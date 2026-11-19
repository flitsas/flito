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
// RN-TOR-M10 (ADR-0044): la fecha base es una VARIANTE declarada por métrica (`fechas`); la primera de `fechasBase`
//   (shared-types) es la de defecto y da el mismo resultado que antes. `resolverDef` la elige y vuelve a exigir la matriz.
// RN-TOR-M11: matriz medida × fecha base = la de `METRICAS_TORRE.fechasBase` (creación, aprobación, facturación, pago).
//   Pago = `pagado_en` (impuestos) o `fecha_pago` (derechos). El tiempo de ciclo solo admite aprobación.
// RN-TOR-M13: `tramites` + aprobación cuenta `fecha_aprobacion` en el rango sin mirar `flit_estado`.
// RN-TOR-M14: facturación = `min(siigo_factura_tramites.created_at)` de las activas (`FACTURACION_TRAMITE`).
// RN-TOR-L1: costo e ingreso excluyen las liquidaciones de trámites anulados/abortados/revocados (`LIQUIDACION_VIGENTE`).
import { sql, type SQL } from 'drizzle-orm';
import {
  esFechaBasePermitida, fechaBasePorDefecto, type ColumnaDetalleId, type FechaBaseTorre, type MetricaTorreId,
} from '@operaciones/shared-types';
import {
  flitoDerechosTramite, flitoImpuestos, flitoLiquidaciones, flitoSoat, flitoSoportes, flitoTramiteHistorial, flitoTramites,
  flitoTramiteViajesLogistica, siigoFacturaTramites,
} from '../../db/schema.js';
import {
  BORRADOR_ABANDONADO, ENTRADA_ESTADO_ACTUAL,
} from '../flito-tramites/flito-tramites.borrador.js';
import type { DimensionesBase, FechaBase } from './flito-torre.filtro.js';
import {
  COLS_DERECHO, COLS_IMPUESTO, COLS_SOAT, DESDE_DERECHOS, DESDE_IMPUESTOS, DESDE_SOAT, DIMS_DERECHO, DIMS_IMPUESTO, DIMS_SOAT,
  FECHA_DERECHO_CREACION, FECHA_DERECHO_PAGO, FECHA_IMPUESTO_CREACION, FECHA_IMPUESTO_PAGO, FECHA_SOAT_CREACION, FECHA_SOAT_PAGO,
} from './flito-torre.productos-sql.js';
import { TorreConsultaInvalidaError } from './flito-torre.service.js';

export type FormaMetrica = 'conteo' | 'suma' | 'tasa' | 'tiempo';

/** Variante de una métrica por fecha base (RN-TOR-M10): lo que cambia al anclar la métrica en otra fecha. */
export interface VarianteFecha {
  fecha: FechaBase;
  campoFecha: string;
  /** Condiciones propias de la variante (se suman a las `fijas` de la métrica). */
  fijas: SQL[];
  /** Condición «usó la fecha de sincronización» (para `nBaseSincronizacion`; solo con creación, RN-TOR-M12). */
  sync?: SQL;
  /** JOIN que la variante añade al `desde` de la métrica (facturación: `FACTURACION_TRAMITE`). */
  desdeExtra?: SQL;
}

export interface DefMetricaSql {
  /** `FROM` + `JOIN` fijos. */
  desde: SQL;
  dims: DimensionesBase;
  /** Condiciones de la métrica que valen para TODAS sus fechas base (p. ej. `LIQUIDACION_VIGENTE`). */
  fijas: SQL[];
  forma: FormaMetrica;
  /** suma: la expresión sumada · tasa: la condición del numerador · tiempo: las horas. */
  valor?: SQL;
  /** tiempo: condición que deja fuera al registro (se cuenta en `excluidosSinFecha`). */
  requiere?: SQL;
  /** Variantes por fecha base; las claves son las `fechasBase` de shared-types. Vacío = foto del momento. */
  fechas: Partial<Record<FechaBaseTorre, VarianteFecha>>;
  /** Solo en las de foto (sin variantes): qué declara `baseFecha.campo`. */
  campoFoto?: string;
  /** B3: columnas del detalle propias (las de producto); el resto sale de `colsTramite`. */
  colsDetalle?: Partial<Record<ColumnaDetalleId, SQL>>;
}

