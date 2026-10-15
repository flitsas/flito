// HU #13427 (Feature #13416 F3, ADR-0025; diseño §5-bis) — Qué OPERACIONES concede cada acción de Finanzas
// (y de Administración · Integración con Siigo). Mismo contrato que `acciones-gestion.ts`: la guarda pide la
// operación; la tiene quien tenga una acción efectiva que la contenga (`arbol/expansion.ts`).
//
// Dos piezas que Gestión no necesitó (§5-bis.1):
//   · `predecesores` explícito: dos guardas de hoy eran UN código para varias acciones aprobadas
//     (`finanzas.reporte_costos.ver` y el transitorio `siigo.parametrizacion.administrar`). Se parten en
//     operaciones NUEVAS (guarda nueva en la ruta) cuyo predecesor es el código viejo: quien lo tenía
//     recibe todas las acciones que lo sustituyen. Las nuevas nacen absorbidas (no se siembran).
//   · Predecesor de PÁGINA (P-19): «Ver los gastos diarios» la recibe quien tiene la página; la página
//     no se absorbe (sigue siendo el ítem).
//
// Decisiones del PO del 2026-10-13 que se leen aquí: P-15 («Ver la parametrización», lectura), P-16/P-17
// (opcionales), P-18 («Quitar el freno de emisión»), P-19 (operación nueva de gastos diarios), P-20
// (`catalogos-vivo` sigue bajo `siigo.factura.consultar`). Regla vigente: en las de LECTURA, descargar o
// exportar es OPCIONAL (`bolsas.soporte.descargar`, `comprobantes.archivo.descargar`,
// `conciliacion.comprobante.descargar`); «Exportar a Excel» y «Cerrar periodo y descargar extracto» ya
// modifican (regla «todos») y no cambian. `liquidacion.pago_manual.administrar` es de Órdenes de trabajo
// (P-14): `FUERA_DE_AREA_FINANZAS`, lo retira #13429.
import type { AccionArbol } from './acciones-gestion.js';

const REPORTE = 'finanzas.reporte_costos.ver';
const TRANSITORIO_SIIGO = 'siigo.parametrizacion.administrar';

