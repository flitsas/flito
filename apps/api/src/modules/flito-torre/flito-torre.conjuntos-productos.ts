// Torre de Control Gerencial (Épica #14590, B3) — los CONJUNTOS del área Productos (SOAT · Impuestos · Derechos).
//
// Entran en `CONJUNTOS_SQL` (`flito-torre.conjuntos.ts`) y se cuentan y listan con el mismo `contarConjuntos` /
// `totalFragmento` / `listarFragmento`: la cifra del tablero y el `total` del detalle salen del MISMO fragmento.
// RN-TOR-P5: las bases van por `condicionesTorre` con las dimensiones del producto (compañía y secretaría del SOAT,
//   del impuesto o del derecho; tipo y estado del trámite asociado). Lo que el catálogo declara en `filtrosIgnorados`
//   no se aplica (las fotos ignoran el rango; las incompletas y los recibos, lo que no tienen).
// RN-TOR-P6: `impuestos_pagados_periodo` y `derechos_pagados_periodo` son las métricas `impuestos_pagados` /
//   `derechos_pagados` del Explorador: mismo `desde`, misma fecha y misma condición de pago.
// RN-TOR-P7: por vencer = SOAT pagado con `vence_el` entre hoy y hoy + `dias_soat_por_vencer` (Bogotá, ambos inclusive).
// Solo importa TIPOS de `flito-torre.conjuntos.ts` (que importa este archivo como valor): sin ciclo al cargar.
import { sql, type SQL } from 'drizzle-orm';
import { conjuntoTorre, type ConjuntoTorreId } from '@operaciones/shared-types';
import {
  flitoDerechosPendientes, flitoDerechosTramite, flitoImpuestos, flitoSoat, flitoSoatIncompletas,
} from '../../db/schema.js';
import type { ConjuntoSql } from './flito-torre.conjuntos.js';
import { condicionesTorre, type DimensionesBase, type FechaBase, type RangoResuelto } from './flito-torre.filtro.js';
import {
  COLS_DERECHO, COLS_DERECHO_PENDIENTE, COLS_IMPUESTO, COLS_SOAT, COLS_SOAT_INCOMPLETA, DERECHO_SIN_SOPORTE, DESDE_DERECHOS,
  DESDE_DERECHOS_PENDIENTES, DESDE_IMPUESTOS, DESDE_SOAT, DESDE_SOAT_INCOMPLETAS, DIMS_DERECHO, DIMS_DERECHO_PENDIENTE,
  DIMS_IMPUESTO, DIMS_SOAT, DIMS_SOAT_INCOMPLETA, FECHA_DERECHO_PAGO, FECHA_IMPUESTO_CREACION,
  FECHA_IMPUESTO_PAGO, FECHA_SOAT_CREACION, FECHA_SOAT_PAGO, HOY_BOGOTA, SOAT_PAGADO,
} from './flito-torre.productos-sql.js';
import type { ContextoTablero } from './flito-torre.tablero-comun.js';

const S = flitoSoat;
const I = flitoImpuestos;
const D = flitoDerechosTramite;

export type ConjuntoProductoId =
  | 'soat_por_estado' | 'soat_por_vencer' | 'soat_vigencia_no_verificada' | 'soat_pagados_periodo' | 'soat_incompletas_abiertas'
  | 'impuestos_por_estado' | 'impuestos_rechazados_periodo' | 'impuestos_con_diferencia' | 'impuestos_direccion_pendiente'
  | 'impuestos_pagados_periodo' | 'derechos_pagados_periodo' | 'derechos_sin_soporte' | 'derechos_pendientes_sin_resolver';

/** RN-TOR-P5: base con las dimensiones del producto, sin los filtros que el conjunto declara ignorados. */
const baseDe = (id: ConjuntoTorreId, dims: DimensionesBase, fecha?: FechaBase) =>
  (ctx: ContextoTablero, rango: RangoResuelto | null): SQL[] =>
    condicionesTorre(ctx.filtro, ctx.alcance, dims, { rango, fecha, ignorar: conjuntoTorre(id).filtrosIgnorados });

interface Pieza {
  grupo: string; entidad: ConjuntoSql['entidad']; tabla: string; desde: SQL; dims: DimensionesBase; cols: ConjuntoSql['cols'];
  id: SQL; tramiteId: SQL | null;
}

const SOAT: Pieza = {
  grupo: '', entidad: 'gestion_soat', tabla: 'flito_soat', desde: DESDE_SOAT, dims: DIMS_SOAT, cols: COLS_SOAT,
  id: sql`${S.id}`, tramiteId: sql`${sql.identifier('flito_tramites')}.id`,
};
const IMPUESTO: Pieza = {
  grupo: '', entidad: 'impuesto', tabla: 'flito_impuestos', desde: DESDE_IMPUESTOS, dims: DIMS_IMPUESTO, cols: COLS_IMPUESTO,
  id: sql`${I.id}`, tramiteId: sql`${I.tramiteId}`,
};
const DERECHO: Pieza = {
  grupo: '', entidad: 'derecho', tabla: 'flito_derechos_tramite', desde: DESDE_DERECHOS, dims: DIMS_DERECHO, cols: COLS_DERECHO,
  id: sql`${D.id}`, tramiteId: sql`${D.tramiteId}`,
};

