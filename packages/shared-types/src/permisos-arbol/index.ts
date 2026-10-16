// HU #12873 (Feature #13416, ADR-0025) — El ÁRBOL de permisos: elemento (nivel 1, `menu.*`) → ítem
// (nivel 2, `pagina.*`) → acción (nivel 3, `accion.<item>.<accion>`; la anidada cuelga de su acción
// madre). Aquí vive la ESTRUCTURA y los NOMBRES que lee la web (panel y, desde #13431, el menú). Qué
// operaciones concede cada acción es cosa del API (`apps/api/src/modules/permisos/arbol/`), no de aquí.
//
// Un archivo por área (cada uno ≤800 líneas): `gestion.ts` (#12873), `finanzas.ts` y `administracion.ts`
// (#13427), `general.ts` y `perfil.ts` (#13428, que amplía `administracion.ts` y `gestion.ts`) y `legado.ts`
// (#13429: los ítems antiguos). Desde la #13429 los `menu.*` se siembran en `permisos_funciones` (menos
// «Ayuda», derivada) y el resolutor exige la cadena entera (elemento → ítem → acción).
import type { PageSlug } from '../permissions.js';
import { ELEMENTOS_PERMISOS } from './elementos.js';
import { ARBOL_ADMINISTRACION } from './administracion.js';
import { ARBOL_FINANZAS } from './finanzas.js';
import { ARBOL_CLIENTES_Y_BITACORA, ARBOL_GESTION } from './gestion.js';
import { ARBOL_GENERAL } from './general.js';
import { ARBOL_LEGADO } from './legado.js';
import { ARBOL_PERFIL } from './perfil.js';

/**
 * HU #13429: `operacion` = una operación suelta marcable que no es nodo del menú — opcional de una acción o
 * de un ítem antiguo (`opcional: true`, cuelga de él). HU #13589 (P-35..P-37): ya no hay transversales sin padre.
 */
export type TipoNodoPermiso = 'elemento' | 'item' | 'accion' | 'operacion';

export interface NodoArbolDef {
  codigo: string;
  nombre: string;
  tipo: TipoNodoPermiso;
  /** Código del nodo padre; `null` en los elementos (nivel 1). */
  padre: string | null;
  /** Orden entre hermanos (ascendente). */
  orden: number;
  /** Lo que se le explica al administrador en el panel. */
  descripcion?: string;
  /** Ítems: la página que representan (menú y `hasPage`). */
  slug?: PageSlug;
  /** Ítem antiguo (HU #13429): concede todo lo suyo; sin nivel 3 salvo «Administrar» en PESV (P-24 A1). */
  legado?: boolean;
  /** «Ayuda»: no se marca, se calcula (≥1 capítulo visible). */
  derivado?: boolean;
  /** HU #13429 (contrato del API): profundidad visual 1..4 (la acción anidada y el opcional de acción, 4). */
  nivel?: number;
  /** HU #13429: operación OPCIONAL de su padre (acción o ítem antiguo): ni la expande ni se gana con él. */
  opcional?: boolean;
}

export interface NodoArbolRol extends NodoArbolDef {
  marcado: boolean;
  efectivo: boolean;
  sinAcciones: boolean;
  hijos: NodoArbolRol[];
}

export interface NodoArbolUsuario extends Omit<NodoArbolRol, 'hijos'> {
  heredado: boolean;
  excepcion: 'conceder' | 'revocar' | null;
  hijos: NodoArbolUsuario[];
}

/** HU #13429 — `GET /api/permisos/arbol`: la estructura sin marcas. HU #13589: sin bloque `transversales` (P-35..P-37). */
export interface ArbolPermisosRespuesta { arbol: NodoArbolDef[] }

/** HU #13429 — `GET /api/permisos/roles/:codigo/arbol`. */
export interface ArbolRolRespuesta {
  rol: { codigo: string; nombre: string; tipoEnlace: string };
  arbol: NodoArbolRol[];
}

/** HU #13429 — `GET /api/users/:id/arbol` (guarda del módulo `usuarios`; §5-quater.10, desvío). */
export interface ArbolUsuarioRespuesta { userId: number; rol: string; arbol: NodoArbolUsuario[] }

export const PREFIJO_ACCION = 'accion.';
export const PREFIJO_ELEMENTO = 'menu.';

export { ELEMENTOS_PERMISOS } from './elementos.js';
export { ARBOL_CLIENTES_Y_BITACORA, ARBOL_GESTION, ITEMS_CLIENTES_Y_BITACORA, ITEMS_GESTION } from './gestion.js';
export { ARBOL_FINANZAS, ITEMS_FINANZAS } from './finanzas.js';
export { ARBOL_ADMINISTRACION, ITEMS_ADMINISTRACION } from './administracion.js';
export { ARBOL_GENERAL, ITEMS_GENERAL } from './general.js';
export { ARBOL_PERFIL, ITEMS_PERFIL } from './perfil.js';
export { ARBOL_LEGADO, ITEMS_LEGADO } from './legado.js';

/** Ítems y acciones de todas las áreas (sin los `menu.*`), padres antes que hijos: lo que el API mapea. */
export const ARBOL_ITEMS_Y_ACCIONES: readonly NodoArbolDef[] = [
  ...ARBOL_GESTION, ...ARBOL_CLIENTES_Y_BITACORA, ...ARBOL_FINANZAS, ...ARBOL_ADMINISTRACION, ...ARBOL_GENERAL, ...ARBOL_PERFIL, ...ARBOL_LEGADO,
];

/** El árbol entero, padres antes que hijos. */
export const ARBOL_PERMISOS: readonly NodoArbolDef[] = [...ELEMENTOS_PERMISOS, ...ARBOL_ITEMS_Y_ACCIONES];
