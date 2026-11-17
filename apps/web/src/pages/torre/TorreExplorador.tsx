// Torre de Control (Épica #14590) — Explorador de métricas (spec UX §5). Preguntas frecuentes en chips y la oración
// «Medir [métrica] agrupado por [agrupación]» sobre el catálogo CERRADO `METRICAS_TORRE`. No hay botón «Consultar»:
// cada cambio recalcula y gana la última petición. Compañía, periodo y demás filtros salen de la barra transversal.
// Única primaria: «Exportar a Excel». Sin la función de dinero, las métricas `requiereDinero` no se ofrecen.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  FUNCION_TORRE_DINERO, METRICAS_TORRE, metricaTorre,
  type AgrupacionTorre, type ConsultaMetrica, type MetricaTorreId, type ResultadoMetrica,
} from '@operaciones/shared-types';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import type { FiltrosTorre, PeriodoTorre } from '../../lib/torreFiltros';
import GradientButton from '../../components/flit/GradientButton';
import { Icono } from '../../components/flit/kit/Icono';
import { ErrorVista, Vacio } from '../../components/flit/Cargador';
import { toastError, toastOk } from '../../components/flit/ToastFlito';
import PaginaTorre, { useTorre, type ContextoTorre } from '../../components/torre/PaginaTorre';
import ResultadoExplorador from '../../components/torre/ResultadoExplorador';
import { useCompaniasTorre } from '../../components/torre/BarraFiltrosTorre';
import {
  ETIQUETA_AGRUPACION, aFiltroTorre, etiquetaPeriodo, formatoUnidad, nombreDepartamento, nombreOrganismo,
} from '../../components/torre/formatoTorre';

interface Pregunta {
  id: string; rotulo: string; metrica: MetricaTorreId; agrupacion: AgrupacionTorre | ''; periodo: PeriodoTorre;
  tipoTramite?: string; descripcion: string;
}

const PREGUNTAS: readonly Pregunta[] = [
  { id: 'aprobados_hoy', rotulo: 'Aprobados hoy', metrica: 'tramites_aprobados', agrupacion: 'compania', periodo: 'hoy',
    descripcion: 'Trámites aprobados · Compañía · Hoy' },
  { id: 'tiempo_aprobacion', rotulo: 'Tiempo hasta la aprobación', metrica: 'tiempo_creacion_aprobacion', agrupacion: 'mes', periodo: 'ultimos_6m',
    descripcion: 'Tiempo de creación a aprobación · Mes · Últimos 6 meses' },
  { id: 'costo_logistica', rotulo: 'Costo de logística del mes', metrica: 'costo_logistica', agrupacion: 'compania', periodo: 'mes',
    descripcion: 'Costo de logística · Compañía · Este mes' },
  { id: 'impuestos_ot', rotulo: 'Impuestos pagados por organismo', metrica: 'impuestos_pagados', agrupacion: 'organismo', periodo: 'mes',
    descripcion: 'Impuestos pagados · Organismo de tránsito · Este mes' },
  { id: 'derechos', rotulo: 'Derechos de tránsito pagados', metrica: 'derechos_pagados', agrupacion: 'compania', periodo: 'mes',
    descripcion: 'Derechos de tránsito pagados · Compañía · Este mes' },
  { id: 'matriculas_dpto', rotulo: 'Matrículas por departamento', metrica: 'tramites_aprobados', agrupacion: 'departamento', periodo: 'anio',
    tipoTramite: 'MATRICULA', descripcion: 'Trámites aprobados de matrícula · Departamento · Este año' },
];

const GRUPOS_METRICA: { rotulo: string; unidades: string[] }[] = [
  { rotulo: 'Cuántos', unidades: ['conteo', 'pct'] },
  { rotulo: 'Cuánto se tardó', unidades: ['horas'] },
  { rotulo: 'Cuánto se pagó', unidades: ['cop'] },
];

type Estado = { tipo: 'cargando' } | { tipo: 'error' } | { tipo: 'listo'; res: ResultadoMetrica };

export default function TorreExplorador() {
  const torre = useTorre();
  const [exportar, setExportar] = useState<{ habilitado: boolean; ejecutar: () => Promise<void> }>({ habilitado: false, ejecutar: async () => {} });
  const [ocupado, setOcupado] = useState(false);
  const alExportar = async () => {
    setOcupado(true);
    try { await exportar.ejecutar(); } finally { setOcupado(false); }
  };
  return (
    <PaginaTorre torre={torre} titulo="Explorador de métricas"
      subtitulo="Responda preguntas sobre trámites, tiempos y costos sin pedir un reporte."
      acciones={(
        <GradientButton type="button" onClick={() => { void alExportar(); }} ocupado={ocupado} disabled={!exportar.habilitado}>
          <Icono nombre="nube-bajar" size={18} />
          Exportar a Excel
        </GradientButton>
      )}>
      <Explorador ctx={torre} onExportar={setExportar} />
    </PaginaTorre>
  );
}

