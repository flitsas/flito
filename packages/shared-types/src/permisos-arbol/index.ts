// HU #12873 (Feature #13416, ADR-0025) — El ÁRBOL de permisos: elemento (nivel 1, `menu.*`) → ítem
// (nivel 2, `pagina.*`) → acción (nivel 3, `accion.<item>.<accion>`; la anidada cuelga de su acción
// madre). Aquí vive la ESTRUCTURA y los NOMBRES que lee la web (panel y, desde #13431, el menú). Qué
// operaciones concede cada acción es cosa del API (`apps/api/src/modules/permisos/arbol/`), no de aquí.
//
// Un archivo por área (cada uno ≤800 líneas): `gestion.ts` (#12873), `finanzas.ts` y `administracion.ts` (#13427); Administración,
// General, Perfil y legado los añaden #13427/#13428/#13429. Los `menu.*` se declaran ya (los ítems los
// necesitan como padre) pero NO se siembran en `permisos_funciones` hasta la #13429.
import type { PageSlug } from '../permissions.js';
import { ELEMENTOS_PERMISOS } from './elementos.js';
import { ARBOL_ADMINISTRACION } from './administracion.js';
import { ARBOL_FINANZAS } from './finanzas.js';
import { ARBOL_GESTION } from './gestion.js';

export type TipoNodoPermiso = 'elemento' | 'item' | 'accion';

export interface NodoArbolDef {
  codigo: string;
  nombre: string;
  tipo: TipoNodoPermiso;
  /** Código del nodo padre; `null` solo en los elementos (nivel 1). */
  padre: string | null;
  /** Orden entre hermanos (ascendente). */
  orden: number;
  /** Lo que se le explica al administrador en el panel. */
  descripcion?: string;
  /** Ítems: la página que representan (menú y `hasPage`). */
  slug?: PageSlug;
  /** Ítem sin nivel 3 («ve y hace todo», legacy). */
  legado?: boolean;
  /** «Ayuda»: no se marca, se calcula (≥1 capítulo visible). */
  derivado?: boolean;
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

export const PREFIJO_ACCION = 'accion.';
export const PREFIJO_ELEMENTO = 'menu.';

export { ELEMENTOS_PERMISOS } from './elementos.js';
export { ARBOL_GESTION, ITEMS_GESTION } from './gestion.js';
export { ARBOL_FINANZAS, ITEMS_FINANZAS } from './finanzas.js';
export { ARBOL_ADMINISTRACION, ITEMS_ADMINISTRACION } from './administracion.js';

/** El árbol entero, padres antes que hijos. */
export const ARBOL_PERMISOS: readonly NodoArbolDef[] = [...ELEMENTOS_PERMISOS, ...ARBOL_GESTION, ...ARBOL_FINANZAS, ...ARBOL_ADMINISTRACION];

/** Solo ítems y acciones (sin los `menu.*`, que no se siembran hasta la #13429): lo que conoce el API. */
export const ARBOL_ITEMS_Y_ACCIONES: readonly NodoArbolDef[] = [...ARBOL_GESTION, ...ARBOL_FINANZAS, ...ARBOL_ADMINISTRACION];
