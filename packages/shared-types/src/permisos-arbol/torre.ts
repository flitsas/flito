// Torre de Control Gerencial (Épica #14590) — los ítems de la Torre y sus acciones. Los cuatro tableros y el
// Explorador cuelgan de General; los umbrales, de Administración. Cada acción concede UNA operación `torre.*`,
// que es la que exige su ruta (`apps/api/src/modules/permisos/arbol/acciones-torre.ts`). Lo siembra la 0303.
import type { NodoArbolDef } from './index.js';
import { itemsANodos, type ItemDef } from './nodos.js';

const a = (clave: string, nombre: string, descripcion: string) => ({ clave, nombre, descripcion });

export const ITEMS_TORRE: readonly ItemDef[] = [
  { slug: 'torre_360', clave: 'torre_360', nombre: 'Torre · Vista 360°', elemento: 'general', orden: 30, acciones: [
    a('ver', 'Ver la vista 360°', 'Consultar el tablero ejecutivo de la Torre de Control.'),
  ] },
  { slug: 'torre_comercial', clave: 'torre_comercial', nombre: 'Torre · Comercial', elemento: 'general', orden: 40, acciones: [
    a('ver', 'Ver el tablero comercial', 'Consultar el volumen y la evolución por compañía.'),
  ] },
  { slug: 'torre_operativa', clave: 'torre_operativa', nombre: 'Torre · Operativa', elemento: 'general', orden: 50, acciones: [
    a('ver', 'Ver el tablero operativo', 'Consultar los tiempos, el trabajo en curso y los trámites en riesgo.'),
    // B5: la pestaña Equipo (solo gerencia_general y admin). Sin ítem propio: es una pestaña de Operativa, no una
    // página; la siembra su propia migración (0309), no la 0303.
    a('ver_equipo', 'Ver la operación del equipo', 'Consultar las gestiones, la carga abierta y los pendientes fuera de ANS de cada funcionario.'),
  ] },
  { slug: 'torre_financiera', clave: 'torre_financiera', nombre: 'Torre · Financiera', elemento: 'general', orden: 60, acciones: [
    a('ver', 'Ver el tablero financiero', 'Consultar costos, pagos, ingreso liquidado y lo pendiente de facturar.'),
  ] },
  { slug: 'torre_explorador', clave: 'torre_explorador', nombre: 'Torre · Explorador', elemento: 'general', orden: 70, acciones: [
    a('consultar', 'Consultar métricas', 'Consultar cualquier métrica del catálogo con sus filtros y agrupaciones.'),
    a('exportar', 'Exportar métricas', 'Descargar en Excel o PDF el resultado de una consulta agregada.'),
    a('buscar_placa', 'Buscar una placa', 'Abrir la ficha de un trámite por su placa, sin datos personales del comprador.'),
    a('ver_dinero', 'Ver las métricas de dinero', 'Consultar costos, impuestos, derechos, ingreso liquidado y lo pendiente de facturar.'),
  ] },
  { slug: 'torre_umbrales', clave: 'torre_umbrales', nombre: 'Torre · Umbrales', elemento: 'administracion', orden: 70, acciones: [
    a('ver', 'Ver los umbrales', 'Consultar los umbrales que usan las alertas de la Torre.'),
    a('editar', 'Editar los umbrales', 'Cambiar el valor de un umbral de la Torre.'),
  ] },
  // Detalle universal (ADR-0047, B1): no es pestaña; lo abre cada cifra. Lo siembra su propia migración (no la 0303).
  { slug: 'torre_detalle', clave: 'torre_detalle', nombre: 'Torre · Detalle', elemento: 'general', orden: 80, acciones: [
    a('ver', 'Ver los registros de una cifra', 'Abrir la lista de registros (placa, compañía y estado) detrás de una cifra de la Torre.'),
    a('exportar', 'Exportar los registros de una cifra', 'Descargar en Excel los registros detrás de una cifra de la Torre.'),
  ] },
  // Productos (B3): SOAT, impuestos y derechos. Lo siembra su propia migración (0307), con el umbral nuevo.
  { slug: 'torre_productos', clave: 'torre_productos', nombre: 'Torre · Productos', elemento: 'general', orden: 90, acciones: [
    a('ver', 'Ver el tablero de productos', 'Consultar el estado de los SOAT, los impuestos y los derechos de tránsito.'),
  ] },
  // Logística (B4): traslados y entregas. Lo siembra su propia migración (0308), con el umbral nuevo.
  { slug: 'torre_logistica', clave: 'torre_logistica', nombre: 'Torre · Logística', elemento: 'general', orden: 100, acciones: [
    a('ver', 'Ver el tablero de logística', 'Consultar los traslados de documentos, las actas de entrega y los viajes adicionales.'),
  ] },
];

/** Ítems y acciones del área, padres antes que hijos. */
export const ARBOL_TORRE: readonly NodoArbolDef[] = itemsANodos(ITEMS_TORRE);
