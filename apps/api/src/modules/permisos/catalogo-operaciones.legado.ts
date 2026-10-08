// HU #13421 (ADR-0023, Feature #13413) — Cómo se llama en el negocio cada operación de los módulos
// LEGACY que dejaron de decidir por `requireRole`: pesv/, drivers/, jornadas/ y rum/.
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
  },
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
  op(`${RUM} GET /summary`, 'rum.resumen.ver'),
];
