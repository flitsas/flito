// Torre de Control (Épica #14590) — tarjeta de resultado del Explorador (spec UX §5.2 y §5.3 del Explorador flexible):
// la cifra dominante, el desglose (ranking de participación o `LineaTendencia`) y el `DataTable`. En tiempos, 4 cifras:
// mediana, 9 de cada 10, el que más tardó (con «ver ficha») y lapso total. Con dos agrupaciones (`res.cruce`), la
// gráfica por series si un eje es temporal y la tabla cruzada (`TablaCruzadaTorre`).
// Vistas flexibles (spec §4/§5): con eje temporal la cifra va arriba y la gráfica a todo el ancho; la fila de vista
// (`OpcionesVistaTorre`) va dentro de la tarjeta; con `res.anterior`, la cifra lleva la variación y las fechas del
// periodo anterior, y la tabla de una agrupación de dimensión suma «Anterior» y «Variación» (sin verde ni rojo).
import { useEffect, useState, type ReactNode } from 'react';
import type { AgrupacionTorre, AnteriorTorre, MetricaTorreDef, ResultadoMetrica } from '@operaciones/shared-types';
import KpiCard from '../flit/KpiCard';
import DataTable, { type ColumnaTabla } from '../flit/DataTable';
import InlineAlert from '../flit/InlineAlert';
import { LineaTendencia, SERIE_KIT } from '../flit/Graficos';
import RankingTorre from './RankingTorre';
import {
  ETIQUETA_AGRUPACION, conteo, duracion, esTemporal, etiquetasCortesTorre, formatoUnidad, fraseRango, porcentaje,
  textoVariacion, variacionRelativa, type VariacionTorre,
} from './formatoTorre';
import { GraficaSeriesTorre, TablaCruzadaTorre, avisosCruce, esAditiva } from './TablaCruzadaTorre';
import { VISTA_TORRE_INICIAL, type VistaTorre } from './OpcionesVistaTorre';

type Fila = ResultadoMetrica['filas'][number];
type FilaAnterior = AnteriorTorre['filas'][number];
const POR_PAGINA = 20;
const DEMAS = '__demas';

/** «▲ 13,7 %» en tinta secundaria: la flecha es `aria-hidden` y el lector oye «sube 13,7 %» (spec §5, §6). */
export function Variacion({ v }: { v: VariacionTorre }) {
  return (
    <span className="whitespace-nowrap" style={{ color: 'var(--flit-text-secondary)' }} data-torre="variacion">
      <span aria-hidden="true">{v.flecha ? `${v.flecha} ` : ''}{v.texto}</span>
      <span className="sr-only">{v.accesible}</span>
    </span>
  );
}

/** Bajo la cifra: «▲ 12,0 % frente a 984» y «Periodo anterior: 11 dic 2025 – 31 may 2026». */
function ComparacionCifra({ anterior, actual, fmt }: { anterior: AnteriorTorre; actual: number; fmt: (n: number) => string }) {
  const periodo = fraseRango(anterior.rango);
  if (anterior.total.n === 0) {
    return (
      <p className="m-0 text-sm" style={{ color: 'var(--flit-text-secondary)' }} data-torre="comparacion" data-anterior="vacio">
        Sin datos en el periodo anterior ({periodo})
      </p>
    );
  }
  const v = textoVariacion(actual, anterior.total.valor, anterior.variacion, anterior.en);
  return (
    <div className="flex flex-col gap-0.5 text-sm" style={{ color: 'var(--flit-text-secondary)' }} data-torre="comparacion">
      <p className="m-0 font-semibold"><Variacion v={v} /> frente a {fmt(anterior.total.valor)}</p>
      <p className="m-0">Periodo anterior: {periodo}</p>
    </div>
  );
}

