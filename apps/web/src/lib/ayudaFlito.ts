import { CATALOGO_AYUDA, GRUPOS_ORDEN, type ClaveAyuda, type EntradaAyuda } from '../content/ayuda/catalogo';
// HU #12087: se mira `allowedPages` del sobre `/me` (ya resuelto). NO se importa `hasPage` de
// `lib/permissions`: desde la HU #11913 ese módulo consume `NAV_ITEMS` para `rutaInicio`, y
// `navItems.ts` consume este — importar `hasPage` cerraría el ciclo en tiempo de ejecución.
import { isValidPage, type TipoEnlace } from '@operaciones/shared-types';

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
  // FLITO — usuario CON ENLACE (Feature #11912; HU #12875 lo decide por `tipoEnlace`, no por el
  // nombre del rol): ninguna ficha. Va aquí y no en el catálogo porque la
  // visibilidad de «Ayuda FLITO» es DERIVADA (`puedeVerAyudaFlito` = ≥1 ficha visible): apagarla
  // aquí retira de una vez el ítem del menú, la entrada de la ⌘K y el gate de `/flito/ayuda`, que
  // es lo que hace literalmente verdadera la frase del AC1 «su menú muestra únicamente SOAT».
  //
  // Sin esta línea el Cliente vería DOS ítems: la ficha `soat` cuelga de `permiso: 'flito_soat'`
  // (ADR-0008 §4) y él tiene ese slug. Mismo caso especial por rol que `siigo_credenciales`, justo
  // debajo (hoy ya por slug). El ADR daba por buena esa segunda entrada («consecuencia buscada»); el AC1 y el doc de
  // UX §3.2 no, y manda el AC. Revertirlo el día que el Cliente merezca ficha propia —la #11914—
  // es borrar esta línea.
  if (user.tipoEnlace != null && user.tipoEnlace !== 'ninguno') return false;
  if (!entrada.permiso) return false;
  return (user.allowedPages ?? []).filter(isValidPage).includes(entrada.permiso);
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
