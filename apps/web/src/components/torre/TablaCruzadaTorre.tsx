// Torre de Control (Épica #14590) — resultado cruzado del Explorador (spec UX §5.3, ADR-0044 D2): la tabla filas ×
// columnas sobre `DataTable matriz` (primera columna fija, scroll del kit, cierre «Total»/«General» en `<tfoot>` que se
// repite en cada página) y la gráfica por series cuando un eje es temporal (Top 5 + «Los demás» solo si la medida suma).
// Los marginales y los «General» los calcula el servidor (RN-TOR-C4): aquí no se suman tiempos ni tasas.
import { useEffect, useRef, useState } from 'react';
import type { AgrupacionTorre, CeldaTorre, ColumnaCruceTorre, ResultadoMetrica, UnidadMetricaTorre } from '@operaciones/shared-types';
import DataTable, { type ColumnaTabla } from '../flit/DataTable';
import { LineaTendencia, SERIE_KIT, type SerieLinea } from '../flit/Graficos';
import { ETIQUETA_AGRUPACION, duracion, esTemporal, formatoUnidad } from './formatoTorre';

type Fila = ResultadoMetrica['filas'][number];
const POR_PAGINA = 20;
const COLORES = [SERIE_KIT.azul, SERIE_KIT.turquesa, SERIE_KIT.amarillo, SERIE_KIT.verde, SERIE_KIT.naranja];

/** Conteo y dinero se suman («Total», «Los demás»); tiempo y tasa no («General», sin «Los demás»). */
export const esAditiva = (u: UnidadMetricaTorre) => u === 'conteo' || u === 'cop';

/** La cifra que se pinta de una celda o de un marginal: en tiempos, la mediana. */
const cifra = (u: UnidadMetricaTorre, x: { valor: number; mediana?: number }) => (u === 'horas' ? x.mediana ?? x.valor : x.valor);

function Celda({ unidad, celda }: { unidad: UnidadMetricaTorre; celda: CeldaTorre | null }) {
  if (!celda) {
    return <span style={{ color: 'var(--color-text-tertiary)' }}>{esAditiva(unidad) ? '0' : '—'}</span>;
  }
  return <>{formatoUnidad(unidad, cifra(unidad, celda))}</>;
}

