// FLITO — bolsas prepago del cliente (HU #11121, Feature #11120 §2.1).
//
// Esta HU cubre el esquema y las ENTRADAS: la recarga que FLIT precarga en la bolsa del cliente.
// Las salidas automáticas cuelgan del sellado de la liquidación y llegan en la HU #11122; por eso
// `registrarMovimiento` ya recibe concepto, organismo, trámite y llave de idempotencia aunque una
// recarga no use ninguno.

// HU #13899 (ADR-0029): el libro vive en `flito_bolsas_unicas*` y su núcleo (asiento, periodo
// imputable, salidas/reversos de la liquidación) en `flito-bolsas.libro.ts`. Aquí quedan las lecturas,
// la recarga, los manuales, el cierre, el extracto y las alertas, todos por la bolsa de alcance
// COMPAÑÍA. Sin bolsa: recarga/manual/corrección → 409 `bolsa_inexistente`; inactiva → 409
// `bolsa_inactiva` (el cierre mensual SÍ se permite). Nadie autocrea bolsas (D6).

import { and, desc, eq, exists, getTableColumns, isNotNull, isNull, lt, notExists, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  clients, flitoBolsasUnicas, flitoBolsasUnicasCierres, flitoBolsasUnicasMovimientos,
  flitoConciliacionBoletas, flitoDerechosPendientes, flitoSoportes, flitoTramites,
} from '../../db/schema.js';
import { aIso } from '../../shared/utils/fecha-rango.js';
import {
  type AlertaBolsa,
  type AlertasConciliacion,
  type BolsaConRiesgo,
  type BolsaDto,
  type CierreDto,
  CLAVE_AGRUPACION_SIN_ASIGNAR,
  type ConceptoBolsa,
  CodigoErrorBolsa,
  EstadoBoleta,
  type ExtractoCliente,
  type LineaAgrupada,
  type MovimientoBolsaDto,
  NIVEL_RIESGO_BOLSA_LABEL,
  nivelRiesgoDe,
  NivelRiesgoBolsa,
  porcentajeSaldo,
  type SaldoConsolidado,
  type TipoMovimientoBolsa,
  TipoSoporte,
} from '@operaciones/shared-types';
import {
  aMovimientoDto, asentarMovimiento, BolsaError, bolsaCompaniaBloqueada, type CtxUsuario, type DatosMovimiento,
  type DbOrTx, deCompania, esLlaveDuplicada, exigirActiva, exigirBolsaActivaDe, hoyIso, movimientoPorLlave, MSG_BOLSA_INEXISTENTE, num,
  periodoDeFecha, redondear, type SoporteRecarga, validarMovimiento,
} from './flito-bolsas.libro.js';

// Re-exporta el núcleo del libro: los importadores (tránsito, liquidación, conciliación, script de
// backfill, tests) lo traían de aquí y siguen haciéndolo.
export {
  asentarMovimiento, asentarSiHayBolsa, BolsaError, esLlaveDuplicada, hoyIso, insertarSoporte, num, periodoDeFecha,
  periodoSiguiente, redondear, registrarSalidasLiquidacion, reversarSalidasLiquidacion, TOPE_NUMERIC,
} from './flito-bolsas.libro.js';
export type {
  CtxUsuario, DatosSalidasLiquidacion, DbOrTx, SalidaConcepto, SoporteRecarga, Tx,
} from './flito-bolsas.libro.js';

// Las formas que devuelve este servicio viven en shared-types: la web las pinta tal cual y
// redeclararlas allí sería garantizar que un día divergen (mismo motivo por el que `nivelRiesgoDe`
// está compartido). Se re-exportan para no tocar a los importadores que ya las traían de aquí.
export type {
  AlertaBolsa, AlertasConciliacion, BolsaConRiesgo, CierreDto,
  ExtractoCliente, LineaAgrupada, SaldoConsolidado,
};

export interface DatosRecarga {
  valor: number;
  /** ISO 'YYYY-MM-DD'. Por defecto, hoy. */
  fecha?: string;
  observacion?: string | null;
  soporte: SoporteRecarga;
  /**
   * Clave que envía el cliente en el encabezado `Idempotency-Key`. Debe acuñarse al ABRIR el
   * formulario, no al pulsar guardar: si se genera por clic, el doble clic produce dos claves y no
   * protege de nada.
   */
  claveIdempotencia: string;
}

// ─────────────────────────── Lectura ─────────────────────────────────────────

/** Movimientos del libro de la bolsa de la compañía C (join a la bolsa: el libro no lleva compania_id). */
const MOV_DE_BOLSA = eq(flitoBolsasUnicasMovimientos.bolsaId, flitoBolsasUnicas.id);

