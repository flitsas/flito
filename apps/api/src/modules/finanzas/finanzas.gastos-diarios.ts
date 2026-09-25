// Finanzas — Gastos diarios: serie por día del evento y totales por categoría (HU #12623, Feature
// #12621, Épica #12248).
//
// NO es el consolidado del reporte con `periodo=dia`: aquel agrupa por la fecha de aprobación del
// trámite y deja mandar la liquidación sellada. Aquí cada categoría cuenta el día en que su gasto se
// EJECUTÓ, leído de la fuente del evento (RN-01), en calendario de Colombia (RN-04) y sin leer
// `flito_liquidaciones` (RN-03): cinco sub-consultas independientes en `Promise.all`, cada una con la
// proyección `{ dia, cantidad, valor }` agrupada por `dia`, volcadas en JS sobre el rango completo.
//
// Cada `ensamblar<Fuente>()` recibe la consulta ya abierta —como `ensamblarConsolidado`— para que el
// test la abra con `QueryBuilder` y lea el SQL renderizado de ESTA función: el CI no tiene Postgres y
// el mock ignora joins, `where` y `groupBy`.
//
// El huso va LITERAL dentro del template (`AT TIME ZONE 'America/Bogota'`) y la expresión `dia` de
// cada consulta es UNA instancia usada en SELECT y GROUP BY: Drizzle no deduplica literales, y un
// `${TZ}` en los dos sitios serían `$1` y `$2`, que Postgres rechaza con 42803 en toda llamada
// (Bug #12058; precedente `APROBADO_UTC`/`EXPR_PERIODO`).
//
// Sin registro PII (`logPiiAccess`): la respuesta son días, cantidades y sumas. No viaja placa, VIN,
// titular, documento ni id de trámite, así que no hay acceso a datos personales que auditar (AC8).
// Solo lecturas: ningún INSERT/UPDATE/DELETE ni `db.transaction`.
//
// Variante de `release` (promoción selectiva de la Épica #12248): los servicios adicionales (Épica
// #12246, tabla `flito_tramite_servicios_adicionales`) aún no existen en producción, así que su
// categoría sale en cero sin consultar. La merge completa `staging → release` restituye la sub-consulta.

import { and, inArray, sql, type SQL } from 'drizzle-orm';
import type { PgColumn, PgSelect } from 'drizzle-orm/pg-core';
import { db } from '../../db/client.js';
import {
  clients, flitoDerechosTramite, flitoExcepcionesAutogestion, flitoImpuestos, flitoSoat, flitoTramites,
} from '../../db/schema.js';
import { createdInRangeCondition, hoyColombia, parseFechaQuery } from '../../shared/utils/fecha-rango.js';
import { TASA_GMF } from '../flito-liquidacion/flito-liquidacion.service.js';
import {
  claveEmpresa, EXPR_LOGISTICA_ESTIMADA, indiceEmpresas, JOIN_EXC_LOGISTICA, JOIN_LG, lg,
  type EmpresaMaestro,
} from './finanzas.service.js';
import { redondear } from './finanzas.consolidado.js';
import {
  GASTOS_DIARIOS_CATEGORIAS, GASTOS_DIARIOS_RANGO_DEFAULT_DIAS, GASTOS_DIARIOS_RANGO_MAX_DIAS,
  type GastosDiariosCategoria, type GastosDiariosCelda, type GastosDiariosDia, type GastosDiariosRespuesta,
  type GastosDiariosTotales,
} from '@operaciones/shared-types';

// ── El rango ────────────────────────────────────────────────────────────────

/** `desde`/`hasta` ya validados: `YYYY-MM-DD`, `desde <= hasta`, a lo sumo 366 días. */
export interface RangoDias { desde: string; hasta: string }

export type RangoResuelto =
  | { ok: true; rango: RangoDias }
  | { ok: false; error: string; parametro: 'desde' | 'hasta' };

/** Aritmética de días sobre `YYYY-MM-DD` en UTC: sin reloj local y sin cambios de hora de por medio. */
const aUtc = (iso: string): number => {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
};
export const sumarDias = (iso: string, n: number): string =>
  new Date(aUtc(iso) + n * 86_400_000).toISOString().slice(0, 10);
const diasEntre = (desde: string, hasta: string): number => Math.round((aUtc(hasta) - aUtc(desde)) / 86_400_000) + 1;

/**
 * El rango de la petición (RN-09). Sin los dos: los últimos 30 días, hoy incluido, en el calendario
 * de Colombia. Uno solo, una fecha que no es un día del calendario, `hasta < desde` o más de 366
 * días son 400 nombrando el parámetro: nunca «todo el histórico» por un parámetro mal escrito.
 */
