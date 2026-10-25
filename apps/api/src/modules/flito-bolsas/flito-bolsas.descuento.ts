// FLITO — descuento de la bolsa de COMPAÑÍA al aplicar un comprobante de pago (HU #13902, Feature #13886,
// ADR-0029 D7-D12 y D15). Gancho de servidor, no HTTP: lo llama `aplicarEnTx` de
// `flito-comprobantes.aplicar.ts` DENTRO de la tx que deja el comprobante `aplicado`.
//
// Reglas (en este orden; cada omisión lleva su motivo y NINGUNA genera alerta, D10):
//   RN-C1 Solo `esPago`: la documentación no mueve dinero (`no_es_pago`). El GMF no es concepto de
//         comprobante y no se descuenta (Q6).
//   RN-C2 Corte (D12): `FLITO_BOLSAS_CORTE_COMPROBANTES`. Sin valor el gancho no hace nada (devuelve null).
//         Con valor descuenta si el DÍA EN COLOMBIA de `aplicadoEn` es ≥ corte (`antes_del_corte` si no).
//         El contenedor corre en UTC: el 30-nov 23:30 COT es 01-dic 04:30Z y NO alcanza un corte 01-dic.
//   RN-C3 Compañía del trámite (`sin_compania`).
//   RN-C4 Autogestión (D15, `autogestionado`): MISMA regla que la liquidación (`calcularConceptos` de
//         `flito-liquidacion.service.ts`) y el reporte de costos (`GESTIONA_*` de `finanzas.service.ts`):
//         FLITO gestiona el concepto si la compañía no lo autogestiona O el trámite tiene excepción vigente
//         —SOAT/impuesto: la marca `excepcion_autogestion` de su registro, que `flito-excepciones` pone y
//         quita junto con la fila de `flito_excepciones_autogestion`; logística: la fila viva, vía
//         `gestionaLogistica` + `excepcionLogisticaViva`—. Además, el SOAT del canal cliente
//         (`flito_soat.origen = 'cliente'`) siempre descuenta (AC11). Impuesto: SOLO el eje compañía; la
//         modalidad del organismo es asunto de la bolsa de tránsito (HU-G). Derecho, trámite digital y
//         servicios adicionales no tienen autogestión.
//   RN-C5 Llave (ADR-0006): SOAT → `salida:soat:<soatId>` (la MISMA de la conciliación y la liquidación:
//         el índice único impide el doble cobro en cualquier orden); resto → `salida:comprobante:<id>`.
//         Llave ocupada por la liquidación → `cubierto_por_liquidacion`; por la conciliación →
//         `cubierto_por_conciliacion`; por este comprobante → idempotente (no hay segundo movimiento).
//   RN-C6 Bolsa (`flito-bolsas.resolver.ts`): `sin_bolsa` / `inactiva` / `concepto_no_cubierto`.
//   RN-C7 Anti doble cobro con lo anterior al corte: salida VIVA (`salida:%`, no reversada) de origen
//         `automatico` en la bolsa, mismo trámite y concepto → `cubierto_por_liquidacion`.
//   RN-C8 Saldo insuficiente NO bloquea (D11): la salida deja la bolsa en negativo y vuelve en `alertas`.
//   RN-C9 Orden de locks: comprobante → trámite (los toma `aplicar`) → bolsa compañía (aquí).
//   RN-C10 Ley 1581: los logs llevan solo ids (comprobante, bolsa, movimiento); nunca placa, VIN ni NIT.
//
// Reversión al desaplicar/reemplazar (HU #13905, D13/D14): `exigirDescuentoReversible` + `revertirDescuentoComprobante`.
// HU #13909 (HU-H): el lado TRÁNSITO vive en `flito-bolsas.descuento-transito.ts`; se decide por separado
// tras el lado compañía (RN-C9: comprobante → trámite → bolsa compañía → bolsa tránsito). La reversión
// recorre las salidas vivas de AMBOS alcances (`salida:%` y `consumo:%`) en ese mismo orden: un periodo
// cerrado en cualquiera de las dos bloquea la operación entera (todo o nada).
// HU #13910 (HU-E, Q4): `{ backfill: true }` salta SOLO RN-C2 `antes_del_corte` (el corte sigue siendo
// obligatorio) y fecha el movimiento el día de ejecución (`hoyIso`); el periodo lo corre `periodoImputable`
// si cae en mes cerrado. Lo usa `src/scripts/flito-bolsas-backfill-comprobantes.ts`; el gancho normal no cambia.

