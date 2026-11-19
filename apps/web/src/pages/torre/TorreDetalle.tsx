// Torre de Control (Épica #14590, ADR-0047, spec UX §5, maqueta `docs/ux/mockups/torre-detalle.html`) — Detalle
// universal: los registros que forman una cifra. Se llega desde una KPI, una fila de bloque o el Explorador; no está en
// la navegación. La URL solo trae datos opacos (`lib/torreDetalle.ts`); la placa vive en el estado de esta página y viaja
// en el body del POST (nunca en la URL ni en sessionStorage). Cuatro estados + vacío por filtros, aviso de tope y
// conjunto inválido. «Descargar Excel» es la única primaria y solo existe con `torre.detalle.exportar`.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  TOPES_TORRE, conjuntoTorre, metricaTorre,
  type ConsultaDetalle, type ExportarDetalle, type FiltrosDetalleTorre, type OrdenDetalle, type ResultadoDetalle,
} from '@operaciones/shared-types';
import { ApiError, torreDetalleApi } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { hasPage } from '../../lib/permissions';
import { ORIGENES_DETALLE, etiquetaVistaOrigen, leerDetalleUrl, rutaVolver, type DetalleEnUrl } from '../../lib/torreDetalle';
import PageHeaderCard from '../../components/flit/PageHeaderCard';
import GradientButton, { claseBoton } from '../../components/flit/GradientButton';
import InlineAlert from '../../components/flit/InlineAlert';
import FiltrosPlegables from '../../components/flit/FiltrosPlegables';
import { ErrorVista, Vacio } from '../../components/flit/Cargador';
import { flitInp } from '../../components/flit/flitPageKit';
import { Icono } from '../../components/flit/kit/Icono';
import { toastError, toastOk } from '../../components/flit/ToastFlito';
import BarraFiltrosTorre, { useOpcionesTorre } from '../../components/torre/BarraFiltrosTorre';
import SelectorMultipleTorre from '../../components/torre/SelectorMultipleTorre';
import TablaDetalleTorre, { type TamanoDetalle } from '../../components/torre/TablaDetalleTorre';
import { useTorre, type ContextoTorre } from '../../components/torre/PaginaTorre';
import { aFiltroTorre, conteo } from '../../components/torre/formatoTorre';

export const FUNCION_TORRE_DETALLE_EXPORTAR = 'torre.detalle.exportar';
const FUNCION_TORRE_PLACA = 'torre.placa.buscar';
const PLACA_VALIDA = /^[A-Z0-9]{3,7}$/;

type Estado =
  | { tipo: 'cargando'; previo: ResultadoDetalle | null }
  | { tipo: 'error'; motivo: 'tiempo' | 'permiso' | 'otro' }
  | { tipo: 'listo'; res: ResultadoDetalle };

/** Título del catálogo, sin esperar al API (§5.3: el encabezado ya dice qué lista es mientras carga). */
function tituloDe(d: DetalleEnUrl): string {
  return d.origen.tipo === 'conjunto' ? conjuntoTorre(d.origen.conjunto).etiqueta : metricaTorre(d.origen.metrica).etiqueta;
}

export default function TorreDetalle() {
  const [params] = useSearchParams();
  const torre = useTorre();
  const leido = useMemo(() => leerDetalleUrl(params), [params]);
  if (!leido) return <ConjuntoInvalido />;
  return <Detalle key={params.toString()} d={leido} torre={torre} />;
}

function ConjuntoInvalido() {
  const { user } = useAuth();
  return (
    <div className="flex flex-col gap-4" data-torre="detalle" data-estado="invalido">
      <PageHeaderCard title="Lista no disponible" miga={[{ etiqueta: 'Torre de Control' }]} />
      <section className="card">
        <Vacio texto="Esta lista no existe o ya no está disponible." detalle="Vuelva al tablero y ábrala desde la cifra."
          accion={hasPage(user, 'torre_360') ? <Link to="/flito/torre/resumen" className={claseBoton('secondary', 'sm')}>Ir al Resumen 360°</Link> : undefined} />
      </section>
    </div>
  );
}

/** Placa del filtro: mayúsculas, solo letras y números, ≤ 7. */
const normalizarPlaca = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 7);