export const ACCIONES_FINANZAS: Readonly<Record<string, AccionArbol>> = {
  // ── Reporte de costos ──
  'accion.reporte_costos.ver_listado': { lectura: true,
    operaciones: [REPORTE, 'liquidacion.liquidacion.ver', 'liquidacion.liquidacion.ver_eventos', 'finanzas.servicios_adicionales.ver'],
  },
  'accion.reporte_costos.exportar': { operaciones: ['finanzas.reporte_costos.exportar'], predecesores: [REPORTE] },
  'accion.reporte_costos.ver_soportes': { lectura: true, operaciones: ['finanzas.reporte_costos.ver_soportes'], predecesores: [REPORTE] },
  'accion.reporte_costos.ver_viajes_adicionales': { lectura: true, operaciones: ['finanzas.reporte_costos.ver_viajes'], predecesores: [REPORTE] },
  'accion.reporte_costos.asignar_servicios_adicionales': {
    operaciones: ['finanzas.servicios_adicionales.asignar', 'finanzas.servicios_adicionales.quitar'], apoyo: ['finanzas.servicios_adicionales.ver'],
  },
  'accion.reporte_costos.liquidar': { operaciones: ['liquidacion.liquidacion.liquidar', 'liquidacion.liquidacion.liquidar_lote'] },
  'accion.reporte_costos.facturar': { operaciones: ['liquidacion.liquidacion.facturar'] },
  'accion.reporte_costos.enviar_siigo': { operaciones: ['siigo.factura.emitir'] },
  'accion.reporte_costos.reversar_liquidacion': { operaciones: ['liquidacion.liquidacion.reversar'] },
  // ── Gastos diarios (P-19) ──
  'accion.gastos_diarios.ver': { lectura: true, operaciones: ['finanzas.gastos_diarios.ver'], predecesores: ['pagina.finanzas_gastos_diarios'] },
  // ── Bolsas ──
  'accion.bolsas.ver_clientes': { lectura: true,
    operaciones: ['bolsas.consolidado.ver', 'bolsas.bolsa.ver', 'bolsas.movimientos.ver', 'bolsas.cierres.ver'],
    opcionales: ['bolsas.soporte.descargar'],
  },
  'accion.bolsas.ver_transito': { lectura: true, operaciones: ['bolsas.transito.listar', 'bolsas.transito.ver', 'bolsas.transito.ver_movimientos'] },
  'accion.bolsas.crear': { operaciones: ['bolsas.transito.crear'] },
  'accion.bolsas.editar': { operaciones: ['bolsas.transito.editar'] },
  'accion.bolsas.registrar_recargas': { operaciones: ['bolsas.recarga.registrar', 'bolsas.transito.cargar'] },
  'accion.bolsas.movimientos_manuales': { operaciones: ['bolsas.movimiento.registrar', 'bolsas.movimiento.corregir'] },
  'accion.bolsas.cerrar_periodo': { operaciones: ['bolsas.cierre.crear', 'bolsas.extracto.descargar'] },
  'accion.bolsas.ver_alertas': { lectura: true, operaciones: ['bolsas.alertas.ver', 'bolsas.riesgo.ver'] },
  // ── Tarifas ──
  'accion.tarifas.ver': { lectura: true, operaciones: ['parametrizacion.tarifas.listar', 'parametrizacion.tarifas.ver_por_cliente', 'parametrizacion.tarifas.historial'] },
  'accion.tarifas.crear_modificar': { operaciones: ['parametrizacion.tarifas.crear', 'parametrizacion.tarifas.editar'] },
  // ── Servicios adicionales (1:1) ──
  'accion.servicios_adicionales.ver': { lectura: true, operaciones: ['parametrizacion.servicios_adicionales.listar'] },
  'accion.servicios_adicionales.crear': { operaciones: ['parametrizacion.servicios_adicionales.crear'] },
  'accion.servicios_adicionales.editar': { operaciones: ['parametrizacion.servicios_adicionales.editar'] },
  'accion.servicios_adicionales.dar_de_baja': { operaciones: ['parametrizacion.servicios_adicionales.dar_de_baja'] },
  // ── Comprobantes ──
  'accion.comprobantes.cargar': { operaciones: ['comprobantes.lote.cargar'] },
  'accion.comprobantes.asociar': { operaciones: ['comprobantes.tramites.buscar', 'comprobantes.comprobante.aplicar'] },
  'accion.comprobantes.ver_cola': { lectura: true, operaciones: ['comprobantes.cola.ver', 'comprobantes.comprobante.ver'], opcionales: ['comprobantes.archivo.descargar'] },
  // `releer` es OCR con coste: va en una acción que modifica (regla «todos»).
  'accion.comprobantes.resolver': { operaciones: ['comprobantes.comprobante.descartar', 'comprobantes.comprobante.releer', 'comprobantes.diferencia.aceptar'] },
  // ── Conciliación ──
  'accion.conciliacion.ver_boletas': { lectura: true, operaciones: ['conciliacion.boletas.listar', 'conciliacion.boleta.ver'], opcionales: ['conciliacion.comprobante.descargar'] },
  'accion.conciliacion.cargar_boleta': { operaciones: ['conciliacion.boleta.cargar'] },
  'accion.conciliacion.conciliar': { operaciones: ['conciliacion.boleta.conciliar', 'conciliacion.boleta.descartar', 'conciliacion.boleta.recruzar'] },
  'accion.conciliacion.comprobante': { operaciones: ['conciliacion.comprobante.cargar', 'conciliacion.comprobante.reemplazar'] },
  // ── Facturación electrónica · Parametrización ──
  // HU #13429: `siigo.conceptos.confirmar` es opcional también de «Ver» (basta una acción efectiva): quien confirma
  // mapeos sin administrarlos (financiera) lo conserva con el gating de la cadena; nadie lo gana.
  'accion.facturacion_parametrizacion.ver': {
    lectura: true, operaciones: ['siigo.parametrizacion.ver', 'siigo.emision.ver'], opcionales: ['siigo.conceptos.confirmar'],
  },
  'accion.facturacion_parametrizacion.mapeo_conceptos': {
    operaciones: ['siigo.conceptos.administrar', 'siigo.catalogos.sincronizar'], predecesores: [TRANSITORIO_SIIGO],
    opcionales: ['siigo.conceptos.confirmar'],
  },
  'accion.facturacion_parametrizacion.terceros': { operaciones: ['siigo.terceros.configurar'], predecesores: [TRANSITORIO_SIIGO] },
  // ── Facturación electrónica · Operación ──
  // P-20: `catalogos-vivo` (sale a Siigo, sin escritura) sigue bajo `siigo.factura.consultar`, con `vivoLimiter`.
  'accion.facturacion_operacion.ver_facturas': { lectura: true, operaciones: ['siigo.factura.consultar'], apoyo: ['siigo.parametrizacion.ver'] },
  'accion.facturacion_operacion.gestionar': {
    operaciones: ['siigo.factura.reintentar', 'siigo.factura.reenviar_correo', 'siigo.factura.marcar_fallido', 'siigo.factura.reactivar'],
    opcionales: ['siigo.factura.corregir', 'siigo.factura.anular'],
  },
  'accion.facturacion_operacion.freno': { operaciones: ['siigo.freno.reactivar'], predecesores: [TRANSITORIO_SIIGO] },
  // ── Administración · Integración con Siigo (P-3) ──
  'accion.integracion_siigo.credenciales_pruebas': {
    operaciones: ['siigo.credenciales.registrar_pruebas'], apoyo: ['siigo.credenciales.ver'], predecesores: [TRANSITORIO_SIIGO],
  },
  'accion.integracion_siigo.credenciales_produccion': {
    operaciones: ['siigo.credenciales.registrar_produccion'], apoyo: ['siigo.credenciales.ver'], predecesores: [TRANSITORIO_SIIGO],
  },
  'accion.integracion_siigo.probar_conexion': {
    operaciones: ['siigo.credenciales.probar'], apoyo: ['siigo.credenciales.ver'], predecesores: [TRANSITORIO_SIIGO],
  },
};

