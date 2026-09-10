// Finanzas — Consolidado del reporte de costos por cliente y periodo (HU #12433, Feature #12404).
//
// Es una AGREGACIÓN del mismo universo que el detalle, no una segunda definición de ese universo:
// el WHERE es `and(...condiciones(f))` tal cual, los joins son `conJoins()` y las sumas son de las
// mismas `EXPR_*` que alimentan cada celda (CF-13). Lo único que añade es el eje: cliente × periodo
// de aprobación (mes o trimestre, S-03), agrupado en SQL, y el plegado de los NITs a un cliente en
// JS con la MISMA identidad que la faceta de empresas (`claveEmpresa`, RN-06).
//
// Convive con el detalle en un archivo hermano —como `finanzas.facturacion-electronica.ts` y
// `finanzas.reporte-columnas.ts`— porque `finanzas.service.ts` ya está en el límite de líneas y
// porque lo que vive aquí (el eje de agregación y su CSV) no lo usa ninguna otra consulta.

import { and, sql, type SQL } from 'drizzle-orm';
import type { PgColumn, PgSelect } from 'drizzle-orm/pg-core';
import { db } from '../../db/client.js';
import { clients, flitoTramites } from '../../db/schema.js';
import {
  BOM_CSV, celda, claveEmpresa, condiciones, conJoins, indiceEmpresas, SELECT_TOTALES,
  type EmpresaMaestro, type FiltrosReporte, type TotalesReporte,
} from './finanzas.service.js';

export const PERIODOS_CONSOLIDADO = ['mes', 'trimestre'] as const;
export type PeriodoConsolidado = (typeof PERIODOS_CONSOLIDADO)[number];

/**
 * Periodo pedido por la pantalla. Uno desconocido cae en `mes`, igual que `etapa()` ignora una etapa
 * desconocida: un enlace guardado con un valor viejo tiene que seguir abriendo, no romperse con 400.
 */
export function periodoConsolidado(v: unknown): PeriodoConsolidado {
  return v === 'trimestre' ? 'trimestre' : 'mes';
}

/** Los mismos numéricos que `TotalesReporte`: el consolidado agrega exactamente lo que el detalle totaliza. */
export type TotalesConsolidado = TotalesReporte;

export interface FilaConsolidado extends TotalesConsolidado {
  /** La clave de `claveEmpresa`: `c<id>` si hay empresa registrada, `n<raíz del NIT>` si no. */
  clienteClave: string;
  clienteNombre: string;
  /** `'YYYY-MM'` o `'YYYY-Tn'`; `null` = sin fecha de aprobación (se rotula «Sin aprobar»). */
  periodo: string | null;
  tramites: number;
}

export interface ConsolidadoReporte {
  periodo: PeriodoConsolidado;
  items: FilaConsolidado[];
  totales: TotalesConsolidado;
}

// ── El periodo, en SQL ──────────────────────────────────────────────────────
//
// En UTC, como `periodoDe()` del detalle (HU #12432, AC7): el mismo instante tiene que caer en el
// mismo mes en la celda y en el consolidado, o una aprobación de las 23:30 de Colombia del 30-sep
// se contaría en septiembre en una y en octubre en la otra.
//
// SIN parámetros, a propósito: `'YYYY-MM'` va como literal dentro del template y no interpolado.
// Drizzle no deduplica literales, así que un `${'YYYY-MM'}` en el SELECT y otro en el GROUP BY
// serían `$1` y `$2`, y Postgres —que compara el árbol, no el valor— rechazaría la consulta con
// 42803 en toda llamada (Bug #12058). Por lo mismo la instancia que va al SELECT y la del GROUP BY
// es UNA: `EXPR_PERIODO[periodo]`.
const APROBADO_UTC = sql`(${flitoTramites.fechaAprobacion} AT TIME ZONE 'UTC')`;

