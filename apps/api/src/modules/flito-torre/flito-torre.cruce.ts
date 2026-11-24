// Torre de Control Gerencial (Épica #14590, ADR-0044 §(b)) — segunda agrupación del Explorador: tabla cruzada.
//
// RN-TOR-C1: como máximo 2 agrupaciones. `agrupacionColumnas` exige `agrupacion`, debe ser distinta de ella, ambas
//   permitidas por la métrica y NO las dos temporales. Zod ya lo valida; `exigirReglasCruce` lo vuelve a exigir.
// RN-TOR-C2: un eje de DIMENSIÓN se recorta a top-N por su marginal (`valor DESC`; `n DESC` en tasa y tiempo; desempate
//   por clave ASC) y el resto se pliega en «Los demás (N)» (clave `__otros`, `esOtros: true`, siempre la última). Un eje
//   TEMPORAL no se recorta: todos sus cortes con registros, en orden cronológico, sin «Otros».
// RN-TOR-C3: topes — pantalla 50 filas × 12 columnas de dimensión; Excel 2.000 × 100. Los cortes del eje temporal
//   (≤ 62) se validan antes de consultar (`exigirTopesCruce`, flito-torre.filtro.ts). RN-TOR-K4: en pantalla, `top`
//   sustituye el tope del eje de dimensión (`topesCruce`).
// RN-TOR-C4: los marginales (por fila y por columna) se calculan en SQL con `GROUPING SETS` sobre las filas crudas;
//   NUNCA se suman celdas (en tiempo y tasa no son aditivos). Una celda sin registros es `null`.
// RN-TOR-C5: comparte con el modo simple el `WHERE` (`condicionesTorre`, RN-TOR-F1), el alcance, el permiso de dinero,
//   el `statement_timeout` y la caché, y va en UNA sola sentencia.
import { sql, type SQL } from 'drizzle-orm';
import {
  TOPES_TORRE, esAgrupacionPermitida,
  type AgrupacionTorre, type CeldaTorre, type ColumnaCruceTorre, type ConsultaMetrica, type CruceTorre, type ResultadoMetrica,
} from '@operaciones/shared-types';
import type { DefResuelta } from './flito-torre.catalogo.js';
import { claveAgrupacion, esTemporal } from './flito-torre.filtro.js';
import {
  agregados, etiquetar, num, opt, participacion, valorDe, type Ejecutor,
} from './flito-torre.metricas.service.js';
import { TorreConsultaInvalidaError } from './flito-torre.service.js';

/** Clave de la fila o columna que pliega los grupos fuera del top. */
export const CLAVE_OTROS = '__otros';
export const etiquetaOtros = (plegados: number): string => `Los demás (${plegados})`;

/** RN-TOR-C1 (defensa en profundidad: la ruta ya lo validó con Zod). */
export function exigirReglasCruce(c: ConsultaMetrica): void {
  const col = c.agrupacionColumnas;
  if (!col) return;
  const falla = (detalle: string): never => { throw new TorreConsultaInvalidaError('agrupacionColumnas', detalle); };
  if (!c.agrupacion) falla('exige una agrupación principal');
  if (col === c.agrupacion) falla('no puede repetir la principal');
  if (!esAgrupacionPermitida(c.metrica, col)) falla('esa agrupación no aplica a la métrica');
  if (esTemporal(c.agrupacion) && esTemporal(col)) falla('solo una de las dos agrupaciones puede ser de tiempo');
}

/**
 * RN-TOR-C3: topes de dimensión del cruce. En pantalla, `limite` (si es menor) acota además las filas.
 * RN-TOR-K4: en pantalla, `top` sustituye al tope del eje de DIMENSIÓN: con la dimensión en filas,
 * `min(limite, top, 50)` filas (las columnas siguen en 12); con el tiempo en filas, `min(top, 12)` columnas. El eje
 * temporal no se corta nunca (`consultarCruce` no le aplica tope). El Excel ignora `top` (2.000 × 100).
 */
