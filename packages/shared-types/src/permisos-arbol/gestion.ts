// HU #12873 (Feature #13416) — Gestión y Tránsito: los 9 ítems con nivel 3 y sus acciones, con los
// nombres del catálogo aprobado (decisiones del PO del 2026-10-09, Discussion de #13416).
//
// Decisiones que se leen en esta lista:
//   · Gestión Trámites sin «Ver la factura» (P-6) y sin ítem «Compuerta»: su pantalla la abre
//     «Entregar trámites» (P-10). Autogestión y empresa van a Clientes (#13428).
//   · «Solicitar SOAT e impuestos a la vez» no es acción: exige las dos de solicitar (el API lo resuelve).
//   · Impuestos NO repite las acciones de SOAT sin operación propia (P-5).
//   · Revisiones OCR: «Ver» + una sola «Revisar lecturas» (P-7). Mi ruta: ver, escanear, novedad (P-8).
//   · Tablero FLITO no está aquí: pasa al Tablero de General (P-11, `general.ts`, #13428).
import type { NodoArbolDef } from './index.js';
import { itemsANodos, type AccionDef, type ItemDef } from './nodos.js';

const a = (clave: string, nombre: string, descripcion: string, hijas?: AccionDef[]): AccionDef =>
  ({ clave, nombre, descripcion, ...(hijas ? { hijas } : {}) });