export function resolverRango(desde: unknown, hasta: unknown, hoy: string = hoyColombia()): RangoResuelto {
  if (desde === undefined && hasta === undefined) {
    return { ok: true, rango: { desde: sumarDias(hoy, -(GASTOS_DIARIOS_RANGO_DEFAULT_DIAS - 1)), hasta: hoy } };
  }
  if (desde === undefined) return { ok: false, error: 'Falta el parámetro desde (YYYY-MM-DD)', parametro: 'desde' };
  if (hasta === undefined) return { ok: false, error: 'Falta el parámetro hasta (YYYY-MM-DD)', parametro: 'hasta' };
  const d = parseFechaQuery(desde);
  if (!d) return { ok: false, error: 'El parámetro desde debe ser un día YYYY-MM-DD', parametro: 'desde' };
  const h = parseFechaQuery(hasta);
  if (!h) return { ok: false, error: 'El parámetro hasta debe ser un día YYYY-MM-DD', parametro: 'hasta' };
  if (h < d) return { ok: false, error: 'El parámetro hasta no puede ser anterior a desde', parametro: 'hasta' };
  if (diasEntre(d, h) > GASTOS_DIARIOS_RANGO_MAX_DIAS) {
    return { ok: false, error: `El rango desde–hasta no puede superar ${GASTOS_DIARIOS_RANGO_MAX_DIAS} días`, parametro: 'hasta' };
  }
  return { ok: true, rango: { desde: d, hasta: h } };
}

// ── Las cinco sub-consultas ─────────────────────────────────────────────────

/** `to_char(<ts> AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD')`, huso literal (ver cabecera). */
const diaBogota = (col: PgColumn): SQL<string> => sql<string>`to_char(${col} AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD')`;

/** UNA instancia por consulta: la misma va al SELECT y al GROUP BY. */
export const DIA_SOAT = diaBogota(flitoSoat.pagadoEn);
export const DIA_IMPUESTO = diaBogota(flitoImpuestos.pagadoEn);
/** `fecha_pago` es `date`: un día civil sin instante, así que no hay huso que convertir. */
export const DIA_DERECHO = sql<string>`to_char(${flitoDerechosTramite.fechaPago}, 'YYYY-MM-DD')`;
export const DIA_LOGISTICA = diaBogota(flitoTramites.fechaAprobacion);

/** Lo que devuelve cada sub-consulta: `numeric` sumado llega como texto. */
export interface FilaSerie { dia: string; cantidad: number | string; valor: string | number }

/** La proyección de una sub-consulta: `COUNT` de filas de la fuente (una por evento) y `SUM` del valor. */
export function seleccion(dia: SQL<string>, valor: PgColumn | SQL, cantidad: SQL<number> = sql<number>`COUNT(*)::int`) {
  return { dia, cantidad, valor: sql<string>`COALESCE(SUM(${valor}), 0)` } as const;
}

/** `[desde, hasta]` inclusivo por día colombiano sobre un `timestamptz`. */
const enRango = (col: PgColumn, r: RangoDias): SQL => createdInRangeCondition(col, r)!;

/**
 * Filtro de cliente para las fuentes que cuelgan de un trámite: `EXISTS` al trámite por
 * `tramite_id` con `compania_nit IN (...)`, el mismo predicado que `condiciones()` del reporte
 * (RN-07). Sin empresas (o lista vacía) no se añade nada: «sin filtro», no «ninguna empresa».
 */
const deEmpresas = (tramiteId: PgColumn, empresas: string[] | undefined): SQL | undefined =>
  (empresas?.length
    ? sql`EXISTS (SELECT 1 FROM ${flitoTramites} WHERE ${flitoTramites.id} = ${tramiteId} AND ${inArray(flitoTramites.companiaNit, empresas)})`
    : undefined);

const PAGADO_CON_VALOR = (estado: PgColumn, valor: PgColumn): SQL =>
  sql`${estado} = 'pagado' AND ${valor} IS NOT NULL`;

/**
 * SOAT: una fila por póliza pagada, SIN join a `flito_tramites` —`soat_id` no es único y el canal
 * Cliente crea SOAT sin trámite—. El cliente se filtra por `compania_id` con los ids resueltos de
 * los NITs (`empresasIds`), y la firma distingue dos vacíos que no son el mismo:
 * - `undefined` = sin filtro de empresa → el universo.
 * - `[]` = hubo NITs y ninguno resolvió a `clients.id` → **cero filas** (`false`). Un SOAT siempre
 *   tiene `compania_id` (FK a `clients`), así que un NIT sin empresa registrada no puede tener SOAT;
 *   devolver el universo aquí enseñaría el SOAT de todas las compañías bajo un filtro de cliente.
 * No se emite `IN ()` (SQL inválido): el `false` es el mismo veto, escrito de forma que Postgres lo acepte.
 */
