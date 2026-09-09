import type { Request, Response, NextFunction } from 'express';
import { PAGES, getEffectivePages, type PageSlug } from '@operaciones/shared-types';

// Catálogo de páginas, grupos, defaults por rol y helpers: fuente única en
// @operaciones/shared-types. Aquí solo se re-exportan (compatibilidad con los
// importadores existentes de '../../shared/permissions.js') y se define
// `requirePage`, que depende de Express y por eso no vive en el paquete compartido.
export {
  PAGES,
  PAGE_GROUPS,
  ROLE_DEFAULT_PAGES,
  PESV_ADMIN_ROLES,
  FLEET_OPS_ROLES,
  getEffectivePages,
  // HU #12169: la lectura de los defaults de UN rol, que ya no se puede indexar a mano porque el rol
  // puede ser uno que creó el administrador y no tiene fila.
  paginasPorDefecto,
  isValidPage,
} from '@operaciones/shared-types';
export type { PageSlug } from '@operaciones/shared-types';

/**
 * Middleware: requiere que el usuario tenga acceso a una página específica.
 * Se aplica DESPUÉS de authMiddleware. Se puede combinar con requireRole para defensa en profundidad.
 */
export function requirePage(slug: PageSlug) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) { res.status(401).json({ error: 'Token requerido' }); return; }
    const pages = getEffectivePages(req.user);
    if (!pages.includes(slug)) {
      res.status(403).json({ error: `Sin permiso para acceder a "${PAGES[slug]}"` });
      return;
    }
    next();
  };
}
