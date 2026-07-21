import type { PageSlug } from '../../lib/permissions';

// Catálogo único de navegación. Antes vivía en Layout.tsx pero ahora lo consumen
// CommandPalette y FlitSidebar. Single source of truth.

export interface NavItem {
  page: PageSlug;
  to: string;
  label: string;
  /** Si se define, el ítem solo se muestra a estos roles (además del permiso de página). */
  roles?: string[];
  section: 'general' | 'gestion' | 'flito' | 'transito' | 'flota' | 'mantenimiento' | 'pesv' | 'rndc' | 'laft' | 'admin';
  keywords?: string;  // términos de búsqueda alternativos para Command Palette
}

// Orden estable de secciones en la navegación (no depende del orden de NAV_ITEMS).
export const SECTION_ORDER: NavItem['section'][] = [
  'general', 'gestion', 'flito', 'transito', 'flota', 'mantenimiento', 'pesv', 'rndc', 'laft', 'admin',
];

/** Sección del ítem de nav que mejor coincide con la ruta actual (prefijo más largo). */
export function activeSectionForPath(pathname: string, items: NavItem[]): NavItem['section'] | null {
  const matches = items.filter((it) =>
    it.to === '/' ? pathname === '/' : pathname === it.to || pathname.startsWith(`${it.to}/`),
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.to.length - a.to.length);
  return matches[0].section;
}

export const SECTION_LABEL: Record<NavItem['section'], string> = {
  general:       'General',
  gestion:       'Gestión',
  flito:         'FLITO',
  transito:      'Tránsito',
  flota:         'Flota',
  mantenimiento: 'Mantenimiento',
  pesv:          'PESV',
  rndc:          'RNDC',
  laft:          'Cumplimiento',
  admin:         'Administración',
};

