// HU #12873 (Feature #13416, ADR-0025) — Qué OPERACIONES concede cada acción de Gestión y Tránsito.
//
// Las guardas del API no cambian: siguen pidiendo la operación (`exigirFuncion('soat.cola.ver')`). Lo
// que cambia es quién la tiene: desde la migración 0233 ninguna de estas operaciones se concede
// directamente; la tiene quien tenga una acción efectiva que la contenga (`arbol/expansion.ts`).
//
// `operaciones` son también los PREDECESORES del paso «todos los del grupo» (P-1): la acción se le
// concede al rol/usuario que tenía TODAS. `apoyo` se expande pero no es predecesor (no exige tenerla
// para recibir la acción). `lectura` (PO, 2026-10-13): la acción solo consulta y se recibe con ALGUNA
// de sus operaciones. `opcionales` (P-9 revisada): ni predecesor ni expansión; siguen concediéndose
// directo (`logistica.actas.operar_ajenas`: entregar actas AJENAS sigue siendo aparte). Las claves de página (`pagina.flito_compuerta`) son códigos que la acción
// también expande: la compuerta deja de ser ítem y su pantalla la abre «Entregar trámites» (P-10).
//
// Lo que NO está aquí, y por qué (P-9, decisiones del 2026-10-09): `soat.solicitud.subsanar`,
// `soat.revision.validar/rechazar` y `soat.causales.ver` no existen como operación en el código (no
// hay guarda que las pida); se mapearían a «Gestionar solicitudes» / «Ver por validar» / «Ver el
// listado» el día que existan. Autogestión y empresa son de Clientes (#13428): `FUERA_DE_AREA_GESTION`.

export interface AccionArbol {
  /** Operaciones (y páginas absorbidas) que la acción concede y que son su grupo «todos». */
  operaciones: readonly string[];
  /** Operaciones que también concede pero que no se exigen para recibirla. */
  apoyo?: readonly string[];
  /**
   * Decisión del PO del 2026-10-13: acción de LECTURA = las «Ver …» del catálogo aprobado (consulta en
   * pantalla). En el paso se recibe con ALGUNA de las operaciones viejas, no con todas. Las de descarga y
   * exportación NO lo son (AC7 de los soportes en ZIP: la auditoría no descarga). Explícito aquí, nunca
   * deducido del nombre; la lista literal la vigila `permisos-arbol-gestion.test.ts`.
   */
  lectura?: true;
  /**
   * Decisión del PO del 2026-10-13 (P-9): operaciones OPCIONALES de la acción. No son predecesor, la
   * acción NO las expande y NO se absorben: siguen concediéndose directo (su marca de rol y sus
   * excepciones no se tocan). Quien no las tenía sigue sin tenerlas aunque reciba o se le marque la acción.
   */
  opcionales?: readonly string[];
  /**
   * HU #13427 (diseño §5-bis.1): el grupo del PASO cuando no es `operaciones`. Hace falta cuando la acción
   * concede operaciones NUEVAS (una guarda vieja partida en varias) cuyo código viejo es quien decide
   * quién la recibe; o cuando el predecesor es una página (`pagina.*`), que no se absorbe. Por defecto,
   * `operaciones`.
   */
  predecesores?: readonly string[];
  /**
   * HU #13428 (diseño §5-ter.1 punto 3, P-22): la acción se reparte a TODOS los roles existentes (fila a
   * fila de `permisos_roles`, sin literales), junto con la página de su ítem, y no por un grupo. Se
   * declara con `predecesores: []`. La CTE de usuarios no la toca (nadie la tenía revocada: no existía).
   */
  repartoUniversal?: true;
  /**
   * HU #13429 (P-24, A1): en el paso basta ALGUNO de los predecesores, como en las de lectura, sin que la acción
   * sea de lectura («Administrar» de PESV: la recibe quien hoy administra algo de PESV).
   */
  alguna?: true;
  /**
   * HU #13429 (P-24, A1): en el paso, además del grupo, hay que tener la PÁGINA del ítem de la acción. Sin esto la
   * acción quedaría marcada bajo un ítem que el rol no tiene y se activaría sola el día que se lo marquen.
   */
  exigeItem?: true;
}