import { and, asc, eq, getTableColumns, like, or } from 'drizzle-orm';
import {
  AlcanceBolsa, ConceptoCosto, EstadoComprobante, type ConceptoBolsa, type DescuentoBolsaDto, type MovimientoBolsaDto,
} from '@operaciones/shared-types';
import { env } from '../../config/env.js';
import { clients, flitoBolsasUnicas, flitoBolsasUnicasMovimientos, flitoComprobantes, flitoExcepcionesAutogestion, flitoImpuestos, flitoSoat, flitoTramites } from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';
import { TZ_COLOMBIA } from '../../shared/utils/fecha-rango.js';
import { excepcionLogisticaViva, gestionaLogistica } from '../flito-liquidacion/gestiona-logistica.js';
import {
  asentarEnBolsa, bolsaBloqueadaPorId, type CtxUsuario, hoyIso, movimientoPorLlave, num, periodosCerrados, PREFIJO_REVERSADO, PREFIJO_SALIDA, type Tx,
} from './flito-bolsas.libro.js';
import { descontarTransito, type ReglasCompartidas } from './flito-bolsas.descuento-transito.js';
import { bolsaCompaniaPara } from './flito-bolsas.resolver.js';
import { PREFIJO_CONSUMO } from './flito-bolsas-transito.service.js';

const log = loggerFor('flito-bolsas-descuento');

/** El comprobante tal como quedó tras `cerrarComoPago` (o `adjuntarDocumentacion`). */
export interface ComprobanteAplicado {
  comprobanteId: string;
  tramiteId: string;
  concepto: ConceptoCosto;
  esPago: boolean;
  /** `flito_comprobantes.valor` (D8). */
  valor: string | null;
  /** Decide el corte (D12). */
  aplicadoEn: Date;
}

/** Día calendario de Colombia (AAAA-MM-DD) de un instante. */
export function diaColombia(instante: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ_COLOMBIA, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(instante);
}

/** El corte configurado (AAAA-MM-DD) o null. Se lee en cada llamada: el env ya viene validado por Zod. */
export function corteVigente(): string | null {
  return env.FLITO_BOLSAS_CORTE_COMPROBANTES ?? null;
}

/** ¿El día contable `dia` (AAAA-MM-DD, ya en Colombia) cae desde el corte? false sin corte. */
export function cubiertoPorCorte(dia: string): boolean {
  const corte = corteVigente();
  return corte !== null && dia >= corte;
}

const COMPANIA = AlcanceBolsa.COMPANIA;
type Motivo = DescuentoBolsaDto['omitidos'][number]['motivo'];

function vacio(): DescuentoBolsaDto {
  return { movimientos: [], omitidos: [], alertas: [] };
}

function omitido(motivo: Motivo): DescuentoBolsaDto {
  return { movimientos: [], omitidos: [{ alcance: COMPANIA, motivo }], alertas: [] };
}

/** Motivo que aplica a los dos lados (no es pago, antes del corte): una omisión por alcance. */
function omitidoAmbos(motivo: Motivo): DescuentoBolsaDto {
  return { movimientos: [], omitidos: [{ alcance: COMPANIA, motivo }, { alcance: AlcanceBolsa.TRANSITO, motivo }], alertas: [] };
}

function unir(a: DescuentoBolsaDto, b: DescuentoBolsaDto): DescuentoBolsaDto {
  return { movimientos: [...a.movimientos, ...b.movimientos], omitidos: [...a.omitidos, ...b.omitidos], alertas: [...a.alertas, ...b.alertas] };
}

/**
 * HU #13904: nombre visible de la bolsa — el suyo (tránsito) o, si es NULL (compañía), el del cliente.
 * Viaja en la alerta de saldo y en el 409 `periodo_cerrado`; NUNCA a logs (RN-C10: los logs llevan solo ids).
 */
