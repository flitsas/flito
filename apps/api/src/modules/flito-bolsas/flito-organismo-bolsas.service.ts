// FLITO — bolsa prepago de FLIT en un Organismo de Tránsito (HU #11161, Feature #11120 §4).
//
// Es la INVERSA de la bolsa del cliente y conviene tenerlo presente al leer: aquí FLIT precarga el
// dinero en la secretaría y ella lo consume cada vez que emite un derecho de trámite. La pregunta
// que este módulo responde es «¿cuánto le queda a Medellín?», no «¿cuánto le debemos?».
//
// Reutiliza los helpers de `flito-bolsas.service.ts` (redondeo, tope, fecha contable, periodo) a
// propósito: son dos libros distintos, pero si sus reglas de imputación divergieran, el mismo
// movimiento podría caer en meses distintos según qué bolsa lo mire.

import { and, desc, eq, inArray, like, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  flitoOrganismoBolsas, flitoOrganismoMovimientos, flitoTramites, organismosTransitoConfig,
} from '../../db/schema.js';
import { parseFechaQuery } from '../../shared/utils/fecha-rango.js';
import {
  type BolsaOrganismoConNivel,
  type BolsaOrganismoDto,
  deudaConOrganismo,
  type MovimientoOrganismoDto,
  nivelBolsaOrganismoDe,
  type NivelBolsaOrganismo,
  type OrigenMovimientoOrganismo,
  porcentajeSaldo,
  type TipoMovimientoOrganismo,
} from '@operaciones/shared-types';
import {
  BolsaError, type CtxUsuario, esLlaveDuplicada, hoyIso, insertarSoporte, num, periodoDeFecha,
  redondear, type SoporteRecarga, TOPE_NUMERIC, type Tx,
} from './flito-bolsas.service.js';

export type { BolsaOrganismoConNivel, BolsaOrganismoDto, MovimientoOrganismoDto };

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

// ─────────────────────────── Lectura ─────────────────────────────────────────

/** Si el organismo está marcado para operar con saldo prepago (AC1). */
export async function llevaBolsa(codigo: string): Promise<boolean> {
  const [fila] = await db
    .select({ lleva: organismosTransitoConfig.flitoLlevaBolsa })
    .from(organismosTransitoConfig)
    .where(eq(organismosTransitoConfig.codigo, codigo))
    .limit(1);
  return fila?.lleva === true;
}

function aBolsaDto(f: typeof flitoOrganismoBolsas.$inferSelect): BolsaOrganismoDto {
  return {
    id: f.id,
    organismoCodigo: f.organismoCodigo,
    saldo: num(f.saldo),
    ultimaCargaValor: f.ultimaCargaValor === null ? null : num(f.ultimaCargaValor),
    ultimaCargaEn: f.ultimaCargaEn?.toISOString() ?? null,
  };
}

/**
 * Bolsa del organismo con su nivel ya clasificado, o `null` si ese organismo no lleva bolsa.
 *
 * Devolver `null` y no una bolsa en cero es deliberado: «este organismo no opera con saldo prepago»
 * y «opera y está en cero» son estados distintos, y la pantalla tiene que poder distinguirlos.
 */
