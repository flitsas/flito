import type { PageSlug } from '../../lib/permissions';

// Catálogo único de navegación. Antes vivía en Layout.tsx pero ahora lo consumen
// CommandPalette y FlitSidebar. Single source of truth.

export interface NavItem {
  page: PageSlug;
  to: string;
  label: string;
  /** Si se define, el ítem solo se muestra a estos roles (además del permiso de página). */
  roles?: string[];
  section: 'general' | 'gestion' | 'transito' | 'flota' | 'mantenimiento' | 'pesv' | 'rndc' | 'laft' | 'finanzas' | 'admin';
  keywords?: string;  // términos de búsqueda alternativos para Command Palette
}

// Orden estable de secciones en la navegación (no depende del orden de NAV_ITEMS).
export const SECTION_ORDER: NavItem['section'][] = [
  'general', 'gestion', 'transito', 'flota', 'mantenimiento', 'pesv', 'rndc', 'laft', 'finanzas', 'admin',
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
  transito:      'Tránsito',
  flota:         'Flota',
  mantenimiento: 'Mantenimiento',
  pesv:          'PESV',
  rndc:          'RNDC',
  laft:          'Cumplimiento',
  finanzas:      'Finanzas',
  admin:         'Administración',
};

export const NAV_ITEMS: NavItem[] = [
  { page: 'dashboard',   to: '/',                                section: 'general',       label: 'Tablero',                 keywords: 'dashboard inicio home resumen' },
  { page: 'vehicles',    to: '/vehicles',                        section: 'gestion',       label: 'Vehículos',               keywords: 'placa vin runt cargar' },
    { page: 'clients',      to: '/clients',      section: 'gestion', label: 'Clientes y proveedores', keywords: 'empresa nit razon social tarifas proveedores soat parametrizacion autogestion' },
  { page: 'tramite',     to: '/tramite',                         section: 'gestion',       label: 'Trámite Digital',         keywords: 'traspaso fur mintransporte' },
  // FLITO — vista unificada de despacho (SOAT + Impuestos + entrega en una sola pantalla) y sus
  // herramientas, todas bajo el desplegable «Gestión» (§correcciones-UX P2.3). Reemplaza el SOAT y
  // la Lectura de Impuestos legacy.
  //
  // Las colas de SOAT e Impuestos las ven su gestor (proveedor / gestor_impuestos) Y Operaciones
  // (HU #11151). Antes eran exclusivas del gestor y Operaciones trabajaba desde Trámites; con la
  // contingencia del Feature #11150, Operaciones puede asumir la gestión cuando no hay proveedor o
  // el gestor no puede atender, y necesita entrar a la cola. El permiso de página ya lo tenía —
  // `ROLE_DEFAULT_PAGES.admin` es todo el catálogo—, lo que faltaba era la entrada de menú.
  { page: 'flito_tramites', to: '/flito/tramites',               section: 'gestion',       label: 'Gestión Trámites',        keywords: 'flito tramites gestion unificado solicitar soat impuestos entregar lote despacho cola factura venta' },
  { page: 'flito_derechos', to: '/flito/derechos',               section: 'gestion',       label: 'Derechos de tránsito',     keywords: 'flito derecho tramite cuenta cobro organismo recibo valor radicado carga masiva zip consolidado pendientes' },
  { page: 'flito_revisiones', to: '/flito/revisiones',           section: 'gestion',       label: 'Revisiones OCR',          keywords: 'flito revision ocr cola confirmar campos umbral' },
  { page: 'flito_bitacora', to: '/flito/bitacora',               section: 'gestion',       label: 'Bitácora',                keywords: 'flito auditoria rastro movimientos audit log' },
  // Comparendos monitoreados (Feature #11495): SIN `roles`, a diferencia de SOAT e Impuestos. Ese
  // campo restringe DENTRO de quienes ya tienen el slug, y aquí el slug no se lo da por defecto
  // ningún rol (`ROLE_DEFAULT_PAGES` no se toca): repetir la regla en dos sitios solo crea dos
  // sitios que pueden divergir.
  { page: 'flito_comparendos', to: '/flito/comparendos',         section: 'gestion',       label: 'Comparendos',             keywords: 'comparendo simit multa infraccion placa nit transito monitoreo' },
  { page: 'flito_logistica', to: '/flito/logistica',             section: 'gestion',       label: 'Logística',               keywords: 'flito logistica documentos licencia lt placa acta despacho entrega mensajero recogida trazabilidad' },
  { page: 'flito_logistica_ruta', to: '/flito/ruta',             section: 'gestion',       label: 'Mi ruta',                 roles: ['mensajero'],         keywords: 'flito logistica mensajero ruta recogida entrega firma pwa campo' },
  { page: 'soat',           to: '/flito/soat',                   section: 'gestion',       label: 'SOAT',                    roles: ['proveedor', 'admin'],        keywords: 'flito soat cola adquisicion factura poliza gestor proveedor pagado operaciones contingencia' },
  { page: 'flito_impuestos', to: '/flito/impuestos',            section: 'gestion',       label: 'Impuestos',               roles: ['gestor_impuestos', 'admin'], keywords: 'flito impuesto organismo recibo factura venta gestion pagado conciliacion operaciones contingencia' },
  { page: 'finanzas_reporte_costos', to: '/finanzas/reporte-costos', section: 'finanzas',  label: 'Reporte de costos',       keywords: 'finanzas contabilidad facturacion cobros costos reporte soat impuesto gmf derecho tramite logistica digital total' },
  // Bolsas: va en Finanzas y no en Gestión porque su dueño es el área financiera —es quien
  // recarga, ajusta y cierra el periodo—, aunque el dominio sea FLITO. «prepago» se conserva en las
  // keywords: dejó de ser el nombre visible, pero es como muchos siguen buscándolo.
  { page: 'flito_bolsas', to: '/flito/bolsas',                   section: 'finanzas',      label: 'Bolsas',                  keywords: 'bolsa saldo prepago recarga movimiento manual cierre periodo extracto organismo secretaria transito conciliacion riesgo alerta financiera' },
  // Conciliación de boletas SOAT (Feature #11623): va en Finanzas —lo pide el AC1 y además espeja a
  // Bolsas, que también es dominio FLITO con dueño financiero—. Sin `roles`: el slug ya es exclusivo
  // de `admin` + `financiera`, y repetir la regla aquí la pondría en dos sitios que pueden divergir.
  { page: 'flito_conciliacion', to: '/flito/conciliacion',       section: 'finanzas',      label: 'Conciliación',            keywords: 'conciliacion boleta soat portal excel cruce poliza bolsa pse comprobante financiera cuadre recaudo' },
  // Facturación electrónica: va en Finanzas porque su dueño es contabilidad —es quien firma la
  // confirmación de cada concepto—, aunque el dominio técnico sea la integración con Siigo.
  // Dos entradas, y la existente se RENOMBRA: dos opciones llamadas «Facturación electrónica» en el
  // mismo grupo es una trampa —nadie sabría cuál abrir—. Ninguna lleva `roles`: el slug ya restringe,
  // y repetir la regla la pondría en dos sitios que pueden divergir.
  { page: 'siigo_parametrizacion', to: '/siigo/parametrizacion',   section: 'finanzas',      label: 'Facturación electrónica · Parametrización', keywords: 'siigo facturacion electronica dian parametrizacion mapeo concepto producto catalogo emision contabilidad confirmacion tributaria iva' },
  { page: 'siigo_operacion', to: '/siigo/operacion',               section: 'finanzas',      label: 'Facturación electrónica · Operación', keywords: 'siigo facturacion electronica dian bandeja fallidos reintento correo rechazo linea de tiempo operacion pendiente detenido' },
  { page: 'transito',    to: '/transito',                        section: 'transito',      label: 'Bandeja de trámites',     keywords: 'transito tránsito bandeja stt placa asignar pendientes' },
  { page: 'transito_organismos', to: '/transito/organismos',      section: 'transito',      label: 'Organismos STT',          keywords: 'transito organismo secretaria logo alias configuracion modalidad autogestion admin operaciones' },
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