export const NAV_ITEMS: NavItem[] = [
  { page: 'dashboard',   to: '/',                                section: 'general',       label: 'Tablero',                 keywords: 'dashboard inicio home resumen' },
  { page: 'vehicles',    to: '/vehicles',                        section: 'gestion',       label: 'Vehículos',               keywords: 'placa vin runt cargar' },
  { page: 'clients',     to: '/clients',                         section: 'gestion',       label: 'Clientes',                keywords: 'empresa nit razon social' },
  { page: 'tramite',     to: '/tramite',                         section: 'gestion',       label: 'Trámite Digital',         keywords: 'traspaso fur mintransporte' },
  // FLITO — vista unificada de despacho (SOAT + Impuestos + entrega en una sola pantalla) y sus
  // herramientas. Reemplaza el SOAT y la Lectura de Impuestos legacy. Las colas de gestor SOAT/Impuestos
  // solo se muestran a los gestores (proveedor / gestor_impuestos); admin/operaciones usan Trámites.
  { page: 'flito_tramites', to: '/flito/tramites',               section: 'flito',         label: 'Trámites',                keywords: 'flito tramites unificado solicitar soat impuestos entregar lote despacho cola factura venta' },
  { page: 'flito_revisiones', to: '/flito/revisiones',           section: 'flito',         label: 'Revisiones OCR',          keywords: 'flito revision ocr cola confirmar campos umbral' },
  { page: 'flito_parametrizacion', to: '/flito/parametrizacion', section: 'flito',        label: 'Parametrización',         keywords: 'flito parametrizacion companias proveedores organismos modalidad reglas umbral sla' },
  { page: 'flito_bitacora', to: '/flito/bitacora',               section: 'flito',         label: 'Bitácora',                keywords: 'flito auditoria rastro movimientos audit log' },
  { page: 'flito_demo',     to: '/flito/demo',                   section: 'flito',         label: 'Panel de demo',           keywords: 'flito demo simulado flit crear tramite anular recrear sincronizar' },
  { page: 'soat',           to: '/flito/soat',                   section: 'flito',         label: 'SOAT (gestor)',           roles: ['proveedor'],         keywords: 'flito soat cola adquisicion factura poliza gestor proveedor pagado' },
  { page: 'flito_impuestos', to: '/flito/impuestos',            section: 'flito',         label: 'Impuestos (gestor)',      roles: ['gestor_impuestos'],  keywords: 'flito impuesto organismo recibo factura venta gestion pagado conciliacion' },
  { page: 'transito',    to: '/transito',                        section: 'transito',      label: 'Bandeja de trámites',     keywords: 'transito tránsito bandeja stt placa asignar pendientes' },
  { page: 'users',       to: '/transito/organismos',             section: 'transito',      label: 'Organismos STT',          keywords: 'transito organismo secretaria logo alias configuracion admin' },
  { page: 'fleet',       to: '/fleet',                           section: 'flota',         label: 'Flota',                   keywords: 'vehiculos flota carga documentos' },
  { page: 'maintenance', to: '/maintenance',                     section: 'mantenimiento', label: 'Mantenimiento',           keywords: 'taller orden trabajo' },
  { page: 'maintenance', to: '/maintenance/work-orders',         section: 'mantenimiento', label: 'Órdenes de trabajo',      keywords: 'wo work order taller' },
  { page: 'maintenance', to: '/maintenance/indicators',          section: 'mantenimiento', label: 'Indicadores mant.',       keywords: 'kpi metricas mantenimiento' },
  { page: 'pesv',        to: '/pesv',                            section: 'pesv',          label: 'Tablero PESV',            keywords: 'seguridad vial conductor' },
  { page: 'pesv',        to: '/pesv/conductores',                section: 'pesv',          label: 'Conductores',             keywords: 'driver licencia documentos' },
  { page: 'pesv',        to: '/pesv/capacitaciones',             section: 'pesv',          label: 'Capacitaciones',          keywords: 'training curso inducción' },
  { page: 'pesv',        to: '/pesv/incidentes',                 section: 'pesv',          label: 'Incidentes',              keywords: 'accidente reporte vial' },
  { page: 'pesv',        to: '/pesv/incidentes/stats',           section: 'pesv',          label: 'Estadística siniestros',  keywords: 'estadistica siniestros indicadores frecuencia severidad gravedad paso 21 res 40595' },
  { page: 'pesv',        to: '/pesv/checklists',                 section: 'pesv',          label: 'Checklists',              keywords: 'inspección preoperacional' },
  { page: 'pesv',        to: '/pesv/alcoholimetria',             section: 'pesv',          label: 'Alcoholimetría',          keywords: 'alcohol test sustancias' },
  { page: 'pesv',        to: '/pesv/emergencias',                section: 'pesv',          label: 'Emergencias',             keywords: 'plan emergencia contingencia' },
  { page: 'pesv',        to: '/pesv/operacion-indicadores',      section: 'pesv',          label: 'Indicadores op.',         keywords: 'kpi pesv operacional' },
  { page: 'pesv',        to: '/pesv/politica',                   section: 'pesv',          label: 'Política PSV',            keywords: 'politica seguridad vial firmada vigente res 40595' },
  { page: 'pesv',        to: '/pesv/comite',                     section: 'pesv',          label: 'Comité Seguridad Vial',   keywords: 'comite csv actas reunion' },
  { page: 'pesv',        to: '/pesv/plan',                       section: 'pesv',          label: 'Plan Anual PESV',         keywords: 'plan anual objetivos acciones presupuesto' },
  { page: 'pesv',        to: '/pesv/diagnostico',                section: 'pesv',          label: 'Diagnóstico PESV',        keywords: 'autoevaluacion linea base 24 estandares phva res 45295' },
  { page: 'pesv',        to: '/pesv/tablero',                    section: 'pesv',          label: 'Tablero ejecutivo PESV',  keywords: 'tablero ejecutivo score sisi pesv supert export' },
  { page: 'pesv',        to: '/pesv/reportar',                   section: 'pesv',          label: 'Reportar incidente',      keywords: 'reportar incidente accidente comparendo movil gps foto conductor' },
  { page: 'pesv',        to: '/pesv/auditorias',                 section: 'pesv',          label: 'Auditorías PESV',         keywords: 'auditoria interna externa supert onac hallazgos paso 22' },
  { page: 'pesv',        to: '/pesv/comunicaciones',             section: 'pesv',          label: 'Comunicaciones',          keywords: 'comunicaciones difusion politica lecciones acuse paso 1.8 24' },
  { page: 'pesv',        to: '/pesv/contratistas',               section: 'pesv',          label: 'Contratistas',            keywords: 'contratistas terceros transportadores aliados paso 18' },
  { page: 'privacy',     to: '/privacy/log-pii',                 section: 'admin',         label: 'Log accesos PII',         keywords: 'pii ley 1581 habeas data accesos auditoria sic' },
  { page: 'pesv',        to: '/pesv/jornadas',                   section: 'pesv',          label: 'Control Jornada (admin)', keywords: 'jornada conductor decreto 1079 horas conduccion alarmas' },
  { page: 'pesv',        to: '/pesv/mi-jornada',                 section: 'pesv',          label: 'Mi Jornada',              keywords: 'jornada conductor abrir cerrar pausa descanso' },
  { page: 'pesv',        to: '/pesv/rutas',                      section: 'pesv',          label: 'Rutas operativas',        keywords: 'ruta caracterizacion waypoint riesgo trimestral pernocta paso 4' },
  { page: 'pesv',        to: '/pesv/pernocta',                   section: 'pesv',          label: 'Zonas de pernocta',       keywords: 'pernocta parqueo seguro zona certificada' },
  { page: 'pesv_raci',     to: '/pesv/raci',                       section: 'pesv',          label: 'Matriz RACI',             keywords: 'responsabilidades raci responsible accountable consulted informed paso 1.5' },
  { page: 'pesv_normativa',to: '/pesv/normativa',                  section: 'pesv',          label: 'Tracker normativo',       keywords: 'normativa leyes decretos resoluciones tracker revision paso 1.7' },
  { page: 'pesv_retencion',to: '/pesv/retencion',                  section: 'pesv',          label: 'Retención documental',    keywords: 'retencion archivo ley 594 paso 19 purga anonimizar' },
  { page: 'rndc',        to: '/rndc',                            section: 'rndc',          label: 'Tablero RNDC',            keywords: 'mintransporte registro nacional carga' },
  { page: 'rndc',        to: '/rndc/remesas',                    section: 'rndc',          label: 'Remesas',                 keywords: 'remesa carga manifiesto' },
  { page: 'rndc',        to: '/rndc/manifiestos',                section: 'rndc',          label: 'Manifiestos',             keywords: 'manifiesto electrónico carga MN' },
  { page: 'rndc',        to: '/rndc/maestros',                   section: 'rndc',          label: 'Maestros RNDC',           keywords: 'catálogos maestros tipos' },
  { page: 'rndc_admin',  to: '/rndc/admin/credenciales',         section: 'rndc',          label: 'Credenciales RNDC',       keywords: 'usuario clave qr ws' },
  { page: 'laft',        to: '/laft',                            section: 'laft',          label: 'Cumplimiento LAFT',       keywords: 'lavado activos terrorismo sarlaft' },
  { page: 'laft_unusual',to: '/laft/unusual',                    section: 'laft',          label: 'Operaciones inusuales',   keywords: 'sospechoso ros sirel uiaf' },
  { page: 'laft_trainings', to: '/laft/trainings',               section: 'laft',          label: 'Capacitaciones LAFT',     keywords: 'curso lavado activos' },
  { page: 'laft_manual',    to: '/laft/manual',                   section: 'laft',          label: 'Manual SARLAFT',          keywords: 'manual sarlaft version publicado pdf' },
  { page: 'laft_oficial',   to: '/laft/oficial',                  section: 'laft',          label: 'Oficial cumplimiento',    keywords: 'oficial cumplimiento principal suplente iso 17024' },
  { page: 'laft_audit_plan',to: '/laft/plan-auditorias',          section: 'laft',          label: 'Plan de auditorías',      keywords: 'plan auditoria interna externa sarlaft' },
  { page: 'laft_dashboard', to: '/laft/tablero',                  section: 'laft',          label: 'Tablero LAFT',            keywords: 'tablero dashboard indicadores kpi cumplimiento' },
  { page: 'users',       to: '/users',                           section: 'admin',         label: 'Usuarios',                keywords: 'admin usuarios roles permisos' },
  { page: 'drive',       to: '/drive',                           section: 'admin',         label: 'Google Drive',            keywords: 'archivos drive folder' },
  { page: 'privacy',     to: '/privacy',                         section: 'admin',         label: 'Privacidad y datos',      keywords: 'ley 1581 forget anonimizar' },
];