/** Bolsa del cliente con el nombre de la compañía, o null si no tiene una. */
export async function bolsaDe(companiaId: number): Promise<BolsaDto | null> {
  const [fila] = await db
    .select({
      id: flitoBolsasUnicas.id,
      companiaId: flitoBolsasUnicas.companiaId,
      companiaNombre: clients.name,
      saldo: flitoBolsasUnicas.saldo,
      ultimaRecargaValor: flitoBolsasUnicas.ultimaEntradaValor,
      ultimaRecargaEn: flitoBolsasUnicas.ultimaEntradaEn,
    })
    .from(flitoBolsasUnicas)
    .innerJoin(clients, eq(flitoBolsasUnicas.companiaId, clients.id))
    .where(deCompania(companiaId))
    .limit(1);

  if (!fila) return null;
  return {
    id: fila.id,
    companiaId,
    companiaNombre: fila.companiaNombre,
    saldo: num(fila.saldo),
    ultimaRecargaValor: fila.ultimaRecargaValor === null ? null : num(fila.ultimaRecargaValor),
    // aIso y no .toISOString(): el tipo declarado no garantiza que la columna llegue como Date
    // (ver shared/utils/fecha-rango.ts). Llamarlo a ciegas revienta en producción sin aviso del tsc.
    ultimaRecargaEn: aIso(fila.ultimaRecargaEn),
  };
}

export interface FiltroMovimientos {
  periodo?: string;
  limite?: number;
}

/** Libro de la bolsa, del movimiento más reciente al más antiguo. */
export async function movimientosDe(
  companiaId: number,
  filtro: FiltroMovimientos = {},
): Promise<MovimientoBolsaDto[]> {
  const condiciones = [deCompania(companiaId)];
  if (filtro.periodo) condiciones.push(eq(flitoBolsasUnicasMovimientos.periodo, filtro.periodo));

  // El join trae el id de FLIT, que es como Operaciones nombra el trámite. Va aquí y no en una
  // segunda consulta por fila: la tabla del libro los pinta todos.
  const filas = await db
    .select({ m: flitoBolsasUnicasMovimientos, idFlit: flitoTramites.idFlit })
    .from(flitoBolsasUnicasMovimientos)
    .innerJoin(flitoBolsasUnicas, MOV_DE_BOLSA)
    .leftJoin(flitoTramites, eq(flitoBolsasUnicasMovimientos.tramiteId, flitoTramites.id))
    .where(and(...condiciones))
    .orderBy(desc(flitoBolsasUnicasMovimientos.createdAt))
    .limit(Math.min(filtro.limite ?? 200, 500));

  return filas.map((f) => aMovimientoDto(f.m, companiaId, f.idFlit));
}

// ─────────────────────────── Escritura ───────────────────────────────────────

/** Asienta en una transacción propia, validando antes de pedírsela a Postgres. */
async function registrarMovimiento(
  companiaId: number,
  datos: DatosMovimiento,
  ctx: CtxUsuario,
): Promise<{ movimiento: MovimientoBolsaDto; duplicado: boolean }> {
  validarMovimiento(datos);
  return db.transaction((tx) => asentarMovimiento(tx, companiaId, datos, ctx));
}

/** Llave de idempotencia de una recarga, con el prefijo de su familia. */
export function llaveRecarga(companiaId: number, clave: string): string {
  return `recarga:${companiaId}:${clave}`;
}

/**
 * Registra una recarga: dinero que FLIT precarga en la bolsa del cliente (AC1).
 *
 * HU #13899 (D6, AC7): ya NO crea la bolsa. Sin bolsa → 409 `bolsa_inexistente` «Crea la bolsa de la
 * compañía primero»; inactiva → 409 `bolsa_inactiva` (Q7). Actualiza la última recarga, que es la base
 * con la que la HU #11125 clasifica el riesgo del saldo.
 *
 * Es IDEMPOTENTE por `llaveIdempotencia`: reenviar la misma recarga —doble clic, reintento de red—
 * devuelve el movimiento original con `duplicado: true` y no vuelve a acreditar el dinero. Importa
 * porque el libro es append-only: lo que entra mal, entra para siempre.
 */
export async function registrarRecarga(
  companiaId: number,
  datos: DatosRecarga,
  ctx: CtxUsuario,
): Promise<{ movimiento: MovimientoBolsaDto; saldo: number; duplicado: boolean }> {
  const llaveIdempotencia = llaveRecarga(companiaId, datos.claveIdempotencia);
  const movimientoDe = (m: MovimientoBolsaDto, duplicado: boolean) =>
    ({ movimiento: m, saldo: m.saldoResultante, duplicado });

  try {
    const { movimiento, duplicado } = await registrarMovimiento(
      companiaId,
      {
        tipo: 'entrada',
        origen: 'recarga',
        valor: datos.valor,
        fecha: datos.fecha ?? hoyIso(),
        observacion: datos.observacion ?? null,
        soporte: datos.soporte,
        llaveIdempotencia,
        etiqueta: 'recarga',
      },
      ctx,
    );
    return movimientoDe(movimiento, duplicado);
  } catch (e) {
    // Carrera: dos peticiones con la misma llave a la vez. El pre-chequeo de ambas salió vacío y el
    // índice único frenó a la segunda al escribir. Es el mismo caso de negocio que el replay, así que
    // se resuelve igual: se devuelve el que sí quedó asentado.
    if (!esLlaveDuplicada(e)) throw e;
    const previo = await movimientoPorLlave(db, llaveIdempotencia);
    if (!previo) throw e;
    return movimientoDe(previo, true);
  }
}

// ───────────── Movimientos manuales y correcciones (HU #11123) ───────────────

const MOTIVO_MINIMO = 5;

export interface DatosMovimientoManual {
  tipo: TipoMovimientoBolsa;
  valor: number;
  motivo: string;
  fecha?: string;
  concepto?: ConceptoBolsa | null;
  organismoCodigo?: string | null;
  soporte?: SoporteRecarga | null;
}

