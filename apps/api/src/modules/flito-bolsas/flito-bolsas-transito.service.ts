// FLITO — bolsa que FLIT precarga para pagar trámites ante las secretarías (HU #11161, ajuste 0124).
//
// Es la INVERSA de la bolsa del cliente y conviene tenerlo presente al leer: aquí FLIT pone el
// dinero por adelantado y un tercero lo gasta pagando ante las secretarías. La pregunta que este
// módulo responde es «¿cuánto le queda a la bolsa de mi sector?», no «¿cuánto le debemos?».
//
// Una bolsa NO es una secretaría. Cubre parejas (secretaría, concepto) —Medellín, Envigado y
// Sabaneta solo para impuestos, por ejemplo— y ese par no puede repetirse en dos bolsas. Esa
// exclusividad, garantizada por el índice único `uq_bolsa_transito_cobertura`, es lo que hace que
// `bolsaQueCubre` devuelva como mucho una candidata y que el sellado de la liquidación no tenga que
// preguntarle a nadie a dónde va el dinero.
//
// Reutiliza los helpers de `flito-bolsas.service.ts` (redondeo, tope, fecha contable, periodo) a
// propósito: son dos libros distintos, pero si sus reglas de imputación divergieran, el mismo
// movimiento podría caer en meses distintos según qué bolsa lo mire.

import { and, desc, eq, inArray, like, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  flitoBolsasTransito, flitoBolsaTransitoCobertura, flitoBolsaTransitoMovimientos, flitoTramites,
  organismosTransitoConfig,
} from '../../db/schema.js';
import { parseFechaQuery } from '../../shared/utils/fecha-rango.js';
import {
  type BolsaTransitoConNivel,
  type BolsaTransitoDto,
  type ConceptoBolsaTransito,
  CONCEPTOS_BOLSA_TRANSITO,
  type CoberturaBolsaTransito,
  type DatosBolsaTransito,
  deudaBolsaTransito,
  esConceptoBolsaTransito,
  type MovimientoTransitoDto,
  nivelBolsaTransitoDe,
  type NivelBolsaTransito,
  type OrigenMovimientoTransito,
  porcentajeSaldo,
  type TipoMovimientoTransito,
} from '@operaciones/shared-types';
import {
  BolsaError, type CtxUsuario, esLlaveDuplicada, hoyIso, insertarSoporte, num, periodoDeFecha,
  redondear, type SoporteRecarga, TOPE_NUMERIC, type Tx,
} from './flito-bolsas.service.js';

export type { BolsaTransitoConNivel, BolsaTransitoDto, MovimientoTransitoDto };

/** Tipo del comprobante de una carga en `flito_soportes`. */
const TIPO_SOPORTE_CARGA = 'carga_organismo';

/** Prefijo de familia de las llaves. El índice único es uno solo para toda la tabla. */
const PREFIJO_CONSUMO = 'consumo:';
/**
 * Prefijo que libera la llave de un consumo cuando su liquidación se reversa, para que volver a
 * liquidar vuelva a consumir. Mismo mecanismo que el `rev:` de la bolsa del cliente: es lo único que
 * se reescribe de una fila del libro, y no toca el dinero.
 */
const PREFIJO_REVERSADO = 'rev:';

// ─────────────────────────── Cobertura ───────────────────────────────────────

/**
 * La bolsa que cubre un concepto ante una secretaría, o `null` si ninguna lo hace.
 *
 * Devuelve como mucho una fila por construcción: el índice único sobre (organismo, concepto) impide
 * que dos bolsas se solapen. Que devuelva `null` es un desenlace NORMAL —la mayoría de las
 * secretarías no están en ninguna bolsa— y quien llama debe tratarlo como «aquí no hay nada que
 * descontar», nunca como un error.
 */
export async function bolsaQueCubre(
  tx: Tx,
  organismoCodigo: string,
  concepto: ConceptoBolsaTransito,
): Promise<{ id: string; nombre: string } | null> {
  const [fila] = await tx
    .select({ id: flitoBolsasTransito.id, nombre: flitoBolsasTransito.nombre })
    .from(flitoBolsaTransitoCobertura)
    .innerJoin(flitoBolsasTransito, eq(flitoBolsasTransito.id, flitoBolsaTransitoCobertura.bolsaId))
    .where(and(
      eq(flitoBolsaTransitoCobertura.organismoCodigo, organismoCodigo),
      eq(flitoBolsaTransitoCobertura.concepto, concepto),
    ))
    .limit(1);
  return fila ?? null;
}

