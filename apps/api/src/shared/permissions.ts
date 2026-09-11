import { type PageSlug } from '@operaciones/shared-types';
import { exigirFuncion } from './middleware/exigir-funcion.js';

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
 *
 * HU #12082 (AC7, RN-A4): es `exigirFuncion('pagina.<slug>')` y nada más. Decide contra el conjunto
 * efectivo de la base —no contra el token— y el admin ve todo porque el seed de la 0179 le marcó las
 * 43 `pagina.*`, no porque haya una rama `role === 'admin'`. El 403 tiene el cuerpo unificado de
 * `exigirFuncion`: `{ error, funcion: 'pagina.<slug>', motivo }`.
 */
export function requirePage(slug: PageSlug) {
  return exigirFuncion(`pagina.${slug}`);
}
