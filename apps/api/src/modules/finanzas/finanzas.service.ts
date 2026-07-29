// Finanzas — Reporte de costos por trámite (contabilidad / facturación / cobros).
//
// Cada fila es de una de dos naturalezas, y la diferencia importa:
//   SELLADA   — el trámite está liquidado: se muestran los valores congelados. Aunque hoy la tarifa
//               de la compañía sea otra, lo que se cobró fue eso.
//   ESTIMADA  — aún sin liquidar: se calcula en vivo con lo pagado y las tarifas vigentes. Puede
//               cambiar mañana, y por eso viaja marcada como estimada.
//
// Ya no hay conceptos inventados. Antes existía `COSTOS_FIJOS = { derechoTramite: 75000,
// logistica: 15000, tramiteDigital: 300000, gmf: 7000 }`, cuatro constantes iguales para todos los
// clientes que se sumaban a TODOS los trámites del reporte.

import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { alias, type PgSelect } from 'drizzle-orm/pg-core';
import { db } from '../../db/client.js';
import {
  clients, flitoDerechosTramite, flitoImpuestos, flitoLiquidaciones, flitoSoat, flitoTarifasCompania,
  flitoTramites, vehicles,
} from '../../db/schema.js';
import { TASA_GMF } from '../flito-liquidacion/flito-liquidacion.service.js';

export interface FiltrosReporte {
  buscar?: string; estados?: string[]; empresas?: string[]; tipos?: string[];
  /** 'si' = solo liquidados; 'no' = solo sin liquidar. */
  liquidado?: 'si' | 'no';
  facturado?: 'si' | 'no';
  /** Rango sobre la fecha de creación del trámite, en formato yyyy-mm-dd. */
  desde?: string; hasta?: string;
  /** Rango sobre la fecha de aprobación, en formato yyyy-mm-dd. Independiente del anterior. */
  aprobadoDesde?: string; aprobadoHasta?: string;
  page?: number; pageSize?: number;
}

/** `null` = no aplica o no configurado. NUNCA cero: un cero implícito cuadra totales falsos. */
export interface FilaReporte {
  tramiteId: string; idFlit: string; placa: string | null; estado: string | null; empresa: string | null;
  tipoTramite: string | null;
  /** Fecha en que FLIT aprobó el trámite. null mientras siga esperando aprobación. */
  fechaAprobacion: string | null;
  soat: number | null; impuesto: number | null;
  derechoTramite: number | null; logistica: number | null; tramiteDigital: number | null;
  gmf: number | null; total: number | null;
  /** true = valores congelados por una liquidación; false = estimados en vivo. */
  sellada: boolean;
  estadoLiquidacion: 'liquidado' | 'facturado' | null;
  /** Conceptos sin tarifa configurada. Si hay alguno, el total es incompleto. */
  noConfigurados: string[];
}

export interface TotalesReporte {
  soat: number; impuesto: number; derechoTramite: number; logistica: number; tramiteDigital: number;
  gmf: number; total: number;
  /** Cuántas filas del universo filtrado tienen algún concepto sin configurar. */
  filasIncompletas: number;
}
export interface ReporteCostos { items: FilaReporte[]; total: number; page: number; pageSize: number; totales: TotalesReporte }

// Alias para resolver la tarifa: la específica del tipo y la genérica. Cada join casa a lo sumo una
// fila gracias al índice único, así que un COALESCE entre ambas da la que manda, sin LATERAL.
const tdEsp = alias(flitoTarifasCompania, 'td_esp');
const tdGen = alias(flitoTarifasCompania, 'td_gen');
const lgEsp = alias(flitoTarifasCompania, 'lg_esp');
const lgGen = alias(flitoTarifasCompania, 'lg_gen');

const TIPO_NORM = sql`UPPER(TRIM(COALESCE(${flitoTramites.tipoTramite}, '')))`;

// Cada alias tiene su propio nombre literal en el tipo, así que no son intercambiables sin la unión.
type AliasTarifa = typeof tdEsp | typeof tdGen | typeof lgEsp | typeof lgGen;