/** Comprueba el motivo, que es lo único que hace auditable un movimiento manual. */
function motivoValido(motivo: string): string {
  const texto = motivo.trim();
  if (texto.length < MOTIVO_MINIMO) throw new BolsaError('Indica el motivo del movimiento');
  return texto;
}

/**
 * Rechaza escribir en un periodo ya cerrado (AC4).
 *
 * Distinto del rezago del asiento automático: allí el movimiento viene de un hecho que ya ocurrió
 * —el organismo cobró— y perderlo sería peor que imputarlo con desfase. Aquí lo escribe una persona
 * que puede elegir la fecha, así que apuntar a un mes ya conciliado es un error suyo, no un dato que
 * salvar.
 */
async function exigirPeriodoAbierto(tx: DbOrTx, bolsaId: string, fecha: string): Promise<void> {
  if (await periodoCerradoDeBolsa(tx, bolsaId, periodoDeFecha(fecha))) {
    throw new BolsaError(
      'No se pueden registrar ni editar movimientos de un periodo cerrado',
      409,
    );
  }
}

/**
 * Registra una entrada, salida o ajuste manual (AC1). HU #13899: sin bolsa o inactiva → 409.
 *
 * No lleva llave de idempotencia: dos ajustes iguales el mismo día son dos ajustes, y quien los
 * registra los está viendo en pantalla. Lo que los hace rastreables es el motivo y la evidencia.
 */
export async function registrarMovimientoManual(
  companiaId: number,
  datos: DatosMovimientoManual,
  ctx: CtxUsuario,
): Promise<{ movimiento: MovimientoBolsaDto; saldo: number }> {
  const motivo = motivoValido(datos.motivo);
  const fecha = datos.fecha ?? hoyIso();
  const bolsa = await exigirBolsaActivaDe(db, companiaId);
  await exigirPeriodoAbierto(db, bolsa.id, fecha);

  const { movimiento } = await registrarMovimiento(
    companiaId,
    {
      tipo: datos.tipo,
      origen: 'manual',
      valor: datos.valor,
      fecha,
      concepto: datos.concepto ?? null,
      organismoCodigo: datos.organismoCodigo ?? null,
      observacion: motivo,
      soporte: datos.soporte ?? null,
      etiqueta: datos.tipo === 'entrada' ? 'entrada manual' : 'salida manual',
    },
    ctx,
  );
  return { movimiento, saldo: movimiento.saldoResultante };
}

/**
 * Corrige el valor de un movimiento MANUAL con un ajuste que lo referencia (AC2).
 *
 * No se toca la fila original: el libro es append-only y el histórico debe seguir mostrando qué se
 * registró primero. La corrección asienta solo la DIFERENCIA, en la dirección que haga falta, de
 * modo que el saldo quede como si el valor correcto se hubiera registrado desde el principio.
 *
 * Los movimientos automáticos no se corrigen por aquí (AC5): vienen de un hecho —el sellado de una
 * liquidación— y cambiarles el valor desalinearía la bolsa de lo que dice la liquidación. Para esos
 * se registra un ajuste manual suelto, que deja constancia de que la corrección es una decisión de
 * una persona y no una enmienda al hecho.
 */
export async function corregirMovimiento(
  movimientoId: string,
  valorCorregido: number,
  motivoBruto: string,
  ctx: CtxUsuario,
  companiaId?: CompaniaDeAlcance,
): Promise<{ correccion: MovimientoBolsaDto; saldo: number }> {
  const motivo = motivoValido(motivoBruto);

  // HU #13426 (AC3): con enlace, el movimiento tiene que ser del libro de SU compañía (en el WHERE);
  // si no aparece, 403 sin distinguir «ajeno» de «inexistente».
  const [fila] = await db
    .select({
      ...getTableColumns(flitoBolsasUnicasMovimientos),
      companiaId: flitoBolsasUnicas.companiaId,
      activa: flitoBolsasUnicas.activa,
    })
    .from(flitoBolsasUnicasMovimientos)
    .innerJoin(flitoBolsasUnicas, MOV_DE_BOLSA)
    .where(and(eq(flitoBolsasUnicasMovimientos.id, movimientoId), soloCompania(flitoBolsasUnicas.companiaId, companiaId)))
    .limit(1);
  if (!fila && companiaId !== undefined) throw new BolsaError('Sin permisos', 403);
  if (!fila || fila.companiaId === null) throw new BolsaError('El movimiento no existe', 404);
  const original = fila;

  if (original.origen !== 'manual') {
    throw new BolsaError(
      'Un movimiento automático no se edita: corrígelo con un ajuste manual',
      409,
    );
  }
  // HU #13899 (Q7): la bolsa inactiva no admite correcciones.
  exigirActiva({ id: original.bolsaId, saldo: 0, companiaId: fila.companiaId, activa: fila.activa });
  await exigirPeriodoAbierto(db, original.bolsaId, original.fecha);

  const valorOriginal = num(original.valor);
  const diferencia = redondear(valorCorregido - valorOriginal);
  if (diferencia === 0) throw new BolsaError('El valor corregido es igual al actual');

  // Si el movimiento era una salida y sube de valor, hay que sacar más: la corrección va en la misma
  // dirección que el original. Si baja, va en la contraria.
  const mismaDireccion = diferencia > 0;
  const tipo: TipoMovimientoBolsa = mismaDireccion
    ? (original.tipo as TipoMovimientoBolsa)
    : (original.tipo === 'entrada' ? 'salida' : 'entrada');

  const { movimiento } = await registrarMovimiento(
    fila.companiaId,
    {
      tipo,
      origen: 'manual',
      valor: Math.abs(diferencia),
      fecha: hoyIso(),
      concepto: original.concepto === null ? null : (original.concepto as ConceptoBolsa),
      organismoCodigo: original.organismoCodigo,
      tramiteId: original.tramiteId,
      observacion: `Corrección de ${valorOriginal} a ${valorCorregido}: ${motivo}`,
      corrigeMovimientoId: original.id,
      etiqueta: 'corrección',
    },
    ctx,
  );
  return { correccion: movimiento, saldo: movimiento.saldoResultante };
}