export function ensamblarSoat<Q extends PgSelect>(q: Q, r: RangoDias, empresasIds: number[] | undefined) {
  return q
    .where(and(
      PAGADO_CON_VALOR(flitoSoat.estado, flitoSoat.valorPagado),
      enRango(flitoSoat.pagadoEn, r),
      empresasIds === undefined ? undefined : empresasIds.length ? inArray(flitoSoat.companiaId, empresasIds) : sql`false`,
    ))
    .groupBy(DIA_SOAT);
}

export function ensamblarImpuesto<Q extends PgSelect>(q: Q, r: RangoDias, empresas: string[] | undefined) {
  return q
    .where(and(
      PAGADO_CON_VALOR(flitoImpuestos.estado, flitoImpuestos.valorPagado),
      enRango(flitoImpuestos.pagadoEn, r),
      deEmpresas(flitoImpuestos.tramiteId, empresas),
    ))
    .groupBy(DIA_IMPUESTO);
}

/** `fecha_pago` es `date`: el rango es un `BETWEEN` de días, sin conversión de huso. */
export function ensamblarDerecho<Q extends PgSelect>(q: Q, r: RangoDias, empresas: string[] | undefined) {
  return q
    .where(and(
      sql`${flitoDerechosTramite.valor} IS NOT NULL`,
      sql`${flitoDerechosTramite.fechaPago} BETWEEN ${r.desde}::date AND ${r.hasta}::date`,
      deEmpresas(flitoDerechosTramite.tramiteId, empresas),
    ))
    .groupBy(DIA_DERECHO);
}

/** La cantidad de logística: trámites cuya estimación no es NULL (los que FLITO gestiona y tienen tarifa). */
export const CANTIDAD_LOGISTICA = sql<number>`(COUNT(*) FILTER (WHERE ${EXPR_LOGISTICA_ESTIMADA} IS NOT NULL))::int`;

/**
 * Logística: sin evento propio, el día es la fecha de aprobación del trámite y el valor la rama sin
 * sellar de `EXPR_LOGISTICA` (`EXPR_LOGISTICA_ESTIMADA`, RN-02), con los MISMOS joins que el
 * reporte para resolverla —`clients`, la excepción vigente y la vigencia `lg`— y ninguno más: nada
 * de `conJoins()`, que trae `flito_liquidaciones` (RN-03).
 */
export function ensamblarLogistica<Q extends PgSelect>(q: Q, r: RangoDias, empresas: string[] | undefined) {
  return q
    .leftJoin(clients, sql`${flitoTramites.companiaId} = ${clients.id}`)
    .leftJoin(flitoExcepcionesAutogestion, JOIN_EXC_LOGISTICA)
    .leftJoin(lg, JOIN_LG)
    .where(and(
      sql`${flitoTramites.fechaAprobacion} IS NOT NULL`,
      enRango(flitoTramites.fechaAprobacion, r),
      empresas?.length ? inArray(flitoTramites.companiaNit, empresas) : undefined,
    ))
    .groupBy(DIA_LOGISTICA);
}

/**
 * Los NITs del filtro → `clients.id`, con la MISMA identidad que la faceta de empresas y el
 * consolidado (`claveEmpresa`, RN-06): NIT con o sin dígito de verificación, puntos o guiones.
 * `undefined` solo cuando no hay filtro (`empresas` ausente o vacía); si hubo NITs y ninguno
 * resolvió devuelve `[]`, que `ensamblarSoat` traduce a cero filas.
 */
export function empresasIds(empresas: string[] | undefined, maestro: EmpresaMaestro[]): number[] | undefined {
  if (!empresas?.length) return undefined;
  const indice = indiceEmpresas(maestro);
  const ids = new Set<number>();
  for (const nit of empresas) {
    const m = /^c(\d+)$/.exec(claveEmpresa({ nit, companiaId: null }, indice).clave);
    if (m) ids.add(Number(m[1]));
  }
  return [...ids];
}

// ── Centavos: la suma en entero, no en float ────────────────────────────────

