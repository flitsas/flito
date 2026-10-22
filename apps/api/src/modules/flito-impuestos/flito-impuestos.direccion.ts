// FLITO Impuestos — dirección del comprador leída de la factura de venta (HU #12833, Épica #12809,
// Feature #12824). Diseño: docs/diseno-hu-12833-direccion-comprador.md (D1-D6).
//
// La dirección CONFIRMADA vive en `flito_impuestos` (migración 0208) y NUNCA en `flito_compradores`:
// el sync con FLIT borra y reinserta los compradores, así que ahí se perdería (AC1/AC2).
//
//   AC1  Paso `direccion` del análisis (entre `extraccion` y `comparacion`): dirección confiable →
//        confirmada (`direccion_fuente = 'factura'`). Municipio/departamento solo si su campo es
//        confiable; si no, NULL y el lector cae a FLIT campo a campo (decisión de David, 2026-09-24).
//   AC3  No confiable o ausente → `direccion_pendiente_revision = true`. La propuesta sin confirmar
//        NO se duplica: ya está en `extraccion_factura_venta`.
//   AC5  Corrección manual (`direccion_fuente = 'manual'`), permitida en cualquier estado. Ni el paso
//        ni el reintento la pisan nunca (guarda `IS DISTINCT FROM 'manual'` y D6).
//
// PII: nada de valores en los logs. Solo el id del impuesto y el desenlace.

import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  AnalisisEstadoImpuesto, type CampoExtraido, type DireccionCompradorImpuesto,
  type ExtraccionFacturaVentaImpuesto,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoCompradores, flitoImpuestos, flitoTramites } from '../../db/schema.js';
import { celdaDesdeJson, expresionesFlitRaw } from '../../shared/export/cola-flito-derivados.js';
import { loggerFor } from '../../shared/logger.js';
import { registrarAccesoSistema } from './flito-impuestos.extraccion.js';
import type { PasoAnalisis } from './flito-impuestos.analisis.service.js';

const log = loggerFor('flito-impuestos.direccion');

export type FuenteDireccion = 'factura' | 'manual';

export interface DireccionPlana { direccion: string | null; municipio: string | null; departamento: string | null }

/** El valor recortado de un campo extraído, o `null` si viene vacío. */
function valorDe(c: CampoExtraido | undefined | null): string | null {
  if (c?.valor === null || c?.valor === undefined) return null;
  const v = String(c.valor).trim();
  return v === '' ? null : v;
}

const confiableDe = (c: CampoExtraido | undefined | null): string | null => (c?.confiable ? valorDe(c) : null);

/**
 * La regla del paso sobre lo extraído (y la misma que el backfill de la 0208). `null` = no hay
 * dirección confiable → pendiente de revisión (AC3).
 */
export function direccionConfirmableDe(e: ExtraccionFacturaVentaImpuesto | null | undefined): DireccionPlana | null {
  const direccion = confiableDe(e?.direccion);
  if (!direccion) return null;
  return { direccion, municipio: confiableDe(e?.municipio), departamento: confiableDe(e?.departamento) };
}

/** La propuesta sin confirmar (lo leído, confiable o no), para el detalle. */
function propuestaDe(e: ExtraccionFacturaVentaImpuesto | null | undefined): DireccionPlana | null {
  if (!e) return null;
  const p = { direccion: valorDe(e.direccion), municipio: valorDe(e.municipio), departamento: valorDe(e.departamento) };
  return p.direccion || p.municipio || p.departamento ? p : null;
}

// ─────────────────────────────── Paso del análisis (AC1/AC3) ───────────────────────────────

/** Guarda de todo `UPDATE` automático: una corrección manual siempre gana, aunque llegue en pleno job. */
export const NO_MANUAL: SQL = sql`${flitoImpuestos.direccionFuente} IS DISTINCT FROM 'manual'`;

/** Paso `direccion` de la cola de la HU 12825. No toca `flito_compradores` (AC1). */
export const pasoDireccion: PasoAnalisis = async ({ impuestoId }) => {
  const [fila] = await db.select({ extraccion: flitoImpuestos.extraccionFacturaVenta })
    .from(flitoImpuestos).where(eq(flitoImpuestos.id, impuestoId)).limit(1);
  const confirmable = direccionConfirmableDe(fila?.extraccion);
  const guarda = and(
    eq(flitoImpuestos.id, impuestoId),
    eq(flitoImpuestos.analisisEstado, AnalisisEstadoImpuesto.EN_CURSO),
    NO_MANUAL,
  );
  if (confirmable) {
    await db.update(flitoImpuestos).set({
      direccionFactura: confirmable.direccion,
      municipioFactura: confirmable.municipio,
      departamentoFactura: confirmable.departamento,
      direccionFuente: 'factura',
      direccionPendienteRevision: false,
      direccionConfirmadaPorId: null,
      direccionConfirmadaPorNombre: null,
      direccionConfirmadaEn: new Date(),
    }).where(guarda);
  } else {
    await db.update(flitoImpuestos).set({ direccionPendienteRevision: true }).where(guarda);
  }
  await registrarAccesoSistema(impuestoId, ['direccion', 'municipio', 'departamento'], 'dirección de la factura');
  log.info({ impuestoId, resultado: confirmable ? 'confirmada' : 'pendiente' }, 'direccion: decidida');
};

/**
 * Valor de `direccion_pendiente_revision` en los `UPDATE` que ponen `error_analisis` (D2): un
 * análisis caído sin dirección confirmada queda pendiente; una ya confirmada no se marca.
 */
export const PENDIENTE_SI_SIN_DIRECCION: SQL = sql`${flitoImpuestos.direccionFuente} IS NULL`;