// ─────────────────── Cierre mensual del periodo (HU #11126) ──────────────────

async function periodoCerradoDeBolsa(tx: DbOrTx, bolsaId: string, periodo: string): Promise<boolean> {
  const [fila] = await tx
    .select({ id: flitoBolsasUnicasCierres.id })
    .from(flitoBolsasUnicasCierres)
    .where(and(eq(flitoBolsasUnicasCierres.bolsaId, bolsaId), eq(flitoBolsasUnicasCierres.periodo, periodo)))
    .limit(1);
  return fila !== undefined;
}

/** True si ese periodo ya está cerrado en la bolsa del cliente (false si no tiene bolsa). */
export async function periodoEstaCerrado(
  tx: DbOrTx, companiaId: number, periodo: string,
): Promise<boolean> {
  const [fila] = await tx
    .select({ id: flitoBolsasUnicasCierres.id })
    .from(flitoBolsasUnicasCierres)
    .innerJoin(flitoBolsasUnicas, eq(flitoBolsasUnicasCierres.bolsaId, flitoBolsasUnicas.id))
    .where(and(deCompania(companiaId), eq(flitoBolsasUnicasCierres.periodo, periodo)))
    .limit(1);
  return fila !== undefined;
}

function aCierreDto(c: typeof flitoBolsasUnicasCierres.$inferSelect, companiaId: number): CierreDto {
  return {
    id: c.id,
    companiaId,
    periodo: c.periodo,
    saldoInicial: num(c.saldoInicial),
    totalEntradas: num(c.totalEntradas),
    totalSalidas: num(c.totalSalidas),
    saldoFinal: num(c.saldoFinal),
    movimientos: c.movimientos,
    observaciones: c.observaciones,
    cerradoPorNombre: c.cerradoPorNombre,
    cerradoEn: aIso(c.cerradoEn) ?? '',
  };
}

/** Cierres de un cliente, del más reciente al más antiguo. */
export async function cierresDe(companiaId: number): Promise<CierreDto[]> {
  const filas = await db
    .select(getTableColumns(flitoBolsasUnicasCierres))
    .from(flitoBolsasUnicasCierres)
    .innerJoin(flitoBolsasUnicas, eq(flitoBolsasUnicasCierres.bolsaId, flitoBolsasUnicas.id))
    .where(deCompania(companiaId))
    .orderBy(desc(flitoBolsasUnicasCierres.periodo));
  return filas.map((f) => aCierreDto(f, companiaId));
}

/** Suma de entradas o salidas del libro, para los agregados. */
const sumaDe = (tipo: 'entrada' | 'salida') =>
  sql<string>`coalesce(sum(case when ${flitoBolsasUnicasMovimientos.tipo} = ${tipo} then ${flitoBolsasUnicasMovimientos.valor} else 0 end), 0)`;

/**
 * Cierra un periodo: congela sus movimientos y deja el reporte de auditoría (AC1).
 *
 * El disparo es manual y el periodo no tiene por qué ser el mes anterior: Financiera cierra cuando
 * ha conciliado. Lo que no se admite es cerrar un mes que aún no ha terminado, porque el saldo final
 * que quedaría sellado no sería el del periodo.
 *
 * El saldo inicial sale del cierre anterior, no de recalcular el libro entero: encadenar los cierres
 * es lo que hace que el arrastre sea auditable mes a mes.
 */
