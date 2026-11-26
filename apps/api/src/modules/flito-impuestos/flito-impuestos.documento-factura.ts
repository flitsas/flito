// FLITO Impuestos — corregir o reintentar número, fecha y avalúo de la factura tras certificar
// (HU #14664, Feature #14662, Épica #14164). Mismo principio que `flito-impuestos.direccion.ts`:
// sub-router y servicio propios para que el inventario de guardas vea solo estas rutas.
//
//   AC2  Corrección manual: exige motivo; el campo corregido queda `confiable: true` con el valor
//        escrito (o `null` si se vació). Sin restricción de estado (igual que la dirección): también
//        certificado o pagado.
//   AC3  Reintento: vuelve a descargar + leer la MISMA factura y reemplaza SOLO estos 3 campos —
//        vehículo, dirección e identidad del comprador quedan intactos.
//   AC4  Ninguna de las dos toca `analisisEstado`, la certificación ni la comparación RUNT: no
//        importan `reanalizarImpuesto` ni nada de `flito-impuestos.analisis.service.ts`.
//   AC5  Auditoría: toda corrección/reintento sobrescribe `ultimoCambioDocumento` (quién, cuándo,
//        motivo) dentro del mismo jsonb — no hay historial, solo el último movimiento.
//
// Escritura ATÓMICA con `jsonb_set` anidado (sin SELECT previo): dos pestañas corrigiendo o
// reintentando el mismo impuesto a la vez no deben poder perder el cambio de una clave que ninguna
// de las dos tocó (vehículo, dirección, identidad del comprador).
//
// PII: estos 3 campos (número/fecha/avalúo de la factura) NO son datos personales del titular
// (AGENTS.md §14/§16) — la auditoría de la mutación va por `audit()` en la ruta, no por
// `logPiiAccess`/`pii_access_log`.

import { and, eq, ne, sql, type SQL } from 'drizzle-orm';
import {
  TipoCambioDocumentoFactura,
  type CampoExtraido, type DatosDocumentoFacturaImpuesto,
  type ExtraccionFacturaVentaImpuesto, type UltimoCambioDocumentoFactura,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoImpuestos } from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';
import { descargarFacturaDeImpuesto, extraerDeFactura, FacturaNoDisponibleError } from './flito-impuestos.extraccion.js';
import { exigirImpuestoVigentePorId } from '../../shared/tramite-vigente.js';

const log = loggerFor('flito-impuestos.documento-factura');

/** El bloque `datosDocumentoFactura` del detalle: nunca `null` — los 3 `CampoExtraido` vienen
 * `null` si nunca hubo lectura, así el frontend distingue "sin lectura" con un solo chequeo (AC8). */
export function bloqueDatosDocumentoFacturaDetalle(
  e: ExtraccionFacturaVentaImpuesto | null | undefined,
): DatosDocumentoFacturaImpuesto {
  return {
    numeroFactura: e?.numeroFactura ?? null,
    fechaFactura: e?.fechaFactura ?? null,
    avaluoComercial: e?.avaluoComercial ?? null,
    ultimoCambio: e?.ultimoCambioDocumento ?? null,
  };
}

/** `undefined` = no tocar esa clave. `''` (tras recorte) vacía el campo (`valor: null`), AC2. */
function campoManual(valor: string | undefined): CampoExtraido | undefined {
  if (valor === undefined) return undefined;
  const v = valor.trim();
  return { valor: v === '' ? null : v, confianza: 1, confiable: true };
}

/** Arma el `UPDATE ... SET extraccion_factura_venta = jsonb_set(jsonb_set(...))` final. */
function conJsonbSetDe(
  base: SQL, claves: ReadonlyArray<readonly [string, CampoExtraido | undefined]>, ultimoCambio: UltimoCambioDocumentoFactura,
): SQL {
  let expr = base;
  for (const [clave, campo] of claves) {
    if (campo === undefined) continue;
    const ruta = sql.raw(`'{${clave}}'`);
    expr = sql`jsonb_set(${expr}, ${ruta}, ${JSON.stringify(campo)}::jsonb, true)`;
  }
  return sql`jsonb_set(${expr}, '{ultimoCambioDocumento}', ${JSON.stringify(ultimoCambio)}::jsonb, true)`;
}

const BASE_JSONB: SQL = sql`COALESCE(${flitoImpuestos.extraccionFacturaVenta}, '{}'::jsonb)`;