export async function bolsaOrganismoDe(codigo: string): Promise<BolsaOrganismoConNivel | null> {
  if (!await llevaBolsa(codigo)) return null;

  const [fila] = await db
    .select()
    .from(flitoOrganismoBolsas)
    .where(eq(flitoOrganismoBolsas.organismoCodigo, codigo))
    .limit(1);

  // Marcado pero sin movimientos todavía: la bolsa existe conceptualmente aunque su fila no.
  const base: BolsaOrganismoDto = fila ? aBolsaDto(fila) : {
    id: '', organismoCodigo: codigo, saldo: 0, ultimaCargaValor: null, ultimaCargaEn: null,
  };

  // El valor se guarda siempre positivo y la dirección la da `tipo`, así que los dos totales salen
  // de la misma pasada filtrando por dirección.
  const [totales] = await db
    .select({
      cargado: sql<string>`coalesce(sum(case when ${flitoOrganismoMovimientos.tipo} = 'entrada' then ${flitoOrganismoMovimientos.valor} else 0 end), 0)`,
      consumido: sql<string>`coalesce(sum(case when ${flitoOrganismoMovimientos.tipo} = 'salida' then ${flitoOrganismoMovimientos.valor} else 0 end), 0)`,
    })
    .from(flitoOrganismoMovimientos)
    .where(eq(flitoOrganismoMovimientos.organismoCodigo, codigo));

  return {
    ...base,
    nivel: nivelBolsaOrganismoDe(base.saldo, base.ultimaCargaValor),
    porcentaje: porcentajeSaldo(base.saldo, base.ultimaCargaValor),
    deuda: deudaConOrganismo(base.saldo),
    totalCargado: redondear(num(totales?.cargado ?? '0')),
    totalConsumido: redondear(num(totales?.consumido ?? '0')),
  };
}

/**
 * Orden en que se atienden los organismos: primero el que más urge (HU #11210).
 *
 * `sin_cargas` va por delante de `normal` a propósito, aunque no sea una alarma: un organismo
 * marcado para llevar bolsa al que nunca se le ha cargado nada es un trámite pendiente de alguien,
 * mientras que uno en nivel normal no pide nada.
 */
const ORDEN_NIVEL: Record<NivelBolsaOrganismo, number> = {
  en_prestamo: 0, agotada: 1, critico: 2, bajo: 3, sin_cargas: 4, normal: 5,
};

/**
 * Todas las bolsas de organismo, del más urgente al más tranquilo (HU #11210, AC9).
 *
 * Los organismos SIN marcar quedan fuera de la lista, no en cero: la pantalla lista lo que FLIT
 * gestiona con saldo prepago, y meter ahí a los demás sería inventarles una bolsa que no existe.
 *
 * Tres consultas fijas, no una por organismo: el listado se pinta entero de una vez y un N+1 aquí
 * crecería con cada secretaría que se sume al modelo prepago.
 */
export async function bolsasOrganismos(): Promise<BolsaOrganismoConNivel[]> {
  const marcados = await db
    .select({ codigo: organismosTransitoConfig.codigo })
    .from(organismosTransitoConfig)
    .where(eq(organismosTransitoConfig.flitoLlevaBolsa, true));
  if (marcados.length === 0) return [];

  const codigos = marcados.map((m) => m.codigo);

  const [filas, totales] = await Promise.all([
    db.select().from(flitoOrganismoBolsas)
      .where(inArray(flitoOrganismoBolsas.organismoCodigo, codigos)),
    db.select({
      codigo: flitoOrganismoMovimientos.organismoCodigo,
      cargado: sql<string>`coalesce(sum(case when ${flitoOrganismoMovimientos.tipo} = 'entrada' then ${flitoOrganismoMovimientos.valor} else 0 end), 0)`,
      consumido: sql<string>`coalesce(sum(case when ${flitoOrganismoMovimientos.tipo} = 'salida' then ${flitoOrganismoMovimientos.valor} else 0 end), 0)`,
    })
      .from(flitoOrganismoMovimientos)
      .where(inArray(flitoOrganismoMovimientos.organismoCodigo, codigos))
      .groupBy(flitoOrganismoMovimientos.organismoCodigo),
  ]);

  const porCodigo = new Map(filas.map((f) => [f.organismoCodigo, f]));
  const totalPorCodigo = new Map(totales.map((t) => [t.codigo, t]));

  return codigos
    .map((codigo) => {
      const fila = porCodigo.get(codigo);
      // Marcado pero sin movimientos: la bolsa existe conceptualmente aunque su fila todavía no,
      // igual que en `bolsaOrganismoDe`. Omitirlo escondería justo a los que falta cargar.
      const base: BolsaOrganismoDto = fila ? aBolsaDto(fila) : {
        id: '', organismoCodigo: codigo, saldo: 0, ultimaCargaValor: null, ultimaCargaEn: null,
      };
      const t = totalPorCodigo.get(codigo);
      return {
        ...base,
        nivel: nivelBolsaOrganismoDe(base.saldo, base.ultimaCargaValor),
        porcentaje: porcentajeSaldo(base.saldo, base.ultimaCargaValor),
        deuda: deudaConOrganismo(base.saldo),
        totalCargado: redondear(num(t?.cargado ?? '0')),
        totalConsumido: redondear(num(t?.consumido ?? '0')),
      };
    })
    .sort((a, b) => ORDEN_NIVEL[a.nivel] - ORDEN_NIVEL[b.nivel] || a.saldo - b.saldo);
}

