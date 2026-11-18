// Torre de Control (Épica #14590) — tarjeta «¿Qué quiere saber?» del Explorador flexible (spec UX §3): preguntas
// frecuentes en chips y la oración «Medir · según la fecha de · agrupar por · y luego por» sobre el catálogo CERRADO
// `METRICAS_TORRE` (solo las `enConstructor`). Presentacional: el estado y sus reglas de coherencia viven en la página.
import {
  FECHAS_BASE_TORRE, type AgrupacionTorre, type FechaBaseTorre, type MetricaTorreDef, type MetricaTorreId,
} from '@operaciones/shared-types';
import type { PeriodoTorre } from '../../lib/torreFiltros';
import { Icono } from '../flit/kit/Icono';
import { ETIQUETA_AGRUPACION, FECHA_BASE_ORACION, esTemporal } from './formatoTorre';

export interface PreguntaTorre {
  id: string; rotulo: string; metrica: MetricaTorreId; fechaBase: FechaBaseTorre;
  agrupacion: AgrupacionTorre | ''; columnas: AgrupacionTorre | ''; periodo: PeriodoTorre;
  /** Solo «Matrículas por departamento» toca un filtro (el tipo), como antes. Ningún chip pone «Estado actual». */
  tiposTramite?: string[];
  descripcion: string;
}

// Spec UX §3.2. El ejemplo del pedido («Aprobados por compañía · 6 meses») NO lleva filtro de estado (D3).
export const PREGUNTAS_TORRE: readonly PreguntaTorre[] = [
  { id: 'aprobados_hoy', rotulo: 'Aprobados hoy', metrica: 'tramites', fechaBase: 'aprobacion', agrupacion: 'compania', columnas: '',
    periodo: 'hoy', descripcion: 'Trámites · aprobación · Compañía · Hoy' },
  { id: 'aprobados_6m', rotulo: 'Aprobados por compañía · 6 meses', metrica: 'tramites', fechaBase: 'aprobacion', agrupacion: 'compania',
    columnas: '', periodo: 'ultimos_6m', descripcion: 'Trámites · aprobación · Compañía · Últimos 6 meses' },
  { id: 'aprobados_mes', rotulo: 'Aprobados por compañía y mes', metrica: 'tramites', fechaBase: 'aprobacion', agrupacion: 'compania',
    columnas: 'mes', periodo: 'ultimos_6m', descripcion: 'Trámites · aprobación · Compañía y Mes · Últimos 6 meses' },
  { id: 'tiempo_aprobacion', rotulo: 'Tiempo hasta la aprobación', metrica: 'tiempo_creacion_aprobacion', fechaBase: 'aprobacion',
    agrupacion: 'mes', columnas: '', periodo: 'ultimos_6m', descripcion: 'Tiempo de creación a aprobación · Mes · Últimos 6 meses' },
  { id: 'costo_logistica', rotulo: 'Costo de logística del mes', metrica: 'costo_logistica', fechaBase: 'aprobacion', agrupacion: 'compania',
    columnas: '', periodo: 'mes', descripcion: 'Costo de logística · aprobación · Compañía · Este mes' },
  { id: 'impuestos_ot', rotulo: 'Impuestos pagados por organismo', metrica: 'impuestos_pagados', fechaBase: 'pago', agrupacion: 'organismo',
    columnas: '', periodo: 'mes', descripcion: 'Impuestos pagados · pago · Organismo de tránsito · Este mes' },
  { id: 'derechos', rotulo: 'Derechos de tránsito pagados', metrica: 'derechos_pagados', fechaBase: 'pago', agrupacion: 'compania',
    columnas: '', periodo: 'mes', descripcion: 'Derechos de tránsito pagados · pago · Compañía · Este mes' },
  { id: 'matriculas_dpto', rotulo: 'Matrículas por departamento', metrica: 'tramites', fechaBase: 'aprobacion', agrupacion: 'departamento',
    columnas: '', periodo: 'anio', tiposTramite: ['MATRICULA'], descripcion: 'Trámites aprobados de matrícula · Departamento · Este año' },
];

const GRUPOS_METRICA: { rotulo: string; unidades: string[] }[] = [
  { rotulo: 'Cuántos', unidades: ['conteo', 'pct'] },
  { rotulo: 'Cuánto se tardó', unidades: ['horas'] },
  { rotulo: 'Cuánto se pagó', unidades: ['cop'] },
];

/** En el selector, la foto del momento lo dice en el nombre. */
const rotuloMedida = (m: MetricaTorreDef) => (m.id === 'wip_activo' ? 'Trámites en curso (hoy)' : m.etiqueta);