export const EXPR_PERIODO: Record<PeriodoConsolidado, SQL> = {
  mes: sql`to_char(${APROBADO_UTC}, 'YYYY-MM')`,
  // Trimestre CALENDARIO (RN-05): `EXTRACT(QUARTER …)`, no una división del mes. Concatenado con
  // `||` da `'2026-T3'`, la misma forma que `periodoDe()`.
  trimestre: sql`(to_char(${APROBADO_UTC}, 'YYYY') || '-T' || EXTRACT(QUARTER FROM ${APROBADO_UTC}))`,
};

/**
 * La proyección REAL del consolidado, exportada para que el test afirme sobre ella. Las tres claves
 * de agrupación van primero; las sumas son `SELECT_TOTALES` tal cual —las mismas expresiones, el
 * mismo `COALESCE` por término (RN-02) y el mismo contador de incompletas—, por lo que cada celda
 * del consolidado es exactamente `totalesDe()` restringido a ese (cliente, periodo).
 */
export function selectConsolidado(periodo: PeriodoConsolidado) {
  return {
    companiaId: flitoTramites.companiaId,
    companiaNit: flitoTramites.companiaNit,
    periodo: EXPR_PERIODO[periodo],
    // DISTINCT, como el conteo del detalle: los joins pueden multiplicar en teoría, y un grupo con
    // más «trámites» que trámites descuadraría con la tabla.
    tramites: sql<number>`COUNT(DISTINCT ${flitoTramites.id})::int`,
    ...SELECT_TOTALES,
  } as const;
}

/** Las tres claves del GROUP BY, con la MISMA instancia de la expresión de periodo que el SELECT. */
export const clavesAgrupacion = (periodo: PeriodoConsolidado): Array<PgColumn | SQL> => [
  flitoTramites.companiaId, flitoTramites.companiaNit, EXPR_PERIODO[periodo],
];

/**
 * Joins, predicado y agrupación sobre un `select(selectConsolidado(periodo)).from(flitoTramites)`
 * ya abierto. Recibe la consulta en vez de crearla —como `resumenFacturacionElectronica` recibe
 * `conJoins`— para que el test la abra con `QueryBuilder` y lea el SQL renderizado de ESTA función,
 * no de una copia: el CI no tiene Postgres, y el mock ignora joins, `where` y `groupBy`.
 */
export function ensamblarConsolidado<Q extends PgSelect>(q: Q, f: FiltrosReporte, periodo: PeriodoConsolidado) {
  const conds = condiciones(f);
  return conJoins(q)
    .where(conds.length ? and(...conds) : undefined)
    .groupBy(...clavesAgrupacion(periodo));
}

/** Un grupo tal como lo devuelve la consulta: (compañía, NIT, periodo) con sus sumas como texto. */
export interface GrupoConsolidado {
  companiaId: number | null; companiaNit: string | null; periodo: string | null;
  tramites: number | string;
  soat: string | number; impuesto: string | number; derechoTramite: string | number;
  tramiteDigital: string | number; logistica: string | number; gmf: string | number;
  total: string | number; totalReintegro: string | number; totalServicio: string | number;
  filasIncompletas: number | string;
}

const NUMERICOS = [
  'soat', 'impuesto', 'derechoTramite', 'logistica', 'tramiteDigital', 'gmf', 'total',
  'totalReintegro', 'totalServicio', 'filasIncompletas',
] as const satisfies ReadonlyArray<keyof TotalesConsolidado>;

const totalesEnCero = (): TotalesConsolidado => ({
  soat: 0, impuesto: 0, derechoTramite: 0, logistica: 0, tramiteDigital: 0, gmf: 0, total: 0,
  totalReintegro: 0, totalServicio: 0, filasIncompletas: 0,
});

/** Las sumas vienen de `numeric`; al sumarlas en JS se redondea a centavos como `subtotalesDe`. */
const redondear = (v: number): number => Math.round(v * 100) / 100;

