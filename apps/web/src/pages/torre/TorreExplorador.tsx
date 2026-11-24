// Torre de Control (Épica #14590) — Explorador de métricas flexible (spec UX `flito-torre-explorador-flexible.md`, ADR-0044).
// La pregunta tiene dos mitades: QUÉ se mide (tarjeta «¿Qué quiere saber?»: medida, fecha base y hasta 2 agrupaciones) y
// SOBRE QUÉ conjunto (la barra compartida de la Torre). No hay botón «Consultar»: cada cambio recalcula y gana la última
// petición. Única primaria: «Exportar a Excel». Sin la función de dinero, las medidas `requiereDinero` no se ofrecen.
// Vistas flexibles (spec §5): la fila de vista del resultado manda `top` y `comparar` en el cuerpo y guarda los tres
// valores en sessionStorage (nunca en la URL). Con el rango de la barra inválido no se consulta (spec §3).
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  FUNCION_TORRE_DINERO, METRICAS_TORRE, esTopGruposTorre, metricaTorre,
  type AgrupacionTorre, type ConsultaMetrica, type FechaBaseTorre, type MetricaTorreId, type ResultadoMetrica,
} from '@operaciones/shared-types';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { CLAVE_VISTA_TORRE, hayMasFiltros } from '../../lib/torreFiltros';
import GradientButton from '../../components/flit/GradientButton';
import InlineAlert from '../../components/flit/InlineAlert';
import { Icono } from '../../components/flit/kit/Icono';
import { ErrorVista, Vacio } from '../../components/flit/Cargador';
import { toastError, toastOk } from '../../components/flit/ToastFlito';
import PaginaTorre, { useTorre, type ContextoTorre } from '../../components/torre/PaginaTorre';
import ResultadoExplorador from '../../components/torre/ResultadoExplorador';
import OpcionesVistaTorre, { VISTA_TORRE_INICIAL, type VistaTorre } from '../../components/torre/OpcionesVistaTorre';
import { esAditiva } from '../../components/torre/TablaCruzadaTorre';
import { ROTULO_FILTRO, nombresFiltros, useOpcionesTorre } from '../../components/torre/BarraFiltrosTorre';
import ConstructorConsultaTorre, { PREGUNTAS_TORRE, type PreguntaTorre } from '../../components/torre/ConstructorConsultaTorre';
import {
  ETIQUETA_AGRUPACION, FECHA_BASE_ORACION, aFiltroTorre, esPeriodoCorto, esTemporal, etiquetaPeriodo, formatoUnidad,
  fraseRango, frasePeriodo, listaO, medidaConFecha, resumenCompanias, resumenSeleccion,
} from '../../components/torre/formatoTorre';

type Estado = { tipo: 'cargando' } | { tipo: 'error' } | { tipo: 'cortes' } | { tipo: 'listo'; res: ResultadoMetrica };

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

const minuscula = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);
const mismos = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** La fila de vista guardada; lo dudoso cae al default. */
function leerVista(): VistaTorre {
  try {
    const o = JSON.parse(sessionStorage.getItem(CLAVE_VISTA_TORRE) ?? 'null') as Partial<VistaTorre> | null;
    if (!o || typeof o !== 'object') return { ...VISTA_TORRE_INICIAL };
    return {
      top: typeof o.top === 'number' && esTopGruposTorre(o.top) ? o.top : VISTA_TORRE_INICIAL.top,
      pct: o.pct === true,
      comparar: o.comparar === true,
    };
  } catch {
    return { ...VISTA_TORRE_INICIAL };
  }
}

/** 400 `campo: 'rango'` con dos agrupaciones y una por día o semana: más de 62 cortes (RN-TOR-C3), no un fallo. */
function esDemasiadosCortes(e: unknown, agr: AgrupacionTorre | '', col: AgrupacionTorre | ''): boolean {
  if (!(e instanceof ApiError) || e.status !== 400 || !col) return false;
  const campo = (e.rawDetails as { campo?: unknown } | undefined)?.campo;
  return campo === 'rango' && [agr, col].some((a) => a === 'dia' || a === 'semana');
}