/** Cobertura de varias bolsas de una sola consulta, con el alias del organismo ya resuelto. */
async function coberturaDe(bolsaIds: string[]): Promise<Map<string, CoberturaBolsaTransito[]>> {
  const porBolsa = new Map<string, CoberturaBolsaTransito[]>();
  if (bolsaIds.length === 0) return porBolsa;

  const filas = await db
    .select({
      bolsaId: flitoBolsaTransitoCobertura.bolsaId,
      organismoCodigo: flitoBolsaTransitoCobertura.organismoCodigo,
      organismoNombre: organismosTransitoConfig.alias,
      concepto: flitoBolsaTransitoCobertura.concepto,
    })
    .from(flitoBolsaTransitoCobertura)
    .leftJoin(
      organismosTransitoConfig,
      eq(organismosTransitoConfig.codigo, flitoBolsaTransitoCobertura.organismoCodigo),
    )
    .where(inArray(flitoBolsaTransitoCobertura.bolsaId, bolsaIds))
    .orderBy(flitoBolsaTransitoCobertura.organismoCodigo, flitoBolsaTransitoCobertura.concepto);

  for (const f of filas) {
    const lista = porBolsa.get(f.bolsaId) ?? [];
    lista.push({
      organismoCodigo: f.organismoCodigo,
      organismoNombre: f.organismoNombre,
      concepto: f.concepto as ConceptoBolsaTransito,
    });
    porBolsa.set(f.bolsaId, lista);
  }
  return porBolsa;
}

/**
 * Valida y normaliza lo que llega del formulario de creación.
 *
 * Deduplica secretarías y conceptos antes de materializar el producto: repetir Medellín en la lista
 * chocaría contra la clave primaria de la cobertura y convertiría un descuido de la pantalla en un
 * 500.
 */
function normalizarDatos(datos: DatosBolsaTransito): {
  nombre: string; organismos: string[]; conceptos: ConceptoBolsaTransito[];
} {
  const nombre = datos.nombre?.trim() ?? '';
  if (nombre.length < 3) throw new BolsaError('El nombre de la bolsa debe tener al menos 3 caracteres');
  if (nombre.length > 120) throw new BolsaError('El nombre de la bolsa no puede superar 120 caracteres');

  const organismos = [...new Set((datos.organismos ?? []).map((o) => o.trim()).filter(Boolean))];
  if (organismos.length === 0) throw new BolsaError('Selecciona al menos una secretaría');

  const conceptos = [...new Set(datos.conceptos ?? [])];
  if (conceptos.length === 0) throw new BolsaError('Selecciona al menos un concepto');
  for (const c of conceptos) {
    if (!esConceptoBolsaTransito(c)) throw new BolsaError(`Concepto no válido: ${c}`);
  }
  // Orden fijo para que la cobertura se lea igual venga como venga del formulario.
  conceptos.sort((a, b) => CONCEPTOS_BOLSA_TRANSITO.indexOf(a) - CONCEPTOS_BOLSA_TRANSITO.indexOf(b));

  return { nombre, organismos, conceptos };
}

/**
 * Traduce el choque contra `uq_bolsa_transito_cobertura` en un mensaje que diga QUÉ se solapa.
 *
 * Se consulta después del fallo y no antes: comprobar primero dejaría una ventana entre la
 * comprobación y el INSERT, y en algo que decide a dónde va el dinero esa ventana no es aceptable.
 * El índice es el árbitro; esto solo traduce su veredicto.
 */
