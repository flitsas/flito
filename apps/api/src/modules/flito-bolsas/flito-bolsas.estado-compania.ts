// HU #13899 (Feature #13886, ADR-0029) — contrato (d) con la Épica #13407 (gestión documental):
// «¿esta compañía tiene bolsa y está activa?».
//
// Archivo aparte, pequeño y sin dependencias del resto del módulo (solo `db` + `flitoBolsasUnicas`):
// `flito-bolsas.service.ts` está en su techo de max-lines y así #13407 lo importa sin ciclo.
// La unicidad 1:1 la da el índice PARCIAL `uq_flito_bolsas_unicas_compania … WHERE alcance='compania'`;
// la tabla NO tiene unique(compania_id), por eso el filtro lleva el alcance.
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { flitoBolsasUnicas } from '../../db/schema.js';

/** Misma forma que `EstadoBolsaCompaniaDto` (shared-types) y que el tipo del fallback de #13407. */
export interface EstadoBolsaCompania { existe: boolean; activa: boolean }

/** Sin bolsa → `{ existe: false, activa: false }` (nunca 404). `activa` es false cuando `existe` es false. */
export async function estadoBolsaDeCompania(companiaId: number): Promise<EstadoBolsaCompania> {
  const [fila] = await db
    .select({ activa: flitoBolsasUnicas.activa })
    .from(flitoBolsasUnicas)
    .where(and(eq(flitoBolsasUnicas.alcance, 'compania'), eq(flitoBolsasUnicas.companiaId, companiaId)))
    .limit(1);
  return fila ? { existe: true, activa: fila.activa } : { existe: false, activa: false };
}