function Detalle({ d, torre }: { d: DetalleEnUrl; torre: ContextoTorre }) {
  const { user, hasFuncion } = useAuth();
  const titulo = tituloDe(d);
  const tituloRef = useRef<HTMLHeadingElement>(null);
  const defConjunto = d.origen.tipo === 'conjunto' ? conjuntoTorre(d.origen.conjunto) : null;
  const foto = defConjunto ? defConjunto.fechaBase === null : false;

  // Filtros propios de la lista. La placa solo en memoria; se aplica con ≥ 3 caracteres y 400 ms de pausa (§5.2).
  const [placaTexto, setPlacaTexto] = useState('');
  const [placa, setPlaca] = useState('');
  const [estados, setEstados] = useState<string[]>([]);
  const [orden, setOrden] = useState<OrdenDetalle | null>(defConjunto ? { ...defConjunto.ordenDefecto } : null);
  const [pagina, setPagina] = useState(1);
  const [tamano, setTamano] = useState<TamanoDetalle>(25);
  const [estado, setEstado] = useState<Estado>({ tipo: 'cargando', previo: null });
  const [intento, setIntento] = useState(0);
  const [exportando, setExportando] = useState(false);
  const ultima = useRef(0);

  useEffect(() => { tituloRef.current?.focus(); }, []);
  useEffect(() => {
    const t = window.setTimeout(() => setPlaca(PLACA_VALIDA.test(placaTexto) ? placaTexto : ''), 400);
    return () => window.clearTimeout(t);
  }, [placaTexto]);

  const filtro = aFiltroTorre(d.periodoFijo ? { ...torre.filtros, periodo: 'mes', rango: null } : torre.filtros);
  const filtrosDetalle: FiltrosDetalleTorre = { ...(placa ? { placa } : {}), ...(estados.length ? { estados } : {}) };
  const activos = (placa ? 1 : 0) + (estados.length ? 1 : 0);
  const base: ExportarDetalle = {
    origen: d.origen, ...(d.segmentos.length ? { segmentos: d.segmentos } : {}), filtro,
    ...(activos ? { filtrosDetalle } : {}), ...(orden ? { orden } : {}),
  };
  const consulta: ConsultaDetalle = { ...base, pagina, tamano };
  const clave = JSON.stringify(consulta);

  // Cambia el filtro, la placa, el estado o el tamaño: vuelve a la página 1.
  const claveFiltros = JSON.stringify([filtro, filtrosDetalle, tamano, orden]);
  useEffect(() => { setPagina(1); }, [claveFiltros]);

  useEffect(() => {
    if (torre.rangoInvalido) return;
    const id = ++ultima.current;
    setEstado((e) => ({ tipo: 'cargando', previo: e.tipo === 'listo' ? e.res : e.tipo === 'cargando' ? e.previo : null }));
    torreDetalleApi.consultar(JSON.parse(clave) as ConsultaDetalle)
      .then((res) => { if (id === ultima.current) setEstado({ tipo: 'listo', res }); })
      .catch((e: unknown) => {
        if (id !== ultima.current) return;
        const status = e instanceof ApiError ? e.status : 0;
        setEstado({ tipo: 'error', motivo: status === 503 ? 'tiempo' : status === 403 ? 'permiso' : 'otro' });
      });
  }, [clave, intento, torre.rangoInvalido]);

  const res = estado.tipo === 'listo' ? estado.res : estado.tipo === 'cargando' ? estado.previo : null;
  const total = res?.total ?? null;
  const excedeExcel = total !== null && total > TOPES_TORRE.FILAS_DETALLE_EXPORTAR_MAX;
  const puedeExportar = hasFuncion(FUNCION_TORRE_DETALLE_EXPORTAR);
  // «Volver a <área>» vuelve a la subvista de origen (spec UX §6.1: `?vista=`), con su nombre en la miga.
  const vistaVolver = d.volver ? etiquetaVistaOrigen(d.volver, d.vistaVolver) : null;
  const volver = d.volver && hasPage(user, ORIGENES_DETALLE[d.volver].slug)
    ? { ...ORIGENES_DETALLE[d.volver], to: rutaVolver(d.volver, d.vistaVolver), vista: vistaVolver } : null;
  const quitarFiltros = () => { setPlacaTexto(''); setPlaca(''); setEstados([]); };

  const exportar = async (): Promise<void> => {
    setExportando(true);
    try {
      await torreDetalleApi.exportar(base);
      toastOk(`Se descargó el Excel con ${conteo(total ?? 0)} ${total === 1 ? 'registro' : 'registros'}.`, { id: 'torre-detalle-exportar' });
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      toastError(
        status === 403 ? 'No tiene permiso para descargar esta lista.'
          : status === 422 ? 'La lista es muy grande para un Excel. Acote el periodo o los filtros e intente de nuevo.'
            : 'No se pudo generar el Excel. Intente de nuevo en un momento.',
        status === 403 || status === 422 ? undefined : () => { void exportar(); }, { id: 'torre-detalle-exportar' },
      );
    } finally {
      setExportando(false);
    }
  };

  const acciones = (volver || puedeExportar) ? (
    <>
      {volver && (
        <Link to={volver.to} className={claseBoton('ghost')} data-torre="volver">
          <span aria-hidden="true">←</span> Volver {d.volver === 'explorador' ? 'al' : 'a'} {volver.vista ?? volver.etiqueta}
        </Link>
      )}
      {puedeExportar && (
        <GradientButton type="button" ocupado={exportando} data-torre="exportar-detalle"
          disabled={estado.tipo !== 'listo' || estado.res.total === 0 || excedeExcel}
          title={excedeExcel ? 'La lista pasa del tope del Excel: filtre para descargarla.' : undefined}
          onClick={() => { void exportar(); }}>
          <Icono nombre="nube-bajar" size={18} />
          {exportando ? 'Generando Excel…' : 'Descargar Excel'}
        </GradientButton>
      )}
    </>
  ) : undefined;

  // La frase la arma el API con el total vivo de cada respuesta (`fraseDeConjunto`, UX §4.2): aquí no se escribe copy.
  const frase = res?.frase ?? null;
  const definicion = res?.definicion.definicion ?? null;

  return (
    <div className="flex flex-col gap-4" data-torre="detalle" data-estado={estado.tipo === 'listo' ? (estado.res.total === 0 ? 'vacio' : 'lleno') : estado.tipo}>
      <PageHeaderCard title={res?.definicion.etiqueta ?? titulo} titleRef={tituloRef} actions={acciones}
        miga={[{ etiqueta: 'Torre de Control' }, ...(volver ? (volver.vista
          ? [{ etiqueta: volver.etiqueta, to: ORIGENES_DETALLE[d.volver!].to }, { etiqueta: volver.vista, to: volver.to }]
          : [{ etiqueta: volver.etiqueta, to: volver.to }]) : [])]}
        subtitle={frase ?? undefined}
        detalle={definicion
          ? <p className="mt-1 max-w-[72ch] text-sm" data-torre="definicion-detalle"><strong>Cómo se calcula:</strong> {definicion}</p>
          : <div className="kit-esqueleto mt-2 h-4 w-72 max-w-full" aria-hidden="true" />} />
      <p className="sr-only" role="status">{estado.tipo === 'cargando' ? 'Cargando la lista' : frase ?? ''}</p>

      <BarraFiltrosTorre filtros={torre.filtros} onCambio={torre.setFiltros} onLimpiar={torre.limpiar}
        onBuscarPlaca={torre.abrirFicha} buscadorRef={torre.buscadorRef} onRangoInvalido={torre.setRangoInvalido} />
      {(foto || d.periodoFijo) && (
        <p className="m-0 flex flex-wrap items-center gap-2 text-sm text-[color:var(--color-text-secondary)]" data-torre="nota-periodo">
          {foto && <span className="kit-etiqueta" data-tono="neutro">Foto de hoy</span>}
          {foto ? 'Esta lista es la foto de hoy: no depende del periodo.' : 'Esta lista es del mes en curso, como el Resumen 360°.'}
        </p>
      )}

      <FiltrosLista placaTexto={placaTexto} onPlaca={(v) => setPlacaTexto(normalizarPlaca(v))} estados={estados} onEstados={setEstados}
        activos={activos} onQuitar={quitarFiltros} />

      {excedeExcel && puedeExportar && (
        <InlineAlert tono="info">
          La lista tiene {conteo(total ?? 0)} filas y el Excel admite hasta {conteo(TOPES_TORRE.FILAS_DETALLE_EXPORTAR_MAX)}. Filtre la lista para descargarla.
        </InlineAlert>
      )}
      {res?.truncado && (
        <InlineAlert tono="info">
          Se pueden recorrer las primeras {conteo(TOPES_TORRE.FILAS_DETALLE_PAGINABLE_MAX)} filas; el total cuenta todas. Filtre la lista para ver el resto.
        </InlineAlert>
      )}

      <section className="min-w-0" aria-label={`Registros: ${titulo}`} aria-busy={estado.tipo === 'cargando' || undefined} data-torre="lista">
        <CuerpoLista estado={estado} res={res} titulo={titulo} activos={activos} onQuitar={quitarFiltros}
          onReintentar={() => setIntento((n) => n + 1)}
          tabla={(r) => (
            <TablaDetalleTorre res={r} nombre={titulo} orden={orden} onOrden={setOrden} pagina={pagina} tamano={tamano}
              onPagina={setPagina} onTamano={setTamano} ocupado={estado.tipo === 'cargando'}
              onAbrir={hasFuncion(FUNCION_TORRE_PLACA) ? torre.abrirFicha : undefined} />
          )} />
      </section>
      {torre.drawer}
    </div>
  );
}