async function errorDeSolapamiento(
  organismos: string[],
  conceptos: ConceptoBolsaTransito[],
  bolsaIdExcluida?: string,
): Promise<BolsaError> {
  const chocan = await db
    .select({
      organismoCodigo: flitoBolsaTransitoCobertura.organismoCodigo,
      organismoNombre: organismosTransitoConfig.alias,
      concepto: flitoBolsaTransitoCobertura.concepto,
      bolsaNombre: flitoBolsasTransito.nombre,
      bolsaId: flitoBolsaTransitoCobertura.bolsaId,
    })
    .from(flitoBolsaTransitoCobertura)
    .innerJoin(flitoBolsasTransito, eq(flitoBolsasTransito.id, flitoBolsaTransitoCobertura.bolsaId))
    .leftJoin(
      organismosTransitoConfig,
      eq(organismosTransitoConfig.codigo, flitoBolsaTransitoCobertura.organismoCodigo),
    )
    .where(and(
      inArray(flitoBolsaTransitoCobertura.organismoCodigo, organismos),
      inArray(flitoBolsaTransitoCobertura.concepto, conceptos),
    ));

  const ajenos = chocan.filter((c) => c.bolsaId !== bolsaIdExcluida);
  if (ajenos.length === 0) {
    return new BolsaError('Ya existe una bolsa con esa cobertura', 409);
  }
  const detalle = ajenos
    .slice(0, 3)
    .map((c) => `${c.organismoNombre ?? c.organismoCodigo} (${c.concepto}) ya está en «${c.bolsaNombre}»`)
    .join('; ');
  const resto = ajenos.length > 3 ? ` y ${ajenos.length - 3} más` : '';
  return new BolsaError(
    `Una secretaría no puede tener el mismo concepto en dos bolsas: ${detalle}${resto}.`,
    409,
  );
}

// ─────────────────────────── Lectura ─────────────────────────────────────────

function aBolsaDto(
  f: typeof flitoBolsasTransito.$inferSelect,
  cobertura: CoberturaBolsaTransito[],
): BolsaTransitoDto {
  return {
    id: f.id,
    nombre: f.nombre,
    saldo: num(f.saldo),
    ultimaCargaValor: f.ultimaCargaValor === null ? null : num(f.ultimaCargaValor),
    ultimaCargaEn: f.ultimaCargaEn?.toISOString() ?? null,
    cobertura,
  };
}

function conNivel(base: BolsaTransitoDto, cargado: string, consumido: string): BolsaTransitoConNivel {
  return {
    ...base,
    nivel: nivelBolsaTransitoDe(base.saldo, base.ultimaCargaValor),
    porcentaje: porcentajeSaldo(base.saldo, base.ultimaCargaValor),
    deuda: deudaBolsaTransito(base.saldo),
    totalCargado: redondear(num(cargado)),
    totalConsumido: redondear(num(consumido)),
  };
}

/** Bolsa con su nivel ya clasificado, o `null` si no existe. */
export async function bolsaTransitoDe(bolsaId: string): Promise<BolsaTransitoConNivel | null> {
  const [fila] = await db
    .select()
    .from(flitoBolsasTransito)
    .where(eq(flitoBolsasTransito.id, bolsaId))
    .limit(1);
  if (!fila) return null;

  // El valor se guarda siempre positivo y la dirección la da `tipo`, así que los dos totales salen
  // de la misma pasada filtrando por dirección.
  const [[totales], cobertura] = await Promise.all([
    db.select({
      cargado: sql<string>`coalesce(sum(case when ${flitoBolsaTransitoMovimientos.tipo} = 'entrada' then ${flitoBolsaTransitoMovimientos.valor} else 0 end), 0)`,
      consumido: sql<string>`coalesce(sum(case when ${flitoBolsaTransitoMovimientos.tipo} = 'salida' then ${flitoBolsaTransitoMovimientos.valor} else 0 end), 0)`,
    })
      .from(flitoBolsaTransitoMovimientos)
      .where(eq(flitoBolsaTransitoMovimientos.bolsaId, bolsaId)),
    coberturaDe([bolsaId]),
  ]);

  return conNivel(
    aBolsaDto(fila, cobertura.get(bolsaId) ?? []),
    totales?.cargado ?? '0',
    totales?.consumido ?? '0',
  );
}

/**
 * Orden en que se atienden las bolsas: primero la que más urge (HU #11210).
 *
 * `sin_cargas` va por delante de `normal` a propósito, aunque no sea una alarma: una bolsa creada a
 * la que nunca se le ha cargado nada es un trámite pendiente de alguien, mientras que una en nivel
 * normal no pide nada.
 */
const ORDEN_NIVEL: Record<NivelBolsaTransito, number> = {
  en_prestamo: 0, agotada: 1, critico: 2, bajo: 3, sin_cargas: 4, normal: 5,
};

/**
 * Todas las bolsas de tránsito, de la más urgente a la más tranquila (HU #11210, AC9).
 *
 * Tres consultas fijas, no una por bolsa: el listado se pinta entero de una vez y un N+1 aquí
 * crecería con cada bolsa que se abra.
 */