export async function nombreVisibleBolsa(tx: Tx, bolsaId: string): Promise<string> {
  const [f] = await tx.select({ nombre: flitoBolsasUnicas.nombre, cliente: clients.name }).from(flitoBolsasUnicas)
    .leftJoin(clients, eq(flitoBolsasUnicas.companiaId, clients.id))
    .where(eq(flitoBolsasUnicas.id, bolsaId)).limit(1);
  return f?.nombre ?? f?.cliente ?? '';
}

async function conMovimiento(tx: Tx, m: MovimientoBolsaDto): Promise<DescuentoBolsaDto> {
  const r = vacio();
  r.movimientos.push({ bolsaId: m.bolsaId, alcance: COMPANIA, movimientoId: m.id, valor: m.valor, saldoResultante: m.saldoResultante });
  if (m.saldoResultante < 0) {
    r.alertas.push({ bolsaId: m.bolsaId, bolsaNombre: await nombreVisibleBolsa(tx, m.bolsaId), alcance: COMPANIA, saldoResultante: m.saldoResultante });
  }
  return r;
}

/** Lo que decide compañía, autogestión y llave del SOAT, en una sola lectura. */
async function contextoTramite(tx: Tx, tramiteId: string) {
  const [f] = await tx.select({
    companiaId: flitoTramites.companiaId,
    soatId: flitoTramites.soatId,
    soatAutogestionable: clients.soatAutogestionable,
    impuestosAutogestionable: clients.impuestosAutogestionable,
    logisticaAutogestionable: clients.logisticaAutogestionable,
    soatExcepcion: flitoSoat.excepcionAutogestion,
    soatOrigen: flitoSoat.origen,
    impuestoExcepcion: flitoImpuestos.excepcionAutogestion,
    logisticaExcepcion: flitoExcepcionesAutogestion.id,
  }).from(flitoTramites)
    .leftJoin(clients, eq(flitoTramites.companiaId, clients.id))
    .leftJoin(flitoSoat, eq(flitoTramites.soatId, flitoSoat.id))
    .leftJoin(flitoImpuestos, eq(flitoImpuestos.tramiteId, flitoTramites.id))
    // Mismo LEFT JOIN que la liquidación: a lo sumo una excepción viva por concepto (índice parcial).
    .leftJoin(flitoExcepcionesAutogestion, excepcionLogisticaViva())
    .where(eq(flitoTramites.id, tramiteId)).limit(1);
  return f;
}
type ContextoTramite = NonNullable<Awaited<ReturnType<typeof contextoTramite>>>;

/** RN-C4: ¿FLITO gestiona (y por tanto cobra de la bolsa) este concepto en este trámite? */
export function gestionaConcepto(concepto: string, f: Omit<ContextoTramite, 'companiaId' | 'soatId'>): boolean {
  if (concepto === ConceptoCosto.SOAT) {
    return f.soatOrigen === 'cliente' || !f.soatAutogestionable || Boolean(f.soatExcepcion);
  }
  if (concepto === ConceptoCosto.IMPUESTO) return !f.impuestosAutogestionable || Boolean(f.impuestoExcepcion);
  if (concepto === ConceptoCosto.LOGISTICA) return gestionaLogistica(f.logisticaAutogestionable, f.logisticaExcepcion !== null);
  return true;
}

/** RN-C5: la llave de la salida. */
export function llaveDescuento(concepto: string, comprobanteId: string, soatId: string | null): string {
  return concepto === ConceptoCosto.SOAT && soatId
    ? `${PREFIJO_SALIDA}soat:${soatId}`
    : `${PREFIJO_SALIDA}comprobante:${comprobanteId}`;
}

/**
 * RN-C7: ¿la liquidación (anterior al corte) ya cobró este trámite × concepto en esta bolsa? `prefijo`:
 * `salida:` en la de compañía, `consumo:` en la de tránsito (HU #13909).
 */
async function cubiertoPorLiquidacion(tx: Tx, bolsaId: string, tramiteId: string, concepto: string, prefijo = PREFIJO_SALIDA): Promise<boolean> {
  const [fila] = await tx.select({ id: flitoBolsasUnicasMovimientos.id }).from(flitoBolsasUnicasMovimientos).where(and(
    eq(flitoBolsasUnicasMovimientos.bolsaId, bolsaId),
    eq(flitoBolsasUnicasMovimientos.tramiteId, tramiteId),
    eq(flitoBolsasUnicasMovimientos.concepto, concepto),
    eq(flitoBolsasUnicasMovimientos.origen, 'automatico'),
    eq(flitoBolsasUnicasMovimientos.tipo, 'salida'),
    like(flitoBolsasUnicasMovimientos.llaveIdempotencia, `${prefijo}%`),
  )).limit(1);
  return fila !== undefined;
}