/** `'215000.00'` → `21500000n`. Acepta signo y hasta dos decimales (lo que devuelve `numeric(14,2)`). */
export function aCentavos(v: string | number): bigint {
  const s = String(v).trim();
  const m = /^(-?)(\d+)(?:\.(\d{0,2}))?$/.exec(s);
  if (!m) throw new TypeError(`Valor monetario no reconocido: ${s}`);
  const [, signo, entero, frac = ''] = m;
  const c = BigInt(entero!) * 100n + BigInt(frac.padEnd(2, '0'));
  return signo === '-' ? -c : c;
}

/** `21500000n` → `'215000.00'`. */
export function deCentavos(c: bigint): string {
  const abs = c < 0n ? -c : c;
  return `${c < 0n ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

const celdaCero = (): GastosDiariosCelda => ({ cantidad: 0, valor: '0.00' });
const diaCero = (dia: string): GastosDiariosDia => ({
  dia, soat: celdaCero(), impuesto: celdaCero(), derecho: celdaCero(), logistica: celdaCero(),
  serviciosAdicionales: celdaCero(),
});

/**
 * La serie completa del rango —un elemento por día, ascendente, en cero donde no hubo gasto— con
 * las filas de cada categoría volcadas por `dia`. Una fila con un día fuera del rango se ignora:
 * no puede darse (el WHERE lo acota) y si se diera no debe inventar un día.
 */
export function serieDe(r: RangoDias, filas: Record<GastosDiariosCategoria, FilaSerie[]>): GastosDiariosDia[] {
  const porDia = new Map<string, GastosDiariosDia>();
  for (let d = r.desde; d <= r.hasta; d = sumarDias(d, 1)) porDia.set(d, diaCero(d));
  for (const cat of GASTOS_DIARIOS_CATEGORIAS) {
    for (const f of filas[cat]) {
      const dia = porDia.get(f.dia);
      if (dia) dia[cat] = { cantidad: Number(f.cantidad), valor: deCentavos(aCentavos(f.valor)) };
    }
  }
  return [...porDia.values()];
}

/**
 * Totales del periodo (RN-05): por categoría la suma de la serie en centavos enteros; `base` la suma
 * de las cinco; `gmfEstimado = ROUND(base × TASA_GMF, 2)` —la tasa del liquidador, no un literal—;
 * `total = base + gmfEstimado`. La única operación en `Number` es el producto por la tasa (la base
 * cabe en un double); su resultado vuelve a centavos antes de sumarse.
 */
export function totalesDe(serie: GastosDiariosDia[]): GastosDiariosTotales {
  const porCategoria = {} as Record<GastosDiariosCategoria, GastosDiariosCelda>;
  let base = 0n;
  for (const cat of GASTOS_DIARIOS_CATEGORIAS) {
    let cantidad = 0;
    let valor = 0n;
    for (const d of serie) { cantidad += d[cat].cantidad; valor += aCentavos(d[cat].valor); }
    porCategoria[cat] = { cantidad, valor: deCentavos(valor) };
    base += valor;
  }
  const gmf = BigInt(Math.round(redondear((Number(base) / 100) * TASA_GMF) * 100));
  return { ...porCategoria, base: deCentavos(base), gmfEstimado: deCentavos(gmf), total: deCentavos(base + gmf) };
}

// ── La consulta ─────────────────────────────────────────────────────────────

export async function gastosDiarios(r: RangoDias, empresas?: string[]): Promise<GastosDiariosRespuesta> {
  // El maestro va primero: los ids de compañía del SOAT salen de él.
  const maestro = await db.select({ id: clients.id, nombre: clients.name, documento: clients.document }).from(clients);
  const [soat, impuesto, derecho, logistica] = await Promise.all([
    ensamblarSoat(db.select(seleccion(DIA_SOAT, flitoSoat.valorPagado)).from(flitoSoat).$dynamic(), r, empresasIds(empresas, maestro)),
    ensamblarImpuesto(db.select(seleccion(DIA_IMPUESTO, flitoImpuestos.valorPagado)).from(flitoImpuestos).$dynamic(), r, empresas),
    ensamblarDerecho(db.select(seleccion(DIA_DERECHO, flitoDerechosTramite.valor)).from(flitoDerechosTramite).$dynamic(), r, empresas),
    ensamblarLogistica(
      db.select(seleccion(DIA_LOGISTICA, EXPR_LOGISTICA_ESTIMADA, CANTIDAD_LOGISTICA)).from(flitoTramites).$dynamic(), r, empresas,
    ),
  ]);
  const serie = serieDe(r, {
    soat: soat as FilaSerie[], impuesto: impuesto as FilaSerie[], derecho: derecho as FilaSerie[],
    logistica: logistica as FilaSerie[], serviciosAdicionales: [],
  });
  return { desde: r.desde, hasta: r.hasta, serie, totales: totalesDe(serie) };
}
