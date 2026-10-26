// Comprobantes universales — HU #13903 (Feature #13886): DESAPLICAR y REEMPLAZAR un comprobante aplicado.
//
// Una sola tx, con el orden de bloqueo de `aplicar` (comprobante → trámite → filas del dueño → bolsa):
//   1. `FOR UPDATE` del comprobante y relectura: sigue `aplicado` o 409 `no_aplicado` (AC4, AC8: de dos
//      desaplicaciones concurrentes la segunda espera el bloqueo, ve el estado nuevo y pierde; la reversa
//      del dueño corre UNA vez).
//   2. `FOR UPDATE` del trámite (`bloquearTramite`, el mismo que toma la liquidación).
//   3. Guardas de negocio, sin escribir nada todavía:
//        · derecho pagado → 409 `dueno_no_reversible` «Corrige el pago en su módulo» (AC3): el derecho no
//          tiene reversa propia que reutilizar, así que nada cambia;
//        · honorario pagado con el trámite liquidado → 409 `tramite_liquidado` (AC5).
//   4. Bolsa: `exigirDescuentoReversible` (409 `periodo_cerrado` con `bolsaId` y `periodo`, AC9; D14 sobre el
//      periodo imputado, HU #13905) → `revertirDescuentoComprobante` (entrada enlazada; libera la llave para el reemplazo).
//   5. El DUEÑO en la misma tx (nota de QA A: si algo posterior falla, la reversa se deshace con todo):
//      SOAT e impuesto reutilizan la escritura de su `reversar` (`reversarEnTx`, RN-06: historial con el
//      motivo literal; el impuesto además su audit). Destino del dueño: `pendiente` al desaplicar (AC1, AC2);
//      `solicitado` al reemplazar, porque el camino normal de aplicar (la guarda de `duenos.ts`) solo
//      acepta pagar un SOAT/impuesto en adquisición/gestión. El SOAT/impuesto tiene que estar `pagado`; si
//      no, o si la reversa lanza, 409 `dueno_no_reversible` con su mensaje y rollback (AC6).
//   6. La fila: `pendiente` sin trámite y sin rastro de la aplicación (vuelve a la cola, AC1) o
//      `descartado` con `descartado_por_id/en/motivo` (los del descarte de siempre, AC2, AC7). El rastro
//      quién/cuándo/motivo de la desaplicación lo deja la RUTA en `audit_logs` (`audit`, como el resto del
//      módulo, que solo escribe comprobantes y soportes): no hay columnas propias de desaplicación.
//   AC11 (0251): un pago de servicios adicionales devuelve la puente a su estado previo (`sa_asignacion_previa` /
//   `sa_valor_previo`, que guarda `aplicar`): sin fila previa se borra, con fila vuelve a su valor; aplicado antes
//   de la 0251 (NULL) → 409 `servicio_no_reversible`, nada cambia.
//   Reemplazar (AC7): tras el paso 6 (original descartado), `enTx` del reemplazo (`prepararAplicacion` con
//   `sinGuardaPrevia`) al MISMO trámite y concepto; si falla, rollback total: el original sigue aplicado.
//   Límite conocido: el pago de SOAT del reemplazo se escribe TRAS el commit (D1 de `duenos.ts`); si el
//   dueño lo rechaza entonces, el reemplazo vuelve a pendiente (compensación de `aplicar`) y el original
//   queda descartado con el SOAT en adquisición.
//
// Ningún log lleva contenido leído (Habeas Data): ids y conceptos.

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  CodigoErrorComprobante, ConceptoCosto, DESTINOS_DESAPLICACION, EstadoComprobante, EstadoImpuesto, EstadoSoat, MotivoPendienteComprobante,
  type ComprobanteDetalleDto, type DestinoDesaplicacion,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoComprobantes, flitoImpuestos, flitoSoat, flitoTramites } from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';
import {
  bloquearTramite, restaurarDesdeComprobante, TramiteNoEncontradoError, type Tx,
} from '../finanzas-servicios-adicionales/finanzas-servicios-adicionales.service.js';
import { exigirDescuentoReversible, PeriodoCerradoError, revertirDescuentoComprobante } from '../flito-bolsas/flito-bolsas.descuento.js';
import { esLlaveDuplicada } from '../flito-bolsas/flito-bolsas.libro.js';
import { reversarEnTx as reversarSoatEnTx, SoatError } from '../flito-soat/flito-soat.service.js';
import { ImpuestoError, reversarEnTx as reversarImpuestoEnTx } from '../flito-impuestos/flito-impuestos.service.js';
import type { AlcanceResuelto } from '../../shared/middleware/frontera-enlace.js';
import { ComprobanteError, condicionAlcanceComprobantes, detalle, type ComprobanteCtx } from './flito-comprobantes.service.js';
import { liberarSoporteSiNadieLoUsa, prepararAplicacion } from './flito-comprobantes.aplicar.js';
import { esHonorario } from './flito-comprobantes.expr.js';
import { exigirNoLiquidado } from './flito-comprobantes.honorarios.js';