/** Los ítems del área, en el orden del menú. `clave` es el segmento `<item>` de `accion.<item>.<accion>`. */
export const ITEMS_GESTION: readonly ItemDef[] = [
  { slug: 'flito_tramites', clave: 'tramites', nombre: 'Gestión Trámites', elemento: 'gestion', orden: 10, acciones: [
    a('ver_listado', 'Ver el listado de trámites', 'Consultar la cola de trámites, filtrarla y ver el historial de cada uno.'),
    a('solicitar_soat', 'Solicitar SOAT', 'Pedir el SOAT de los trámites seleccionados.'),
    a('solicitar_impuestos', 'Solicitar impuestos', 'Pedir el pago de impuestos de los trámites seleccionados.'),
    a('descargar_soportes', 'Descargar soportes', 'Ver y descargar los soportes de los trámites.'),
    a('sincronizar', 'Sincronizar trámites', 'Traer los trámites nuevos de las fuentes y ver el estado de la sincronización.'),
    a('configurar_sincronizacion', 'Configurar la sincronización', 'Encender o apagar fuentes y gestionar el acceso a FLIT 2.'),
    a('crear_demo', 'Crear trámites de demostración', 'Sembrar trámites de prueba en el ambiente.'),
    a('entregar', 'Entregar trámites', 'Marcar trámites como entregados y usar la compuerta de entrega.'),
  ] },
  { slug: 'flito_soat', clave: 'soat', nombre: 'SOAT', elemento: 'gestion', orden: 20, acciones: [
    a('ver_listado', 'Ver el listado', 'Consultar la cola de SOAT, filtrarla y ver el detalle y el historial de cada solicitud.'),
    a('ver_soportes', 'Ver soportes', 'Abrir los soportes de una solicitud.'),
    a('cargar_comprobantes', 'Cargar comprobantes', 'Cargar la factura de una solicitud o varias a la vez.'),
    a('exportar', 'Exportar a Excel', 'Descargar la cola en Excel.', [
      a('exportar_pago', 'Exportar con datos de pago y trazabilidad', 'Incluir en el Excel las columnas de pago y de trazabilidad.'),
    ]),
    a('cambiar_proveedor', 'Cambiar proveedor', 'Cambiar el proveedor de SOAT de una solicitud.'),
    a('solicitar_sin_tramite', 'Solicitar SOAT sin trámite', 'Radicar un SOAT sin trámite previo, con la preconsulta RUNT y la lectura de la factura.'),
    a('gestionar_solicitudes', 'Gestionar solicitudes', 'Enviar, asumir, devolver, reactivar, reversar y rechazar solicitudes.'),
    a('ver_por_validar', 'Ver solicitudes por validar', 'Buscar las solicitudes incompletas, verlas y reintentar el RUNT.'),
    a('descargar_zip', 'Descargar soportes en ZIP', 'Descargar en un ZIP los soportes de varias solicitudes.'),
    a('ver_documentos_adicionales', 'Ver documentos adicionales', 'Ver los documentos adicionales de una solicitud.'),
    a('cargar_documentos_adicionales', 'Cargar documentos adicionales', 'Cargar documentos adicionales a una solicitud.'),
    a('eliminar_documentos_adicionales', 'Eliminar documentos adicionales', 'Eliminar documentos adicionales de una solicitud.'),
  ] },
  { slug: 'flito_impuestos', clave: 'impuestos', nombre: 'Impuestos', elemento: 'gestion', orden: 30, acciones: [
    a('ver_listado', 'Ver el listado', 'Consultar la cola de impuestos, filtrarla y ver el detalle, el historial y la factura de venta.'),
    a('ver_soportes', 'Ver soportes', 'Abrir los soportes de un trámite.'),
    a('cargar_comprobantes', 'Cargar comprobantes', 'Cargar los recibos de pago.'),
    a('exportar', 'Exportar a Excel', 'Descargar la cola en Excel.', [
      a('exportar_pago', 'Exportar con datos de pago y trazabilidad', 'Incluir en el Excel las columnas de pago y de trazabilidad.'),
    ]),
    a('descargar_zip', 'Descargar soportes en ZIP', 'Descargar en un ZIP los soportes de varios trámites.'),
    a('gestionar_solicitudes', 'Gestionar solicitudes', 'Enviar, asumir, devolver, reactivar, reversar y rechazar trámites.'),
    a('certificar_runt', 'Certificar en el RUNT', 'Certificar un trámite o un lote en el RUNT.'),
    a('cargar_recibo_caja', 'Cargar recibo de caja', 'Cargar el recibo de caja de un trámite.'),
    a('reemplazar_comprobante', 'Reemplazar comprobante', 'Reemplazar el recibo de pago de un trámite.'),
    a('corregir_direccion', 'Corregir dirección', 'Corregir la dirección del trámite.'),
    a('descargar_certificado', 'Descargar certificado', 'Descargar el certificado del trámite.'),
  ] },
  { slug: 'flito_derechos', clave: 'derechos', nombre: 'Derechos', elemento: 'gestion', orden: 40, acciones: [
    a('ver_listado', 'Ver el listado', 'Consultar la cola de derechos y filtrarla.'),
    a('cargar', 'Cargar recibos', 'Cargar recibos de derechos y ver los candidatos de una placa.'),
    a('procesar_drive', 'Procesar desde Drive', 'Listar y procesar los archivos de Drive y ver su registro.'),
    a('ver_soportes', 'Ver soportes', 'Descargar el soporte de un derecho.'),
  ] },
  { slug: 'flito_revisiones', clave: 'revisiones', nombre: 'Revisiones OCR', elemento: 'gestion', orden: 50, acciones: [
    a('ver', 'Ver revisiones', 'Consultar la cola de revisiones, sus campos y sus soportes.'),
    a('revisar_lecturas', 'Revisar lecturas OCR', 'Resolver o descartar las lecturas pendientes.'),
  ] },
  { slug: 'flito_logistica', clave: 'logistica', nombre: 'Logística', elemento: 'gestion', orden: 60, acciones: [
    a('ver_consola', 'Ver la consola', 'Consultar la consola de logística, filtrarla y ver cada documento.'),
    a('registrar_viajes', 'Registrar viajes adicionales', 'Ver, registrar y quitar viajes adicionales de un trámite.'),
    a('generar_actas', 'Generar actas', 'Validar la LT y generar las actas.'),
    a('ver_actas', 'Ver actas', 'Listar, ver y descargar actas.'),
    a('despachar_entregar_devolver', 'Despachar, entregar y devolver', 'Despachar, entregar (también actas de otros mensajeros) y devolver actas.'),
    a('cerrar_lote', 'Cerrar lote', 'Cerrar el lote de documentos.'),
    a('reversar_paso', 'Reversar paso', 'Reversar el último paso de un documento.'),
  ] },
  { slug: 'flito_logistica_ruta', clave: 'mi_ruta', nombre: 'Mi ruta', elemento: 'gestion', orden: 70, acciones: [
    a('ver', 'Ver mi ruta', 'Ver la ruta del día y sus documentos.'),
    a('escanear', 'Escanear documentos', 'Escanear los documentos de la ruta.'),
    a('reportar_novedad', 'Reportar novedad', 'Reportar una novedad sobre un documento.'),
  ] },
  { slug: 'flito_comparendos', clave: 'comparendos', nombre: 'Comparendos', elemento: 'gestion', orden: 80, acciones: [
    a('ver_listado', 'Ver el listado', 'Listar, buscar y exportar comparendos, y ver cada registro y sus eventos.'),
    a('gestionar', 'Gestionar comparendos', 'Registrar la gestión de un comparendo.'),
    a('sincronizar', 'Sincronizar', 'Lanzar la sincronización y ver sus corridas.'),
    a('configurar', 'Configurar', 'Administrar NIT, municipios, causales y el token de SIMIT.'),
  ] },
  { slug: 'transito_organismos', clave: 'organismos_stt', nombre: 'Organismos STT', elemento: 'transito', orden: 10, acciones: [
    a('ver', 'Ver organismos', 'Consultar los organismos de tránsito, su configuración, logo, checklist y vigencias.'),
    a('editar', 'Editar organismos', 'Editar organismos, su modalidad, configuración, logo y checklist.'),
  ] },
];