export function topesCruce(
  modo: 'pantalla' | 'exportar', limite: number, top?: number, filasEje?: AgrupacionTorre,
): { topeFilas: number; topeColumnas: number } {
  if (modo === 'exportar') {
    return { topeFilas: TOPES_TORRE.FILAS_CRUCE_EXPORTAR_MAX, topeColumnas: TOPES_TORRE.COLUMNAS_CRUCE_EXPORTAR_MAX };
  }
  const topeFilas = Math.min(limite, TOPES_TORRE.FILAS_CRUCE_PANTALLA_MAX);
  const topeColumnas = TOPES_TORRE.COLUMNAS_CRUCE_PANTALLA_MAX;
  if (top == null) return { topeFilas, topeColumnas };
  if (filasEje && esTemporal(filasEje)) return { topeFilas, topeColumnas: Math.min(top, topeColumnas) };
  return { topeFilas: Math.min(topeFilas, top), topeColumnas };
}

export interface EntradaCruce {
  def: DefResuelta;
  filasEje: AgrupacionTorre;
  columnasEje: AgrupacionTorre;
  /** El `WHERE` completo del modo simple (fijas + `condicionesTorre` + `requiere`). */
  where: SQL;
  topeFilas: number;
  topeColumnas: number;
  /** El total de la consulta (ya calculado en SQL): base de la participación. */
  total: { valor: number; n: number };
}

export interface SalidaCruce {
  filas: ResultadoMetrica['filas'];
  cruce: CruceTorre;
  /** Filas plegadas en «Los demás». */
  truncado: boolean;
}

type Fila = Record<string, unknown>;

/** Orden del top y de los marginales (RN-TOR-C2). */
function ordenTop(def: DefResuelta, eje: 'k1' | 'k2'): SQL {
  const k = sql.raw(eje);
  if (def.forma === 'suma') return sql`COALESCE(sum(v), 0) DESC, ${k} ASC`;
  return sql`count(*) DESC, ${k} ASC`;
}

/** Marginal de un eje (`claves` en el orden de RN-TOR-C2) a partir de los `GROUPING SETS`. */
interface Marginal { clave: string | null; otros: boolean; fila: Fila }

function ordenar(def: DefResuelta, temporal: boolean, xs: Marginal[]): Marginal[] {
  const porValor = def.forma === 'suma' || def.forma === 'conteo';
  const medida = (m: Marginal): number => (porValor ? valorDe(def, m.fila) : num(m.fila.n));
  const porClave = (a: Marginal, b: Marginal): number => {
    if (a.clave === b.clave) return 0;
    if (a.clave == null) return 1;
    if (b.clave == null) return -1;
    return a.clave < b.clave ? -1 : 1;
  };
  return [...xs].sort((a, b) => {
    if (a.otros !== b.otros) return a.otros ? 1 : -1;
    if (temporal) return porClave(a, b);
    return medida(b) - medida(a) || porClave(a, b);
  });
}

const claveDe = (m: Marginal): string => (m.otros ? CLAVE_OTROS : m.clave == null ? 'sin' : m.clave);
const id = (clave: string | null, otros: boolean): string => (otros ? CLAVE_OTROS : `k:${clave ?? ''}:${clave == null ? 1 : 0}`);

