import { CATALOGO_AYUDA, GRUPOS_ORDEN, type ClaveAyuda, type EntradaAyuda } from '../content/ayuda/catalogo';
// HU #12087: se mira `allowedPages` del sobre `/me` (ya resuelto). NO se importa `hasPage` de
// `lib/permissions`: desde la HU #11913 ese módulo consume `NAV_ITEMS` para `rutaInicio`, y
// `navItems.ts` consume este — importar `hasPage` cerraría el ciclo en tiempo de ejecución.
import {
  isValidPage, paginaAbiertaAlEnlace, paginasPorDefecto, ROLE_DEFAULT_PAGES, USER_ROLES, type PageSlug, type TipoEnlace, type UserRole,
} from '@operaciones/shared-types';

/**
 * HU #12875: `tipoEnlace` (de `/permisos/mios`) es la frontera, no el nombre del rol. Ausente = aún no
 * se sabe → se trata como sin enlace solo para fichas cuya página ya tiene.
 */
export type UsuarioAyuda = { allowedPages?: string[] | null; tipoEnlace?: TipoEnlace | null };

/**
 * Visibilidad de UNA ficha: la página de su `permiso`. `siigo_credenciales` cuelga de su propio slug;
 * prohibido aliasarla a `siigo_parametrizacion` (Financiera vería credenciales).
 */
export function puedeVerEntradaAyuda(user: UsuarioAyuda | null, entrada: EntradaAyuda): boolean {
  if (!user) return false;
  if (!entrada.permiso) return false;
  // HU #13914: el usuario con enlace ve la ficha de cada pantalla que puede abrir, con la misma regla
  // que `effectivePages` (lib/permissions): página en `allowedPages` Y abierta a su enlace (frontera
  // de la HU #13452). Sin la frontera, el Proveedor vería «Tablero de control» (tiene `dashboard` por
  // defecto y su enlace se lo cierra). No se usa `hasPage`: cerraría el ciclo de la cabecera.
  return (user.allowedPages ?? []).filter(isValidPage).includes(entrada.permiso)
    && paginaAbiertaAlEnlace(entrada.permiso, user.tipoEnlace);
}

/** Menú, paleta, índice y gate de `/flito/ayuda`: ≥1 ficha del catálogo visible. */
export function puedeVerAyudaFlito(user: UsuarioAyuda | null): boolean {
  if (!user) return false;
  return CATALOGO_AYUDA.some((entrada) => puedeVerEntradaAyuda(user, entrada));
}

export function capitulosVisibles(user: UsuarioAyuda | null): EntradaAyuda[] {
  if (!user) return [];
  return CATALOGO_AYUDA.filter((entrada) => puedeVerEntradaAyuda(user, entrada));
}

export function entradaAyudaPorClave(clave: string): EntradaAyuda | undefined {
  return CATALOGO_AYUDA.find((entrada) => entrada.clave === clave);
}

export function esClaveAyuda(clave: string): clave is ClaveAyuda {
  return CATALOGO_AYUDA.some((entrada) => entrada.clave === clave);
}

/** Fichas visibles en el orden del índice sin búsqueda: grupo (orden del menú) y, dentro, el del catálogo. */
export function capitulosEnOrdenDeIndice(user: UsuarioAyuda | null): EntradaAyuda[] {
  const visibles = capitulosVisibles(user);
  return GRUPOS_ORDEN.flatMap((g) => visibles.filter((c) => c.grupo === g));
}

/**
 * Anterior/Siguiente de la ficha (HU #13705 AC5, diseño slim §7). Puro: recibe la lista ya filtrada
 * por permiso y ordenada como el índice, así que las no visibles se saltan por construcción. Una
 * clave que no está en la lista no tiene vecinas.
 */
export function vecinasVisibles(
  visibles: readonly EntradaAyuda[],
  clave: string,
): { anterior?: EntradaAyuda; siguiente?: EntradaAyuda } {
  const i = visibles.findIndex((e) => e.clave === clave);
  if (i < 0) return {};
  return {
    anterior: i > 0 ? visibles[i - 1] : undefined,
    siguiente: i < visibles.length - 1 ? visibles[i + 1] : undefined,
  };
}

/**
 * ¿El rol tiene TODAS las páginas? Es el que no tiene fila en `ROLE_DEFAULT_PAGES` (`admin`: su tabla
 * es total sobre los demás roles y sus páginas las siembra la migración 0179 en
 * `permisos_rol_funcion`; ver el comentario de `ROLE_DEFAULT_PAGES` en `permissions.ts`). Se deriva de
 * la matriz, no del nombre del rol.
 */
const sinFilaPorDefecto = (rol: UserRole): boolean => !(rol in ROLE_DEFAULT_PAGES);

/**
 * «Aplica para» (HU #13706 AC3, diseño slim §5, P9-2c): roles de `USER_ROLES`, EN SU ORDEN, que tienen
 * `slug` por defecto o que no tienen fila en `ROLE_DEFAULT_PAGES` (todas las páginas). Desde la HU #13914
 * incluye los roles de enlace (cliente, proveedor), que ya ven las fichas de lo que abren. Sale de los
 * permisos por defecto SIN aplicar la frontera del enlace (no hay espejo rol→enlace en shared-types), así
 * que puede listar un rol de enlace en una ficha que su enlace cierra (p. ej. Proveedor en «Tablero de
 * control»): texto informativo, aceptado en la HU #13914; NO decide acceso. «Administrador primero» sale de ahí sin literal: `admin` es `USER_ROLES[0]` y es el único rol
 * sin fila. `operaciones` no puede salir: no está en `USER_ROLES`. Puro: sin red ni estado.
 */
export function rolesPorDefectoDePagina(slug: PageSlug): UserRole[] {
  return USER_ROLES.filter(
    (rol) => sinFilaPorDefecto(rol) || paginasPorDefecto(rol).includes(slug),
  );
}

const RAIZ_AYUDA = '/flito/ayuda';
const FICHA_AYUDA = /^\/flito\/ayuda\/([^/?#]+)(?:[?#].*)?$/;

/**
 * Enlaces internos a la Ayuda dentro de una ficha (HU #13705 AC4, diseño slim §4). Falla cerrada para
 * todo lo que empiece por `/flito/ayuda`:
 * 1) fuera de la Ayuda → true (los esquemas ya los filtró `hrefPermitido`);
 * 2) el índice, con o sin `?…`/`#…` → `puedeVerAyudaFlito`;
 * 3) una ficha, con o sin `?…`/`#…` → esa ficha existe y el usuario la ve;
 * 4) cualquier otra forma (segmentos extra, `/flito/ayudaX`) → false.
 */
export function puedeEnlazarFichaAyuda(user: UsuarioAyuda | null, href: string): boolean {
  if (!href.startsWith(RAIZ_AYUDA)) return true;
  const resto = href.slice(RAIZ_AYUDA.length);
  if (resto === '' || resto[0] === '?' || resto[0] === '#' || /^\/(?:[?#].*)?$/.test(resto)) {
    return puedeVerAyudaFlito(user);
  }
  const match = FICHA_AYUDA.exec(href);
  if (!match) return false;
  const entrada = entradaAyudaPorClave(match[1]);
  if (!entrada) return false;
  return puedeVerEntradaAyuda(user, entrada);
}
