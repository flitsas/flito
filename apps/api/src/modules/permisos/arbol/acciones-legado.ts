// HU #13429 (Feature #13416 F3, ADR-0025; diseño §5-quater.2-4) — Qué conceden los ítems ANTIGUOS del nivel 2
// (los 46 de `packages/shared-types/src/permisos-arbol/legado.ts`), qué operaciones quedan sueltas y qué
// transitorios «Administrar <ítem>» se retiran.
//
// Regla de expansión (§5-quater.3): un ítem antiguo efectivo concede (a) sus transitorios (AC3: ganancia
// aprobada) y (b) sus operaciones permanentes que hoy tiene TODO rol con el ítem. La permanente que solo
// tiene una parte de quienes tienen el ítem es OPCIONAL del ítem (P-26: nadie la gana). Una operación puede
// estar en varios ítems (la Bandeja de trámites conserva las `tramite.*` que usa su rol). Todo lo que entra en
// algún ítem queda absorbido: deja de concederse directo (la 0239 borra sus filas); las guardas no cambian.
//
// PESV — decisión A1 de David sobre P-24 (2026-10-13): los 20 ítems PESV con operaciones NO expanden; llevan
// una acción de nivel 3 «Administrar» (`accion.pesv_<x>.administrar`) que absorbe sus transitorios. La reparte
// la 0239 por una regla de DATO, sin nombres de rol: la recibe quien hoy tiene ALGUNA administración PESV
// (`alguna` sobre la familia entera) y además el ítem (`exigeItem`). Así compliance, supervisor_flota y
// lider_pesv ganan lo aprobado en los ítems que ya tienen, y quien no administraba nada de PESV (hoy, el
// conductor) conserva sus pantallas sin ganar la administración.
import type { AccionArbol } from './acciones-gestion.js';

/** Las 26 administraciones transitorias de PESV (pesv.*, drivers.*, jornadas, rutas): la familia de A1. */
export const FAMILIA_ADMINISTRACION_PESV: readonly string[] = [
  'drivers.alcoholimetria.administrar', 'drivers.capacitaciones.administrar', 'drivers.checklists.administrar',
  'drivers.conductores.administrar', 'drivers.emergencias.administrar', 'drivers.incidentes.administrar',
  'drivers.incidentes_registro.administrar', 'jornadas.control.administrar',
  'pesv.auditorias.administrar', 'pesv.comite.administrar', 'pesv.comunicaciones.administrar', 'pesv.contratistas.administrar',
  'pesv.diagnostico.administrar', 'pesv.diagnostico_consulta.administrar', 'pesv.incidentes_causa_raiz.administrar',
  'pesv.normativa.administrar', 'pesv.normativa_edicion.administrar', 'pesv.plan.administrar', 'pesv.politica.administrar',
  'pesv.politica_edicion.administrar', 'pesv.raci.administrar', 'pesv.retencion.administrar', 'pesv.retencion_edicion.administrar',
  'pesv.tablero_ejecutivo.administrar', 'rutas.pernocta.administrar', 'rutas.rutas.administrar',
];

/** Lo que absorbe la acción «Administrar» de cada ítem PESV (tabla de §5-quater.3). */
const ADMINISTRACION_PESV: Readonly<Record<string, readonly string[]>> = {
  pesv_tablero_ejecutivo: ['pesv.tablero_ejecutivo.administrar'],
  pesv_diagnostico: ['pesv.diagnostico.administrar', 'pesv.diagnostico_consulta.administrar'],
  pesv_comite: ['pesv.comite.administrar'],
  pesv_plan: ['pesv.plan.administrar'],
  pesv_politica: ['pesv.politica.administrar', 'pesv.politica_edicion.administrar'],
  pesv_auditorias: ['pesv.auditorias.administrar'],
  pesv_comunicaciones: ['pesv.comunicaciones.administrar'],
  pesv_contratistas: ['pesv.contratistas.administrar'],
  pesv_incidentes: ['pesv.incidentes_causa_raiz.administrar', 'drivers.incidentes.administrar', 'drivers.incidentes_registro.administrar'],
  pesv_raci: ['pesv.raci.administrar'],
  pesv_normativa: ['pesv.normativa.administrar', 'pesv.normativa_edicion.administrar'],
  pesv_retencion: ['pesv.retencion.administrar', 'pesv.retencion_edicion.administrar'],
  pesv_conductores: ['drivers.conductores.administrar'],
  pesv_capacitaciones: ['drivers.capacitaciones.administrar'],
  pesv_checklists: ['drivers.checklists.administrar'],
  pesv_alcoholimetria: ['drivers.alcoholimetria.administrar'],
  pesv_emergencias: ['drivers.emergencias.administrar'],
  pesv_jornadas: ['jornadas.control.administrar'],
  pesv_rutas: ['rutas.rutas.administrar'],
  pesv_pernocta: ['rutas.pernocta.administrar'],
};