/** RN-TOR-C1/C2/C4/C5: una sola sentencia con CTE materializada, top-N por eje de dimensión y `GROUPING SETS`. */
export async function consultarCruce(q: Ejecutor, e: EntradaCruce): Promise<SalidaCruce> {
  const { def } = e;
  const t1 = esTemporal(e.filasEje);
  const t2 = esTemporal(e.columnasEje);
  const k1 = claveAgrupacion(e.filasEje, def.dims, def.fecha);
  const k2 = claveAgrupacion(e.columnasEje, def.dims, def.fecha);
  const vExpr = def.forma === 'conteo' ? sql`NULL::numeric` : sql`(${def.valor})`;

  const ctes: SQL[] = [sql`base AS MATERIALIZED (SELECT ${k1} AS k1, ${k2} AS k2, ${vExpr} AS v FROM ${def.desde} WHERE ${e.where})`];
  if (!t1) ctes.push(sql`top1 AS (SELECT k1 FROM base GROUP BY k1 ORDER BY ${ordenTop(def, 'k1')} LIMIT ${e.topeFilas})`);
  if (!t2) ctes.push(sql`top2 AS (SELECT k2 FROM base GROUP BY k2 ORDER BY ${ordenTop(def, 'k2')} LIMIT ${e.topeColumnas})`);
  const en1 = t1 ? sql`true` : sql`EXISTS (SELECT 1 FROM top1 WHERE top1.k1 IS NOT DISTINCT FROM base.k1)`;
  const en2 = t2 ? sql`true` : sql`EXISTS (SELECT 1 FROM top2 WHERE top2.k2 IS NOT DISTINCT FROM base.k2)`;
  ctes.push(sql`mapeada AS (SELECT CASE WHEN ${en1} THEN k1 END AS f, NOT ${en1} AS f_otros,
    CASE WHEN ${en2} THEN k2 END AS c, NOT ${en2} AS c_otros, v FROM base)`);

  const filasSql = await q(sql`WITH ${sql.join(ctes, sql`, `)}
    SELECT f, f_otros, c, c_otros, GROUPING(f, f_otros, c, c_otros)::int AS g, count(*)::int AS n,
      ${agregados(def, sql`v`)},
      (SELECT count(*) FROM (SELECT 1 FROM base GROUP BY k1) s1)::int AS nk1,
      (SELECT count(*) FROM (SELECT 1 FROM base GROUP BY k2) s2)::int AS nk2
    FROM mapeada
    GROUP BY GROUPING SETS ((f, f_otros, c, c_otros), (f, f_otros), (c, c_otros))`);

  const texto = (v: unknown): string | null => (v == null ? null : String(v));
  const porFila: Marginal[] = [];
  const porColumna: Marginal[] = [];
  const celdasCrudas = new Map<string, Fila>();
  let nk1 = 0;
  let nk2 = 0;
  for (const r of filasSql) {
    nk1 = num(r.nk1); nk2 = num(r.nk2);
    const g = num(r.g);
    const f = { clave: texto(r.f), otros: r.f_otros === true };
    const c = { clave: texto(r.c), otros: r.c_otros === true };
    if (g === 0) celdasCrudas.set(`${id(f.clave, f.otros)}|${id(c.clave, c.otros)}`, r);
    else if (g === 3) porFila.push({ ...f, fila: r });
    else if (g === 12) porColumna.push({ ...c, fila: r });
  }

  const filasOrd = ordenar(def, t1, porFila);
  const columnasOrd = ordenar(def, t2, porColumna);
  const plegadasFilas = t1 ? 0 : Math.max(0, nk1 - e.topeFilas);
  const plegadasColumnas = t2 ? 0 : Math.max(0, nk2 - e.topeColumnas);

  const etiquetas = async (eje: AgrupacionTorre, xs: Marginal[], plegados: number): Promise<string[]> => {
    const normales = await etiquetar(q, eje, xs.filter((m) => !m.otros).map((m) => m.clave));
    let i = 0;
    return xs.map((m) => (m.otros ? etiquetaOtros(plegados) : normales[i++]!));
  };
  const etiquetasFilas = await etiquetas(e.filasEje, filasOrd, plegadasFilas);
  const etiquetasColumnas = await etiquetas(e.columnasEje, columnasOrd, plegadasColumnas);
  const tiempo = def.forma === 'tiempo';

  const filas: ResultadoMetrica['filas'] = filasOrd.map((m, i) => {
    const valor = valorDe(def, m.fila);
    return {
      clave: claveDe(m), etiqueta: etiquetasFilas[i]!, valor, n: num(m.fila.n),
      participacion: participacion(def, valor, num(m.fila.n), e.total),
      ...(tiempo ? { mediana: opt(m.fila.mediana), p90: opt(m.fila.p90), max: opt(m.fila.max) } : {}),
      ...(m.otros ? { esOtros: true as const } : {}),
    };
  });
  const columnas: ColumnaCruceTorre[] = columnasOrd.map((m, j) => {
    const valor = valorDe(def, m.fila);
    return {
      clave: claveDe(m), etiqueta: etiquetasColumnas[j]!, valor, n: num(m.fila.n),
      participacion: participacion(def, valor, num(m.fila.n), e.total),
      ...(tiempo ? { mediana: opt(m.fila.mediana), p90: opt(m.fila.p90) } : {}),
      ...(m.otros ? { esOtros: true as const } : {}),
    };
  });
  const celdas: (CeldaTorre | null)[][] = filasOrd.map((f) => columnasOrd.map((c) => {
    const r = celdasCrudas.get(`${id(f.clave, f.otros)}|${id(c.clave, c.otros)}`);
    if (!r) return null;
    return {
      valor: valorDe(def, r), n: num(r.n),
      ...(tiempo ? { mediana: opt(r.mediana), p90: opt(r.p90) } : {}),
    };
  }));

  return {
    filas,
    cruce: { agrupacion: e.columnasEje, columnas, celdas, truncadoColumnas: plegadasColumnas > 0 },
    truncado: plegadasFilas > 0,
  };
}
