// FLITO — Tarifas: el configurador de valores con historial de vigencias (HU #12375, Feature #12365).
// Diseño: `docs/ux/flito-configurador-tarifas.md` (modo full).
//
// Un cliente a la vez: a la izquierda la lista con «Faltan n», a la derecha las cuatro filas del
// elegido (`MatrizTarifas`) y el historial plegado debajo (`HistorialTarifas`). Dos rutas y un solo
// componente: `/flito/tarifas` (sin cliente) y `/flito/tarifas/:companiaId`. El id de la URL es el
// de una EMPRESA, no de una persona; ningún id de usuario ni de vigencia sale a la URL.
//
// No se preselecciona el primer cliente: la matriz escribe en sitio, y enseñar de entrada el precio
// de un cliente que nadie eligió es la vía corta a cambiarle el precio a quien no era.
//
// La pantalla decide por `capacidades` del servidor y por el gate de ruta (`ProtectedRoute
// page="flito_tarifas"`); nunca por el nombre del rol.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, errorMessage } from '../lib/api';
import {
  RUTA_TARIFAS, etiquetaLlave, faltantesDe, faltantesPorCompania, normalizaTexto,
  type FilaVistaTarifa, type TarifaAbierta, type VistaTarifasCompania,
} from '../lib/tarifas';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import FlitSelect from '../components/flit/FlitSelect';
import {
  flitInp, FlitCard, FlitEmpty, FlitPillButton, FlitPillGroup, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../components/flit/flitPageKit';
import MatrizTarifas from './tarifas/MatrizTarifas';
import HistorialTarifas, { type FiltroHistorial } from './tarifas/HistorialTarifas';

/** Lo único que la lista usa de `GET /clients`: el resto de columnas no se pinta ni se guarda. */
interface ClienteLista { id: number; name: string }

const SUBTITULO = 'Lo que FLITO le cobra a cada cliente por el trámite digital y la logística, desde ahora.';
const ERROR_FALTANTES = 'No se pudo calcular qué clientes tienen valores sin configurar. La lista sí cargó.';

const faltanTexto = (n: number) => (n === 1 ? 'Falta 1' : `Faltan ${n}`);
const faltanValores = (n: number) => (n === 1 ? 'Falta 1 valor' : `Faltan ${n} valores`);

const barra = (ancho: string, key: number) => (
  <div key={key} className={`h-5 ${ancho} animate-pulse rounded`} style={{ background: 'var(--flit-bg-table-header)' }} />
);

export default function FlitoTarifas() {
  const { companiaId: param } = useParams<{ companiaId?: string }>();
  const navigate = useNavigate();
  const companiaId = param && /^\d+$/.test(param) ? Number(param) : null;

  const [clientes, setClientes] = useState<ClienteLista[] | null>(null);
  const [errorClientes, setErrorClientes] = useState<string | null>(null);
  const [faltan, setFaltan] = useState<Map<number, number> | null>(null);
  const [errorFaltantes, setErrorFaltantes] = useState<string | null>(null);

  const [busqueda, setBusqueda] = useState('');
  const [soloFaltantes, setSoloFaltantes] = useState(false);
  const lista = useRef<HTMLUListElement>(null);

  const [vista, setVista] = useState<VistaTarifasCompania | null>(null);
  const [cargandoVista, setCargandoVista] = useState(false);
  const [refrescando, setRefrescando] = useState(false);
  const [errorVista, setErrorVista] = useState<{ status: number; mensaje: string } | null>(null);
  const [anuncio, setAnuncio] = useState('');

  const [historialAbierto, setHistorialAbierto] = useState(false);
  const [filtroHistorial, setFiltroHistorial] = useState<FiltroHistorial>('todos');
  const [versionHistorial, setVersionHistorial] = useState(0);
  const tituloHistorial = useRef<HTMLElement | null>(null);

  // Lo que está en edición se guarda en un ref: solo se lee al cambiar de cliente, y ponerlo en
  // estado repintaría la lista entera con cada tecla.
  const enEdicion = useRef<FilaVistaTarifa | null>(null);
  const onEdicionCambia = useCallback((fila: FilaVistaTarifa | null) => { enEdicion.current = fila; }, []);

  const cargarFaltantes = useCallback(() => {
    setFaltan(null); setErrorFaltantes(null);
    api.get<TarifaAbierta[]>(RUTA_TARIFAS)
      .then((t) => setFaltan(faltantesPorCompania(t)))
      .catch((e) => setErrorFaltantes(errorMessage(e)));
  }, []);

  const cargarClientes = useCallback(() => {
    setClientes(null); setErrorClientes(null);
    api.get<ClienteLista[]>('/clients')
      .then((c) => setClientes([...c].map(({ id, name }) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'es'))))
      .catch((e) => setErrorClientes(errorMessage(e)));
  }, []);

  useEffect(() => { cargarClientes(); cargarFaltantes(); }, [cargarClientes, cargarFaltantes]);

  // La vista del cliente: al elegirlo y tras cada escritura (se repide entera, no se parchea).
  // Solo la ÚLTIMA petición lanzada escribe estado: cambiar de cliente dos veces seguidas —o el
  // doble montaje de StrictMode— no puede dejar en pantalla la respuesta que llegó tarde.
  const peticionVista = useRef(0);
  const cargarVista = useCallback((id: number, modo: 'inicial' | 'refresco') => {
    const mia = ++peticionVista.current;
    const vigente = () => mia === peticionVista.current;
    if (modo === 'inicial') { setVista(null); setCargandoVista(true); } else setRefrescando(true);
    setErrorVista(null);
    return api.get<VistaTarifasCompania>(`${RUTA_TARIFAS}/companias/${id}`)
      .then((v) => {
        if (!vigente()) return;
        setVista(v);
        const n = v.tarifas.filter((f) => f.valor === null).length;
        setAnuncio(`Valores de ${v.companiaNombre}.${n > 0 ? ` ${faltanValores(n)}.` : ''}`);
      })
      .catch((e) => {
        if (!vigente()) return;
        const status = e instanceof ApiError ? e.status : 0;
        setErrorVista({ status, mensaje: errorMessage(e) });
        if (modo === 'inicial') setVista(null);
      })
      .finally(() => { if (vigente()) { setCargandoVista(false); setRefrescando(false); } });
  }, []);

  useEffect(() => {
    setHistorialAbierto(false); setFiltroHistorial('todos');
    if (companiaId === null) { setVista(null); setErrorVista(null); setCargandoVista(false); return; }
    void cargarVista(companiaId, 'inicial');
  }, [companiaId, cargarVista]);

  const elegir = (id: number) => {
    if (id === companiaId) return;
    const f = enEdicion.current;
    if (f && vista && !window.confirm(`Tienes un valor sin guardar en ${etiquetaLlave(f)} de ${vista.companiaNombre}. ¿Salir y perderlo?`)) return;
    navigate(`/flito/tarifas/${id}`, { replace: true });
  };

  const tarifaGuardada = () => {
    if (companiaId === null) return;
    void cargarVista(companiaId, 'refresco');
    cargarFaltantes();
    setVersionHistorial((n) => n + 1);
  };

  const abrirHistorial = (filtro: FiltroHistorial) => {
    setFiltroHistorial(filtro);
    setHistorialAbierto(true);
    requestAnimationFrame(() => tituloHistorial.current?.focus());
  };

  const conFaltantes = useMemo(
    () => (clientes && faltan ? clientes.filter((c) => faltantesDe(faltan, c.id) > 0).length : 0),
    [clientes, faltan],
  );

  const visibles = useMemo(() => {
    if (!clientes) return [];
    const q = normalizaTexto(busqueda.trim());
    return clientes.filter((c) =>
      (!q || normalizaTexto(c.name).includes(q))
      && (!soloFaltantes || (faltan !== null && faltantesDe(faltan, c.id) > 0)));
  }, [clientes, busqueda, soloFaltantes, faltan]);

  const elegido = clientes?.find((c) => c.id === companiaId) ?? null;

  const verFaltantes = () => {
    setSoloFaltantes(true); setBusqueda('');
    requestAnimationFrame(() => lista.current?.focus());
  };

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard title="Tarifas" subtitle={SUBTITULO} />
      <p className="sr-only" role="status">{anuncio}</p>

      {errorClientes ? (
        <FlitCard className="mx-auto w-full max-w-xl text-center">
          <p role="alert" className="text-sm font-semibold" style={{ color: 'var(--flit-danger-ink)' }}>No se pudo cargar la lista de clientes.</p>
          <p className="mt-1 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{errorClientes}</p>
          <button type="button" className={`${flitBtnSecondary} mt-4`} style={flitBtnSecondaryStyle} onClick={cargarClientes}>Reintentar</button>
        </FlitCard>
      ) : clientes === null ? (
        <div role="status" aria-busy="true" aria-label="Cargando tarifas" className="grid gap-5 lg:grid-cols-[300px_1fr] lg:gap-6">
          <FlitCard className="space-y-3">{['w-3/4', 'w-1/2', 'w-2/3', 'w-3/5', 'w-1/2', 'w-2/3'].map(barra)}</FlitCard>
          <FlitCard className="space-y-3">{['w-1/3', 'w-full', 'w-full', 'w-full'].map(barra)}</FlitCard>
        </div>
      ) : clientes.length === 0 ? (
        <FlitEmpty>
          <p style={{ color: 'var(--flit-text-primary)' }}>Todavía no hay clientes.</p>
          <p className="mt-1">Crea el primero en Clientes y proveedores; cuando exista, aquí se le fijan sus valores.</p>
          <Link to="/clients" className={`${flitBtnSecondary} mt-4`} style={flitBtnSecondaryStyle}>Ir a Clientes y proveedores</Link>
        </FlitEmpty>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[300px_1fr] lg:gap-6">
          <aside className="lg:sticky lg:top-[calc(var(--flit-topbar-height)_+_var(--flit-navbar-height))] lg:self-start">
            <FlitCard className="space-y-3">
              <h2 className="text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>Clientes ({clientes.length})</h2>
              {errorFaltantes && (
                <div className="flex flex-wrap items-center gap-2">
                  <p role="alert" className="text-xs" style={{ color: 'var(--flit-danger-ink)' }}>{ERROR_FALTANTES}</p>
                  <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={cargarFaltantes}>Reintentar</button>
                </div>
              )}
              <input
                type="search" className={flitInp} value={busqueda} placeholder="Buscar cliente…" aria-label="Buscar cliente"
                onChange={(e) => setBusqueda(e.target.value)}
              />
              <FlitPillGroup label="Filtro de clientes">
                <FlitPillButton active={!soloFaltantes} pressed={!soloFaltantes} onClick={() => setSoloFaltantes(false)}>
                  Todos · {clientes.length}
                </FlitPillButton>
                {faltan !== null ? (
                  <FlitPillButton active={soloFaltantes} pressed={soloFaltantes} onClick={() => setSoloFaltantes(true)}>
                    Con faltantes · {conFaltantes}
                  </FlitPillButton>
                ) : (
                  <button type="button" disabled aria-pressed={false} className="flit-focus inline-flex items-center rounded-[999px] px-4 py-2 text-xs font-semibold disabled:opacity-50"
                    style={{ color: 'var(--flit-text-secondary)' }}>
                    Con faltantes
                  </button>
                )}
              </FlitPillGroup>

              {/* Por debajo de `lg` la lista se pliega a un selector; el faltante viaja en la etiqueta. */}
              <div className="lg:hidden">
                <FlitSelect
                  label="Cliente"
                  value={companiaId === null ? '' : String(companiaId)}
                  onChange={(v) => { if (v) elegir(Number(v)); }}
                  opciones={[
                    { valor: '', etiqueta: 'Elige un cliente…' },
                    ...visibles.map((c) => {
                      const n = faltan ? faltantesDe(faltan, c.id) : 0;
                      return { valor: String(c.id), etiqueta: n > 0 ? `${c.name} · ${faltanTexto(n).toLowerCase()}` : c.name };
                    }),
                  ]}
                />
              </div>

              <div className="hidden lg:block">
                {visibles.length === 0 ? (
                  <FlitEmpty>
                    {busqueda.trim() ? (
                      <>
                        <p style={{ color: 'var(--flit-text-primary)' }}>Ningún cliente se llama así.</p>
                        <p className="mt-1">Prueba con otra parte del nombre.</p>
                        <button type="button" className={`${flitBtnSecondary} mt-3`} style={flitBtnSecondaryStyle} onClick={() => setBusqueda('')}>Limpiar búsqueda</button>
                      </>
                    ) : (
                      <>
                        <p style={{ color: 'var(--flit-text-primary)' }}>Todos los clientes tienen sus cuatro valores fijados.</p>
                        <button type="button" className={`${flitBtnSecondary} mt-3`} style={flitBtnSecondaryStyle} onClick={() => setSoloFaltantes(false)}>Ver todos</button>
                      </>
                    )}
                  </FlitEmpty>
                ) : (
                  <ul ref={lista} tabIndex={-1} className="flit-focus max-h-[60vh] space-y-0.5 overflow-y-auto" aria-label="Clientes">
                    {visibles.map((c) => {
                      const n = faltan ? faltantesDe(faltan, c.id) : 0;
                      const actual = c.id === companiaId;
                      return (
                        <li key={c.id}>
                          <button
                            type="button"
                            aria-current={actual ? 'true' : undefined}
                            onClick={() => elegir(c.id)}
                            className="flit-focus flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm"
                            style={{
                              background: actual ? 'var(--flit-bg-table-header)' : undefined,
                              color: 'var(--flit-text-primary)', fontWeight: actual ? 600 : 400,
                            }}
                          >
                            <span className="min-w-0 truncate">{c.name}</span>
                            {n > 0 && (
                              <span className="shrink-0 text-xs font-semibold" style={{ color: 'var(--flit-warning-ink)' }}>{faltanTexto(n)}</span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </FlitCard>
          </aside>

          <section className="min-w-0 space-y-5" aria-label="Valores del cliente">
            {companiaId === null ? (
              <FlitCard>
                <p className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
                  Elige un cliente de la lista para ver y fijar sus valores.
                </p>
                {faltan !== null && (
                  <p className="mt-3 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
                    {conFaltantes > 0
                      ? `${conFaltantes === 1 ? '1 cliente tiene' : `${conFaltantes} clientes tienen`} valores sin configurar; sus trámites de esos tipos saldrán como «No configurado» en el reporte de costos y no se podrán liquidar.`
                      : `${clientes.length === 1 ? 'El único cliente tiene' : `Los ${clientes.length} clientes tienen`} sus cuatro valores fijados.`}
                  </p>
                )}
                {faltan !== null && conFaltantes > 0 && (
                  <button type="button" className={`${flitBtnSecondary} mt-4`} style={flitBtnSecondaryStyle} onClick={verFaltantes}>
                    Ver {conFaltantes === 1 ? 'el que falta' : `los ${conFaltantes}`}
                  </button>
                )}
              </FlitCard>
            ) : (
              <PanelCliente
                nombre={vista?.companiaNombre ?? elegido?.name ?? `Cliente ${companiaId}`}
                vista={vista}
                cargando={cargandoVista}
                refrescando={refrescando}
                error={errorVista}
                onReintentar={() => void cargarVista(companiaId, 'inicial')}
                onGuardado={tarifaGuardada}
                onHistorial={(fila) => abrirHistorial({ concepto: fila.concepto, tipoTramite: fila.tipoTramite })}
                onHistorialCliente={() => abrirHistorial('todos')}
                onEdicionCambia={onEdicionCambia}
              />
            )}

            {vista && vista.capacidades.verHistorial && (
              <HistorialTarifas
                companiaId={vista.companiaId}
                companiaNombre={vista.companiaNombre}
                abierto={historialAbierto}
                onToggle={() => setHistorialAbierto((a) => !a)}
                filtro={filtroHistorial}
                onFiltro={setFiltroHistorial}
                version={versionHistorial}
                tituloRef={tituloHistorial}
              />
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function PanelCliente({ nombre, vista, cargando, refrescando, error, onReintentar, onGuardado, onHistorial, onHistorialCliente, onEdicionCambia }: {
  nombre: string;
  vista: VistaTarifasCompania | null;
  cargando: boolean;
  refrescando: boolean;
  error: { status: number; mensaje: string } | null;
  onReintentar: () => void;
  onGuardado: () => void;
  onHistorial: (fila: FilaVistaTarifa) => void;
  onHistorialCliente: () => void;
  onEdicionCambia: (fila: FilaVistaTarifa | null) => void;
}) {
  const faltantes = vista ? vista.tarifas.filter((f) => f.valor === null).length : 0;
  return (
    <FlitCard>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-bold" style={{ color: 'var(--flit-text-primary)' }}>{nombre}</h2>
          {vista && faltantes > 0 && (
            <p className="text-sm font-semibold" style={{ color: 'var(--flit-warning-ink)' }}>{faltanValores(faltantes)}</p>
          )}
        </div>
        {vista && vista.capacidades.verHistorial && (
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onHistorialCliente}>Historial del cliente</button>
        )}
      </div>

      {error && !vista ? (
        error.status === 404 ? (
          <div className="space-y-3">
            <p role="alert" className="text-sm font-semibold" style={{ color: 'var(--flit-danger-ink)' }}>Ese cliente ya no existe.</p>
            <Link to="/flito/tarifas" replace className={flitBtnSecondary} style={flitBtnSecondaryStyle}>Ver la lista</Link>
          </div>
        ) : (
          <div className="space-y-3">
            <p role="alert" className="text-sm font-semibold" style={{ color: 'var(--flit-danger-ink)' }}>No se pudieron cargar los valores de {nombre}.</p>
            <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{error.mensaje}</p>
            <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onReintentar}>Reintentar</button>
          </div>
        )
      ) : cargando || !vista ? (
        <div role="status" aria-busy="true" aria-label={`Cargando los valores de ${nombre}`} className="space-y-3">
          {['w-full', 'w-full', 'w-full', 'w-full'].map(barra)}
        </div>
      ) : (
        <>
          {error && (
            <p role="alert" className="mb-3 text-sm" style={{ color: 'var(--flit-danger-ink)' }}>
              No se pudieron recargar los valores de {nombre}. {error.mensaje}{' '}
              <button type="button" className="underline" onClick={onReintentar}>Reintentar</button>
            </p>
          )}
          <MatrizTarifas
            vista={vista}
            refrescando={refrescando}
            onGuardado={onGuardado}
            onHistorial={onHistorial}
            onEdicionCambia={onEdicionCambia}
          />
        </>
      )}
    </FlitCard>
  );
}