/**
 * Corrección manual de número/fecha/avalúo (AC2/AC4). La frontera (404) la pone la ruta con
 * `buscarConAcceso` ANTES de llamar. `null` si la fila desapareció entre la frontera y el `UPDATE`.
 */
export async function corregirDatosDocumentoFactura(
  id: string,
  datos: { numeroFactura?: string; fechaFactura?: string; avaluoComercial?: string; motivo: string },
  actor: { userId: number; nombre: string },
): Promise<DatosDocumentoFacturaImpuesto | null> {
  const ultimoCambio: UltimoCambioDocumentoFactura = {
    tipo: TipoCambioDocumentoFactura.CORRECCION, usuarioId: String(actor.userId), usuarioNombre: actor.nombre,
    en: new Date().toISOString(), motivo: datos.motivo,
  };
  const expr = conJsonbSetDe(BASE_JSONB, [
    ['numeroFactura', campoManual(datos.numeroFactura)],
    ['fechaFactura', campoManual(datos.fechaFactura)],
    ['avaluoComercial', campoManual(datos.avaluoComercial)],
  ], ultimoCambio);

  const [fila] = await db.update(flitoImpuestos)
    .set({ extraccionFacturaVenta: expr, updatedAt: new Date() })
    .where(and(eq(flitoImpuestos.id, id), ne(flitoImpuestos.estado, 'descartado')))
    .returning();
  // Épica #14707 (I): un impuesto `descartado` no se corrige (409); el UPDATE ya lo excluyó.
  if (!fila) { await exigirImpuestoVigentePorId(id); return null; }
  log.info({ impuestoId: id }, 'documento-factura: corrección manual guardada');
  return bloqueDatosDocumentoFacturaDetalle(fila.extraccionFacturaVenta);
}

/**
 * Reintento de lectura (AC3): descarga + OCR de la MISMA factura y reemplaza SOLO los 3 campos del
 * documento. De las hasta 18 claves de la extracción fresca se descartan vehículo, dirección e
 * identidad del comprador — nunca se escriben. SÍNCRONO (decisión del humano): responde con el
 * resultado en el mismo request.
 */
export async function reintentarLecturaDocumentoFactura(
  id: string, motivo: string, actor: { userId: number; nombre: string },
): Promise<
  | { resultado: 'OK'; datos: DatosDocumentoFacturaImpuesto }
  | { resultado: 'NO_ENCONTRADO' }
  | { resultado: 'FACTURA_NO_DISPONIBLE'; motivo: string }
> {
  let factura: { bytes: Buffer; contentType: string };
  try {
    factura = await descargarFacturaDeImpuesto(id);
  } catch (e) {
    if (e instanceof FacturaNoDisponibleError) {
      log.warn({ impuestoId: id, motivo: e.motivo }, 'documento-factura: reintento sin factura disponible');
      return { resultado: 'FACTURA_NO_DISPONIBLE', motivo: e.motivo };
    }
    throw e;
  }
  const fresca = await extraerDeFactura(factura);
  const ultimoCambio: UltimoCambioDocumentoFactura = {
    tipo: TipoCambioDocumentoFactura.REINTENTO, usuarioId: String(actor.userId), usuarioNombre: actor.nombre,
    en: new Date().toISOString(), motivo,
  };
  // Siempre las tres: un reintento reemplaza la lectura completa de esos campos (no un merge parcial).
  const expr = conJsonbSetDe(BASE_JSONB, [
    ['numeroFactura', fresca.numeroFactura],
    ['fechaFactura', fresca.fechaFactura],
    ['avaluoComercial', fresca.avaluoComercial],
  ], ultimoCambio);

  const [fila] = await db.update(flitoImpuestos)
    .set({ extraccionFacturaVenta: expr, updatedAt: new Date() })
    .where(and(eq(flitoImpuestos.id, id), ne(flitoImpuestos.estado, 'descartado')))
    .returning();
  // Épica #14707 (I): ídem en el reintento.
  if (!fila) { await exigirImpuestoVigentePorId(id); return { resultado: 'NO_ENCONTRADO' }; }
  log.info({ impuestoId: id }, 'documento-factura: reintento de lectura guardado');
  return { resultado: 'OK', datos: bloqueDatosDocumentoFacturaDetalle(fila.extraccionFacturaVenta) };
}
