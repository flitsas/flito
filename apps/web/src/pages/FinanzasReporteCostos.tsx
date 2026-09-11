// Finanzas — Reporte de costos. Cada fila muestra los valores SELLADOS si el trámite está
// liquidado, o un ESTIMADO en vivo si no. La distinción se pinta, porque un estimado puede cambiar
// mañana y un sellado no. Rol `financiera` (+ admin/auditor, este último en solo lectura).
//
// Desde la HU #12434 la página es el ORQUESTADOR: guarda el estado, dispara las cargas y reparte
// entre la tarjeta de filtros, la tabla en secciones, la vista consolidada y los diálogos. Lo que
// se pinta vive en `components/finanzas/`.

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { hasPage } from '../lib/permissions';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import VisorSoportes from '../components/flit/VisorSoportes';
import ContadoresFacturacion from '../components/finanzas/ContadoresFacturacion';
import DetalleFacturacion from '../components/finanzas/DetalleFacturacion';
import TarjetaEnvioFacturacion from '../components/finanzas/TarjetaEnvioFacturacion';
import AccionEnviarFactura from '../components/finanzas/AccionEnviarFactura';
import DialogoEnvioFacturacion, { type TramiteDelEnvio } from '../components/finanzas/DialogoEnvioFacturacion';
import { useElegibilidadFacturacion } from '../components/finanzas/useElegibilidadFacturacion';
import FiltrosReporteCostos from '../components/finanzas/FiltrosReporteCostos';
import TablaReporteCostos from '../components/finanzas/TablaReporteCostos';
import ConsolidadoReporteCostos from '../components/finanzas/ConsolidadoReporteCostos';
import { periodoEnCurso, rangoDeMes } from '../components/finanzas/SelectorPeriodo';
import type { FacturacionTramite, ResumenFacturacion } from '../components/finanzas/tiposFacturacion';
import {
  ESTADO_POR_DEFECTO, faltantes,
  type ConsolidadoReporte, type Facetas, type Fila, type FiltrosDetalle, type Reporte,
} from '../components/finanzas/tiposReporteCostos';
import {
  type MotivoElegibilidad, type SiigoEnvioTramite, type SiigoEstadoReporte, type SiigoResumenEnvio,
} from '@operaciones/shared-types';
import {
  FlitCard, FlitEmpty, FlitPillGroup, FlitPillButton,
  flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../components/flit/flitPageKit';

type Vista = 'detalle' | 'consolidado';

/**
 * El punto de partida de la pantalla: Aprobado y el mes en curso (CF-05). Cerrar el mes es la
 * pregunta con la que se entra, así que ya viene armada; «Limpiar filtros» vuelve AQUÍ, no a un
 * rango vacío, y `hayFiltros` se mide contra esto.
 */
function filtrosIniciales(): FiltrosDetalle {
  const { anio, indice } = periodoEnCurso();
  const r = rangoDeMes(anio, indice);
  return {
    buscar: '', empresa: '', tipo: '', etapa: '', desde: '', hasta: '',
    aprobadoDesde: r.desde, aprobadoHasta: r.hasta,
    estados: [ESTADO_POR_DEFECTO], organismos: [], docCompleta: false, tipoPeriodo: 'mes',
  };
}

const claveDe = (f: FiltrosDetalle) => [
  f.buscar, f.empresa, f.tipo, f.etapa, f.desde, f.hasta, f.aprobadoDesde, f.aprobadoHasta,
  f.estados.join(','), f.organismos.join(','), f.docCompleta, f.tipoPeriodo,
].join('|');

export default function FinanzasReporteCostos() {
  const { user, hasFuncion } = useAuth();
  // HU #12170: botones por función del catálogo (`/permisos/mios`), no por rol literal.
  const puedeLiquidar = hasFuncion('liquidacion.liquidacion.liquidar');
  const puedeReversar = hasFuncion('liquidacion.liquidacion.reversar');
  // Emisión FE: Feature #12072 no absorbe Siigo; el proxy en el catálogo FLITO es facturar.
  const puedeEmitir = hasFuncion('liquidacion.liquidacion.facturar');
  const puedeReactivar = hasFuncion('liquidacion.liquidacion.facturar');

  const [data, setData] = useState<Reporte | null>(null);
  const [facetas, setFacetas] = useState<Facetas | null>(null);
  const [facetasCargando, setFacetasCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [recarga, setRecarga] = useState(0);
  const [enProceso, setEnProceso] = useState(false);
  const [soportesDe, setSoportesDe] = useState<Fila | null>(null);
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set());

  // Facturación electrónica (HU #11337). Se carga aparte del reporte a propósito: si un fallo del
  // módulo de Siigo tumbara la carga del reporte, quien viene a conciliar costos se quedaría sin la
  // pantalla entera por algo que no necesitaba para conciliar.
  const [resumenFe, setResumenFe] = useState<ResumenFacturacion | null>(null);
  const [feCargando, setFeCargando] = useState(true);
  const [feError, setFeError] = useState<string | null>(null);
  const [fichasFe, setFichasFe] = useState<Map<string, FacturacionTramite>>(new Map());
  const [estadoFe, setEstadoFe] = useState<SiigoEstadoReporte | null>(null);
  /** La fila cuyo detalle está abierto (HU #11331). La ficha la pide él. */
  const [detalleDe, setDetalleDe] = useState<Fila | null>(null);

  // Envío a facturación electrónica (HU #11329).
  const [envio, setEnvio] = useState<{
    tramites: TramiteDelEnvio[]; excluidos: (TramiteDelEnvio & { motivos: MotivoElegibilidad[] })[];
  } | null>(null);
  /**
   * El parche local del AC5: en cuanto llega el 202, las filas encoladas se pintan «En cola» sin
   * recargar. Se vacía cuando llegan datos nuevos, que son los que mandan.
   */
  const [parcheFe, setParcheFe] = useState<Map<string, SiigoEstadoReporte>>(new Map());
  /** Lo que salva a quien cerró el diálogo sin leerlo; también anuncia el cambio de vista. */
  const [anuncio, setAnuncio] = useState('');
  const tarjetaEnvioRef = useRef<HTMLHeadingElement>(null);

  const [filtros, setFiltros] = useState<FiltrosDetalle>(filtrosIniciales);
  const [page, setPage] = useState(1);
  const claveFiltros = claveDe(filtros);
  const cambiarFiltros = (parche: Partial<FiltrosDetalle>) => setFiltros((f) => ({ ...f, ...parche }));

  // La vista va en la URL (`?vista=consolidado`) para que un enlace del cierre de mes abra donde
  // toca. Sin página ni permiso nuevos: es la misma pantalla plegada.
  const [searchParams, setSearchParams] = useSearchParams();
  const vista: Vista = searchParams.get('vista') === 'consolidado' ? 'consolidado' : 'detalle';
  const cambiarVista = (v: Vista) => {
    if (v === vista) return;
    setSearchParams((p) => {
      const n = new URLSearchParams(p);
      if (v === 'consolidado') n.set('vista', 'consolidado'); else n.delete('vista');
      return n;
    }, { replace: true });
    setAnuncio(v === 'consolidado' ? 'Vista consolidada' : 'Vista de detalle');
  };

  // Consolidado (HU #12433). Se carga SOLO al conmutar a él, con los mismos params del detalle.
  const [consolidado, setConsolidado] = useState<ConsolidadoReporte | null>(null);
  const [consolidadoCargando, setConsolidadoCargando] = useState(false);
  const [consolidadoError, setConsolidadoError] = useState<string | null>(null);
  const [recargaConsolidado, setRecargaConsolidado] = useState(0);

  const params = () => {
    const p = new URLSearchParams();
    const f = filtros;
    if (f.buscar.trim()) p.set('buscar', f.buscar.trim());
    if (f.empresa) p.set('empresas', f.empresa);
    if (f.tipo) p.set('tipos', f.tipo);
    if (f.etapa) p.set('etapa', f.etapa);
    if (f.desde) p.set('desde', f.desde);
    if (f.hasta) p.set('hasta', f.hasta);
    if (f.aprobadoDesde) p.set('aprobadoDesde', f.aprobadoDesde);
    if (f.aprobadoHasta) p.set('aprobadoHasta', f.aprobadoHasta);
    if (f.estados.length) p.set('estados', f.estados.join(','));
    // Por CÓDIGO, que es la identidad del organismo en el API (CF-04); el nombre es para leer.
    if (f.organismos.length) p.set('organismos', f.organismos.join(','));
    if (f.docCompleta) p.set('documentacionCompleta', 'si');
    if (estadoFe) p.set('estadoFacturacion', estadoFe);
    return p;
  };

  const limpiarFiltros = () => {
    setFiltros(filtrosIniciales());
    setEstadoFe(null);
  };

  const hayFiltros = estadoFe !== null || claveFiltros !== claveDe(filtrosIniciales());

  useEffect(() => { setPage(1); setSeleccion(new Set()); }, [claveFiltros, estadoFe]);

  useEffect(() => {
    setError(null);
    const p = params();
    p.set('page', String(page));
    api.get<Reporte>(`/finanzas/reporte-costos?${p.toString()}`)
      // El parche local se descarta con los datos nuevos: mandan los del servidor.
      .then((r) => { setData(r); setParcheFe(new Map()); })
      .catch((e) => setError(errorMessage(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claveFiltros, estadoFe, page, recarga]);

  // Los contadores. Mismo filtro que la tabla salvo el propio estado, que lo excluye el servidor.
  useEffect(() => {
    setFeCargando(true);
    setFeError(null);
    api.get<ResumenFacturacion>(`/finanzas/reporte-costos/facturacion-electronica?${params().toString()}`)
      .then(setResumenFe)
      .catch((e) => { setResumenFe(null); setFeError(errorMessage(e)); })
      .finally(() => setFeCargando(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claveFiltros, estadoFe, recarga]);

  // El consolidado: los MISMOS `params()` del detalle más el tipo de periodo. Nada de construir una
  // query propia, que es como dos vistas de lo mismo empiezan a decir cosas distintas.
  useEffect(() => {
    if (vista !== 'consolidado') return;
    setConsolidadoCargando(true);
    setConsolidadoError(null);
    const p = params();
    p.set('periodo', filtros.tipoPeriodo);
    api.get<ConsolidadoReporte>(`/finanzas/reporte-costos/consolidado?${p.toString()}`)
      .then(setConsolidado)
      .catch((e) => { setConsolidado(null); setConsolidadoError(errorMessage(e)); })
      .finally(() => setConsolidadoCargando(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vista, claveFiltros, estadoFe, recarga, recargaConsolidado]);

  // La ficha de los trámites de ESTA página. Por lote y no una petición por fila.
  useEffect(() => {
    const ids = (data?.items ?? []).map((f) => f.tramiteId);
    if (ids.length === 0) { setFichasFe(new Map()); return; }
    api.get<{ items: FacturacionTramite[] }>(
      `/siigo/facturacion/tramites?${new URLSearchParams({ ids: ids.join(',') }).toString()}`)
      .then((r) => setFichasFe(new Map(r.items.map((i) => [i.tramiteId, i]))))
      // Un fallo aquí NO rompe el reporte y tampoco miente: la columna sigue pintando el estado
      // que trae cada fila; lo único que se pierde es el enriquecido.
      .catch(() => setFichasFe(new Map()));
  }, [data]);

  useEffect(() => {
    api.get<Facetas>('/finanzas/reporte-costos/facetas').then(setFacetas).catch(() => setFacetas(null))
      .finally(() => setFacetasCargando(false));
  }, []);

  const filas = data?.items ?? [];
  const refrescar = () => setRecarga((n) => n + 1);

  /** Solo se puede liquidar lo que no está liquidado y tiene todos sus conceptos resueltos. */
  // Es la misma condición que exige el backend al sellar: si aquí faltara una, el botón se
  // ofrecería activo para fallar al pulsarlo.
  const liquidable = (f: Fila) => !f.sellada && faltantes(f).length === 0;

  // ── Envío a facturación electrónica (HU #11329) ───────────────────────────

  const estadoFeDe = (f: Fila) => parcheFe.get(f.tramiteId) ?? f.estadoFacturacion;
  /**
   * Sobre quién tiene sentido PREGUNTAR. No decide elegibilidad —eso solo lo dice el servidor—:
   * decide el universo al que la acción aplica. `encolado` se descuenta aparte: es el único estado
   * con trabajo en marcha, y ofrecer el botón invitaría a pulsar sobre algo ya en curso (AC6).
   */
  const esCandidato = (f: Fila) => f.estadoLiquidacion === 'facturado' && estadoFeDe(f) !== 'encolado';
  const candidatos = filas.filter(esCandidato);

  // La MISMA clave de invalidación que el reporte: cambiar de filtro, de página o recargar vacía
  // los veredictos guardados.
  const claveVista = [claveFiltros, estadoFe, page, recarga].join('|');
  const elegibilidad = useElegibilidadFacturacion(
    candidatos.map((f) => f.tramiteId), puedeEmitir, claveVista);

  const esElegible = (f: Fila) => elegibilidad.veredictos.get(f.tramiteId)?.elegible === true;
  /** Lo accionable de la página: lo liquidable y lo que puede irse a facturación. */
  const accionable = (f: Fila) => liquidable(f) || (puedeEmitir && esCandidato(f));
  const seleccionados = filas.filter((f) => seleccion.has(f.tramiteId));
  /**
   * Los dos conjuntos son **disjuntos por construcción**: `liquidable` exige `!sellada` y ser
   * candidato exige `estadoLiquidacion === 'facturado'`, que implica `sellada`.
   */
  const liquidablesSel = seleccionados.filter(liquidable);
  const enviablesSel = seleccionados.filter((f) => esCandidato(f) && esElegible(f));
  const enviablesPagina = candidatos.filter(esElegible);
  const conSeleccion = puedeEmitir && enviablesSel.length > 0;

  // A4 — el diálogo agrupa por empresa para preguntar la emisión una vez por cliente.
  const deEnvio = (f: Fila): TramiteDelEnvio => ({
    tramiteId: f.tramiteId,
    idFlit: f.idFlit,
    clienteId: elegibilidad.veredictos.get(f.tramiteId)?.companiaId ?? null,
    empresa: f.empresa,
  });

  /** Abre el diálogo con los elegibles del conjunto y, plegado, el porqué de los que se quedan. */
  const abrirEnvio = (conjunto: Fila[]) => setEnvio({
    tramites: conjunto.filter(esElegible).map(deEnvio),
    excluidos: conjunto.filter((f) => !esElegible(f)).map((f) => ({
      ...deEnvio(f), motivos: elegibilidad.veredictos.get(f.tramiteId)?.motivos ?? [],
    })),
  });

  const marcarEncolados = (items: SiigoEnvioTramite[]) => setParcheFe((m) => {
    const n = new Map(m);
    // `ya_en_cola` también: lo estaban ya, y la fila lo estaba pintando mal.
    for (const i of items) {
      if (i.resultado === 'encolado' || i.resultado === 'reactivado' || i.resultado === 'ya_en_cola') {
        n.set(i.tramiteId, 'encolado');
      }
    }
    return n;
  });

  const cerrarEnvio = (resumen: SiigoResumenEnvio | null) => {
    const enviados = envio?.tramites.map((t) => t.tramiteId) ?? [];
    setEnvio(null);
    if (resumen) {
      setAnuncio(`${resumen.encolados} trámite(s) quedaron en cola. ${resumen.rechazados} no se pudieron enviar.`);
      setSeleccion((s) => new Set([...s].filter((id) => !enviados.includes(id))));
      // «Sin recargar» es sin `window.location.reload`: la tabla se repinta con datos nuevos.
      refrescar();
    }
    // `useFocusTrap` devuelve el foco al disparador; si esa fila ya no existe, `focus()` sobre un
    // nodo desmontado deja el foco en `<body>`. Se rescata al encabezado de la tarjeta de envío.
    setTimeout(() => {
      if (document.activeElement === document.body) tarjetaEnvioRef.current?.focus();
    }, 0);
  };

  const ejecutar = async (fn: () => Promise<string>) => {
    setEnProceso(true); setError(null); setAviso(null);
    try { setAviso(await fn()); refrescar(); setSeleccion(new Set()); }
    catch (e) { setError(errorMessage(e)); }
    finally { setEnProceso(false); }
  };

  const liquidarUno = (f: Fila) => ejecutar(async () => {
    await api.post(`/flito/liquidacion/${f.tramiteId}/liquidar`, {});
    return `${f.idFlit} liquidado.`;
  });

  // Solo los LIQUIDABLES de la selección: mandar la selección completa enviaría a liquidar cosas
  // ya selladas — que el backend rechaza, y con razón.
  const liquidarLote = () => ejecutar(async () => {
    const r = await api.post<{ liquidados: string[]; fallidos: { motivo: string }[] }>(
      '/flito/liquidacion/lote/liquidar', { tramiteIds: liquidablesSel.map((f) => f.tramiteId) });
    return `${r.liquidados.length} liquidados, ${r.fallidos.length} sin liquidar.`;
  });

  const facturarUno = (f: Fila) => ejecutar(async () => {
    await api.post(`/flito/liquidacion/${f.tramiteId}/facturar`, {});
    return `${f.idFlit} marcado como facturado.`;
  });

  const reversarUno = (f: Fila, motivo: string) => ejecutar(async () => {
    await api.post(`/flito/liquidacion/${f.tramiteId}/reversar`, { motivo });
    return `Liquidación de ${f.idFlit} reversada.`;
  });

  // La exportación cubre TODO el filtro, no la página: se abre en una pestaña para que el
  // navegador gestione la descarga con su propio indicador de progreso. El orden de las columnas
  // lo decide el API; la pantalla no lo transforma (CF-17).
  const exportar = () => {
    window.open(`/api/finanzas/reporte-costos/export?${params().toString()}`, '_blank');
  };
  const exportarConsolidado = () => {
    const p = params();
    p.set('periodo', filtros.tipoPeriodo);
    window.open(`/api/finanzas/reporte-costos/consolidado/export?${p.toString()}`, '_blank');
  };

  const enConsolidado = vista === 'consolidado';

  return (
    <div className="space-y-4">
      <PageHeaderCard title="Reporte de costos"
        subtitle="Costos reales por trámite. Las filas liquidadas muestran valores sellados; el resto, un estimado con las tarifas vigentes."
        actions={(
          <div className="flex flex-wrap items-center gap-3">
            {/* El conmutador de vista: el consolidado es la misma pantalla plegada por cliente y
                periodo, con los mismos filtros. Cambia el botón de exportar y su peso: en el
                consolidado exportar es la única acción y para eso se entra. */}
            <FlitPillGroup role="tablist" label="Vista del reporte">
              <FlitPillButton active={!enConsolidado} pressed={!enConsolidado} onClick={() => cambiarVista('detalle')}>Detalle</FlitPillButton>
              <FlitPillButton active={enConsolidado} pressed={enConsolidado} onClick={() => cambiarVista('consolidado')}>Consolidado</FlitPillButton>
            </FlitPillGroup>
            {enConsolidado
              ? <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} onClick={exportarConsolidado}>Exportar consolidado</button>
              : <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={exportar}>Exportar CSV</button>}
          </div>
        )} />

      <FiltrosReporteCostos filtros={filtros} onCambio={cambiarFiltros} facetas={facetas} facetasCargando={facetasCargando}
        resumen={data?.resumen ?? null} hayFiltros={hayFiltros} onLimpiar={limpiarFiltros} />

      {/* Lo que salva a quien cerró el diálogo sin leerlo, y el anuncio del cambio de vista. */}
      <p className="sr-only" role="status" aria-live="polite">{anuncio}</p>

      {enConsolidado && (
        <FlitCard>
          <ConsolidadoReporteCostos data={consolidado} cargando={consolidadoCargando} error={consolidadoError}
            onReintentar={() => setRecargaConsolidado((n) => n + 1)} onLimpiarFiltros={limpiarFiltros} />
        </FlitCard>
      )}

      {!enConsolidado && (
        <>
          {/* HU #11337 — los contadores van DEBAJO de los filtros y ENCIMA de la tabla: cuentan
              sobre lo que los filtros dejan y describen lo que se ve abajo. */}
          <ContadoresFacturacion
            resumen={resumenFe}
            cargando={feCargando}
            error={feError}
            seleccionado={estadoFe}
            onSeleccionar={setEstadoFe}
            onReintentar={refrescar}
          />

          {error && <FlitCard><p className="text-sm text-red-600">{error}</p></FlitCard>}
          {aviso && <FlitCard><p className="text-sm" style={{ color: 'var(--flit-blue-text)' }}>{aviso}</p></FlitCard>}

          {/* Un total al que le faltan conceptos no puede pasar por completo. Va en una línea y con
              la salida puesta. */}
          {data && data.totales.filasIncompletas > 0 && (
            <FlitCard className="!p-3">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <span>
                  El total mostrado está incompleto:{' '}
                  <strong>{data.totales.filasIncompletas.toLocaleString('es-CO')}</strong> de{' '}
                  <strong>{data.total.toLocaleString('es-CO')}</strong> trámites tienen algún concepto
                  sin resolver.
                </span>
                {filtros.etapa !== 'incompleto' && (
                  <button type="button" className="text-sm font-semibold underline"
                    style={{ color: 'var(--flit-blue-text)' }} onClick={() => cambiarFiltros({ etapa: 'incompleto' })}>
                    Ver cuáles
                  </button>
                )}
              </p>
            </FlitCard>
          )}

          {/* La barra dice cuántos de los seleccionados sirven para cada acción ANTES de pulsar
              nada (AC3). */}
          {puedeLiquidar && seleccion.size > 0 && (
            <FlitCard>
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm font-semibold">
                  {seleccion.size} seleccionado(s) · {liquidablesSel.length} se pueden liquidar
                  {puedeEmitir && ` · ${enviablesSel.length} se pueden enviar a facturación electrónica`}
                </span>
                <button className={flitBtnPrimary} style={flitBtnPrimaryStyle}
                  disabled={enProceso || liquidablesSel.length === 0} onClick={liquidarLote}>
                  {enProceso ? 'Liquidando…' : `Liquidar ${liquidablesSel.length}`}
                </button>
                {conSeleccion && (
                  <button className={flitBtnPrimary} style={flitBtnPrimaryStyle}
                    onClick={() => abrirEnvio(seleccionados.filter(esCandidato))}>
                    Enviar {enviablesSel.length} a facturación electrónica
                  </button>
                )}
                <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setSeleccion(new Set())}>Quitar selección</button>
              </div>
            </FlitCard>
          )}

          {/* La tarjeta de envío NO se monta para quien no puede emitir: al `auditor` el estado ya
              se lo dan los contadores, la columna y la ficha; esto es el envoltorio de la acción. */}
          {puedeEmitir && filas.length > 0 && (
            <TarjetaEnvioFacturacion
              cargando={elegibilidad.cargando}
              error={elegibilidad.error}
              onReintentar={elegibilidad.reintentar}
              filas={filas.length}
              candidatos={candidatos.length}
              resumen={elegibilidad.resumen}
              elegibles={conSeleccion ? enviablesSel.length : enviablesPagina.length}
              universo={conSeleccion ? seleccion.size : candidatos.length}
              deLaSeleccion={conSeleccion}
              onEnviar={() => abrirEnvio(conSeleccion ? seleccionados.filter(esCandidato) : candidatos)}
              onVerPorFacturar={() => cambiarFiltros({ etapa: 'por_facturar' })}
              puedeVerConfiguracion={hasPage(user, 'siigo_parametrizacion')}
              tituloRef={tarjetaEnvioRef}
            />
          )}

          {data && filas.length === 0 && <FlitCard><FlitEmpty>No hay trámites que coincidan con los filtros.</FlitEmpty></FlitCard>}

          {data && filas.length > 0 && (
            <FlitCard>
              <TablaReporteCostos data={data} puedeLiquidar={puedeLiquidar} puedeReversar={puedeReversar} enProceso={enProceso}
                seleccion={seleccion} onSeleccion={setSeleccion} accionable={accionable}
                fichasFe={fichasFe} estadoFeDe={estadoFeDe} onAbrirDetalle={setDetalleDe}
                onLiquidar={liquidarUno} onFacturar={facturarUno} onReversar={reversarUno} onSoportes={setSoportesDe}
                // Va al final de la celda: el orden de foco es Soporte → Enviar → ¿Por qué no?, la
                // acción antes que su explicación.
                accionEnvio={(f) => puedeEmitir && esCandidato(f) && (
                  <AccionEnviarFactura tramiteId={f.tramiteId} idFlit={f.idFlit}
                    veredicto={elegibilidad.veredictos.get(f.tramiteId)}
                    cargando={elegibilidad.cargando} error={elegibilidad.error !== null}
                    onReintentar={elegibilidad.reintentar} onEnviar={() => abrirEnvio([f])} />
                )}
                onPrev={() => setPage((p) => Math.max(1, p - 1))} onNext={() => setPage((p) => p + 1)} />
            </FlitCard>
          )}
        </>
      )}

      {detalleDe && (
        <DetalleFacturacion
          tramiteId={detalleDe.tramiteId}
          idFlit={detalleDe.idFlit}
          estadoFila={estadoFeDe(detalleDe)}
          requiereRevision={detalleDe.facturaRequiereRevision}
          // HU #12170: proxy FE en catálogo = facturar (Siigo no absorbido aún).
          puedeOperar={puedeEmitir}
          onClose={() => setDetalleDe(null)}
          onCambio={refrescar}
        />
      )}

      {soportesDe && (
        <VisorSoportes ruta={`/finanzas/tramites/${soportesDe.tramiteId}/soportes`} titulo={soportesDe.idFlit}
          onClose={() => setSoportesDe(null)} />
      )}

      {envio && envio.tramites.length > 0 && (
        <DialogoEnvioFacturacion
          tramites={envio.tramites}
          excluidos={envio.excluidos}
          puedeReactivar={puedeReactivar}
          idFlitDe={(id) => filas.find((f) => f.tramiteId === id)?.idFlit ?? id}
          onEncolados={marcarEncolados}
          onCerrar={cerrarEnvio}
        />
      )}
    </div>
  );
}