export async function bolsasTransito(): Promise<BolsaTransitoConNivel[]> {
  const filas = await db.select().from(flitoBolsasTransito).orderBy(flitoBolsasTransito.nombre);
  if (filas.length === 0) return [];

  const ids = filas.map((f) => f.id);
  const [totales, cobertura] = await Promise.all([
    db.select({
      bolsaId: flitoBolsaTransitoMovimientos.bolsaId,
      cargado: sql<string>`coalesce(sum(case when ${flitoBolsaTransitoMovimientos.tipo} = 'entrada' then ${flitoBolsaTransitoMovimientos.valor} else 0 end), 0)`,
      consumido: sql<string>`coalesce(sum(case when ${flitoBolsaTransitoMovimientos.tipo} = 'salida' then ${flitoBolsaTransitoMovimientos.valor} else 0 end), 0)`,
    })
      .from(flitoBolsaTransitoMovimientos)
      .where(inArray(flitoBolsaTransitoMovimientos.bolsaId, ids))
      .groupBy(flitoBolsaTransitoMovimientos.bolsaId),
    coberturaDe(ids),
  ]);

  const totalPorBolsa = new Map(totales.map((t) => [t.bolsaId, t]));

  return filas
    .map((f) => {
      const t = totalPorBolsa.get(f.id);
      return conNivel(
        aBolsaDto(f, cobertura.get(f.id) ?? []),
        t?.cargado ?? '0',
        t?.consumido ?? '0',
      );
    })
    .sort((a, b) => ORDEN_NIVEL[a.nivel] - ORDEN_NIVEL[b.nivel] || a.saldo - b.saldo);
}

/** Movimientos de la bolsa, del más reciente al más antiguo, con el trámite legible. */
export async function movimientosTransitoDe(bolsaId: string): Promise<MovimientoTransitoDto[]> {
  const filas = await db
    .select({
      m: flitoBolsaTransitoMovimientos,
      idFlit: flitoTramites.idFlit,
    })
    .from(flitoBolsaTransitoMovimientos)
    .leftJoin(flitoTramites, eq(flitoBolsaTransitoMovimientos.tramiteId, flitoTramites.id))
    .where(eq(flitoBolsaTransitoMovimientos.bolsaId, bolsaId))
    .orderBy(desc(flitoBolsaTransitoMovimientos.createdAt));

  return filas.map(({ m, idFlit }) => ({ ...aMovimientoDto(m), idFlit: idFlit ?? null }));
}

// ─────────────────────────── Creación y edición ──────────────────────────────

/**
 * Crea una bolsa con su cobertura.
 *
 * Bolsa y cobertura se escriben en la MISMA transacción: una bolsa sin cobertura no cubriría nada y
 * sería dinero sin destino, exactamente el estado que este modelo existe para evitar.
 */
export async function crearBolsaTransito(
  datos: DatosBolsaTransito,
  _ctx: CtxUsuario,
): Promise<BolsaTransitoConNivel> {
  const { nombre, organismos, conceptos } = normalizarDatos(datos);

  const id = await db.transaction(async (tx) => {
    let bolsaId: string;
    try {
      const [creada] = await tx.insert(flitoBolsasTransito).values({ nombre, saldo: '0' }).returning();
      bolsaId = creada.id;
    } catch (e) {
      if (esLlaveDuplicada(e)) throw new BolsaError(`Ya existe una bolsa llamada «${nombre}»`, 409);
      throw e;
    }

    try {
      await tx.insert(flitoBolsaTransitoCobertura).values(
        organismos.flatMap((organismoCodigo) =>
          conceptos.map((concepto) => ({ bolsaId, organismoCodigo, concepto }))),
      );
    } catch (e) {
      if (!esLlaveDuplicada(e)) throw e;
      throw await errorDeSolapamiento(organismos, conceptos);
    }
    return bolsaId;
  });

  const bolsa = await bolsaTransitoDe(id);
  if (!bolsa) throw new BolsaError('No fue posible crear la bolsa', 500);
  return bolsa;
}

/**
 * Redefine nombre y cobertura de una bolsa. El SALDO no se toca: es dinero real y no se edita.
 *
 * La cobertura se reemplaza entera (borrar + insertar) en vez de calcular el diferencial: el
 * formulario manda el estado final, y un diff sobre tres conceptos no compra nada frente a la
 * simplicidad de reescribirla. Sigue dentro de una transacción, así que nadie ve la bolsa sin
 * cobertura a medio camino.
 */
