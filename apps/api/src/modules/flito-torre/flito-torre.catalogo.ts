// Torre de Control Gerencial (Épica #14590, ADR-0043 D1/D4/D6) — SQL FIJO de cada métrica del catálogo cerrado.
//
// Cada entrada declara su tabla base (con sus JOIN fijos), la fecha que la ancla, las columnas de dimensión y la
// forma del agregado. El motor (`flito-torre.metricas.service.ts`) solo compone esto con `condicionesTorre()`; nada
// de aquí depende de lo que mande el cliente.
//
// RN-TOR-M1: «aprobado» = `fecha_aprobacion` dentro del rango (no se mira `flit_estado`).
// RN-TOR-M2: los conteos por creación usan `COALESCE(fecha_creacion_flit, created_at)` (índice de la 0303) y cuentan
//   en `nBaseSincronizacion` los que cayeron al `created_at` de la carga masiva.
// RN-TOR-M3: los tiempos EXCLUYEN los trámites sin `fecha_creacion_flit` (su `created_at` es la carga masiva) y los
//   cuentan en `baseFecha.excluidosSinFecha`.
// RN-TOR-M4: costo de logística = `flito_liquidaciones.valor_logistica` (ya incluye tarifa + viajes + traslados),
//   fechado por la `fecha_aprobacion` del trámite. NO se suma `flito_tramite_viajes_logistica.valor`: contaría doble.
// RN-TOR-M5: impuestos = `flito_impuestos.valor_pagado` por `pagado_en`; derechos = `flito_derechos_tramite.valor` por
//   `fecha_pago` (columna `date`).
import { sql, type SQL } from 'drizzle-orm';
import type { MetricaTorreId } from '@operaciones/shared-types';
import {
  flitoDerechosTramite, flitoImpuestos, flitoLiquidaciones, flitoTramites, siigoFacturaTramites,
} from '../../db/schema.js';
import type { DimensionesBase, FechaBase } from './flito-torre.filtro.js';

export type FormaMetrica = 'conteo' | 'suma' | 'tasa' | 'tiempo';

export interface DefMetricaSql {
  /** `FROM` + `JOIN` fijos. */
  desde: SQL;
  dims: DimensionesBase;
  /** `undefined` = foto del momento: no se acota por rango ni se agrupa por tiempo. */
  fecha?: FechaBase;
  campoFecha: string;
  /** Condiciones fijas de la métrica. */
  fijas: SQL[];
  forma: FormaMetrica;
  /** suma: la expresión sumada · tasa: la condición del numerador · tiempo: las horas. */
  valor?: SQL;
  /** tiempo: condición que deja fuera al registro (se cuenta en `excluidosSinFecha`). */
  requiere?: SQL;
  /** Condición «usó la fecha de sincronización» (para `nBaseSincronizacion`). */
  sync?: SQL;
}

const T = flitoTramites;

export const DIMS_TRAMITE: DimensionesBase = {
  compania: T.companiaId, organismo: T.organismoCodigo, tipoTramite: T.tipoTramite, flitEstado: T.flitEstado,
};

/** RN-TOR-M2: fecha de creación con respaldo al `created_at` de la sincronización. */
export const FECHA_CREACION: FechaBase = { expr: sql`COALESCE(${T.fechaCreacionFlit}, ${T.createdAt})` };
export const FECHA_APROBACION: FechaBase = { expr: T.fechaAprobacion };
export const SIN_FECHA_FLIT = sql`${T.fechaCreacionFlit} IS NULL`;

/** Horas de creación a aprobación (solo con `fecha_creacion_flit`). */
export const HORAS_CICLO = sql`(EXTRACT(EPOCH FROM (${T.fechaAprobacion} - ${T.fechaCreacionFlit})) / 3600.0)`;

/** Estados de FLIT que ya no están en curso (comparación en minúsculas: FLIT los manda capitalizados). */
export const ESTADOS_FLIT_CERRADOS = ['aprobado', 'anulado', 'abortado', 'rechazado', 'revocado'] as const;

/** Trámite en curso: sin aprobar y en un estado de FLIT vivo. */
export const EN_CURSO = sql`(${T.fechaAprobacion} IS NULL
  AND COALESCE(lower(${T.flitEstado}), '') NOT IN ${[...ESTADOS_FLIT_CERRADOS]})`;

/** El trámite está en una factura de Siigo activa. */
export const FACTURADO = sql`EXISTS (SELECT 1 FROM ${siigoFacturaTramites}
  WHERE ${siigoFacturaTramites.tramiteId} = ${T.id} AND ${siigoFacturaTramites.activo} = true)`;