export const ACCIONES_GESTION: Readonly<Record<string, AccionArbol>> = {
  // ── Gestión Trámites ──
  'accion.tramites.ver_listado': { lectura: true, operaciones: ['tramites.cola.ver', 'tramites.cola.filtrar', 'tramites.tramite.ver_historial'] },
  'accion.tramites.solicitar_soat': { operaciones: ['tramites.solicitud.pedir_soat'] },
  'accion.tramites.solicitar_impuestos': { operaciones: ['tramites.solicitud.pedir_impuestos'] },
  'accion.tramites.descargar_soportes': { operaciones: ['tramites.soportes.descargar', 'tramites.tramite.ver_soportes'] },
  'accion.tramites.sincronizar': { operaciones: ['sync.sync.ver_estado'] }, // HU #13631: sin `sync.sync.lanzar` (retirada)
  'accion.tramites.configurar_sincronizacion': {
    operaciones: ['tramites.sincronizacion.configurar', 'tramites.flit2.ver_acceso', 'tramites.flit2.guardar_acceso'],
  },
  'accion.tramites.crear_demo': { operaciones: ['tramites.demo.sembrar'] },
  'accion.tramites.entregar': {
    operaciones: ['tramites.tramite.entregar', 'compuerta.cola.ver', 'compuerta.tramite.ver', 'compuerta.tramite.entregar', 'pagina.flito_compuerta'],
  },
  // ── SOAT ──
  'accion.soat.ver_listado': { lectura: true, operaciones: ['soat.cola.ver', 'soat.cola.filtrar', 'soat.solicitud.ver', 'soat.solicitud.ver_historial'] },
  'accion.soat.ver_soportes': { lectura: true, operaciones: ['soat.solicitud.ver_soportes'] },
  'accion.soat.cargar_comprobantes': { operaciones: ['soat.comprobante.cargar', 'soat.masiva.cargar'] },
  'accion.soat.exportar': { operaciones: ['soat.excel.exportar'] },
  'accion.soat.exportar_pago': { operaciones: ['soat.excel.exportar_pago'] },
  'accion.soat.cambiar_proveedor': { operaciones: ['soat.proveedor.cambiar'] },
  // La excepción nombrada de ADR-0024 / #12874 sigue en la guarda de `soat.solicitud.crear`.
  'accion.soat.solicitar_sin_tramite': { operaciones: ['soat.solicitud.crear', 'soat.runt.preconsultar', 'soat.factura.leer'] },
  'accion.soat.gestionar_solicitudes': {
    operaciones: ['soat.solicitud.enviar', 'soat.solicitud.asumir', 'soat.solicitud.devolver', 'soat.solicitud.reactivar', 'soat.solicitud.reversar', 'soat.solicitud.rechazar'],
  },
  // PO 2026-10-13: de lectura; reintentar el RUNT (coste externo) es OPCIONAL: quien no lo tenía no lo gana.
  'accion.soat.ver_por_validar': { lectura: true, operaciones: ['soat.incompletas.buscar', 'soat.incompleta.ver'], opcionales: ['soat.solicitud.reintentar_runt'] },
  'accion.soat.descargar_zip': { operaciones: ['soat.soportes.descargar'] },
  // AC7: 1:1, conservan exactamente su reparto y sus excepciones.
  'accion.soat.ver_documentos_adicionales': { lectura: true, operaciones: ['soat.documentos_adicionales.ver'] },
  'accion.soat.cargar_documentos_adicionales': { operaciones: ['soat.documentos_adicionales.cargar'] },
  'accion.soat.eliminar_documentos_adicionales': { operaciones: ['soat.documentos_adicionales.eliminar'] },
  // ── Impuestos ──
  // La factura de venta (P-6) es un DOCUMENTO con datos del titular (`GET /:id/factura-venta` sirve el
  // PDF): en una acción de lectura es OPCIONAL, como exportar/descargar. Quien la tenía la conserva.
  'accion.impuestos.ver_listado': { lectura: true,
    operaciones: ['impuestos.cola.ver', 'impuestos.cola.filtrar', 'impuestos.tramite.ver', 'impuestos.tramite.ver_historial'],
    opcionales: ['impuestos.factura.ver'],
  },
  'accion.impuestos.ver_soportes': { lectura: true, operaciones: ['impuestos.tramite.ver_soportes'] },
  'accion.impuestos.cargar_comprobantes': { operaciones: ['impuestos.recibos.cargar'] },
  'accion.impuestos.exportar': { operaciones: ['impuestos.excel.exportar'] },
  'accion.impuestos.exportar_pago': { operaciones: ['impuestos.excel.exportar_pago'] },
  'accion.impuestos.descargar_zip': { operaciones: ['impuestos.soportes.descargar'] },
  'accion.impuestos.gestionar_solicitudes': {
    operaciones: ['impuestos.tramite.enviar', 'impuestos.tramite.asumir', 'impuestos.tramite.devolver', 'impuestos.tramite.reactivar', 'impuestos.tramite.reversar', 'impuestos.tramite.rechazar'],
  },
  'accion.impuestos.certificar_runt': { operaciones: ['impuestos.tramite.certificar', 'impuestos.tramite.certificar_lote'] },
  'accion.impuestos.cargar_recibo_caja': { operaciones: ['impuestos.recibos.cargar_caja'] },
  'accion.impuestos.reemplazar_comprobante': { operaciones: ['impuestos.recibos.reemplazar'] },
  'accion.impuestos.corregir_direccion': { operaciones: ['impuestos.tramite.corregir_direccion'] },
  'accion.impuestos.descargar_certificado': { operaciones: ['impuestos.certificado.descargar'] },
  // ── Derechos ──
  'accion.derechos.ver_listado': { lectura: true, operaciones: ['derechos.cola.ver', 'derechos.cola.filtrar'] },
  'accion.derechos.cargar': { operaciones: ['derechos.recibos.cargar', 'derechos.candidatos.ver'] },
  'accion.derechos.procesar_drive': { operaciones: ['derechos.drive.listar', 'derechos.drive.procesar', 'derechos.drive.ver_registro'] },
  // Es una DESCARGA (una sola operación): no es de lectura (PO, 2026-10-13); con una sola, «todos» = «alguna».
  'accion.derechos.ver_soportes': { operaciones: ['derechos.soporte.descargar'] },
  // ── Revisiones OCR (P-7) ──
  // PO 2026-10-13: en las de lectura, descargar/exportar es OPCIONAL (quien lo tenía lo conserva; nadie lo gana).
  'accion.revisiones.ver': { lectura: true, operaciones: ['revisiones.cola.ver', 'revisiones.campos.ver'], opcionales: ['revisiones.soporte.descargar'] },
  'accion.revisiones.revisar_lecturas': { operaciones: ['revisiones.revision.resolver', 'revisiones.revision.descartar'] },
  // ── Logística ──
  'accion.logistica.ver_consola': { lectura: true, operaciones: ['logistica.consola.ver', 'logistica.consola.filtrar', 'logistica.documento.ver'], opcionales: ['logistica.motivos.gestionar'] }, // + gestionar motivos de llegada (HU #14119): se concede aparte
  'accion.logistica.registrar_viajes': { operaciones: ['logistica.viajes.ver', 'logistica.viajes.registrar', 'logistica.viajes.quitar'] },
  'accion.logistica.generar_actas': { operaciones: ['logistica.lt.validar'] },
  'accion.logistica.ver_actas': { lectura: true, operaciones: ['logistica.actas.listar', 'logistica.actas.ver'], opcionales: ['logistica.actas.descargar', 'logistica.actas.ver_documento_firmante'] }, // + ver_documento_firmante (HU #14110): PII, se concede aparte
  'accion.logistica.despachar_entregar_devolver': {
    // PO 2026-10-13: despachar y operar ajenas son OPCIONALES: el mensajero recibe la acción (entregar y
    // devolver) sin despachar ni operar actas ajenas; quien las tenía las conserva como marca directa.
    operaciones: ['logistica.actas.entregar', 'logistica.actas.devolver'],
    opcionales: ['logistica.actas.despachar', 'logistica.actas.operar_ajenas'],
  },
  'accion.logistica.cerrar_lote': { operaciones: ['logistica.lote.cerrar'] },
  'accion.logistica.reversar_paso': { operaciones: ['logistica.documento.reversar'], opcionales: ['logistica.documento.resolver_tramite', 'logistica.traslado.anular'] }, // + resolver el trámite (HU #14143); + anular viaje (HU #14115): se conceden aparte
  // ── Mi ruta (P-8) ── el mensajero abre el documento desde su ruta: `documento.ver` es de apoyo.
  'accion.mi_ruta.ver': { lectura: true, operaciones: ['logistica.ruta.ver'], apoyo: ['logistica.documento.ver'] },
  'accion.mi_ruta.escanear': { operaciones: ['logistica.documento.escanear'], opcionales: ['logistica.recogida.confirmar', 'logistica.traslado.registrar'] }, // + confirmar recogida (HU #14110); + registrar viaje a cliente (HU #14114): se conceden aparte
  'accion.mi_ruta.reportar_novedad': { operaciones: ['logistica.documento.reportar_novedad'] },
  // ── Comparendos ──
  'accion.comparendos.ver_listado': { lectura: true,
    operaciones: ['comparendos.registros.listar', 'comparendos.registros.buscar', 'comparendos.registro.ver', 'comparendos.registro.ver_eventos'],
    opcionales: ['comparendos.registros.exportar'],
  },
  'accion.comparendos.gestionar': { operaciones: ['comparendos.registro.gestionar'] },
  'accion.comparendos.sincronizar': { operaciones: ['comparendos.sync.lanzar', 'comparendos.sync.ver_corridas', 'comparendos.sync.ver_corrida'] },
  'accion.comparendos.configurar': {
    operaciones: [
      'comparendos.nits.listar', 'comparendos.nits.crear', 'comparendos.nits.editar', 'comparendos.nits.borrar',
      'comparendos.municipios.listar', 'comparendos.municipios.crear', 'comparendos.municipios.editar',
      'comparendos.causales.listar', 'comparendos.causales.crear', 'comparendos.causales.editar',
      'comparendos.simit.ver_token', 'comparendos.simit.guardar_token',
    ],
  },
  // ── Organismos STT (Tránsito) ──
  'accion.organismos_stt.ver': { lectura: true,
    operaciones: [
      'parametrizacion.organismos.listar', 'parametrizacion.organismos.ver_vigencias',
      'transito.config.listar', 'transito.config.ver', 'transito.logo.ver', 'transito.checklist.ver',
    ],
  },
  'accion.organismos_stt.editar': {
    operaciones: [
      'parametrizacion.organismos.editar', 'parametrizacion.organismos.fijar_modalidad',
      'transito.config.editar', 'transito.logo.cargar', 'transito.logo.borrar', 'transito.checklist.editar',
    ],
  },
};