export async function actualizarBolsaTransito(
  bolsaId: string,
  datos: DatosBolsaTransito,
  _ctx: CtxUsuario,
): Promise<BolsaTransitoConNivel> {
  const { nombre, organismos, conceptos } = normalizarDatos(datos);

  await db.transaction(async (tx) => {
    const [existe] = await tx
      .select({ id: flitoBolsasTransito.id })
      .from(flitoBolsasTransito)
      .where(eq(flitoBolsasTransito.id, bolsaId))
      .limit(1);
    if (!existe) throw new BolsaError('La bolsa no existe', 404);

    try {
      await tx.update(flitoBolsasTransito)
        .set({ nombre, updatedAt: new Date() })
        .where(eq(flitoBolsasTransito.id, bolsaId));
    } catch (e) {
      if (esLlaveDuplicada(e)) throw new BolsaError(`Ya existe una bolsa llamada «${nombre}»`, 409);
      throw e;
    }

    await tx.delete(flitoBolsaTransitoCobertura)
      .where(eq(flitoBolsaTransitoCobertura.bolsaId, bolsaId));

    try {
      await tx.insert(flitoBolsaTransitoCobertura).values(
        organismos.flatMap((organismoCodigo) =>
          conceptos.map((concepto) => ({ bolsaId, organismoCodigo, concepto }))),
      );
    } catch (e) {
      if (!esLlaveDuplicada(e)) throw e;
      throw await errorDeSolapamiento(organismos, conceptos, bolsaId);
    }
  });

  const bolsa = await bolsaTransitoDe(bolsaId);
  if (!bolsa) throw new BolsaError('La bolsa no existe', 404);
  return bolsa;
}

// ─────────────────────────── Escritura del libro ─────────────────────────────

interface DatosMovimientoTransito {
  tipo: TipoMovimientoTransito;
  origen: OrigenMovimientoTransito;
  valor: number;
  fecha: string;
  organismoCodigo?: string | null;
  concepto?: ConceptoBolsaTransito | null;
  tramiteId?: string | null;
  observacion?: string | null;
  soporteId?: string | null;
  llaveIdempotencia?: string | null;
  etiqueta?: string;
}

/** Bloquea la fila de la bolsa (`FOR UPDATE`). La bolsa ya existe: se crea explícitamente. */
async function bolsaBloqueada(tx: Tx, bolsaId: string): Promise<{ id: string; saldo: number }> {
  const [fila] = await tx
    .select({ id: flitoBolsasTransito.id, saldo: flitoBolsasTransito.saldo })
    .from(flitoBolsasTransito)
    .where(eq(flitoBolsasTransito.id, bolsaId))
    .for('update')
    .limit(1);
  if (!fila) throw new BolsaError('La bolsa no existe', 404);
  return { id: fila.id, saldo: num(fila.saldo) };
}

/** Comprueba lo que no depende de la base: valor redondeado y fecha contable real. */
function validarMovimiento(datos: DatosMovimientoTransito): { valor: number; fecha: string } {
  const etiqueta = datos.etiqueta ?? 'movimiento';
  const valor = redondear(datos.valor);
  if (!Number.isFinite(valor) || valor <= 0) {
    throw new BolsaError(`El valor de la ${etiqueta} debe ser mayor que cero`);
  }
  if (valor > TOPE_NUMERIC) {
    throw new BolsaError(`El valor de la ${etiqueta} excede el máximo admitido`);
  }
  const fecha = parseFechaQuery(datos.fecha);
  if (fecha === null) throw new BolsaError('La fecha del movimiento no es válida');
  if (fecha > hoyIso()) throw new BolsaError('La fecha del movimiento no puede ser futura');
  return { valor, fecha };
}

/**
 * El cuerpo del asiento, sobre una transacción YA abierta.
 *
 * NO valida saldo suficiente: la bolsa puede quedar en negativo y eso es el préstamo (AC5). Si el
 * pago ya se hizo ante la secretaría, el gasto ocurrió; frenar el asiento no lo deshace.
 */