function joinTarifa(a: AliasTarifa, concepto: string, especifica: boolean): SQL {
  return especifica
    ? sql`${a.companiaId} = ${flitoTramites.companiaId} AND ${a.concepto} = ${concepto} AND ${a.activo} AND ${a.tipoTramite} = ${TIPO_NORM}`
    : sql`${a.companiaId} = ${flitoTramites.companiaId} AND ${a.concepto} = ${concepto} AND ${a.activo} AND ${a.tipoTramite} IS NULL`;
}

// ── Expresiones de valor. Sellada manda; si no, se estima. ───────────────────
//
// No se usa COALESCE(sellado, estimado): en una liquidación sellada, NULL significa «no aplica», y
// un COALESCE lo reemplazaría por el estimado, resucitando un concepto que se decidió no cobrar.
const seLiquido = sql`${flitoLiquidaciones.id} IS NOT NULL`;

const EXPR_SOAT = sql`CASE WHEN ${seLiquido} THEN ${flitoLiquidaciones.valorSoat}
  WHEN COALESCE(${clients.soatAutogestionable}, false) THEN NULL
  WHEN ${flitoSoat.estado} = 'pagado' THEN ${flitoSoat.valorPagado} END`;

const EXPR_IMPUESTO = sql`CASE WHEN ${seLiquido} THEN ${flitoLiquidaciones.valorImpuesto}
  WHEN COALESCE(${clients.impuestosAutogestionable}, false) THEN NULL
  WHEN ${flitoImpuestos.estado} = 'pagado' THEN ${flitoImpuestos.valorPagado} END`;

const EXPR_DERECHO = sql`CASE WHEN ${seLiquido} THEN ${flitoLiquidaciones.valorDerecho}
  ELSE ${flitoDerechosTramite.valor} END`;

const EXPR_DIGITAL = sql`CASE WHEN ${seLiquido} THEN ${flitoLiquidaciones.valorTramiteDigital}
  ELSE COALESCE(${tdEsp.valor}, ${tdGen.valor}) END`;

const EXPR_LOGISTICA = sql`CASE WHEN ${seLiquido} THEN ${flitoLiquidaciones.valorLogistica}
  WHEN COALESCE(${clients.logisticaAutogestionable}, false) THEN NULL
  ELSE COALESCE(${lgEsp.valor}, ${lgGen.valor}) END`;

// Base del 4x1000: el total de los cinco conceptos del trámite. El GMF se calcula sobre esa suma y
// se añade encima, así que el total final es la base más su propio gravamen.
const EXPR_BASE_GMF = sql`COALESCE(${EXPR_SOAT}, 0) + COALESCE(${EXPR_IMPUESTO}, 0) + COALESCE(${EXPR_DERECHO}, 0)
  + COALESCE(${EXPR_DIGITAL}, 0) + COALESCE(${EXPR_LOGISTICA}, 0)`;
const EXPR_GMF = sql`CASE WHEN ${seLiquido} THEN ${flitoLiquidaciones.valorGmf}
  ELSE ROUND((${EXPR_BASE_GMF}) * ${TASA_GMF}, 2) END`;

const EXPR_TOTAL = sql`CASE WHEN ${seLiquido} THEN ${flitoLiquidaciones.total}
  ELSE (${EXPR_BASE_GMF}) + ROUND((${EXPR_BASE_GMF}) * ${TASA_GMF}, 2) END`;

/**
 * Una fila está incompleta si algún concepto que SÍ debería tener valor no lo tiene. Las
 * liquidaciones selladas nunca lo están: no se pudieron sellar sin resolverlo todo.
 */
const EXPR_INCOMPLETA = sql`(NOT ${seLiquido} AND (
     ${EXPR_DERECHO} IS NULL
  OR (NOT COALESCE(${clients.logisticaAutogestionable}, false) AND ${EXPR_LOGISTICA} IS NULL)
  OR ${EXPR_DIGITAL} IS NULL))`;

