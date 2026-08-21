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
  // Finanzas: usuarios del área financiera (contabilidad, facturación, cobros). Hoy solo el reporte de costos.
  'financiera',
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
  financiera: 'Financiera',
};

// ============================================================================
// Catálogo de páginas (slug → label visible)
// ============================================================================
export const PAGES = {
  dashboard: 'Tablero de control',
  vehicles: 'Vehículos',
  clients: 'Clientes y proveedores',
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
  // Derechos de tránsito: lo que el organismo cobra por radicar (HU #10950/#10951).
  flito_derechos: 'FLITO — Derechos de tránsito',
  flito_revisiones: 'FLITO — Revisión OCR',
  flito_compuerta: 'FLITO — Compuerta de entrega',
  flito_tablero: 'FLITO — Tablero',
  flito_bitacora: 'FLITO — Bitácora',
  // FLITO Logística: consola de Operaciones (trazabilidad por documento, actas, despacho).
  flito_logistica: 'FLITO — Logística',
  // FLITO Logística — ruta del mensajero (PWA de campo, Fase 2): recogidas y entregas asignadas.
  flito_logistica_ruta: 'FLITO — Mi ruta (mensajero)',
  // Monitoreo de comparendos (Feature #11495, 17b): el visor de lo que SIMIT y los municipios
  // reportan de los NIT vigilados. Clave PROPIA y no una sub-vista de `flito_tramites`: quien opera
  // comparendos no tiene por qué entrar al resto del sistema, y ese es justo el permiso que esta
  // pantalla concede. NO se añade a `ROLE_DEFAULT_PAGES` en ninguna fila —`admin` la obtiene por
  // tenerlas todas—; en particular NO se le da a `auditor`, que sí entra al resto de FLITO en
  // lectura: el router de `/flito/comparendos` exige `admin` entero, así que darle la página sería
  // regalarle una pantalla que responde 403 en cada petición.
  flito_comparendos: 'FLITO — Comparendos',
  // Bolsas prepago del cliente (Feature #11120): saldo, movimientos, cierres y estado de cuenta de
  // los organismos. Es dinero, así que solo la ven Administración y Financiera — ni siquiera
  // auditoría, a diferencia del resto de vistas FLITO.
  flito_bolsas: 'FLITO — Bolsas prepago',
  // Conciliación de recaudo SOAT (Feature #11623): la carga del .xlsx del portal, el cuadre contra
  // lo emitido y el cierre con su comprobante. Es dinero de terceros, así que sigue el reparto de
  // `flito_bolsas` y NO el del resto de FLITO: solo Administración y Financiera. `auditor` queda
  // fuera a propósito —el router de `/flito/conciliacion` exige `admin`/`financiera` entero, y su
  // lectura del comprobante ya va por la ruta suya de `/flito/soat` (HU #11678)—.
  flito_conciliacion: 'FLITO — Conciliación',
  // Finanzas — reporte de costos por trámite (contabilidad / facturación / cobros).
  finanzas_reporte_costos: 'Finanzas — Reporte de costos',
  // Facturación electrónica (Feature #11240): parametrización de la integración con Siigo —
  // catálogos, mapeo de conceptos a productos y configuración global de emisión. UNA sola clave
  // para toda la parametrización: son pantallas del mismo trabajo y de la misma persona, y
  // partirla obligaría a conceder dos permisos para completar una tarea.
  siigo_parametrizacion: 'Facturación electrónica — Parametrización',
  // Facturación electrónica (Feature #11244): la pantalla de OPERACIÓN — bandeja de facturas,
  // línea de tiempo de cada una y las acciones de emitir, reintentar, reenviar o corregir.
  // Clave PROPIA y distinta de `siigo_parametrizacion` y de `finanzas_reporte_costos` a propósito:
  // parametrizar es decidir cómo se factura (se hace una vez y casi no se toca), operar es empujar
  // facturas todos los días, y el reporte de costos es otro trabajo con otra audiencia. Unirlas
  // obligaría a conceder la operación diaria a quien solo debe parametrizar, o al revés.
  siigo_operacion: 'Facturación electrónica — Operación',
} as const satisfies Record<string, string>;

export type PageSlug = keyof typeof PAGES;