function OpcionesAgrupacion({ lista }: { lista: readonly AgrupacionTorre[] }) {
  const tiempo = lista.filter((a) => esTemporal(a));
  const categoria = lista.filter((a) => !esTemporal(a));
  return (
    <>
      {tiempo.length > 0 && <optgroup label="En el tiempo">{tiempo.map((a) => <option key={a} value={a}>{ETIQUETA_AGRUPACION[a]}</option>)}</optgroup>}
      {categoria.length > 0 && <optgroup label="Por categoría">{categoria.map((a) => <option key={a} value={a}>{ETIQUETA_AGRUPACION[a]}</option>)}</optgroup>}
    </>
  );
}

const CAMPO = 'campo min-w-0 flex-[1_1_240px] lg:flex-[1_1_200px]';

export default function ConstructorConsultaTorre({
  metricas, preguntas, preguntaActiva, onPregunta, def, fecha, agrupacion, columnas, opcionesColumnas,
  onMedida, onFecha, onAgrupacion, onColumnas, onIntercambiar,
}: {
  metricas: readonly MetricaTorreDef[];
  preguntas: readonly PreguntaTorre[];
  preguntaActiva: string | undefined;
  onPregunta: (p: PreguntaTorre) => void;
  def: MetricaTorreDef;
  fecha: FechaBaseTorre | null;
  agrupacion: AgrupacionTorre | '';
  columnas: AgrupacionTorre | '';
  opcionesColumnas: readonly AgrupacionTorre[];
  onMedida: (id: MetricaTorreId) => void;
  onFecha: (f: FechaBaseTorre) => void;
  onAgrupacion: (a: AgrupacionTorre | '') => void;
  onColumnas: (a: AgrupacionTorre | '') => void;
  onIntercambiar: () => void;
}) {
  const foto = def.fechasBase.length === 0;
  return (
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
            title={p.descripcion} onClick={() => onPregunta(p)}>
            {p.rotulo}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-3">
        <div className={CAMPO}>
          <label htmlFor="torre-medir">Medir</label>
          <select id="torre-medir" className="control" value={def.id} onChange={(e) => onMedida(e.target.value as MetricaTorreId)}>
            {GRUPOS_METRICA.map((g) => {
              const del = metricas.filter((m) => g.unidades.includes(m.unidad));
              return del.length === 0 ? null : (
                <optgroup key={g.rotulo} label={g.rotulo}>
                  {del.map((m) => <option key={m.id} value={m.id}>{rotuloMedida(m)}</option>)}
                </optgroup>
              );
            })}
          </select>
        </div>
        <div className={CAMPO}>
          <label htmlFor="torre-fecha">Según la fecha de</label>
          {foto ? (
            <>
              <select id="torre-fecha" className="control" disabled value="hoy" aria-describedby="torre-fecha-pista" onChange={() => {}}>
                <option value="hoy">hoy (foto del momento)</option>
              </select>
              <small id="torre-fecha-pista" style={{ color: 'var(--color-text-secondary)' }}>
                Esta medida es la foto de hoy: no usa fecha ni periodo.
              </small>
            </>
          ) : (
            <select id="torre-fecha" className="control" value={fecha ?? ''} onChange={(e) => onFecha(e.target.value as FechaBaseTorre)}>
              {FECHAS_BASE_TORRE.map((f) => {
                const aplica = def.fechasBase.includes(f);
                return <option key={f} value={f} disabled={!aplica}>{aplica ? FECHA_BASE_ORACION[f] : `${FECHA_BASE_ORACION[f]} (no aplica)`}</option>;
              })}
            </select>
          )}
        </div>
        <div className={CAMPO}>
          <label htmlFor="torre-agrupar">Agrupar por</label>
          <select id="torre-agrupar" className="control" value={agrupacion} onChange={(e) => onAgrupacion(e.target.value as AgrupacionTorre | '')}>
            <option value="">Sin agrupar (total)</option>
            <OpcionesAgrupacion lista={def.agrupacionesPermitidas} />
          </select>
        </div>
        {agrupacion !== '' && columnas !== '' && (
          <div className="order-last flex w-full justify-end lg:order-none lg:w-auto lg:self-center lg:pt-6">
            <button type="button" className="btn ghost sm transition-colors" aria-label="Intercambiar filas y columnas" onClick={onIntercambiar}>
              <Icono nombre="intercambio" size={16} />
              Intercambiar
            </button>
          </div>
        )}
        {agrupacion !== '' && (
          <div className={CAMPO}>
            <label htmlFor="torre-columnas">Y luego por</label>
            <select id="torre-columnas" className="control" value={columnas} onChange={(e) => onColumnas(e.target.value as AgrupacionTorre | '')}>
              <option value="">Ninguna</option>
              <OpcionesAgrupacion lista={opcionesColumnas} />
            </select>
          </div>
        )}
      </div>
    </section>
  );
}