function condiciones(f: FiltrosReporte): SQL[] {
  const conds: SQL[] = [];
  const t = f.buscar?.trim();
  if (t) {
    const patron = `%${t.toUpperCase().replace(/[\s-]/g, '')}%`;
    const patronTexto = `%${t.toUpperCase()}%`;
    conds.push(or(
      sql`UPPER(${flitoTramites.idFlit}) LIKE ${patronTexto}`,
      sql`UPPER(REPLACE(${vehicles.plate}, '-', '')) LIKE ${patron}`,
      sql`UPPER(${vehicles.vin}) LIKE ${patron}`,
    )!);
  }
  if (f.estados?.length) conds.push(inArray(flitoTramites.flitEstado, f.estados));
  if (f.empresas?.length) conds.push(inArray(flitoTramites.companiaNit, f.empresas));
  if (f.tipos?.length) conds.push(inArray(flitoTramites.tipoTramite, f.tipos));
  if (f.liquidado === 'si') conds.push(sql`${flitoLiquidaciones.id} IS NOT NULL`);
  if (f.liquidado === 'no') conds.push(sql`${flitoLiquidaciones.id} IS NULL`);
  if (f.facturado === 'si') conds.push(sql`${flitoLiquidaciones.estado} = 'facturado'`);
  if (f.facturado === 'no') conds.push(sql`COALESCE(${flitoLiquidaciones.estado}, '') <> 'facturado'`);

  // Los dos rangos son inclusivos por día: `hasta` suma un día para no dejar fuera esa jornada.
  //
  // El de creación mira `fecha_creacion_flit`, que es cuándo NACIÓ el trámite en FLIT, no
  // `created_at`, que es cuándo el sync lo ingirió. Filtrar por `created_at` hacía que los miles de
  // históricos traídos en la carga masiva compartieran una única fecha y el filtro fuera inservible.
  // El COALESCE cubre los trámites viejos cuyo reporte aún no traía el campo.
  const nacimiento = sql`COALESCE(${flitoTramites.fechaCreacionFlit}, ${flitoTramites.createdAt})`;
  if (f.desde) conds.push(sql`${nacimiento} >= ${f.desde}::date`);
  if (f.hasta) conds.push(sql`${nacimiento} < (${f.hasta}::date + INTERVAL '1 day')`);
  if (f.aprobadoDesde) conds.push(sql`${flitoTramites.fechaAprobacion} >= ${f.aprobadoDesde}::date`);
  if (f.aprobadoHasta) conds.push(sql`${flitoTramites.fechaAprobacion} < (${f.aprobadoHasta}::date + INTERVAL '1 day')`);
  return conds;
}

/**
 * Todos los joins del reporte, en un solo sitio. Los comparten la página, el conteo, los totales y
 * la exportación: si el conteo y la página no llevan exactamente los mismos joins, el total y las
 * filas dejan de cuadrar sin que nada avise.
 */
function conJoins<Q extends PgSelect>(q: Q) {
  return q
    .innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
    .leftJoin(clients, eq(flitoTramites.companiaId, clients.id))
    .leftJoin(flitoSoat, eq(flitoTramites.soatId, flitoSoat.id))
    .leftJoin(flitoImpuestos, eq(flitoImpuestos.tramiteId, flitoTramites.id))
    .leftJoin(flitoDerechosTramite, eq(flitoDerechosTramite.tramiteId, flitoTramites.id))
    .leftJoin(flitoLiquidaciones, eq(flitoLiquidaciones.tramiteId, flitoTramites.id))
    .leftJoin(tdEsp, joinTarifa(tdEsp, 'tramite_digital', true))
    .leftJoin(tdGen, joinTarifa(tdGen, 'tramite_digital', false))
    .leftJoin(lgEsp, joinTarifa(lgEsp, 'logistica', true))
    .leftJoin(lgGen, joinTarifa(lgGen, 'logistica', false));
}