/**
 * Operaciones que no concede UNA acción sino la CONJUNCIÓN de varias: «Solicitar SOAT e impuestos a la
 * vez» exige las dos acciones de solicitar (decisión del PO). La guarda de la ruta no cambia
 * (`tramites.solicitud.pedir_ambos`); el resolutor la incluye solo si ambas son efectivas.
 */
export const CONJUNCIONES_GESTION: readonly { operacion: string; acciones: readonly string[] }[] = [
  { operacion: 'tramites.solicitud.pedir_ambos', acciones: ['accion.tramites.solicitar_soat', 'accion.tramites.solicitar_impuestos'] },
];

/** El área de esta HU sobre `OPERACIONES_DECLARADAS` (AC6): prefijos del código, sin legacy. */
export const AREA_GESTION = /^(tramites|sync|compuerta|soat|impuestos|logistica|derechos|comparendos|revisiones)\.|^parametrizacion\.organismos\.|^transito\.(config|logo|checklist)\./;

/** Operaciones que el prefijo mete en el área pero son de otro ítem, con el destino. */
export const FUERA_DE_AREA_GESTION: Readonly<Record<string, string>> = {
  'tramites.autogestion.desbloquear': 'Clientes y proveedores (#13428)',
  'tramites.autogestion.revocar': 'Clientes y proveedores (#13428)',
  'tramites.empresa.crear': 'Clientes y proveedores (#13428)',
  'soat.antiguo.administrar': 'SOAT antiguo, legado (#13429)',
  'soat.antiguo.operar': 'SOAT antiguo, legado (#13429)',
};