/** Movimientos del organismo, del más reciente al más antiguo, con el trámite legible. */
export async function movimientosOrganismoDe(codigo: string): Promise<MovimientoOrganismoDto[]> {
  const filas = await db
    .select({
      m: flitoOrganismoMovimientos,
      idFlit: flitoTramites.idFlit,
    })
    .from(flitoOrganismoMovimientos)
    .leftJoin(flitoTramites, eq(flitoOrganismoMovimientos.tramiteId, flitoTramites.id))
    .where(eq(flitoOrganismoMovimientos.organismoCodigo, codigo))
    .orderBy(desc(flitoOrganismoMovimientos.createdAt));

  return filas.map(({ m, idFlit }) => ({
    id: m.id,
    organismoCodigo: m.organismoCodigo,
    tipo: m.tipo as TipoMovimientoOrganismo,
    origen: m.origen as OrigenMovimientoOrganismo,
    tramiteId: m.tramiteId,
    idFlit: idFlit ?? null,
    valor: num(m.valor),
    saldoResultante: num(m.saldoResultante),
    periodo: m.periodo,
    fecha: m.fecha,
    observacion: m.observacion,
    soporteId: m.soporteId,
    registradoPorNombre: m.registradoPorNombre,
    createdAt: m.createdAt.toISOString(),
  }));
}

// ─────────────────────────── Escritura ───────────────────────────────────────

interface DatosMovimientoOrganismo {
  tipo: TipoMovimientoOrganismo;
  origen: OrigenMovimientoOrganismo;
  valor: number;
  fecha: string;
  tramiteId?: string | null;
  observacion?: string | null;
  soporteId?: string | null;
  llaveIdempotencia?: string | null;
  etiqueta?: string;
}

/**
 * Bloquea la fila de la bolsa (`FOR UPDATE`) y la abre si es la primera vez.
 *
 * Exige que el organismo esté marcado: sin esa comprobación, un consumo podría abrir en silencio la
 * bolsa de una secretaría que nadie decidió gestionar así (AC1).
 */
async function bolsaBloqueada(
  tx: Tx,
  codigo: string,
): Promise<{ id: string; saldo: number }> {
  const [config] = await tx
    .select({ lleva: organismosTransitoConfig.flitoLlevaBolsa })
    .from(organismosTransitoConfig)
    .where(eq(organismosTransitoConfig.codigo, codigo))
    .limit(1);
  if (!config) throw new BolsaError('El organismo no existe', 404);
  if (config.lleva !== true) {
    throw new BolsaError('Este Organismo de Tránsito no maneja bolsa prepago', 409);
  }

  const bloquear = async () => {
    const [fila] = await tx
      .select({ id: flitoOrganismoBolsas.id, saldo: flitoOrganismoBolsas.saldo })
      .from(flitoOrganismoBolsas)
      .where(eq(flitoOrganismoBolsas.organismoCodigo, codigo))
      .for('update')
      .limit(1);
    return fila;
  };

  const existente = await bloquear();
  if (existente) return { id: existente.id, saldo: num(existente.saldo) };

  // `FOR UPDATE` sobre una fila que aún no existe no bloquea nada: dos primeras cargas simultáneas
  // llegarían ambas hasta aquí. `DO NOTHING` deja que una gane y que la otra relea la fila ya creada.
  await tx
    .insert(flitoOrganismoBolsas)
    .values({ organismoCodigo: codigo, saldo: '0' })
    .onConflictDoNothing({ target: flitoOrganismoBolsas.organismoCodigo });

  const creada = await bloquear();
  if (!creada) throw new BolsaError('No fue posible abrir la bolsa del organismo', 409);
  return { id: creada.id, saldo: num(creada.saldo) };
}

