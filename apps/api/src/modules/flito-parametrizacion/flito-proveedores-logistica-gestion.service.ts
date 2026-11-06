// HU #14148 (Feature #14089, Épica #13758) — Impacto de un proveedor de logística. Módulo FLITO `flito-parametrizacion`.
//
// Reglas:
//   · RN-PROVU-2 — `{ companias, nombres }` con los nombres de las compañías vigentes asignadas, en orden alfabético y MÁXIMO
//       3 (`companias` es el total real). Un perfil de baja no tiene impacto.
//   · RN-PROVU-1 y RN-PROVU-3 — RETIRADAS por la HU #14334: el listado unificado y el DELETE físico ya no existen. Listar y
//       eliminar viven en `flito-proveedores.service.ts` y `flito-proveedores-eliminar.service.ts`.
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { flitoProveedoresLogistica } from '../../db/schema.js';
import { companiasConProveedorLogistica } from './flito-logistica-proveedor-compania.service.js';
import { ProveedorLogisticaNoEncontradoError } from './flito-proveedores-logistica.service.js';

export const TOPE_NOMBRES_IMPACTO = 3;

/** RN-PROVU-2. Lanza `ProveedorLogisticaNoEncontradoError` si el proveedor no existe o su perfil está de baja. */
export async function impactoProveedorLogistica(id: string): Promise<{ companias: number; nombres: string[] }> {
  const [p] = await db.select({ id: flitoProveedoresLogistica.id }).from(flitoProveedoresLogistica)
    .where(and(eq(flitoProveedoresLogistica.id, id), isNull(flitoProveedoresLogistica.deletedAt))).limit(1);
  if (p === undefined) throw new ProveedorLogisticaNoEncontradoError();
  const nombres = await companiasConProveedorLogistica(db, id);
  return { companias: nombres.length, nombres: nombres.slice(0, TOPE_NOMBRES_IMPACTO) };
}