async function asentar(
  tx: Tx,
  bolsaId: string,
  datos: DatosMovimientoTransito,
  ctx: CtxUsuario,
): Promise<{ movimiento: MovimientoTransitoDto; duplicado: boolean }> {
  const { valor, fecha } = validarMovimiento(datos);

  // Pre-chequeo de la llave ANTES de tocar el saldo: un reintento del sellado no puede mover la
  // bolsa ni un peso (AC10).
  if (datos.llaveIdempotencia) {
    const previo = await movimientoPorLlave(tx, datos.llaveIdempotencia);
    if (previo) return { movimiento: previo, duplicado: true };
  }

  const bolsa = await bolsaBloqueada(tx, bolsaId);
  const delta = datos.tipo === 'entrada' ? valor : -valor;
  const saldoResultante = redondear(bolsa.saldo + delta);

  try {
    const [fila] = await tx.insert(flitoBolsaTransitoMovimientos).values({
      bolsaId: bolsa.id,
      organismoCodigo: datos.organismoCodigo ?? null,
      concepto: datos.concepto ?? null,
      tipo: datos.tipo,
      origen: datos.origen,
      tramiteId: datos.tramiteId ?? null,
      valor: String(valor),
      saldoResultante: String(saldoResultante),
      periodo: periodoDeFecha(fecha),
      fecha,
      observacion: datos.observacion ?? null,
      soporteId: datos.soporteId ?? null,
      registradoPorId: ctx.userId,
      registradoPorNombre: ctx.nombre.slice(0, 150),
      llaveIdempotencia: datos.llaveIdempotencia ?? null,
    }).returning();

    const actualizacion: Record<string, unknown> = {
      saldo: String(saldoResultante),
      updatedAt: new Date(),
    };
    // La última CARGA es la base del nivel de alerta. Solo la mueven las entradas de origen `carga`:
    // una devolución por reverso no es dinero nuevo y tomarla como base falsearía el porcentaje.
    if (datos.tipo === 'entrada' && datos.origen === 'carga') {
      actualizacion.ultimaCargaValor = String(valor);
      actualizacion.ultimaCargaEn = new Date();
    }
    await tx.update(flitoBolsasTransito)
      .set(actualizacion)
      .where(eq(flitoBolsasTransito.id, bolsa.id));

    return { movimiento: aMovimientoDto(fila), duplicado: false };
  } catch (e) {
    // Carrera contra otra transacción con la misma llave: la otra ganó y su movimiento es el bueno.
    if (!esLlaveDuplicada(e) || !datos.llaveIdempotencia) throw e;
    const previo = await movimientoPorLlave(tx, datos.llaveIdempotencia);
    if (!previo) throw e;
    return { movimiento: previo, duplicado: true };
  }
}

async function movimientoPorLlave(tx: Tx, llave: string): Promise<MovimientoTransitoDto | undefined> {
  const [fila] = await tx
    .select()
    .from(flitoBolsaTransitoMovimientos)
    .where(eq(flitoBolsaTransitoMovimientos.llaveIdempotencia, llave))
    .limit(1);
  return fila ? aMovimientoDto(fila) : undefined;
}

function aMovimientoDto(f: typeof flitoBolsaTransitoMovimientos.$inferSelect): MovimientoTransitoDto {
  return {
    id: f.id,
    bolsaId: f.bolsaId,
    organismoCodigo: f.organismoCodigo,
    concepto: f.concepto as ConceptoBolsaTransito | null,
    tipo: f.tipo as TipoMovimientoTransito,
    origen: f.origen as OrigenMovimientoTransito,
    tramiteId: f.tramiteId,
    idFlit: null,
    valor: num(f.valor),
    saldoResultante: num(f.saldoResultante),
    periodo: f.periodo,
    fecha: f.fecha,
    observacion: f.observacion,
    soporteId: f.soporteId,
    registradoPorNombre: f.registradoPorNombre,
    createdAt: f.createdAt.toISOString(),
  };
}

// ─────────────────────────── Carga (AC2, AC6) ────────────────────────────────

export interface DatosCargaTransito {
  valor: number;
  fecha?: string;
  observacion?: string | null;
  soporte?: SoporteRecarga | null;
}

/**
 * Carga saldo en la bolsa.
 *
 * Si venía en negativo, la carga NETA la deuda por pura aritmética (AC6): −4.000.000 más una carga
 * de 10.000.000 deja 6.000.000. Por eso el préstamo no necesita tabla ni estado propio.
 */
export async function registrarCargaTransito(
  bolsaId: string,
  datos: DatosCargaTransito,
  ctx: CtxUsuario,
): Promise<{ movimiento: MovimientoTransitoDto; saldo: number }> {
  const fecha = datos.fecha ?? hoyIso();
  return db.transaction(async (tx) => {
    const soporteId = datos.soporte
      ? await insertarSoporte(tx, datos.soporte, ctx, TIPO_SOPORTE_CARGA)
      : null;
    const { movimiento } = await asentar(tx, bolsaId, {
      tipo: 'entrada',
      origen: 'carga',
      valor: datos.valor,
      fecha,
      observacion: datos.observacion ?? null,
      soporteId,
      etiqueta: 'carga',
    }, ctx);
    return { movimiento, saldo: movimiento.saldoResultante };
  });
}

