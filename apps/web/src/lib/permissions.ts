// Catálogo de páginas, roles y permisos: FUENTE ÚNICA en @operaciones/shared-types
// (compartida con el backend). Este módulo solo re-exporta + añade los helpers
// `effectivePages`/`hasPage` (forma Set, conveniente para la UI) sobre el
// `getEffectivePages` compartido. NO redefinir catálogos aquí.
import { getEffectivePages, type PageSlug } from '@operaciones/shared-types';

export {
  PAGES,
  PAGE_GROUPS,
  ROLE_DEFAULT_PAGES,
  ROLE_LABELS,
  USER_ROLES,
  ALL_ROLES,
  getEffectivePages,
  isValidPage,
} from '@operaciones/shared-types';
export type { PageSlug, UserRole } from '@operaciones/shared-types';

export function effectivePages(user: { role: string; allowedPages?: string[] | null } | null): Set<PageSlug> {
  if (!user) return new Set();
  // role llega como string desde el JWT/me; getEffectivePages valida internamente.
  return new Set(getEffectivePages(user as { role: import('@operaciones/shared-types').UserRole; allowedPages?: string[] | null }));
}

export function hasPage(user: { role: string; allowedPages?: string[] | null } | null, page: PageSlug): boolean {
  return effectivePages(user).has(page);
}

// FLITO: `operaciones` es funcionalmente el mismo perfil que `admin` (superusuario del dominio).
// Ambos operan/mutan; los gestores y auditoría son roles acotados aparte.
export function puedeOperar(role: string | undefined): boolean {
  // El operador FLITO ES el admin (despliegue FLITO-only; el rol `operaciones` se fusionó en `admin`).
  return role === 'admin';
}
