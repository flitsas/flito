// Catálogo de páginas, roles y permisos: FUENTE ÚNICA en @operaciones/shared-types
// (compartida con el backend). Este módulo solo re-exporta + añade los helpers
// `effectivePages`/`hasPage` (forma Set, conveniente para la UI) sobre el
// `getEffectivePages` compartido. NO redefinir catálogos aquí.
import { getEffectivePages, type PageSlug, type UserRole } from '@operaciones/shared-types';
// `rutaInicio` (abajo) deriva el destino del catálogo de navegación. El import es de VALOR y va en
// este sentido; el que `navItems.ts` hace de este módulo es `import type` y se borra al compilar,
// así que no hay ciclo en ejecución. Ver la nota de `lib/ayudaFlito.ts`.
import { NAV_ITEMS, navItemPermitido } from '../components/shell/navItems';

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

/** Lo mínimo que hay que saber de un usuario para resolver sus permisos. */
export type UsuarioPermisos = { role: string; allowedPages?: string[] | null };

export function effectivePages(user: UsuarioPermisos | null): Set<PageSlug> {
  if (!user) return new Set();
  // role llega como string desde el JWT/me; getEffectivePages valida internamente.
  return new Set(getEffectivePages(user as { role: import('@operaciones/shared-types').UserRole; allowedPages?: string[] | null }));
}

export function hasPage(user: UsuarioPermisos | null, page: PageSlug): boolean {
  return effectivePages(user).has(page);
}

// FLITO: `operaciones` es funcionalmente el mismo perfil que `admin` (superusuario del dominio).
// Ambos operan/mutan; los gestores y auditoría son roles acotados aparte.
export function puedeOperar(role: string | undefined): boolean {
  // El operador FLITO ES el admin (despliegue FLITO-only; el rol `operaciones` se fusionó en `admin`).
  return role === 'admin';
}

// ────────────────────────── Dónde empieza un usuario (HU #11913) ────────────────────────────────

/**
 * La página de inicio del usuario y cómo se llama.
 *
 * Existe por un fallo concreto, encontrado al medir el rol `cliente` (Feature #11912) y que afecta
 * a CUALQUIER rol sin `dashboard`: al entrar, el usuario cae en `/` → `ProtectedRoute
 * page="dashboard"` → `NoAccess`, cuyo único botón es un `<Link to="/">` que dice «Volver al
 * tablero» — es decir, vuelve al mismo `NoAccess`. Bucle. Y el comodín `<Route path="*">` mete ahí
 * cualquier URL desconocida. Hasta hoy no lo vio nadie porque los 11 roles anteriores tienen
 * `dashboard`.
 *
 * Lo consumen la ruta `/` (`InicioGate`) **y** `NoAccess`. Los dos, no uno: con solo el primero, el
 * botón sigue devolviendo al bucle desde cualquier otra página negada; con solo el segundo, el
 * aterrizaje tras el login sigue siendo un error.
 *
 * Devuelve también la ETIQUETA porque el botón de `NoAccess` tiene que nombrar el destino («Ir a
 * SOAT»). Se toma la del ítem de navegación y no `PAGES[slug]`, que diría «Ir a FLITO — SOAT»: el
 * usuario reconoce la palabra de su menú, no la del catálogo de permisos.
 *
 * Se deriva de `NAV_ITEMS` en vez de escribir un mapa rol → ruta: un mapa habría que acordarse de
 * ampliarlo con cada rol nuevo, y el día que nadie se acuerde el bucle vuelve en silencio.
 */
export interface DestinoInicio { to: string; etiqueta: string }

export function rutaInicio(user: UsuarioPermisos | null): DestinoInicio {
  const TABLERO: DestinoInicio = { to: '/', etiqueta: 'Tablero' };
  if (!user || hasPage(user, 'dashboard')) return TABLERO;

  const permitidas = effectivePages(user);
  const destino = NAV_ITEMS.find((it) =>
    // «Ayuda FLITO» nunca es el sitio donde se trabaja: es documentación, y su visibilidad además
    // es derivada. Aterrizar ahí sería mandar a alguien a leer sobre pantallas que no tiene.
    it.page !== 'flito_ayuda'
    && navItemPermitido(it, user as { role: UserRole; allowedPages?: string[] | null }, permitidas),
  );
  // Sin ninguna entrada permitida no hay a dónde ir: se devuelve `/` a propósito para que el
  // `InicioGate` acabe en el `NoAccess` de siempre en vez de en un `Navigate` sobre sí mismo.
  return destino ? { to: destino.to, etiqueta: destino.label } : TABLERO;
}