/** La métrica con su fecha base ya elegida: lo único que consume el motor. */
export interface DefResuelta {
  desde: SQL;
  dims: DimensionesBase;
  /** `undefined` = foto del momento: no se acota por rango ni se agrupa por tiempo. */
  fecha?: FechaBase;
  fechaBase: FechaBaseTorre | null;
  campoFecha: string;
  fijas: SQL[];
  forma: FormaMetrica;
  valor?: SQL;
  requiere?: SQL;
  sync?: SQL;
  colsDetalle?: Partial<Record<ColumnaDetalleId, SQL>>;
}

const T = flitoTramites;
const L = flitoLiquidaciones;
const SF = siigoFacturaTramites;

/**
 * RN-TOR-O1: último cambio de `flit_estado` (historial), con respaldo en la fecha de creación. Es la «entrada al estado
 * actual» de `flito-tramites` (RN-TRA-B1): el mismo SQL que usa la regla de borrador abandonado.
 */
export const ULTIMO_CAMBIO_ESTADO = ENTRADA_ESTADO_ACTUAL;
/** Días completos en el estado actual: la columna `dias_en_estado` del detalle y el tramo de antigüedad (B2). */
export const DIAS_EN_ESTADO = sql`floor(EXTRACT(EPOCH FROM (now() - ${ULTIMO_CAMBIO_ESTADO})) / 86400)::int`;
/** Horas en el estado actual: el valor de la métrica `dias_en_estado` del Explorador (B2). */
export const HORAS_EN_ESTADO = sql`(EXTRACT(EPOCH FROM (now() - ${ULTIMO_CAMBIO_ESTADO})) / 3600.0)`;