/** Llave ya ocupada: de quién es. `null` = de este mismo comprobante (idempotencia). */
function motivoLlaveOcupada(previo: MovimientoBolsaDto, comprobanteId: string): Motivo | null {
  if (previo.origen === 'automatico') return 'cubierto_por_liquidacion';
  if (previo.origen === 'comprobante' && previo.comprobanteId === comprobanteId) return null;
  return 'cubierto_por_conciliacion';
}

const REGLAS: ReglasCompartidas = { motivoLlaveOcupada, cubiertoPorLiquidacion };

/** HU #13910: opciones del backfill del corte. Sin ellas, el gancho normal (RN-C2 intacta). */
export interface OpcionesDescuento {
  /** Salta solo `antes_del_corte`; el movimiento se fecha HOY (día de ejecución, Colombia). */
  backfill?: boolean;
  /** Observación de los movimientos (ambos alcances); por defecto la del gancho. */
  observacion?: string;
}

/**
 * Dentro de la tx de aplicar. Nunca lanza por saldo ni por negocio; sí por error de BD. Idempotente por
 * llave. `null` = corte apagado (RN-C2): no hay nada que contar en la respuesta.
 */
export async function descontarComprobante(
  tx: Tx, c: ComprobanteAplicado, ctx: CtxUsuario, o: OpcionesDescuento = {},
): Promise<DescuentoBolsaDto | null> {
  const corte = corteVigente();
  if (corte === null) return null;
  if (!c.esPago) return omitidoAmbos('no_es_pago');
  if (o.backfill !== true && diaColombia(c.aplicadoEn) < corte) return omitidoAmbos('antes_del_corte');
  const fecha = o.backfill === true ? hoyIso() : diaColombia(c.aplicadoEn);
  const valor = num(c.valor);
  if (!(valor > 0)) return vacio(); // pago sin valor documental: no hay importe que descontar

  // RN-C9: el lado compañía primero (bloquea su bolsa), después el de tránsito. Cada uno decide por su cuenta.
  const compania = await descontarCompania(tx, c, valor, fecha, ctx, o.observacion);
  const transito = await descontarTransito(tx, {
    comprobanteId: c.comprobanteId, tramiteId: c.tramiteId, concepto: c.concepto, valor, fecha, observacion: o.observacion,
  }, ctx, REGLAS);
  return unir(compania, transito);
}

/** El lado compañía (RN-C3..RN-C8). */
async function descontarCompania(
  tx: Tx, c: ComprobanteAplicado, valor: number, fecha: string, ctx: CtxUsuario, observacion?: string,
): Promise<DescuentoBolsaDto> {
  const f = await contextoTramite(tx, c.tramiteId);
  if (!f || f.companiaId === null) return omitido('sin_compania');
  if (!gestionaConcepto(c.concepto, f)) return omitido('autogestionado');

  const llave = llaveDescuento(c.concepto, c.comprobanteId, f.soatId);
  const ocupada = await movimientoPorLlave(tx, llave);
  if (ocupada) {
    const motivo = motivoLlaveOcupada(ocupada, c.comprobanteId);
    return motivo ? omitido(motivo) : await conMovimiento(tx, ocupada);
  }

  const resuelta = await bolsaCompaniaPara(tx, f.companiaId, c.concepto);
  if (!resuelta.bolsa) return omitido(resuelta.motivo);
  const bolsa = resuelta.bolsa;
  if (await cubiertoPorLiquidacion(tx, bolsa.id, c.tramiteId, c.concepto)) return omitido('cubierto_por_liquidacion');

  const { movimiento, duplicado } = await asentarEnBolsa(tx, bolsa, {
    tipo: 'salida',
    origen: 'comprobante',
    valor,
    fecha,
    concepto: c.concepto as ConceptoBolsa,
    tramiteId: c.tramiteId,
    comprobanteId: c.comprobanteId,
    llaveIdempotencia: llave,
    observacion: observacion ?? 'Descuento al aplicar el comprobante de pago',
    etiqueta: 'salida',
  }, ctx);
  // Carrera: otro escritor ocupó la llave mientras esperábamos el lock (RN-A5 del libro).
  if (duplicado) {
    const motivo = motivoLlaveOcupada(movimiento, c.comprobanteId);
    return motivo ? omitido(motivo) : await conMovimiento(tx, movimiento);
  }
  log.info({ comprobanteId: c.comprobanteId, bolsaId: bolsa.id, movimientoId: movimiento.id, negativo: movimiento.saldoResultante < 0 },
    'Bolsa de la compañía descontada por comprobante');
  return await conMovimiento(tx, movimiento);
}

