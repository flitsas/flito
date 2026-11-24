// Torre de Control Gerencial (Épica #14590) — «Comparar con el periodo anterior» del Explorador.
//
// RN-TOR-K1: el periodo anterior es `periodoAnterior(rango)` (igual duración, inmediatamente antes), con la MISMA fecha
//   base, el mismo alcance y los mismos filtros: solo cambia el rango (constructor único, RN-TOR-F1). No se re-validan
//   los topes: la duración es la misma.
// RN-TOR-K2: compara el total y, con agrupación por DIMENSIÓN, cada grupo visible. Con agrupación temporal (o sin
//   agrupación) `filas = []`: las claves (`2026-11` contra `2026-10`) no se emparejan. Foto y cruce ya son 400 (Zod).
// RN-TOR-K3: variación relativa `r1((actual − anterior) / anterior × 100)` en `conteo`, `cop` y `horas` (en tiempos se
//   compara la mediana); en `pct`, diferencia en PUNTOS `r1(actual − anterior)`. `null` si no hay base: valor anterior
//   0 (en `pct`: sin registros en el periodo anterior, porque una tasa de 0 % con registros sí es base) o el grupo no
//   existía. `filas` trae exactamente las claves de las filas actuales, en su orden; sin registros → `valor: null`.
// Corre dentro del `enTorre` de `consultarMetrica` (misma transacción y `statement_timeout`): 2 sentencias más.
import { sql } from 'drizzle-orm';
import type { AnteriorTorre, ConsultaMetrica, ResultadoMetrica, UnidadMetricaTorre } from '@operaciones/shared-types';
import type { AlcanceResuelto } from '../../shared/middleware/frontera-enlace.js';
import type { DefResuelta } from './flito-torre.catalogo.js';
import {
  claveAgrupacion, condicionesTorre, donde, esTemporal, periodoAnterior, type RangoResuelto,
} from './flito-torre.filtro.js';
import { GRUPOS_MAX, agregados, num, valorDe, type Ejecutor } from './flito-torre.metricas.service.js';

const r1 = (v: number): number => Math.round(v * 10) / 10;

/** Un valor y su número de registros (la base de la variación). */
interface Medida { valor: number; n: number }

/** RN-TOR-K3 (pura). `anterior` ausente = el grupo no existía en el periodo anterior. */
export function variacionTorre(unidad: UnidadMetricaTorre, actual: number, anterior: Medida | undefined): number | null {
  if (!anterior) return null;
  if (unidad === 'pct') return anterior.n > 0 ? r1(actual - anterior.valor) : null;
  return anterior.valor !== 0 ? r1(((actual - anterior.valor) / anterior.valor) * 100) : null;
}

/** RN-TOR-K1..K3: el bloque `anterior` del resultado. */
export async function calcularAnterior(
  q: Ejecutor, def: DefResuelta, c: ConsultaMetrica, alcance: AlcanceResuelto, rango: RangoResuelto,
  unidad: UnidadMetricaTorre, filas: ResultadoMetrica['filas'], totalActual: Medida,
): Promise<AnteriorTorre> {
  const ant = periodoAnterior(rango);
  const conds = [...def.fijas, ...condicionesTorre(c.filtro, alcance, def.dims, { rango: ant, fecha: def.fecha })];
  const base = donde(def.requiere ? [...conds, def.requiere] : conds);

  const [tot] = await q(sql`SELECT count(*)::int AS n, ${agregados(def)} FROM ${def.desde} WHERE ${base}`);
  const total: Medida = { valor: valorDe(def, tot ?? {}), n: num(tot?.n) };

  let filasAnt: AnteriorTorre['filas'] = [];
  if (c.agrupacion && !esTemporal(c.agrupacion) && filas.length) {
    const grupos = await q(sql`SELECT ${claveAgrupacion(c.agrupacion, def.dims, def.fecha)} AS clave, count(*)::int AS n,
      ${agregados(def)} FROM ${def.desde} WHERE ${base} GROUP BY 1 LIMIT ${GRUPOS_MAX}`);
    // Misma convención de clave que las filas actuales: `null` ↔ 'sin'.
    const porClave = new Map<string, Medida>(grupos.map((g) => [
      g.clave == null ? 'sin' : String(g.clave), { valor: valorDe(def, g), n: num(g.n) },
    ]));
    filasAnt = filas.map((f) => {
      const a = porClave.get(f.clave);
      return { clave: f.clave, valor: a ? a.valor : null, variacion: variacionTorre(unidad, f.valor, a) };
    });
  }

  return {
    rango: ant,
    total,
    variacion: variacionTorre(unidad, totalActual.valor, total),
    en: unidad === 'pct' ? 'puntos' : 'relativa',
    filas: filasAnt,
  };
}
