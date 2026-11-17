// Torre de Control (Épica #14590) — tarjeta de resultado del Explorador (spec UX §5.2): la cifra dominante, el
// desglose (ranking de participación o `LineaTendencia`) y el `DataTable`. En tiempos, 4 cifras: mediana, 9 de
// cada 10, el que más tardó (con «ver ficha») y lapso total.
import { useEffect, useState } from 'react';
import type { AgrupacionTorre, MetricaTorreDef, ResultadoMetrica } from '@operaciones/shared-types';
import KpiCard from '../flit/KpiCard';
import DataTable, { type ColumnaTabla } from '../flit/DataTable';
import InlineAlert from '../flit/InlineAlert';
import { LineaTendencia, SERIE_KIT } from '../flit/Graficos';
import RankingTorre from './RankingTorre';
import { AGRUPACIONES_TEMPORALES, conteo, duracion, formatoUnidad, porcentaje } from './formatoTorre';

type Fila = ResultadoMetrica['filas'][number];
const TOP = 10;
const POR_PAGINA = 20;

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
      {res.truncado && (
        <InlineAlert tono="info">Se muestran los primeros {conteo(res.filas.length)} grupos. El Excel trae todos.</InlineAlert>
      )}
    </>
  );
}

export default function ResultadoExplorador({ res, def, agrupacion, titulo, subtitulo, onVerFicha }: {
  res: ResultadoMetrica;
  def: MetricaTorreDef;
  agrupacion: AgrupacionTorre | '';
  titulo: string;
  subtitulo: string;
  onVerFicha: (placa: string) => void;
}) {
  const [pagina, setPagina] = useState(1);
  useEffect(() => { setPagina(1); }, [res]);
  const tiempos = def.unidad === 'horas';
  const temporal = agrupacion !== '' && AGRUPACIONES_TEMPORALES.includes(agrupacion);
  const categoria = agrupacion !== '' && !temporal;
  const fmt = (n: number) => formatoUnidad(def.unidad, n);
  const t = res.total;

  const columnas: ColumnaTabla<Fila>[] = tiempos
    ? [
      { key: 'etiqueta', header: 'Grupo', render: (f) => f.etiqueta },
      { key: 'n', header: 'Trámites', align: 'right', render: (f) => conteo(f.n) },
      { key: 'mediana', header: 'Mediana', align: 'right', render: (f) => (f.mediana !== undefined ? duracion(f.mediana) : '—') },
      { key: 'p90', header: 'Percentil 90', align: 'right', render: (f) => (f.p90 !== undefined ? duracion(f.p90) : '—') },
      { key: 'max', header: 'Máximo', align: 'right', render: (f) => (f.max !== undefined ? duracion(f.max) : '—') },
    ]
    : [
      { key: 'etiqueta', header: 'Grupo', render: (f) => f.etiqueta },
      { key: 'valor', header: def.etiqueta, align: 'right', render: (f) => fmt(f.valor) },
      ...(categoria && def.unidad !== 'pct'
        ? [{ key: 'pct', header: 'Participación', align: 'right' as const, render: (f: Fila) => porcentaje(f.participacion) }]
        : []),
    ];

  const totalPaginas = Math.max(1, Math.ceil(res.filas.length / POR_PAGINA));
  const filasPagina = categoria ? res.filas.slice((pagina - 1) * POR_PAGINA, pagina * POR_PAGINA) : res.filas;

  const pctDe = (f: Fila) => (def.unidad === 'pct' ? f.valor : f.participacion);
  const top = res.filas.slice(0, TOP);
  const resto = res.filas.slice(TOP);
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
    <section className="card min-w-0" aria-labelledby="torre-resultado-titulo" data-torre="resultado" data-estado="lleno">
      <div className="card__cabeza">
        <div className="min-w-0">
          <h2 id="torre-resultado-titulo">{titulo}</h2>
          <p className="text-sm" style={{ color: 'var(--color-text-tertiary)' }}>{subtitulo}</p>
        </div>
      </div>
      <div className="flex flex-col gap-4">
        {tiempos ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4" data-torre="cifras-tiempo">
            <KpiCard label="Mediana" value={duracion(t.mediana ?? t.valor)} hint="La mitad tardó menos" />
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
          <div className={categoria ? 'grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]' : 'grid grid-cols-1 gap-4'}>
            <KpiCard label={def.etiqueta} value={formatoUnidad(def.unidad, t.valor, true)}
              hint={def.unidad === 'conteo' ? undefined : `${conteo(t.n)} registros`} />
            {categoria && (
              <div className="min-w-0">
                <p className="mb-2 text-sm font-semibold">{def.unidad === 'pct' ? 'Por grupo' : 'Participación'}</p>
                <RankingTorre filas={ranking} etiqueta={`${def.etiqueta} por grupo`} />
              </div>
            )}
          </div>
        )}

        <NotasBaseFecha res={res} tiempos={tiempos} />

        {temporal && (
          // Tiempos: la gráfica va en DÍAS (el eje rotula el número crudo, y en horas no casaba con la tabla).
          <LineaTendencia titulo={tiempos ? `${titulo} (días)` : titulo} etiquetas={res.filas.map((f) => f.etiqueta)}
            formato={tiempos ? (d) => duracion(d * 24) : fmt}
            series={tiempos
              ? [
                { t: 'Mediana', c: SERIE_KIT.azul, v: res.filas.map((f) => (f.mediana === undefined ? null : f.mediana / 24)) },
                { t: 'Percentil 90', c: SERIE_KIT.turquesa, v: res.filas.map((f) => (f.p90 === undefined ? null : f.p90 / 24)) },
              ]
              : [{ t: def.etiqueta, c: SERIE_KIT.azul, v: res.filas.map((f) => f.valor) }]} />
        )}

        {agrupacion !== '' && (
          <DataTable ariaLabel={`Desglose: ${titulo}`} columnas={columnas} filas={filasPagina} getKey={(f) => f.clave}
            emptyMessage="Ningún trámite cumple esta consulta."
            paginacion={categoria && res.filas.length > POR_PAGINA ? {
              total: res.filas.length, page: pagina, totalPaginas, sustantivo: 'grupos', singular: 'grupo',
              onPrev: () => setPagina((p) => Math.max(1, p - 1)), onNext: () => setPagina((p) => Math.min(totalPaginas, p + 1)),
            } : undefined} />
        )}
      </div>
    </section>
  );
}