/** Comprueba lo que no depende de la base: valor redondeado y fecha contable real. */
function validarMovimiento(datos: DatosMovimientoOrganismo): { valor: number; fecha: string } {
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
 * NO valida saldo suficiente: la bolsa puede quedar en negativo y eso es el préstamo del organismo
 * (AC5). Si la secretaría ya emitió el derecho, el gasto ocurrió; frenar el asiento no lo deshace.
 */
async function asentar(
  tx: Tx,
  codigo: string,
  datos: DatosMovimientoOrganismo,
  ctx: CtxUsuario,
): Promise<{ movimiento: MovimientoOrganismoDto; duplicado: boolean }> {
  const { valor, fecha } = validarMovimiento(datos);

  // Pre-chequeo de la llave ANTES de tocar el saldo: un reintento del sellado no puede mover la
  // bolsa ni un peso (AC10).
  if (datos.llaveIdempotencia) {
    const previo = await movimientoPorLlave(tx, datos.llaveIdempotencia);
    if (previo) return { movimiento: previo, duplicado: true };
  }

  const bolsa = await bolsaBloqueada(tx, codigo);
  const delta = datos.tipo === 'entrada' ? valor : -valor;
  const saldoResultante = redondear(bolsa.saldo + delta);

  try {
    const [fila] = await tx.insert(flitoOrganismoMovimientos).values({
      bolsaId: bolsa.id,
      organismoCodigo: codigo,
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
    await tx.update(flitoOrganismoBolsas)
      .set(actualizacion)
      .where(eq(flitoOrganismoBolsas.id, bolsa.id));

    return { movimiento: aMovimientoDto(fila), duplicado: false };
  } catch (e) {
    // Carrera contra otra transacción con la misma llave: la otra ganó y su movimiento es el bueno.
    if (!esLlaveDuplicada(e) || !datos.llaveIdempotencia) throw e;
    const previo = await movimientoPorLlave(tx, datos.llaveIdempotencia);
    if (!previo) throw e;
    return { movimiento: previo, duplicado: true };
  }
}

async function movimientoPorLlave(tx: Tx, llave: string): Promise<MovimientoOrganismoDto | undefined> {
  const [fila] = await tx
    .select()
    .from(flitoOrganismoMovimientos)
    .where(eq(flitoOrganismoMovimientos.llaveIdempotencia, llave))
    .limit(1);
  return fila ? aMovimientoDto(fila) : undefined;
}

function aMovimientoDto(f: typeof flitoOrganismoMovimientos.$inferSelect): MovimientoOrganismoDto {
  return {
    id: f.id,
    organismoCodigo: f.organismoCodigo,
    tipo: f.tipo as TipoMovimientoOrganismo,
    origen: f.origen as OrigenMovimientoOrganismo,
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

export interface DatosCargaOrganismo {
  valor: number;
  fecha?: string;
  observacion?: string | null;
  soporte?: SoporteRecarga | null;
}

/**
 * Carga saldo en la bolsa del organismo.
 *
 * Si la bolsa venía en negativo, la carga NETA la deuda por pura aritmética (AC6): −4.000.000 más
 * una carga de 10.000.000 deja 6.000.000. Por eso el préstamo no necesita tabla ni estado propio.
 */
export async function registrarCargaOrganismo(
  codigo: string,
  datos: DatosCargaOrganismo,
  ctx: CtxUsuario,
): Promise<{ movimiento: MovimientoOrganismoDto; saldo: number }> {
  const fecha = datos.fecha ?? hoyIso();
  return db.transaction(async (tx) => {
    const soporteId = datos.soporte
      ? await insertarSoporte(tx, datos.soporte, ctx, TIPO_SOPORTE_CARGA)
      : null;
    const { movimiento } = await asentar(tx, codigo, {
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

// ─────────────────────────── Consumo del derecho (AC3, AC4, AC8) ─────────────

export interface DatosConsumoDerecho {
  organismoCodigo: string;
  tramiteId: string;
  /** Valor del derecho SIN GMF: el gravamen ya viene incluido en el comprobante del organismo (AC4). */
  valor: number;
  fecha: string;
  /** Llave sin prefijo de familia; la pone quien conoce la naturaleza del consumo. */
  llave: string;
}

/**
 * Asienta el consumo del derecho en la bolsa del organismo, dentro de la transacción del sellado.
 *
 * No hace nada si el organismo no lleva bolsa: sellar un trámite de una secretaría que no opera con
 * saldo prepago tiene que seguir funcionando igual (AC1). Se comprueba ANTES de entrar al asiento
 * para no abrirle una bolsa por accidente.
 */
export async function registrarConsumoDerecho(
  tx: Tx,
  datos: DatosConsumoDerecho,
  ctx: CtxUsuario,
): Promise<MovimientoOrganismoDto | null> {
  const [config] = await tx
    .select({ lleva: organismosTransitoConfig.flitoLlevaBolsa })
    .from(organismosTransitoConfig)
    .where(eq(organismosTransitoConfig.codigo, datos.organismoCodigo))
    .limit(1);
  if (config?.lleva !== true) return null;

  const { movimiento, duplicado } = await asentar(tx, datos.organismoCodigo, {
    tipo: 'salida',
    origen: 'automatico',
    valor: datos.valor,
    fecha: datos.fecha,
    tramiteId: datos.tramiteId,
    llaveIdempotencia: `${PREFIJO_CONSUMO}${datos.llave}`,
    etiqueta: 'salida',
  }, ctx);
  return duplicado ? null : movimiento;
}

/**
 * Devuelve a la bolsa del organismo lo que consumió este trámite (AC9).
 *
 * Igual que en la bolsa del cliente: el libro es append-only, así que devolver es asentar una
 * entrada nueva, y solo alcanza a los consumos VIVOS —los que conservan su llave sin prefijar—, de
 * modo que reversar dos veces no acredita dos veces.
 */
export async function reversarConsumoDerecho(
  tx: Tx,
  tramiteId: string,
  ctx: CtxUsuario,
): Promise<MovimientoOrganismoDto[]> {
  const consumos = await tx
    .select()
    .from(flitoOrganismoMovimientos)
    .where(and(
      eq(flitoOrganismoMovimientos.tramiteId, tramiteId),
      eq(flitoOrganismoMovimientos.origen, 'automatico'),
      eq(flitoOrganismoMovimientos.tipo, 'salida'),
      like(flitoOrganismoMovimientos.llaveIdempotencia, `${PREFIJO_CONSUMO}%`),
    ));

  const contras: MovimientoOrganismoDto[] = [];
  for (const c of consumos) {
    const { movimiento } = await asentar(tx, c.organismoCodigo, {
      tipo: 'entrada',
      origen: 'automatico',
      valor: num(c.valor),
      fecha: hoyIso(),
      tramiteId: c.tramiteId,
      observacion: 'Reverso de la liquidación: devuelve el consumo del derecho de tránsito',
      llaveIdempotencia: `contra:${c.id}`,
    }, ctx);
    contras.push(movimiento);

    // Libera la llave del consumo original para que volver a liquidar vuelva a consumir.
    await tx
      .update(flitoOrganismoMovimientos)
      .set({ llaveIdempotencia: `${PREFIJO_REVERSADO}${c.llaveIdempotencia}`.slice(0, 200) })
      .where(eq(flitoOrganismoMovimientos.id, c.id));
  }
  return contras;
}