const log = loggerFor('flito-comprobantes-desaplicar');

// ─────────────────────────── Esquemas (API común a zod 3 y 4) ────────────────

const motivo = z.string().trim().min(5).max(500);

export const desaplicarSchema = z.object({
  destino: z.enum(DESTINOS_DESAPLICACION as unknown as [DestinoDesaplicacion, ...DestinoDesaplicacion[]]),
  motivo,
});

export const reemplazarSchema = z.object({
  reemplazoId: z.string().guid(),
  motivo,
  campos: z.record(z.string(), z.string().max(200)).optional(),
});

// ─────────────────────────── Errores ─────────────────────────────────────────

const noEncontrado = (que = 'El comprobante no existe') => new ComprobanteError(404, CodigoErrorComprobante.NO_ENCONTRADO, que);
const noAplicado = () => new ComprobanteError(409, CodigoErrorComprobante.NO_APLICADO, 'El comprobante no está aplicado');
const datosInvalidos = (msg: string) => new ComprobanteError(400, CodigoErrorComprobante.DATOS_INVALIDOS, msg);
const duenoNoReversible = (detalle: string) =>
  new ComprobanteError(409, CodigoErrorComprobante.DUENO_NO_REVERSIBLE, 'El pago no se puede deshacer desde Comprobantes', { detalle });
const servicioNoReversible = () => new ComprobanteError(409, CodigoErrorComprobante.SERVICIO_NO_REVERSIBLE,
  'El valor del servicio no se puede deshacer desde Comprobantes', { detalle: 'Corrige el valor en Servicios adicionales' });
/** Índice único parcial de la llave del libro de bolsas únicas (0249). */
const UQ_LLAVE_BOLSA = 'uq_flito_bolsas_unicas_mov_llave';
/**
 * AC6 (HU #13969): un 23505 de la llave de la bolsa dentro de la tx de desaplicar/reemplazar es un conflicto
 * (409 legible), no un 500. La tx ya hizo rollback: nada cambió. Otro error se devuelve tal cual.
 */
export function traducirChoqueLlaveBolsa(e: unknown): unknown {
  if (!esLlaveDuplicada(e)) return e;
  // postgres-js la expone como `constraint_name` (node-postgres: `constraint`); drizzle la envuelve en `cause`.
  const restriccion = (x: unknown) => {
    if (typeof x !== 'object' || x === null) return undefined;
    const pg = x as { constraint_name?: string; constraint?: string };
    return pg.constraint_name ?? pg.constraint;
  };
  const r = restriccion(e) ?? restriccion((e as { cause?: unknown }).cause);
  if (r !== UQ_LLAVE_BOLSA) return e;
  return new ComprobanteError(409, CodigoErrorComprobante.DESCUENTO_EN_CONFLICTO,
    'La bolsa no pudo registrar la devolución de este comprobante; nada cambió. Vuelve a intentarlo');
}
const yaResuelto = () => new ComprobanteError(409, CodigoErrorComprobante.YA_RESUELTO, 'El comprobante de reemplazo ya no está pendiente');

// ─────────────────────────── Núcleo en tx ────────────────────────────────────

const COLUMNAS = {
  id: flitoComprobantes.id, estado: flitoComprobantes.estado, tramiteId: flitoComprobantes.tramiteId,
  concepto: flitoComprobantes.concepto, esPago: flitoComprobantes.esPago, soporteId: flitoComprobantes.soporteId,
  servicioTipoId: flitoComprobantes.servicioTipoId,
  saAsignacionPrevia: flitoComprobantes.saAsignacionPrevia, saValorPrevio: flitoComprobantes.saValorPrevio,
} as const;

type FilaAplicada = {
  id: string; estado: string; tramiteId: string | null; concepto: string | null; esPago: boolean | null; soporteId: string;
  servicioTipoId: string | null; saAsignacionPrevia: boolean | null; saValorPrevio: string | null;
};

