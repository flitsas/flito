// HU #13426 (Feature #12871, ADR-0024 §4.4) — El alcance por ENLACE de Gestión Trámites. El módulo
// se abre a `compania` (`FRONTERA_POR_ENLACE.tramites`): una compañía ve y opera SOLO sus trámites.
// Sin enlace (`ninguno`) no se acota nada. El filtro nunca mira el nombre del rol (AC8/AC9).
import { and, eq, inArray, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { flitoTramites } from '../../db/schema.js';
import type { AlcanceResuelto } from '../../shared/middleware/frontera-enlace.js';
import { AlcanceAjenoError, condicionPorCompania } from '../../shared/alcance-filas.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Condición de alcance sobre `flito_tramites`. `undefined` = sin acotar. */
export function condicionAlcanceTramites(a: AlcanceResuelto): SQL | undefined {
  return condicionPorCompania(flitoTramites.companiaId, a);
}

/** ¿Está el trámite en el alcance? Lectura de detalle: el que no lo está responde 404 (AC2). */
export async function tramiteEnAlcance(id: string, a: AlcanceResuelto): Promise<boolean> {
  const cond = condicionAlcanceTramites(a);
  if (!cond) return true;
  if (!UUID.test(id)) return false; // un id que no es uuid no es de nadie (y no llega a Postgres)
  const [f] = await db.select({ id: flitoTramites.id }).from(flitoTramites)
    .where(and(eq(flitoTramites.id, id), cond)).limit(1);
  return !!f;
}

/**
 * Escritura sobre un lote de trámites (AC3): con enlace, TODOS tienen que ser suyos; si uno no lo es
 * (o no existe), 403 antes de tocar nada — sin distinguir ajeno de inexistente.
 */
export async function exigirTramitesPropios(ids: readonly string[], a: AlcanceResuelto): Promise<void> {
  const cond = condicionAlcanceTramites(a);
  if (!cond || ids.length === 0) return;
  const unicos = [...new Set(ids)];
  if (!unicos.every((id) => UUID.test(id))) throw new AlcanceAjenoError();
  const propios = await db.select({ id: flitoTramites.id }).from(flitoTramites)
    .where(and(inArray(flitoTramites.id, unicos), cond));
  if (new Set(propios.map((p) => p.id)).size !== unicos.length) throw new AlcanceAjenoError();
}
