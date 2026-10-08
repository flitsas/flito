// HU #13421 (ADR-0023, Feature #13413) — Cómo se llama en el negocio cada operación de los módulos
// LEGACY que dejaron de decidir por `requireRole`: pesv/, drivers/, jornadas/ y rum/ (HU #13421); maintenance/,
// vehicles/, fleet/, rndc/, rutas/, liquidacion/, finanzas/ y clients/ (HU #13422).
//
// Misma regla que `catalogo-operaciones.ts` (de donde se concatena con un spread): la llave es la
// guarda real `<fichero> <MÉTODO> <ruta>` y el código lleva el prefijo del módulo del fichero
// (`FICHEROS_LEGADO_EN_ALCANCE`). Vive aparte por la regla de 800 líneas: #13422 y #13423 añaden aquí.
//
// Diferencia con el catálogo FLITO: aquí VARIAS guardas comparten código. Ver un ítem del menú es su
// página (`requirePage('pesv_<item>')`, fuera de este catálogo); lo que hoy exigía rol va detrás de
// un permiso TRANSITORIO «Administrar <ítem>» por ítem, que retira la HU #13429 (marca: sufijo
// `.administrar`). Cuando las guardas de un ítem exigían listas de roles distintas, el transitorio
// principal lleva la INTERSECCIÓN y cada lista más ancha va a un segundo transitorio del mismo ítem
// (`<item>_<accion>.administrar`): así nadie gana ni pierde (AC5). `catalogoDeOperaciones` exige
// que todas las guardas de un mismo código tengan el mismo nombre y el mismo reparto.
import type { OperacionDeclarada } from './catalogo-operaciones.js';

const PESV_EXP = 'pesv/export.routes.ts';
const PESV_EXD = 'pesv/export-diagnostico.routes.ts';
const PESV_DIA = 'pesv/diagnostico.routes.ts';
const PESV_EVI = 'pesv/diagnostico-evidencias.routes.ts';
const PESV_COM = 'pesv/comite.routes.ts';
const PESV_PLA = 'pesv/plan.routes.ts';
const PESV_POL = 'pesv/policy.routes.ts';
const PESV_HUE = 'pesv/huerfanos.routes.ts';
const PESV_RAC = 'pesv/raci.routes.ts';
const PESV_NOR = 'pesv/normativa.routes.ts';
const PESV_RET = 'pesv/retencion.routes.ts';
const DRV = 'drivers/drivers.routes.ts';
const DRV_DOC = 'drivers/documents.routes.ts';
const DRV_CAP = 'drivers/trainings.routes.ts';
const DRV_INC = 'drivers/incidents.routes.ts';
const DRV_CHK = 'drivers/checklists.routes.ts';
const DRV_ALC = 'drivers/alcohol.routes.ts';
const DRV_EME = 'drivers/emergency.routes.ts';
const JOR = 'jornadas/jornadas.routes.ts';
const RUM = 'rum/rum.routes.ts';
// HU #13422
const MAIN_CATALOG = 'maintenance/catalog.routes.ts';
const MAIN_ROUTINES = 'maintenance/routines.routes.ts';
const MAIN_SCHEDULE = 'maintenance/schedule.routes.ts';
const MAIN_PARTS = 'maintenance/parts.routes.ts';
const MAIN_PREORDERS = 'maintenance/preorders.routes.ts';
const MAIN_WORKORDERS = 'maintenance/workorders.routes.ts';
const VEHI_VEHICLES = 'vehicles/vehicles.routes.ts';
const VEHI_OCR = 'vehicles/ocr.routes.ts';
const FLEE_VEHICLES = 'fleet/vehicles.routes.ts';
const FLEE_LINKS = 'fleet/links.routes.ts';
const FLEE_DOCUMENTS = 'fleet/documents.routes.ts';
const RNDC_CREDENCIALES = 'rndc/credenciales.routes.ts';
const RNDC_MANIFIESTOS = 'rndc/manifiestos.routes.ts';
const RUTA_ROUTES = 'rutas/routes.routes.ts';
const RUTA_RISK = 'rutas/risk.routes.ts';
const RUTA_PERNOCTA = 'rutas/pernocta.routes.ts';
const LIQU_LIQUIDACION = 'liquidacion/liquidacion.routes.ts';
const FINA_FINANZAS = 'finanzas/finanzas.routes.ts';
const CLIE_CLIENTS = 'clients/clients.routes.ts';

