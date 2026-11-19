// Torre de Control (Épica #14590) — resultado cruzado del Explorador (spec UX §5.3, ADR-0044 D2): la tabla filas ×
// columnas sobre `DataTable matriz` (primera columna fija, scroll del kit, cierre «Total»/«General» en `<tfoot>` que se
// repite en cada página) y la gráfica por series cuando un eje es temporal (Top 5 + «Los demás» solo si la medida suma).
// Los marginales y los «General» los calcula el servidor (RN-TOR-C4): aquí no se suman tiempos ni tasas.
// Vistas flexibles (spec §4/§5, RN-TOR-K5): las cabeceras de tiempo llevan la etiqueta corta del eje («1 jun»,
// «jun 2026»), «Valores %» reparte cada corte al 100 % (en conteo y dinero) y los avisos usan el Top efectivo.
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AgrupacionTorre, CeldaTorre, ColumnaCruceTorre, ResultadoMetrica, UnidadMetricaTorre } from '@operaciones/shared-types';
import DataTable, { type ColumnaTabla } from '../flit/DataTable';
import { LineaTendencia, SERIE_KIT, type SerieLinea } from '../flit/Graficos';
import { ETIQUETA_AGRUPACION, conteo, duracion, esTemporal, etiquetasCortesTorre, formatoUnidad, porcentaje } from './formatoTorre';
import { rutaRegistrosMetrica } from '../../lib/torreDetalle';
import { usePuedeVerDetalle } from './KpiExplicable';

type Fila = ResultadoMetrica['filas'][number];
const POR_PAGINA = 20;
const COLORES = [SERIE_KIT.azul, SERIE_KIT.turquesa, SERIE_KIT.amarillo, SERIE_KIT.verde, SERIE_KIT.naranja];

/** Conteo y dinero se suman («Total», «Los demás»); tiempo y tasa no («General», sin «Los demás»). */
export const esAditiva = (u: UnidadMetricaTorre) => u === 'conteo' || u === 'cop';

/** La cifra que se pinta de una celda o de un marginal: en tiempos, la mediana. */
const cifra = (u: UnidadMetricaTorre, x: { valor: number; mediana?: number }) => (u === 'horas' ? x.mediana ?? x.valor : x.valor);

function Celda({ unidad, celda, pct }: { unidad: UnidadMetricaTorre; celda: CeldaTorre | null; pct: number | null }) {
  if (!celda) {
    return <span style={{ color: 'var(--color-text-tertiary)' }}>{pct !== null ? '0 %' : esAditiva(unidad) ? '0' : '—'}</span>;
  }
  return <>{pct !== null ? porcentaje(pct) : formatoUnidad(unidad, cifra(unidad, celda))}</>;
}

const parte = (v: number, base: number) => (base > 0 ? (v / base) * 100 : 0);

/**
 * RN-TOR-K5: el reparto va DENTRO de cada corte. Con un eje temporal, cada corte de tiempo suma 100 % (esté en filas o
 * en columnas); con dos categóricos, cada columna. «Total» da la parte de cada fila en el total general. El marginal
 * incluye «Otros», así que cada corte cierra en 100 %.
 */
export function repartoCruce(res: ResultadoMetrica, agrupacion: AgrupacionTorre) {
  const cruce = res.cruce!;
  const porFila = esTemporal(agrupacion);
  return {
    celda: (i: number, j: number) => parte(cruce.celdas[i]?.[j]?.valor ?? 0, porFila ? res.filas[i]?.valor ?? 0 : cruce.columnas[j]?.valor ?? 0),
    fila: (i: number) => parte(res.filas[i]?.valor ?? 0, res.total.valor),
    columna: (j: number) => (porFila ? parte(cruce.columnas[j].valor, res.total.valor) : cruce.columnas[j].valor > 0 ? 100 : 0),
  };
}