export function TablaCruzadaTorre({ res, agrupacion, titulo }: { res: ResultadoMetrica; agrupacion: AgrupacionTorre; titulo: string }) {
  const cruce = res.cruce!;
  const u = res.unidad;
  const [pagina, setPagina] = useState(1);
  const [desborda, setDesborda] = useState(false);
  const caja = useRef<HTMLDivElement>(null);
  useEffect(() => { setPagina(1); }, [res]);

  // «Deslice para ver más columnas.» solo si de verdad hay desborde horizontal.
  useEffect(() => {
    const wrap = caja.current?.querySelector<HTMLElement>('.tabla-wrap');
    if (!wrap) return undefined;
    const medir = () => setDesborda(wrap.scrollWidth > wrap.clientWidth + 1);
    medir();
    const ro = new ResizeObserver(medir);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [res]);

  const cierre = esAditiva(u) ? 'Total' : 'General';
  const indice = new Map(res.filas.map((f, i) => [f.clave, i]));
  const columnas: ColumnaTabla<Fila>[] = [
    { key: '__fila', header: ETIQUETA_AGRUPACION[agrupacion], render: (f) => f.etiqueta },
    ...cruce.columnas.map((c, j): ColumnaTabla<Fila> => ({
      key: `c-${c.clave}`, header: c.etiqueta, align: 'right',
      render: (f) => <Celda unidad={u} celda={cruce.celdas[indice.get(f.clave) ?? -1]?.[j] ?? null} />,
    })),
    { key: '__cierre', header: cierre, align: 'right', className: 'font-semibold', render: (f) => formatoUnidad(u, cifra(u, f)) },
  ];
  const totalPaginas = Math.max(1, Math.ceil(res.filas.length / POR_PAGINA));
  const filasPagina = res.filas.slice((pagina - 1) * POR_PAGINA, pagina * POR_PAGINA);

  const pie = (
    <tr>
      <th scope="row">{cierre}</th>
      {cruce.columnas.map((c) => <td key={c.clave} className="text-right">{formatoUnidad(u, cifra(u, c))}</td>)}
      <td className="text-right">{formatoUnidad(u, cifra(u, res.total))}</td>
    </tr>
  );

  return (
    <div ref={caja} className="flex min-w-0 flex-col gap-1.5" data-torre="tabla-cruzada">
      {desborda && <p className="text-sm" style={{ color: 'var(--color-text-tertiary)' }}>Deslice para ver más columnas.</p>}
      <DataTable matriz encabezadoFila ariaLabel={`Tabla cruzada: ${titulo}`} caption={titulo} regionDesplazable={`Tabla cruzada: ${titulo}`}
        columnas={columnas} filas={filasPagina} getKey={(f) => f.clave} pie={pie}
        paginacion={res.filas.length > POR_PAGINA ? {
          total: res.filas.length, page: pagina, totalPaginas, sustantivo: 'filas', singular: 'fila',
          onPrev: () => setPagina((p) => Math.max(1, p - 1)), onNext: () => setPagina((p) => Math.min(totalPaginas, p + 1)),
        } : undefined} />
    </div>
  );
}

/** Serie de la gráfica: un valor de la agrupación categórica a lo largo del eje temporal. */
interface Candidata { etiqueta: string; n: number; esOtros: boolean; valores: (CeldaTorre | null)[] }

/** Gráfica por series (solo si un eje es temporal): Top 5 por volumen + «Los demás» si la medida suma. */
export function GraficaSeriesTorre({ res, agrupacion, titulo }: { res: ResultadoMetrica; agrupacion: AgrupacionTorre; titulo: string }) {
  const cruce = res.cruce!;
  const u = res.unidad;
  const tiempos = u === 'horas';
  const temporalEnFilas = esTemporal(agrupacion);

  // El eje x es el temporal; cada serie, un valor del eje categórico.
  const etiquetas = temporalEnFilas ? res.filas.map((f) => f.etiqueta) : cruce.columnas.map((c) => c.etiqueta);
  const candidatas: Candidata[] = temporalEnFilas
    ? cruce.columnas.map((c: ColumnaCruceTorre, j) => ({
      etiqueta: c.etiqueta, n: c.n, esOtros: !!c.esOtros, valores: cruce.celdas.map((fila) => fila[j] ?? null),
    }))
    : res.filas.map((f, i) => ({ etiqueta: f.etiqueta, n: f.n, esOtros: !!f.esOtros, valores: cruce.celdas[i] ?? [] }));

  const ordenadas = candidatas.filter((c) => !c.esOtros).sort((a, b) => b.n - a.n);
  const top = ordenadas.slice(0, COLORES.length);
  const resto = [...ordenadas.slice(COLORES.length), ...candidatas.filter((c) => c.esOtros)];
  const punto = (c: CeldaTorre | null): number | null => {
    if (!c) return esAditiva(u) ? 0 : null;
    return tiempos ? cifra(u, c) / 24 : c.valor;
  };
  const series: SerieLinea[] = top.map((c, k) => ({ t: c.etiqueta, c: COLORES[k], v: etiquetas.map((_, i) => punto(c.valores[i] ?? null)) }));
  if (esAditiva(u) && resto.length > 0) {
    series.push({
      t: 'Los demás', c: SERIE_KIT.gris,
      v: etiquetas.map((_, i) => resto.reduce((a, c) => a + (c.valores[i]?.valor ?? 0), 0)),
    });
  }
  const fmt = (n: number) => formatoUnidad(u, n);
  return (
    <div data-torre="grafica-series">
      <LineaTendencia titulo={tiempos ? `${titulo} (mediana en días)` : titulo} etiquetas={etiquetas} series={series}
        formato={tiempos ? (d) => duracion(d * 24) : fmt} />
    </div>
  );
}

/** Los avisos de ejes cortados (spec §5.4): solo los de DIMENSIÓN; un eje temporal no se corta. */
export function avisosCruce(res: ResultadoMetrica, agrupacion: AgrupacionTorre): string[] {
  const cruce = res.cruce;
  if (!cruce) return [];
  const avisos: string[] = [];
  const otrasCol = cruce.columnas.find((c) => c.esOtros);
  if (cruce.truncadoColumnas && !esTemporal(cruce.agrupacion)) {
    avisos.push(`Se muestran las 12 columnas con más registros; el resto va en «${otrasCol?.etiqueta ?? 'Los demás'}». El Excel trae hasta 100.`);
  }
  const otrasFila = res.filas.find((f) => f.esOtros);
  if (res.truncado && !esTemporal(agrupacion)) {
    avisos.push(`Se muestran las 50 filas con más registros; el resto va en «${otrasFila?.etiqueta ?? 'Los demás'}». El Excel trae hasta 2.000.`);
  }
  return avisos;
}