function CuerpoLista({ estado, res, titulo, activos, onQuitar, onReintentar, tabla }: {
  estado: Estado; res: ResultadoDetalle | null; titulo: string; activos: number;
  onQuitar: () => void; onReintentar: () => void; tabla: (r: ResultadoDetalle) => JSX.Element;
}) {
  if (estado.tipo === 'error') {
    const texto = estado.motivo === 'tiempo' ? 'La consulta tardó demasiado. Acote el periodo o agregue un filtro, e intente de nuevo.'
      : estado.motivo === 'permiso' ? 'No tiene permiso para ver esta lista. Pídalo a un administrador.'
        : `No pudimos cargar la lista de ${titulo.toLowerCase()}. Revise su conexión e intente de nuevo.`;
    return <div className="card"><ErrorVista texto={texto} onReintentar={estado.motivo === 'permiso' ? undefined : onReintentar} /></div>;
  }
  if (!res) return <div className="card"><EsqueletoLista /></div>;
  if (res.total === 0 && estado.tipo === 'listo') {
    return <div className="card" data-torre="vacio-lista">{activos > 0 ? (
      <Vacio icono="buscar" texto="Ningún registro de esta lista coincide con los filtros." detalle="Quítelos para volver a ver la lista completa."
        accion={<GradientButton variant="secondary" size="sm" onClick={onQuitar}>Quitar filtros</GradientButton>} />
    ) : (
      // Sin acción propia: «Volver a <área>» ya está en la cabecera (una sola acción igual por página).
      <Vacio texto={res.fraseVacio} detalle="Cuando alguno cumpla la regla, aparecerá aquí." />
    )}</div>;
  }
  return tabla(res);
}

