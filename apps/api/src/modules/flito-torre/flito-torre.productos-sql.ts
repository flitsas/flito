// Torre de Control Gerencial (Épica #14590, B3) — piezas SQL de los PRODUCTOS (SOAT, impuestos y derechos): el `FROM`,
// las dimensiones y las columnas del detalle. Las comparten los conjuntos (`flito-torre.conjuntos-productos.ts`) y las
// métricas del Explorador (`flito-torre.catalogo.ts`), así que la cifra y su detalle no pueden discrepar.
//
// RN-TOR-P1: un SOAT se ve con su PRIMER trámite (el más antiguo con `soat_id`), como `soat_sin_gestion`. El LATERAL
//   se llama `flito_tramites` a propósito: así las columnas de Drizzle de `flitoTramites` (código FLIT, placa, tipo y
//   estado del trámite) resuelven contra esa fila sin duplicar el SOAT cuando tiene varios trámites. Índice
//   `idx_flito_tramites_soat_orden (soat_id, created_at, id)`.
// RN-TOR-P2 (Ley 1581): solo placa, compañía, secretaría, estado, fechas y valores. La póliza va con sus 4 últimos
//   (`poliza_ultimos`); nunca la dirección del impuesto, el VIN, `poliza_runt` ni nada de `flito_compradores`.
// RN-TOR-P3: «hoy» es el día de Bogotá (`HOY_BOGOTA`), como el resto de la Torre.
// RN-TOR-P4: el motivo (incompleta, novedad del impuesto, concepto del recibo) se corta a 40 caracteres sin espacios
//   al borde: es la clave del segmento `motivo` y cabe en el tope de Zod de un valor de segmento.
import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { ColumnaDetalleId } from '@operaciones/shared-types';
import {
  flitoDerechosPendientes, flitoDerechosTramite, flitoImpuestos, flitoSoat, flitoSoatIncompletas, flitoSoportes,
  flitoTramites,
} from '../../db/schema.js';
import type { DimensionesBase, FechaBase } from './flito-torre.filtro.js';

type Cols = Partial<Record<ColumnaDetalleId, SQL>>;

const T = flitoTramites;
const S = flitoSoat;
const I = flitoImpuestos;
const D = flitoDerechosTramite;
const DP = flitoDerechosPendientes;
const SI = flitoSoatIncompletas;
const SOP = flitoSoportes;

export const HOY_BOGOTA = sql`(now() AT TIME ZONE 'America/Bogota')::date`;

/** RN-TOR-P4. */
export const motivoCorto = (e: AnyColumn | SQL): SQL => sql`NULLIF(btrim(left(btrim(${e}), 40)), '')`;

/** Una columna que no existe en la tabla (incompletas sin secretaría, recibos sin compañía). */
const NULO_ENTERO = sql`NULL::integer` as unknown as AnyColumn;
const NULO_TEXTO = sql`NULL::text` as unknown as AnyColumn;

// ── SOAT ───────────────────────────────────────────────────────────────────────────────────────────────

/** RN-TOR-P1. */
export const DESDE_SOAT = sql`${S} LEFT JOIN LATERAL (SELECT torre_t1.* FROM ${T} torre_t1 WHERE torre_t1.soat_id = ${S.id}
  ORDER BY torre_t1.created_at ASC, torre_t1.id ASC LIMIT 1) ${sql.identifier('flito_tramites')} ON true`;
export const DIMS_SOAT: DimensionesBase = {
  compania: S.companiaId, organismo: S.organismoCodigo, tipoTramite: T.tipoTramite, flitEstado: T.flitEstado,
};
export const FECHA_SOAT_CREACION: FechaBase = { expr: S.createdAt };
export const FECHA_SOAT_PAGO: FechaBase = { expr: S.pagadoEn };
/** RN-TOR-P2: «…1234». */
export const POLIZA_ULTIMOS = sql`(CASE WHEN COALESCE(btrim(${S.numeroPoliza}), '') = '' THEN NULL
  ELSE '…' || right(btrim(${S.numeroPoliza}), 4) END)`;
export const COLS_SOAT: Cols = {
  codigo_flit: sql`${T.idFlit}`, placa: sql`${T.plateComplete}`, compania: sql`${S.companiaId}`, organismo: sql`${S.organismoCodigo}`,
  estado: sql`${S.estado}::text`, creado_en: sql`${S.createdAt}`, pagado_en: sql`${S.pagadoEn}`, valor: sql`${S.valorPagado}`,
  poliza_ultimos: POLIZA_ULTIMOS, vence_el: sql`${S.venceEl}`, dias_para_vencer: sql`(${S.venceEl} - ${HOY_BOGOTA})::int`,
  estado_vigencia: sql`${S.estadoVigencia}`,
};
export const SOAT_PAGADO = sql`${S.estado} = 'pagado'`;