/**
 * HU #13428 — Clientes y proveedores y Bitácora cuelgan de Gestión (decisión del PO del 9-oct; el AC1 de la
 * HU los ponía en Administración) y van al final del elemento. Lista aparte de `ITEMS_GESTION` porque su
 * mapeo y su paso son de la #13428 (`acciones-administracion.ts`, 0236/0237), no de la #12873.
 * «Ver clientes y proveedores» es P-21 (2026-10-13).
 */
export const ITEMS_CLIENTES_Y_BITACORA: readonly ItemDef[] = [
  { slug: 'clients', clave: 'clientes', nombre: 'Clientes y proveedores', elemento: 'gestion', orden: 90, acciones: [
    a('ver', 'Ver clientes y proveedores', 'Consultar los clientes, las compañías y los proveedores de SOAT.'),
    a('crear_editar_clientes', 'Crear y editar clientes', 'Crear clientes y empresas, y editar sus datos generales.'),
    a('crear_editar_proveedores', 'Crear y editar proveedores', 'Crear y editar los proveedores de SOAT.'),
    a('autogestion', 'Habilitar o revocar la autogestión del cliente', 'Habilitar o revocar la autogestión de SOAT, impuestos y logística de un cliente.'),
    a('soat_sin_tramite', 'Configurar «SOAT sin trámite»', 'Permitir a un cliente solicitar SOAT sin trámite y elegir su proveedor.'),
    a('datos_fiscales', 'Datos fiscales', 'Registrar y editar los datos fiscales de un cliente.'),
  ] },
  { slug: 'flito_bitacora', clave: 'bitacora', nombre: 'Bitácora', elemento: 'gestion', orden: 100, acciones: [
    a('ver', 'Ver la bitácora', 'Consultar la bitácora de cambios y la de cada registro.'),
  ] },
];

/** Ítems y acciones del área, padres antes que hijos. */
export const ARBOL_GESTION: readonly NodoArbolDef[] = itemsANodos(ITEMS_GESTION);
export const ARBOL_CLIENTES_Y_BITACORA: readonly NodoArbolDef[] = itemsANodos(ITEMS_CLIENTES_Y_BITACORA);
