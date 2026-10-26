// FLITO — bolsa que FLIT precarga para pagar trámites ante las secretarías (HU #11161, ajuste 0124).
//
// Es la INVERSA de la bolsa del cliente y conviene tenerlo presente al leer: aquí FLIT pone el
// dinero por adelantado y un tercero lo gasta pagando ante las secretarías. La pregunta que este
// módulo responde es «¿cuánto le queda a la bolsa de mi sector?», no «¿cuánto le debemos?».
//
// Una bolsa NO es una secretaría. Cubre parejas (secretaría, concepto) —Medellín, Envigado y
// Sabaneta solo para impuestos, por ejemplo— y ese par no puede repetirse en dos bolsas ACTIVAS.
// Esa exclusividad, garantizada por el índice parcial `uq_flito_bolsas_unicas_cobertura_activa`
// (ADR-0029 D3), es lo que hace que `bolsaQueCubre` devuelva como mucho una candidata y que el
// sellado de la liquidación no tenga que preguntarle a nadie a dónde va el dinero.
//
// HU #13906 (Feature #13887, ADR-0029): desde la 0257 este módulo lee y escribe el MODELO ÚNICO
// (`flito_bolsas_unicas` con `alcance='transito'`, su cobertura y el libro único). HU #13911 retiró las
// rutas `/transito/…` (y aquí su listado, alta y edición: los da el catálogo único); queda el libro —
// movimientos, carga, consumo y reverso—. El origen 'recarga' del libro único se sigue mostrando como
// 'carga' en `MovimientoTransitoDto` (`OrigenMovimientoTransito`). El asiento es el núcleo
// común de `flito-bolsas.libro.ts` (`asentarEnBolsa`), así que las reglas de imputación (periodo,
// redondeo, tope, fecha) son por construcción las mismas en los dos alcances.
//
// RN-T1 (Q7): una bolsa inactiva no admite cargas (409 `bolsa_inactiva`) ni consumos; sí la
//        devolución de sus propios consumos al reversar una liquidación.

import { and, desc, eq, like } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { flitoBolsasUnicasMovimientos, flitoTramites } from '../../db/schema.js';
import {
  CodigoErrorBolsa,
  type ConceptoBolsaTransito,
  type MovimientoBolsaDto,
  type MovimientoTransitoDto,
  type OrigenMovimientoTransito,
  type TipoMovimientoTransito,
} from '@operaciones/shared-types';
import {
  aMovimientoDto as aMovimientoLibro, asentarEnBolsa, BolsaError, bolsaBloqueadaPorId, type BolsaEnLibro,
  type CtxUsuario, type DatosMovimiento, hoyIso, MSG_BOLSA_INACTIVA, movimientoPorLlave, num,
  llaveReversada, type SoporteRecarga, type Tx, validarMovimiento,
} from './flito-bolsas.libro.js';
import { bolsaTransitoPara } from './flito-bolsas.resolver.js';

export type { MovimientoTransitoDto };

/** Tipo del comprobante de una carga en `flito_soportes`. */
const TIPO_SOPORTE_CARGA = 'carga_organismo';

/** Prefijo de familia de las llaves. El índice único es uno solo para todo el libro único. */
export const PREFIJO_CONSUMO = 'consumo:';

// ─────────────────────────── Cobertura ───────────────────────────────────────

/**
 * La bolsa ACTIVA que cubre un concepto ante una secretaría, o `null` si ninguna lo hace.
 *
 * Delega en `bolsaTransitoPara` (resolver común del gancho de descuento) y sale con la bolsa
 * BLOQUEADA. Que devuelva `null` es un desenlace NORMAL —la mayoría de las secretarías no están en
 * ninguna bolsa, o su bolsa está inactiva— y quien llama debe tratarlo como «aquí no hay nada que
 * descontar», nunca como un error.
 */
export async function bolsaQueCubre(
  tx: Tx,
  organismoCodigo: string,
  concepto: ConceptoBolsaTransito,
): Promise<(BolsaEnLibro & { nombre: string }) | null> {
  const r = await bolsaTransitoPara(tx, organismoCodigo, concepto);
  return r.bolsa ?? null;
}

// ─────────────────────────── Lectura ─────────────────────────────────────────

