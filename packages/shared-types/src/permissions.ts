// FUENTE ÚNICA de roles, catálogo de páginas y permisos por defecto.
// Consumido por API (apps/api/src/shared/permissions.ts) y web
// (apps/web/src/lib/permissions.ts). NO duplicar estas tablas en ningún otro lado:
// el test de paridad (permissions.authz.test.ts) falla si vuelven a divergir.
//
// Módulo PURO (sin zod ni side-effects) para que el web pueda importar el catálogo
// sin arrastrar zod al bundle. La validación de `role` en endpoints usa z.enum(ALL_ROLES).

// ============================================================================
// Roles del sistema
// ============================================================================
// Tupla canónica. UserRole y ALL_ROLES se derivan de aquí para que no puedan
// desincronizarse (antes vivían en 3 sitios con conteos distintos: 8/7/4).
export const USER_ROLES = [
  'admin',
  'proveedor',
  'transito',
  'compliance',
  'lider_pesv',
  'supervisor_flota',
  'conductor',
  'auditor',
  // FLITO (migración packages/ → Operaciones): gestor de impuestos (atado a un organismo).
  // El operador FLITO ES el admin (despliegue FLITO-only); gestor SOAT reutiliza `proveedor`;
  // auditoría reutiliza `auditor`. El antiguo rol `operaciones` se fusionó en `admin`.
  'gestor_impuestos',
  // FLITO Logística: mensajero de campo. Usa la PWA y solo ve su ruta asignada (CA-11).
  // Las tareas de Coordinador (armar/despachar actas, asignar rutas) las asume `admin`.
  'mensajero',
] as const;

export type UserRole = (typeof USER_ROLES)[number];

// Roles asignables al crear/editar un usuario. Hoy = todos los roles del sistema
// (incluye `auditor`, que antes faltaba y volvía el rol inasignable por el producto).
export const ALL_ROLES = USER_ROLES;

// Etiqueta legible en español por rol. Capa de presentación; única fuente para la UI.
export const ROLE_LABELS: Record<UserRole, string> = {
  admin: 'Administrador',
  compliance: 'Cumplimiento (LAFT)',
  transito: 'Tránsito',
  proveedor: 'Proveedor',
  lider_pesv: 'Líder PESV',
  supervisor_flota: 'Supervisor de flota',
  conductor: 'Conductor',
  auditor: 'Auditor (revisor fiscal)',
  gestor_impuestos: 'Gestor de Impuestos',
  mensajero: 'Mensajero',
};

// ============================================================================
// Catálogo de páginas (slug → label visible)
// ============================================================================
export const PAGES = {
  dashboard: 'Tablero de control',
  vehicles: 'Vehículos',
  clients: 'Clientes',
  soat: 'SOAT',
  tramite: 'Trámite Digital',
  tax_reader: 'Lectura de Impuestos',
  drive: 'Google Drive',
  users: 'Usuarios',
  laft: 'Cumplimiento LAFT',
  laft_unusual: 'Operaciones inusuales',
  laft_trainings: 'Capacitaciones',
  laft_manual: 'LAFT — Manual SARLAFT',
  laft_oficial: 'LAFT — Oficial cumplimiento',
  laft_audit_plan: 'LAFT — Plan de auditorías',
  laft_dashboard: 'LAFT — Tablero',
  transito: 'Tránsito',
  transito_organismos: 'Organismos de tránsito',
  privacy: 'Privacidad y datos',
  fleet: 'Flota',
  maintenance: 'Mantenimiento',
  pesv: 'PESV — Conductores',
  rndc: 'RNDC y manifiestos',
  rndc_admin: 'Catálogos RNDC',
  pesv_raci: 'PESV — Matriz RACI',
  pesv_normativa: 'PESV — Tracker normativo',
  pesv_retencion: 'PESV — Retención documental',
  // FLITO (migración packages/ → Operaciones). El slug `soat` de arriba se REUTILIZA
  // para el portal SOAT de FLITO (reemplaza el módulo SOAT legacy). El resto son nuevos.
  flito_tramites: 'FLITO — Trámites',
  flito_impuestos: 'FLITO — Impuestos',
  flito_revisiones: 'FLITO — Revisión OCR',
  flito_compuerta: 'FLITO — Compuerta de entrega',
  flito_parametrizacion: 'FLITO — Parametrización',
  flito_tablero: 'FLITO — Tablero',
  flito_bitacora: 'FLITO — Bitácora',
  // FLITO Logística: consola de Operaciones (trazabilidad por documento, actas, despacho).
  // La página de ruta del mensajero (PWA) se añade en la Fase 2.
  flito_logistica: 'FLITO — Logística',
} as const satisfies Record<string, string>;

export type PageSlug = keyof typeof PAGES;