/** Nombre y descripción de cada código: uno por código, no por guarda (las guardas lo comparten). */
export const NOMBRES_LEGADO: Readonly<Record<string, { nombre: string; descripcion: string }>> = {
  'pesv.tablero_ejecutivo.administrar': transitorio('Tablero ejecutivo PESV'),
  'pesv.diagnostico.administrar': transitorio('Diagnóstico PESV'),
  'pesv.diagnostico_consulta.administrar': transitorio('Diagnóstico PESV', 'consultar', 'el preflight, el historial por estándar, las evidencias y los expedientes exportados'),
  'pesv.comite.administrar': transitorio('Comité Seguridad Vial'),
  'pesv.plan.administrar': transitorio('Plan Anual PESV'),
  'pesv.politica.administrar': transitorio('Política PSV'),
  'pesv.politica_edicion.administrar': transitorio('Política PSV', 'crear, editar y firmar', 'crear, editar y firmar la política'),
  'pesv.auditorias.administrar': transitorio('Auditorías PESV'),
  'pesv.comunicaciones.administrar': transitorio('Comunicaciones'),
  'pesv.contratistas.administrar': transitorio('Contratistas'),
  'pesv.incidentes_causa_raiz.administrar': transitorio('Incidentes', 'causa raíz', 'registrar la causa raíz de un incidente'),
  'pesv.raci.administrar': transitorio('Matriz RACI'),
  'pesv.normativa.administrar': transitorio('Tracker normativo'),
  'pesv.normativa_edicion.administrar': transitorio('Tracker normativo', 'crear, editar y revisar', 'crear, editar y marcar como revisada una norma'),
  'pesv.retencion.administrar': transitorio('Retención documental'),
  'pesv.retencion_edicion.administrar': transitorio('Retención documental', 'crear y editar políticas', 'crear y editar políticas de retención'),
  'drivers.conductores.administrar': transitorio('Conductores'),
  'drivers.capacitaciones.administrar': transitorio('Capacitaciones'),
  'drivers.incidentes.administrar': transitorio('Incidentes'),
  'drivers.incidentes_registro.administrar': transitorio('Incidentes', 'registrar', 'registrar un incidente desde la consola'),
  'drivers.checklists.administrar': transitorio('Checklists'),
  'drivers.alcoholimetria.administrar': transitorio('Alcoholimetría'),
  'drivers.emergencias.administrar': transitorio('Emergencias'),
  'jornadas.control.administrar': transitorio('Control Jornada (admin)'),
  // Permanente (no transitoria): el resumen RUM no cuelga de ningún ítem del menú PESV.
  'rum.resumen.ver': {
    nombre: 'Ver el resumen de rendimiento web (RUM)',
    descripcion: 'Leer las métricas Web Vitals agregadas (p75 por métrica, ruta y dispositivo) que reportan los navegadores.',
  },  // HU #13422 (ADR-0023): los ocho directorios de operación. Todas sus guardas de rol `admin` van a un
  // transitorio por ítem del menú; las dos `LECTURA` (admin, auditor, financiera) y el documento del
  // propietario son permanentes: no son «administrar», son leer.
  'maintenance.inicio.administrar': transitorio('Mantenimiento'),
  'maintenance.ordenes.administrar': transitorio('Órdenes de trabajo'),
  'liquidacion.pago_manual.administrar': transitorio('Órdenes de trabajo', 'liquidación y pago manual', 'liquidar y confirmar el pago manual de una orden'),
  'vehicles.vehiculos.administrar': transitorio('Vehículos'),
  'vehicles.propietario.ver_documento': {
    nombre: 'Ver el documento completo del propietario',
    descripcion: 'En el listado de vehículos, ver el número de documento del propietario sin enmascarar.',
  },
  'fleet.flota.administrar': transitorio('Flota'),
  'rndc.credenciales.administrar': transitorio('Credenciales RNDC'),
  'rndc.manifiestos.administrar': transitorio('Manifiestos', undefined, 'encolar y reintentar el envío al RNDC (y recibir el aviso del envío fallido)'),
  'rutas.rutas.administrar': transitorio('Rutas operativas'),
  'rutas.pernocta.administrar': transitorio('Zonas de pernocta'),
  'finanzas.reporte_costos.ver': {
    nombre: 'Ver el reporte de costos',
    descripcion: 'Leer y exportar el reporte de costos, su consolidado, su facturación electrónica y los soportes y viajes de un trámite.',
  },
  'clients.clientes.ver': {
    nombre: 'Ver clientes y proveedores',
    descripcion: 'Leer el listado de clientes y proveedores.',
  },
  'clients.clientes.administrar': transitorio('Clientes y proveedores'),
};