const SELECT_FILA = {
  tramiteId: flitoTramites.id, idFlit: flitoTramites.idFlit,
  placa: vehicles.plate, estado: flitoTramites.flitEstado, empresa: clients.name,
  tipoTramite: flitoTramites.tipoTramite,
  fechaAprobacion: flitoTramites.fechaAprobacion,
  sellada: sql<boolean>`${seLiquido}`,
  estadoLiquidacion: flitoLiquidaciones.estado,
  soat: sql<string | null>`${EXPR_SOAT}`,
  impuesto: sql<string | null>`${EXPR_IMPUESTO}`,
  derechoTramite: sql<string | null>`${EXPR_DERECHO}`,
  tramiteDigital: sql<string | null>`${EXPR_DIGITAL}`,
  logistica: sql<string | null>`${EXPR_LOGISTICA}`,
  gmf: sql<string | null>`${EXPR_GMF}`,
  totalFila: sql<string | null>`${EXPR_TOTAL}`,
  logisticaAutogestionable: clients.logisticaAutogestionable,
} as const;

const n = (v: string | number | null): number | null => (v === null ? null : Number(v));

function aFila(r: Record<string, unknown>): FilaReporte {
  const sellada = Boolean(r.sellada);
  const digital = n(r.tramiteDigital as string | null);
  const logistica = n(r.logistica as string | null);
  const derecho = n(r.derechoTramite as string | null);

  const noConfigurados: string[] = [];
  if (!sellada) {
    if (derecho === null) noConfigurados.push('Derecho de tránsito');
    if (digital === null) noConfigurados.push('Trámite digital');
    if (logistica === null && !r.logisticaAutogestionable) noConfigurados.push('Logística');
  }

  return {
    tramiteId: r.tramiteId as string, idFlit: r.idFlit as string,
    placa: r.placa as string | null, estado: r.estado as string | null,
    empresa: r.empresa as string | null, tipoTramite: r.tipoTramite as string | null,
    fechaAprobacion: (r.fechaAprobacion as Date | null)?.toISOString() ?? null,
    soat: n(r.soat as string | null), impuesto: n(r.impuesto as string | null),
    derechoTramite: derecho, logistica, tramiteDigital: digital,
    gmf: n(r.gmf as string | null), total: n(r.totalFila as string | null),
    sellada,
    estadoLiquidacion: (r.estadoLiquidacion as FilaReporte['estadoLiquidacion']) ?? null,
    noConfigurados,
  };
}

/**
 * Totales del UNIVERSO FILTRADO, agregados en SQL.
 *
 * Antes se calculaban con un `reduce` sobre la página, así que un filtro de 3.000 trámites mostraba
 * el total de los 50 visibles y lo rotulaba «Totales».
 */
async function totalesDe(where: SQL | undefined): Promise<TotalesReporte> {
  const [t] = await conJoins(db.select({
    soat: sql<string>`COALESCE(SUM(${EXPR_SOAT}), 0)`,
    impuesto: sql<string>`COALESCE(SUM(${EXPR_IMPUESTO}), 0)`,
    derechoTramite: sql<string>`COALESCE(SUM(${EXPR_DERECHO}), 0)`,
    tramiteDigital: sql<string>`COALESCE(SUM(${EXPR_DIGITAL}), 0)`,
    logistica: sql<string>`COALESCE(SUM(${EXPR_LOGISTICA}), 0)`,
    gmf: sql<string>`COALESCE(SUM(${EXPR_GMF}), 0)`,
    total: sql<string>`COALESCE(SUM(${EXPR_TOTAL}), 0)`,
    filasIncompletas: sql<number>`COUNT(*) FILTER (WHERE ${EXPR_INCOMPLETA})::int`,
  }).from(flitoTramites).$dynamic()).where(where);

  return {
    soat: Number(t.soat), impuesto: Number(t.impuesto), derechoTramite: Number(t.derechoTramite),
    tramiteDigital: Number(t.tramiteDigital), logistica: Number(t.logistica),
    gmf: Number(t.gmf), total: Number(t.total), filasIncompletas: Number(t.filasIncompletas),
  };
}

