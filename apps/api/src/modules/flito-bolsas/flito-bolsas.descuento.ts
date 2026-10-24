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
// Fuera de alcance: tránsito (HU-H), D14 (HU-D; el gancho `exigirDescuentoReversible` lo deja la HU-R #13903),
// backfill (HU-E).

import { and, eq, like } from 'drizzle-orm';
import {
  AlcanceBolsa, ConceptoCosto, EstadoComprobante, type ConceptoBolsa, type DescuentoBolsaDto, type MovimientoBolsaDto,
} from '@operaciones/shared-types';
import { env } from '../../config/env.js';
import { clients, flitoBolsasUnicasMovimientos, flitoComprobantes, flitoExcepcionesAutogestion, flitoImpuestos, flitoSoat, flitoTramites } from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';
import { TZ_COLOMBIA } from '../../shared/utils/fecha-rango.js';
import { excepcionLogisticaViva, gestionaLogistica } from '../flito-liquidacion/gestiona-logistica.js';
import {
  asentarEnBolsa, bolsaBloqueadaPorId, type CtxUsuario, hoyIso, movimientoPorLlave, num, PREFIJO_REVERSADO, PREFIJO_SALIDA, type Tx,
} from './flito-bolsas.libro.js';
import { bolsaCompaniaPara } from './flito-bolsas.resolver.js';

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