/** Fuera de la tx: 404 / 409 `no_aplicado` / 409 derecho, antes de subir nada a S3 (reemplazo). */
async function leerAplicado(id: string): Promise<FilaAplicada> {
  const [c] = await db.select(COLUMNAS).from(flitoComprobantes).where(eq(flitoComprobantes.id, id)).limit(1);
  if (!c) throw noEncontrado();
  if (c.estado !== EstadoComprobante.APLICADO) throw noAplicado();
  exigirDuenoReversible(c);
  exigirServicioReversible(c);
  return c;
}

/** ¿Es un pago de servicios adicionales que escribió la puente (`fijarDesdeComprobante`)? */
function esPagoSa(c: Pick<FilaAplicada, 'concepto' | 'esPago' | 'servicioTipoId'>): boolean {
  return c.esPago === true && c.concepto === ConceptoCosto.SERVICIOS_ADICIONALES && c.servicioTipoId !== null;
}

/** AC11: sin el estado previo de la puente (aplicado antes de la 0251) no se adivina: 409 y nada cambia. */
function exigirServicioReversible(c: Pick<FilaAplicada, 'concepto' | 'esPago' | 'servicioTipoId' | 'saAsignacionPrevia'>): void {
  if (esPagoSa(c) && c.saAsignacionPrevia === null) throw servicioNoReversible();
}

/** AC3: el pago de un derecho se corrige en su módulo. La documentación (es_pago = false) sí se desaplica. */
function exigirDuenoReversible(c: Pick<FilaAplicada, 'concepto' | 'esPago'>): void {
  if (c.esPago && c.concepto === ConceptoCosto.DERECHO) throw duenoNoReversible('Corrige el pago en su módulo');
}

interface Desaplicacion {
  destino: DestinoDesaplicacion;
  motivo: string;
  /** El estado al que vuelve el dueño (SOAT / impuesto): `pendiente` al desaplicar, `solicitado` al reemplazar. */
  duenoA: 'pendiente' | 'solicitado';
}

/** Pasos 1-6 de la cabecera. Devuelve la fila tal como estaba (trámite y concepto: los hereda el reemplazo). */
async function desaplicarEnTx(tx: Tx, id: string, d: Desaplicacion, ctx: ComprobanteCtx): Promise<FilaAplicada & { tramiteId: string; concepto: ConceptoCosto }> {
  const [c] = await tx.select(COLUMNAS).from(flitoComprobantes).where(eq(flitoComprobantes.id, id)).for('update').limit(1);
  if (!c) throw noEncontrado();
  if (c.estado !== EstadoComprobante.APLICADO || !c.tramiteId || !c.concepto) throw noAplicado();
  const concepto = c.concepto as ConceptoCosto;
  try {
    await bloquearTramite(tx, c.tramiteId);
  } catch (e) {
    if (e instanceof TramiteNoEncontradoError) throw noEncontrado('El trámite no existe');
    throw e;
  }
  exigirDuenoReversible(c);
  if (c.esPago && esHonorario(concepto)) await exigirNoLiquidado(tx, c.tramiteId);
  exigirServicioReversible(c);

  if (c.esPago) {
    const usuario = { userId: ctx.userId, nombre: ctx.username };
    try {
      await exigirDescuentoReversible(tx, id);
    } catch (e) {
      if (e instanceof PeriodoCerradoError) {
        throw new ComprobanteError(409, CodigoErrorComprobante.PERIODO_CERRADO, e.message, {
          bolsaId: e.bolsaId, bolsaNombre: e.bolsaNombre, periodo: e.periodo,
        });
      }
      throw e;
    }
    await revertirDescuentoComprobante(tx, id, usuario, { motivo: `Desaplicación del comprobante: ${d.motivo}` });
    await revertirDueno(tx, c.tramiteId, concepto, d, ctx);
    // AC11: la puente de servicios adicionales vuelve a como estaba antes de este pago.
    if (esPagoSa(c)) {
      await restaurarDesdeComprobante(tx, c.tramiteId, c.servicioTipoId!, { existia: c.saAsignacionPrevia === true, valor: c.saValorPrevio });
    }
  }

  const ahora = new Date();
  if (d.destino === 'pendiente') {
    await tx.update(flitoComprobantes).set({
      // `flito_comprobantes_pendiente_chk`: un pendiente lleva motivo. Vuelve leído y sin asociar.
      estado: EstadoComprobante.PENDIENTE, motivoPendiente: MotivoPendienteComprobante.LEIDO, detallePendiente: `Desaplicado: ${d.motivo}`,
      tramiteId: null, cruce: null, esPago: null, valor: null, soporteAplicadoId: null, servicioTipoId: null,
      saAsignacionPrevia: null, saValorPrevio: null,
      tarifaReferencia: null, diferenciaTarifa: null, marcadoPorDiferencia: false,
      diferenciaAceptadaPorId: null, diferenciaAceptadaEn: null, diferenciaAceptadaMotivo: null,
      aplicadoAutomaticamente: false, aplicadoPorId: null, aplicadoEn: null, aplicadoMotivo: null, updatedAt: ahora,
    }).where(and(eq(flitoComprobantes.id, id), eq(flitoComprobantes.estado, EstadoComprobante.APLICADO)));
  } else {
    await tx.update(flitoComprobantes).set({
      estado: EstadoComprobante.DESCARTADO, descartadoPorId: ctx.userId, descartadoEn: ahora, descartadoMotivo: d.motivo, updatedAt: ahora,
    }).where(and(eq(flitoComprobantes.id, id), eq(flitoComprobantes.estado, EstadoComprobante.APLICADO)));
    await liberarSoporteSiNadieLoUsa(tx, c.soporteId, id);
  }
  return { ...c, tramiteId: c.tramiteId, concepto };
}