export const DIMS_TRAMITE: DimensionesBase = {
  compania: T.companiaId, organismo: T.organismoCodigo, tipoTramite: T.tipoTramite, flitEstado: T.flitEstado,
  diasEnEstado: DIAS_EN_ESTADO,
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

/** RN-TOR-L1: estados de FLIT cuya liquidación no se suma. «Rechazado» NO está (decisión L-β). */
export const ESTADOS_FLIT_ANULADOS = ['anulado', 'abortado', 'revocado'] as const;

/**
 * RN-TOR-L1: el fragmento ÚNICO de «liquidación vigente». El `COALESCE` es obligatorio: sin él un `flit_estado` nulo
 * daría `NULL` y la liquidación se excluiría por error. Exige `flito_tramites` en el `FROM`.
 */
export const LIQUIDACION_VIGENTE = sql`COALESCE(lower(${T.flitEstado}), '') NOT IN ${[...ESTADOS_FLIT_ANULADOS]}`;

/** El trámite está en una factura de Siigo activa. */
export const FACTURADO = sql`EXISTS (SELECT 1 FROM ${SF}
  WHERE ${SF.tramiteId} = ${T.id} AND ${SF.activo} = true)`;

/**
 * RN-TOR-M14: fecha de facturación = la PRIMERA factura activa del trámite (misma definición que `FACTURADO` y
 * RN-TOR-P4). Tabla derivada agregada por trámite + `INNER JOIN`: un trámite con varias facturas cuenta una vez y uno
 * sin factura activa queda fuera. Índice parcial `(tramite_id, created_at) WHERE activo` de la 0304.
 */
const FAC = sql.identifier('torre_fac');
export const FACTURACION_TRAMITE = sql`INNER JOIN (SELECT ${SF.tramiteId} AS tramite_id, min(${SF.createdAt}) AS facturado_en
  FROM ${SF} WHERE ${SF.activo} = true GROUP BY ${SF.tramiteId}) ${FAC} ON ${FAC}.tramite_id = ${T.id}`;
export const FECHA_FACTURACION: FechaBase = { expr: sql`${FAC}.facturado_en` };

const DESDE_TRAMITES = sql`${T}`;
const DESDE_LIQUIDACIONES = sql`${L} INNER JOIN ${T} ON ${T.id} = ${L.tramiteId}`;
const DESDE_TRAMITES_LIQ = sql`${T} LEFT JOIN ${L} ON ${L.tramiteId} = ${T.id}`;

export const APROBADO = sql`${T.fechaAprobacion} IS NOT NULL`;

// ── Fragmentos de los tableros (ADR-0047: cifra y detalle desde el MISMO SQL; vienen de operativa/comercial/financiera) ──

const H = flitoTramiteHistorial;
/** «Entregado» / «Enviado a OT»: en manos del organismo (el umbral `dias_respuesta_ot` del inventario, B2). */
export const ESTADOS_EN_OT = ['entregado', 'enviado a ot'];

/**
 * RN-TOR-O1 + RN-TRA-B1 (B2-AC2): en Borrador desde hace más de `dias` días contados desde la ENTRADA al estado. Es el
 * fragmento de `flito-tramites` (dueño del dato), el mismo de la alerta `borrador_5d`.
 */
export { BORRADOR_ABANDONADO };

/** RN-TOR-O1: en el organismo («Entregado»/«Enviado a OT»), sin aprobar, sin cambiar de estado hace más de `dias`. */
export const ESTANCADO_OT = (dias: number): SQL => sql`(lower(${T.flitEstado}) IN ${ESTADOS_EN_OT} AND ${T.fechaAprobacion} IS NULL
    AND ${ULTIMO_CAMBIO_ESTADO} < now() - make_interval(days => ${dias}))`;

/** RN-TOR-C3: radicado = pasó por «Entregado»/«Enviado a OT» o ya está aprobado. */
export const RADICADO = sql`(${T.fechaAprobacion} IS NOT NULL
  OR lower(${T.flitEstado}) IN ${['entregado', 'enviado a ot', 'aprobado']}
  OR EXISTS (SELECT 1 FROM ${H} WHERE ${H.tramiteId} = ${T.id} AND ${H.campo} = 'flit_estado'
    AND lower(${H.valorNuevo}) IN ${['entregado', 'enviado a ot']}))`;

export const RECHAZADO = sql`lower(${T.flitEstado}) = 'rechazado'`;

/** RN-TOR-FI4: soportes vigentes (no descartados) de SOAT, impuesto y derecho del trámite. */
const S = flitoSoportes;
// `descartado` es NOT NULL: sin COALESCE, para que los índices `idx_flito_soportes_*_tipo` sirvan (db-review).
const SOPORTE_VIGENTE = sql`${S.descartado} = false`;
export const SOPORTE_SOAT = sql`EXISTS (SELECT 1 FROM ${S} WHERE ${S.soatId} = ${T.soatId} AND ${SOPORTE_VIGENTE})`;
export const SOPORTE_IMPUESTO = sql`EXISTS (SELECT 1 FROM ${S} INNER JOIN ${flitoImpuestos} ON ${flitoImpuestos.id} = ${S.impuestoId}
  WHERE ${flitoImpuestos.tramiteId} = ${T.id} AND ${SOPORTE_VIGENTE})`;
export const SOPORTE_DERECHO = sql`EXISTS (SELECT 1 FROM ${flitoDerechosTramite} WHERE ${flitoDerechosTramite.tramiteId} = ${T.id}
  AND (${flitoDerechosTramite.soporteId} IS NOT NULL
    OR EXISTS (SELECT 1 FROM ${S} WHERE ${S.derechoId} = ${flitoDerechosTramite.id} AND ${SOPORTE_VIGENTE})))`;
/** 0..3 soportes vigentes. */
export const PUNTOS_SOPORTE = sql`(CASE WHEN ${SOPORTE_SOAT} THEN 1 ELSE 0 END
  + CASE WHEN ${SOPORTE_IMPUESTO} THEN 1 ELSE 0 END
  + CASE WHEN ${SOPORTE_DERECHO} THEN 1 ELSE 0 END)`;

/** RN-TOR-O4: viajes adicionales (`numero >= 2`) de la logística del trámite. */
const V = flitoTramiteViajesLogistica;
export const VIAJES_ADICIONALES = sql`(SELECT count(*)::int FROM ${V} WHERE ${V.tramiteId} = ${T.id} AND ${V.numero} >= 2)`;

// ── Variantes reutilizables (RN-TOR-M11) ──────────────────────────────────────────────────────────────────────
const POR_CREACION: VarianteFecha = { fecha: FECHA_CREACION, campoFecha: 'fecha_creacion_flit', fijas: [], sync: SIN_FECHA_FLIT };
const POR_APROBACION: VarianteFecha = { fecha: FECHA_APROBACION, campoFecha: 'fecha_aprobacion', fijas: [APROBADO] };
const POR_FACTURACION: VarianteFecha = {
  fecha: FECHA_FACTURACION, campoFecha: 'siigo_factura_tramites.created_at (primera activa)', fijas: [], desdeExtra: FACTURACION_TRAMITE,
};

/** B3: variantes de un producto (su fecha de creación o de pago, que exige la fecha). */
const PRODUCTO_CREACION = (fecha: FechaBase, campoFecha: string): VarianteFecha => ({ fecha, campoFecha, fijas: [] });
const PRODUCTO_PAGO = (fecha: FechaBase, campoFecha: string): VarianteFecha => ({ fecha, campoFecha, fijas: [sql`${fecha.expr} IS NOT NULL`] });

export const CATALOGO_SQL: Record<MetricaTorreId, DefMetricaSql> = {
  // RN-TOR-M13: métrica neutra del constructor. `tramites`+creación ≡ `tramites_creados`; `tramites`+aprobación ≡
  // `tramites_aprobados` (sin mirar `flit_estado`, RN-TOR-M1: «siguen en Aprobado» es el filtro `flitEstados`).
  tramites: {
    desde: DESDE_TRAMITES, dims: DIMS_TRAMITE, fijas: [], forma: 'conteo',
    fechas: { creacion: POR_CREACION, aprobacion: POR_APROBACION, facturacion: POR_FACTURACION },
  },
  tramites_creados: {
    desde: DESDE_TRAMITES, dims: DIMS_TRAMITE, fijas: [], forma: 'conteo', fechas: { creacion: POR_CREACION },
  },
  tramites_aprobados: {
    desde: DESDE_TRAMITES, dims: DIMS_TRAMITE, fijas: [], forma: 'conteo', fechas: { aprobacion: POR_APROBACION },
  },
  tiempo_creacion_aprobacion: {
    desde: DESDE_TRAMITES, dims: DIMS_TRAMITE, fijas: [], forma: 'tiempo', valor: HORAS_CICLO,
    requiere: sql`${T.fechaCreacionFlit} IS NOT NULL`,
    fechas: { aprobacion: { ...POR_APROBACION, campoFecha: 'fecha_creacion_flit → fecha_aprobacion' } },
  },
  costo_logistica: {
    desde: DESDE_LIQUIDACIONES, dims: DIMS_TRAMITE, fijas: [LIQUIDACION_VIGENTE], forma: 'suma',
    valor: sql`COALESCE(${L.valorLogistica}, 0)`,
    fechas: { aprobacion: POR_APROBACION, facturacion: POR_FACTURACION },
  },
  impuestos_pagados: {
    desde: sql`${flitoImpuestos} LEFT JOIN ${T} ON ${T.id} = ${flitoImpuestos.tramiteId}`,
    dims: { compania: flitoImpuestos.companiaId, organismo: flitoImpuestos.organismoCodigo, tipoTramite: T.tipoTramite, flitEstado: T.flitEstado },
    fijas: [], forma: 'suma', valor: sql`COALESCE(${flitoImpuestos.valorPagado}, 0)`,
    fechas: { pago: { fecha: { expr: flitoImpuestos.pagadoEn }, campoFecha: 'pagado_en', fijas: [sql`${flitoImpuestos.pagadoEn} IS NOT NULL`] } },
  },
  derechos_pagados: {
    desde: sql`${flitoDerechosTramite} LEFT JOIN ${T} ON ${T.id} = ${flitoDerechosTramite.tramiteId}`,
    dims: { compania: flitoDerechosTramite.companiaId, organismo: flitoDerechosTramite.organismoCodigo, tipoTramite: T.tipoTramite, flitEstado: T.flitEstado },
    fijas: [], forma: 'suma', valor: sql`COALESCE(${flitoDerechosTramite.valor}, 0)`,
    fechas: {
      pago: {
        fecha: { expr: flitoDerechosTramite.fechaPago, esDate: true }, campoFecha: 'fecha_pago',
        fijas: [sql`${flitoDerechosTramite.fechaPago} IS NOT NULL`],
      },
    },
  },
  ingreso_liquidado: {
    desde: DESDE_LIQUIDACIONES, dims: DIMS_TRAMITE, fijas: [LIQUIDACION_VIGENTE], forma: 'suma',
    valor: sql`COALESCE(${L.total}, 0)`,
    fechas: { aprobacion: POR_APROBACION, facturacion: POR_FACTURACION },
  },
  wip_activo: {
    desde: DESDE_TRAMITES, dims: DIMS_TRAMITE, fijas: [EN_CURSO], forma: 'conteo', fechas: {}, campoFoto: 'estado actual',
  },
  // B2: horas que llevan los trámites en curso en su estado actual (foto, mismo universo que `wip_activo`).
  dias_en_estado: {
    desde: DESDE_TRAMITES, dims: DIMS_TRAMITE, fijas: [EN_CURSO], forma: 'tiempo', valor: HORAS_EN_ESTADO, fechas: {},
    campoFoto: 'último cambio de estado',
  },
  tasa_aprobacion: {
    desde: DESDE_TRAMITES, dims: DIMS_TRAMITE, fijas: [], forma: 'tasa', valor: APROBADO, fechas: { creacion: POR_CREACION },
  },
  // RN-TOR-L1: es un CONTEO de trámites (no suma la liquidación), así que no lleva `LIQUIDACION_VIGENTE`.
  sin_facturar: {
    desde: DESDE_TRAMITES_LIQ, dims: DIMS_TRAMITE, fijas: [sql`NOT ${FACTURADO}`], forma: 'conteo',
    fechas: { aprobacion: POR_APROBACION },
  },
  // B3 (Productos), RN-TOR-M15: sin fecha base nueva (decisión del humano): creación del registro o pago. El SOAT se ve
  // con su PRIMER trámite (RN-TOR-P1); impuesto y derecho, con el suyo (LEFT JOIN, como `impuestos_pagados`).
  soat_gestionados: {
    desde: DESDE_SOAT, dims: DIMS_SOAT, fijas: [], forma: 'conteo', colsDetalle: COLS_SOAT,
    fechas: { creacion: PRODUCTO_CREACION(FECHA_SOAT_CREACION, 'flito_soat.created_at'), pago: PRODUCTO_PAGO(FECHA_SOAT_PAGO, 'pagado_en') },
  },
  soat_pagados_valor: {
    desde: DESDE_SOAT, dims: DIMS_SOAT, fijas: [], forma: 'suma', valor: sql`COALESCE(${flitoSoat.valorPagado}, 0)`, colsDetalle: COLS_SOAT,
    fechas: { pago: PRODUCTO_PAGO(FECHA_SOAT_PAGO, 'pagado_en') },
  },
  impuestos_gestionados: {
    desde: DESDE_IMPUESTOS, dims: DIMS_IMPUESTO, fijas: [], forma: 'conteo', colsDetalle: COLS_IMPUESTO,
    fechas: { creacion: PRODUCTO_CREACION(FECHA_IMPUESTO_CREACION, 'flito_impuestos.created_at'), pago: PRODUCTO_PAGO(FECHA_IMPUESTO_PAGO, 'pagado_en') },
  },
  derechos_registrados: {
    desde: DESDE_DERECHOS, dims: DIMS_DERECHO, fijas: [], forma: 'conteo', colsDetalle: COLS_DERECHO,
    fechas: { creacion: PRODUCTO_CREACION(FECHA_DERECHO_CREACION, 'flito_derechos_tramite.created_at'), pago: PRODUCTO_PAGO(FECHA_DERECHO_PAGO, 'fecha_pago') },
  },
};

/**
 * RN-TOR-M10: resuelve la variante de la fecha base (ausente = la de defecto, idéntica a la de antes). El servicio
 * VUELVE a exigir la matriz aunque Zod ya la validó: una fecha fuera de ella es 400, nunca otra cifra.
 */
export function resolverDef(metrica: MetricaTorreId, fechaBase?: FechaBaseTorre): DefResuelta {
  const def = CATALOGO_SQL[metrica];
  const elegida = fechaBase ?? fechaBasePorDefecto(metrica);
  if (fechaBase && !esFechaBasePermitida(metrica, fechaBase)) throw new TorreConsultaInvalidaError('fechaBase', 'esa fecha base no aplica a la métrica');
  const v = elegida ? def.fechas[elegida] : undefined;
  if (elegida && !v) throw new TorreConsultaInvalidaError('fechaBase', 'esa fecha base no aplica a la métrica');
  return {
    desde: v?.desdeExtra ? sql`${def.desde} ${v.desdeExtra}` : def.desde,
    dims: def.dims, forma: def.forma, valor: def.valor, requiere: def.requiere,
    fecha: v?.fecha, fechaBase: v ? elegida : null, campoFecha: v?.campoFecha ?? def.campoFoto ?? 'estado actual',
    fijas: [...(v?.fijas ?? []), ...def.fijas], sync: v?.sync, colsDetalle: def.colsDetalle,
  };
}
