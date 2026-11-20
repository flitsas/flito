// HU #13427 (Feature #13416 F3) — Finanzas: los ítems con nivel 3 y sus acciones, con los nombres LITERALES
// del catálogo aprobado por el PO (anexo del diseño §5-bis, 2026-10-07) y las decisiones del 2026-10-13:
//   · P-15: «Ver la parametrización» (lectura) en Facturación electrónica · Parametrización.
//   · P-18: la acción del freno se llama «Quitar el freno de emisión» (el freno se activa solo).
//   · P-19: Gastos diarios solo tiene «Ver».
// Qué operaciones concede cada acción es cosa del API (`apps/api/src/modules/permisos/arbol/acciones-finanzas.ts`).
import type { NodoArbolDef } from './index.js';
import { itemsANodos, type ItemDef } from './nodos.js';

const a = (clave: string, nombre: string, descripcion: string) => ({ clave, nombre, descripcion });

/** Los ítems del área, en el orden del menú. `clave` es el segmento `<item>` de `accion.<item>.<accion>`. */
export const ITEMS_FINANZAS: readonly ItemDef[] = [
  { slug: 'finanzas_reporte_costos', clave: 'reporte_costos', nombre: 'Reporte de costos', elemento: 'finanzas', orden: 10, acciones: [
    a('ver_listado', 'Ver el listado de trámites', 'Consultar el reporte de costos, sus filtros, el consolidado, la facturación electrónica y los eventos de liquidación.'),
    a('exportar', 'Exportar a Excel', 'Descargar el reporte de costos y su consolidado en Excel.'),
    a('ver_soportes', 'Ver soportes', 'Abrir los soportes de un trámite desde el reporte.'),
    a('ver_viajes_adicionales', 'Ver viajes adicionales', 'Ver los viajes de logística de un trámite desde el reporte.'),
    a('asignar_servicios_adicionales', 'Asignar servicios adicionales', 'Asignar y quitar servicios adicionales a un trámite.'),
    a('liquidar', 'Liquidar (incluye en lote)', 'Liquidar trámites, uno a uno o en lote.'),
    a('facturar', 'Facturar', 'Marcar como facturados los trámites liquidados.'),
    a('enviar_siigo', 'Enviar a Siigo', 'Emitir la factura electrónica en Siigo y sincronizar sus terceros.'),
    a('reversar_liquidacion', 'Reversar una liquidación', 'Deshacer la liquidación de un trámite.'),
  ] },
  { slug: 'finanzas_gastos_diarios', clave: 'gastos_diarios', nombre: 'Gastos diarios', elemento: 'finanzas', orden: 20, acciones: [
    a('ver', 'Ver los gastos diarios', 'Consultar los gastos diarios.'),
  ] },
  { slug: 'flito_bolsas', clave: 'bolsas', nombre: 'Bolsas', elemento: 'finanzas', orden: 30, acciones: [
    a('ver_clientes', 'Ver bolsas de clientes', 'Consultar el consolidado, las bolsas de clientes, sus movimientos y sus cierres.'),
    a('ver_transito', 'Ver bolsas de tránsito', 'Consultar las bolsas de tránsito y sus movimientos.'),
    a('crear', 'Crear bolsas', 'Crear bolsas de tránsito.'),
    a('editar', 'Editar bolsas', 'Editar bolsas de tránsito.'),
    a('registrar_recargas', 'Registrar recargas y cargar saldo', 'Registrar recargas y cargar saldo a las bolsas.'),
    a('movimientos_manuales', 'Registrar y corregir movimientos manuales', 'Registrar y corregir movimientos manuales de una bolsa.'),
    a('cerrar_periodo', 'Cerrar periodo y descargar extracto', 'Cerrar el periodo de una bolsa y descargar su extracto.'),
    a('ver_alertas', 'Ver alertas y riesgo de saldo', 'Consultar las alertas y el riesgo de saldo de las bolsas.'),
    // HU #13889 (ADR-0028): expediente documental de la compañía.
    a('ver_documentos', 'Ver el expediente documental', 'Consultar y descargar los documentos de vinculación de la compañía.'),
    a('cargar_documentos', 'Cargar documentos del expediente', 'Subir o reemplazar documentos de la compañía y fijar su fecha de expedición.'),
  ] },
  { slug: 'flito_tarifas', clave: 'tarifas', nombre: 'Tarifas', elemento: 'finanzas', orden: 40, acciones: [
    a('ver', 'Ver las tarifas (incluye historial)', 'Consultar las tarifas, las de cada cliente y su historial.'),
    a('crear_modificar', 'Crear y modificar tarifas', 'Crear y editar tarifas.'),
  ] },
  { slug: 'flito_servicios_adicionales', clave: 'servicios_adicionales', nombre: 'Servicios adicionales', elemento: 'finanzas', orden: 50, acciones: [
    a('ver', 'Ver', 'Consultar el catálogo de servicios adicionales.'),
    a('crear', 'Crear', 'Crear servicios adicionales.'),
    a('editar', 'Editar', 'Editar servicios adicionales.'),
    a('dar_de_baja', 'Dar de baja', 'Dar de baja servicios adicionales.'),
  ] },
  { slug: 'flito_comprobantes', clave: 'comprobantes', nombre: 'Comprobantes', elemento: 'finanzas', orden: 60, acciones: [
    a('cargar', 'Cargar comprobantes', 'Cargar lotes de comprobantes.'),
    a('asociar', 'Asociar manualmente', 'Buscar el trámite y aplicarle un comprobante a mano.'),
    a('ver_cola', 'Ver la cola de comprobantes', 'Consultar la cola de comprobantes y el detalle de cada uno.'),
    a('resolver', 'Descartar, releer o aceptar una diferencia', 'Descartar un comprobante, volver a leerlo o aceptar una diferencia.'),
  ] },
  { slug: 'flito_conciliacion', clave: 'conciliacion', nombre: 'Conciliación', elemento: 'finanzas', orden: 70, acciones: [
    a('ver_boletas', 'Ver las boletas cargadas', 'Consultar las boletas cargadas y su detalle.'),
    a('cargar_boleta', 'Cargar boleta', 'Cargar una boleta.'),
    a('conciliar', 'Conciliar, descartar o volver a cruzar', 'Conciliar, descartar o volver a cruzar una boleta.'),
    a('comprobante', 'Cargar o reemplazar el comprobante de la boleta', 'Cargar o reemplazar el comprobante de una boleta.'),
  ] },
  { slug: 'siigo_parametrizacion', clave: 'facturacion_parametrizacion', nombre: 'Facturación electrónica · Parametrización', elemento: 'finanzas', orden: 80, acciones: [
    a('ver', 'Ver la parametrización', 'Consultar la compuerta, el mapeo de conceptos, las ciudades, la validación de clientes y los catálogos de emisión.'),
    a('mapeo_conceptos', 'Mapeo de conceptos', 'Crear, editar, revalidar y borrar el mapeo de conceptos y sincronizar los catálogos de Siigo.'),
    a('terceros', 'Configuración de terceros', 'Cargar ciudades, confirmar la ciudad de un cliente y recalcular duplicados.'),
  ] },
  { slug: 'siigo_operacion', clave: 'facturacion_operacion', nombre: 'Facturación electrónica · Operación', elemento: 'finanzas', orden: 90, acciones: [
    a('ver_facturas', 'Ver las facturas emitidas', 'Consultar la bandeja, la línea de tiempo y el estado de las facturas, y el estado del freno.'),
    a('gestionar', 'Reintentar, reenviar el correo, marcar como fallida y reactivar', 'Reintentar, reenviar el correo, marcar como fallida y reactivar una factura electrónica.'),
    a('freno', 'Quitar el freno de emisión', 'Reactivar la emisión de facturas cuando el freno se activó.'),
  ] },
];

/** Ítems y acciones del área, padres antes que hijos. */
export const ARBOL_FINANZAS: readonly NodoArbolDef[] = itemsANodos(ITEMS_FINANZAS);
