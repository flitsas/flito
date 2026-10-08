import { CATALOGO_AYUDA, type ClaveAyuda, type EntradaAyuda } from '../content/ayuda/catalogo';
// HU #12087: se mira `allowedPages` del sobre `/me` (ya resuelto). NO se importa `hasPage` de
// `lib/permissions`: desde la HU #11913 ese módulo consume `NAV_ITEMS` para `rutaInicio`, y
// `navItems.ts` consume este — importar `hasPage` cerraría el ciclo en tiempo de ejecución.
import { isValidPage } from '@operaciones/shared-types';

/**
 * HU #12872: `tipoPrincipal` (de `/permisos/mios`) es la frontera interno/externo, no el nombre del
 * rol. Ausente = aún no se sabe → se trata como interno solo para fichas cuya página ya tiene.
 */
export type UsuarioAyuda = { allowedPages?: string[] | null; tipoPrincipal?: 'interno' | 'externo' | null };

/**
 * Visibilidad de UNA ficha: la página de su `permiso`. `siigo_credenciales` cuelga de su propio slug;
 * prohibido aliasarla a `siigo_parametrizacion` (Financiera vería credenciales).
 */
export function puedeVerEntradaAyuda(user: UsuarioAyuda | null, entrada: EntradaAyuda): boolean {
  if (!user) return false;
  // FLITO — principal EXTERNO (Feature #11912; HU #12872 lo decide por `tipoPrincipal`, no por el
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
  if (user.tipoPrincipal === 'externo') return false;
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

/** Enlaces internos a otra ficha: solo si el usuario puede ver ese capítulo. */
export function puedeEnlazarFichaAyuda(user: UsuarioAyuda | null, href: string): boolean {
  const match = /^\/flito\/ayuda\/([^/?#]+)$/.exec(href);
  if (!match) return true;
  const entrada = entradaAyudaPorClave(match[1]);
  if (!entrada) return false;
  return puedeVerEntradaAyuda(user, entrada);
}