/**
 * Las operaciones NUEVAS (guarda nueva en una ruta que hoy pedía otro código) y el código de PARTIDA del
 * que salen. No existieron en el mundo plano: `catalogoPlano()` las lee con su código de partida (y las
 * de página no las lee), así las migraciones históricas siguen comparándose con lo que sembraron.
 */
export const PARTIDA_DE_OPERACION_NUEVA: Readonly<Record<string, string>> = {
  'finanzas.reporte_costos.exportar': REPORTE,
  'finanzas.reporte_costos.ver_soportes': REPORTE,
  'finanzas.reporte_costos.ver_viajes': REPORTE,
  'finanzas.gastos_diarios.ver': 'pagina.finanzas_gastos_diarios',
  'siigo.conceptos.administrar': TRANSITORIO_SIIGO,
  'siigo.catalogos.sincronizar': TRANSITORIO_SIIGO,
  'siigo.terceros.configurar': TRANSITORIO_SIIGO,
  'siigo.freno.reactivar': TRANSITORIO_SIIGO,
  'siigo.credenciales.ver': TRANSITORIO_SIIGO,
  'siigo.credenciales.registrar_pruebas': TRANSITORIO_SIIGO,
  'siigo.credenciales.registrar_produccion': TRANSITORIO_SIIGO,
  'siigo.credenciales.probar': TRANSITORIO_SIIGO,
};

/** El área de esta HU sobre `OPERACIONES_DECLARADAS` (AC6 de cobertura), por prefijo del código. */
export const AREA_FINANZAS = /^(liquidacion|bolsas|conciliacion|comprobantes|finanzas|siigo)\.|^parametrizacion\.(tarifas|servicios_adicionales)\./;

/** Operaciones que el prefijo mete en el área pero son de otro ítem, con el destino. */
export const FUERA_DE_AREA_FINANZAS: Readonly<Record<string, string>> = {
  'liquidacion.pago_manual.administrar': 'Órdenes de trabajo, legado (#13429, P-14)',
};