const M = flitoBolsasUnicasMovimientos;
/** Movimientos de la bolsa, del más reciente al más antiguo, con el trámite legible. */
export async function movimientosTransitoDe(bolsaId: string): Promise<MovimientoTransitoDto[]> {
  const filas = await db
    .select({ m: M, idFlit: flitoTramites.idFlit })
    .from(M)
    .leftJoin(flitoTramites, eq(M.tramiteId, flitoTramites.id))
    .where(eq(M.bolsaId, bolsaId))
    .orderBy(desc(M.createdAt));

  return filas.map(({ m, idFlit }) => aMovimientoDto(aMovimientoLibro(m, null, idFlit ?? null)));
}

// ─────────────────────────── Escritura del libro ─────────────────────────────

/** Bloquea la bolsa (`FOR UPDATE`) y exige que sea de tránsito. La bolsa se crea explícitamente. */
async function bolsaTransitoBloqueada(tx: Tx, bolsaId: string): Promise<BolsaEnLibro> {
  const bolsa = await bolsaBloqueadaPorId(tx, bolsaId);
  // Una bolsa de compañía tiene `companiaId`; por las rutas de tránsito no existe.
  if (!bolsa || bolsa.companiaId !== null) throw new BolsaError('La bolsa no existe', 404);
  return bolsa;
}

/**
 * El asiento de tránsito sobre el núcleo común (`asentarEnBolsa`).
 *
 * Pre-chequeo de la llave ANTES de tocar el saldo: un reintento del sellado no puede mover la bolsa
 * ni un peso (AC10). La SEGUNDA lectura, ya dentro del lock, la hace `asentarEnBolsa` (Bug #11685,
 * punto 1): la familia `consumo:soat:*` tiene dos escritores —sellado y conciliación— que en un
 * trámite sin cliente solo se serializan por el lock de ESTA bolsa.
 *
 * NO valida saldo suficiente: la bolsa puede quedar en negativo y eso es el préstamo (AC5).
 */
async function asentar(
  tx: Tx,
  bolsa: BolsaEnLibro,
  datos: DatosMovimiento,
  ctx: CtxUsuario,
): Promise<{ movimiento: MovimientoTransitoDto; duplicado: boolean }> {
  // Savepoint (Bug #11685 punto 3): tras un 23505 la relectura por llave puede correr y el choque es duplicado.
  const r = await asentarEnBolsa(tx, bolsa, { ...datos, savepoint: true }, { userId: ctx.userId, nombre: ctx.nombre.slice(0, 150) });
  return { movimiento: aMovimientoDto(r.movimiento), duplicado: r.duplicado };
}

