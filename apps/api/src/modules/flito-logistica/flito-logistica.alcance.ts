// HU #13426 (Feature #12871, ADR-0024 §4.4) — El alcance por ENLACE de Logística. El módulo se abre a
// `compania` (`FRONTERA_POR_ENLACE.logistica`): una compañía ve SOLO sus trámites, documentos y
// actas, y opera las suyas si su rol tiene la función (decisión P-2 del PO); lo ajeno → 403 en
// escritura (sin comprobar si existe: sin oráculo) y 404 en lectura. Sin enlace no se acota nada.
//
// HU #14349 y #14351 (ADR-0039 §6.3 y §6.4): también a `proveedor`, por el dueño estampado en cada fila, nunca por la
// compañía: al cambiar de proveedor, el nuevo no ve las LT que entregó el anterior. Las actas exigen además la fecha de
// corte (R17). La condición va SIEMPRE en el WHERE.
import { and, eq, inArray, ne, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  flitoLogisticaActas, flitoLogisticaCorteProveedor, flitoLogisticaDocumentos, flitoLogisticaRecogidaFirmantes,
  flitoLogisticaTraslados, flitoTramites,
} from '../../db/schema.js';
import type { AlcanceResuelto } from '../../shared/middleware/frontera-enlace.js';
import { AlcanceAjenoError, condicionPorCompania, condicionPorProveedor } from '../../shared/alcance-filas.js';
import { aprobadoSql } from './flito-logistica.aprobado.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NINGUNA_FILA: SQL = sql`false`;

/**
 * Desde la fecha de corte de este ambiente (R17, HU #14349). Sin fila la subconsulta da NULL y la comparación no se
 * cumple: sin fecha legible el proveedor no ve nada (AC8). Solo la lleva la condición de proveedor: Operaciones no la ejecuta.
 */
const desdeElCorte = (col: AnyColumn): SQL => sql`${col} >= (SELECT ${flitoLogisticaCorteProveedor.corteEn} FROM ${flitoLogisticaCorteProveedor})`;

/**
 * §6.3: el trámite de su LT, o el de su compañía si aún no tiene LT. La rama sin LT exige además compañía gestionada y
 * trámite aprobado: un trámite que no entró a la consola no se alcanza por id. El alias `d` evita chocar con el JOIN del listado.
 */
const tramitesDelProveedor = (proveedorId: string): SQL => sql`(
  EXISTS (SELECT 1 FROM flito_logistica_documentos d WHERE d.tramite_id = ${flitoTramites.id} AND d.proveedor_logistica_id = ${proveedorId})
  OR (NOT EXISTS (SELECT 1 FROM flito_logistica_documentos d WHERE d.tramite_id = ${flitoTramites.id})
    AND ${aprobadoSql}
    AND EXISTS (SELECT 1 FROM clients c WHERE c.id = ${flitoTramites.companiaId}
      AND c.flito_proveedor_logistica_id = ${proveedorId} AND c.logistica_autogestionable = false))
)`;

/** Condición de alcance sobre los trámites del listado y las facetas. `undefined` = sin acotar. */
export const condicionTramitesLogistica = (a: AlcanceResuelto): SQL | undefined => {
  if (a.enlace !== 'proveedor') return condicionPorCompania(flitoTramites.companiaId, a);
  return a.proveedorId ? tramitesDelProveedor(a.proveedorId) : NINGUNA_FILA;
};

/** Actas del proveedor (§6.3): las suyas, desde el corte y sin las históricas estampadas con el proveedor por defecto. */
const actasDelProveedor = (a: AlcanceResuelto): SQL => and(
  condicionPorProveedor(flitoLogisticaActas.proveedorLogisticaId, a),
  desdeElCorte(flitoLogisticaActas.createdAt),
  sql`NOT EXISTS (SELECT 1 FROM flito_logistica_traslados tr WHERE tr.id = ${flitoLogisticaActas.trasladoId} AND tr.legado)`,
)!;

/**
 * Condición de alcance sobre las actas. `undefined` = sin acotar (sin enlace).
 * HU #14109 (ADR-0030 §9): el acta de organismo es multi-compañía y su `compania_id` puede ser NULL. Para
 * una compañía es INVISIBLE: se excluye por `punto` Y por compañía (default seguro: lo que no
 * encaja en el alcance no se muestra, aunque un acta de organismo trajera compañía). El proveedor sí la alcanza por id,
 * porque la estampa `confirmarRecogida` (§6.3); los listados la excluyen para todos.
 */
