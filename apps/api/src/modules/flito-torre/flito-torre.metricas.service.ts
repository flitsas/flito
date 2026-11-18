// Torre de Control Gerencial (Épica #14590, ADR-0043 D1/D2, checklist §2-3) — motor de métricas del catálogo cerrado.
//
// RN-TOR-M6: una métrica con `requiereDinero` sin la función `FUNCION_TORRE_DINERO` → `TorreDineroDenegadoError` (403).
//   Lo decide la ruta con `tieneFuncion` y lo pasa como `dinero`; el motor no mira el rol.
// RN-TOR-M7: cada consulta corre en una transacción con `SET LOCAL statement_timeout`. Un fallo de la base se traduce a
//   `TorreConsultaError` con mensaje genérico (sin SQL ni parámetros: la placa o una compañía no salen en el error).
// RN-TOR-M8: caché Redis de 60 s; la clave es el hash de la consulta normalizada + el rango resuelto + el alcance. Si
//   Redis falla o tarda, se consulta la base igual (best effort en ambos sentidos).
// RN-TOR-M9: máximo `GRUPOS_MAX` grupos por consulta; la pantalla corta en `limite` y marca `truncado`.
import { createHash } from 'node:crypto';
import { inArray, sql, type SQL } from 'drizzle-orm';
import {
  ORGANISMOS_TRANSITO, DEPARTAMENTO_POR_CODIGO, TOPES_TORRE, fechaBasePorDefecto, metricaTorre,
  type AgrupacionTorre, type ConsultaMetrica, type ResultadoMetrica,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { clients, flitoTramites } from '../../db/schema.js';
import { getRedis } from '../../shared/redis.js';
import { loggerFor } from '../../shared/logger.js';
import type { AlcanceResuelto } from '../../shared/middleware/frontera-enlace.js';
import { CATALOGO_SQL, type DefMetricaSql } from './flito-torre.catalogo.js';
import { ErrorDominioTorre, noImplementado } from './flito-torre.service.js';
import {
  claveAgrupacion, condicionesTorre, donde, esTemporal, exigirTopesRango, resolverRango,
  type RangoResuelto,
} from './flito-torre.filtro.js';

const log = loggerFor('flito-torre');

/** Máximo de grupos de una consulta (ADR-0043 checklist §3). */
export const GRUPOS_MAX = 5_000;
const TTL_CACHE_S = 60;
const ESPERA_REDIS_MS = 250;

export class TorreDineroDenegadoError extends ErrorDominioTorre {
  readonly code = 'TORRE_DINERO_DENEGADO';
  constructor() { super('Su rol no tiene permiso para ver valores en dinero de la Torre.'); }
}

export class TorreConsultaError extends ErrorDominioTorre {
  constructor(message: string, readonly status: 500 | 503, readonly code: string) { super(message); }
}

// ── Ejecución con tope de tiempo ───────────────────────────────────────────────────────────────────────

export type Ejecutor = <T = Record<string, unknown>>(q: SQL) => Promise<T[]>;

function codigoPg(e: unknown): string | undefined {
  const x = e as { code?: string; cause?: { code?: string } };
  return x?.code ?? x?.cause?.code;
}

/** RN-TOR-M7: corre `fn` en UNA transacción con `statement_timeout`. */
export async function enTorre<R>(fn: (q: Ejecutor) => Promise<R>): Promise<R> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '15s'`);
      const q: Ejecutor = async <T>(consulta: SQL) => (await tx.execute(consulta)) as unknown as T[];
      return fn(q);
    });
  } catch (e) {
    if (e instanceof ErrorDominioTorre) throw e;
    const code = codigoPg(e);
    log.error({ code }, 'consulta de la Torre falló');
    if (code === '57014') {
      throw new TorreConsultaError('La consulta tardó demasiado. Acote el periodo o los filtros e intente de nuevo.', 503, 'TORRE_TIEMPO_AGOTADO');
    }
    throw new TorreConsultaError('No pudimos calcular la información de la Torre. Intente de nuevo.', 500, 'TORRE_ERROR');
  }
}

// ── Caché (best effort) ────────────────────────────────────────────────────────────────────────────────

const conEspera = <T>(p: Promise<T>): Promise<T | null> =>
  Promise.race([p, new Promise<null>((r) => { setTimeout(() => r(null), ESPERA_REDIS_MS).unref?.(); })]);

export function claveCache(prefijo: string, ...partes: unknown[]): string {
  return `torre:${prefijo}:${createHash('sha256').update(JSON.stringify(partes)).digest('hex')}`;
}

export async function leerCache<T>(clave: string): Promise<T | null> {
  try {
    const r = getRedis();
    if (!r) return null;
    const v = await conEspera(r.get(clave));
    return v ? (JSON.parse(v) as T) : null;
  } catch { return null; }
}

export async function guardarCache(clave: string, valor: unknown): Promise<void> {
  try {
    const r = getRedis();
    if (r) await conEspera(r.set(clave, JSON.stringify(valor), 'EX', TTL_CACHE_S));
  } catch { /* RN-TOR-M8: la caché nunca tumba la consulta */ }
}

// ── Etiquetas ──────────────────────────────────────────────────────────────────────────────────────────

export const SIN_COMPANIA = 'Sin compañía';
export const SIN_SECRETARIA = 'Sin secretaría';
const NOMBRE_ORGANISMO = new Map(ORGANISMOS_TRANSITO.map((o) => [o.codigo, o.nombre]));

export const nombreOrganismo = (codigo: string | null): string =>
  codigo == null ? SIN_SECRETARIA : NOMBRE_ORGANISMO.get(codigo) ?? codigo;

/** Nombres de compañía por id, en la misma transacción. */
export async function nombresCompania(q: Ejecutor, ids: readonly number[]): Promise<Map<number, string>> {
  const unicos = [...new Set(ids)];
  if (!unicos.length) return new Map();
  const filas = await q<{ id: number; name: string }>(sql`SELECT ${clients.id} AS id, ${clients.name} AS name
    FROM ${clients} WHERE ${inArray(clients.id, unicos)}`);
  return new Map(filas.map((f) => [Number(f.id), f.name]));
}

async function etiquetar(q: Ejecutor, a: AgrupacionTorre, claves: (string | null)[]): Promise<string[]> {
  if (a === 'compania') {
    const nombres = await nombresCompania(q, claves.filter((c): c is string => c != null).map(Number));
    return claves.map((c) => (c == null ? SIN_COMPANIA : nombres.get(Number(c)) ?? `Compañía ${c}`));
  }
  if (a === 'organismo') return claves.map(nombreOrganismo);
  if (a === 'departamento') return claves.map((c) => (c == null ? SIN_SECRETARIA : DEPARTAMENTO_POR_CODIGO[c] ?? SIN_SECRETARIA));
  if (a === 'tipo_tramite') return claves.map((c) => c ?? 'Sin tipo');
  if (a === 'flit_estado') return claves.map((c) => c ?? 'Sin estado');
  return claves.map((c) => c ?? 'Sin fecha');
}

// ── Agregados ──────────────────────────────────────────────────────────────────────────────────────────

function agregados(def: DefMetricaSql): SQL {
  switch (def.forma) {
    case 'conteo': return sql`count(*)::numeric AS valor`;
    case 'suma': return sql`COALESCE(sum(${def.valor}), 0)::numeric AS valor`;
    case 'tasa': return sql`count(*) FILTER (WHERE ${def.valor})::numeric AS aprobados`;
    case 'tiempo': return sql`percentile_cont(0.5) WITHIN GROUP (ORDER BY ${def.valor}) AS mediana,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY ${def.valor}) AS p90, max(${def.valor}) AS max`;
  }
}

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const opt = (v: unknown): number | undefined => (v == null ? undefined : Math.round(Number(v) * 100) / 100);
const r2 = (v: number): number => Math.round(v * 100) / 100;

function valorDe(def: DefMetricaSql, f: Record<string, unknown>): number {
  if (def.forma === 'tasa') { const n = num(f.n); return n ? r2((num(f.aprobados) / n) * 100) : 0; }
  if (def.forma === 'tiempo') return opt(f.mediana) ?? 0;
  return num(f.valor);
}

export interface OpcionesConsulta {
  /** ¿El usuario tiene `FUNCION_TORRE_DINERO`? */
  dinero: boolean;
  /** Tope interno de grupos (la exportación sube a `GRUPOS_MAX`). */
  limiteMax?: number;
  /** Día de hoy en Bogotá (tests). */
  hoy?: string;
}

/** El rango que aplica a una consulta: `null` en las métricas de foto (sin fecha). Aplica los topes. */
export function rangoDeConsulta(c: ConsultaMetrica, hoy?: string): RangoResuelto | null {
  if (!CATALOGO_SQL[c.metrica].fecha) return null;
  const r = resolverRango(c.filtro.rango, hoy);
  exigirTopesRango(r, c.agrupacion);
  return r;
}

/** Consulta una métrica del catálogo con el filtro y el alcance. */
export async function consultarMetrica(
  c: ConsultaMetrica, alcance: AlcanceResuelto, op: OpcionesConsulta,
): Promise<ResultadoMetrica> {
  const meta = metricaTorre(c.metrica);
  if (meta.requiereDinero && !op.dinero) throw new TorreDineroDenegadoError();
  // Contract-first (Épica #14590, bloque i): la segunda agrupación y una fecha base distinta de la de defecto ya pasan
  // Zod, pero el motor aún no las sabe resolver: 501 en vez de una cifra con la fecha equivocada. Lo retira el bloque (ii).
  if (c.agrupacionColumnas) noImplementado('Agrupar por dos criterios');
  if (c.fechaBase && c.fechaBase !== fechaBasePorDefecto(c.metrica)) noImplementado('Elegir la fecha base');
  const def = CATALOGO_SQL[c.metrica];
  const rango = rangoDeConsulta(c, op.hoy);
  const tope = Math.min(op.limiteMax ?? TOPES_TORRE.FILAS_PANTALLA_MAX, GRUPOS_MAX);
  const limite = Math.min(c.limite ?? tope, tope);

  const clave = claveCache('metrica', { ...c, limite }, rango, alcance);
  const cacheado = await leerCache<ResultadoMetrica>(clave);
  if (cacheado) return cacheado;

  const conds = [...def.fijas, ...condicionesTorre(c.filtro, alcance, def.dims, { rango, fecha: def.fecha })];
  const resultado = await enTorre(async (q) => {
    const base = donde(def.requiere ? [...conds, def.requiere] : conds);
    const sync = def.sync ? sql`, count(*) FILTER (WHERE ${def.sync})::int AS sync` : sql``;
    const lapso = def.forma === 'tiempo'
      ? sql`, EXTRACT(EPOCH FROM (max(${flitoTramites.fechaAprobacion}) - min(${flitoTramites.fechaCreacionFlit}))) / 3600.0 AS lapso`
      : sql``;
    const [tot] = await q(sql`SELECT count(*)::int AS n, ${agregados(def)}${sync}${lapso} FROM ${def.desde} WHERE ${base}`);
    const totalFila = tot ?? {};

    let excluidos = 0;
    let maximo: ResultadoMetrica['total']['maximo'];
    if (def.forma === 'tiempo' && def.requiere) {
      const [ex] = await q(sql`SELECT count(*)::int AS n FROM ${def.desde} WHERE ${donde(conds)} AND NOT (${def.requiere})`);
      excluidos = num(ex?.n);
      const [mx] = await q<{ id: string; placa: string | null }>(sql`SELECT ${flitoTramites.id} AS id, ${flitoTramites.plateComplete} AS placa
        FROM ${def.desde} WHERE ${base} ORDER BY ${def.valor} DESC NULLS LAST LIMIT 1`);
      maximo = mx ? { placa: mx.placa, tramiteUuid: mx.id } : null;
    }

    let filas: ResultadoMetrica['filas'] = [];
    let truncado = false;
    if (c.agrupacion) {
      const temporal = esTemporal(c.agrupacion);
      const orden = temporal ? sql`1 ASC` : def.forma === 'tiempo' ? sql`n DESC, 1 ASC` : sql`${sql.identifier(def.forma === 'tasa' ? 'n' : 'valor')} DESC, 1 ASC`;
      const grupos = await q(sql`SELECT ${claveAgrupacion(c.agrupacion, def.dims, def.fecha)} AS clave, count(*)::int AS n, ${agregados(def)}
        FROM ${def.desde} WHERE ${base} GROUP BY 1 ORDER BY ${orden} LIMIT ${limite + 1}`);
      truncado = grupos.length > limite;
      const visibles = grupos.slice(0, limite);
      const etiquetas = await etiquetar(q, c.agrupacion, visibles.map((g) => (g.clave == null ? null : String(g.clave))));
      const totalValor = valorDe(def, totalFila);
      const totalN = num(totalFila.n);
      filas = visibles.map((g, i) => {
        const valor = valorDe(def, g);
        const porN = def.forma === 'tasa' || def.forma === 'tiempo';
        const base100 = porN ? totalN : totalValor;
        return {
          clave: g.clave == null ? 'sin' : String(g.clave), etiqueta: etiquetas[i]!, valor, n: num(g.n),
          participacion: base100 ? r2(((porN ? num(g.n) : valor) / base100) * 100) : 0,
          ...(def.forma === 'tiempo' ? { mediana: opt(g.mediana), p90: opt(g.p90), max: opt(g.max) } : {}),
        };
      });
    }

    const r: ResultadoMetrica = {
      metrica: c.metrica, unidad: meta.unidad,
      total: {
        valor: valorDe(def, totalFila), n: num(totalFila.n),
        ...(def.forma === 'tiempo' ? {
          mediana: opt(totalFila.mediana), p90: opt(totalFila.p90), max: opt(totalFila.max), lapsoHoras: opt(totalFila.lapso), maximo,
        } : {}),
      },
      filas,
      baseFecha: {
        campo: def.campoFecha, excluidosSinFecha: excluidos, nBaseSincronizacion: num(totalFila.sync),
        fechaBase: fechaBasePorDefecto(c.metrica),
      },
      truncado,
      generadoEn: new Date().toISOString(),
    };
    return r;
  });
  await guardarCache(clave, resultado);
  return resultado;
}
