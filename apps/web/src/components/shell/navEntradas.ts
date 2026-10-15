import type { PageSlug } from '../../lib/permissions';
import type { UsuarioAyuda } from '../../lib/ayudaFlito';
import { puedeVerAyudaFlito } from '../../lib/ayudaFlito';

// Las ENTRADAS del menú (qué existe, dónde vive y quién lo ve) sin sus nombres. Separadas de
// `navItems.ts` (HU #13431) porque `lib/permissions.ts` —que va en el chunk de entrada de /login—
// las necesita para `rutaInicio`, y los nombres salen de `ARBOL_PERMISOS` (shared-types), que pesa
// ~4,6 KB gzip: el presupuesto de `check:bundle` no los admite en ese chunk. Los nombres se
// resuelven en `navItems.ts`, que solo importa el shell (post-login).

export interface NavItem {
  page: PageSlug;
  to: string;
  /** Nombre del catálogo (o la `etiqueta` del enlace secundario). Se resuelve, no se declara. */
  label: string;
  /**
   * HU #12872: si se define, además del permiso de página el usuario necesita AL MENOS UNA de estas
   * funciones (OR). Nunca el nombre del rol: lo decide el cuadro de permisos.
   */
  funcion?: string | readonly string[];
  section: 'general' | 'gestion' | 'transito' | 'flota' | 'mantenimiento' | 'pesv' | 'rndc' | 'laft' | 'finanzas' | 'admin' | 'ayuda';
  keywords?: string;  // términos de búsqueda alternativos para Command Palette
}