export async function cerrarPeriodo(
  companiaId: number,
  periodo: string,
  observaciones: string | null,
  ctx: CtxUsuario,
): Promise<CierreDto> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodo)) {
    throw new BolsaError('El periodo debe tener la forma AAAA-MM');
  }
  const enCurso = periodoDeFecha(hoyIso());
  if (periodo > enCurso) throw new BolsaError('No se puede cerrar un periodo futuro');
  if (periodo === enCurso) {
    throw new BolsaError('El periodo en curso no ha terminado: solo se cierra un mes ya cumplido');
  }

  return db.transaction(async (tx) => {
    // Se bloquea la bolsa mientras se cierra: sin el lock, un movimiento que entre entre el conteo y
    // el INSERT quedaría dentro del periodo pero fuera del reporte. HU #13899: ya no la crea, y la
    // bolsa INACTIVA sí se cierra (Q7).
    const bolsa = await bolsaCompaniaBloqueada(tx, companiaId);
    if (!bolsa) throw new BolsaError(MSG_BOLSA_INEXISTENTE, 409, CodigoErrorBolsa.BOLSA_INEXISTENTE);

    if (await periodoCerradoDeBolsa(tx, bolsa.id, periodo)) {
      throw new BolsaError('El periodo ya está cerrado', 409);
    }

    const [totales] = await tx
      .select({ entradas: sumaDe('entrada'), salidas: sumaDe('salida'), movimientos: sql<number>`count(*)::int` })
      .from(flitoBolsasUnicasMovimientos)
      .where(and(
        eq(flitoBolsasUnicasMovimientos.bolsaId, bolsa.id),
        eq(flitoBolsasUnicasMovimientos.periodo, periodo),
      ));

    const [previo] = await tx
      .select({ saldoFinal: flitoBolsasUnicasCierres.saldoFinal })
      .from(flitoBolsasUnicasCierres)
      .where(and(
        eq(flitoBolsasUnicasCierres.bolsaId, bolsa.id),
        lt(flitoBolsasUnicasCierres.periodo, periodo),
      ))
      .orderBy(desc(flitoBolsasUnicasCierres.periodo))
      .limit(1);

    const saldoInicial = previo ? num(previo.saldoFinal) : 0;
    const totalEntradas = redondear(num(totales?.entradas ?? '0'));
    const totalSalidas = redondear(num(totales?.salidas ?? '0'));
    const saldoFinal = redondear(saldoInicial + totalEntradas - totalSalidas);

    const [fila] = await tx.insert(flitoBolsasUnicasCierres).values({
      bolsaId: bolsa.id,
      periodo,
      saldoInicial: String(saldoInicial),
      totalEntradas: String(totalEntradas),
      totalSalidas: String(totalSalidas),
      saldoFinal: String(saldoFinal),
      movimientos: totales?.movimientos ?? 0,
      observaciones: observaciones?.trim() ? observaciones.trim() : null,
      cerradoPorId: ctx.userId,
      cerradoPorNombre: ctx.nombre.slice(0, 150),
    }).returning();

    return aCierreDto(fila, companiaId);
  });
}

// ───────── Extracto por OT y bolsa simbólica del organismo (HU #11124) ───────

/** Agrupa el libro de un cliente por una columna, sumando entradas y salidas por separado. */
async function agrupar(
  companiaId: number,
  columna: typeof flitoBolsasUnicasMovimientos.organismoCodigo | typeof flitoBolsasUnicasMovimientos.concepto,
  periodo?: string,
): Promise<LineaAgrupada[]> {
  const condiciones = [deCompania(companiaId)];
  if (periodo) condiciones.push(eq(flitoBolsasUnicasMovimientos.periodo, periodo));

  const filas = await db
    .select({
      clave: columna,
      entradas: sumaDe('entrada'),
      salidas: sumaDe('salida'),
      movimientos: sql<number>`count(*)::int`,
    })
    .from(flitoBolsasUnicasMovimientos)
    .innerJoin(flitoBolsasUnicas, MOV_DE_BOLSA)
    .where(and(...condiciones))
    .groupBy(columna);

  return filas.map((f) => ({
    // `null` es una agrupación legítima, no un fallo: las recargas no tienen organismo ni concepto,
    // y el trámite digital y la logística no tienen organismo por ser honorarios de FLIT.
    clave: f.clave ?? CLAVE_AGRUPACION_SIN_ASIGNAR,
    entradas: redondear(num(f.entradas)),
    salidas: redondear(num(f.salidas)),
    movimientos: f.movimientos,
  }));
}

/**
 * Extracto del cliente: el saldo con su consumo desglosado por organismo y por concepto (AC1).
 *
 * Los desgloses se calculan del mismo libro que produce el saldo, así que cuadran por construcción:
 * saldo = entradas − salidas, y cada agrupación reparte esas mismas sumas por una dimensión distinta.
 */
export async function extractoDe(companiaId: number, periodo?: string): Promise<ExtractoCliente> {
  const condiciones = [deCompania(companiaId)];
  if (periodo) condiciones.push(eq(flitoBolsasUnicasMovimientos.periodo, periodo));
  const [totales] = await db
    .select({ entradas: sumaDe('entrada'), salidas: sumaDe('salida') })
    .from(flitoBolsasUnicasMovimientos)
    .innerJoin(flitoBolsasUnicas, MOV_DE_BOLSA)
    .where(and(...condiciones));

  const [porOrganismo, porConcepto, bolsa] = await Promise.all([
    agrupar(companiaId, flitoBolsasUnicasMovimientos.organismoCodigo, periodo),
    agrupar(companiaId, flitoBolsasUnicasMovimientos.concepto, periodo),
    bolsaDe(companiaId),
  ]);

  return {
    companiaId,
    saldoActual: bolsa?.saldo ?? 0,
    totalEntradas: redondear(num(totales?.entradas ?? '0')),
    totalSalidas: redondear(num(totales?.salidas ?? '0')),
    porOrganismo,
    porConcepto,
  };
}

// ─────────────── Nivel de riesgo del saldo y alertas (HU #11125) ─────────────

function conRiesgo(b: BolsaDto): BolsaConRiesgo {
  return {
    ...b,
    nivel: nivelRiesgoDe(b.saldo, b.ultimaRecargaValor),
    porcentaje: porcentajeSaldo(b.saldo, b.ultimaRecargaValor),
    // Los totales del periodo solo los calcula el listado del tablero, que sabe qué mes se pidió.
    // `null` aquí no es «cero movimientos», es «no se preguntó».
    entradasPeriodo: null,
    salidasPeriodo: null,
  };
}