export const PAGE_GROUPS: { label: string; pages: PageSlug[] }[] = [
  { label: 'General', pages: ['dashboard'] },
  { label: 'Operaciones', pages: ['vehicles', 'soat', 'tramite', 'tax_reader', 'transito', 'drive'] },
  { label: 'Flota', pages: ['fleet'] },
  { label: 'Mantenimiento', pages: ['maintenance'] },
  { label: 'PESV', pages: ['pesv', 'pesv_raci', 'pesv_normativa', 'pesv_retencion'] },
  { label: 'RNDC', pages: ['rndc', 'rndc_admin'] },
  { label: 'Cumplimiento LAFT', pages: ['laft', 'laft_unusual', 'laft_trainings', 'laft_manual', 'laft_oficial', 'laft_audit_plan', 'laft_dashboard'] },
  { label: 'Tránsito', pages: ['transito', 'transito_organismos'] },
  { label: 'FLITO (SOAT e Impuestos)', pages: ['flito_tramites', 'soat', 'flito_impuestos', 'flito_derechos', 'flito_revisiones', 'flito_compuerta', 'clients', 'flito_tablero', 'flito_bitacora', 'flito_logistica', 'flito_logistica_ruta', 'flito_bolsas', 'flito_comparendos', 'flito_conciliacion'] },
  { label: 'Finanzas', pages: ['finanzas_reporte_costos', 'siigo_parametrizacion', 'siigo_operacion'] },
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
    'flito_tramites', 'soat', 'flito_impuestos', 'flito_derechos', 'flito_revisiones', 'flito_compuerta', 'clients', 'flito_tablero', 'flito_bitacora', 'flito_logistica',
    // El reporte de costos consolida datos que el auditor ya ve uno a uno (SOAT, impuestos,
    // derechos). Negarle la vista agregada no protegía nada: solo le obligaba a reconstruirla.
    'finanzas_reporte_costos',
    // Parametrización de facturación electrónica: el backend concede lectura a `auditor` en las
    // tres rutas (mapeo, configuración y compuerta) porque ver la parametrización que respalda una
    // factura emitida es parte de auditar. La pantalla no le deja escribir nada.
    'siigo_parametrizacion',
    // Operación de facturación electrónica: VER la bandeja, la línea de tiempo y el estado de cada
    // factura es exactamente lo que audita un revisor fiscal. Las acciones que mueven una factura
    // (emitir, reintentar, corregir…) le están negadas en el servidor por la tabla de
    // `siigo.permisos.ts`, que solo le concede `consultar`. Ver y operar no son el mismo permiso.
    'siigo_operacion'],
  // FLITO — el operador del dominio ES el admin (despliegue FLITO-only): admin ya obtiene TODAS
  // las páginas arriba, así que no hay una fila `operaciones` aparte.
  // FLITO — Gestor de Impuestos: solo su portal (filtrado por organismo en el servidor).
  gestor_impuestos: ['dashboard', 'flito_impuestos'],
  // FLITO Logística — Mensajero: su ruta de campo (PWA). No accede a la consola de Operaciones.
  mensajero: ['dashboard', 'flito_logistica_ruta'],
  // Finanzas — usuarios financieros: el reporte de costos y la administración comercial del
  // cliente (sus tarifas), que es de donde salen los valores de ese reporte. Los derechos de
  // tránsito NO son suyos: los gestiona Operaciones, que es quien carga los recibos.
  // Las bolsas prepago SÍ son suyas: es el dinero del cliente que Financiera recarga, mueve y
  // cierra. El backend (`/flito/bolsas`) solo admite admin y financiera, así que la página va aquí
  // y NO en `auditor`, que en el resto de FLITO lee todo pero de los movimientos crudos queda fuera.
  // La parametrización de facturación electrónica es suya: `financiera` es quien FIRMA la
  // confirmación de contabilidad de cada concepto (AC8 de la HU #11282). Ve la pantalla completa,
  // pero el backend solo le admite el endpoint de confirmar; el resto de la edición es de `admin`.
  // La operación de facturación electrónica también es suya: `financiera` es quien emite, reintenta
  // y corrige el día a día (valor conservador de hoy en `siigo.permisos.ts`: escritura para `admin`
  // y `financiera`). Si mañana se decide que solo emite `admin`, se edita esa tabla y esta línea.
  // La conciliación del recaudo SOAT es suya por el mismo motivo que las bolsas: es plata del
  // cliente que Financiera cuadra y cierra. El router de `/flito/conciliacion` solo admite
  // `admin` y `financiera` (CF-08), así que la página va aquí y NO en `auditor`.
  financiera: ['dashboard', 'finanzas_reporte_costos', 'clients', 'flito_bolsas', 'flito_conciliacion', 'siigo_parametrizacion', 'siigo_operacion'],
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