// Orden estable de secciones en la navegación (no depende del orden de NAV_ITEMS).
export const SECTION_ORDER: NavItem['section'][] = [
  'general', 'gestion', 'transito', 'flota', 'mantenimiento', 'pesv', 'rndc', 'laft', 'finanzas', 'admin', 'ayuda',
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


/** ¿El conjunto de funciones trae al menos una de las pedidas? `null` (aún no llegó) = no (fail-closed). */
function algunaFuncion(funciones: readonly string[] | null, pedidas: string | readonly string[]): boolean {
  if (!funciones) return false;
  const lista = typeof pedidas === 'string' ? [pedidas] : pedidas;
  return lista.some((c) => funciones.includes(c));
}

/**
 * Visibilidad de un ítem: permiso de página + `funcion` opcional (HU #12872). `flito_ayuda` usa el
 * helper derivado. Ningún nombre de rol interviene.
 */
export function navItemPermitido(
  it: Pick<NavItem, 'page' | 'funcion'>,
  user: UsuarioAyuda | null,
  allowed: Set<PageSlug>,
  funciones: readonly string[] | null,
): boolean {
  if (it.page === 'flito_ayuda') return puedeVerAyudaFlito(user);
  return allowed.has(it.page) && (!it.funcion || algunaFuncion(funciones, it.funcion));
}

/** Declaración: el nombre lo pone el catálogo; `etiqueta` solo en enlaces que no son un ítem suyo. */
export type NavItemDecl = Omit<NavItem, 'label'> & { etiqueta?: string };

export const NAV_ENTRADAS: NavItemDecl[] = [
  { page: 'dashboard',   to: '/',                                section: 'general',       keywords: 'dashboard inicio home resumen' },
  { page: 'flito_ayuda', to: '/flito/ayuda',                     section: 'ayuda',                     keywords: 'ayuda manual guia ficha como se usa flito' },
  { page: 'vehicles',    to: '/vehicles',                        section: 'gestion',       keywords: 'placa vin runt cargar' },
    { page: 'clients',      to: '/clients',      section: 'gestion', keywords: 'empresa nit razon social tarifas proveedores soat parametrizacion autogestion' },
  { page: 'tramite',     to: '/tramite',                         section: 'gestion',       keywords: 'traspaso fur mintransporte' },
  // FLITO — vista unificada de despacho (SOAT + Impuestos + entrega en una sola pantalla) y sus
  // herramientas, todas bajo el desplegable «Gestión» (§correcciones-UX P2.3). Reemplaza el SOAT y
  // la Lectura de Impuestos legacy.
  //
  // Las colas de SOAT e Impuestos las ve quien tenga la página Y la función de ver la cola
  // (HU #12872): el gestor, Operaciones en contingencia (Feature #11150) o cualquier rol al que el
  // cuadro se la dé. Antes era una lista fija de roles.
  { page: 'flito_tramites', to: '/flito/tramites',               section: 'gestion',       keywords: 'flito tramites gestion unificado solicitar soat impuestos entregar lote despacho cola factura venta' },
  { page: 'flito_derechos', to: '/flito/derechos',               section: 'gestion',       keywords: 'flito derecho tramite cuenta cobro organismo recibo valor radicado carga masiva zip consolidado pendientes' },
  { page: 'flito_revisiones', to: '/flito/revisiones',           section: 'gestion',       keywords: 'flito revision ocr cola confirmar campos umbral' },
  { page: 'flito_bitacora', to: '/flito/bitacora',               section: 'gestion',       keywords: 'flito auditoria rastro movimientos audit log' },
  // Comparendos monitoreados (Feature #11495): SIN `funcion`, a diferencia de SOAT e Impuestos: el
  // slug basta, y repetir la regla en dos sitios solo crea dos sitios que pueden divergir.
  { page: 'flito_comparendos', to: '/flito/comparendos',         section: 'gestion',       keywords: 'comparendo simit multa infraccion placa nit transito monitoreo' },
  { page: 'flito_logistica', to: '/flito/logistica',             section: 'gestion',       keywords: 'flito logistica documentos licencia lt placa acta despacho entrega mensajero recogida trazabilidad' },
  { page: 'flito_logistica_ruta', to: '/flito/ruta',             section: 'gestion',       funcion: 'logistica.ruta.ver',  keywords: 'flito logistica mensajero ruta recogida entrega firma pwa campo' },
  // Portal SOAT de FLITO. Slug `flito_soat` —el propio, no la `soat` del módulo legacy (ADR-0008
  // §4)—. HU #12872: además de la página pide ver la cola (`soat.cola.ver`) o radicar
  // (`soat.solicitud.crear`, canal Cliente). Quien tenga la página y una de las dos lo ve, sea cual
  // sea el nombre de su rol: lo decide el cuadro de permisos (Épica #13411).
  { page: 'flito_soat',     to: '/flito/soat',                   section: 'gestion',       funcion: ['soat.cola.ver', 'soat.solicitud.crear'], keywords: 'flito soat cola adquisicion factura poliza gestor proveedor pagado operaciones contingencia cliente solicitud' },
  { page: 'flito_impuestos', to: '/flito/impuestos',            section: 'gestion',       funcion: 'impuestos.cola.ver', keywords: 'flito impuesto organismo recibo factura venta gestion pagado conciliacion operaciones contingencia' },
  { page: 'finanzas_reporte_costos', to: '/finanzas/reporte-costos', section: 'finanzas',  keywords: 'finanzas contabilidad facturacion cobros costos reporte soat impuesto gmf derecho tramite logistica digital total' },
  // Gastos diarios (HU #12624): cuánto salió de caja por día y por categoría, contado el día del
  // pago. Va justo tras el reporte porque es su lectura de caja, no su consolidado.
  { page: 'finanzas_gastos_diarios', to: '/finanzas/gastos-diarios', section: 'finanzas',  keywords: 'gastos diarios soat impuestos derechos logistica servicios adicionales gmf dashboard' },
  // Bolsas: va en Finanzas y no en Gestión porque su dueño es el área financiera —es quien
  // recarga, ajusta y cierra el periodo—, aunque el dominio sea FLITO. «prepago» se conserva en las
  // keywords: dejó de ser el nombre visible, pero es como muchos siguen buscándolo.
  { page: 'flito_bolsas', to: '/flito/bolsas',                   section: 'finanzas',      keywords: 'bolsa saldo prepago recarga movimiento manual cierre periodo extracto organismo secretaria transito conciliacion riesgo alerta financiera' },
  // Tarifas (HU #12375): lo que FLITO le cobra a cada cliente por trámite digital y logística, como
  // vigencias con historial. Va en Finanzas —su dueño es quien pone precio— y sin `roles`: el slug
  // `flito_tarifas` ya es de `admin` + `financiera` y repetirlo aquí sería una segunda verdad.
  { page: 'flito_tarifas', to: '/flito/tarifas',                 section: 'finanzas',      keywords: 'tarifas valor servicio precio tramite digital matricula traspaso otros logistica vigencia historial cliente compania financiera' },
  // Servicios adicionales (HU #12542): el catálogo global de lo que FLITO cobra aparte del trámite,
  // con su valor. Va justo después de Tarifas —mismo dueño, misma zona— y sin `roles`: el slug
  // `flito_servicios_adicionales` ya es de `admin` + `financiera`.
  { page: 'flito_servicios_adicionales', to: '/flito/servicios-adicionales', section: 'finanzas', keywords: 'servicios adicionales catalogo tipo valor precio paz y salvo diagnostico derecho de peticion financiera tarifa' },
  // Comprobantes (HU #12612): la puerta única por la que entra cualquier comprobante o soporte de un
  // trámite y la cola de lo que FLITO leyó. Va en Finanzas —su dueño es quien revisa pagos y
  // soportes— y sin `roles`: el slug `flito_comprobantes` ya es de `admin` + `financiera` (0198).
  { page: 'flito_comprobantes', to: '/flito/comprobantes',     section: 'finanzas',      keywords: 'comprobantes comprobante soporte pago factura recibo transferencia ocr lectura carga lote cola pendientes consolidado documento financiera' },
  // Conciliación de boletas SOAT (Feature #11623): va en Finanzas —lo pide el AC1 y además espeja a
  // Bolsas, que también es dominio FLITO con dueño financiero—. Sin `roles`: el slug ya es exclusivo
  // de `admin` + `financiera`, y repetir la regla aquí la pondría en dos sitios que pueden divergir.
  { page: 'flito_conciliacion', to: '/flito/conciliacion',       section: 'finanzas',      keywords: 'conciliacion boleta soat portal excel cruce poliza bolsa pse comprobante financiera cuadre recaudo' },
  // Facturación electrónica: va en Finanzas porque su dueño es contabilidad —es quien firma la
  // confirmación de cada concepto—, aunque el dominio técnico sea la integración con Siigo.
  // Dos entradas, y la existente se RENOMBRA: dos opciones llamadas «Facturación electrónica» en el
  // mismo grupo es una trampa —nadie sabría cuál abrir—. Ninguna lleva `roles`: el slug ya restringe,
  // y repetir la regla la pondría en dos sitios que pueden divergir.
  { page: 'siigo_parametrizacion', to: '/siigo/parametrizacion',   section: 'finanzas',      keywords: 'siigo facturacion electronica dian parametrizacion mapeo concepto producto catalogo emision contabilidad confirmacion tributaria iva' },
  { page: 'siigo_operacion', to: '/siigo/operacion',               section: 'finanzas',      keywords: 'siigo facturacion electronica dian bandeja fallidos reintento correo rechazo linea de tiempo operacion pendiente detenido' },
  { page: 'transito',    to: '/transito',                        section: 'transito',      keywords: 'transito tránsito bandeja stt placa asignar pendientes' },
  { page: 'transito_organismos', to: '/transito/organismos',      section: 'transito',      keywords: 'transito organismo secretaria logo alias configuracion modalidad autogestion admin operaciones' },
  { page: 'fleet',       to: '/fleet',                           section: 'flota',         keywords: 'vehiculos flota carga documentos' },
  // HU #13422 (ADR-0023): una página por ítem del menú Mantenimiento (`PAGINAS_MANTENIMIENTO_POR_ITEM`).
  { page: 'maintenance_inicio', to: '/maintenance',              section: 'mantenimiento', keywords: 'taller orden trabajo' },
  { page: 'maintenance_ordenes', to: '/maintenance/work-orders', section: 'mantenimiento', keywords: 'wo work order taller' },
  { page: 'maintenance_indicadores', to: '/maintenance/indicators', section: 'mantenimiento', keywords: 'kpi metricas mantenimiento' },
  { page: 'pesv',        to: '/pesv',                            section: 'pesv',          keywords: 'seguridad vial conductor' },
  { page: 'pesv_conductores', to: '/pesv/conductores',                section: 'pesv',          keywords: 'driver licencia documentos' },
  { page: 'pesv_capacitaciones', to: '/pesv/capacitaciones',             section: 'pesv',          keywords: 'training curso inducción' },
  { page: 'pesv_incidentes', to: '/pesv/incidentes',                 section: 'pesv',          keywords: 'accidente reporte vial' },
  { page: 'pesv_siniestralidad', to: '/pesv/incidentes/stats',           section: 'pesv',          keywords: 'estadistica siniestros indicadores frecuencia severidad gravedad paso 21 res 40595' },
  { page: 'pesv_checklists', to: '/pesv/checklists',                 section: 'pesv',          keywords: 'inspección preoperacional' },
  { page: 'pesv_alcoholimetria', to: '/pesv/alcoholimetria',             section: 'pesv',          keywords: 'alcohol test sustancias' },
  { page: 'pesv_emergencias', to: '/pesv/emergencias',                section: 'pesv',          keywords: 'plan emergencia contingencia' },
  { page: 'pesv_indicadores_operacion', to: '/pesv/operacion-indicadores',      section: 'pesv',          keywords: 'kpi pesv operacional' },
  { page: 'pesv_politica', to: '/pesv/politica',                   section: 'pesv',          keywords: 'politica seguridad vial firmada vigente res 40595' },
  { page: 'pesv_comite', to: '/pesv/comite',                     section: 'pesv',          keywords: 'comite csv actas reunion' },
  { page: 'pesv_plan',   to: '/pesv/plan',                       section: 'pesv',          keywords: 'plan anual objetivos acciones presupuesto' },
  { page: 'pesv_diagnostico', to: '/pesv/diagnostico',                section: 'pesv',          keywords: 'autoevaluacion linea base 24 estandares phva res 45295' },
  { page: 'pesv_tablero_ejecutivo', to: '/pesv/tablero',                    section: 'pesv',          keywords: 'tablero ejecutivo score sisi pesv supert export' },
  { page: 'pesv_reportar_incidente', to: '/pesv/reportar',                   section: 'pesv',          keywords: 'reportar incidente accidente comparendo movil gps foto conductor' },
  { page: 'pesv_auditorias', to: '/pesv/auditorias',                 section: 'pesv',          keywords: 'auditoria interna externa supert onac hallazgos paso 22' },
  { page: 'pesv_comunicaciones', to: '/pesv/comunicaciones',             section: 'pesv',          keywords: 'comunicaciones difusion politica lecciones acuse paso 1.8 24' },
  { page: 'pesv_contratistas', to: '/pesv/contratistas',               section: 'pesv',          keywords: 'contratistas terceros transportadores aliados paso 18' },
  { page: 'privacy',     to: '/privacy/log-pii',                 section: 'admin',        etiqueta: 'Log accesos PII',         keywords: 'pii ley 1581 habeas data accesos auditoria sic' },
  { page: 'pesv_jornadas', to: '/pesv/jornadas',                   section: 'pesv',          keywords: 'jornada conductor decreto 1079 horas conduccion alarmas' },
  { page: 'pesv_mi_jornada', to: '/pesv/mi-jornada',                 section: 'pesv',          keywords: 'jornada conductor abrir cerrar pausa descanso' },
  { page: 'pesv_rutas',  to: '/pesv/rutas',                      section: 'pesv',          keywords: 'ruta caracterizacion waypoint riesgo trimestral pernocta paso 4' },
  { page: 'pesv_pernocta', to: '/pesv/pernocta',                   section: 'pesv',          keywords: 'pernocta parqueo seguro zona certificada' },
  { page: 'pesv_raci',     to: '/pesv/raci',                       section: 'pesv',          keywords: 'responsabilidades raci responsible accountable consulted informed paso 1.5' },
  { page: 'pesv_normativa',to: '/pesv/normativa',                  section: 'pesv',          keywords: 'normativa leyes decretos resoluciones tracker revision paso 1.7' },
  { page: 'pesv_retencion',to: '/pesv/retencion',                  section: 'pesv',          keywords: 'retencion archivo ley 594 paso 19 purga anonimizar' },
  { page: 'rndc',        to: '/rndc',                            section: 'rndc',          keywords: 'mintransporte registro nacional carga' },
  { page: 'rndc',        to: '/rndc/remesas',                    section: 'rndc',         etiqueta: 'Remesas',                 keywords: 'remesa carga manifiesto' },
  { page: 'rndc',        to: '/rndc/manifiestos',                section: 'rndc',         etiqueta: 'Manifiestos',             keywords: 'manifiesto electrónico carga MN' },
  { page: 'rndc',        to: '/rndc/maestros',                   section: 'rndc',         etiqueta: 'Maestros RNDC',           keywords: 'catálogos maestros tipos' },
  { page: 'rndc_admin',  to: '/rndc/admin/credenciales',         section: 'rndc',          keywords: 'usuario clave qr ws' },
  { page: 'laft',        to: '/laft',                            section: 'laft',          keywords: 'lavado activos terrorismo sarlaft' },
  { page: 'laft_unusual',to: '/laft/unusual',                    section: 'laft',          keywords: 'sospechoso ros sirel uiaf' },
  { page: 'laft_trainings', to: '/laft/trainings',               section: 'laft',          keywords: 'curso lavado activos' },
  { page: 'laft_manual',    to: '/laft/manual',                   section: 'laft',          keywords: 'manual sarlaft version publicado pdf' },
  { page: 'laft_oficial',   to: '/laft/oficial',                  section: 'laft',          keywords: 'oficial cumplimiento principal suplente iso 17024' },
  { page: 'laft_audit_plan',to: '/laft/plan-auditorias',          section: 'laft',          keywords: 'plan auditoria interna externa sarlaft' },
  { page: 'laft_dashboard', to: '/laft/tablero',                  section: 'laft',          keywords: 'tablero dashboard indicadores kpi cumplimiento' },
  { page: 'users',       to: '/users',                           section: 'admin',         keywords: 'admin usuarios roles permisos' },
  { page: 'roles_permisos', to: '/roles-permisos',               section: 'admin',         keywords: 'roles permisos funciones cuadro' },
  { page: 'drive',       to: '/drive',                           section: 'admin',         keywords: 'archivos drive folder' },
  { page: 'privacy',     to: '/privacy',                         section: 'admin',         keywords: 'ley 1581 forget anonimizar' },
  // Credenciales de Siigo (HU #11890) — en `admin` y NO en `finanzas`, donde viven las otras dos
  // pantallas del módulo, por dos motivos que no son de gusto:
  //
  //   1. El backend YA promete esta ruta por escrito, dos veces: `siigo.diagnostico.service.ts` y
  //      `siigo.catalogos.service.ts` dicen «Regístralas en **Administración › Integración con
  //      Siigo**». Con `section: 'admin'` y este `label`, lo que el usuario lee en el mensaje es
  //      exactamente lo que ve en el menú — sin tocar ni una cadena del API.
  //   2. La sección Finanzas la puebla `financiera`, que NO puede usar esta pantalla (el router
  //      exige `admin` entero). Un ítem visible solo para `admin` entre los suyos invita a pedir
  //      «acceso a esa de ahí» y a conceder un permiso roto.
  //
  // Sin campo `roles`: el slug ya restringe, y repetir la regla la pondría en dos sitios que pueden
  // divergir. Las `keywords` traen «siigo» y «facturacion electronica» para que el Command Palette
  // siga ofreciendo las tres pantallas juntas, que es lo único que se pierde al cambiar de sección.
  { page: 'siigo_credenciales', to: '/siigo/credenciales',        section: 'admin',         keywords: 'siigo credenciales access key llave token integracion facturacion electronica dian ambiente pruebas produccion conexion probar cifrado' },
];