/** Bolsa del cliente con su nivel de riesgo ya clasificado. */
export async function bolsaConRiesgoDe(companiaId: number): Promise<BolsaConRiesgo | null> {
  const b = await bolsaDe(companiaId);
  return b === null ? null : conRiesgo(b);
}

/**
 * Todas las bolsas con su nivel, las de peor riesgo primero (AC1).
 *
 * El orden lo pone el servidor y no la pantalla: es la lista que Financiera abre para decidir a quién
 * recargar, y dejar que cada cliente la ordene invitaría a que dos vistas muestren prioridades
 * distintas del mismo dato.
 */
/**
 * HU #13426 (AC2/AC9): acota un AGREGADO a la compañía del enlace. `undefined` = global (sin enlace);
 * `null` = cero filas (enlace sin compañía, o que no es de compañía). Lo calcula `companiaDeAlcance`.
 */
export type CompaniaDeAlcance = number | null | undefined;
function soloCompania(col: AnyColumn, companiaId: CompaniaDeAlcance): SQL | undefined {
  if (companiaId === undefined) return undefined;
  return companiaId === null ? sql`false` : eq(col, companiaId);
}

export async function bolsasConRiesgo(periodo?: string, companiaId?: CompaniaDeAlcance): Promise<BolsaConRiesgo[]> {
  const filas = await db
    .select({
      id: flitoBolsasUnicas.id,
      companiaId: flitoBolsasUnicas.companiaId,
      companiaNombre: clients.name,
      saldo: flitoBolsasUnicas.saldo,
      ultimaRecargaValor: flitoBolsasUnicas.ultimaEntradaValor,
      ultimaRecargaEn: flitoBolsasUnicas.ultimaEntradaEn,
    })
    .from(flitoBolsasUnicas)
    .innerJoin(clients, eq(flitoBolsasUnicas.companiaId, clients.id))
    .where(and(eq(flitoBolsasUnicas.alcance, 'compania'), soloCompania(flitoBolsasUnicas.companiaId, companiaId)));

  // Los totales del periodo salen de UNA consulta agrupada, no de una por cliente. El tablero los
  // pinta en cada tarjeta, así que pedirlos uno a uno convertía abrir la pantalla en tantas
  // consultas como clientes hubiera.
  const totales = new Map<number, { entradas: number; salidas: number }>();
  if (periodo) {
    const agregados = await db
      .select({
        companiaId: flitoBolsasUnicas.companiaId,
        entradas: sumaDe('entrada'),
        salidas: sumaDe('salida'),
      })
      .from(flitoBolsasUnicasMovimientos)
      .innerJoin(flitoBolsasUnicas, MOV_DE_BOLSA)
      .where(and(eq(flitoBolsasUnicasMovimientos.periodo, periodo), eq(flitoBolsasUnicas.alcance, 'compania'),
        soloCompania(flitoBolsasUnicas.companiaId, companiaId)))
      .groupBy(flitoBolsasUnicas.companiaId);
    for (const a of agregados) {
      if (a.companiaId === null) continue;
      totales.set(a.companiaId, {
        entradas: redondear(num(a.entradas)),
        salidas: redondear(num(a.salidas)),
      });
    }
  }

  const orden: Record<NivelRiesgoBolsa, number> = {
    agotada: 0, critico: 1, bajo: 2, normal: 3, sin_recargas: 4,
  };

  return filas
    .map((f) => {
      const companiaDeFila = f.companiaId as number; // alcance 'compania' ⇒ no nulo (CHECK de forma)
      const t = totales.get(companiaDeFila);
      return {
        ...conRiesgo({
          id: f.id,
          companiaId: companiaDeFila,
          companiaNombre: f.companiaNombre,
          saldo: num(f.saldo),
          ultimaRecargaValor: f.ultimaRecargaValor === null ? null : num(f.ultimaRecargaValor),
          ultimaRecargaEn: aIso(f.ultimaRecargaEn),
        }),
        // `null` cuando no se pidió periodo: distinto de cero, que sí significa «ese mes no se movió».
        entradasPeriodo: periodo ? (t?.entradas ?? 0) : null,
        salidasPeriodo: periodo ? (t?.salidas ?? 0) : null,
      };
    })
    .sort((a, b) => orden[a.nivel] - orden[b.nivel]
      // A igual nivel, primero el que más lejos está de su base: es el que antes se queda sin saldo.
      || (a.porcentaje ?? Infinity) - (b.porcentaje ?? Infinity));
}

/**
 * Alertas de saldo: las bolsas que no están en nivel normal (AC2).
 *
 * `sin_recargas` NO alerta: un cliente que aún no ha recibido su primera recarga no tiene un
 * problema de saldo, y colarlo aquí llenaría el panel de ruido el día que se den de alta clientes.
 */
