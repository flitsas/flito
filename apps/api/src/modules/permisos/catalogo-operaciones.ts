// HU #12081 / #12083 — Cómo se llama en el negocio cada operación que una ruta exige con
// `exigirFuncion('<codigo>')`.
//
// Esta tabla es la mitad que ESCRIBE EL PRODUCTO (CF-23). La otra mitad —qué roles tenía cada
// operación el día de partida— está en la foto `inventario.generado.ts`, y aquí NO se repite ni un
// rol. Desde la #12083 el reparto vive en la base y se edita desde el panel; una función NUEVA entra
// aquí, en la foto y en una migración, las tres a la vez.
//
// La llave es `<fichero> <MÉTODO> <ruta>`, es decir la guarda REAL, y no el código de la función.
// Eso es lo que permite la comprobación de doble sentido del AC6: una guarda sin entrada aquí es un
// error («hay una operación que el catálogo no declara») y una entrada aquí sin guarda viva también
// («el catálogo declara algo que ya nadie usa»). Con la llave en el código de la función, renombrar
// una ruta habría pasado en silencio.
//
// Medido el 9/09/2026 con el lector de la #12081: 217 rutas guardadas en 21 ficheros; la #12083
// añadió 11 (dos de impuestos que el lector no veía, ocho de `users/` y una guarda en línea de
// trámites). Ningún número se escribe en un test: los tests comparan CONJUNTOS contra la foto y contra
// los montajes leídos del fuente, porque un número escrito a mano es justo lo que dejó nueve
// operaciones fuera del enunciado original de la #12081.

export interface OperacionDeclarada {
  /** `<fichero> <MÉTODO> <ruta>` — la guarda real. */
  llave: string;
  /** `<modulo>.<objeto>.<accion>`. El `<modulo>` debe coincidir con el del fichero en alcance. */
  codigo: string;
  /** Cómo se lee en la pantalla de permisos. */
  nombre: string;
  /** Qué habilita, en una frase. Nunca vacía (AC2). */
  descripcion: string;
}

const op = (llave: string, codigo: string, nombre: string, descripcion: string): OperacionDeclarada =>
  ({ llave, codigo, nombre, descripcion });

const SOAT = 'flito-soat/flito-soat.routes.ts';
const SOAT_CLI = 'flito-soat/flito-soat-cliente.routes.ts';
const IMP = 'flito-impuestos/flito-impuestos.routes.ts';
const DER = 'flito-derechos/flito-derechos.routes.ts';
const REV = 'flito-revisiones/flito-revisiones.routes.ts';
const COMP = 'flito-compuerta/flito-compuerta.routes.ts';
const TRA = 'flito-tramites/flito-tramites.routes.ts';
const TAB = 'flito-tablero/flito-tablero.routes.ts';
const BIT = 'flito-bitacora/flito-bitacora.routes.ts';
const LOG = 'flito-logistica/flito-logistica.routes.ts';
const BOL = 'flito-bolsas/flito-bolsas.routes.ts';
const CON = 'flito-conciliacion/flito-conciliacion.routes.ts';
const CMP = 'flito-comparendos/flito-comparendos.routes.ts';
const LIQ = 'flito-liquidacion/flito-liquidacion.routes.ts';
const PAR = 'flito-parametrizacion/flito-parametrizacion.routes.ts';
const SYN = 'flito-sync/flito-sync.routes.ts';
const TRD = 'tramites/tramites.routes.ts';
const OCR = 'tramites/ocr-docs.routes.ts';
const IDE = 'tramites/identidad.routes.ts';
const TRN = 'tramites/transito.routes.ts';
const TRC = 'tramites/transito-config.routes.ts';
const USR = 'users/users.routes.ts';
const PER = 'permisos/permisos.routes.ts';