/** Las 20 acciones «Administrar» de PESV (A1). */
export const ACCIONES_LEGADO: Readonly<Record<string, AccionArbol>> = Object.fromEntries(
  Object.entries(ADMINISTRACION_PESV).map(([slug, operaciones]) => [`accion.${slug}.administrar`, {
    operaciones, predecesores: FAMILIA_ADMINISTRACION_PESV, alguna: true, exigeItem: true,
  } satisfies AccionArbol]),
);

/** Las `tramite.*` que hoy usa la Bandeja de trámites (su rol no tiene Trámite Digital): la Bandeja las conserva. */
const TRAMITE_DE_LA_BANDEJA: readonly string[] = [
  'tramite.checklist.sugerir', 'tramite.checklist.ver', 'tramite.cola.ver', 'tramite.contrato.generar', 'tramite.documentos.borrar',
  'tramite.documentos.cargar', 'tramite.documentos.descargar', 'tramite.documentos.listar', 'tramite.embudo.ver',
  'tramite.estadisticas.ver_metricas', 'tramite.estadisticas.ver_resumen', 'tramite.expediente.descargar', 'tramite.fur.generar',
  'tramite.improntas.generar', 'tramite.impuesto.consultar', 'tramite.lote.confirmar', 'tramite.lote.crear',
  'tramite.lote.descargar_plantilla', 'tramite.lote.listar', 'tramite.lote.previsualizar', 'tramite.lote.procesar_async',
  'tramite.lote.ver', 'tramite.lote.ver_estado', 'tramite.metricas.ver_gestor', 'tramite.motivos_rechazo.ver',
  'tramite.notificaciones.ver_config', 'tramite.participantes.invitar', 'tramite.participantes.ver_pendientes',
  'tramite.participantes.verificar_enlace', 'tramite.preflight.accionar', 'tramite.preflight.evaluar', 'tramite.preflight.ver',
  'tramite.tipologias.ver', 'tramite.tramite.cambiar_estado', 'tramite.tramite.crear', 'tramite.tramite.editar',
  'tramite.tramite.rechazar_ot', 'tramite.tramite.ver', 'tramite.tramite.ver_historial',
];

/** Las `tramite.*` que solo da Trámite Digital (las 51 = la Bandeja + estas 12). */
const TRAMITE_SOLO_DIGITAL: readonly string[] = [
  'tramite.identidad.certificar', 'tramite.identidad.iniciar', 'tramite.identidad.iniciar_partes', 'tramite.identidad.seguir',
  'tramite.identidad.ver_documentos', 'tramite.identidad.ver_estado', 'tramite.lote.descargar_resultados', 'tramite.lote.reprocesar',
  'tramite.metricas.ver_resumen', 'tramite.ocr.descargar', 'tramite.ocr.leer', 'tramite.tramite.forzar_continuar',
];

export interface ItemLegado { operaciones: readonly string[]; opcionales?: readonly string[] }

/**
 * Lo que EXPANDE cada ítem antiguo efectivo (sin los PESV con «Administrar», que lo hacen por su acción). Las
 * claves son los 46 ítems; vacío = la pantalla y nada más.
 */