export function NotasBaseFecha({ res, tiempos }: { res: ResultadoMetrica; tiempos: boolean }) {
  const { nBaseSincronizacion, excluidosSinFecha } = res.baseFecha;
  return (
    <>
      {tiempos && nBaseSincronizacion > 0 && (
        <InlineAlert tono="info">
          Los tiempos se cuentan desde la creación del trámite en FLITO. {conteo(nBaseSincronizacion)} de estos {conteo(res.total.n)} trámites son
          anteriores a julio de 2026: para ellos se cuenta desde la fecha en que FLITO los sincronizó, que puede ser posterior a la creación real.
        </InlineAlert>
      )}
      {excluidosSinFecha > 0 && (
        <InlineAlert tono="info">
          {conteo(excluidosSinFecha)} {excluidosSinFecha === 1 ? 'registro no tiene' : 'registros no tienen'} la fecha que ancla esta
          métrica y no {excluidosSinFecha === 1 ? 'entra' : 'entran'} en la cifra.
        </InlineAlert>
      )}
      {res.truncado && !res.cruce && (
        <InlineAlert tono="info">Se muestran los primeros {conteo(res.filas.length)} grupos. El Excel trae todos.</InlineAlert>
      )}
    </>
  );
}

export default function ResultadoExplorador({
  res, def, agrupacion, titulo, subtitulo, onVerFicha, avisos, medida = def.etiqueta, vista = VISTA_TORRE_INICIAL, opciones,
}: {
  res: ResultadoMetrica;
  def: MetricaTorreDef;
  agrupacion: AgrupacionTorre | '';
  titulo: string;
  subtitulo: string;
  onVerFicha: (placa: string) => void;
  /** Avisos de página propios de la consulta (p. ej. el del filtro «Estado actual», spec §5.4). */
  avisos?: ReactNode;
  /** La medida con su fecha («Trámites aprobados»): rótulo de la cifra, de la columna y del ranking. */
  medida?: string;
  /** Top N y «Valores %» elegidos en la fila de vista. */
  vista?: VistaTorre;
  /** La fila de vista (`OpcionesVistaTorre`): va dentro de la tarjeta, sobre la cifra. */
  opciones?: ReactNode;
}) {
  const [pagina, setPagina] = useState(1);
  useEffect(() => { setPagina(1); }, [res]);
  const tiempos = def.unidad === 'horas';
  const cruzado = !!res.cruce && agrupacion !== '';
  const temporal = esTemporal(agrupacion);
  const categoria = agrupacion !== '' && !temporal && !cruzado;
  const ejeTemporal = cruzado && (temporal || esTemporal(res.cruce!.agrupacion));
  const grupo = agrupacion ? ETIQUETA_AGRUPACION[agrupacion] : 'Grupo';
  const fmt = (n: number) => formatoUnidad(def.unidad, n);
  const t = res.total;
  const aditiva = esAditiva(def.unidad);
  const TOP = vista.top;

  // Comparación (RN-TOR-K2): la cifra siempre; las columnas solo con agrupación de DIMENSIÓN.
  const anterior = res.anterior;
  const antPorClave = new Map<string, FilaAnterior>((anterior?.filas ?? []).map((a) => [a.clave, a]));
  const conColumnasAnt = !!anterior && categoria && antPorClave.size > 0;
  const actualDe = (f: Fila) => (tiempos ? f.mediana ?? f.valor : f.valor);
  const variacionDe = (f: Fila): VariacionTorre => {
    const a = antPorClave.get(f.clave);
    if (f.clave === DEMAS) return textoVariacion(f.valor, a?.valor ?? 0, variacionRelativa(f.valor, a?.valor ?? 0), 'relativa');
    return textoVariacion(actualDe(f), a?.valor ?? null, a?.variacion ?? null, anterior?.en ?? 'relativa');
  };
  const anteriorDe = (f: Fila) => {
    const v = antPorClave.get(f.clave)?.valor ?? null;
    if (v === null) return aditiva ? fmt(0) : '—';
    return tiempos ? duracion(v) : fmt(v);
  };
  const columnasAnt: ColumnaTabla<Fila>[] = conColumnasAnt
    ? [
      { key: 'anterior', header: 'Anterior', align: 'right', render: anteriorDe },
      { key: 'variacion', header: 'Variación', align: 'right', render: (f) => <Variacion v={variacionDe(f)} /> },
    ]
    : [];

  const columnas: ColumnaTabla<Fila>[] = tiempos
    ? [
      { key: 'etiqueta', header: grupo, render: (f) => f.etiqueta },
      { key: 'n', header: 'Trámites', align: 'right', render: (f) => conteo(f.n) },
      { key: 'mediana', header: 'Mediana', align: 'right', render: (f) => (f.mediana !== undefined ? duracion(f.mediana) : '—') },
      ...columnasAnt,
      { key: 'p90', header: 'Percentil 90', align: 'right', render: (f) => (f.p90 !== undefined ? duracion(f.p90) : '—') },
      { key: 'max', header: 'Máximo', align: 'right', render: (f) => (f.max !== undefined ? duracion(f.max) : '—') },
    ]
    : [
      { key: 'etiqueta', header: grupo, render: (f) => f.etiqueta },
      { key: 'valor', header: medida, align: 'right', render: (f) => fmt(f.valor) },
      ...columnasAnt,
      ...(categoria && def.unidad !== 'pct'
        ? [{ key: 'pct', header: 'Participación', align: 'right' as const, render: (f: Fila) => porcentaje(f.participacion) }]
        : []),
    ];

  const pctDe = (f: Fila) => (def.unidad === 'pct' ? f.valor : f.participacion);
  const top = res.filas.slice(0, TOP);
  const resto = res.filas.slice(TOP);

  // «Mostrar N» (spec §5): en conteo y dinero la tabla también muestra N filas más «Los demás (M)», que suma sus grupos
  // (también en «Anterior»). En tasas y tiempos no se suman, así que la tabla sigue paginando todos los grupos.
  const demas: Fila | null = categoria && aditiva && resto.length > 0 ? {
    clave: DEMAS, etiqueta: `Los demás (${resto.length})`, valor: resto.reduce((a, f) => a + f.valor, 0),
    n: resto.reduce((a, f) => a + f.n, 0), participacion: resto.reduce((a, f) => a + f.participacion, 0),
  } : null;
  if (demas && conColumnasAnt) {
    antPorClave.set(DEMAS, { clave: DEMAS, valor: resto.reduce((a, f) => a + (antPorClave.get(f.clave)?.valor ?? 0), 0), variacion: null });
  }
  const filasTabla = categoria && aditiva ? [...top, ...(demas ? [demas] : [])] : res.filas;
  const totalPaginas = Math.max(1, Math.ceil(filasTabla.length / POR_PAGINA));
  const filasPagina = categoria ? filasTabla.slice((pagina - 1) * POR_PAGINA, pagina * POR_PAGINA) : filasTabla;
  const cortes = temporal && !cruzado ? etiquetasCortesTorre(agrupacion as AgrupacionTorre, res.filas) : null;
  const ranking = [
    ...top.map((f) => ({ id: f.clave, etiqueta: f.etiqueta, pct: pctDe(f), valor: fmt(f.valor) })),
    ...(resto.length > 0 && def.unidad !== 'pct'
      ? [{
        id: '__demas', etiqueta: `Los demás (${resto.length})`,
        pct: resto.reduce((a, f) => a + f.participacion, 0), valor: fmt(resto.reduce((a, f) => a + f.valor, 0)),
      }]
      : []),
  ];

  return (
    <section className="card min-w-0" aria-labelledby="torre-resultado-titulo" data-torre="resultado" data-estado="lleno"
      data-forma={cruzado ? 'cruzado' : 'simple'}>
      <div className="card__cabeza">
        <div className="min-w-0">
          <h2 id="torre-resultado-titulo">{titulo}</h2>
          <p className="text-sm" style={{ color: 'var(--color-text-tertiary)' }}>{subtitulo}</p>
        </div>
      </div>
      <div className="flex flex-col gap-4">
        {opciones}
        {tiempos ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4" data-torre="cifras-tiempo">
            <KpiCard label="Mediana" value={duracion(t.mediana ?? t.valor)} hint="La mitad tardó menos">
              {anterior && <ComparacionCifra anterior={anterior} actual={t.mediana ?? t.valor} fmt={duracion} />}
            </KpiCard>
            <KpiCard label="9 de cada 10" value={t.p90 !== undefined ? `${duracion(t.p90)} o menos` : '—'} hint="Percentil 90" />
            <KpiCard label="El que más tardó" value={t.max !== undefined ? duracion(t.max) : '—'}>
              {t.maximo?.placa && (
                <button type="button" className="btn ghost sm" onClick={() => onVerFicha(t.maximo!.placa!)}>
                  Placa {t.maximo.placa} · ver ficha
                </button>
              )}
            </KpiCard>
            <KpiCard label="Lapso total" value={t.lapsoHoras !== undefined ? duracion(t.lapsoHoras) : '—'} hint="Del primero creado al último aprobado" />
          </div>
        ) : (
          // Con eje temporal la cifra va en su fila y la gráfica a todo el ancho (spec §4); el ranking sigue al lado.
          <div className={categoria ? 'grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]' : 'grid grid-cols-1 gap-4'}>
            <div className={ejeTemporal ? 'min-w-0 lg:max-w-[18rem]' : 'min-w-0'}>
              <KpiCard label={medida} value={formatoUnidad(def.unidad, t.valor, true)}
                hint={def.unidad === 'conteo' ? undefined : `${conteo(t.n)} registros`}>
                {anterior && <ComparacionCifra anterior={anterior} actual={t.valor} fmt={fmt} />}
              </KpiCard>
            </div>
            {ejeTemporal && (
              <GraficaSeriesTorre res={res} agrupacion={agrupacion as AgrupacionTorre} titulo={titulo} enPct={vista.pct} />
            )}
            {categoria && (
              <div className="min-w-0">
                <p className="mb-2 text-sm font-semibold">{def.unidad === 'pct' ? 'Por grupo' : 'Participación'}</p>
                <RankingTorre filas={ranking} etiqueta={`${medida} por grupo`} />
              </div>
            )}
          </div>
        )}

        {tiempos && ejeTemporal && <GraficaSeriesTorre res={res} agrupacion={agrupacion as AgrupacionTorre} titulo={titulo} />}

        <NotasBaseFecha res={res} tiempos={tiempos} />
        {avisos}

        {cruzado && (
          <>
            <TablaCruzadaTorre res={res} agrupacion={agrupacion as AgrupacionTorre} titulo={titulo} enPct={vista.pct} />
            {avisosCruce(res, agrupacion as AgrupacionTorre, vista.top).map((a) => <InlineAlert key={a} tono="info">{a}</InlineAlert>)}
          </>
        )}

        {temporal && !cruzado && (
          // Tiempos: la gráfica va en DÍAS (el eje rotula el número crudo, y en horas no casaba con la tabla).
          <LineaTendencia fluido titulo={tiempos ? `${titulo} (días)` : titulo} etiquetas={cortes?.cortas ?? []} titulosTip={cortes?.largas}
            formato={tiempos ? (d) => duracion(d * 24) : fmt}
            series={tiempos
              ? [
                { t: 'Mediana', c: SERIE_KIT.azul, v: res.filas.map((f) => (f.mediana === undefined ? null : f.mediana / 24)) },
                { t: 'Percentil 90', c: SERIE_KIT.turquesa, v: res.filas.map((f) => (f.p90 === undefined ? null : f.p90 / 24)) },
              ]
              : [{ t: def.etiqueta, c: SERIE_KIT.azul, v: res.filas.map((f) => f.valor) }]} />
        )}

        {agrupacion !== '' && !cruzado && (
          <DataTable ariaLabel={`Desglose: ${titulo}`} columnas={columnas} filas={filasPagina} getKey={(f) => f.clave}
            emptyMessage="Ningún trámite cumple esta consulta."
            paginacion={categoria && filasTabla.length > POR_PAGINA ? {
              total: filasTabla.length, page: pagina, totalPaginas, sustantivo: 'grupos', singular: 'grupo',
              onPrev: () => setPagina((p) => Math.max(1, p - 1)), onNext: () => setPagina((p) => Math.min(totalPaginas, p + 1)),
            } : undefined} />
        )}
      </div>
    </section>
  );
}
