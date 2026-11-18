// Torre de Control Gerencial (Épica #14590, ADR-0043 D1/D2, checklist §2-3) — motor de métricas del catálogo cerrado.
//
// RN-TOR-M6: una métrica con `requiereDinero` sin la función `FUNCION_TORRE_DINERO` → `TorreDineroDenegadoError` (403).
//   Lo decide la ruta con `tieneFuncion` y lo pasa como `dinero`; el motor no mira el rol.
// RN-TOR-M7: cada consulta corre en una transacción con `SET LOCAL statement_timeout`. Un fallo de la base se traduce a
//   `TorreConsultaError` con mensaje genérico (sin SQL ni parámetros: la placa o una compañía no salen en el error).
// RN-TOR-M8: caché Redis de 60 s; la clave es el hash de la consulta normalizada + el rango resuelto + el alcance. Si
//   Redis falla o tarda, se consulta la base igual (best effort en ambos sentidos).
// RN-TOR-M9: máximo `GRUPOS_MAX` grupos por consulta; la pantalla corta en `limite` y marca `truncado`.
// RN-TOR-M10/M12 (ADR-0044): la fecha base se resuelve con `resolverDef` (ausente = la de defecto, mismo resultado que
//   antes) y ancla a la vez el rango y los cortes temporales; `baseFecha.campo`/`fechaBase` la declaran. La clave de
//   caché lleva la fecha base RESUELTA, las dos agrupaciones y el modo (pantalla/exportar: topes distintos).
// RN-TOR-C5: con `agrupacionColumnas` delega en `consultarCruce` (flito-torre.cruce.ts) con el MISMO `WHERE`, alcance,
//   permiso de dinero, `statement_timeout` y caché.
import { createHash } from 'node:crypto';
import { inArray, sql, type SQL } from 'drizzle-orm';
import {
  ORGANISMOS_TRANSITO, DEPARTAMENTO_POR_CODIGO, TOPES_TORRE, metricaTorre,
  type AgrupacionTorre, type ConsultaMetrica, type ResultadoMetrica,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { clients, flitoTramites } from '../../db/schema.js';
import { getRedis } from '../../shared/redis.js';
import { loggerFor } from '../../shared/logger.js';
import type { AlcanceResuelto } from '../../shared/middleware/frontera-enlace.js';
import { resolverDef, type DefResuelta, type FormaMetrica } from './flito-torre.catalogo.js';
import { consultarCruce, exigirReglasCruce, topesCruce } from './flito-torre.cruce.js';
import { ErrorDominioTorre } from './flito-torre.service.js';
import {
  claveAgrupacion, condicionesTorre, donde, esTemporal, exigirTopesCruce, exigirTopesRango, resolverRango,
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

/** RN-TOR-M7: corre `fn` en UNA transacción con `statement_timeout` (15 s; las sugerencias de placa usan 3 s). */
export async function enTorre<R>(fn: (q: Ejecutor) => Promise<R>, op: { timeout?: '15s' | '3s' } = {}): Promise<R> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(op.timeout === '3s'
        ? sql`SET LOCAL statement_timeout = '3s'`
        : sql`SET LOCAL statement_timeout = '15s'`);
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

/** Etiqueta de cada clave de grupo (compartida con el cruce). */
export async function etiquetar(q: Ejecutor, a: AgrupacionTorre, claves: (string | null)[]): Promise<string[]> {
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

/** Lo que los agregados necesitan de la métrica. */
export interface FormaDef { forma: FormaMetrica; valor?: SQL }

/**
 * Agregados de la métrica. `v` = la expresión agregada (por defecto `def.valor`); el cruce pasa la columna `v` de su
 * CTE. En conteo no se usa.
 */
export function agregados(def: FormaDef, v: SQL | undefined = def.valor): SQL {
  switch (def.forma) {
    case 'conteo': return sql`count(*)::numeric AS valor`;
    case 'suma': return sql`COALESCE(sum(${v}), 0)::numeric AS valor`;
    case 'tasa': return sql`count(*) FILTER (WHERE ${v})::numeric AS aprobados`;
    case 'tiempo': return sql`percentile_cont(0.5) WITHIN GROUP (ORDER BY ${v}) AS mediana,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY ${v}) AS p90, max(${v}) AS max`;
  }
}

export const num = (v: unknown): number => (v == null ? 0 : Number(v));
export const opt = (v: unknown): number | undefined => (v == null ? undefined : Math.round(Number(v) * 100) / 100);
export const r2 = (v: number): number => Math.round(v * 100) / 100;

/** % de un grupo sobre el total: por `n` en tasa y tiempo (no aditivos), por valor en conteo y suma. */
export function participacion(def: FormaDef, valor: number, n: number, total: { valor: number; n: number }): number {
  const porN = def.forma === 'tasa' || def.forma === 'tiempo';
  const base100 = porN ? total.n : total.valor;
  return base100 ? r2(((porN ? n : valor) / base100) * 100) : 0;
}

export function valorDe(def: FormaDef, f: Record<string, unknown>): number {
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
  /** Topes del cruce (RN-TOR-C3): pantalla 50 × 12, exportar 2.000 × 100. Por defecto, pantalla. */
  modo?: 'pantalla' | 'exportar';
}

/** El rango que aplica a una consulta: `null` en las métricas de foto (sin fecha). Aplica los topes. */
export function rangoDeConsulta(c: ConsultaMetrica, hoy?: string): RangoResuelto | null {
  if (!resolverDef(c.metrica, c.fechaBase).fecha) return null;
  const r = resolverRango(c.filtro.rango, hoy);
  exigirTopesRango(r, c.agrupacion);
  if (c.agrupacion && c.agrupacionColumnas) {
    exigirTopesRango(r, c.agrupacionColumnas);
    exigirTopesCruce(c.agrupacion, c.agrupacionColumnas, r);
  }
  return r;
}

/** Consulta una métrica del catálogo con el filtro y el alcance. */
export async function consultarMetrica(
  c: ConsultaMetrica, alcance: AlcanceResuelto, op: OpcionesConsulta,
): Promise<ResultadoMetrica> {
  const meta = metricaTorre(c.metrica);
  if (meta.requiereDinero && !op.dinero) throw new TorreDineroDenegadoError();
  const def: DefResuelta = resolverDef(c.metrica, c.fechaBase);
  if (c.agrupacionColumnas) exigirReglasCruce(c);
  const rango = rangoDeConsulta(c, op.hoy);
  const tope = Math.min(op.limiteMax ?? TOPES_TORRE.FILAS_PANTALLA_MAX, GRUPOS_MAX);
  const limite = Math.min(c.limite ?? tope, tope);
  const modo = op.modo ?? 'pantalla';

  // Objeto normalizado (orden fijo de claves): la fecha base ausente y la explícita de defecto dan la MISMA clave.
  const normalizada = {
    metrica: c.metrica, fechaBase: def.fechaBase, agrupacion: c.agrupacion ?? null,
    agrupacionColumnas: c.agrupacionColumnas ?? null, filtro: c.filtro, limite, modo,
  };
  const clave = claveCache('metrica', normalizada, rango, alcance);
  // El rango sale del cálculo de esta petición, no de la entrada cacheada (una vieja puede no traerlo).
  // `RangoResuelto.hasta` ya es inclusivo (el fin exclusivo `hasta + 1` solo vive en el SQL de `condicionesTorre`).
  const conRango = (r: ResultadoMetrica): ResultadoMetrica => {
    const sinRango: ResultadoMetrica = { ...r };
    delete sinRango.rango;
    return rango ? { ...sinRango, rango: { desde: rango.desde, hasta: rango.hasta } } : sinRango;
  };
  const cacheado = await leerCache<ResultadoMetrica>(clave);
  if (cacheado) return conRango(cacheado);

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
    let cruce: ResultadoMetrica['cruce'];
    if (c.agrupacion && c.agrupacionColumnas) {
      const r = await consultarCruce(q, {
        def, filasEje: c.agrupacion, columnasEje: c.agrupacionColumnas, where: base,
        ...topesCruce(modo, limite), total: { valor: valorDe(def, totalFila), n: num(totalFila.n) },
      });
      ({ filas, cruce, truncado } = r);
    } else if (c.agrupacion) {
      const temporal = esTemporal(c.agrupacion);
      const orden = temporal ? sql`1 ASC` : def.forma === 'tiempo' ? sql`n DESC, 1 ASC` : sql`${sql.identifier(def.forma === 'tasa' ? 'n' : 'valor')} DESC, 1 ASC`;
      const grupos = await q(sql`SELECT ${claveAgrupacion(c.agrupacion, def.dims, def.fecha)} AS clave, count(*)::int AS n, ${agregados(def)}
        FROM ${def.desde} WHERE ${base} GROUP BY 1 ORDER BY ${orden} LIMIT ${limite + 1}`);
      truncado = grupos.length > limite;
      const visibles = grupos.slice(0, limite);
      const etiquetas = await etiquetar(q, c.agrupacion, visibles.map((g) => (g.clave == null ? null : String(g.clave))));
      const total = { valor: valorDe(def, totalFila), n: num(totalFila.n) };
      filas = visibles.map((g, i) => {
        const valor = valorDe(def, g);
        return {
          clave: g.clave == null ? 'sin' : String(g.clave), etiqueta: etiquetas[i]!, valor, n: num(g.n),
          participacion: participacion(def, valor, num(g.n), total),
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
        fechaBase: def.fechaBase,
      },
      truncado,
      ...(cruce ? { cruce } : {}),
      generadoEn: new Date().toISOString(),
    };
    return r;
  });
  await guardarCache(clave, resultado);
  return conRango(resultado);
}