function Explorador({ ctx, onExportar }: {
  ctx: ContextoTorre;
  onExportar: (e: { habilitado: boolean; ejecutar: () => Promise<void> }) => void;
}) {
  const { filtros, setFiltros, abrirFicha, rangoInvalido } = ctx;
  const { hasFuncion } = useAuth();
  const veDinero = hasFuncion(FUNCION_TORRE_DINERO);
  const metricas = useMemo(() => METRICAS_TORRE.filter((m) => m.enConstructor && (veDinero || !m.requiereDinero)), [veDinero]);
  const preguntas = PREGUNTAS_TORRE.filter((p) => veDinero || !metricaTorre(p.metrica).requiereDinero);
  const { opciones } = useOpcionesTorre();

  // Al abrir: Trámites · aprobación · Compañía · Ninguna (continuidad con el Explorador de antes).
  const [metrica, setMetrica] = useState<MetricaTorreId>('tramites');
  const [fechaBase, setFechaBase] = useState<FechaBaseTorre>('aprobacion');
  const [agrupacion, setAgrupacion] = useState<AgrupacionTorre | ''>('compania');
  const [columnas, setColumnas] = useState<AgrupacionTorre | ''>('');
  const [ajuste, setAjuste] = useState('');
  const [vistaGuardada, setVista] = useState<VistaTorre>(leerVista);
  useEffect(() => {
    try { sessionStorage.setItem(CLAVE_VISTA_TORRE, JSON.stringify(vistaGuardada)); } catch { /* sin almacenamiento: solo memoria */ }
  }, [vistaGuardada]);
  const [estado, setEstado] = useState<Estado>({ tipo: 'cargando' });
  const [intento, setIntento] = useState(0);
  const ultima = useRef(0);

  // Sin la función de dinero (o si se la quitan con la pantalla abierta) no queda una medida de dinero elegida.
  useEffect(() => { if (!metricas.some((m) => m.id === metrica)) setMetrica('tramites'); }, [metricas, metrica]);

  const def = metricaTorre(metrica);
  const foto = def.fechasBase.length === 0;
  const fecha: FechaBaseTorre | null = foto ? null : def.fechasBase.includes(fechaBase) ? fechaBase : def.fechasBase[0];
  const permitidas = def.agrupacionesPermitidas;
  const agr: AgrupacionTorre | '' = agrupacion && permitidas.includes(agrupacion) ? agrupacion : '';
  // «Y luego por»: ni la principal ni, si la principal es temporal, otra temporal (RN-TOR-C1).
  const opcionesColumnas = agr ? permitidas.filter((a) => a !== agr && !(esTemporal(agr) && esTemporal(a))) : [];
  const col: AgrupacionTorre | '' = columnas && opcionesColumnas.includes(columnas) ? columnas : '';

  // Qué controles de vista aplican (spec §5). Al dejar de aplicar, Comparar se apaga y % vuelve a Absoluto (no queda
  // un estado oculto); Top conserva su valor.
  const conTop = (agr !== '' && !esTemporal(agr)) || (col !== '' && !esTemporal(col));
  const conPct = !!col && esAditiva(def.unidad);
  const conComparar = !foto && !col && !rangoInvalido;
  const vista: VistaTorre = { ...vistaGuardada, pct: conPct && vistaGuardada.pct, comparar: conComparar && vistaGuardada.comparar };
  useEffect(() => {
    if ((!conPct && vistaGuardada.pct) || (!conComparar && vistaGuardada.comparar)) {
      setVista((v) => ({ ...v, pct: conPct && v.pct, comparar: conComparar && v.comparar }));
    }
  }, [conPct, conComparar, vistaGuardada.pct, vistaGuardada.comparar]);
  const notaTop = col && !esTemporal(col) && esTemporal(agr) && vista.top > 12
    ? `Con ${ETIQUETA_AGRUPACION[col as AgrupacionTorre].toLowerCase()} en columnas se ven hasta 12.` : undefined;

  const filtroTorre = useMemo(() => aFiltroTorre(filtros), [filtros]);
  const consulta: ConsultaMetrica = useMemo(() => ({
    metrica, filtro: filtroTorre,
    ...(fecha ? { fechaBase: fecha } : {}),
    ...(agr ? { agrupacion: agr } : {}),
    ...(col ? { agrupacionColumnas: col } : {}),
    ...(conTop ? { top: vista.top } : {}),
    ...(vista.comparar ? { comparar: true } : {}),
  }), [metrica, fecha, agr, col, filtroTorre, conTop, vista.top, vista.comparar]);
  const claveConsulta = JSON.stringify(consulta);

  useEffect(() => {
    // Rango inválido en la barra: no se consulta y queda el último resultado válido (spec §3 regla 5).
    if (rangoInvalido) return;
    const id = ++ultima.current;
    setEstado({ tipo: 'cargando' });
    api.post<ResultadoMetrica>('/flito/torre/metricas/consultar', consulta)
      .then((res) => { if (id === ultima.current) setEstado({ tipo: 'listo', res }); })
      .catch((e: unknown) => {
        if (id === ultima.current) setEstado({ tipo: esDemasiadosCortes(e, agr, col) ? 'cortes' : 'error' });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `claveConsulta` resume `consulta`
  }, [claveConsulta, intento, rangoInvalido]);

  // Vacío = el CONJUNTO vacío; una tabla con celdas en 0 es lleno.
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

  // ── Reglas de coherencia: el control se corrige solo y se anuncia (spec §3.1) ──
  const cambiarMedida = (id: MetricaTorreId) => {
    const d = metricaTorre(id);
    const avisos: string[] = [];
    if (fecha && d.fechasBase.length > 0 && !d.fechasBase.includes(fecha)) {
      const nueva = d.fechasBase[0];
      setFechaBase(nueva);
      avisos.push(`La fecha cambió a ${FECHA_BASE_ORACION[nueva]}: ${FECHA_BASE_ORACION[fecha]} no aplica a ${d.etiqueta}.`);
    }
    if (agr && !d.agrupacionesPermitidas.includes(agr)) {
      setAgrupacion('');
      setColumnas('');
      avisos.push(`La agrupación cambió a Sin agrupar: ${ETIQUETA_AGRUPACION[agr]} no aplica a ${d.etiqueta}.`);
    } else if (col && !d.agrupacionesPermitidas.includes(col)) {
      setColumnas('');
      avisos.push(`«Y luego por» cambió a Ninguna: ${ETIQUETA_AGRUPACION[col]} no aplica a ${d.etiqueta}.`);
    }
    setAjuste(avisos.join(' '));
    setMetrica(id);
  };
  const cambiarAgrupacion = (a: AgrupacionTorre | '') => {
    setAgrupacion(a);
    setAjuste('');
    if (col && (a === '' || a === col || (esTemporal(a) && esTemporal(col)))) {
      setColumnas('');
      if (a !== '') setAjuste(`«Y luego por» cambió a Ninguna: ${ETIQUETA_AGRUPACION[col]} no se combina con ${ETIQUETA_AGRUPACION[a]}.`);
    }
  };
  const intercambiar = () => { if (agr && col) { setAgrupacion(col); setColumnas(agr); } };
  const agruparPorMes = () => {
    if (agr === 'dia' || agr === 'semana') setAgrupacion('mes');
    if (col === 'dia' || col === 'semana') setColumnas('mes');
  };

  const elegirPregunta = (p: PreguntaTorre) => {
    setMetrica(p.metrica);
    setFechaBase(p.fechaBase);
    setAgrupacion(p.agrupacion);
    setColumnas(p.columnas);
    setAjuste('');
    // Nunca toca las compañías ni «Más filtros»; solo «Matrículas por departamento» pone el tipo, como antes.
    setFiltros({ ...filtros, periodo: p.periodo, rango: null, ...(p.tiposTramite ? { tiposTramite: p.tiposTramite } : {}) });
  };
  // Marcado solo si TODA la consulta coincide, «Más filtros» incluidos: con un filtro de estado puesto, la pregunta ya
  // es otra (D3) y ningún chip queda marcado.
  const preguntaActiva = preguntas.find((p) => p.metrica === metrica && p.fechaBase === fecha && p.agrupacion === agr
    && p.columnas === col && p.periodo === filtros.periodo
    && filtros.organismos.length === 0 && filtros.departamentos.length === 0 && filtros.flitEstados.length === 0
    && mismos(filtros.tiposTramite, p.tiposTramite ?? []))?.id;

  // ── La oración devuelta (spec §5.1) ──
  const medida = medidaConFecha(metrica, def.etiqueta, def.fechasBase, fecha);
  const porQue = agr ? ` · por ${ETIQUETA_AGRUPACION[agr].toLowerCase()}${col ? ` y ${ETIQUETA_AGRUPACION[col].toLowerCase()}` : ''}` : '';
  const titulo = `${medida}${foto ? '' : ` · ${etiquetaPeriodo(filtros)}`}${porQue}`;
  const nombres = nombresFiltros(filtros, opciones);
  const companias = resumenCompanias(filtros.companiaIds.map((id) => opciones.companias.find((c) => c.id === id)?.nombre ?? 'Compañía elegida'));
  const otros = (Object.keys(ROTULO_FILTRO) as (keyof typeof ROTULO_FILTRO)[])
    .filter((k) => nombres[k].length > 0).map((k) => `${ROTULO_FILTRO[k]}: ${resumenSeleccion(nombres[k])}`);
  // RN-TOR-F5: las fechas las declara la API en `res.rango` (la web no calcula presets). Mientras carga, sin fecha.
  const rangoReal = !foto && estado.tipo === 'listo' && estado.res.rango ? [fraseRango(estado.res.rango)] : [];
  const partes = foto ? ['Hoy', companias, ...otros, 'No depende del periodo elegido.'] : [...rangoReal, companias, ...otros];
  const subtitulo = def.unidad === 'horas' && estado.tipo === 'listo'
    ? `${partes.join(' · ')} · ${estado.res.total.n.toLocaleString('es-CO')} trámites aprobados`
    : partes.join(' · ');

  const hayFiltros = filtros.companiaIds.length > 0 || hayMasFiltros(filtros);
  const textoVacio = hayFiltros ? 'Ningún trámite cumple esta consulta.'
    : `No hay ${minuscula(medida)} ${foto ? 'hoy' : frasePeriodo(filtros)}.`;
  const corto = !foto && esPeriodoCorto(filtros);
  const porDia = agr === 'dia' || col === 'dia';
  const textoCortes = `Con dos agrupaciones, el periodo admite hasta 62 cortes por ${porDia ? 'día' : 'semana'}.`;

  const anuncio = estado.tipo === 'cargando' ? 'Calculando la consulta'
    : estado.tipo === 'error' ? 'No pudimos calcular esta consulta'
      : estado.tipo === 'cortes' ? textoCortes
        : vacio ? textoVacio
          : `${titulo}: ${formatoUnidad(def.unidad, estado.res.total.valor, true)}`;

  const avisoEstado = filtros.flitEstados.length > 0 && !foto ? (
    <InlineAlert tono="info" accion={(
      <button type="button" className="btn ghost sm shrink-0 transition-colors"
        onClick={() => setFiltros({ ...filtros, flitEstados: [] })}>Quitar el filtro de estado</button>
    )}>
      Solo entran los trámites que hoy están en {listaO(nombres.flitEstados)}. Los que ya pasaron a otro estado quedan fuera,
      aunque su fecha de {FECHA_BASE_ORACION[fecha ?? 'creacion']} caiga en el periodo. Para contarlos todos, quite el filtro de estado.
    </InlineAlert>
  ) : null;

  return (
    <>
      <ConstructorConsultaTorre metricas={metricas} preguntas={preguntas} preguntaActiva={preguntaActiva} onPregunta={elegirPregunta}
        def={def} fecha={fecha} agrupacion={agr} columnas={col} opcionesColumnas={opcionesColumnas}
        onMedida={cambiarMedida} onFecha={(f) => { setFechaBase(f); setAjuste(''); }} onAgrupacion={cambiarAgrupacion}
        onColumnas={(a) => { setColumnas(a); setAjuste(''); }} onIntercambiar={intercambiar} />

      <p className="sr-only" role="status" aria-live="polite">{ajuste ? `${ajuste} ${anuncio}` : anuncio}</p>

      {estado.tipo === 'cargando' && (
        <EsqueletoResultado cruzado={!!col} conGrafica={!!col && (esTemporal(agr) || esTemporal(col))} comparar={vista.comparar} />
      )}
      {estado.tipo === 'error' && (
        <section className="card min-w-0" data-torre="resultado" data-estado="error">
          <ErrorVista texto="No pudimos calcular esta consulta. Revise su conexión e intente de nuevo." onReintentar={() => setIntento((n) => n + 1)} />
        </section>
      )}
      {estado.tipo === 'cortes' && (
        <section className="card min-w-0" data-torre="resultado" data-estado="cortes">
          <Vacio icono="alerta" texto={textoCortes} detalle="Elija una agrupación más amplia o acorte el periodo."
            accion={<GradientButton variant="secondary" size="sm" onClick={agruparPorMes}>Agrupar por mes</GradientButton>} />
        </section>
      )}
      {vacio && (
        <section className="card min-w-0" data-torre="resultado" data-estado="vacio">
          <Vacio texto={textoVacio}
            detalle={hayFiltros ? 'Pruebe quitar algún filtro o ampliar el periodo.' : corto ? 'Pruebe con un periodo más amplio.' : 'Pruebe con otra medida u otra fecha.'}
            accion={hayFiltros ? (
              <GradientButton variant="secondary" size="sm"
                onClick={() => setFiltros({ ...filtros, companiaIds: [], organismos: [], departamentos: [], tiposTramite: [], flitEstados: [] })}>
                Quitar filtros
              </GradientButton>
            ) : corto ? (
              <GradientButton variant="secondary" size="sm" onClick={() => setFiltros({ ...filtros, periodo: 'ultimos_6m', rango: null })}>
                Ver los últimos 6 meses
              </GradientButton>
            ) : undefined} />
        </section>
      )}
      {lleno && estado.tipo === 'listo' && (
        <ResultadoExplorador res={estado.res} def={def} agrupacion={agr} titulo={titulo} subtitulo={subtitulo} onVerFicha={abrirFicha}
          avisos={avisoEstado} medida={medida} vista={vista}
          opciones={<OpcionesVistaTorre vista={vista} onCambio={setVista} conTop={conTop} conPct={conPct} conComparar={conComparar} notaTop={notaTop} />} />
      )}
    </>
  );
}

/** Esqueleto de la estructura que viene: simple (cifra + ranking + filas) o cruzado (cifra, gráfica y rejilla). */
function EsqueletoResultado({ cruzado, conGrafica, comparar }: { cruzado: boolean; conGrafica: boolean; comparar: boolean }) {
  // Con Comparar: una línea corta bajo la cifra y 2 columnas más en las filas (spec §6).
  const cifra = (
    <div className="flex flex-col gap-2 lg:max-w-[18rem]">
      <div className="kit-esqueleto h-[104px]" aria-hidden="true" />
      {comparar && <div className="kit-esqueleto h-4 w-2/3" aria-hidden="true" />}
    </div>
  );
  return (
    <section className="card min-w-0" aria-busy="true" aria-label="Calculando la consulta" data-torre="resultado" data-estado="cargando">
      <div className="kit-esqueleto mb-2 h-6 w-2/3" aria-hidden="true" />
      <div className="kit-esqueleto mb-4 h-4 w-1/3" aria-hidden="true" />
      {!cruzado ? (
        <>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
            {cifra}
            <div className="flex flex-col gap-2">{[0, 1, 2, 3].map((i) => <div key={i} className="kit-esqueleto h-6" aria-hidden="true" />)}</div>
          </div>
          <div className="mt-4 flex flex-col gap-2" aria-hidden="true">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className={comparar ? 'grid grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))] gap-1.5' : ''}>
                {comparar ? [0, 1, 2, 3, 4].map((c) => <div key={c} className="kit-esqueleto h-10" />) : <div className="kit-esqueleto h-10" />}
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          {/* Con eje temporal, la gráfica va a todo el ancho bajo la cifra (spec §4). */}
          <div className="grid grid-cols-1 gap-4">
            {cifra}
            {conGrafica && <div className="kit-esqueleto h-[250px]" aria-hidden="true" />}
          </div>
          <div className="mt-4 flex flex-col gap-1.5" aria-hidden="true">
            {[0, 1, 2, 3, 4, 5, 6].map((f) => (
              <div key={f} className="grid grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))] gap-1.5">
                {[0, 1, 2, 3, 4].map((c) => <div key={c} className="kit-esqueleto h-8" />)}
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
