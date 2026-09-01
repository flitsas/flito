import { CATALOGO_AYUDA, type ClaveAyuda, type EntradaAyuda } from '../content/ayuda/catalogo';
// `getEffectivePages` se toma de la fuente única y NO el `hasPage` de `lib/permissions`, aunque sea
// el mismo cálculo: desde la HU #11913 `permissions.ts` consume `NAV_ITEMS` para `rutaInicio`, y
// `navItems.ts` consume este módulo. Importar `hasPage` cerraría el ciclo
// permissions → navItems → ayudaFlito → permissions en tiempo de EJECUCIÓN (el import que
// `navItems.ts` hace de `permissions.ts` es `import type`, y se borra al compilar).
import { getEffectivePages, type UserRole } from '@operaciones/shared-types';

export type UsuarioAyuda = { role: UserRole; allowedPages?: string[] | null };

/**
 * Visibilidad de UNA ficha. `siigo_credenciales` no es PageSlug en este worktree: solo `admin`.
 * Prohibido aliasarla a `siigo_parametrizacion` (Financiera vería credenciales).
 */
export function puedeVerEntradaAyuda(user: UsuarioAyuda | null, entrada: EntradaAyuda): boolean {
  if (!user) return false;
  // FLITO — Cliente (Feature #11912): ninguna ficha. Va aquí y no en el catálogo porque la
  // visibilidad de «Ayuda FLITO» es DERIVADA (`puedeVerAyudaFlito` = ≥1 ficha visible): apagarla
  // aquí retira de una vez el ítem del menú, la entrada de la ⌘K y el gate de `/flito/ayuda`, que
  // es lo que hace literalmente verdadera la frase del AC1 «su menú muestra únicamente SOAT».
  //
  // Sin esta línea el Cliente vería DOS ítems: la ficha `soat` cuelga de `permiso: 'flito_soat'`
  // (ADR-0008 §4) y él tiene ese slug. Mismo caso especial por rol que `siigo_credenciales`, justo
  // debajo. El ADR daba por buena esa segunda entrada («consecuencia buscada»); el AC1 y el doc de
  // UX §3.2 no, y manda el AC. Revertirlo el día que el Cliente merezca ficha propia —la #11914—
  // es borrar esta línea.
  if (user.role === 'cliente') return false;
  if (entrada.clave === 'siigo_credenciales') return user.role === 'admin';
  if (!entrada.permiso) return false;
  return getEffectivePages(user).includes(entrada.permiso);
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
