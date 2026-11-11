// FLITO — Tarifas › modo Proveedores (Épica #13763, ADR-0041 §6). Lo que cada proveedor le cobra a FLITO.
// Diseño: `docs/ux/flito-tarifas-proveedores.md` (slim, aprobado). Rutas: `/flito/tarifas/proveedores` y
// `/flito/tarifas/proveedores/:proveedorId` (uuid opaco; ningún nombre ni NIT en la URL).
//
// Un proveedor a la vez, sin preselección (misma razón que en Clientes). La pantalla decide por
// `capacidades` del servidor y por `proveedor.activo`; nunca por el nombre del rol. Sin rojo.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { ConceptoCostoProveedor, ResumenProveedorCostos, VistaCostosProveedor } from '@operaciones/shared-types';
import { normalizaTexto } from '../../lib/tarifas';
import { PAGINA_PROVEEDORES, esUuid, estadoError, etiquetaConcepto, tarifasProveedorApi } from '../../lib/tarifas-proveedor';
import PageHeaderCard from '../../components/flit/PageHeaderCard';
import FlitSelect from '../../components/flit/FlitSelect';
import { NOTA_INACTIVO, opcionesConEstado } from '../../components/flit/opcionesConEstado';
import {
  flitInp, FlitCard, FlitEmpty, FlitPillButton, FlitPillGroup, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../../components/flit/flitPageKit';
import CostosProveedor, { AvisoTonal } from './CostosProveedor';
import HistorialCostosProveedor, { type FiltroHistorialProveedor } from './HistorialCostosProveedor';

const SUBTITULO = 'Lo que cada proveedor le cobra a FLITO por su servicio, desde ahora.';

/** Selector Clientes · Proveedores. `antesDeSalir` devuelve `false` si el usuario no quiere perder lo que edita. */
export function SelectorModo({ modo, antesDeSalir }: { modo: 'clientes' | 'proveedores'; antesDeSalir: () => boolean }) {
  const navigate = useNavigate();
  const ir = (destino: 'clientes' | 'proveedores') => {
    if (destino === modo || !antesDeSalir()) return;
    navigate(destino === 'clientes' ? '/flito/tarifas' : PAGINA_PROVEEDORES);
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span aria-hidden="true" className="text-sm font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>Ver tarifas de</span>
      <FlitPillGroup label="Ver tarifas de">
        <FlitPillButton active={modo === 'clientes'} pressed={modo === 'clientes'} onClick={() => ir('clientes')}>Clientes</FlitPillButton>
        <FlitPillButton active={modo === 'proveedores'} pressed={modo === 'proveedores'} onClick={() => ir('proveedores')}>Proveedores</FlitPillButton>
      </FlitPillGroup>
    </div>
  );
}

const barra = (ancho: string, key: number) => (
  <div key={key} className={`h-5 ${ancho} animate-pulse rounded`} style={{ background: 'var(--flit-bg-table-header)' }} />
);

const IrAClientes = () => (
  <Link to="/clients" className={`${flitBtnSecondary} mt-4`} style={flitBtnSecondaryStyle}>Ir a Clientes y proveedores</Link>
);

export default function TarifasProveedores() {
  const { proveedorId: param } = useParams<{ proveedorId?: string }>();
  const navigate = useNavigate();
  const proveedorId = param ?? null;

  const [lista, setLista] = useState<ResumenProveedorCostos[] | null>(null);
  const [errorLista, setErrorLista] = useState(false);
  const [busqueda, setBusqueda] = useState('');

  const [vista, setVista] = useState<VistaCostosProveedor | null>(null);
  const [cargandoVista, setCargandoVista] = useState(false);
  const [refrescando, setRefrescando] = useState(false);
  const [errorVista, setErrorVista] = useState<{ status: number } | null>(null);
  const [anuncio, setAnuncio] = useState('');

  const [historialAbierto, setHistorialAbierto] = useState(false);
  const [filtro, setFiltro] = useState<FiltroHistorialProveedor>('todos');
  const [versionHistorial, setVersionHistorial] = useState(0);
  const tituloHistorial = useRef<HTMLElement | null>(null);

  const enEdicion = useRef<ConceptoCostoProveedor | null>(null);
  const onEdicionCambia = useCallback((c: ConceptoCostoProveedor | null) => { enEdicion.current = c; }, []);

  const cargarLista = useCallback(() => {
    setLista(null); setErrorLista(false);
    tarifasProveedorApi.listar()
      .then((l) => setLista([...l].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))))
      .catch(() => setErrorLista(true));
  }, []);
  useEffect(() => { cargarLista(); }, [cargarLista]);

  // Solo la ÚLTIMA petición escribe estado (cambio rápido de proveedor, doble montaje de StrictMode).
  const peticion = useRef(0);
  const cargarVista = useCallback((id: string, modo: 'inicial' | 'refresco') => {
    const mia = ++peticion.current;
    const vigente = () => mia === peticion.current;
    if (modo === 'inicial') { setVista(null); setCargandoVista(true); } else setRefrescando(true);
    setErrorVista(null);
    if (!esUuid(id)) { setErrorVista({ status: 404 }); setCargandoVista(false); setRefrescando(false); return; }
    tarifasProveedorApi.vista(id)
      .then((v) => { if (vigente()) { setVista(v); setAnuncio(`Valores de ${v.proveedor.nombre}.`); } })
      .catch((e) => {
        if (!vigente()) return;
        setErrorVista({ status: estadoError(e) });
        if (modo === 'inicial') setVista(null);
      })
      .finally(() => { if (vigente()) { setCargandoVista(false); setRefrescando(false); } });
  }, []);

  useEffect(() => {
    setHistorialAbierto(false); setFiltro('todos');
    if (proveedorId === null) { setVista(null); setErrorVista(null); setCargandoVista(false); return; }
    cargarVista(proveedorId, 'inicial');
  }, [proveedorId, cargarVista]);

  const nombreElegido = vista?.proveedor.nombre ?? lista?.find((p) => p.id === proveedorId)?.nombre ?? 'el proveedor';

  const puedeSalir = () => {
    const c = enEdicion.current;
    return !c || window.confirm(`Tienes un valor sin guardar en ${etiquetaConcepto(c)} de ${nombreElegido}. ¿Salir y perderlo?`);
  };

  const elegir = (id: string) => {
    if (id === proveedorId || !puedeSalir()) return;
    navigate(`${PAGINA_PROVEEDORES}/${id}`, { replace: true });
  };

  const guardado = () => {
    if (proveedorId === null) return;
    cargarVista(proveedorId, 'refresco');
    setVersionHistorial((n) => n + 1);
  };

  const abrirHistorial = (f: FiltroHistorialProveedor) => {
    setFiltro(f); setHistorialAbierto(true);
    requestAnimationFrame(() => tituloHistorial.current?.focus());
  };

  const visibles = useMemo(() => {
    if (!lista) return [];
    const q = normalizaTexto(busqueda.trim());
    return q ? lista.filter((p) => normalizaTexto(p.nombre).includes(q)) : lista;
  }, [lista, busqueda]);

  // El elegido inactivo no viene en la lista (solo activos): se añade arriba con «Inactivo».
  const elegidoFuera = vista && !lista?.some((p) => p.id === vista.proveedor.id)
    ? { id: vista.proveedor.id, nombre: vista.proveedor.nombre, activo: vista.proveedor.activo }
    : null;

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard title="Tarifas" subtitle={SUBTITULO} />
      <SelectorModo modo="proveedores" antesDeSalir={puedeSalir} />
      <p className="sr-only" role="status">{anuncio}</p>

      {errorLista ? (
        <FlitCard className="mx-auto w-full max-w-xl">
          <AvisoTonal tono="activo" rol="alert" icono="!"
            accion={<button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={cargarLista}>Reintentar</button>}>
            <p className="font-semibold">No se pudo cargar la lista de proveedores.</p>
            <p className="mt-0.5">Revisa tu conexión y vuelve a intentarlo.</p>
          </AvisoTonal>
        </FlitCard>
      ) : lista === null ? (
        <div role="status" aria-busy="true" aria-label="Cargando proveedores" className="grid gap-5 lg:grid-cols-[300px_1fr] lg:gap-6">
          <FlitCard className="space-y-3">{['w-3/4', 'w-1/2', 'w-2/3', 'w-3/5'].map(barra)}</FlitCard>
          <FlitCard className="space-y-3">{['w-1/3', 'w-full', 'w-full', 'w-full'].map(barra)}</FlitCard>
        </div>
      ) : lista.length === 0 && !proveedorId ? (
        <FlitEmpty>
          <p style={{ color: 'var(--flit-text-primary)' }}>No hay proveedores activos.</p>
          <p className="mt-1">Activa un proveedor en Clientes y proveedores; cuando esté activo, aquí se le fijan sus valores.</p>
          <IrAClientes />
        </FlitEmpty>
      ) : (
        <div className="grid min-w-0 gap-5 lg:grid-cols-[300px_1fr] lg:gap-6">
          <aside className="min-w-0 lg:sticky lg:top-[calc(var(--flit-topbar-height)_+_var(--flit-navbar-height))] lg:self-start">
            <FlitCard className="space-y-3">
              <h2 className="text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>Proveedores ({lista.length})</h2>
              <input type="search" className={flitInp} value={busqueda} placeholder="Buscar proveedor…" aria-label="Buscar proveedor"
                onChange={(e) => setBusqueda(e.target.value)} />

              <div className="lg:hidden">
                <FlitSelect
                  label="Proveedor"
                  value={proveedorId ?? ''}
                  onChange={(v) => { if (v) elegir(v); }}
                  opciones={opcionesConEstado(
                    [
                      ...(elegidoFuera ? [elegidoFuera] : []),
                      ...visibles.map((p) => ({ id: p.id, nombre: p.nombre, activo: true })),
                      ...(!elegidoFuera && proveedorId && !visibles.some((p) => p.id === proveedorId)
                        ? lista.filter((p) => p.id === proveedorId).map((p) => ({ id: p.id, nombre: p.nombre, activo: true }))
                        : []),
                    ],
                    proveedorId ?? '',
                    { placeholder: 'Elige un proveedor…', etiquetaAusente: nombreElegido },
                  )}
                />
              </div>

              <div className="hidden lg:block">
                {visibles.length === 0 && !elegidoFuera ? (
                  <FlitEmpty>
                    <p style={{ color: 'var(--flit-text-primary)' }}>Ningún proveedor se llama así.</p>
                    <p className="mt-1">Prueba con otra parte del nombre.</p>
                    <button type="button" className={`${flitBtnSecondary} mt-3`} style={flitBtnSecondaryStyle} onClick={() => setBusqueda('')}>Limpiar búsqueda</button>
                  </FlitEmpty>
                ) : (
                  <ul className="max-h-[60vh] space-y-0.5 overflow-y-auto" aria-label="Proveedores">
                    {[...(elegidoFuera ? [elegidoFuera] : []), ...visibles.map((p) => ({ id: p.id, nombre: p.nombre, activo: true }))].map((p) => {
                      const actual = p.id === proveedorId;
                      return (
                        <li key={p.id}>
                          <button type="button" aria-current={actual ? 'true' : undefined} onClick={() => elegir(p.id)}
                            className="flit-focus flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--flit-bg-hover)]"
                            style={{
                              background: actual ? 'var(--flit-bg-table-header)' : undefined,
                              color: p.activo ? 'var(--flit-text-primary)' : 'var(--flit-text-secondary)', fontWeight: actual ? 600 : 400,
                            }}>
                            <span className="min-w-0 truncate">{p.nombre}</span>
                            {!p.activo && <span className="shrink-0 text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>{NOTA_INACTIVO}</span>}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </FlitCard>
          </aside>

          <section className="min-w-0 space-y-5" aria-label="Valores del proveedor">
            {proveedorId === null ? (
              <FlitCard>
                <p className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
                  Elige un proveedor de la lista para ver y fijar sus valores.
                </p>
              </FlitCard>
            ) : (
              <PanelProveedor
                nombre={nombreElegido}
                vista={vista}
                cargando={cargandoVista}
                refrescando={refrescando}
                error={errorVista}
                onReintentar={() => cargarVista(proveedorId, 'inicial')}
                onGuardado={guardado}
                onHistorial={(c) => abrirHistorial(c)}
                onHistorialProveedor={() => abrirHistorial('todos')}
                onEdicionCambia={onEdicionCambia}
              />
            )}

            {vista && vista.capacidades.verHistorial && vista.filas.length > 0 && (
              <HistorialCostosProveedor
                proveedorId={vista.proveedor.id}
                proveedorNombre={vista.proveedor.nombre}
                conceptos={vista.filas.map((f) => f.concepto)}
                abierto={historialAbierto}
                onToggle={() => setHistorialAbierto((a) => !a)}
                filtro={filtro}
                onFiltro={setFiltro}
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

function PanelProveedor({ nombre, vista, cargando, refrescando, error, onReintentar, onGuardado, onHistorial, onHistorialProveedor, onEdicionCambia }: {
  nombre: string;
  vista: VistaCostosProveedor | null;
  cargando: boolean;
  refrescando: boolean;
  error: { status: number } | null;
  onReintentar: () => void;
  onGuardado: () => void;
  onHistorial: (c: ConceptoCostoProveedor) => void;
  onHistorialProveedor: () => void;
  onEdicionCambia: (c: ConceptoCostoProveedor | null) => void;
}) {
  const reintentar = (
    <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onReintentar}>Reintentar</button>
  );
  return (
    <FlitCard>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="break-words text-base font-bold" style={{ color: 'var(--flit-text-primary)' }}>{nombre}</h2>
          <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>Lo que este proveedor le cobra a FLITO. Valores en pesos, sin IVA.</p>
        </div>
        {vista && vista.capacidades.verHistorial && vista.filas.length > 0 && (
          <button type="button" className={`${flitBtnSecondary} w-full justify-center sm:w-auto`} style={flitBtnSecondaryStyle} onClick={onHistorialProveedor}>
            Historial del proveedor
          </button>
        )}
      </div>

      {error && !vista ? (
        error.status === 404 ? (
          <AvisoTonal tono="activo" rol="alert" icono="!"
            accion={<Link to={PAGINA_PROVEEDORES} replace className={flitBtnSecondary} style={flitBtnSecondaryStyle}>Ver la lista</Link>}>
            <p className="font-semibold">Ese proveedor ya no existe.</p>
          </AvisoTonal>
        ) : (
          <AvisoTonal tono="activo" rol="alert" icono="!" accion={reintentar}>
            <p className="font-semibold">No se pudieron cargar los valores de {nombre}.</p>
            <p className="mt-0.5">Vuelve a intentarlo en un momento.</p>
          </AvisoTonal>
        )
      ) : cargando || !vista ? (
        <div role="status" aria-busy="true" aria-label={`Cargando los valores de ${nombre}`} className="space-y-3">
          {['w-full', 'w-full', 'w-full'].map(barra)}
        </div>
      ) : vista.filas.length === 0 ? (
        <FlitEmpty>
          <p style={{ color: 'var(--flit-text-primary)' }}>{vista.proveedor.nombre} no tiene servicios asignados.</p>
          <p className="mt-1">Asígnale logística o SOAT en su ficha de Clientes y proveedores para fijarle valores.</p>
          <IrAClientes />
        </FlitEmpty>
      ) : (
        <div className="space-y-4">
          {error && (
            <AvisoTonal tono="activo" rol="alert" icono="!" accion={reintentar}>
              <p className="font-semibold">No se pudieron recargar los valores de {nombre}.</p>
            </AvisoTonal>
          )}
          {(!vista.proveedor.activo || vista.proveedor.eliminado) && (
            <AvisoTonal tono="neutro" rol="status" icono="i">
              <p><strong>Este proveedor está inactivo.</strong> Sus valores se pueden consultar, pero no fijar ni cambiar. Para hacerlo, actívalo en Clientes y proveedores.</p>
            </AvisoTonal>
          )}
          <CostosProveedor
            vista={vista}
            refrescando={refrescando}
            onGuardado={onGuardado}
            onHistorial={onHistorial}
            onEdicionCambia={onEdicionCambia}
          />
        </div>
      )}
    </FlitCard>
  );
}