/**
 * D14 (HU #13905): el periodo de la bolsa al que se IMPUTÓ el descuento está cerrado, así que no se puede
 * devolver. Quien desaplica/reemplaza lo traduce a 409 `periodo_cerrado` con `{ bolsaId, bolsaNombre, periodo }`
 * (`bolsaNombre`, HU #13904: el nombre visible, para que el aviso nombre la bolsa).
 */
export class PeriodoCerradoError extends Error {
  constructor(public bolsaId: string, public periodo: string, public bolsaNombre: string) {
    super('El periodo de la bolsa ya está cerrado: el descuento no se puede devolver');
  }
}

/**
 * Salidas VIVAS (`salida:%` en compañía, `consumo:%` en tránsito —HU #13909—; no reversadas) que este
 * comprobante dejó en cualquier bolsa. Orden fijo (`alcance` —'compania' < 'transito'—, `bolsa_id`, `id`):
 * mismo orden de locks que aplicar (RN-C9), sin cruce entre dos reversiones concurrentes, y el error de
 * D14 nombra siempre la misma bolsa.
 */
async function salidasVivasDe(tx: Tx, comprobanteId: string) {
  const M = flitoBolsasUnicasMovimientos;
  return tx.select(getTableColumns(M)).from(M)
    .innerJoin(flitoBolsasUnicas, eq(M.bolsaId, flitoBolsasUnicas.id))
    .where(and(
      eq(M.comprobanteId, comprobanteId),
      eq(M.origen, 'comprobante'),
      eq(M.tipo, 'salida'),
      or(like(M.llaveIdempotencia, `${PREFIJO_SALIDA}%`), like(M.llaveIdempotencia, `${PREFIJO_CONSUMO}%`)),
    )).orderBy(asc(flitoBolsasUnicas.alcance), asc(M.bolsaId), asc(M.id));
}
type SalidaViva = Awaited<ReturnType<typeof salidasVivasDe>>[number];

/**
 * D14 sobre el periodo IMPUTADO (`periodo`, no el de `fecha`): si la salida se corrió a un periodo posterior
 * porque el natural ya estaba cerrado, lo que cuenta es dónde quedó contada. Bloquea la bolsa antes de leer
 * sus cierres para que un cierre concurrente no se cuele entre la guarda y la entrada. Q7: no mira `activa`.
 */
async function exigirPeriodoAbierto(tx: Tx, s: SalidaViva): Promise<void> {
  await bolsaBloqueadaPorId(tx, s.bolsaId);
  if ((await periodosCerrados(tx, s.bolsaId)).has(s.periodo)) {
    throw new PeriodoCerradoError(s.bolsaId, s.periodo, await nombreVisibleBolsa(tx, s.bolsaId));
  }
}

/**
 * Guarda de desaplicar/reemplazar (D14), ANTES de `revertirDescuentoComprobante` y dentro de la misma tx:
 * si CUALQUIER salida viva del comprobante cayó en un periodo cerrado de su bolsa, lanza
 * `PeriodoCerradoError` y nada se escribe (todo o nada). Sin salidas vivas (no descontó: antes del corte,
 * sin bolsa, ya revertido) no hay nada que proteger.
 */
export async function exigirDescuentoReversible(tx: Tx, comprobanteId: string): Promise<void> {
  for (const s of await salidasVivasDe(tx, comprobanteId)) await exigirPeriodoAbierto(tx, s);
}