export const PAGE_GROUPS: { label: string; pages: PageSlug[] }[] = [
  { label: 'General', pages: ['dashboard'] },
  { label: 'Operaciones', pages: ['vehicles', 'clients', 'soat', 'tramite', 'tax_reader', 'transito', 'drive'] },
  { label: 'Flota', pages: ['fleet'] },
  { label: 'Mantenimiento', pages: ['maintenance'] },
  { label: 'PESV', pages: ['pesv', 'pesv_raci', 'pesv_normativa', 'pesv_retencion'] },
  { label: 'RNDC', pages: ['rndc', 'rndc_admin'] },
  { label: 'Cumplimiento LAFT', pages: ['laft', 'laft_unusual', 'laft_trainings', 'laft_manual', 'laft_oficial', 'laft_audit_plan', 'laft_dashboard'] },
  { label: 'Tránsito', pages: ['transito', 'transito_organismos'] },
  { label: 'FLITO (SOAT e Impuestos)', pages: ['flito_tramites', 'soat', 'flito_impuestos', 'flito_revisiones', 'flito_compuerta', 'flito_parametrizacion', 'flito_tablero', 'flito_bitacora', 'flito_logistica'] },
  { label: 'Administración', pages: ['users', 'privacy'] },
];

// ============================================================================
// Permisos por defecto por rol — base que se UNE con allowedPages del usuario.
// Admin tiene acceso a TODO independiente del campo allowed_pages.
// ============================================================================
export const ROLE_DEFAULT_PAGES: Record<UserRole, readonly PageSlug[]> = {
  admin: Object.keys(PAGES) as PageSlug[],
  compliance: ['dashboard', 'laft', 'laft_unusual', 'laft_trainings', 'laft_manual', 'laft_oficial', 'laft_audit_plan', 'laft_dashboard', 'privacy', 'pesv', 'pesv_raci', 'pesv_normativa', 'pesv_retencion'],
  // Líder PESV: gestión completa del PESV pero NO acceso a SOAT/RNDC/LAFT.
  lider_pesv: ['dashboard', 'pesv', 'fleet', 'maintenance', 'pesv_raci', 'pesv_normativa', 'pesv_retencion'],
  // Supervisor de flota: ve flota+PESV+mantenimiento, opera incidentes/checklists.
  supervisor_flota: ['dashboard', 'pesv', 'fleet', 'maintenance', 'vehicles'],
  // Conductor: ve solo su jornada propia + reporta incidentes desde móvil.
  conductor: ['dashboard', 'pesv'],
  transito: ['dashboard', 'transito'],
  // Proveedor = Gestor SOAT de FLITO: ve su cola SOAT (filtrada por proveedor en el servidor).
  proveedor: ['dashboard', 'soat'],
  // Auditor: read-only LAFT + vistas FLITO de solo lectura (migración D-2). No se le
  // incluye en ningún requireRole de mutación FLITO — solo lectura.
  auditor: ['dashboard', 'laft_manual', 'laft_oficial', 'laft_audit_plan', 'laft_dashboard',
    'flito_tramites', 'soat', 'flito_impuestos', 'flito_revisiones', 'flito_compuerta', 'flito_parametrizacion', 'flito_tablero', 'flito_bitacora', 'flito_logistica'],
  // FLITO — el operador del dominio ES el admin (despliegue FLITO-only): admin ya obtiene TODAS
  // las páginas arriba, así que no hay una fila `operaciones` aparte.
  // FLITO — Gestor de Impuestos: solo su portal (filtrado por organismo en el servidor).
  gestor_impuestos: ['dashboard', 'flito_impuestos'],
  // FLITO Logística — Mensajero: hoy solo el tablero; su página de ruta (PWA) llega en la Fase 2.
  mensajero: ['dashboard'],
};

// Helpers de permisos PESV: en endpoints de gestión PESV, lider_pesv tiene los mismos
// derechos que admin. Para el resto del sistema, sigue siendo rol limitado.
export const PESV_ADMIN_ROLES: readonly UserRole[] = ['admin', 'lider_pesv'];
// Para inspecciones/checklists/incidentes el supervisor_flota también puede mutar.
export const FLEET_OPS_ROLES: readonly UserRole[] = ['admin', 'lider_pesv', 'supervisor_flota'];

export function isValidPage(slug: string): slug is PageSlug {
  return slug in PAGES;
}

/**
 * Combina los defaults del rol con las páginas personalizadas del usuario.
 * Admin siempre obtiene TODO. Otros roles: union(rol_defaults, user.allowedPages válidas).
 */
export function getEffectivePages(user: { role: UserRole; allowedPages?: string[] | null }): PageSlug[] {
  if (user.role === 'admin') return Object.keys(PAGES) as PageSlug[];
  const fromRole = ROLE_DEFAULT_PAGES[user.role] ?? [];
  const fromUser = (user.allowedPages ?? []).filter(isValidPage);
  return Array.from(new Set([...fromRole, ...fromUser]));
}
