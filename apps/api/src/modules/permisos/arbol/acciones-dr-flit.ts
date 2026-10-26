// HU #13941 (decisión de David, 2026-10-24) — Qué OPERACIONES concede cada acción de General · Dr. Flit.
// Mismo contrato que `acciones-gestion.ts`: la ruta exige la operación (`drflit.*`, en línea en
// `flito-dr-flit/dr-flit.funciones.ts`); la tiene quien tenga la acción efectiva que la contiene.
//
// Las cuatro operaciones NACEN en el árbol (como las del expediente de bolsas, HU #13889): no parten ninguna
// guarda vieja, no existieron en el mundo plano, nacen absorbidas (no se siembran: sembrarlas haría fallar
// `verificarCatalogoAlArrancar`) y las acciones las siembra la 0254. `predecesores: []`: nadie las tenía.
//   · «Ver los manuales» es de reparto UNIVERSAL (como Perfil, P-22): la 0254 la da con el ítem a todos los
//     roles y `crearRol` la marca a todo rol nuevo (`ACCIONES_UNIVERSALES`).
//   · IA, consulta de gestión y soporte: solo `admin` (ADR-0022, «admin tiene todas las acciones»); al resto
//     se le conceden desde la pantalla de permisos.
import type { AccionArbol } from './acciones-gestion.js';

export const ACCIONES_DR_FLIT: Readonly<Record<string, AccionArbol>> = {
  'accion.dr_flit.ver_manuales': { lectura: true, operaciones: ['drflit.manuales.ver'], predecesores: [], repartoUniversal: true },
  'accion.dr_flit.usar_ia': { operaciones: ['drflit.ia.usar'], predecesores: [] },
  'accion.dr_flit.consultar_gestion': { operaciones: ['drflit.gestion.consultar'], predecesores: [] },
  'accion.dr_flit.radicar_soporte': { operaciones: ['drflit.soporte.radicar'], predecesores: [] },
};

/** Las operaciones que nacen con el ítem (ver `OPERACIONES_NACIDAS_EN_EL_ARBOL`). */
export const OPERACIONES_DR_FLIT: readonly string[] = Object.values(ACCIONES_DR_FLIT).flatMap((a) => a.operaciones);

/** El ítem (nivel 2) que estrena la 0254: no es del mundo plano ni de la 0238/0239. */
export const ITEM_DR_FLIT = 'pagina.flito_dr_flit';

/** El área de esta HU sobre `OPERACIONES_DECLARADAS`, por prefijo del código. */
export const AREA_DR_FLIT = /^drflit\./;