/**
 * Una entrada enlazada (`revierte_movimiento_id`) por cada salida VIVA del comprobante; libera la llave
 * del original con `rev:` (única columna que se reescribe; así reemplazar puede volver a descontar, y el
 * SOAT recupera `salida:soat:<soatId>`). Se permite con la bolsa inactiva (RN-A2 / Q7: devolver lo cobrado).
 * Dos llamadas no acreditan dos veces: la segunda ya no ve salidas vivas, y el índice único parcial de
 * `revierte_movimiento_id` lo garantiza en la base. La entrada se imputa al primer periodo abierto
 * (`asentarEnBolsa` → `periodoImputable`). D14: sin `compensacion` se re-exige el periodo abierto de cada
 * salida (defensa si un llamador olvida `exigirDescuentoReversible`); `compensacion: true` (rechazo del
 * dueño tras el commit: el dinero nunca debió salir) la omite.
 */
export async function revertirDescuentoComprobante(
  tx: Tx, comprobanteId: string, ctx: CtxUsuario, o: { motivo: string; compensacion?: boolean },
): Promise<MovimientoBolsaDto[]> {
  const salidas = await salidasVivasDe(tx, comprobanteId);
  if (o.compensacion !== true) for (const s of salidas) await exigirPeriodoAbierto(tx, s);
  const entradas: MovimientoBolsaDto[] = [];
  for (const s of salidas) {
    const bolsa = await bolsaBloqueadaPorId(tx, s.bolsaId);
    if (!bolsa) continue; // imposible por la FK; se deja por tipado
    const { movimiento } = await asentarEnBolsa(tx, bolsa, {
      tipo: 'entrada',
      origen: 'comprobante',
      valor: num(s.valor),
      fecha: hoyIso(),
      concepto: s.concepto === null ? null : (s.concepto as ConceptoBolsa),
      organismoCodigo: s.organismoCodigo,
      tramiteId: s.tramiteId,
      comprobanteId,
      revierteMovimientoId: s.id,
      observacion: o.motivo.slice(0, 500),
      llaveIdempotencia: `contra:${s.id}`,
      etiqueta: 'devolución',
    }, ctx);
    entradas.push(movimiento);
    await tx.update(flitoBolsasUnicasMovimientos)
      .set({ llaveIdempotencia: `${PREFIJO_REVERSADO}${s.llaveIdempotencia}`.slice(0, 200) })
      .where(eq(flitoBolsasUnicasMovimientos.id, s.id));
    log.info({ comprobanteId, bolsaId: s.bolsaId, movimientoId: movimiento.id, revierte: s.id, compensacion: o.compensacion === true },
      'Descuento del comprobante revertido');
  }
  return entradas;
}

/**
 * AC10: tras reversar DESPUÉS del corte una liquidación que sí movió la bolsa (anterior al corte), se
 * descuenta en la misma tx cada comprobante de pago aplicado del trámite: si no, el dinero se devuelve y
 * nunca se vuelve a cobrar. `aplicadoEn` = ahora (el reverso es lo que lo hace cobrable). Solo con
 * `huboDevolucion`: si la liquidación no movió la bolsa (ya era posterior al corte), los comprobantes ya
 * se descontaron o se omitieron por su motivo, y uno anterior al corte es trabajo del backfill (HU-E).
 */
export async function redescontarTrasReverso(tx: Tx, tramiteId: string, huboDevolucion: boolean, ctx: CtxUsuario): Promise<DescuentoBolsaDto[]> {
  const ahora = new Date();
  if (!huboDevolucion || !cubiertoPorCorte(diaColombia(ahora))) return [];
  const aplicados = await tx.select({
    id: flitoComprobantes.id, concepto: flitoComprobantes.concepto, valor: flitoComprobantes.valor,
  }).from(flitoComprobantes).where(and(
    eq(flitoComprobantes.tramiteId, tramiteId),
    eq(flitoComprobantes.estado, EstadoComprobante.APLICADO),
    eq(flitoComprobantes.esPago, true),
  ));
  const resultados: DescuentoBolsaDto[] = [];
  for (const a of aplicados) {
    if (!a.concepto) continue;
    const r = await descontarComprobante(tx, {
      comprobanteId: a.id, tramiteId, concepto: a.concepto as ConceptoCosto, esPago: true, valor: a.valor, aplicadoEn: ahora,
    }, ctx);
    if (r) resultados.push(r);
  }
  return resultados;
}