/** «Administrar <label del menú>» (y « — <acción>» si es el segundo transitorio del ítem). */
function transitorio(label: string, accion?: string, que?: string): { nombre: string; descripcion: string } {
  return {
    nombre: accion ? `Administrar ${label} — ${accion}` : `Administrar ${label}`,
    descripcion: `Transitorio (retira la HU #13429): ${que ?? 'acciones administrativas'} de «${label}».`,
  };
}

function op(llave: string, codigo: string): OperacionDeclarada {
  const n = NOMBRES_LEGADO[codigo];
  if (!n) throw new Error(`catalogo-operaciones.legado: «${codigo}» sin nombre en NOMBRES_LEGADO`);
  return { llave, codigo, nombre: n.nombre, descripcion: n.descripcion };
}

export const OPERACIONES_DECLARADAS_LEGADO: OperacionDeclarada[] = [
  op(`${PESV_EXP} POST /sisi`, 'pesv.tablero_ejecutivo.administrar'),
  op(`${PESV_EXD} GET /diagnostico/:id/estandar/:codigo`, 'pesv.diagnostico_consulta.administrar'),
  op(`${PESV_EXD} GET /diagnostico/:id`, 'pesv.diagnostico_consulta.administrar'),
  op(`${PESV_DIA} POST /`, 'pesv.diagnostico.administrar'),
  op(`${PESV_DIA} PATCH /:id/items/:estandarId`, 'pesv.diagnostico.administrar'),
  op(`${PESV_DIA} GET /:id/preflight`, 'pesv.diagnostico_consulta.administrar'),
  op(`${PESV_DIA} POST /:id/cerrar`, 'pesv.diagnostico.administrar'),
  op(`${PESV_DIA} GET /:id/items/:estandarId/historial`, 'pesv.diagnostico_consulta.administrar'),
  // HU #13425: en línea en el detalle (antes, por nombre de rol).
  op(`${PESV_DIA} GET /:id [vistaAuditoria]`, 'pesv.diagnostico_consulta.administrar'),
  op(`${PESV_DIA} GET /:id [sugerirAuditoria]`, 'pesv.diagnostico.administrar'),
  op(`${PESV_EVI} POST /:id/items/:estandarId/evidencias`, 'pesv.diagnostico.administrar'),
  op(`${PESV_EVI} DELETE /:id/items/:estandarId/evidencias/:keyHash`, 'pesv.diagnostico.administrar'),
  op(`${PESV_EVI} GET /:id/items/:estandarId/evidencias/:keyHash`, 'pesv.diagnostico_consulta.administrar'),
  op(`${PESV_COM} POST /`, 'pesv.comite.administrar'),
  op(`${PESV_COM} POST /:id/miembros`, 'pesv.comite.administrar'),
  op(`${PESV_COM} DELETE /:id/miembros/:userId`, 'pesv.comite.administrar'),
  op(`${PESV_COM} POST /:id/actas`, 'pesv.comite.administrar'),
  op(`${PESV_COM} PATCH /:id/actas/:actaId`, 'pesv.comite.administrar'),
  op(`${PESV_COM} POST /:id/actas/:actaId/cerrar`, 'pesv.comite.administrar'),
  op(`${PESV_PLA} POST /`, 'pesv.plan.administrar'),
  op(`${PESV_PLA} PATCH /:id`, 'pesv.plan.administrar'),
  op(`${PESV_PLA} POST /:id/aprobar`, 'pesv.plan.administrar'),
  op(`${PESV_PLA} POST /:id/objetivos`, 'pesv.plan.administrar'),
  op(`${PESV_PLA} POST /objetivos/:objId/acciones`, 'pesv.plan.administrar'),
  op(`${PESV_PLA} PATCH /acciones/:accId`, 'pesv.plan.administrar'),
  op(`${PESV_POL} POST /`, 'pesv.politica_edicion.administrar'),
  op(`${PESV_POL} PATCH /:id`, 'pesv.politica_edicion.administrar'),
  op(`${PESV_POL} POST /:id/firmar`, 'pesv.politica_edicion.administrar'),
  op(`${PESV_POL} DELETE /:id`, 'pesv.politica.administrar'),
  op(`${PESV_HUE} POST /auditorias`, 'pesv.auditorias.administrar'),
  op(`${PESV_HUE} POST /auditorias/:id/cerrar`, 'pesv.auditorias.administrar'),
  op(`${PESV_HUE} POST /auditorias/:id/hallazgos`, 'pesv.auditorias.administrar'),
  op(`${PESV_HUE} POST /hallazgos/:hallazgoId/cerrar`, 'pesv.auditorias.administrar'),
  op(`${PESV_HUE} POST /comunicaciones`, 'pesv.comunicaciones.administrar'),
  op(`${PESV_HUE} POST /comunicaciones/:id/publicar`, 'pesv.comunicaciones.administrar'),
  op(`${PESV_HUE} POST /contratistas`, 'pesv.contratistas.administrar'),
  op(`${PESV_HUE} PATCH /contratistas/:id`, 'pesv.contratistas.administrar'),
  op(`${PESV_HUE} PATCH /incidents/:id/causa-raiz`, 'pesv.incidentes_causa_raiz.administrar'),
  op(`${PESV_RAC} POST /`, 'pesv.raci.administrar'),
  op(`${PESV_RAC} PATCH /:id(\\\\d+)`, 'pesv.raci.administrar'),
  op(`${PESV_RAC} DELETE /:id(\\\\d+)`, 'pesv.raci.administrar'),
  op(`${PESV_RAC} PUT /proceso`, 'pesv.raci.administrar'),
  op(`${PESV_NOR} POST /`, 'pesv.normativa_edicion.administrar'),
  op(`${PESV_NOR} PATCH /:id(\\\\d+)`, 'pesv.normativa_edicion.administrar'),
  op(`${PESV_NOR} POST /:id(\\\\d+)/revisar`, 'pesv.normativa_edicion.administrar'),
  op(`${PESV_NOR} DELETE /:id(\\\\d+)`, 'pesv.normativa.administrar'),
  op(`${PESV_RET} POST /politicas`, 'pesv.retencion_edicion.administrar'),
  op(`${PESV_RET} PATCH /politicas/:id(\\\\d+)`, 'pesv.retencion_edicion.administrar'),
  op(`${PESV_RET} DELETE /politicas/:id(\\\\d+)`, 'pesv.retencion.administrar'),
  op(`${PESV_RET} POST /run`, 'pesv.retencion.administrar'),
  op(`${DRV} POST /`, 'drivers.conductores.administrar'),
  op(`${DRV} PATCH /:id/profile`, 'drivers.conductores.administrar'),
  op(`${DRV} DELETE /:id`, 'drivers.conductores.administrar'),
  op(`${DRV} GET /candidates/non-driver`, 'drivers.conductores.administrar'),
  op(`${DRV_DOC} POST /`, 'drivers.conductores.administrar'),
  op(`${DRV_DOC} PATCH /:id`, 'drivers.conductores.administrar'),
  op(`${DRV_DOC} DELETE /:id`, 'drivers.conductores.administrar'),
  op(`${DRV_CAP} POST /`, 'drivers.capacitaciones.administrar'),
  op(`${DRV_CAP} PATCH /:id`, 'drivers.capacitaciones.administrar'),
  op(`${DRV_CAP} POST /:id/attendees`, 'drivers.capacitaciones.administrar'),
  op(`${DRV_CAP} PATCH /:id/attendees/:userId`, 'drivers.capacitaciones.administrar'),
  op(`${DRV_INC} POST /`, 'drivers.incidentes_registro.administrar'),
  op(`${DRV_INC} PATCH /:id`, 'drivers.incidentes.administrar'),
  op(`${DRV_INC} POST /:id/actions`, 'drivers.incidentes.administrar'),
  op(`${DRV_INC} PATCH /:id/actions/:actionId`, 'drivers.incidentes.administrar'),
  op(`${DRV_INC} POST /:id/close`, 'drivers.incidentes.administrar'),
  op(`${DRV_CHK} POST /:id/anular`, 'drivers.checklists.administrar'),
  op(`${DRV_ALC} POST /`, 'drivers.alcoholimetria.administrar'),
  op(`${DRV_ALC} POST /:id/levantar-suspension`, 'drivers.alcoholimetria.administrar'),
  op(`${DRV_EME} POST /contacts`, 'drivers.emergencias.administrar'),
  op(`${DRV_EME} PATCH /contacts/:id`, 'drivers.emergencias.administrar'),
  op(`${DRV_EME} DELETE /contacts/:id`, 'drivers.emergencias.administrar'),
  op(`${DRV_EME} POST /protocols`, 'drivers.emergencias.administrar'),
  op(`${DRV_EME} POST /drills`, 'drivers.emergencias.administrar'),
  op(`${JOR} GET /`, 'jornadas.control.administrar'),
  op(`${JOR} POST /alarmas/:alarmaId/ack`, 'jornadas.control.administrar'),
  op(`${JOR} POST /reporte-mensual/regenerar`, 'jornadas.control.administrar'),
  // HU #13425: en línea (`operaJornadaAjena`) para las 6 rutas de «jornada de otro conductor».
  op(`${JOR} POST /abrir [jornadaAjena]`, 'jornadas.control.administrar'),
  op(`${RUM} GET /summary`, 'rum.resumen.ver'),  // HU #13422 (ADR-0023)
  op(`${MAIN_CATALOG} POST /systems`, 'maintenance.inicio.administrar'),
  op(`${MAIN_CATALOG} POST /subsystems`, 'maintenance.inicio.administrar'),
  op(`${MAIN_CATALOG} POST /jobs`, 'maintenance.inicio.administrar'),
  op(`${MAIN_CATALOG} PATCH /jobs/:id`, 'maintenance.inicio.administrar'),
  op(`${MAIN_CATALOG} PATCH /mechanics/:userId`, 'maintenance.inicio.administrar'),
  op(`${MAIN_ROUTINES} POST /`, 'maintenance.inicio.administrar'),
  op(`${MAIN_ROUTINES} PATCH /:id`, 'maintenance.inicio.administrar'),
  op(`${MAIN_ROUTINES} POST /:id/jobs`, 'maintenance.inicio.administrar'),
  op(`${MAIN_ROUTINES} DELETE /:id/jobs/:jobId`, 'maintenance.inicio.administrar'),
  op(`${MAIN_ROUTINES} POST /:id/parts`, 'maintenance.inicio.administrar'),
  op(`${MAIN_ROUTINES} DELETE /:id/parts/:partId`, 'maintenance.inicio.administrar'),
  op(`${MAIN_ROUTINES} POST /:id/periodicity`, 'maintenance.inicio.administrar'),
  op(`${MAIN_ROUTINES} DELETE /:id/periodicity/:periodId`, 'maintenance.inicio.administrar'),
  op(`${MAIN_SCHEDULE} POST /`, 'maintenance.inicio.administrar'),
  op(`${MAIN_SCHEDULE} PATCH /:id/cancel`, 'maintenance.inicio.administrar'),
  op(`${MAIN_SCHEDULE} POST /recompute`, 'maintenance.inicio.administrar'),
  op(`${MAIN_PARTS} POST /locations`, 'maintenance.inicio.administrar'),
  op(`${MAIN_PARTS} POST /`, 'maintenance.inicio.administrar'),
  op(`${MAIN_PARTS} PATCH /:id`, 'maintenance.inicio.administrar'),
  op(`${MAIN_PARTS} POST /movements`, 'maintenance.inicio.administrar'),
  op(`${MAIN_PREORDERS} POST /`, 'maintenance.ordenes.administrar'),
  op(`${MAIN_PREORDERS} POST /:id/jobs`, 'maintenance.ordenes.administrar'),
  op(`${MAIN_PREORDERS} POST /:id/parts`, 'maintenance.ordenes.administrar'),
  op(`${MAIN_PREORDERS} POST /:id/approve`, 'maintenance.ordenes.administrar'),
  op(`${MAIN_PREORDERS} POST /:id/generate-ot`, 'maintenance.ordenes.administrar'),
  op(`${MAIN_WORKORDERS} POST /`, 'maintenance.ordenes.administrar'),
  op(`${MAIN_WORKORDERS} POST /:id/jobs`, 'maintenance.ordenes.administrar'),
  op(`${MAIN_WORKORDERS} POST /:id/parts`, 'maintenance.ordenes.administrar'),
  op(`${MAIN_WORKORDERS} POST /:id/otros-gastos`, 'maintenance.ordenes.administrar'),
  op(`${MAIN_WORKORDERS} POST /:id/seguimiento`, 'maintenance.ordenes.administrar'),
  op(`${MAIN_WORKORDERS} POST /:id/close-tecnica`, 'maintenance.ordenes.administrar'),
  op(`${MAIN_WORKORDERS} POST /:id/close-final`, 'maintenance.ordenes.administrar'),
  op(`${MAIN_WORKORDERS} POST /:id/anular`, 'maintenance.ordenes.administrar'),
  op(`${VEHI_VEHICLES} POST /`, 'vehicles.vehiculos.administrar'),
  op(`${VEHI_VEHICLES} PATCH /:id`, 'vehicles.vehiculos.administrar'),
  op(`${VEHI_VEHICLES} POST /upload`, 'vehicles.vehiculos.administrar'),
  op(`${VEHI_VEHICLES} GET /export`, 'vehicles.vehiculos.administrar'),
  op(`${VEHI_VEHICLES} DELETE /:id`, 'vehicles.vehiculos.administrar'),
  op(`${VEHI_VEHICLES} PATCH /:id/multas`, 'vehicles.vehiculos.administrar'),
  op(`${VEHI_VEHICLES} PATCH /:id/stage`, 'vehicles.vehiculos.administrar'),
  op(`${VEHI_VEHICLES} PATCH /:id/client`, 'vehicles.vehiculos.administrar'),
  op(`${VEHI_VEHICLES} GET /pipeline/stats`, 'vehicles.vehiculos.administrar'),
  op(`${VEHI_VEHICLES} GET / [documentoCompleto]`, 'vehicles.propietario.ver_documento'),
  op(`${VEHI_OCR} POST /ocr`, 'vehicles.vehiculos.administrar'),
  op(`${VEHI_OCR} POST /ocr-export`, 'vehicles.vehiculos.administrar'),
  op(`${VEHI_OCR} POST /ocr-import`, 'vehicles.vehiculos.administrar'),
  op(`${FLEE_VEHICLES} POST /`, 'fleet.flota.administrar'),
  op(`${FLEE_VEHICLES} PATCH /:id`, 'fleet.flota.administrar'),
  op(`${FLEE_VEHICLES} POST /:id/convert`, 'fleet.flota.administrar'),
  op(`${FLEE_LINKS} POST /`, 'fleet.flota.administrar'),
  op(`${FLEE_LINKS} PATCH /:id/close`, 'fleet.flota.administrar'),
  op(`${FLEE_DOCUMENTS} POST /types`, 'fleet.flota.administrar'),
  op(`${FLEE_DOCUMENTS} PATCH /types/:id`, 'fleet.flota.administrar'),
  op(`${FLEE_DOCUMENTS} POST /`, 'fleet.flota.administrar'),
  op(`${FLEE_DOCUMENTS} PATCH /:id`, 'fleet.flota.administrar'),
  op(`${FLEE_DOCUMENTS} DELETE /:id`, 'fleet.flota.administrar'),
  op(`${RNDC_CREDENCIALES} GET /`, 'rndc.credenciales.administrar'),
  op(`${RNDC_CREDENCIALES} POST /`, 'rndc.credenciales.administrar'),
  op(`${RNDC_CREDENCIALES} DELETE /:id`, 'rndc.credenciales.administrar'),
  op(`${RNDC_MANIFIESTOS} POST /:id/encolar-envio`, 'rndc.manifiestos.administrar'),
  op(`${RNDC_MANIFIESTOS} POST /:id/reintentar-envio`, 'rndc.manifiestos.administrar'),
  op(`${RUTA_ROUTES} POST /`, 'rutas.rutas.administrar'),
  op(`${RUTA_ROUTES} PATCH /:id`, 'rutas.rutas.administrar'),
  op(`${RUTA_ROUTES} POST /:id/waypoints`, 'rutas.rutas.administrar'),
  op(`${RUTA_ROUTES} PATCH /waypoints/:wpId`, 'rutas.rutas.administrar'),
  op(`${RUTA_ROUTES} DELETE /waypoints/:wpId`, 'rutas.rutas.administrar'),
  op(`${RUTA_ROUTES} POST /:id/waypoints/reorder`, 'rutas.rutas.administrar'),
  op(`${RUTA_RISK} POST /`, 'rutas.rutas.administrar'),
  op(`${RUTA_RISK} POST /:id/aprobar`, 'rutas.rutas.administrar'),
  op(`${RUTA_RISK} POST /:id/items`, 'rutas.rutas.administrar'),
  op(`${RUTA_RISK} PATCH /items/:itemId`, 'rutas.rutas.administrar'),
  op(`${RUTA_RISK} DELETE /items/:itemId`, 'rutas.rutas.administrar'),
  op(`${RUTA_PERNOCTA} POST /pernocta`, 'rutas.pernocta.administrar'),
  op(`${RUTA_PERNOCTA} PATCH /pernocta/:id`, 'rutas.pernocta.administrar'),
  op(`${RUTA_PERNOCTA} DELETE /pernocta/:id`, 'rutas.pernocta.administrar'),
  op(`${RUTA_PERNOCTA} POST /assignments`, 'rutas.pernocta.administrar'),
  op(`${RUTA_PERNOCTA} DELETE /assignments/:id`, 'rutas.pernocta.administrar'),
  op(`${LIQU_LIQUIDACION} POST /`, 'liquidacion.pago_manual.administrar'),
  op(`${LIQU_LIQUIDACION} GET /`, 'liquidacion.pago_manual.administrar'),
  op(`${LIQU_LIQUIDACION} GET /:id`, 'liquidacion.pago_manual.administrar'),
  op(`${LIQU_LIQUIDACION} POST /:id/confirmar-pago`, 'liquidacion.pago_manual.administrar'),
  op(`${FINA_FINANZAS} GET /reporte-costos`, 'finanzas.reporte_costos.ver'),
  op(`${FINA_FINANZAS} GET /reporte-costos/facetas`, 'finanzas.reporte_costos.ver'),
  op(`${FINA_FINANZAS} GET /reporte-costos/facturacion-electronica`, 'finanzas.reporte_costos.ver'),
  op(`${FINA_FINANZAS} GET /reporte-costos/consolidado`, 'finanzas.reporte_costos.ver'),
  op(`${FINA_FINANZAS} POST /reporte-costos/export`, 'finanzas.reporte_costos.ver'),
  op(`${FINA_FINANZAS} POST /reporte-costos/consolidado/export`, 'finanzas.reporte_costos.ver'),
  op(`${FINA_FINANZAS} GET /tramites/:id/soportes`, 'finanzas.reporte_costos.ver'),
  op(`${FINA_FINANZAS} GET /tramites/:id/viajes-logistica`, 'finanzas.reporte_costos.ver'),
  op(`${CLIE_CLIENTS} GET /`, 'clients.clientes.ver'),
  op(`${CLIE_CLIENTS} POST /`, 'clients.clientes.administrar'),
  op(`${CLIE_CLIENTS} PATCH /:id`, 'clients.clientes.administrar'),
];