export const condicionActasLogistica = (a: AlcanceResuelto): SQL | undefined => {
  if (a.enlace === 'proveedor') return actasDelProveedor(a);
  const porCompania = condicionPorCompania(flitoLogisticaActas.companiaId, a);
  return porCompania && and(porCompania, ne(flitoLogisticaActas.punto, 'organismo'));
};

/** Condición de alcance sobre los documentos (compañías cerrables). `undefined` = sin acotar. */
export const condicionDocumentosLogistica = (a: AlcanceResuelto): SQL | undefined => (
  a.enlace === 'proveedor'
    ? condicionPorProveedor(flitoLogisticaDocumentos.proveedorLogisticaId, a)
    : condicionPorCompania(flitoLogisticaDocumentos.companiaId, a)
);

/** Viajes (§6.5): por traslado, vía acta. Solo Operaciones y proveedor llegan a estas rutas: otro enlace, cero filas. */
export const condicionTrasladosLogistica = (a: AlcanceResuelto): SQL | undefined => {
  if (a.enlace === 'ninguno') return undefined;
  if (a.enlace !== 'proveedor') return NINGUNA_FILA;
  return sql`EXISTS (SELECT 1 FROM ${flitoLogisticaActas} WHERE ${flitoLogisticaActas.trasladoId} = ${flitoLogisticaTraslados.id} AND ${actasDelProveedor(a)})`;
};

/** Firmantes de recogida (§6.3): el proveedor, si todas las LT del firmante eran suyas, y desde el corte. `NULL` = solo Operaciones. */
export const condicionFirmantesLogistica = (a: AlcanceResuelto): SQL | undefined => {
  if (a.enlace === 'ninguno') return undefined;
  if (a.enlace !== 'proveedor') return NINGUNA_FILA;
  return and(condicionPorProveedor(flitoLogisticaRecogidaFirmantes.proveedorLogisticaId, a), desdeElCorte(flitoLogisticaRecogidaFirmantes.firmadoEn));
};

type Recurso = 'acta' | 'documento' | 'tramite' | 'traslado' | 'firmante';

const TABLA = {
  acta: flitoLogisticaActas, documento: flitoLogisticaDocumentos, tramite: flitoTramites,
  traslado: flitoLogisticaTraslados, firmante: flitoLogisticaRecogidaFirmantes,
} as const;

/** Cuántos de estos ids alcanza la condición. Una consulta, con el alcance EN EL WHERE. */
async function contarPropios(recurso: Recurso, ids: string[], cond: SQL): Promise<number> {
  const t = TABLA[recurso];
  const filas = await db.select({ id: t.id }).from(t as typeof flitoLogisticaActas)
    .where(and(ids.length === 1 ? eq(t.id, ids[0]!) : inArray(t.id, ids), cond)).limit(ids.length);
  return filas.length;
}

const CONDICION: Record<Recurso, (a: AlcanceResuelto) => SQL | undefined> = {
  acta: condicionActasLogistica, documento: condicionDocumentosLogistica, tramite: condicionTramitesLogistica,
  traslado: condicionTrasladosLogistica, firmante: condicionFirmantesLogistica,
};

/** ¿Está el recurso dentro del alcance? Sin enlace, sí sin consultar. */
export async function enAlcanceLogistica(recurso: Recurso, id: string, a: AlcanceResuelto): Promise<boolean> {
  const cond = CONDICION[recurso](a);
  if (!cond) return true;
  if (!UUID.test(id)) return false;
  return (await contarPropios(recurso, [id], cond)) === 1;
}

/** Escritura (AC3): 403 si el recurso no es suyo (o no existe), antes de tocar nada. */
export async function exigirPropioLogistica(recurso: Recurso, id: string, a: AlcanceResuelto): Promise<void> {
  if (!await enAlcanceLogistica(recurso, id, a)) throw new AlcanceAjenoError();
}

/** Un lote (§6.4): 403 si alguno no es suyo o no existe, sin decir cuál. */
export async function exigirPropiosLogistica(recurso: Recurso, ids: string[], a: AlcanceResuelto): Promise<void> {
  const cond = CONDICION[recurso](a);
  if (!cond) return;
  const unicos = [...new Set(ids)];
  if (unicos.some((id) => !UUID.test(id))) throw new AlcanceAjenoError();
  if (unicos.length === 0) return;
  if ((await contarPropios(recurso, unicos, cond)) !== unicos.length) throw new AlcanceAjenoError();
}