export async function alertasDeSaldo(companiaId?: CompaniaDeAlcance): Promise<AlertaBolsa[]> {
  const bolsas = await bolsasConRiesgo(undefined, companiaId);
  return bolsas
    .filter((b) => b.nivel !== NivelRiesgoBolsa.NORMAL && b.nivel !== NivelRiesgoBolsa.SIN_RECARGAS)
    .map((b) => ({
      tipo: 'saldo' as const,
      nivel: b.nivel,
      companiaId: b.companiaId,
      companiaNombre: b.companiaNombre,
      saldo: b.saldo,
      porcentaje: b.porcentaje,
      mensaje: b.nivel === NivelRiesgoBolsa.AGOTADA
        ? `La bolsa de ${b.companiaNombre} está agotada (saldo ${b.saldo}).`
        : `${b.companiaNombre} tiene ${NIVEL_RIESGO_BOLSA_LABEL[b.nivel].toLowerCase()}: ${b.porcentaje} % de su última recarga.`,
    }));
}

/** Salidas automáticas (o adoptadas por una conciliación) que siguen sin soporte. */
function condicionSinSoporte(): SQL {
  return and(
    or(
      eq(flitoBolsasUnicasMovimientos.origen, 'automatico'),
      // Adoptado por una conciliación: lo asentó el sellado y sigue sin soporte. Ver la cabecera.
      and(
        eq(flitoBolsasUnicasMovimientos.origen, 'conciliacion'),
        isNotNull(flitoBolsasUnicasMovimientos.tramiteId),
      ),
    ),
    eq(flitoBolsasUnicasMovimientos.tipo, 'salida'),
    isNull(flitoBolsasUnicasMovimientos.soporteId),
  )!;
}

/**
 * Alertas de conciliación (AC4): los dos extremos que no cuadran entre soportes y movimientos.
 *
 * Los soportes sin trámite ya los recoge la bandeja `flito_derechos_pendientes`, que existe desde el
 * módulo de derechos y sirve a los tres conceptos; no se reimplementa ese cruce aquí.
 *
 * ── El origen `conciliacion` y este conteo: DOS direcciones, y las dos importan (Feature #11623) ─
 *
 * **1. Lo que NO se añade.** Los movimientos que la conciliación de una boleta ASIENTA de cero
 * (HU #11677) no se cuentan aquí, y no hay que añadirlos: su comprobante —el soporte del pago PSE—
 * cuelga de la BOLETA y no de cada uno de sus N movimientos, así que incluirlos convertiría cada
 * SOAT conciliado en una alerta permanente que nadie podría cerrar, por más comprobantes que se
 * subieran. Eso deja un hueco conocido —una boleta conciliada sin comprobante que este tablero no
 * ve— cuyo predicado va sobre las tablas nuevas (boleta en `conciliada` sin soporte vivo con
 * `conciliacion_boleta_id`) y entra con la **HU #11678**, que es la que crea la vía para subirlo.
 *
 * **2. Lo que NO se puede dejar salir, y es la razón del `OR` de abajo.** La conciliación también
 * ADOPTA movimientos que ya existían: cuando el sellado se le adelantó, reescribe su `origen` de
 * `automatico` a `conciliacion` (ADR-0006 §2.4-ii). Ese movimiento **ya estaba dentro de este
 * conteo** —las salidas de liquidación no llevan soporte—, así que sin ensanchar el predicado
 * conciliar una boleta HARÍA BAJAR el contador de «movimientos sin soporte» sin que nadie hubiera
 * subido nada: la señal contraria a la realidad, y una regresión de una alerta que hoy funciona.
 *
 * Los dos conjuntos se distinguen sin ambigüedad y sin columna nueva: lo que asienta la conciliación
 * va con `tramite_id NULL` (no hay un trámite «correcto» que poner, ADR §4.1) y lo adoptado
 * CONSERVA el `tramite_id` de su liquidación. De ahí `origen = 'conciliacion' AND tramite_id IS NOT
 * NULL` = «esto lo asentó el sellado y sigue sin comprobante». Conserva la alerta preexistente sin
 * crear ninguna incerrable.
 */
export async function alertasDeConciliacion(companiaId?: CompaniaDeAlcance): Promise<AlertasConciliacion> {
  // HU #13426: para una compañía solo cuenta lo de SU libro (movimientos sin soporte). Los soportes sin
  // trámite y las boletas de conciliación son operación interna de FLIT: 0, sin consultarse.
  if (companiaId !== undefined) {
    const [propios] = await db.select({ n: sql<number>`count(*)::int` }).from(flitoBolsasUnicasMovimientos)
      .innerJoin(flitoBolsasUnicas, MOV_DE_BOLSA)
      .where(and(condicionSinSoporte(), soloCompania(flitoBolsasUnicas.companiaId, companiaId)));
    return { soportesSinTramite: 0, movimientosSinSoporte: propios?.n ?? 0, boletasSinComprobante: 0 };
  }
  const [pendientes] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(flitoDerechosPendientes)
    .where(eq(flitoDerechosPendientes.resuelto, false));

  const [sinSoporte] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(flitoBolsasUnicasMovimientos)
    .where(condicionSinSoporte());

  // AC6 de la HU #11678 — la otra mitad, la que el comentario de arriba dejaba anotada como hueco.
  //
  // El predicado es A NIVEL DE BOLETA y no de movimiento, y esa es toda la decisión: el comprobante
  // PSE cuelga de la boleta (`flito_soportes.conciliacion_boleta_id`), así que una boleta de 40 SOAT
  // a la que le falta el archivo es UNA cosa que hacer, no cuarenta. Contarla por movimiento daría
  // 40 alertas que ni siquiera se apagarían a la vez.
  //
  // `NOT EXISTS` y no un `leftJoin … IS NULL`: la pregunta es «¿hay algún comprobante vivo?», y las
  // tres condiciones del subselect son las mismas del índice único parcial que garantiza que como
  // mucho haya uno. Sin `descartado = false`, un comprobante reemplazado seguiría apagando la alerta.
  const [sinComprobante] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(flitoConciliacionBoletas)
    .where(and(
      eq(flitoConciliacionBoletas.estado, EstadoBoleta.CONCILIADA),
      notExists(
        db.select({ uno: sql`1` }).from(flitoSoportes).where(and(
          eq(flitoSoportes.conciliacionBoletaId, flitoConciliacionBoletas.id),
          eq(flitoSoportes.tipo, TipoSoporte.COMPROBANTE_PSE),
          eq(flitoSoportes.descartado, false),
        )),
      ),
    ));

  return {
    soportesSinTramite: pendientes?.n ?? 0,
    movimientosSinSoporte: sinSoporte?.n ?? 0,
    boletasSinComprobante: sinComprobante?.n ?? 0,
  };
}

