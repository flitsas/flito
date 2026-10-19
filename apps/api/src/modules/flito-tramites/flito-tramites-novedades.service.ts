// HU #13684 — Novedades de Gestión Trámites: ¿cambió algo desde la `marca` del listado en pantalla?
//
// Responde DOS contadores y nada más (sin ids, placas ni nombres): el sondeo del cliente corre cada
// ~50 s y no debe mover PII que nadie va a mirar. El filtro es el MISMO del listado
// (`construirCondiciones` + `conteoBase` + `condicionAlcanceTramites`), así que no hay dos verdades.
//
//   · `nuevos`: trámites que cumplen el filtro con `created_at > marca` (cuándo FLITO lo ingirió, no
//     `fecha_creacion_flit`). No depende de página ni orden: un nuevo que cae en otra página cuenta.
//   · `actualizados`: de los ids VISIBLES, los que tienen `updated_at > marca` y `created_at <= marca`
//     (el segundo término evita contar dos veces lo que ya es nuevo). El alcance se re-aplica: un id
//     ajeno inyectado en `visibles` no cuenta.
//
// Solo cuenta lo que mueve `flito_tramites` (decisión 2a de la HU): un cambio en `flito_soat` /
// `flito_impuestos` que no toque el trámite no avisa. Una `marca` futura da 0 y 0, no es un error.

import { and, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { flitoTramites } from '../../db/schema.js';
import type { AlcanceResuelto } from '../../shared/middleware/frontera-enlace.js';
import { condicionAlcanceTramites } from './flito-tramites.alcance.js';
import { construirCondiciones, conteoBase, type FiltrosListado } from './flito-tramites.service.js';

export interface NovedadesTramites { nuevos: number; actualizados: number }

/** Tope de ids visibles por consulta: el `pageSize` máximo del listado. */
export const MAX_VISIBLES_NOVEDADES = 200;

export async function novedades(
  filtros: FiltrosListado, marca: string, visibles: string[], alcance: AlcanceResuelto,
): Promise<NovedadesTramites> {
  const desde = sql`${marca}::timestamptz`;
  const porAlcance = condicionAlcanceTramites(alcance);

  const conds = construirCondiciones(filtros);
  if (porAlcance) conds.push(porAlcance);
  conds.push(sql`${flitoTramites.createdAt} > ${desde}`);
  const [n] = await conteoBase().where(and(...conds));

  let actualizados = 0;
  if (visibles.length > 0) {
    // Por PK sobre ≤200 ids: no hace falta índice en `updated_at`.
    const [a] = await db.select({ total: sql<number>`count(*)::int` }).from(flitoTramites).where(and(
      inArray(flitoTramites.id, visibles.slice(0, MAX_VISIBLES_NOVEDADES)),
      sql`${flitoTramites.updatedAt} > ${desde}`,
      sql`${flitoTramites.createdAt} <= ${desde}`,
      porAlcance,
    ));
    actualizados = Number(a?.total ?? 0);
  }
  return { nuevos: Number(n?.total ?? 0), actualizados };
}