function EsqueletoLista() {
  return (
    <div className="flex flex-col gap-2" data-torre="esqueleto-lista">
      <span className="sr-only">Cargando la lista</span>
      {Array.from({ length: 8 }, (_, i) => <div key={i} className="kit-esqueleto h-9" aria-hidden="true" />)}
    </div>
  );
}

/** «Filtrar esta lista» (§5.2): placa (solo en memoria) y estado. En teléfono se pliega con el kit. */
function FiltrosLista({ placaTexto, onPlaca, estados, onEstados, activos, onQuitar }: {
  placaTexto: string; onPlaca: (v: string) => void; estados: string[]; onEstados: (v: string[]) => void;
  activos: number; onQuitar: () => void;
}) {
  const { opciones, cargando, fallo, reintentar } = useOpcionesTorre();
  const corta = placaTexto.length > 0 && placaTexto.length < 3;
  return (
    <section aria-label="Filtrar esta lista" data-torre="filtros-lista">
      <FiltrosPlegables activos={activos}>
        <div className="flex flex-wrap items-start gap-3">
          <div className="w-full min-w-0 sm:w-56">
            <label htmlFor="torre-detalle-placa" className="mb-1.5 block text-[0.8125rem] font-semibold">Placa</label>
            <input id="torre-detalle-placa" className={flitInp} value={placaTexto} onChange={(e) => onPlaca(e.target.value)}
              placeholder="Al menos 3 caracteres" autoComplete="off" spellCheck={false} inputMode="text" maxLength={7}
              aria-describedby={corta ? 'torre-detalle-placa-ayuda' : undefined} data-torre="filtro-placa" />
            {corta && <p id="torre-detalle-placa-ayuda" className="mt-1 text-xs text-[color:var(--color-text-secondary)]">Escriba al menos 3 caracteres.</p>}
          </div>
          <div className="w-full min-w-0 sm:w-64">
            <SelectorMultipleTorre label="Estado" valor={estados} opciones={opciones.flitEstados} onCambio={onEstados}
              todas="Todos los estados" sustantivo="Ningún estado" elegidas={(n) => `${n} elegidos`}
              cargando={cargando} fallo={fallo} onReintentar={reintentar} />
          </div>
          {activos > 0 && (
            <div className="flex w-full items-end sm:w-auto sm:self-end">
              <GradientButton variant="ghost" onClick={onQuitar} data-torre="quitar-filtros">
                <Icono nombre="cerrar" size={16} />
                Quitar filtros ({activos})
              </GradientButton>
            </div>
          )}
        </div>
      </FiltrosPlegables>
    </section>
  );
}