/**
 * Los grupos SQL (compañía, NIT, periodo) plegados a (cliente, periodo).
 *
 * Un cliente puede llegar en varios grupos del mismo periodo —el NIT con y sin dígito de
 * verificación, unos trámites emparejados por el sync y otros no—, y aquí caen juntos por
 * `claveEmpresa`, que es la misma regla de la faceta (RN-06). Los grupos con periodo `null` NO se
 * descartan: son trámites que el filtro dejó pasar sin fecha de aprobación, y quitarlos haría que
 * el pie del consolidado sumara menos que el del detalle (CF-13). No se rellenan celdas en cero:
 * solo existe la fila que tuvo trámites (CF-15).
 *
 * Orden: cliente por nombre y, dentro, periodo ascendente con «Sin aprobar» al final.
 */
export function plegarConsolidado(
  grupos: GrupoConsolidado[],
  maestro: EmpresaMaestro[],
): { items: FilaConsolidado[]; totales: TotalesConsolidado } {
  const indice = indiceEmpresas(maestro);
  const filas = new Map<string, FilaConsolidado>();
  const totales = totalesEnCero();

  for (const g of grupos) {
    const { clave, nombre } = claveEmpresa({ nit: g.companiaNit, companiaId: g.companiaId }, indice);
    const periodo = g.periodo ?? null;
    const id = `${clave}|${periodo ?? ''}`;
    const fila = filas.get(id) ?? {
      clienteClave: clave, clienteNombre: nombre, periodo, tramites: 0, ...totalesEnCero(),
    };
    fila.tramites += Number(g.tramites);
    for (const k of NUMERICOS) {
      const v = Number(g[k]);
      fila[k] = redondear(fila[k] + v);
      totales[k] = redondear(totales[k] + v);
    }
    filas.set(id, fila);
  }

  const items = [...filas.values()].sort((a, b) => {
    const porNombre = a.clienteNombre.localeCompare(b.clienteNombre, 'es');
    if (porNombre !== 0) return porNombre;
    if (a.periodo === b.periodo) return 0;
    if (a.periodo === null) return 1;
    if (b.periodo === null) return -1;
    return a.periodo < b.periodo ? -1 : 1;
  });
  return { items, totales };
}

export async function consolidadoReporte(
  f: FiltrosReporte = {},
  periodo: PeriodoConsolidado = 'mes',
): Promise<ConsolidadoReporte> {
  const [grupos, maestro] = await Promise.all([
    ensamblarConsolidado(db.select(selectConsolidado(periodo)).from(flitoTramites).$dynamic(), f, periodo),
    db.select({ id: clients.id, nombre: clients.name, documento: clients.document }).from(clients),
  ]);
  return { periodo, ...plegarConsolidado(grupos as GrupoConsolidado[], maestro) };
}

// ── CSV ─────────────────────────────────────────────────────────────────────

/**
 * Las mismas columnas de valor y con los mismos nombres que el CSV del detalle (CF-14): «Trámite»
 * son los pesos del derecho de tránsito y «Servicio» el subtotal, como allí. Exportada para que el
 * test afirme el orden entero como un solo array.
 */
export const CABECERAS_CSV_CONSOLIDADO = [
  'Cliente', 'Periodo', 'Trámites', 'SOAT', 'Impuesto', 'Trámite', 'GMF', 'Logística',
  'Total reintegro', 'Trámite digital', 'Servicio', 'Total', 'Incompletos',
] as const;

/** Rótulo del periodo `null` en el CSV: el grupo existe, solo que aún nadie lo aprobó. */
export const SIN_APROBAR = 'Sin aprobar';

/** Mismo `;`, BOM y CRLF que `aCsv`: Excel en español lo abre sin asistente y con tildes. */
export function aCsvConsolidado(c: ConsolidadoReporte): string {
  const lineas = [CABECERAS_CSV_CONSOLIDADO.join(';')];
  for (const f of c.items) {
    lineas.push([
      f.clienteNombre, f.periodo ?? SIN_APROBAR, f.tramites, f.soat, f.impuesto, f.derechoTramite,
      f.gmf, f.logistica, f.totalReintegro, f.tramiteDigital, f.totalServicio, f.total,
      f.filasIncompletas,
    ].map(celda).join(';'));
  }
  return `${BOM_CSV}${lineas.join('\r\n')}\r\n`;
}