/** Paso 5: SOAT / impuesto vuelven al estado de `d.duenoA` con su reversa de siempre; cualquier rechazo es 409 legible. */
async function revertirDueno(tx: Tx, tramiteId: string, concepto: ConceptoCosto, d: Desaplicacion, ctx: ComprobanteCtx): Promise<void> {
  if (concepto !== ConceptoCosto.SOAT && concepto !== ConceptoCosto.IMPUESTO) return;
  const motivoDueno = `Comprobante desaplicado: ${d.motivo}`;
  try {
    if (concepto === ConceptoCosto.SOAT) {
      const [t] = await tx.select({ soatId: flitoTramites.soatId }).from(flitoTramites).where(eq(flitoTramites.id, tramiteId)).limit(1);
      const [soat] = t?.soatId
        ? await tx.select({ id: flitoSoat.id, estado: flitoSoat.estado }).from(flitoSoat).where(eq(flitoSoat.id, t.soatId)).for('update').limit(1)
        : [];
      if (!soat) throw duenoNoReversible('El trámite ya no tiene el SOAT que se pagó');
      if (soat.estado !== EstadoSoat.PAGADO) throw duenoNoReversible(`El SOAT no está pagado (${soat.estado}): no hay pago que reversar`);
      await reversarSoatEnTx(tx, soat, d.duenoA === 'pendiente' ? EstadoSoat.PENDIENTE : EstadoSoat.SOLICITADO, motivoDueno, ctx);
      return;
    }
    const [imp] = await tx.select({ id: flitoImpuestos.id, estado: flitoImpuestos.estado }).from(flitoImpuestos)
      .where(eq(flitoImpuestos.tramiteId, tramiteId)).for('update').limit(1);
    if (!imp) throw duenoNoReversible('El trámite ya no tiene el impuesto que se pagó');
    if (imp.estado !== EstadoImpuesto.PAGADO) throw duenoNoReversible(`El impuesto no está pagado (${imp.estado}): no hay pago que reversar`);
    await reversarImpuestoEnTx(tx, imp, d.duenoA === 'pendiente' ? EstadoImpuesto.PENDIENTE : EstadoImpuesto.SOLICITADO, motivoDueno, { ...ctx, organismos: [], alcance: { enlace: 'ninguno' } });
  } catch (e) {
    if (e instanceof SoatError || e instanceof ImpuestoError) throw duenoNoReversible(e.message);
    throw e;
  }
}

// ─────────────────────────── Frontera por enlace (ADR-0024) ──────────────────

/**
 * AC10: ¿el comprobante cae dentro del alcance del enlace? Lo ajeno responde igual que lo inexistente (404,
 * mismo WHERE que el detalle); lo propio sigue cerrado a todo enlace (escritura interna de FLIT, P-2 de #13426).
 */
export async function visibleEnAlcance(id: string, alcance: AlcanceResuelto): Promise<boolean> {
  const [f] = await db.select({ id: flitoComprobantes.id }).from(flitoComprobantes)
    .where(and(eq(flitoComprobantes.id, id), condicionAlcanceComprobantes(alcance))).limit(1);
  return f !== undefined;
}

// ─────────────────────────── Operaciones ─────────────────────────────────────

