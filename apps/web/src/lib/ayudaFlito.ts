import { CATALOGO_AYUDA, type ClaveAyuda, type EntradaAyuda } from '../content/ayuda/catalogo';
import { hasPage, type UserRole } from './permissions';

export type UsuarioAyuda = { role: UserRole; allowedPages?: string[] | null };

/**
 * Visibilidad de UNA ficha. `siigo_credenciales` no es PageSlug en este worktree: solo `admin`.
 * Prohibido aliasarla a `siigo_parametrizacion` (Financiera vería credenciales).
 */
export function puedeVerEntradaAyuda(user: UsuarioAyuda | null, entrada: EntradaAyuda): boolean {
  if (!user) return false;
  if (entrada.clave === 'siigo_credenciales') return user.role === 'admin';
  if (!entrada.permiso) return false;
  return hasPage(user, entrada.permiso);
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