/**
 * Storage key de un soporte **que de verdad pertenece a alguno de los dos libros de bolsa**.
 *
 * Sustituye a `storageKeySoporte` en `GET /flito/bolsas/soportes/:soporteId` (HU #11678, AC7).
 * Aquella resolvía **cualquier** fila de `flito_soportes` por su id: la factura de un SOAT, el
 * recibo de un impuesto, el PDF de una factura electrónica… y bastaba tener el rol de bolsas —que
 * no es el rol de ninguno de esos módulos— y un id. Con un uuid opaco eso era difícil de explotar
 * pero era una frontera que no existía; en cuanto un COMPROBANTE DE PAGO cuelga de esa misma tabla
 * (esta HU), deja de ser teórico: cualquiera con acceso a bolsas podría descargar el comprobante de
 * una boleta sin pasar por el módulo que decide quién ve esa boleta.
 *
 * La corrección es la barata y la correcta: el `EXISTS` sobre los dos libros afirma la PERTENENCIA,
 * no el permiso genérico del rol. Un soporte que no es el comprobante de ninguna recarga ni de
 * ninguna carga de tránsito devuelve `null` → 404, exactamente igual que uno inexistente. Y el
 * comprobante PSE de una boleta, que no está referenciado por ningún movimiento, queda fuera por
 * construcción: se sirve por `…/boletas/:id/comprobante` y por `GET /flito/soat/:id/soportes`, dos
 * rutas donde el dueño es parte de la dirección.
 */
export async function storageKeySoporteDeBolsa(
  soporteId: string, companiaId?: CompaniaDeAlcance,
): Promise<{ storageKey: string; nombreArchivo: string; contentType: string } | null> {
  // El id llega del path: si no es un uuid, la comparación explotaría con un 22P02 (500) en vez de
  // devolver el 404 que corresponde a «eso no existe».
  if (!UUID_RE.test(soporteId)) return null;

  const [s] = await db.select({
    storageKey: flitoSoportes.storageKey,
    nombreArchivo: flitoSoportes.nombreArchivo,
    contentType: flitoSoportes.contentType,
  }).from(flitoSoportes)
    .where(and(
      eq(flitoSoportes.id, soporteId),
      // HU #13426 (AC2): con enlace de compañía, solo un soporte de SU libro; el de tránsito, nunca.
      companiaId !== undefined
        ? exists(db.select({ uno: sql`1` }).from(flitoBolsasUnicasMovimientos).innerJoin(flitoBolsasUnicas, MOV_DE_BOLSA)
          .where(and(eq(flitoBolsasUnicasMovimientos.soporteId, flitoSoportes.id), soloCompania(flitoBolsasUnicas.companiaId, companiaId))))
        // HU #13906: desde la 0257 el libro único guarda también los de tránsito (mismos soportes).
        : exists(db.select({ uno: sql`1` }).from(flitoBolsasUnicasMovimientos)
          .where(eq(flitoBolsasUnicasMovimientos.soporteId, flitoSoportes.id))),
    ))
    .limit(1);
  return s ?? null;
}

/**
 * Forma de un uuid, sin exigir versión ni variante.
 *
 * Solo está para que un id que no es un uuid salga por 404 en vez de por el `22P02` (→ 500) que
 * lanzaría Postgres al comparar texto con una columna `uuid`. Comprobar además versión y variante
 * rechazaría identificadores perfectamente válidos que no nacieron de `gen_random_uuid()`, y este
 * guarda no es una validación de negocio: es una traducción de error.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Saldo total prepago de todos los clientes. Lo consume el tablero de la HU #11127. */
export async function saldoConsolidado(companiaId?: CompaniaDeAlcance): Promise<{ clientes: number; saldoTotal: number }> {
  const [fila] = await db
    .select({
      clientes: sql<number>`count(*)::int`,
      saldoTotal: sql<string>`coalesce(sum(${flitoBolsasUnicas.saldo}), 0)`,
    })
    .from(flitoBolsasUnicas)
    // HU #13426: solo la bolsa de C. HU #13899: solo alcance compañía (tránsito tiene su consolidado).
    .where(and(eq(flitoBolsasUnicas.alcance, 'compania'), soloCompania(flitoBolsasUnicas.companiaId, companiaId)));
  return { clientes: fila?.clientes ?? 0, saldoTotal: num(fila?.saldoTotal ?? '0') };
}