export async function reporteCostos(f: FiltrosReporte = {}): Promise<ReporteCostos> {
  const page = Math.max(1, Math.floor(f.page ?? 1));
  const pageSize = Math.min(200, Math.max(1, Math.floor(f.pageSize ?? 50)));
  const conds = condiciones(f);
  const where = conds.length ? and(...conds) : undefined;

  const [countRows, rows, totales] = await Promise.all([
    conJoins(db.select({ total: sql<number>`count(distinct ${flitoTramites.id})::int` })
      .from(flitoTramites).$dynamic()).where(where),
    conJoins(db.select(SELECT_FILA).from(flitoTramites).$dynamic()).where(where)
      .orderBy(sql`${flitoTramites.createdAt} DESC`).limit(pageSize).offset((page - 1) * pageSize),
    totalesDe(where),
  ]);

  return {
    items: rows.map((r: Record<string, unknown>) => aFila(r)),
    total: Number(countRows[0]?.total ?? 0), page, pageSize, totales,
  };
}

/** Todas las filas del filtro, sin paginar, para exportar. Tope duro por si el filtro está vacío. */
export const TOPE_EXPORTACION = 20_000;

export async function filasParaExportar(f: FiltrosReporte = {}): Promise<FilaReporte[]> {
  const conds = condiciones(f);
  const where = conds.length ? and(...conds) : undefined;
  const rows = await conJoins(db.select(SELECT_FILA).from(flitoTramites).$dynamic()).where(where)
    .orderBy(sql`${flitoTramites.createdAt} DESC`).limit(TOPE_EXPORTACION);
  return rows.map((r: Record<string, unknown>) => aFila(r));
}

const CABECERAS_CSV = [
  'Trámite', 'Placa', 'Estado', 'Empresa', 'Tipo', 'Aprobado', 'SOAT', 'Impuesto',
  'Derecho de tránsito', 'Trámite digital', 'Logística', 'GMF', 'Total', 'Liquidación',
  'Conceptos sin configurar',
] as const;

/** Solo el día, en ISO. Excel lo reconoce como fecha; el instante completo lo trata como texto. */
const soloDia = (iso: string | null): string | null => (iso === null ? null : iso.slice(0, 10));

/** Una celda CSV segura: comillas escapadas y campo entrecomillado si lleva separador o salto. */
function celda(v: string | number | null): string {
  if (v === null) return '';
  const s = String(v);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * CSV con `;` y BOM: es lo que Excel en español abre sin pedir asistente de importación. Con `,`
 * mete todo en una columna, y sin BOM se comen las tildes.
 */
export function aCsv(filas: FilaReporte[]): string {
  const lineas = [CABECERAS_CSV.join(';')];
  for (const f of filas) {
    lineas.push([
      f.idFlit, f.placa, f.estado, f.empresa, f.tipoTramite, soloDia(f.fechaAprobacion),
      f.soat, f.impuesto, f.derechoTramite, f.tramiteDigital, f.logistica, f.gmf, f.total,
      f.sellada ? (f.estadoLiquidacion === 'facturado' ? 'Facturado' : 'Liquidado') : 'Estimado',
      f.noConfigurados.join(' | '),
    ].map(celda).join(';'));
  }
  return `﻿${lineas.join('\r\n')}\r\n`;
}

export interface FacetasReporte {
  estados: string[]; empresas: { nit: string; nombre: string | null }[]; tipos: string[];
}
export async function facetas(): Promise<FacetasReporte> {
  const [estados, empresas, tipos] = await Promise.all([
    db.selectDistinct({ v: flitoTramites.flitEstado }).from(flitoTramites).where(sql`${flitoTramites.flitEstado} is not null`),
    db.selectDistinct({ nit: flitoTramites.companiaNit, nombre: clients.name }).from(flitoTramites)
      .leftJoin(clients, eq(flitoTramites.companiaId, clients.id)).where(sql`${flitoTramites.companiaNit} is not null`),
    db.selectDistinct({ v: flitoTramites.tipoTramite }).from(flitoTramites).where(sql`${flitoTramites.tipoTramite} is not null`),
  ]);
  return {
    estados: estados.map((e) => e.v).filter((v): v is string => !!v).sort(),
    empresas: empresas.filter((e): e is { nit: string; nombre: string | null } => !!e.nit),
    tipos: tipos.map((e) => e.v).filter((v): v is string => !!v).sort(),
  };
}