function conjunto(
  id: ConjuntoProductoId, p: Pieza, grupo: string, propia: ConjuntoSql['propia'],
  extra: { fecha?: FechaBase; campoFecha: string; dimensiones?: ConjuntoSql['dimensiones'] },
): ConjuntoSql {
  return {
    grupo, entidad: p.entidad, tabla: p.tabla, desde: p.desde, base: baseDe(id, p.dims, extra.fecha), propia, dims: p.dims,
    fecha: extra.fecha, campoFecha: extra.campoFecha, id: p.id, tramiteId: p.tramiteId, cols: p.cols,
    ...(extra.dimensiones ? { dimensiones: extra.dimensiones } : {}),
  };
}

const ESTADO_SOAT = { estado: sql`${S.estado}::text` };
const ESTADO_IMPUESTO = { estado: sql`${I.estado}::text` };

export const CONJUNTOS_PRODUCTOS_SQL: Record<ConjuntoProductoId, ConjuntoSql> = {
  // ── SOAT ──
  soat_por_estado: conjunto('soat_por_estado', SOAT, 'soat_creacion', () => [], {
    fecha: FECHA_SOAT_CREACION, campoFecha: 'flito_soat.created_at', dimensiones: ESTADO_SOAT,
  }),
  soat_por_vencer: conjunto('soat_por_vencer', SOAT, 'soat_foto', (u) => [SOAT_PAGADO,
    sql`${S.venceEl} BETWEEN ${HOY_BOGOTA} AND ${HOY_BOGOTA} + ${u.dias_soat_por_vencer}::int`], { campoFecha: 'vence_el' }),
  soat_vigencia_no_verificada: conjunto('soat_vigencia_no_verificada', SOAT, 'soat_foto',
    () => [SOAT_PAGADO, sql`${S.estadoVigencia} = 'no_verificado'`], { campoFecha: 'estado_vigencia' }),
  soat_pagados_periodo: conjunto('soat_pagados_periodo', SOAT, 'soat_pago', () => [sql`${S.pagadoEn} IS NOT NULL`], {
    fecha: FECHA_SOAT_PAGO, campoFecha: 'pagado_en',
  }),
  soat_incompletas_abiertas: conjunto('soat_incompletas_abiertas', {
      grupo: '', entidad: 'soat_incompleta', tabla: 'flito_soat_incompletas', desde: DESDE_SOAT_INCOMPLETAS,
      dims: DIMS_SOAT_INCOMPLETA, cols: COLS_SOAT_INCOMPLETA, id: sql`${flitoSoatIncompletas.id}`, tramiteId: null,
    }, 'soat_incompletas', () => [sql`${flitoSoatIncompletas.estado} = 'incompleta'`], {
      campoFecha: 'estado actual', dimensiones: { motivo: COLS_SOAT_INCOMPLETA.motivo! },
    }),
  // ── Impuestos ──
  impuestos_por_estado: conjunto('impuestos_por_estado', IMPUESTO, 'impuesto_creacion', () => [], {
    fecha: FECHA_IMPUESTO_CREACION, campoFecha: 'flito_impuestos.created_at', dimensiones: ESTADO_IMPUESTO,
  }),
  impuestos_rechazados_periodo: conjunto('impuestos_rechazados_periodo', IMPUESTO, 'impuesto_creacion',
    () => [sql`${I.estado} = 'con_novedad'`], {
      fecha: FECHA_IMPUESTO_CREACION, campoFecha: 'flito_impuestos.created_at', dimensiones: { motivo: COLS_IMPUESTO.motivo! },
    }),
  impuestos_con_diferencia: conjunto('impuestos_con_diferencia', IMPUESTO, 'impuesto_creacion',
    () => [sql`${I.marcadoPorDiferencia} = true`], { fecha: FECHA_IMPUESTO_CREACION, campoFecha: 'flito_impuestos.created_at' }),
  impuestos_direccion_pendiente: conjunto('impuestos_direccion_pendiente', IMPUESTO, 'impuesto_foto',
    () => [sql`${I.direccionPendienteRevision} = true`], { campoFecha: 'estado actual' }),
  // RN-TOR-P6.
  impuestos_pagados_periodo: conjunto('impuestos_pagados_periodo', IMPUESTO, 'impuesto_pago', () => [sql`${I.pagadoEn} IS NOT NULL`], {
    fecha: FECHA_IMPUESTO_PAGO, campoFecha: 'pagado_en',
  }),
  // ── Derechos ──
  derechos_pagados_periodo: conjunto('derechos_pagados_periodo', DERECHO, 'derecho_pago', () => [sql`${D.fechaPago} IS NOT NULL`], {
    fecha: FECHA_DERECHO_PAGO, campoFecha: 'fecha_pago',
  }),
  derechos_sin_soporte: conjunto('derechos_sin_soporte', DERECHO, 'derecho_foto', () => [DERECHO_SIN_SOPORTE], {
    campoFecha: 'estado actual',
  }),
  derechos_pendientes_sin_resolver: conjunto('derechos_pendientes_sin_resolver', {
    grupo: '', entidad: 'derecho_pendiente', tabla: 'flito_derechos_pendientes', desde: DESDE_DERECHOS_PENDIENTES,
    dims: DIMS_DERECHO_PENDIENTE, cols: COLS_DERECHO_PENDIENTE, id: sql`${flitoDerechosPendientes.id}`, tramiteId: null,
  }, 'derecho_pendiente', () => [sql`${flitoDerechosPendientes.resuelto} = false`], {
    campoFecha: 'estado actual', dimensiones: { motivo: COLS_DERECHO_PENDIENTE.motivo! },
  }),
};
