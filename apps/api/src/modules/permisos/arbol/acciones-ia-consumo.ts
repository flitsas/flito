// Épica #14548 (ADR-0051) — Qué OPERACIONES concede cada acción del visor de solo lectura de consumo de IA. Mismo
// contrato que `acciones-torre.ts`: la ruta exige la operación (`ia_consumo.*`, con `exigirFuncion` por ruta en
// `ia-consumo/ia-consumo.routes.ts`); la tiene quien tenga la acción efectiva que la contiene.
//
// Las operaciones NACEN en el árbol (no se siembran: `OPERACIONES_NACIDAS_EN_EL_ARBOL`) y las acciones son posteriores
// a la siembra (`ACCIONES_NACIDAS_TRAS_LA_SIEMBRA`). `predecesores: []`: nadie las tenía. Solo `admin` las recibe por
// defecto (D4, ADR-0022) y no hay reparto a otros roles en la migración: el resto lo concede el panel de permisos.
// `apoyo` concede la lectura junto con la acción sin exigirla para recibirla (`arbol/acciones-gestion.ts`).
import type { AccionArbol } from './acciones-gestion.js';

export const ACCIONES_IA_CONSUMO: Readonly<Record<string, AccionArbol>> = {
  'accion.ia_consumo.ver': { lectura: true, operaciones: ['ia_consumo.registros.ver'], predecesores: [] },
  'accion.ia_consumo.exportar': { operaciones: ['ia_consumo.registros.exportar'], apoyo: ['ia_consumo.registros.ver'], predecesores: [] },
  'accion.ia_consumo.ver_contenido': { operaciones: ['ia_consumo.contenido.ver'], apoyo: ['ia_consumo.registros.ver'], predecesores: [] },
};

/** Las operaciones que nacen con el ítem `ia_consumo` (ver `OPERACIONES_NACIDAS_EN_EL_ARBOL`). */
export const OPERACIONES_IA_CONSUMO: readonly string[] = Object.values(ACCIONES_IA_CONSUMO).flatMap((x) => x.operaciones);