export const OPERACIONES_DECLARADAS: OperacionDeclarada[] = [
  // ── SOAT (portal FLITO) ───────────────────────────────────────────────────────────────────────
  op(`${SOAT} GET /`, 'soat.cola.ver', 'Ver la cola de SOAT', 'Abrir la bandeja de solicitudes de SOAT y recorrer su listado.'),
  op(`${SOAT} GET /facetas`, 'soat.cola.filtrar', 'Filtrar la cola de SOAT', 'Leer los contadores y las facetas con las que se acota la bandeja.'),
  op(`${SOAT} POST /export`, 'soat.excel.exportar', 'Exportar la cola de SOAT a Excel', 'Descargar el listado filtrado como archivo de Excel.'),
  op(`${SOAT} POST /soportes/zip`, 'soat.soportes.descargar', 'Descargar soportes de SOAT en ZIP', 'Bajar en un solo archivo los soportes de las solicitudes seleccionadas.'),
  op(`${SOAT} GET /:id`, 'soat.solicitud.ver', 'Ver una solicitud de SOAT', 'Abrir el detalle de una solicitud concreta.'),
  op(`${SOAT} GET /:id/historial`, 'soat.solicitud.ver_historial', 'Ver el historial de una solicitud de SOAT', 'Consultar la línea de tiempo de cambios de estado de la solicitud.'),
  op(`${SOAT} GET /:id/soportes`, 'soat.solicitud.ver_soportes', 'Ver los soportes de una solicitud de SOAT', 'Listar y abrir los documentos adjuntos de la solicitud.'),
  op(`${SOAT} POST /enviar`, 'soat.solicitud.enviar', 'Enviar solicitudes de SOAT al gestor', 'Pasar solicitudes al proveedor para que las expida.'),
  op(`${SOAT} POST /:id/rechazar`, 'soat.solicitud.rechazar', 'Rechazar una solicitud de SOAT', 'Devolver la solicitud al origen indicando por qué no procede.'),
  op(`${SOAT} POST /:id/reactivar`, 'soat.solicitud.reactivar', 'Reactivar una solicitud de SOAT', 'Volver a poner en curso una solicitud rechazada o detenida.'),
  op(`${SOAT} POST /:id/reversar`, 'soat.solicitud.reversar', 'Reversar una solicitud de SOAT', 'Deshacer el último avance de estado de la solicitud.'),
  op(`${SOAT} POST /:id/proveedor`, 'soat.proveedor.cambiar', 'Cambiar el proveedor de una solicitud de SOAT', 'Reasignar la solicitud a otro gestor SOAT.'),
  op(`${SOAT} POST /:id/asumir-operaciones`, 'soat.solicitud.asumir', 'Asumir una solicitud de SOAT en Operaciones', 'Sacar la solicitud del gestor y trabajarla desde Operaciones.'),
  op(`${SOAT} POST /:id/devolver-gestor`, 'soat.solicitud.devolver', 'Devolver una solicitud de SOAT al gestor', 'Regresar al proveedor una solicitud que Operaciones había asumido.'),
  op(`${SOAT} POST /:id/factura`, 'soat.comprobante.cargar', 'Cargar el comprobante de un SOAT', 'Adjuntar a la solicitud la póliza o la factura de venta emitida.'),
  op(`${SOAT} POST /facturas`, 'soat.masiva.cargar', 'Cargar comprobantes de SOAT en lote', 'Subir varios comprobantes de una vez y repartirlos por solicitud.'),
  op(`${SOAT_CLI} POST /cliente/preconsulta`, 'soat.runt.preconsultar', 'Preconsultar un vehículo en el RUNT', 'Verificar en el RUNT los datos del vehículo antes de radicar.'),
  op(`${SOAT_CLI} POST /cliente`, 'soat.solicitud.crear', 'Radicar una solicitud de SOAT', 'Crear una solicitud de SOAT desde el canal del cliente.'),
  op(`${SOAT_CLI} POST /cliente/factura/lectura`, 'soat.factura.leer', 'Leer la factura de venta del vehículo', 'Extraer del PDF de la factura los datos del vehículo para prellenar la solicitud.'),

  // ── Impuestos ─────────────────────────────────────────────────────────────────────────────────
  op(`${IMP} GET /`, 'impuestos.cola.ver', 'Ver la cola de impuestos', 'Abrir la bandeja de trámites de impuesto vehicular.'),
  op(`${IMP} GET /facetas`, 'impuestos.cola.filtrar', 'Filtrar la cola de impuestos', 'Leer los contadores y las facetas con las que se acota la bandeja.'),
  op(`${IMP} POST /export`, 'impuestos.excel.exportar', 'Exportar la cola de impuestos a Excel', 'Descargar el listado filtrado como archivo de Excel.'),
  op(`${IMP} POST /soportes/zip`, 'impuestos.soportes.descargar', 'Descargar soportes de impuestos en ZIP', 'Bajar en un solo archivo los soportes de los trámites seleccionados.'),
  op(`${IMP} GET /:id`, 'impuestos.tramite.ver', 'Ver un trámite de impuestos', 'Abrir el detalle de un trámite concreto.'),
  op(`${IMP} GET /:id/historial`, 'impuestos.tramite.ver_historial', 'Ver el historial de un trámite de impuestos', 'Consultar la línea de tiempo de cambios de estado del trámite.'),
  op(`${IMP} GET /:id/soportes`, 'impuestos.tramite.ver_soportes', 'Ver los soportes de un trámite de impuestos', 'Listar y abrir los documentos adjuntos del trámite.'),
  op(`${IMP} GET /:id/factura-venta`, 'impuestos.factura.ver', 'Ver la factura de venta del trámite de impuestos', 'Abrir la factura de venta asociada al trámite.'),
  op(`${IMP} POST /:id/certificar`, 'impuestos.tramite.certificar', 'Certificar un trámite de impuestos', 'Dar por pagado y certificado el impuesto de un vehículo.'),
  op(`${IMP} POST /certificar`, 'impuestos.tramite.certificar_lote', 'Certificar trámites de impuestos en lote', 'Certificar de una vez todos los trámites seleccionados.'),
  op(`${IMP} GET /:id/certificado`, 'impuestos.certificado.descargar', 'Descargar el certificado de impuestos', 'Bajar el documento que acredita el pago del impuesto.'),
  op(`${IMP} POST /enviar`, 'impuestos.tramite.enviar', 'Enviar trámites de impuestos al gestor', 'Pasar trámites al gestor de impuestos del organismo.'),
  op(`${IMP} POST /:id/rechazar`, 'impuestos.tramite.rechazar', 'Rechazar un trámite de impuestos', 'Devolver el trámite al origen indicando por qué no procede.'),
  op(`${IMP} POST /:id/reactivar`, 'impuestos.tramite.reactivar', 'Reactivar un trámite de impuestos', 'Volver a poner en curso un trámite rechazado o detenido.'),
  op(`${IMP} POST /:id/reversar`, 'impuestos.tramite.reversar', 'Reversar un trámite de impuestos', 'Deshacer el último avance de estado del trámite.'),
  op(`${IMP} POST /:id/asumir-operaciones`, 'impuestos.tramite.asumir', 'Asumir un trámite de impuestos en Operaciones', 'Sacar el trámite del gestor del organismo y trabajarlo desde Operaciones (traspaso por contingencia).'),
  op(`${IMP} POST /:id/devolver-gestor`, 'impuestos.tramite.devolver', 'Devolver un trámite de impuestos al gestor', 'Regresar al gestor del organismo un trámite que Operaciones había asumido.'),
  op(`${IMP} POST /recibos`, 'impuestos.recibos.cargar', 'Cargar recibos de impuestos', 'Subir los recibos de pago y repartirlos por trámite.'),

  // ── Derechos de tránsito ──────────────────────────────────────────────────────────────────────
  op(`${DER} GET /`, 'derechos.cola.ver', 'Ver los derechos de tránsito', 'Abrir el listado de recibos de derechos cobrados por el organismo.'),
  op(`${DER} GET /facetas`, 'derechos.cola.filtrar', 'Filtrar los derechos de tránsito', 'Leer los contadores y las facetas del listado de derechos.'),
  op(`${DER} POST /cargar`, 'derechos.recibos.cargar', 'Cargar recibos de derechos de tránsito', 'Subir los archivos de recibos para que el sistema los lea y los cruce.'),
  op(`${DER} GET /drive/archivos`, 'derechos.drive.listar', 'Ver los archivos de derechos en Drive', 'Listar los recibos que esperan proceso en la carpeta de Drive.'),
  op(`${DER} GET /drive/registro`, 'derechos.drive.ver_registro', 'Ver el registro de proceso de Drive', 'Consultar qué archivos de Drive se procesaron y con qué resultado.'),
  op(`${DER} POST /drive/procesar`, 'derechos.drive.procesar', 'Procesar los recibos de Drive', 'Lanzar la lectura de los recibos pendientes en la carpeta de Drive.'),
  op(`${DER} GET /candidatos/:placa`, 'derechos.candidatos.ver', 'Ver los trámites candidatos de una placa', 'Consultar a qué trámites podría corresponder un recibo por su placa.'),
  op(`${DER} GET /soporte/:id`, 'derechos.soporte.descargar', 'Descargar el soporte de un derecho', 'Abrir el archivo del recibo de derechos.'),

  // ── Revisión OCR ──────────────────────────────────────────────────────────────────────────────
  op(`${REV} GET /`, 'revisiones.cola.ver', 'Ver la cola de revisión OCR', 'Abrir la bandeja de campos que el OCR dejó dudosos.'),
  op(`${REV} GET /campos/:modulo`, 'revisiones.campos.ver', 'Ver los campos revisables de un módulo', 'Consultar qué campos entran a revisión en cada módulo.'),
  op(`${REV} GET /soporte/:soporteId/archivo`, 'revisiones.soporte.descargar', 'Abrir el documento en revisión', 'Ver el archivo original del que salió el dato dudoso.'),
  op(`${REV} POST /:id/resolver`, 'revisiones.revision.resolver', 'Resolver una revisión OCR', 'Confirmar o corregir el valor leído y darlo por bueno.'),
  op(`${REV} POST /:id/descartar`, 'revisiones.revision.descartar', 'Descartar una revisión OCR', 'Cerrar la revisión sin cambiar el dato.'),

  // ── Compuerta de entrega ──────────────────────────────────────────────────────────────────────
  op(`${COMP} GET /`, 'compuerta.cola.ver', 'Ver la compuerta de entrega', 'Abrir el listado de trámites listos para entregar.'),
  op(`${COMP} GET /:tramiteId`, 'compuerta.tramite.ver', 'Ver un trámite en la compuerta', 'Consultar qué le falta a un trámite para poder entregarse.'),
  op(`${COMP} POST /:tramiteId/entregar`, 'compuerta.tramite.entregar', 'Entregar un trámite', 'Dar por entregado el trámite al cliente y cerrar la compuerta.'),

  // ── Trámites FLITO ────────────────────────────────────────────────────────────────────────────
  op(`${TRA} GET /`, 'tramites.cola.ver', 'Ver la cola de trámites FLITO', 'Abrir la bandeja de trámites de SOAT e impuestos.'),
  op(`${TRA} GET /facetas`, 'tramites.cola.filtrar', 'Filtrar la cola de trámites FLITO', 'Leer los contadores y las facetas de la bandeja.'),
  op(`${TRA} GET /:id/historial`, 'tramites.tramite.ver_historial', 'Ver el historial de un trámite FLITO', 'Consultar la línea de tiempo del trámite.'),
  op(`${TRA} GET /:id/soportes`, 'tramites.tramite.ver_soportes', 'Ver los soportes de un trámite FLITO', 'Listar y abrir los documentos del trámite.'),
  op(`${TRA} POST /soportes/zip`, 'tramites.soportes.descargar', 'Descargar soportes de trámites en ZIP', 'Bajar en un solo archivo los soportes de los trámites seleccionados.'),
  op(`${TRA} POST /crear-empresa`, 'tramites.empresa.crear', 'Crear una empresa cliente', 'Dar de alta la compañía a la que se le van a radicar trámites.'),
  op(`${TRA} POST /demo`, 'tramites.demo.sembrar', 'Sembrar datos de demostración', 'Crear trámites de ejemplo para mostrar el producto.'),
  op(`${TRA} POST /solicitar-soat`, 'tramites.solicitud.pedir_soat', 'Solicitar SOAT para un vehículo', 'Radicar un trámite de SOAT desde Operaciones.'),
  op(`${TRA} POST /solicitar-impuestos`, 'tramites.solicitud.pedir_impuestos', 'Solicitar impuestos para un vehículo', 'Radicar un trámite de impuesto vehicular desde Operaciones.'),
  op(`${TRA} POST /solicitar-ambos`, 'tramites.solicitud.pedir_ambos', 'Solicitar SOAT e impuestos a la vez', 'Radicar los dos trámites del vehículo en una sola operación.'),
  op(`${TRA} POST /entregar`, 'tramites.tramite.entregar', 'Entregar trámites FLITO', 'Marcar como entregados los trámites seleccionados.'),
  op(`${TRA} POST /:id/desbloquear-autogestion`, 'tramites.autogestion.desbloquear', 'Desbloquear la autogestión del cliente', 'Permitir que el cliente vuelva a radicar por su cuenta.'),
  op(`${TRA} POST /:id/revocar-autogestion`, 'tramites.autogestion.revocar', 'Revocar la autogestión del cliente', 'Quitarle al cliente la posibilidad de radicar por su cuenta.'),

  // ── Tablero y bitácora ────────────────────────────────────────────────────────────────────────
  op(`${TAB} GET /`, 'tablero.tablero.ver', 'Ver el tablero FLITO', 'Consultar los indicadores consolidados de la operación.'),
  op(`${BIT} GET /`, 'bitacora.bitacora.ver', 'Ver la bitácora', 'Consultar el registro de quién cambió qué y cuándo.'),
  op(`${BIT} GET /:resource/:resourceId`, 'bitacora.bitacora.ver_recurso', 'Ver la bitácora de un registro', 'Consultar el historial de auditoría de un registro concreto.'),

  // ── Logística ─────────────────────────────────────────────────────────────────────────────────
  op(`${LOG} GET /`, 'logistica.consola.ver', 'Ver la consola de logística', 'Abrir la trazabilidad de documentos en tránsito.'),
  op(`${LOG} GET /facetas`, 'logistica.consola.filtrar', 'Filtrar la consola de logística', 'Leer los contadores y las facetas de la consola.'),
  op(`${LOG} GET /:id`, 'logistica.documento.ver', 'Ver un documento en logística', 'Consultar el detalle y el recorrido de un documento.'),
  op(`${LOG} GET /mi-ruta`, 'logistica.ruta.ver', 'Ver mi ruta de mensajería', 'Consultar las recogidas y entregas asignadas al mensajero.'),
  op(`${LOG} GET /actas`, 'logistica.actas.listar', 'Ver las actas de logística', 'Listar las actas de despacho y entrega.'),
  op(`${LOG} GET /actas/:id`, 'logistica.actas.ver', 'Ver un acta de logística', 'Abrir el detalle de un acta y sus documentos.'),
  op(`${LOG} GET /actas/:id/pdf`, 'logistica.actas.descargar', 'Descargar el PDF de un acta', 'Bajar el acta firmada en formato PDF.'),
  op(`${LOG} POST /validar-lt`, 'logistica.lt.validar', 'Validar un número de guía', 'Comprobar que la guía de transporte existe y corresponde.'),
  op(`${LOG} POST /escanear`, 'logistica.documento.escanear', 'Escanear un documento en campo', 'Registrar el paso de un documento leyendo su código de barras.'),
  op(`${LOG} POST /documentos/:id/novedad`, 'logistica.documento.reportar_novedad', 'Reportar una novedad de entrega', 'Dejar constancia de que la entrega no se pudo completar y por qué.'),
  op(`${LOG} POST /cerrar-lote`, 'logistica.lote.cerrar', 'Cerrar un lote de logística', 'Dar por armado el lote de documentos que va a despacharse.'),
  op(`${LOG} POST /actas/:id/despachar`, 'logistica.actas.despachar', 'Despachar un acta', 'Poner en ruta el acta y sus documentos.'),
  op(`${LOG} POST /actas/:id/entregar`, 'logistica.actas.entregar', 'Entregar un acta', 'Registrar la entrega del acta en destino.'),
  op(`${LOG} POST /actas/:id/devolucion`, 'logistica.actas.devolver', 'Devolver un acta', 'Registrar que el acta vuelve sin haberse entregado.'),
  op(`${LOG} POST /documentos/:id/reversar`, 'logistica.documento.reversar', 'Reversar un paso de logística', 'Deshacer el último movimiento registrado sobre el documento.'),

  // ── Bolsas prepago ────────────────────────────────────────────────────────────────────────────
  op(`${BOL} GET /consolidado`, 'bolsas.consolidado.ver', 'Ver el consolidado de bolsas', 'Consultar el saldo agregado de todas las bolsas prepago.'),
  op(`${BOL} GET /riesgo`, 'bolsas.riesgo.ver', 'Ver el riesgo de saldo', 'Consultar qué bolsas están cerca de quedarse sin fondos.'),
  op(`${BOL} GET /alertas`, 'bolsas.alertas.ver', 'Ver las alertas de bolsas', 'Consultar los avisos de saldo bajo y de movimientos atípicos.'),
  op(`${BOL} GET /:companiaId`, 'bolsas.bolsa.ver', 'Ver la bolsa de una compañía', 'Consultar el saldo y el estado de la bolsa de un cliente.'),
  op(`${BOL} GET /:companiaId/movimientos`, 'bolsas.movimientos.ver', 'Ver los movimientos de una bolsa', 'Recorrer las entradas y salidas de dinero de la bolsa.'),
  op(`${BOL} POST /:companiaId/recargas`, 'bolsas.recarga.registrar', 'Registrar una recarga de bolsa', 'Abonar dinero a la bolsa del cliente con su soporte.'),
  op(`${BOL} GET /soportes/:soporteId`, 'bolsas.soporte.descargar', 'Descargar el soporte de un movimiento', 'Abrir el comprobante que respalda un movimiento de bolsa.'),
  op(`${BOL} GET /:companiaId/extracto`, 'bolsas.extracto.descargar', 'Descargar el extracto de una bolsa', 'Bajar el estado de cuenta de la bolsa del cliente.'),
  op(`${BOL} POST /:companiaId/movimientos-manuales`, 'bolsas.movimiento.registrar', 'Registrar un movimiento manual', 'Cargar a mano una entrada o salida que no vino de un trámite.'),
  op(`${BOL} POST /:companiaId/movimientos/:movimientoId/correccion`, 'bolsas.movimiento.corregir', 'Corregir un movimiento de bolsa', 'Rectificar un movimiento ya registrado dejando el rastro.'),
  op(`${BOL} GET /:companiaId/cierres`, 'bolsas.cierres.ver', 'Ver los cierres de una bolsa', 'Consultar los cortes de periodo ya cerrados.'),
  op(`${BOL} POST /:companiaId/cierres`, 'bolsas.cierre.crear', 'Cerrar un periodo de bolsa', 'Cuadrar y cerrar el periodo de la bolsa del cliente.'),
  op(`${BOL} GET /transito`, 'bolsas.transito.listar', 'Ver las bolsas de organismos', 'Listar las bolsas de derechos abiertas ante los organismos de tránsito.'),
  op(`${BOL} POST /transito`, 'bolsas.transito.crear', 'Crear una bolsa de organismo', 'Abrir una bolsa de derechos ante un organismo de tránsito.'),
  op(`${BOL} GET /transito/:bolsaId`, 'bolsas.transito.ver', 'Ver una bolsa de organismo', 'Consultar el saldo y el detalle de una bolsa de derechos.'),
  op(`${BOL} PATCH /transito/:bolsaId`, 'bolsas.transito.editar', 'Editar una bolsa de organismo', 'Cambiar los datos de la bolsa de derechos.'),
  op(`${BOL} GET /transito/:bolsaId/movimientos`, 'bolsas.transito.ver_movimientos', 'Ver los movimientos de una bolsa de organismo', 'Recorrer las cargas y consumos de la bolsa de derechos.'),
  op(`${BOL} POST /transito/:bolsaId/cargas`, 'bolsas.transito.cargar', 'Cargar saldo a una bolsa de organismo', 'Abonar dinero a la bolsa de derechos con su soporte.'),

  // ── Conciliación de recaudo SOAT ──────────────────────────────────────────────────────────────
  op(`${CON} POST /boletas`, 'conciliacion.boleta.cargar', 'Cargar una boleta de recaudo', 'Subir el archivo del portal con lo recaudado en el periodo.'),
  op(`${CON} GET /boletas`, 'conciliacion.boletas.listar', 'Ver las boletas de recaudo', 'Listar las boletas cargadas y su estado de conciliación.'),
  op(`${CON} GET /boletas/:id`, 'conciliacion.boleta.ver', 'Ver una boleta de recaudo', 'Abrir el cruce de una boleta contra lo emitido.'),
  op(`${CON} POST /boletas/:id/recruzar`, 'conciliacion.boleta.recruzar', 'Volver a cruzar una boleta', 'Repetir el cruce de la boleta tras corregir los datos.'),
  op(`${CON} POST /boletas/:id/conciliar`, 'conciliacion.boleta.conciliar', 'Conciliar una boleta', 'Dar por cuadrada la boleta y cerrarla.'),
  op(`${CON} POST /boletas/:id/descartar`, 'conciliacion.boleta.descartar', 'Descartar una boleta', 'Anular una boleta cargada por error.'),
  op(`${CON} POST /boletas/:id/comprobante`, 'conciliacion.comprobante.cargar', 'Cargar el comprobante de una boleta', 'Adjuntar el soporte de la consignación del recaudo.'),
  op(`${CON} PUT /boletas/:id/comprobante`, 'conciliacion.comprobante.reemplazar', 'Reemplazar el comprobante de una boleta', 'Sustituir el soporte de consignación por otro.'),
  op(`${CON} GET /boletas/:id/comprobante`, 'conciliacion.comprobante.descargar', 'Descargar el comprobante de una boleta', 'Abrir el soporte de la consignación del recaudo.'),

  // ── Comparendos ───────────────────────────────────────────────────────────────────────────────
  op(`${CMP} GET /nits`, 'comparendos.nits.listar', 'Ver los NIT vigilados', 'Listar las compañías a las que se les monitorean comparendos.'),
  op(`${CMP} POST /nits`, 'comparendos.nits.crear', 'Añadir un NIT vigilado', 'Poner una compañía bajo monitoreo de comparendos.'),
  op(`${CMP} PATCH /nits/:id`, 'comparendos.nits.editar', 'Editar un NIT vigilado', 'Cambiar los datos o el estado de un NIT monitoreado.'),
  op(`${CMP} DELETE /nits/:id`, 'comparendos.nits.borrar', 'Quitar un NIT vigilado', 'Sacar una compañía del monitoreo de comparendos.'),
  op(`${CMP} GET /municipios`, 'comparendos.municipios.listar', 'Ver los municipios consultados', 'Listar las fuentes municipales de comparendos configuradas.'),
  op(`${CMP} POST /municipios`, 'comparendos.municipios.crear', 'Añadir un municipio', 'Configurar una fuente municipal nueva de comparendos.'),
  op(`${CMP} PATCH /municipios/:id`, 'comparendos.municipios.editar', 'Editar un municipio', 'Cambiar la configuración o el estado de una fuente municipal.'),
  op(`${CMP} GET /causales`, 'comparendos.causales.listar', 'Ver las causales de comparendo', 'Consultar el catálogo de infracciones y su descripción.'),
  op(`${CMP} POST /causales`, 'comparendos.causales.crear', 'Añadir una causal de comparendo', 'Registrar una infracción nueva en el catálogo.'),
  op(`${CMP} PATCH /causales/:id`, 'comparendos.causales.editar', 'Editar una causal de comparendo', 'Corregir la descripción o el estado de una infracción.'),
  op(`${CMP} GET /config/token-simit`, 'comparendos.simit.ver_token', 'Ver el estado del acceso al SIMIT', 'Comprobar si hay credencial vigente para consultar el SIMIT.'),
  op(`${CMP} PUT /config/token-simit`, 'comparendos.simit.guardar_token', 'Guardar el acceso al SIMIT', 'Registrar la credencial con la que se consulta el SIMIT.'),
  op(`${CMP} POST /sync`, 'comparendos.sync.lanzar', 'Lanzar la consulta de comparendos', 'Disparar a mano la sincronización contra SIMIT y municipios.'),
  op(`${CMP} GET /sync/runs`, 'comparendos.sync.ver_corridas', 'Ver las corridas de sincronización', 'Listar las consultas hechas y cómo terminaron.'),
  op(`${CMP} GET /sync/runs/:id`, 'comparendos.sync.ver_corrida', 'Ver una corrida de sincronización', 'Abrir el detalle paso a paso de una consulta.'),
  op(`${CMP} GET /registros`, 'comparendos.registros.listar', 'Ver los comparendos', 'Recorrer los comparendos detectados en los NIT vigilados.'),
  op(`${CMP} POST /registros/buscar`, 'comparendos.registros.buscar', 'Buscar comparendos', 'Filtrar los comparendos por placa, NIT o documento.'),
  op(`${CMP} POST /registros/export`, 'comparendos.registros.exportar', 'Exportar comparendos', 'Descargar el listado filtrado de comparendos.'),
  op(`${CMP} GET /registros/:id`, 'comparendos.registro.ver', 'Ver un comparendo', 'Abrir el detalle de un comparendo concreto.'),
  op(`${CMP} GET /registros/:id/eventos`, 'comparendos.registro.ver_eventos', 'Ver los eventos de un comparendo', 'Consultar cómo ha cambiado el comparendo entre consultas.'),
  op(`${CMP} PATCH /registros/:id/gestion`, 'comparendos.registro.gestionar', 'Gestionar un comparendo', 'Anotar el estado de gestión y las observaciones del comparendo.'),

  // ── Liquidación ───────────────────────────────────────────────────────────────────────────────
  op(`${LIQ} GET /:tramiteId`, 'liquidacion.liquidacion.ver', 'Ver la liquidación de un trámite', 'Consultar los valores liquidados al trámite.'),
  op(`${LIQ} GET /:tramiteId/eventos`, 'liquidacion.liquidacion.ver_eventos', 'Ver los eventos de una liquidación', 'Consultar el historial de liquidación del trámite.'),
  op(`${LIQ} POST /:tramiteId/liquidar`, 'liquidacion.liquidacion.liquidar', 'Liquidar un trámite', 'Calcular y fijar lo que se le cobra al cliente por el trámite.'),
  op(`${LIQ} POST /lote/liquidar`, 'liquidacion.liquidacion.liquidar_lote', 'Liquidar trámites en lote', 'Liquidar de una vez todos los trámites seleccionados.'),
  op(`${LIQ} POST /:tramiteId/reversar`, 'liquidacion.liquidacion.reversar', 'Reversar una liquidación', 'Deshacer la liquidación de un trámite.'),
  op(`${LIQ} POST /:tramiteId/facturar`, 'liquidacion.liquidacion.facturar', 'Facturar un trámite liquidado', 'Emitir la factura del trámite ya liquidado.'),

  // ── Parametrización FLITO ─────────────────────────────────────────────────────────────────────
  op(`${PAR} GET /companias`, 'parametrizacion.companias.listar', 'Ver las compañías cliente', 'Consultar las compañías dadas de alta y su configuración.'),
  op(`${PAR} PATCH /companias/:id`, 'parametrizacion.companias.editar', 'Editar una compañía cliente', 'Cambiar la configuración comercial y operativa de la compañía.'),
  op(`${PAR} GET /proveedores-soat`, 'parametrizacion.proveedores.listar', 'Ver los proveedores SOAT', 'Consultar los gestores SOAT registrados.'),
  op(`${PAR} POST /proveedores-soat`, 'parametrizacion.proveedores.crear', 'Añadir un proveedor SOAT', 'Registrar un gestor SOAT nuevo.'),
  op(`${PAR} PATCH /proveedores-soat/:id`, 'parametrizacion.proveedores.editar', 'Editar un proveedor SOAT', 'Cambiar los datos o el estado de un gestor SOAT.'),
  op(`${PAR} GET /organismos`, 'parametrizacion.organismos.listar', 'Ver los organismos de tránsito', 'Consultar los organismos y su parametrización FLITO.'),
  op(`${PAR} GET /organismos/:codigo/vigencias`, 'parametrizacion.organismos.ver_vigencias', 'Ver las vigencias de un organismo', 'Consultar los periodos de tarifas y modalidades del organismo.'),
  op(`${PAR} POST /organismos/:codigo/modalidad`, 'parametrizacion.organismos.fijar_modalidad', 'Fijar la modalidad de un organismo', 'Definir cómo se paga a ese organismo a partir de una fecha.'),
  op(`${PAR} PATCH /organismos/:codigo`, 'parametrizacion.organismos.editar', 'Editar un organismo de tránsito', 'Cambiar la parametrización FLITO del organismo.'),
  op(`${PAR} GET /tarifas`, 'parametrizacion.tarifas.listar', 'Ver las tarifas', 'Consultar lo que se le cobra a cada compañía por cada concepto.'),
  op(`${PAR} POST /tarifas`, 'parametrizacion.tarifas.crear', 'Crear una tarifa', 'Fijar el precio de un concepto para una compañía.'),
  op(`${PAR} PATCH /tarifas/:id`, 'parametrizacion.tarifas.editar', 'Editar una tarifa', 'Cambiar el precio o la vigencia de una tarifa.'),
  // HU #12373: `DELETE /tarifas/:id` (parametrizacion.tarifas.borrar) se retiró — una vigencia no se borra, se cierra.
  op(`${PAR} GET /tarifas/companias/:id`, 'parametrizacion.tarifas.ver_por_cliente', 'Ver las tarifas de una compañía', 'Consultar el valor vigente de cada concepto de una compañía y quién lo fijó.'),
  op(`${PAR} GET /tarifas/companias/:id/historial`, 'parametrizacion.tarifas.historial', 'Ver el historial de tarifas de una compañía', 'Consultar las vigencias pasadas y presentes de cada concepto, con quién las fijó y quién las cerró.'),

  // ── Sincronización FLITO ──────────────────────────────────────────────────────────────────────
  op(`${SYN} GET /estado`, 'sync.sync.ver_estado', 'Ver el estado de la sincronización', 'Consultar cuándo corrió la última sincronización y cómo fue.'),
  op(`${SYN} POST /sincronizar`, 'sync.sync.lanzar', 'Lanzar la sincronización', 'Disparar a mano la sincronización de datos FLITO.'),

  // ── Trámite Digital ───────────────────────────────────────────────────────────────────────────
  op(`${TRD} GET /`, 'tramite.cola.ver', 'Ver la cola de Trámite Digital', 'Abrir la bandeja de trámites de tránsito.'),
  op(`${TRD} GET /:id`, 'tramite.tramite.ver', 'Ver un trámite', 'Abrir el detalle de un trámite de tránsito.'),
  op(`${TRD} POST /`, 'tramite.tramite.crear', 'Crear un trámite', 'Radicar un trámite de tránsito nuevo.'),
  op(`${TRD} PATCH /:id`, 'tramite.tramite.editar', 'Editar un trámite', 'Corregir los datos de un trámite en curso.'),
  op(`${TRD} PATCH /:id [_forzarContinuar]`, 'tramite.tramite.forzar_continuar', 'Forzar la continuación de un trámite', 'Al editar, saltarse las validaciones que detendrían el trámite y dejarlo continuar bajo responsabilidad propia.'),
  op(`${TRD} PATCH /:id/estado`, 'tramite.tramite.cambiar_estado', 'Cambiar el estado de un trámite', 'Avanzar o retroceder el trámite en su flujo.'),
  op(`${TRD} GET /:id/timeline`, 'tramite.tramite.ver_historial', 'Ver el historial de un trámite', 'Consultar la línea de tiempo del trámite.'),
  op(`${TRD} GET /tipologias`, 'tramite.tipologias.ver', 'Ver las tipologías de trámite', 'Consultar el catálogo de tipos de trámite.'),
  op(`${TRD} GET /motivos-rechazo-ot`, 'tramite.motivos_rechazo.ver', 'Ver los motivos de rechazo del organismo', 'Consultar el catálogo de causales de devolución.'),
  op(`${TRD} GET /notif-config`, 'tramite.notificaciones.ver_config', 'Ver la configuración de notificaciones', 'Consultar qué avisos se envían y a quién.'),
  op(`${TRD} GET /embudo`, 'tramite.embudo.ver', 'Ver el embudo de trámites', 'Consultar cuántos trámites hay en cada etapa.'),
  op(`${TRD} GET /metrics/summary`, 'tramite.metricas.ver_resumen', 'Ver el resumen de métricas', 'Consultar los indicadores agregados de trámites.'),
  op(`${TRD} GET /metrics/gestor`, 'tramite.metricas.ver_gestor', 'Ver las métricas por gestor', 'Consultar el rendimiento de cada gestor de trámites.'),
  op(`${TRD} GET /stats/metricas`, 'tramite.estadisticas.ver_metricas', 'Ver las estadísticas de trámites', 'Consultar tiempos y volúmenes de la operación.'),
  op(`${TRD} GET /stats/resumen`, 'tramite.estadisticas.ver_resumen', 'Ver el resumen de estadísticas', 'Consultar el consolidado de la operación de trámites.'),
  op(`${TRD} GET /lote/plantilla.csv`, 'tramite.lote.descargar_plantilla', 'Descargar la plantilla de carga masiva', 'Bajar el archivo modelo para radicar trámites en lote.'),
  op(`${TRD} POST /lote/preview`, 'tramite.lote.previsualizar', 'Previsualizar una carga masiva', 'Ver qué se va a crear antes de confirmar el lote.'),
  op(`${TRD} GET /lote`, 'tramite.lote.listar', 'Ver las cargas masivas', 'Listar los lotes de trámites radicados.'),
  op(`${TRD} POST /lote/async`, 'tramite.lote.procesar_async', 'Procesar una carga masiva en segundo plano', 'Lanzar el lote para que se procese sin esperar en pantalla.'),
  op(`${TRD} POST /lote/confirm`, 'tramite.lote.confirmar', 'Confirmar una carga masiva', 'Dar por buena la previsualización y crear los trámites.'),
  op(`${TRD} POST /lote`, 'tramite.lote.crear', 'Crear una carga masiva', 'Radicar de una vez los trámites del archivo.'),
  op(`${TRD} GET /lote/:id/estado`, 'tramite.lote.ver_estado', 'Ver el estado de una carga masiva', 'Consultar por dónde va el proceso del lote.'),
  op(`${TRD} GET /lote/:id`, 'tramite.lote.ver', 'Ver una carga masiva', 'Abrir el detalle de un lote y sus filas.'),
  op(`${TRD} POST /lote/:id/reprocesar-errores`, 'tramite.lote.reprocesar', 'Reprocesar los errores de una carga masiva', 'Volver a intentar las filas del lote que fallaron.'),
  op(`${TRD} GET /lote/:id/resultados.csv`, 'tramite.lote.descargar_resultados', 'Descargar los resultados de una carga masiva', 'Bajar el archivo con el resultado fila a fila.'),
  op(`${TRD} POST /preflight`, 'tramite.preflight.evaluar', 'Evaluar la viabilidad de un trámite', 'Comprobar antes de radicar si el trámite puede seguir.'),
  op(`${TRD} GET /:id/preflight`, 'tramite.preflight.ver', 'Ver la viabilidad de un trámite', 'Consultar los bloqueos detectados en el trámite.'),
  op(`${TRD} POST /:id/preflight/cta`, 'tramite.preflight.accionar', 'Accionar sobre un bloqueo de viabilidad', 'Ejecutar la acción que propone el diagnóstico del trámite.'),
  op(`${TRD} GET /:id/checklist`, 'tramite.checklist.ver', 'Ver el checklist de un trámite', 'Consultar qué documentos exige el organismo para ese trámite.'),
  op(`${TRD} POST /:id/checklist/sugerir`, 'tramite.checklist.sugerir', 'Sugerir el checklist de un trámite', 'Proponer la lista de documentos a partir de la tipología.'),
  op(`${TRD} POST /:id/rechazar-ot`, 'tramite.tramite.rechazar_ot', 'Registrar el rechazo del organismo', 'Anotar que el organismo devolvió el trámite y por qué.'),
  op(`${TRD} POST /:id/invitar`, 'tramite.participantes.invitar', 'Invitar a un participante', 'Enviar el enlace para que un tercero aporte sus datos.'),
  op(`${TRD} GET /:id/participantes-pendientes`, 'tramite.participantes.ver_pendientes', 'Ver los participantes pendientes', 'Consultar quién falta por completar su parte.'),
  op(`${TRD} POST /:id/verify-token`, 'tramite.participantes.verificar_enlace', 'Verificar el enlace de un participante', 'Comprobar que el enlace de invitación sigue siendo válido.'),
  op(`${TRD} GET /:id/expediente.pdf`, 'tramite.expediente.descargar', 'Descargar el expediente del trámite', 'Bajar en un PDF todo el trámite y sus documentos.'),
  op(`${TRD} POST /:id/documentos`, 'tramite.documentos.cargar', 'Cargar un documento del trámite', 'Adjuntar al trámite un documento del checklist.'),
  op(`${TRD} GET /:id/documentos`, 'tramite.documentos.listar', 'Ver los documentos de un trámite', 'Listar lo que se ha adjuntado al trámite.'),
  op(`${TRD} GET /:tramiteId/documentos/:docId/archivo`, 'tramite.documentos.descargar', 'Descargar un documento del trámite', 'Abrir el archivo de un documento adjunto.'),
  op(`${TRD} DELETE /:tramiteId/documentos/:docId`, 'tramite.documentos.borrar', 'Borrar un documento del trámite', 'Retirar del trámite un documento adjunto.'),
  op(`${TRD} POST /:id/generar-fur`, 'tramite.fur.generar', 'Generar el FUR', 'Producir el Formulario Único de Registro del trámite.'),
  op(`${TRD} POST /:id/generar-contrato`, 'tramite.contrato.generar', 'Generar el contrato', 'Producir el contrato de compraventa del trámite.'),
  op(`${TRD} POST /:id/generar-improntas`, 'tramite.improntas.generar', 'Generar la hoja de improntas', 'Producir el documento de improntas del vehículo.'),
  op(`${TRD} POST /impuesto-vehicular/consultar`, 'tramite.impuesto.consultar', 'Consultar el impuesto vehicular', 'Preguntar al organismo cuánto debe el vehículo.'),
  op(`${OCR} POST /ocr/:tipo`, 'tramite.ocr.leer', 'Leer un documento con OCR', 'Extraer los datos de un documento escaneado del trámite.'),
  op(`${OCR} GET /ocr-extracted/:filename`, 'tramite.ocr.descargar', 'Abrir un documento leído por OCR', 'Ver el archivo del que se extrajeron los datos.'),
  op(`${IDE} GET /sse`, 'tramite.identidad.seguir', 'Seguir la validación de identidad en vivo', 'Recibir en pantalla el avance de la validación mientras ocurre.'),
  op(`${IDE} POST /iniciar`, 'tramite.identidad.iniciar', 'Iniciar la validación de identidad', 'Enviar al titular el enlace para validar su identidad.'),
  op(`${IDE} POST /iniciar-partes`, 'tramite.identidad.iniciar_partes', 'Iniciar la validación de todas las partes', 'Enviar el enlace de validación a comprador y vendedor a la vez.'),
  op(`${IDE} GET /estado/:tramiteId`, 'tramite.identidad.ver_estado', 'Ver el estado de la validación de identidad', 'Consultar quién ha validado ya y quién no.'),
  op(`${IDE} GET /documentos/:tramiteId`, 'tramite.identidad.ver_documentos', 'Ver los documentos de identidad', 'Abrir las cédulas y selfies aportadas en la validación.'),
  op(`${IDE} POST /certificado/:tramiteId`, 'tramite.identidad.certificar', 'Emitir el certificado de validación', 'Producir el documento que acredita la validación de identidad.'),

  // ── Tránsito (bandeja del organismo y su configuración) ───────────────────────────────────────
  op(`${TRN} GET /organismos`, 'transito.organismos.listar', 'Ver los organismos de tránsito', 'Consultar los organismos con los que se opera.'),
  op(`${TRN} GET /pendientes`, 'transito.bandeja.ver_pendientes', 'Ver los trámites pendientes del organismo', 'Abrir la bandeja de lo que espera gestión en tránsito.'),
  op(`${TRN} GET /mis-tramites`, 'transito.bandeja.ver_propios', 'Ver mis trámites de tránsito', 'Consultar los trámites que ha tomado el gestor.'),
  op(`${TRN} GET /traspasos`, 'transito.traspasos.listar', 'Ver los traspasos', 'Listar los traspasos en curso ante el organismo.'),
  op(`${TRN} GET /traspasos/:id`, 'transito.traspasos.ver', 'Ver un traspaso', 'Abrir el detalle de un traspaso y sus partes.'),
  op(`${TRN} POST /tomar/:id`, 'transito.tramite.tomar', 'Tomar un trámite de tránsito', 'Asignarse un trámite pendiente de la bandeja.'),
  op(`${TRN} POST /asignar-placa/:id`, 'transito.placa.asignar', 'Asignar la placa de un trámite', 'Registrar la placa que el organismo otorgó.'),
  op(`${TRN} POST /confirmar-placa/:id`, 'transito.placa.confirmar', 'Confirmar la placa de un trámite', 'Dar por buena la placa asignada y cerrar el paso.'),
  op(`${TRC} GET /organismos-config`, 'transito.config.listar', 'Ver la configuración de los organismos', 'Consultar cómo está configurado cada organismo de tránsito.'),
  op(`${TRC} GET /organismos-config/:codigo`, 'transito.config.ver', 'Ver la configuración de un organismo', 'Abrir los parámetros de un organismo concreto.'),
  op(`${TRC} PUT /organismos-config/:codigo`, 'transito.config.editar', 'Editar la configuración de un organismo', 'Cambiar los parámetros de operación del organismo.'),
  op(`${TRC} GET /organismos-config/:codigo/checklist/:tipologia`, 'transito.checklist.ver', 'Ver el checklist de un organismo', 'Consultar qué documentos exige el organismo por tipología.'),
  op(`${TRC} PUT /organismos-config/:codigo/checklist/:tipologia`, 'transito.checklist.editar', 'Editar el checklist de un organismo', 'Cambiar la lista de documentos exigidos por tipología.'),
  op(`${TRC} GET /organismos-config/:codigo/logo`, 'transito.logo.ver', 'Ver el logo de un organismo', 'Abrir la imagen que se imprime en los documentos del organismo.'),
  op(`${TRC} POST /organismos-config/:codigo/logo`, 'transito.logo.cargar', 'Cargar el logo de un organismo', 'Subir la imagen que se imprime en los documentos del organismo.'),
  op(`${TRC} DELETE /organismos-config/:codigo/logo`, 'transito.logo.borrar', 'Quitar el logo de un organismo', 'Retirar la imagen del organismo de los documentos.'),
  // ── Usuarios (HU #12083: `users/` entra al catálogo) ───────────────────────────────────────────
  op(`${USR} GET /`, 'usuarios.usuario.listar', 'Ver los usuarios', 'Abrir la pantalla de usuarios y recorrer el listado con sus filtros.'),
  op(`${USR} GET /resumen`, 'usuarios.usuario.ver_resumen', 'Ver el conteo de usuarios por rol', 'Leer cuántos usuarios activos e inactivos hay por cada rol.'),
  op(`${USR} GET /export`, 'usuarios.usuario.exportar', 'Exportar los usuarios a Excel', 'Descargar el listado filtrado de usuarios como archivo de Excel.'),
  op(`${USR} POST /`, 'usuarios.usuario.crear', 'Crear un usuario', 'Dar de alta un usuario con su rol, sus páginas y su ámbito.'),
  op(`${USR} PATCH /:id`, 'usuarios.usuario.editar', 'Editar un usuario', 'Cambiar el rol, las páginas, el ámbito o los datos de un usuario.'),
  op(`${USR} PATCH /:id/toggle`, 'usuarios.usuario.activar', 'Activar o desactivar un usuario', 'Bloquear o volver a habilitar la entrada de un usuario sin borrarlo.'),
  op(`${USR} DELETE /:id`, 'usuarios.usuario.baja', 'Dar de baja un usuario', 'Marcar un usuario como dado de baja sin borrarlo. Conserva username, permisos y ámbito.'),
  op(`${USR} POST /:id/reactivar`, 'usuarios.usuario.reactivar', 'Reactivar un usuario dado de baja', 'Quitar la marca de baja de un usuario para que vuelva a poder iniciar sesión.'),
  op(`${USR} POST /:id/invalidate-sessions`, 'usuarios.sesiones.invalidar', 'Cerrar las sesiones de un usuario', 'Invalidar todos los tokens vivos de un usuario para que vuelva a iniciar sesión.'),
  op(`${USR} PATCH /:id/password [ajena]`, 'usuarios.contrasena.cambiar_ajena', 'Cambiar la contraseña de otro usuario', 'Fijar una contraseña nueva a un usuario distinto de uno mismo.'),
  // HU #12171 — el historial de cambios (CF-19). Dos codigos y no uno: el catalogo es «una funcion por
  // ruta» y los codigos son unicos (precedente: `soat.cola.ver` / `soat.cola.filtrar`). Textos de
  // negocio fijados el 10/09/2026; los mismos que siembra la 0185 (el test de la 0179 compara literal).
  op(`${USR} GET /auditoria`, 'usuarios.auditoria.ver', 'Ver el historial de cambios de usuarios y permisos', 'Leer quién cambió qué en usuarios, roles y permisos, con el valor anterior y el posterior.'),
  op(`${USR} GET /auditoria/titulares`, 'usuarios.auditoria.filtrar', 'Listar los usuarios para filtrar el historial', 'Leer la lista de usuarios que tienen cambios registrados, para acotar el historial a uno.'),
  // ── Permisos (HU #12084: `permisos/` entra al catálogo) ─────────────────────────────────────────
  // Siete códigos y no cuatro: el catálogo es «una función por ruta» y los códigos son únicos. Ninguno
  // va al auditor: el cuadro de roles es administración, no observación. Textos = los de la 0186.
  op(`${PER} GET /funciones`, 'permisos.catalogo.ver', 'Ver el catálogo de funciones', 'Leer la lista de funciones que existen en el sistema, agrupadas por módulo, para repartirlas entre los roles.'),
  op(`${PER} GET /roles`, 'permisos.rol.listar', 'Ver los roles', 'Abrir la lista de roles con cuántos usuarios tiene cada uno y si se puede borrar.'),
  op(`${PER} POST /roles`, 'permisos.rol.crear', 'Crear un rol', 'Dar de alta un rol nuevo con su tipo de enlace, su tipo principal y su cuadro de funciones.'),
  op(`${PER} PATCH /roles/:codigo`, 'permisos.rol.editar', 'Editar un rol', 'Cambiar el nombre, la descripción, el tipo de enlace, el tipo principal o el estado de un rol.'),
  op(`${PER} DELETE /roles/:codigo`, 'permisos.rol.borrar', 'Borrar un rol', 'Eliminar un rol que ningún usuario tiene asignado, junto con su cuadro de funciones.'),
  op(`${PER} GET /roles/:codigo/funciones`, 'permisos.cuadro.ver', 'Ver el cuadro de funciones de un rol', 'Leer qué funciones concede un rol a quienes lo tienen asignado.'),
  op(`${PER} PUT /roles/:codigo/funciones`, 'permisos.cuadro.guardar', 'Guardar el cuadro de funciones de un rol', 'Reescribir el conjunto completo de funciones que concede un rol.'),
];

/**
 * Las CUATRO operaciones del canal Cliente que el Feature #12074 retiró (AC3).
 *
 * No es una lista de exclusión que el generador consulte —esas rutas ya no existen, así que el lector
 * no las puede encontrar—: es el clavo que impide que vuelvan. El test del AC3 comprueba que ninguno
 * de estos códigos aparece en el catálogo sembrado, de modo que reponer la ruta y su nombre aquí
 * ponga la prueba en rojo y obligue a reabrir la decisión en vez de deslizarla.
 */
export const OPERACIONES_RETIRADAS_CANAL_CLIENTE = [
  'soat.revision.validar',
  'soat.revision.rechazar',
  'soat.causales.ver',
  'soat.solicitud.subsanar',
] as const;