const DESDE_TRAMITES = sql`${T}`;
const DESDE_LIQUIDACIONES = sql`${flitoLiquidaciones} INNER JOIN ${T} ON ${T.id} = ${flitoLiquidaciones.tramiteId}`;
const DESDE_TRAMITES_LIQ = sql`${T} LEFT JOIN ${flitoLiquidaciones} ON ${flitoLiquidaciones.tramiteId} = ${T.id}`;

const APROBADO = sql`${T.fechaAprobacion} IS NOT NULL`;

export const CATALOGO_SQL: Record<MetricaTorreId, DefMetricaSql> = {
  tramites_creados: {
    desde: DESDE_TRAMITES, dims: DIMS_TRAMITE, fecha: FECHA_CREACION, campoFecha: 'fecha_creacion_flit',
    fijas: [], forma: 'conteo', sync: SIN_FECHA_FLIT,
  },
  tramites_aprobados: {
    desde: DESDE_TRAMITES, dims: DIMS_TRAMITE, fecha: FECHA_APROBACION, campoFecha: 'fecha_aprobacion',
    fijas: [APROBADO], forma: 'conteo',
  },
  tiempo_creacion_aprobacion: {
    desde: DESDE_TRAMITES, dims: DIMS_TRAMITE, fecha: FECHA_APROBACION, campoFecha: 'fecha_creacion_flit → fecha_aprobacion',
    fijas: [APROBADO], forma: 'tiempo', valor: HORAS_CICLO,
    requiere: sql`${T.fechaCreacionFlit} IS NOT NULL`,
  },
  costo_logistica: {
    desde: DESDE_LIQUIDACIONES, dims: DIMS_TRAMITE, fecha: FECHA_APROBACION, campoFecha: 'fecha_aprobacion',
    fijas: [APROBADO], forma: 'suma', valor: sql`COALESCE(${flitoLiquidaciones.valorLogistica}, 0)`,
  },
  impuestos_pagados: {
    desde: sql`${flitoImpuestos} LEFT JOIN ${T} ON ${T.id} = ${flitoImpuestos.tramiteId}`,
    dims: { compania: flitoImpuestos.companiaId, organismo: flitoImpuestos.organismoCodigo, tipoTramite: T.tipoTramite, flitEstado: T.flitEstado },
    fecha: { expr: flitoImpuestos.pagadoEn }, campoFecha: 'pagado_en',
    fijas: [sql`${flitoImpuestos.pagadoEn} IS NOT NULL`], forma: 'suma', valor: sql`COALESCE(${flitoImpuestos.valorPagado}, 0)`,
  },
  derechos_pagados: {
    desde: sql`${flitoDerechosTramite} LEFT JOIN ${T} ON ${T.id} = ${flitoDerechosTramite.tramiteId}`,
    dims: { compania: flitoDerechosTramite.companiaId, organismo: flitoDerechosTramite.organismoCodigo, tipoTramite: T.tipoTramite, flitEstado: T.flitEstado },
    fecha: { expr: flitoDerechosTramite.fechaPago, esDate: true }, campoFecha: 'fecha_pago',
    fijas: [sql`${flitoDerechosTramite.fechaPago} IS NOT NULL`], forma: 'suma', valor: sql`COALESCE(${flitoDerechosTramite.valor}, 0)`,
  },
  ingreso_liquidado: {
    desde: DESDE_LIQUIDACIONES, dims: DIMS_TRAMITE, fecha: FECHA_APROBACION, campoFecha: 'fecha_aprobacion',
    fijas: [APROBADO], forma: 'suma', valor: sql`COALESCE(${flitoLiquidaciones.total}, 0)`,
  },
  wip_activo: {
    desde: DESDE_TRAMITES, dims: DIMS_TRAMITE, campoFecha: 'estado actual', fijas: [EN_CURSO], forma: 'conteo',
  },
  tasa_aprobacion: {
    desde: DESDE_TRAMITES, dims: DIMS_TRAMITE, fecha: FECHA_CREACION, campoFecha: 'fecha_creacion_flit',
    fijas: [], forma: 'tasa', valor: APROBADO, sync: SIN_FECHA_FLIT,
  },
  sin_facturar: {
    desde: DESDE_TRAMITES_LIQ, dims: DIMS_TRAMITE, fecha: FECHA_APROBACION, campoFecha: 'fecha_aprobacion',
    fijas: [APROBADO, sql`NOT ${FACTURADO}`], forma: 'conteo',
  },
};