/**
 * Limpieza del reintento (D6), a expandir en el `UPDATE` de `reanalizarImpuesto`. La confirmación
 * automática se descarta y el análisis nuevo la vuelve a decidir; la manual se conserva tal cual.
 */
const siManual = (col: AnyPgColumn): SQL =>
  sql`CASE WHEN ${flitoImpuestos.direccionFuente} = 'manual' THEN ${col} END`;

export const LIMPIEZA_DIRECCION_REANALISIS = {
  direccionFactura: siManual(flitoImpuestos.direccionFactura),
  municipioFactura: siManual(flitoImpuestos.municipioFactura),
  departamentoFactura: siManual(flitoImpuestos.departamentoFactura),
  direccionConfirmadaPorId: siManual(flitoImpuestos.direccionConfirmadaPorId),
  direccionConfirmadaPorNombre: siManual(flitoImpuestos.direccionConfirmadaPorNombre),
  direccionConfirmadaEn: siManual(flitoImpuestos.direccionConfirmadaEn),
  direccionFuente: sql`NULLIF(${flitoImpuestos.direccionFuente}, 'factura')`,
  direccionPendienteRevision: false,
} as const;

// ─────────────────────────────── Lectura (AC2) ───────────────────────────────

export interface DireccionFactura extends DireccionPlana { fuente: FuenteDireccion | null }

/**
 * Precedencia única de lectura (D3). Con dirección confirmada manda la de la factura/manual y el
 * municipio/departamento vacíos caen a FLIT campo a campo; sin ella, FLIT tal cual.
 */
export function direccionEfectiva(
  f: DireccionFactura, flit: DireccionPlana,
): DireccionPlana & { origen: FuenteDireccion | 'flit' } {
  if (f.fuente !== 'factura' && f.fuente !== 'manual') return { ...flit, origen: 'flit' };
  return {
    direccion: f.direccion,
    municipio: f.municipio ?? flit.municipio,
    departamento: f.departamento ?? flit.departamento,
    origen: f.fuente,
  };
}

/**
 * La dirección de FLIT de UN trámite, con las mismas fuentes que el Excel de la cola: dirección del
 * comprador principal (`orden asc, id asc`), municipio = `flito_tramites.ciudad`, departamento de
 * `flit_raw`. Para el detalle (el export la arma por lote en `ensamblarFilas`).
 */
export async function direccionFlitDe(tramiteId: string): Promise<DireccionPlana> {
  const [t] = await db.select({
    municipio: flitoTramites.ciudad, departamento: expresionesFlitRaw(flitoTramites.flitRaw).departamento,
  }).from(flitoTramites).where(eq(flitoTramites.id, tramiteId)).limit(1);
  const [c] = await db.select({ direccion: flitoCompradores.direccion }).from(flitoCompradores)
    .where(eq(flitoCompradores.tramiteId, tramiteId))
    .orderBy(asc(flitoCompradores.orden), asc(flitoCompradores.id)).limit(1);
  return {
    direccion: c?.direccion?.trim() || null,
    municipio: t?.municipio?.trim() || null,
    departamento: celdaDesdeJson(t?.departamento),
  };
}

type FilaImpuesto = typeof flitoImpuestos.$inferSelect;

const ANALISIS_TERMINADO: readonly (string | null)[] = [AnalisisEstadoImpuesto.COMPLETADO, AnalisisEstadoImpuesto.ERROR];

/** El bloque `direccionComprador` del detalle: el dato efectivo y lo que pinta la HU 12834. */
export function bloqueDireccionDetalle(imp: FilaImpuesto, flit: DireccionPlana): DireccionCompradorImpuesto {
  const efectiva = direccionEfectiva({
    fuente: imp.direccionFuente, direccion: imp.direccionFactura,
    municipio: imp.municipioFactura, departamento: imp.departamentoFactura,
  }, flit);
  // Igual que la marca del Excel (AC8): nunca analizado o en curso → sin marca.
  const pendienteRevision = imp.direccionPendienteRevision && ANALISIS_TERMINADO.includes(imp.analisisEstado);
  return {
    ...efectiva,
    pendienteRevision,
    propuesta: pendienteRevision ? propuestaDe(imp.extraccionFacturaVenta) : null,
    confirmadaPor: imp.direccionConfirmadaPorNombre ?? null,
    confirmadaEn: imp.direccionConfirmadaEn ? imp.direccionConfirmadaEn.toISOString() : null,
  };
}

// ─────────────────────────────── Corrección manual (AC5) ───────────────────────────────

/**
 * Guarda y confirma la dirección corregida. La frontera (404) la pone la ruta con `buscarConAcceso`
 * ANTES. Sin restricción de estado (decisión de David): también certificado, pagado o en análisis.
 * `null` si la fila desapareció entre la frontera y el `UPDATE`.
 */
export async function corregirDireccionImpuesto(
  id: string, datos: { direccion: string; municipio: string; departamento: string },
  actor: { userId: number; nombre: string },
): Promise<DireccionCompradorImpuesto | null> {
  const [fila] = await db.update(flitoImpuestos).set({
    direccionFactura: datos.direccion,
    municipioFactura: datos.municipio,
    departamentoFactura: datos.departamento,
    direccionFuente: 'manual',
    direccionPendienteRevision: false,
    direccionConfirmadaPorId: actor.userId,
    direccionConfirmadaPorNombre: actor.nombre,
    direccionConfirmadaEn: new Date(),
    updatedAt: new Date(),
  }).where(eq(flitoImpuestos.id, id)).returning();
  if (!fila) return null;
  return bloqueDireccionDetalle(fila, { direccion: null, municipio: null, departamento: null });
}