function Explorador({ ctx, onExportar }: {
  ctx: ContextoTorre;
  onExportar: (e: { habilitado: boolean; ejecutar: () => Promise<void> }) => void;
}) {
  const { filtros, setFiltros, restablecer, abrirFicha } = ctx;
  const { hasFuncion } = useAuth();
  const veDinero = hasFuncion(FUNCION_TORRE_DINERO);
  const metricas = useMemo(() => METRICAS_TORRE.filter((m) => veDinero || !m.requiereDinero), [veDinero]);
  const preguntas = PREGUNTAS.filter((p) => veDinero || !metricaTorre(p.metrica).requiereDinero);
  const { companias } = useCompaniasTorre();

  const [metrica, setMetrica] = useState<MetricaTorreId>('tramites_aprobados');
  const [agrupacion, setAgrupacion] = useState<AgrupacionTorre | ''>('compania');
  const [estado, setEstado] = useState<Estado>({ tipo: 'cargando' });
  const [intento, setIntento] = useState(0);
  const ultima = useRef(0);

  // Sin la función de dinero (o si se la quitan con la pantalla abierta) no queda una métrica de dinero elegida.
  useEffect(() => { if (!metricas.some((m) => m.id === metrica)) setMetrica('tramites_aprobados'); }, [metricas, metrica]);

  const def = metricaTorre(metrica);
  const agrupaciones = def.agrupacionesPermitidas;
  const agrupacionValida: AgrupacionTorre | '' = agrupacion && agrupaciones.includes(agrupacion) ? agrupacion : '';
  const filtroTorre = useMemo(() => aFiltroTorre(filtros), [filtros]);
  const consulta: ConsultaMetrica = useMemo(() => ({
    metrica, filtro: filtroTorre, ...(agrupacionValida ? { agrupacion: agrupacionValida } : {}),
  }), [metrica, agrupacionValida, filtroTorre]);
  const claveConsulta = JSON.stringify(consulta);

  useEffect(() => {
    const id = ++ultima.current;
    setEstado({ tipo: 'cargando' });
    api.post<ResultadoMetrica>('/flito/torre/metricas/consultar', consulta)
      .then((res) => { if (id === ultima.current) setEstado({ tipo: 'listo', res }); })
      .catch(() => { if (id === ultima.current) setEstado({ tipo: 'error' }); });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `claveConsulta` resume `consulta`
  }, [claveConsulta, intento]);

  const vacio = estado.tipo === 'listo' && estado.res.total.n === 0 && estado.res.filas.length === 0;
  const lleno = estado.tipo === 'listo' && !vacio;

  useEffect(() => {
    const ejecutar = async (): Promise<void> => {
      try {
        await api.downloadPostNamed('/flito/torre/metricas/exportar', 'torre-explorador.xlsx', { consulta, formato: 'xlsx' });
        toastOk('Listo: descargamos el Excel de esta consulta.', { id: 'torre-exportar' });
      } catch {
        toastError('No pudimos generar el Excel. Intente de nuevo en un momento.', () => { void ejecutar(); }, { id: 'torre-exportar' });
      }
    };
    onExportar({ habilitado: lleno, ejecutar });
  }, [lleno, consulta, onExportar]);

  const elegirPregunta = (p: Pregunta) => {
    setMetrica(p.metrica);
    setAgrupacion(p.agrupacion);
    const siguiente: FiltrosTorre = { ...filtros, periodo: p.periodo, rango: null, ...(p.tipoTramite ? { tipoTramite: p.tipoTramite } : {}) };
    setFiltros(siguiente);
  };
  const preguntaActiva = preguntas.find((p) => p.metrica === metrica && p.agrupacion === agrupacionValida && p.periodo === filtros.periodo
    && (!p.tipoTramite || p.tipoTramite === filtros.tipoTramite))?.id;

  const nombreCompania = filtros.companiaId
    ? companias.find((c) => c.id === filtros.companiaId)?.nombre ?? 'Compañía elegida'
    : 'Todas las compañías';
  const partesSubtitulo = [
    nombreCompania,
    ...(filtros.organismo ? [nombreOrganismo(filtros.organismo)] : []),
    ...(filtros.departamento ? [nombreDepartamento(filtros.departamento)] : []),
  ];
  const titulo = `${def.etiqueta} · ${etiquetaPeriodo(filtros)}${agrupacionValida ? ` · por ${ETIQUETA_AGRUPACION[agrupacionValida].toLowerCase()}` : ''}`;
  const subtitulo = def.unidad === 'horas' && estado.tipo === 'listo'
    ? `${partesSubtitulo.join(' · ')} · ${estado.res.total.n.toLocaleString('es-CO')} trámites aprobados`
    : partesSubtitulo.join(' · ');
  const anuncio = estado.tipo === 'cargando' ? 'Calculando la consulta'
    : estado.tipo === 'error' ? 'No pudimos calcular esta consulta'
      : vacio ? 'Ningún trámite cumple esta consulta'
        : `${titulo}: ${formatoUnidad(def.unidad, estado.res.total.valor, true)}`;

  return (
    <>
      <section className="card min-w-0" aria-labelledby="torre-pregunta-titulo" data-torre="pregunta">
        <div className="card__cabeza">
          <div className="min-w-0">
            <h2 id="torre-pregunta-titulo">¿Qué quiere saber?</h2>
            <p className="text-sm" style={{ color: 'var(--color-text-tertiary)' }}>Elija una pregunta frecuente o arme la suya.</p>
          </div>
        </div>
        <div role="group" aria-label="Preguntas frecuentes" className="mb-4 flex flex-wrap gap-2">
          {preguntas.map((p) => (
            <button key={p.id} type="button" className="chip chip--sm transition-colors" aria-pressed={p.id === preguntaActiva}
              title={p.descripcion} onClick={() => elegirPregunta(p)}>
              {p.rotulo}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-x-3 gap-y-3">
          <div className="campo min-w-0 flex-[1_1_240px] lg:flex-[0_1_300px]">
            <label htmlFor="torre-medir">Medir</label>
            <select id="torre-medir" className="control" value={metrica} onChange={(e) => setMetrica(e.target.value as MetricaTorreId)}>
              {GRUPOS_METRICA.map((g) => {
                const del = metricas.filter((m) => g.unidades.includes(m.unidad));
                return del.length === 0 ? null : (
                  <optgroup key={g.rotulo} label={g.rotulo}>
                    {del.map((m) => <option key={m.id} value={m.id}>{m.etiqueta}</option>)}
                  </optgroup>
                );
              })}
            </select>
          </div>
          <span className="hidden pb-3 sm:inline" style={{ color: 'var(--color-text-tertiary)' }} aria-hidden="true">agrupado por</span>
          <div className="campo min-w-0 flex-[1_1_240px] lg:flex-[0_1_300px]">
            <label htmlFor="torre-agrupar">Agrupar por</label>
            <select id="torre-agrupar" className="control" value={agrupacionValida}
              onChange={(e) => setAgrupacion(e.target.value as AgrupacionTorre | '')}>
              <option value="">Sin agrupar (total)</option>
              {agrupaciones.map((a) => <option key={a} value={a}>{ETIQUETA_AGRUPACION[a]}</option>)}
            </select>
          </div>
        </div>
      </section>

      <p className="sr-only" role="status" aria-live="polite">{anuncio}</p>

      {estado.tipo === 'cargando' && (
        <section className="card min-w-0" aria-busy="true" aria-label="Calculando la consulta" data-torre="resultado" data-estado="cargando">
          <div className="kit-esqueleto mb-2 h-6 w-2/3" aria-hidden="true" />
          <div className="kit-esqueleto mb-4 h-4 w-1/3" aria-hidden="true" />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
            <div className="kit-esqueleto h-[104px]" aria-hidden="true" />
            <div className="flex flex-col gap-2">{[0, 1, 2, 3].map((i) => <div key={i} className="kit-esqueleto h-6" aria-hidden="true" />)}</div>
          </div>
          <div className="mt-4 flex flex-col gap-2">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="kit-esqueleto h-10" aria-hidden="true" />)}</div>
        </section>
      )}
      {estado.tipo === 'error' && (
        <section className="card min-w-0" data-torre="resultado" data-estado="error">
          <ErrorVista texto="No pudimos calcular esta consulta. Revise su conexión e intente de nuevo." onReintentar={() => setIntento((n) => n + 1)} />
        </section>
      )}
      {vacio && (
        <section className="card min-w-0" data-torre="resultado" data-estado="vacio">
          <Vacio texto="Ningún trámite cumple esta consulta." detalle="Pruebe con un periodo más amplio o quite algún filtro."
            accion={<GradientButton variant="secondary" size="sm" onClick={restablecer}>Limpiar filtros</GradientButton>} />
        </section>
      )}
      {lleno && estado.tipo === 'listo' && (
        <ResultadoExplorador res={estado.res} def={def} agrupacion={agrupacionValida} titulo={titulo} subtitulo={subtitulo} onVerFicha={abrirFicha} />
      )}
    </>
  );
}