// ── SOAT incompletas (no son un SOAT: sin trámite ni secretaría) ───────────────────────────────────────

export const DESDE_SOAT_INCOMPLETAS = sql`${SI}`;
export const DIMS_SOAT_INCOMPLETA: DimensionesBase = {
  compania: SI.companiaId, organismo: NULO_TEXTO, tipoTramite: NULO_TEXTO, flitEstado: NULO_TEXTO,
};
export const COLS_SOAT_INCOMPLETA: Cols = {
  placa: sql`${SI.placa}`, compania: sql`${SI.companiaId}`, estado: sql`${SI.estado}`, motivo: motivoCorto(SI.motivoPendiente),
  solicitado_en: sql`${SI.solicitadoEn}`, intentos: sql`${SI.intentos}`,
};

// ── Impuestos ──────────────────────────────────────────────────────────────────────────────────────────

/** = el `desde` de la métrica `impuestos_pagados`. */
export const DESDE_IMPUESTOS = sql`${I} LEFT JOIN ${T} ON ${T.id} = ${I.tramiteId}`;
export const DIMS_IMPUESTO: DimensionesBase = {
  compania: I.companiaId, organismo: I.organismoCodigo, tipoTramite: T.tipoTramite, flitEstado: T.flitEstado,
};
export const FECHA_IMPUESTO_CREACION: FechaBase = { expr: I.createdAt };
export const FECHA_IMPUESTO_PAGO: FechaBase = { expr: I.pagadoEn };
export const COLS_IMPUESTO: Cols = {
  codigo_flit: sql`${T.idFlit}`, placa: sql`${T.plateComplete}`, compania: sql`${I.companiaId}`, organismo: sql`${I.organismoCodigo}`,
  estado: sql`${I.estado}::text`, creado_en: sql`${I.createdAt}`, pagado_en: sql`${I.pagadoEn}`, valor: sql`${I.valorPagado}`,
  valor_liquidado: sql`${I.valorLiquidado}`, motivo: motivoCorto(I.motivoRechazo),
};

// ── Derechos de tránsito ───────────────────────────────────────────────────────────────────────────────

/** = el `desde` de la métrica `derechos_pagados`. */
export const DESDE_DERECHOS = sql`${D} LEFT JOIN ${T} ON ${T.id} = ${D.tramiteId}`;
export const DIMS_DERECHO: DimensionesBase = {
  compania: D.companiaId, organismo: D.organismoCodigo, tipoTramite: T.tipoTramite, flitEstado: T.flitEstado,
};
export const FECHA_DERECHO_CREACION: FechaBase = { expr: D.createdAt };
export const FECHA_DERECHO_PAGO: FechaBase = { expr: D.fechaPago, esDate: true };
export const COLS_DERECHO: Cols = {
  codigo_flit: sql`${T.idFlit}`, placa: sql`${T.plateComplete}`, compania: sql`${D.companiaId}`, organismo: sql`${D.organismoCodigo}`,
  creado_en: sql`${D.createdAt}`, fecha_pago: sql`${D.fechaPago}`, valor: sql`${D.valor}`,
};
/** Mismo criterio que `SOPORTE_DERECHO` (catálogo): `soporte_id` o un soporte vigente del derecho. */
export const DERECHO_SIN_SOPORTE = sql`(${D.soporteId} IS NULL
  AND NOT EXISTS (SELECT 1 FROM ${SOP} WHERE ${SOP.derechoId} = ${D.id} AND ${SOP.descartado} = false))`;

// ── Recibos pendientes de asociar (sin compañía ni trámite) ────────────────────────────────────────────

export const DESDE_DERECHOS_PENDIENTES = sql`${DP}`;
export const DIMS_DERECHO_PENDIENTE: DimensionesBase = {
  compania: NULO_ENTERO, organismo: DP.organismoCodigo, tipoTramite: NULO_TEXTO, flitEstado: NULO_TEXTO,
};
export const COLS_DERECHO_PENDIENTE: Cols = {
  placa: sql`${DP.placa}`, organismo: sql`${DP.organismoCodigo}`, motivo: motivoCorto(DP.concepto),
  fecha_pago: sql`${DP.fechaPago}`, intentos: sql`${DP.intentos}`, creado_en: sql`${DP.createdAt}`, valor: sql`${DP.valor}`,
};