/** `POST /:id/desaplicar` (AC1-AC6, AC8, AC9). 404 → 409 no_aplicado / dueno_no_reversible → 400 → tx. */
export async function desaplicar(id: string, cuerpo: unknown, ctx: ComprobanteCtx): Promise<{ comprobante: ComprobanteDetalleDto; destino: DestinoDesaplicacion; motivo: string }> {
  await leerAplicado(id);
  const parsed = desaplicarSchema.safeParse(cuerpo ?? {});
  if (!parsed.success) throw datosInvalidos('Elige el destino (pendiente o descartado) y escribe un motivo de 5 a 500 caracteres');
  const { destino, motivo: texto } = parsed.data;
  let original: Awaited<ReturnType<typeof desaplicarEnTx>>;
  try {
    original = await db.transaction(async (tx) => desaplicarEnTx(tx, id, {
      destino, motivo: texto, duenoA: 'pendiente',
    }, ctx));
  } catch (e) {
    throw traducirChoqueLlaveBolsa(e);
  }
  log.info({ comprobanteId: id, tramiteId: original.tramiteId, concepto: original.concepto, esPago: original.esPago, destino, por: ctx.userId },
    'Comprobante desaplicado');
  return { comprobante: await detalle(id), destino, motivo: texto };
}

/**
 * `POST /:id/reemplazar` (AC3, AC4, AC7, AC9). 404 → 409 no_aplicado / dueno_no_reversible → 400 → el
 * reemplazo: 404 / 409 ya_resuelto y las guardas de aplicar (sin la del dueño con `db`) → tx: desaplicar
 * el original a `descartado` y aplicar el reemplazo al mismo trámite y concepto.
 */
export async function reemplazar(id: string, cuerpo: unknown, ctx: ComprobanteCtx): Promise<{ original: ComprobanteDetalleDto; comprobante: ComprobanteDetalleDto; reemplazoId: string; motivo: string }> {
  const orig = await leerAplicado(id);
  const parsed = reemplazarSchema.safeParse(cuerpo ?? {});
  if (!parsed.success) throw datosInvalidos('Elige el comprobante de reemplazo y escribe un motivo de 5 a 500 caracteres');
  const { reemplazoId, motivo: texto, campos } = parsed.data;
  if (reemplazoId === id) throw datosInvalidos('El reemplazo tiene que ser otro comprobante');
  const [r] = await db.select({ estado: flitoComprobantes.estado }).from(flitoComprobantes).where(eq(flitoComprobantes.id, reemplazoId)).limit(1);
  if (!r) throw noEncontrado('El comprobante de reemplazo no existe');
  if (r.estado !== EstadoComprobante.PENDIENTE) throw yaResuelto();

  const plan = await prepararAplicacion(reemplazoId, {
    tramiteId: orig.tramiteId, concepto: orig.concepto, esPago: orig.esPago, campos: campos ?? {}, motivo: texto,
    ...(orig.servicioTipoId ? { servicioTipoId: orig.servicioTipoId } : {}),
  }, ctx, { sinGuardaPrevia: true });
  try {
    await db.transaction(async (tx) => {
      // Los DOS comprobantes antes que el trámite (mismo orden que aplicar): sin cruzar bloqueos con un
      // `aplicar` concurrente del reemplazo.
      const [lock] = await tx.select({ estado: flitoComprobantes.estado }).from(flitoComprobantes)
        .where(eq(flitoComprobantes.id, id)).for('update').limit(1);
      if (!lock) throw noEncontrado();
      if (lock.estado !== EstadoComprobante.APLICADO) throw noAplicado();
      const [rl] = await tx.select({ estado: flitoComprobantes.estado }).from(flitoComprobantes)
        .where(eq(flitoComprobantes.id, reemplazoId)).for('update').limit(1);
      if (!rl || rl.estado !== EstadoComprobante.PENDIENTE) throw yaResuelto();
      await desaplicarEnTx(tx, id, {
        destino: 'descartado', motivo: texto, duenoA: 'solicitado',
      }, ctx);
      await plan.enTx(tx);
    });
  } catch (e) {
    const choque = traducirChoqueLlaveBolsa(e);
    throw choque !== e ? choque : await plan.traducirError(e);
  }
  await plan.trasCommit();
  log.info({ comprobanteId: id, reemplazoId, tramiteId: orig.tramiteId, concepto: orig.concepto, por: ctx.userId }, 'Comprobante reemplazado');
  return { original: await detalle(id), comprobante: await plan.respuesta(), reemplazoId, motivo: texto };
}
