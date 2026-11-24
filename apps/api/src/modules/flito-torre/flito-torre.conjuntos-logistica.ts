// Torre de Control Gerencial (Épica #14590, B4) — los CONJUNTOS de Logística (Traslados · Entregas) y de las subvistas
// de Financiera (Facturación · Bolsas, con la conciliación de boletas).
//
// Entran en `CONJUNTOS_SQL` (`flito-torre.conjuntos.ts`) y se cuentan y listan con el mismo `contarConjuntos` /
// `totalFragmento` / `listarFragmento`: la cifra del tablero y el `total` del detalle salen del MISMO fragmento.
// Las reglas de cada predicado (RN-TOR-LG1..LG6) están en `flito-torre.logistica-sql.ts`.
// RN-TOR-LG7: las bases van por `condicionesTorre` con las dimensiones de la entidad y sin los filtros que el catálogo
//   declara en `filtrosIgnorados` (traslados, actas, bolsas y boletas solo tienen compañía).
// RN-TOR-LG8: `bolsas_cobertura` = cobertura bajo `dias_cobertura_amarillo` (o sin saldo); su `critico` = bajo
//   `dias_cobertura_rojo` (o sin saldo), así que `severidad: atencion` es el resto (RN-TOR-D3 sobre ESE par de umbrales).
// Solo importa TIPOS de `flito-torre.conjuntos.ts` (que importa este archivo como valor): sin ciclo al cargar.
import { sql, type SQL } from 'drizzle-orm';
import { VALORES_NIVEL_BOLSA, VALORES_NIVEL_COLA, conjuntoTorre, type ConjuntoTorreId } from '@operaciones/shared-types';
import {
  flitoBolsasUnicas, flitoBolsasUnicasMovimientos, flitoConciliacionBoletas, flitoLogisticaActas, flitoLogisticaTraslados, flitoTramiteViajesLogistica,
  siigoFacturas, siigoLoteTramites,
} from '../../db/schema.js';
import type { ConjuntoSql } from './flito-torre.conjuntos.js';
import { condicionesTorre, type DimensionesBase, type FechaBase, type RangoResuelto } from './flito-torre.filtro.js';
import {
  ACTA_DE_ENTREGA, ACTA_DEVUELTA, ACTA_PENDIENTE, BOLETA_CON_DIFERENCIA, BOLETA_SIN_CONCILIAR, BOLSA_AGOTADA,
  BOLSA_DEL_MOVIMIENTO, BOLSA_DE_COMPANIA_ACTIVA, COLA_DETENIDA, COLS_ACTA, COLS_BOLETA, COLS_BOLSA, COLS_COLA, COLS_FACTURA,
  COLS_MOVIMIENTO, COLS_TRASLADO, COLS_VIAJE, DESDE_ACTAS, DESDE_BOLETAS, DESDE_COLA, DESDE_FACTURAS, DESDE_MOVIMIENTOS,
  DESDE_TRASLADOS, DESDE_VIAJES, DIMS_ACTA, DIMS_BOLETA, DIMS_BOLSA, DIMS_COLA, DIMS_FACTURA, DIMS_MOVIMIENTO, DIMS_TRASLADO,
  DIMS_VIAJE, FACTURA_CON_ERROR, FACTURA_EMITIDA, FACTURA_RECHAZADA_DIAN, FECHA_ACTA_CREACION, FECHA_FACTURA_ENVIO,
  FECHA_MOVIMIENTO, FECHA_VIAJE, NIVEL_COLA, colsBolsaConUmbrales, coberturaBajo, desdeBolsas, trasladoMasDe,
} from './flito-torre.logistica-sql.js';
import { claveMotivo } from './flito-torre.productos-sql.js';
import { hoyDe, type ContextoTablero } from './flito-torre.tablero-comun.js';

export type ConjuntoLogisticaId =
  | 'traslados_por_estado' | 'traslados_abiertos_mas_de_n' | 'actas_pendientes_entrega' | 'actas_devueltas_periodo'
  | 'viajes_adicionales_periodo' | 'facturas_con_error' | 'facturas_rechazadas_dian' | 'cola_facturacion_atascada'
  | 'facturado_periodo' | 'bolsas_cobertura' | 'bolsas_agotadas' | 'movimientos_bolsa_periodo' | 'boletas_sin_conciliar'
  | 'boletas_con_diferencia';