// ─────────────────────────── Consumo (AC3, AC4, AC8) ─────────────────────────

export interface DatosConsumoTransito {
  organismoCodigo: string;
  concepto: ConceptoBolsaTransito;
  tramiteId: string;
  /** Valor SIN GMF: el gravamen ya viene incluido en el comprobante del organismo (AC4). */
  valor: number;
  fecha: string;
  /** Llave sin prefijo de familia; la pone quien conoce la naturaleza del consumo. */
  llave: string;
}

/**
 * Asienta el consumo de un concepto en la bolsa que lo cubra, dentro de la transacción del sellado.
 *
 * No hace nada si ninguna bolsa cubre ese par: sellar un trámite de una secretaría que nadie metió
 * en una bolsa tiene que seguir funcionando igual (AC1). Se comprueba ANTES de entrar al asiento
 * para no tocar ninguna bolsa por accidente.
 */
export async function registrarConsumoTransito(
  tx: Tx,
  datos: DatosConsumoTransito,
  ctx: CtxUsuario,
): Promise<MovimientoTransitoDto | null> {
  const bolsa = await bolsaQueCubre(tx, datos.organismoCodigo, datos.concepto);
  if (!bolsa) return null;

  const { movimiento, duplicado } = await asentar(tx, bolsa.id, {
    tipo: 'salida',
    origen: 'automatico',
    valor: datos.valor,
    fecha: datos.fecha,
    organismoCodigo: datos.organismoCodigo,
    concepto: datos.concepto,
    tramiteId: datos.tramiteId,
    llaveIdempotencia: `${PREFIJO_CONSUMO}${datos.llave}`,
    etiqueta: 'salida',
  }, ctx);
  return duplicado ? null : movimiento;
}

/**
 * Devuelve a las bolsas lo que consumió este trámite (AC9).
 *
 * Igual que en la bolsa del cliente: el libro es append-only, así que devolver es asentar una
 * entrada nueva, y solo alcanza a los consumos VIVOS —los que conservan su llave sin prefijar—, de
 * modo que reversar dos veces no acredita dos veces.
 *
 * Un mismo trámite puede haber consumido de VARIAS bolsas (el derecho de una, el impuesto de otra),
 * así que cada contrapartida se asienta en la bolsa de la que salió el consumo original.
 */
export async function reversarConsumoTransito(
  tx: Tx,
  tramiteId: string,
  ctx: CtxUsuario,
): Promise<MovimientoTransitoDto[]> {
  const consumos = await tx
    .select()
    .from(flitoBolsaTransitoMovimientos)
    .where(and(
      eq(flitoBolsaTransitoMovimientos.tramiteId, tramiteId),
      eq(flitoBolsaTransitoMovimientos.origen, 'automatico'),
      eq(flitoBolsaTransitoMovimientos.tipo, 'salida'),
      like(flitoBolsaTransitoMovimientos.llaveIdempotencia, `${PREFIJO_CONSUMO}%`),
    ));

  const contras: MovimientoTransitoDto[] = [];
  for (const c of consumos) {
    const { movimiento } = await asentar(tx, c.bolsaId, {
      tipo: 'entrada',
      origen: 'automatico',
      valor: num(c.valor),
      fecha: hoyIso(),
      organismoCodigo: c.organismoCodigo,
      concepto: c.concepto as ConceptoBolsaTransito | null,
      tramiteId: c.tramiteId,
      observacion: `Reverso de la liquidación: devuelve el consumo de ${c.concepto ?? 'el trámite'}`,
      llaveIdempotencia: `contra:${c.id}`,
    }, ctx);
    contras.push(movimiento);

    // Libera la llave del consumo original para que volver a liquidar vuelva a consumir.
    await tx
      .update(flitoBolsaTransitoMovimientos)
      .set({ llaveIdempotencia: `${PREFIJO_REVERSADO}${c.llaveIdempotencia}`.slice(0, 200) })
      .where(eq(flitoBolsaTransitoMovimientos.id, c.id));
  }
  return contras;
}
