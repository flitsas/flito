// Torre de Control Gerencial (Épica #14590) — Qué OPERACIONES concede cada acción de la Torre. Mismo contrato que
// `acciones-dr-flit.ts`: la ruta exige la operación (`torre.*`, con `exigirFuncion` por ruta en
// `flito-torre/flito-torre.routes.ts` y `flito-torre/flito-torre.tableros.routes.ts`); la tiene quien tenga la
// acción efectiva que la contiene.
//
// Las operaciones NACEN en el árbol (como las de Dr. Flit): no parten ninguna guarda vieja, no se siembran
// (sembrarlas haría fallar `verificarCatalogoAlArrancar`) y las acciones las siembra la 0303 con su ítem.
// `predecesores: []`: nadie las tenía. El reparto a roles distintos de `admin` es `REPARTO_TORRE` (abajo), que
// `catalogo.ts` aplica como reparto posterior al árbol y la 0303 siembra literal.
import type { AccionArbol } from './acciones-gestion.js';

export const ACCIONES_TORRE: Readonly<Record<string, AccionArbol>> = {
  'accion.torre_360.ver': { lectura: true, operaciones: ['torre.tablero_ejecutivo.ver'], predecesores: [] },
  'accion.torre_comercial.ver': { lectura: true, operaciones: ['torre.tablero_comercial.ver'], predecesores: [] },
  'accion.torre_operativa.ver': { lectura: true, operaciones: ['torre.tablero_operativo.ver'], predecesores: [] },
  'accion.torre_financiera.ver': { lectura: true, operaciones: ['torre.tablero_financiero.ver'], predecesores: [] },
  'accion.torre_explorador.consultar': { lectura: true, operaciones: ['torre.metricas.consultar'], predecesores: [] },
  // Exportar NO es lectura (AC7 de los soportes en ZIP: la auditoría no descarga).
  'accion.torre_explorador.exportar': { operaciones: ['torre.metricas.exportar'], predecesores: [] },
  'accion.torre_explorador.buscar_placa': { lectura: true, operaciones: ['torre.placa.buscar'], predecesores: [] },
  // Decisión del humano: quién ve el dinero lo decide el permiso del rol. Sin guarda de ruta: el motor de métricas
  // la pide en línea (`tieneFuncion`) cuando la métrica es `requiereDinero` (403 si falta), como `drflit.manuales.ver`.
  'accion.torre_explorador.ver_dinero': { lectura: true, operaciones: ['torre.metricas.dinero'], predecesores: [] },
  'accion.torre_umbrales.ver': { lectura: true, operaciones: ['torre.umbrales.ver'], predecesores: [] },
  'accion.torre_umbrales.editar': { operaciones: ['torre.umbrales.editar'], predecesores: [] },
  // Detalle universal (ADR-0047, B1): ver los registros detrás de una cifra. Exportar NO es lectura (el auditor no
  // descarga). Las siembra la migración del detalle (no la 0303, que ya está aplicada).
  'accion.torre_detalle.ver': { lectura: true, operaciones: ['torre.detalle.ver'], predecesores: [] },
  'accion.torre_detalle.exportar': { operaciones: ['torre.detalle.exportar'], predecesores: [] },
  // Productos (B3): el área SOAT · Impuestos · Derechos. La siembra su propia migración (0307), con el umbral nuevo.
  'accion.torre_productos.ver': { lectura: true, operaciones: ['torre.tablero_productos.ver'], predecesores: [] },
};

/** Las operaciones que nacen con los ítems (ver `OPERACIONES_NACIDAS_EN_EL_ARBOL`). */
export const OPERACIONES_TORRE: readonly string[] = Object.values(ACCIONES_TORRE).flatMap((x) => x.operaciones);

/** Los ítems (nivel 2) que estrena la 0303, en el orden del árbol. */
export const ITEMS_TORRE_ARBOL: readonly string[] = [
  'pagina.torre_360', 'pagina.torre_comercial', 'pagina.torre_operativa', 'pagina.torre_financiera',
  'pagina.torre_explorador', 'pagina.torre_umbrales', 'pagina.torre_detalle', 'pagina.torre_productos',
];

const TABLEROS = ['torre_360', 'torre_comercial', 'torre_operativa', 'torre_financiera'] as const;
const conCadena = (items: readonly string[], acciones: readonly string[], elementos: readonly string[]): string[] =>
  [...elementos, ...items.map((i) => `pagina.${i}`), ...acciones];

/**
 * Reparto de la 0303 a los roles distintos de `admin` (que recibe todo por ADR-0022). Cada lista lleva la cadena
 * entera (elemento → ítem → acción), porque el resolutor la exige. NADIE salvo `admin` recibe
 * `accion.torre_umbrales.editar` (lo vigila `flito-torre-permisos.test.ts`).
 *   · Las métricas de dinero (`accion.torre_explorador.ver_dinero`) las tienen los cinco roles (decisión del humano).
 *   · `auditor` NO exporta: la auditoría no descarga (mismo criterio que `lectura` arriba); tampoco el detalle.
 *   · El detalle (`torre_detalle`, ADR-0047) lo siembra su propia migración, no la 0303.
 *   · `financiera`: su tablero, el Explorador completo.
 *   · `gerencia_comercial`: su tablero, el Explorador completo.
 *   · `gerencia_general`: los cuatro tableros, el Explorador completo y ver los umbrales.
 *   · Productos (B3): los mismos roles que ven `torre_operativa` (`auditor` y `gerencia_general`); lo siembra la 0307.
 */
const DETALLE_COMPLETO = ['accion.torre_detalle.ver', 'accion.torre_detalle.exportar'];
const EXPLORADOR_COMPLETO = [
  'accion.torre_explorador.consultar', 'accion.torre_explorador.exportar', 'accion.torre_explorador.buscar_placa',
  'accion.torre_explorador.ver_dinero',
];
export const REPARTO_TORRE: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['financiera', conCadena(['torre_financiera', 'torre_explorador', 'torre_detalle'],
    ['accion.torre_financiera.ver', ...EXPLORADOR_COMPLETO, ...DETALLE_COMPLETO], ['menu.general'])],
  ['auditor', conCadena([...TABLEROS, 'torre_explorador', 'torre_umbrales', 'torre_detalle'],
    [...TABLEROS.map((t) => `accion.${t}.ver`), 'accion.torre_explorador.consultar', 'accion.torre_explorador.buscar_placa',
      'accion.torre_explorador.ver_dinero', 'accion.torre_umbrales.ver', 'accion.torre_detalle.ver'], ['menu.general', 'menu.administracion'])],
  ['auditor', conCadena(['torre_productos'], ['accion.torre_productos.ver'], [])],
  ['gerencia_comercial', conCadena(['torre_comercial', 'torre_explorador', 'torre_detalle'],
    ['accion.torre_comercial.ver', ...EXPLORADOR_COMPLETO, ...DETALLE_COMPLETO], ['menu.general'])],
  ['gerencia_general', conCadena([...TABLEROS, 'torre_explorador', 'torre_umbrales', 'torre_detalle'],
    [...TABLEROS.map((t) => `accion.${t}.ver`), ...EXPLORADOR_COMPLETO, 'accion.torre_umbrales.ver', ...DETALLE_COMPLETO],
    ['menu.general', 'menu.administracion'])],
  ['gerencia_general', conCadena(['torre_productos'], ['accion.torre_productos.ver'], [])],
];

/** El área sobre `OPERACIONES_DECLARADAS`, por prefijo del código. */
export const AREA_TORRE = /^torre\./;