/** El libro único dice 'recarga'; el DTO de movimientos de tránsito sigue diciendo 'carga'. */
function aMovimientoDto(m: MovimientoBolsaDto): MovimientoTransitoDto {
  return {
    id: m.id,
    bolsaId: m.bolsaId,
    organismoCodigo: m.organismoCodigo,
    concepto: m.concepto as ConceptoBolsaTransito | null,
    tipo: m.tipo as TipoMovimientoTransito,
    origen: (m.origen === 'recarga' ? 'carga' : m.origen) as OrigenMovimientoTransito,
    tramiteId: m.tramiteId,
    idFlit: m.idFlit,
    valor: m.valor,
    saldoResultante: m.saldoResultante,
    periodo: m.periodo,
    fecha: m.fecha,
    observacion: m.observacion,
    soporteId: m.soporteId,
    registradoPorNombre: m.registradoPorNombre,
    createdAt: m.createdAt,
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
 * RN-T1 (Q7): sobre una bolsa inactiva → 409 `bolsa_inactiva` (primero hay que reactivarla).
 */
export async function registrarCargaTransito(
  bolsaId: string,
  datos: DatosCargaTransito,
  ctx: CtxUsuario,
): Promise<{ movimiento: MovimientoTransitoDto; saldo: number }> {
  const asiento: DatosMovimiento = {
    tipo: 'entrada',
    origen: 'recarga',
    valor: datos.valor,
    fecha: datos.fecha ?? hoyIso(),
    observacion: datos.observacion ?? null,
    soporte: datos.soporte ?? null,
    tipoSoporte: TIPO_SOPORTE_CARGA,
    etiqueta: 'carga',
  };
  validarMovimiento(asiento);
  return db.transaction(async (tx) => {
    const bolsa = await bolsaTransitoBloqueada(tx, bolsaId);
    if (!bolsa.activa) throw new BolsaError(MSG_BOLSA_INACTIVA, 409, CodigoErrorBolsa.BOLSA_INACTIVA);
    const { movimiento } = await asentar(tx, bolsa, asiento, ctx);
    return { movimiento, saldo: movimiento.saldoResultante };
  });
}

// ─────────────────────────── Consumo (AC3, AC4, AC8) ─────────────────────────

export interface DatosConsumoTransito {
  organismoCodigo: string;
  concepto: ConceptoBolsaTransito;
  /**
   * Trámite cuyo pago originó el consumo.
   *
   * **Nullable**, y la columna lo era desde la 0120: lo que estaba de más era este tipo. Un consumo
   * de CONCILIACIÓN (Feature #11623) no cuelga de ningún trámite —un SOAT tiene N trámites y no hay
   * uno «correcto» que poner, ADR-0006 §4.1—, y elegir uno haría que el reverso *de ese* trámite
   * pareciera pertinente cuando no lo es.
   */
  tramiteId: string | null;
  /** Valor SIN GMF: el gravamen ya viene incluido en el comprobante del organismo (AC4). */
  valor: number;
  fecha: string;
  /** Llave sin prefijo de familia; la pone quien conoce la naturaleza del consumo. */
  llave: string;
  /**
   * Quién produce el consumo. Por defecto `automatico`, que es el sellado de la liquidación.
   *
   * La conciliación asienta con `conciliacion`, y eso NO es una etiqueta: es lo que deja el
   * movimiento fuera del barrido de `reversarConsumoTransito` —que filtra por `origen='automatico'`—
   * y hace que un cambio de estado del trámite no devuelva un dinero que sí se pagó (CF-07).
   */
  origen?: 'automatico' | 'conciliacion';
}

/**
 * Asienta el consumo de un concepto en la bolsa ACTIVA que lo cubra, dentro de la transacción del
 * sellado o de la conciliación.
 *
 * No hace nada si ninguna bolsa activa cubre ese par: sellar un trámite de una secretaría que nadie
 * metió en una bolsa —o cuya bolsa se inactivó (Q7)— tiene que seguir funcionando igual (AC1). Nunca
 * crea una bolsa (D6).
 *
 * Devuelve `null` por DOS motivos distintos que colapsan en el mismo valor —ninguna bolsa cubre, o
 * la llave ya estaba ocupada—. Quien necesite distinguirlos (la conciliación lo necesita, para saber
 * si hay un movimiento previo que adoptar) tiene que releer por la llave, que es única.
 */
export async function registrarConsumoTransito(
  tx: Tx,
  datos: DatosConsumoTransito,
  ctx: CtxUsuario,
): Promise<MovimientoTransitoDto | null> {
  const llaveIdempotencia = `${PREFIJO_CONSUMO}${datos.llave}`;
  const previo = await movimientoPorLlave(tx, llaveIdempotencia);
  if (previo) return null;

  const bolsa = await bolsaQueCubre(tx, datos.organismoCodigo, datos.concepto);
  if (!bolsa) return null;

  const { movimiento, duplicado } = await asentar(tx, bolsa, {
    tipo: 'salida',
    origen: datos.origen ?? 'automatico',
    valor: datos.valor,
    fecha: datos.fecha,
    organismoCodigo: datos.organismoCodigo,
    concepto: datos.concepto,
    tramiteId: datos.tramiteId,
    llaveIdempotencia,
    etiqueta: 'salida',
  }, ctx);
  return duplicado ? null : movimiento;
}

/**
 * Devuelve a las bolsas lo que consumió este trámite (AC9).
 *
 * Igual que en la bolsa del cliente: el libro es append-only, así que devolver es asentar una
 * entrada nueva, y solo alcanza a los consumos VIVOS —los que conservan su llave sin prefijar—, de
 * modo que reversar dos veces no acredita dos veces. Se devuelve aunque la bolsa esté inactiva: es
 * la reversión de su propio movimiento (Q7).
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
    .from(M)
    .where(and(
      eq(M.tramiteId, tramiteId),
      eq(M.origen, 'automatico'),
      eq(M.tipo, 'salida'),
      like(M.llaveIdempotencia, `${PREFIJO_CONSUMO}%`),
    ));

  const contras: MovimientoTransitoDto[] = [];
  for (const c of consumos) {
    const bolsa = await bolsaBloqueadaPorId(tx, c.bolsaId);
    if (!bolsa) continue; // imposible por la FK; se deja por tipado
    const { movimiento } = await asentar(tx, bolsa, {
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
      .update(M)
      .set({ llaveIdempotencia: llaveReversada(c.id, c.llaveIdempotencia) })
      .where(eq(M.id, c.id));
  }
  return contras;
}
