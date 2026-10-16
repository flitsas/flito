// HU #13426 (Feature #12871, ADR-0024 §4.4) — El alcance por ENLACE de Impuestos, fuera del servicio
// para que los tests que mockean `flito-impuestos.service.js` no tengan que conocerlo. Impuestos se
// abre a `compania` (su compañía) y a `organismos_transito` (sus secretarías). El filtro nunca mira el
// nombre del rol (AC8/AC9).
import { and, inArray, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { flitoImpuestos } from '../../db/schema.js';
import { AlcanceAjenoError, condicionPorCompania, condicionPorOrganismos } from '../../shared/alcance-filas.js';
import { esGestorDeOrganismo as esGestor, type ImpuestoCtx } from './flito-factura-venta.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * HU #13426: la condición de ALCANCE del enlace sobre `flito_impuestos`. `undefined` = sin acotar
 * (enlace `ninguno`). Compañía → su `compania_id`; organismos → sus secretarías; cualquier otro
 * enlace o id ausente → `false` (cero filas, nunca «todo»).
 */
export function condicionAlcanceImpuesto(ctx: ImpuestoCtx): SQL | undefined {
  return esGestor(ctx)
    ? condicionPorOrganismos(flitoImpuestos.organismoCodigo, ctx.alcance)
    : condicionPorCompania(flitoImpuestos.companiaId, ctx.alcance);
}

/**
 * HU #13426 (AC3): escritura sobre ids concretos. Con enlace, todos los ids tienen que estar en su
 * alcance; si no, 403 ANTES de tocar nada, sin distinguir «ajeno» de «inexistente» (sin oráculo).
 */
export async function exigirImpuestosPropios(ids: readonly string[], ctx: ImpuestoCtx): Promise<void> {
  const cond = condicionAlcanceImpuesto(ctx);
  if (!cond || ids.length === 0) return;
  const unicos = [...new Set(ids)];
  // Un id que no es uuid no puede ser suyo: 403 aquí, no un 500 de Postgres (22P02) en el `inArray`.
  if (unicos.some((id) => !UUID.test(id))) throw new AlcanceAjenoError();
  const propios = await db.select({ id: flitoImpuestos.id }).from(flitoImpuestos)
    .where(and(inArray(flitoImpuestos.id, unicos), cond));
  if (new Set(propios.map((p) => p.id)).size !== unicos.length) throw new AlcanceAjenoError();
}

/**
 * Escrituras sobre un impuesto que ya leen con `buscarConAcceso`: para la COMPAÑÍA, lo ajeno es 403
 * (AC3). El gestor del organismo conserva su frontera «404-no-403» de siempre (HU #12053).
 */
export async function exigirCompaniaPropia(ids: readonly string[], ctx: ImpuestoCtx): Promise<void> {
  if (ctx.alcance.enlace === 'compania') await exigirImpuestosPropios(ids, ctx);
}