function conMovimiento(m: MovimientoBolsaDto): DescuentoBolsaDto {
  const r = vacio();
  r.movimientos.push({ bolsaId: m.bolsaId, alcance: COMPANIA, movimientoId: m.id, valor: m.valor, saldoResultante: m.saldoResultante });
  if (m.saldoResultante < 0) r.alertas.push({ bolsaId: m.bolsaId, alcance: COMPANIA, saldoResultante: m.saldoResultante });
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

/** RN-C7: ¿la liquidación (anterior al corte) ya cobró este trámite × concepto en esta bolsa? */
async function cubiertoPorLiquidacion(tx: Tx, bolsaId: string, tramiteId: string, concepto: string): Promise<boolean> {
  const [fila] = await tx.select({ id: flitoBolsasUnicasMovimientos.id }).from(flitoBolsasUnicasMovimientos).where(and(
    eq(flitoBolsasUnicasMovimientos.bolsaId, bolsaId),
    eq(flitoBolsasUnicasMovimientos.tramiteId, tramiteId),
    eq(flitoBolsasUnicasMovimientos.concepto, concepto),
    eq(flitoBolsasUnicasMovimientos.origen, 'automatico'),
    eq(flitoBolsasUnicasMovimientos.tipo, 'salida'),
    like(flitoBolsasUnicasMovimientos.llaveIdempotencia, `${PREFIJO_SALIDA}%`),
  )).limit(1);
  return fila !== undefined;
}

/** Llave ya ocupada: de quién es. `null` = de este mismo comprobante (idempotencia). */
function motivoLlaveOcupada(previo: MovimientoBolsaDto, comprobanteId: string): Motivo | null {
  if (previo.origen === 'automatico') return 'cubierto_por_liquidacion';
  if (previo.origen === 'comprobante' && previo.comprobanteId === comprobanteId) return null;
  return 'cubierto_por_conciliacion';
}

/**
 * Dentro de la tx de aplicar. Nunca lanza por saldo ni por negocio; sí por error de BD. Idempotente por
 * llave. `null` = corte apagado (RN-C2): no hay nada que contar en la respuesta.
 */
export async function descontarComprobante(tx: Tx, c: ComprobanteAplicado, ctx: CtxUsuario): Promise<DescuentoBolsaDto | null> {
  const corte = corteVigente();
  if (corte === null) return null;
  if (!c.esPago) return omitido('no_es_pago');
  if (diaColombia(c.aplicadoEn) < corte) return omitido('antes_del_corte');
  const valor = num(c.valor);
  if (!(valor > 0)) return vacio(); // pago sin valor documental: no hay importe que descontar

  const f = await contextoTramite(tx, c.tramiteId);
  if (!f || f.companiaId === null) return omitido('sin_compania');
  if (!gestionaConcepto(c.concepto, f)) return omitido('autogestionado');

  const llave = llaveDescuento(c.concepto, c.comprobanteId, f.soatId);
  const ocupada = await movimientoPorLlave(tx, llave);
  if (ocupada) {
    const motivo = motivoLlaveOcupada(ocupada, c.comprobanteId);
    return motivo ? omitido(motivo) : conMovimiento(ocupada);
  }

  const resuelta = await bolsaCompaniaPara(tx, f.companiaId, c.concepto);
  if (!resuelta.bolsa) return omitido(resuelta.motivo);
  const bolsa = resuelta.bolsa;
  if (await cubiertoPorLiquidacion(tx, bolsa.id, c.tramiteId, c.concepto)) return omitido('cubierto_por_liquidacion');

  const { movimiento, duplicado } = await asentarEnBolsa(tx, bolsa, {
    tipo: 'salida',
    origen: 'comprobante',
    valor,
    fecha: diaColombia(c.aplicadoEn),
    concepto: c.concepto as ConceptoBolsa,
    tramiteId: c.tramiteId,
    comprobanteId: c.comprobanteId,
    llaveIdempotencia: llave,
    observacion: 'Descuento al aplicar el comprobante de pago',
    etiqueta: 'salida',
  }, ctx);
  // Carrera: otro escritor ocupó la llave mientras esperábamos el lock (RN-A5 del libro).
  if (duplicado) {
    const motivo = motivoLlaveOcupada(movimiento, c.comprobanteId);
    return motivo ? omitido(motivo) : conMovimiento(movimiento);
  }
  log.info({ comprobanteId: c.comprobanteId, bolsaId: bolsa.id, movimientoId: movimiento.id, negativo: movimiento.saldoResultante < 0 },
    'Bolsa de la compañía descontada por comprobante');
  return conMovimiento(movimiento);
}

/**
 * D14 (HU #13903 deja el gancho; la HU-D lo implementa): el periodo de la bolsa en el que cayó el descuento
 * está cerrado, así que no se puede devolver. Quien desaplica lo traduce a 409 `periodo_cerrado`.
 */
export class PeriodoCerradoError extends Error {
  constructor(public bolsaId: string, public periodo: string) {
    super('El periodo de la bolsa ya está cerrado: el descuento no se puede devolver');
  }
}

/**
 * Guarda de desaplicar/reemplazar (HU #13903), ANTES de `revertirDescuentoComprobante` y dentro de la misma
 * tx. Hoy no-op: la regla del periodo cerrado (D14) la escribe la HU-D, que lanzará `PeriodoCerradoError`.
 */
export async function exigirDescuentoReversible(_tx: Tx, _comprobanteId: string): Promise<void> {
  // no-op hasta la HU-D
}

/**
 * Una entrada enlazada (`revierte_movimiento_id`) por cada salida VIVA del comprobante; libera la llave
 * del original con `rev:` (única columna que se reescribe; así reemplazar puede volver a descontar).
 * Se permite con la bolsa inactiva (RN-A2: devolver lo cobrado). Dos llamadas no acreditan dos veces:
 * la segunda ya no ve salidas vivas, y el índice único parcial de `revierte_movimiento_id` lo garantiza
 * en la base. `compensacion: true` (rechazo del dueño tras el commit) no pasa por D14; sin ella, la
 * guarda de periodo cerrado la añade la HU-D (`exigirDescuentoReversible`).
 */
export async function revertirDescuentoComprobante(
  tx: Tx, comprobanteId: string, ctx: CtxUsuario, o: { motivo: string; compensacion?: boolean },
): Promise<MovimientoBolsaDto[]> {
  const salidas = await tx.select().from(flitoBolsasUnicasMovimientos).where(and(
    eq(flitoBolsasUnicasMovimientos.comprobanteId, comprobanteId),
    eq(flitoBolsasUnicasMovimientos.origen, 'comprobante'),
    eq(flitoBolsasUnicasMovimientos.tipo, 'salida'),
    like(flitoBolsasUnicasMovimientos.llaveIdempotencia, `${PREFIJO_SALIDA}%`),
  ));
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