/** RN-TOR-LG7. */
const baseDe = (id: ConjuntoTorreId, dims: DimensionesBase, fecha?: FechaBase, fijas: readonly SQL[] = []) =>
  (ctx: ContextoTablero, rango: RangoResuelto | null): SQL[] =>
    [...fijas, ...condicionesTorre(ctx.filtro, ctx.alcance, dims, { rango, fecha, ignorar: conjuntoTorre(id).filtrosIgnorados })];

interface Pieza {
  entidad: ConjuntoSql['entidad']; tabla: string; desde: SQL; dims: DimensionesBase; cols: ConjuntoSql['cols'];
  id: SQL; tramiteId: SQL | null; fijas?: readonly SQL[]; desdeCtx?: ConjuntoSql['desdeCtx']; colsU?: ConjuntoSql['colsU'];
}

const TRASLADO: Pieza = {
  entidad: 'traslado', tabla: 'flito_logistica_traslados', desde: DESDE_TRASLADOS, dims: DIMS_TRASLADO, cols: COLS_TRASLADO,
  id: sql`${flitoLogisticaTraslados.id}`, tramiteId: null,
};
const ACTA: Pieza = {
  entidad: 'acta', tabla: 'flito_logistica_actas', desde: DESDE_ACTAS, dims: DIMS_ACTA, cols: COLS_ACTA,
  id: sql`${flitoLogisticaActas.id}`, tramiteId: null, fijas: [ACTA_DE_ENTREGA],
};
const VIAJE: Pieza = {
  entidad: 'viaje_logistica', tabla: 'flito_tramite_viajes_logistica', desde: DESDE_VIAJES, dims: DIMS_VIAJE, cols: COLS_VIAJE,
  id: sql`${flitoTramiteViajesLogistica.id}`, tramiteId: sql`${flitoTramiteViajesLogistica.tramiteId}`,
};
const FACTURA: Pieza = {
  entidad: 'factura', tabla: 'siigo_facturas', desde: DESDE_FACTURAS, dims: DIMS_FACTURA, cols: COLS_FACTURA,
  id: sql`${siigoFacturas.id}`, tramiteId: sql`${sql.identifier('flito_tramites')}.id`,
};
const COLA: Pieza = {
  entidad: 'cola_facturacion', tabla: 'siigo_cola_facturacion', desde: DESDE_COLA, dims: DIMS_COLA, cols: COLS_COLA,
  id: sql`${siigoLoteTramites.id}`, tramiteId: sql`${siigoLoteTramites.tramiteId}`,
};
/** RN-TOR-LG6: el `FROM` depende de «hoy» (la ventana de 30 días de consumo) y el semáforo, de los umbrales. */
const BOLSA: Pieza = {
  // `desde` no se usa (manda `desdeCtx`); está para que la forma de `ConjuntoSql` siga completa.
  entidad: 'bolsa', tabla: 'flito_bolsas_unicas', desde: desdeBolsas('2000-01-31'), dims: DIMS_BOLSA, cols: COLS_BOLSA,
  id: sql`${flitoBolsasUnicas.id}`, tramiteId: null, fijas: BOLSA_DE_COMPANIA_ACTIVA,
  desdeCtx: (ctx) => desdeBolsas(hoyDe(ctx)),
  colsU: (u) => colsBolsaConUmbrales(u.dias_cobertura_rojo, u.dias_cobertura_amarillo),
};
const MOVIMIENTO: Pieza = {
  entidad: 'movimiento_bolsa', tabla: 'flito_bolsas_unicas_movimientos', desde: DESDE_MOVIMIENTOS, dims: DIMS_MOVIMIENTO,
  cols: COLS_MOVIMIENTO, id: sql`${flitoBolsasUnicasMovimientos.id}`, tramiteId: sql`${flitoBolsasUnicasMovimientos.tramiteId}`,
};
const BOLETA: Pieza = {
  entidad: 'boleta', tabla: 'flito_conciliacion_boletas', desde: DESDE_BOLETAS, dims: DIMS_BOLETA, cols: COLS_BOLETA,
  id: sql`${flitoConciliacionBoletas.id}`, tramiteId: null,
};

function conjunto(
  id: ConjuntoLogisticaId, p: Pieza, grupo: string, propia: ConjuntoSql['propia'],
  extra: { fecha?: FechaBase; campoFecha: string } & Partial<Pick<ConjuntoSql, 'dimensiones' | 'critico' | 'nivel'>>,
): ConjuntoSql {
  const { fecha, campoFecha, ...resto } = extra;
  return {
    grupo, entidad: p.entidad, tabla: p.tabla, desde: p.desde, base: baseDe(id, p.dims, fecha, p.fijas), propia, dims: p.dims,
    fecha, campoFecha, id: p.id, tramiteId: p.tramiteId, cols: p.cols,
    ...(p.desdeCtx ? { desdeCtx: p.desdeCtx } : {}), ...(p.colsU ? { colsU: p.colsU } : {}), ...resto,
  };
}