export function TablaCruzadaTorre({ res, agrupacion, titulo, enPct = false }: {
  res: ResultadoMetrica; agrupacion: AgrupacionTorre; titulo: string;
  /** «Valores: %» (solo conteo y dinero). */
  enPct?: boolean;
}) {
  const cruce = res.cruce!;
  const u = res.unidad;
  const puedeVer = usePuedeVerDetalle();
  const pct = enPct && esAditiva(u);
  const reparto = repartoCruce(res, agrupacion);
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
  const cabeceras = esTemporal(cruce.agrupacion) ? etiquetasCortesTorre(cruce.agrupacion, cruce.columnas).cortas : cruce.columnas.map((c) => c.etiqueta);
  const filasCortas = esTemporal(agrupacion) ? etiquetasCortesTorre(agrupacion, res.filas).cortas : null;
  const columnas: ColumnaTabla<Fila>[] = [
    { key: '__fila', header: ETIQUETA_AGRUPACION[agrupacion], render: (f) => (filasCortas ? filasCortas[indice.get(f.clave) ?? -1] ?? f.etiqueta : f.etiqueta) },
    ...cruce.columnas.map((c, j): ColumnaTabla<Fila> => ({
      key: `c-${c.clave}`, header: cabeceras[j], align: 'right',
      render: (f) => {
        const i = indice.get(f.clave) ?? -1;
        const celda = cruce.celdas[i]?.[j] ?? null;
        const contenido = <Celda unidad={u} celda={celda} pct={pct ? reparto.celda(i, j) : null} />;
        // Cada celda con registros abre su lista (spec §8, AC12); «Otros» (fila o columna) no se puede expresar.
        if (!puedeVer || !celda || celda.n === 0 || f.esOtros || c.esOtros) return contenido;
        return (
          <Link to={rutaRegistrosMetrica(res.metrica, res.baseFecha.fechaBase, [[agrupacion, f.clave], [cruce.agrupacion, c.clave]])}
            className="flit-focus-inset -mx-1 -my-0.5 block rounded px-1 py-0.5 text-inherit no-underline transition-colors hover:bg-[var(--kit-hover)]"
            data-torre="celda-registros" aria-label={`${f.etiqueta} · ${c.etiqueta}: ${conteo(celda.n)} registros. Ver registros`}>
            {contenido}
          </Link>
        );
      },
    })),
    {
      key: '__cierre', header: cierre, align: 'right', className: 'font-semibold',
      render: (f) => (pct ? porcentaje(reparto.fila(indice.get(f.clave) ?? -1)) : formatoUnidad(u, cifra(u, f))),
    },
  ];
  const totalPaginas = Math.max(1, Math.ceil(res.filas.length / POR_PAGINA));
  const filasPagina = res.filas.slice((pagina - 1) * POR_PAGINA, pagina * POR_PAGINA);

  const pie = (
    <tr>
      <th scope="row">{cierre}</th>
      {cruce.columnas.map((c, j) => (
        <td key={c.clave} className="text-right">{pct ? porcentaje(reparto.columna(j)) : formatoUnidad(u, cifra(u, c))}</td>
      ))}
      <td className="text-right">{pct ? porcentaje(res.total.valor > 0 ? 100 : 0) : formatoUnidad(u, cifra(u, res.total))}</td>
    </tr>
  );

  return (
    <div ref={caja} className="flex min-w-0 flex-col gap-1.5" data-torre="tabla-cruzada" data-valores={pct ? 'pct' : 'absoluto'}>
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
export function GraficaSeriesTorre({ res, agrupacion, titulo, enPct = false }: {
  res: ResultadoMetrica; agrupacion: AgrupacionTorre; titulo: string;
  /** «Valores: %»: cada corte de tiempo suma 100 %, con «Los demás» incluido. */
  enPct?: boolean;
}) {
  const cruce = res.cruce!;
  const u = res.unidad;
  const tiempos = u === 'horas';
  const pct = enPct && esAditiva(u);
  const temporalEnFilas = esTemporal(agrupacion);

  // El eje x es el temporal; cada serie, un valor del eje categórico. Eje con la etiqueta corta; tip con la larga.
  const cortes = temporalEnFilas ? res.filas : cruce.columnas;
  const { cortas: etiquetas, largas } = etiquetasCortesTorre(temporalEnFilas ? agrupacion : cruce.agrupacion, cortes);
  const totalCorte = (i: number) => cortes[i]?.valor ?? 0;
  const candidatas: Candidata[] = temporalEnFilas
    ? cruce.columnas.map((c: ColumnaCruceTorre, j) => ({
      etiqueta: c.etiqueta, n: c.n, esOtros: !!c.esOtros, valores: cruce.celdas.map((fila) => fila[j] ?? null),
    }))
    : res.filas.map((f, i) => ({ etiqueta: f.etiqueta, n: f.n, esOtros: !!f.esOtros, valores: cruce.celdas[i] ?? [] }));

  const ordenadas = candidatas.filter((c) => !c.esOtros).sort((a, b) => b.n - a.n);
  const top = ordenadas.slice(0, COLORES.length);
  const resto = [...ordenadas.slice(COLORES.length), ...candidatas.filter((c) => c.esOtros)];
  const punto = (c: CeldaTorre | null, i: number): number | null => {
    if (!c) return esAditiva(u) ? 0 : null;
    if (pct) return parte(c.valor, totalCorte(i));
    return tiempos ? cifra(u, c) / 24 : c.valor;
  };
  const series: SerieLinea[] = top.map((c, k) => ({ t: c.etiqueta, c: COLORES[k], v: etiquetas.map((_, i) => punto(c.valores[i] ?? null, i)) }));
  if (esAditiva(u) && resto.length > 0) {
    series.push({
      t: 'Los demás', c: SERIE_KIT.gris,
      v: etiquetas.map((_, i) => {
        const v = resto.reduce((a, c) => a + (c.valores[i]?.valor ?? 0), 0);
        return pct ? parte(v, totalCorte(i)) : v;
      }),
    });
  }
  const fmt = (n: number) => (pct ? porcentaje(n) : formatoUnidad(u, n));
  return (
    <div className="min-w-0" data-torre="grafica-series">
      <LineaTendencia fluido titulo={tiempos ? `${titulo} (mediana en días)` : titulo} etiquetas={etiquetas} titulosTip={largas}
        series={series} formato={tiempos ? (d) => duracion(d * 24) : fmt} />
    </div>
  );
}

/**
 * Topes efectivos del cruce en pantalla (RN-TOR-K4): sin `top`, 50 filas × 12 columnas; con `top`, la dimensión en
 * filas va a `min(top, 50)` y, si la dimensión va en columnas con el tiempo en filas, a `min(top, 12)`.
 */
export function topesCruceWeb(agrupacion: AgrupacionTorre, columnas: AgrupacionTorre, top?: number) {
  const filas = !esTemporal(agrupacion) && top ? Math.min(top, 50) : 50;
  const cols = esTemporal(agrupacion) && !esTemporal(columnas) && top ? Math.min(top, 12) : 12;
  return { filas, columnas: cols };
}

/** Los avisos de ejes cortados (spec §5.4): solo los de DIMENSIÓN; un eje temporal no se corta. */
export function avisosCruce(res: ResultadoMetrica, agrupacion: AgrupacionTorre, top?: number): string[] {
  const cruce = res.cruce;
  if (!cruce) return [];
  const topes = topesCruceWeb(agrupacion, cruce.agrupacion, top);
  const avisos: string[] = [];
  const otrasCol = cruce.columnas.find((c) => c.esOtros);
  if (cruce.truncadoColumnas && !esTemporal(cruce.agrupacion)) {
    avisos.push(`Se muestran las ${topes.columnas} columnas con más registros; el resto va en «${otrasCol?.etiqueta ?? 'Los demás'}». El Excel trae hasta 100.`);
  }
  const otrasFila = res.filas.find((f) => f.esOtros);
  if (res.truncado && !esTemporal(agrupacion)) {
    avisos.push(`Se muestran las ${topes.filas} filas con más registros; el resto va en «${otrasFila?.etiqueta ?? 'Los demás'}». El Excel trae hasta 2.000.`);
  }
  return avisos;
}