export const ITEMS_LEGADO_OPS: Readonly<Record<string, ItemLegado>> = {
  'pagina.vehicles': { operaciones: ['vehicles.vehiculos.administrar'], opcionales: ['vehicles.propietario.ver_documento'] },
  'pagina.tramite': { operaciones: [...TRAMITE_DE_LA_BANDEJA, ...TRAMITE_SOLO_DIGITAL, 'firma.solicitud.administrar', 'firma.estado.ver'] },
  'pagina.soat': { operaciones: ['soat.antiguo.administrar'], opcionales: ['soat.antiguo.operar'] },
  'pagina.tax_reader': { operaciones: [] },
  'pagina.transito': {
    operaciones: [
      'transito.bandeja.ver_pendientes', 'transito.bandeja.ver_propios', 'transito.organismos.listar', 'transito.placa.asignar',
      'transito.placa.confirmar', 'transito.tramite.tomar', 'transito.traspasos.listar', 'transito.traspasos.ver',
      ...TRAMITE_DE_LA_BANDEJA, 'firma.estado.ver',
    ],
  },
  'pagina.fleet': { operaciones: ['fleet.flota.administrar'] },
  'pagina.maintenance_inicio': { operaciones: ['maintenance.inicio.administrar'] },
  // P-14: el pago manual de una orden de trabajo es de Órdenes de trabajo.
  'pagina.maintenance_ordenes': { operaciones: ['maintenance.ordenes.administrar', 'liquidacion.pago_manual.administrar'] },
  'pagina.maintenance_indicadores': { operaciones: [] },
  'pagina.maintenance': { operaciones: [] },
  'pagina.pesv': { operaciones: [] },
  'pagina.pesv_siniestralidad': { operaciones: [] },
  'pagina.pesv_indicadores_operacion': { operaciones: [] },
  'pagina.pesv_reportar_incidente': { operaciones: [] },
  'pagina.pesv_mi_jornada': { operaciones: [] },
  ...Object.fromEntries(Object.keys(ADMINISTRACION_PESV).map((slug) => [`pagina.${slug}`, { operaciones: [] }])),
  'pagina.rndc': { operaciones: ['rndc.manifiestos.administrar'] },
  'pagina.rndc_admin': { operaciones: ['rndc.credenciales.administrar'] },
  'pagina.laft': {
    operaciones: [
      'laft.listas.operar', 'laft.listas.administrar', 'laft.contrapartes.operar', 'laft.bitacora.ver', 'laft.efectivo.operar',
      'laft.empleados.operar', 'laft.retencion.administrar', 'laft.sincronizacion.ver', 'laft.sincronizacion.administrar',
    ],
  },
  'pagina.laft_unusual': { operaciones: ['laft.inusuales.operar', 'laft.ros.operar', 'laft.ros.exportar'] },
  'pagina.laft_trainings': { operaciones: ['laft.capacitaciones.operar'] },
  'pagina.laft_manual': { operaciones: ['laft.manual.administrar'], opcionales: ['laft.manual.firmar'] },
  'pagina.laft_oficial': { operaciones: ['laft.oficial.administrar'] },
  'pagina.laft_audit_plan': { operaciones: ['laft.plan_auditoria.administrar'] },
  'pagina.laft_dashboard': { operaciones: ['laft.tablero.ver'] },
  // P-27: Privacidad y Log accesos PII son la misma página.
  'pagina.privacy': { operaciones: ['privacy.titulares.operar', 'privacy.olvido.administrar', 'privacy.accesos_pii.ver'] },
  'pagina.drive': { operaciones: ['drive.archivos.administrar'] },
};

/**
 * HU #13588 (P-35/P-36, decisión de David del 2026-10-15: «si un permiso está en varios módulos, debería
 * aparecer en cada uno») — la consulta de vehículos y su pasaporte la usan Vehículos, SOAT (antiguo, validador
 * por lotes), Flota (pestaña Pasaporte de `/fleet/:id`) y Trámite Digital («Pasaporte VIN»): es operación de
 * los cuatro ítems.
 */
const CONSULTAR_VEHICULOS = 'vehicles.vehiculos.consultar';

/** HU #13588 — Las búsquedas del wizard de Trámite Digital (Traspaso cuelga de él, sin ítem propio). */
const BUSQUEDAS_DEL_TRAMITE: readonly string[] = ['runt.persona.consultar', 'runt.cedula.leer', 'integraciones.fasecolda.buscar'];

/**
 * HU #13588 — Las operaciones que la #13429 dejó TRANSVERSALES (P-29) y que ahora concede su ítem antiguo. Van
 * aparte de `ITEMS_LEGADO_OPS` porque ese mapa es la entrada del bloque generado de la 0239 (ya aplicada): el
 * reparto de estas lo hace la 0240. Para el resolutor y el catálogo son operaciones del ítem como las demás.
 */
export const OPERACIONES_INCORPORADAS_13588: Readonly<Record<string, readonly string[]>> = {
  'pagina.vehicles': [CONSULTAR_VEHICULOS],
  'pagina.soat': [CONSULTAR_VEHICULOS],
  'pagina.fleet': [CONSULTAR_VEHICULOS],
  'pagina.tramite': [CONSULTAR_VEHICULOS, ...BUSQUEDAS_DEL_TRAMITE],
};

/** Los 43 transitorios «Administrar <ítem>» que esta HU retira (los de la familia PESV, por su acción). */
export const TRANSITORIOS_RETIRADOS: readonly string[] = [...new Set([
  ...FAMILIA_ADMINISTRACION_PESV,
  ...Object.values(ITEMS_LEGADO_OPS).flatMap((i) => i.operaciones.filter((o) => /\.administrar$/.test(o))),
])].sort();