const ESTADO_TRASLADO = { estado: sql`${flitoLogisticaTraslados.estado}::text` };

export const CONJUNTOS_LOGISTICA_SQL: Record<ConjuntoLogisticaId, ConjuntoSql> = {
  // ── Traslados (foto) ──
  traslados_por_estado: conjunto('traslados_por_estado', TRASLADO, 'traslado_foto', () => [], {
    campoFecha: 'estado actual', dimensiones: ESTADO_TRASLADO,
  }),
  traslados_abiertos_mas_de_n: conjunto('traslados_abiertos_mas_de_n', TRASLADO, 'traslado_foto',
    (u) => [trasladoMasDe(u.dias_traslado_abierto)], {
      campoFecha: 'registrado_en', critico: (u) => trasladoMasDe(u.dias_traslado_abierto * 2),
    }),
  // ── Entregas ──
  actas_pendientes_entrega: conjunto('actas_pendientes_entrega', ACTA, 'acta_foto', () => [ACTA_PENDIENTE], { campoFecha: 'estado actual' }),
  actas_devueltas_periodo: conjunto('actas_devueltas_periodo', ACTA, 'acta_creacion', () => [ACTA_DEVUELTA], {
    fecha: FECHA_ACTA_CREACION, campoFecha: 'flito_logistica_actas.created_at',
    dimensiones: { motivo: claveMotivo(flitoLogisticaActas.motivoDevolucion) },
  }),
  viajes_adicionales_periodo: conjunto('viajes_adicionales_periodo', VIAJE, 'viaje_registro', () => [], {
    fecha: FECHA_VIAJE, campoFecha: 'registrado_en',
  }),
  // ── Facturación ──
  facturas_con_error: conjunto('facturas_con_error', FACTURA, 'factura_foto', () => [FACTURA_CON_ERROR], { campoFecha: 'estado actual' }),
  facturas_rechazadas_dian: conjunto('facturas_rechazadas_dian', FACTURA, 'factura_foto', () => [FACTURA_RECHAZADA_DIAN], {
    campoFecha: 'último estado ante la DIAN',
  }),
  cola_facturacion_atascada: conjunto('cola_facturacion_atascada', COLA, 'cola_foto', () => [COLA_DETENIDA], {
    campoFecha: 'proximo_intento_at', nivel: { expr: NIVEL_COLA, valores: VALORES_NIVEL_COLA },
  }),
  facturado_periodo: conjunto('facturado_periodo', FACTURA, 'factura_envio', () => [FACTURA_EMITIDA], {
    fecha: FECHA_FACTURA_ENVIO, campoFecha: 'enviada_en',
  }),
  // ── Bolsas (RN-TOR-LG8) ──
  bolsas_cobertura: conjunto('bolsas_cobertura', BOLSA, 'bolsa_foto', (u) => [coberturaBajo(u.dias_cobertura_amarillo)], {
    campoFecha: 'saldo de hoy', critico: (u) => coberturaBajo(u.dias_cobertura_rojo),
    // B6: `nivel` separa las agotadas, para que «Para hoy» no cuente la misma bolsa en cobertura crítica y en agotadas.
    nivel: { expr: sql`(CASE WHEN ${BOLSA_AGOTADA} THEN 'agotada' ELSE 'con_saldo' END)`, valores: VALORES_NIVEL_BOLSA },
  }),
  bolsas_agotadas: conjunto('bolsas_agotadas', BOLSA, 'bolsa_foto', () => [BOLSA_AGOTADA], { campoFecha: 'saldo de hoy' }),
  movimientos_bolsa_periodo: conjunto('movimientos_bolsa_periodo', MOVIMIENTO, 'movimiento_fecha', () => [], {
    fecha: FECHA_MOVIMIENTO, campoFecha: 'fecha', dimensiones: { bolsa: BOLSA_DEL_MOVIMIENTO },
  }),
  // ── Conciliación de boletas ──
  boletas_sin_conciliar: conjunto('boletas_sin_conciliar', BOLETA, 'boleta_foto', () => [BOLETA_SIN_CONCILIAR], { campoFecha: 'estado actual' }),
  boletas_con_diferencia: conjunto('boletas_con_diferencia', BOLETA, 'boleta_foto', () => [BOLETA_CON_DIFERENCIA], { campoFecha: 'estado actual' }),
};
