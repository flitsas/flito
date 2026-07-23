// FLITO — Trámites unificado (Fase 6). Porta packages/client/src/paginas/tramites/tramites.tsx al kit
// flit/ + api. Una fila por trámite: solicita SOAT/impuestos/ambos, sigue su estado y entrega en lote.
// Es la vista de quien despacha (Operaciones); Auditoría entra en solo lectura. Los gestores NO entran:
// cada uno sigue en su propia cola. Las reglas viven en el backend; aquí solo se orquesta y reporta.

import { puedeOperar } from '../lib/permissions';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ESTADO_IMPUESTO_LABEL, ESTADO_SOAT_LABEL, EstadoImpuesto, EstadoSoat,
} from '@operaciones/shared-types';
import { parseLicenciaTransito } from '@operaciones/shared-types';
import {
  ESTADO_LOGISTICA_SIMPLE_LABEL, ESTADOS_LOGISTICA_SIMPLE_ORDEN, simplificarEstadoLogistica,
  type EstadoLogisticaSimple,
} from '@operaciones/shared-types';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import FlitModal from '../components/flit/FlitModal';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import {
  FlitCard, FlitTable, FlitTh, FlitTr, FlitField, FlitEmpty,
  flitInp, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../components/flit/flitPageKit';

interface FilaSoat {
  id: string; estado: EstadoSoat; proveedorSoatNombre: string | null; valorPagado: number | null;
  enviadoEn: string | null; estancado: boolean; motivoRechazo: string | null;
}
interface FilaImpuesto {
  id: string; estado: EstadoImpuesto; tieneFacturaVenta: boolean; coincidenciaFacturaVenta: number | null;
  valorLiquidado: number | null; valorPagado: number | null; marcadoPorDiferencia: boolean;
  enviadoEn: string | null; estancado: boolean; motivoRechazo: string | null;
}
interface TramiteFila {
  tramiteId: string; idFlit: string; estado: string; asignado: boolean;
  tipoTramite: string | null; ciudad: string | null; fechaAprobacion: string | null;
  companiaNombre: string | null; empresaExiste: boolean; empresaNit: string | null;
  organismoNombre: string | null; secretariaEmparejada: boolean; transitoNombre: string | null;
  facturaVentaFlitId: string | null;
  vehiculo: { vin: string | null; placa: string | null; marca: string | null; linea: string | null; tipoVehiculo: string | null };
  compradorPrincipal: { nombreCompleto: string; numeroDocumento: string } | null;
  compradores: unknown[]; soat: FilaSoat | null; soatAutogestionado: boolean; impuesto: FilaImpuesto | null; impuestosAutogestionado: boolean;
  soatResuelto: boolean; impuestosResueltos: boolean; listoParaEntregar: boolean;
  valorSoat: number | null; valorImpuesto: number | null; sincronizadoEn: string;
  logistica: { estado: string } | null;
}
// Un trámite habilita SOAT/impuestos solo si está Asignado y con empresa + secretaría emparejadas.
const esAccionable = (f: TramiteFila) => f.asignado && f.empresaExiste && f.secretariaEmparejada;
// Listado paginado en servidor: se piden PAGE_SIZE filas por página con los filtros aplicados en SQL.
const PAGE_SIZE = 50;
interface Paginado { items: TramiteFila[]; total: number; page: number; pageSize: number }
interface Facetas { estados: string[]; tramites: string[]; ciudades: string[]; transitos: string[] }
interface Proveedor { id: string; nombre: string; activo: boolean }
interface HistorialItem { id: string; campo: string; valorAnterior: string | null; valorNuevo: string | null; origen: string; usuarioNombre: string | null; creadoEn: string }

interface ResSoat { enviados: number; yaEnviados: number; autogestionados: number; sinRegistro: number }
interface Ref { tramiteId: string; idFlit: string; placa: string | null }
interface ResImpuestos { enviados: number; yaEnviados: number; noEnviables: number }
interface ResEntrega { entregados: number; noHabilitados: Array<{ tramiteId: string; idFlit: string; placa: string; motivo: string }> }
type Resultado =
  | { tipo: 'soat'; soat: ResSoat }
  | { tipo: 'impuestos'; impuestos: ResImpuestos }
  | { tipo: 'ambos'; soat: ResSoat; impuestos: ResImpuestos }
  | { tipo: 'entrega'; entrega: ResEntrega };

// Semáforo de estados (SOAT e impuestos): pendiente naranja, solicitado azul, con novedad rojo,
// pagado verde. La autogestión (sin registro) se pinta aparte en gris.
const TONO_SOAT: Record<EstadoSoat, ChipTone> = { pendiente: 'warning', solicitado: 'active', con_novedad: 'danger', pagado: 'success' };
const TONO_IMP: Record<EstadoImpuesto, ChipTone> = { pendiente: 'warning', solicitado: 'active', con_novedad: 'danger', pagado: 'success' };

// Derecho de trámite: mismo valor fijo que el reporte de costos de Finanzas (COSTOS_FIJOS.derechoTramite).
const DERECHO_TRAMITE = 75000;
const pesos = (v: number | null) => v === null ? null
  : new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(v);
const fecha = (iso: string | null) => iso ? new Date(iso).toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';
const fechaHora = (iso: string | null) => iso
  ? new Date(iso).toLocaleString('es-CO', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  : null;

function useDebounce<T>(valor: T, ms: number): T {
  const [dif, setDif] = useState(valor);
  useEffect(() => { const t = setTimeout(() => setDif(valor), ms); return () => clearTimeout(t); }, [valor, ms]);
  return dif;
}

export default function FlitoTramites() {
  const { user } = useAuth();
  const esOperaciones = puedeOperar(user?.role);

  const [texto, setTexto] = useState('');
  const buscar = useDebounce(texto, 300);
  const [soatSel, setSoatSel] = useState<EstadoSoat[]>([]);
  const [impSel, setImpSel] = useState<EstadoImpuesto[]>([]);
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set());
  const [data, setData] = useState<TramiteFila[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [facetas, setFacetas] = useState<Facetas>({ estados: [], tramites: [], ciudades: [], transitos: [] });
  const [error, setError] = useState<string | null>(null);
  const [proveedores, setProveedores] = useState<Proveedor[]>([]);
  const [dialogo, setDialogo] = useState<null | 'soat' | 'ambos'>(null);
  // Solicitud de SOAT por fila (desde la columna SOAT): apunta a un único trámite en vez de la selección.
  const [filaSolicitud, setFilaSolicitud] = useState<string | null>(null);
  const [resultado, setResultado] = useState<Resultado | null>(null);
  const [enProceso, setEnProceso] = useState(false);
  const [recarga, setRecarga] = useState(0);

  // Sincronización: por defecto es INCREMENTAL (el backend arranca desde la última fecha sincronizada).
  // La fecha inicial solo se elige a mano si no hay sync previo (primera vez) o si se activa el switch.
  const hace30 = () => { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10); };
  const [fechaInicial, setFechaInicial] = useState(hace30);
  const [ultimaSync, setUltimaSync] = useState<string | null>(null);
  const [fechaManual, setFechaManual] = useState(false); // switch para revelar/usar el campo de fecha
  const [sincronizando, setSincronizando] = useState(false);
  const [resumenSync, setResumenSync] = useState<string | null>(null);
  // Sin sync previo (primera vez) → hay que elegir fecha. Con sync previo → oculto salvo switch.
  const primeraVez = ultimaSync === null;
  const mostrarCampoFecha = primeraVez || fechaManual;

  // Historial del trámite (modal).
  const [historial, setHistorial] = useState<{ idFlit: string; items: HistorialItem[] } | null>(null);
  // Crear empresa (cliente) desde un trámite con empresa inexistente (NIT precargado).
  const [crearEmpresa, setCrearEmpresa] = useState<TramiteFila | null>(null);
  // Crear trámite DEMO (pruebas de Logística).
  const [crearDemo, setCrearDemo] = useState(false);
  // Visor de factura de venta (modal): blob url + nombre para descargar.
  const [factura, setFactura] = useState<{ url: string; nombre: string } | null>(null);

  // Filtros (se aplican EN EL SERVIDOR). Los de texto se debouncean para no disparar un fetch por tecla.
  const [estadosSel, setEstadosSel] = useState<string[]>([]);
  const [ciudadesSel, setCiudadesSel] = useState<string[]>([]);
  const [transitosSel, setTransitosSel] = useState<string[]>([]);
  const [empresasSel, setEmpresasSel] = useState<string[]>([]); // NITs de clientes FLITO
  const [empresasOpc, setEmpresasOpc] = useState<{ nit: string; nombre: string }[]>([]);
  // Filtro rápido de autogestión de la empresa: '' = todas · 'si' = autogestionadas · 'no' = no autogestionadas.
  const [autogestionSel, setAutogestionSel] = useState<'' | 'si' | 'no'>('');
  // Todos los filtros son multiselect; se serializan a una key para las dependencias de los efectos.
  const soatKey = soatSel.join(','); const impKey = impSel.join(','); const empresasKey = empresasSel.join(',');
  const estadosKey = estadosSel.join(','); const ciudadesKey = ciudadesSel.join(','); const transitosKey = transitosSel.join(',');

  // Cualquier cambio de filtro/búsqueda vuelve a la página 1 (evita quedar en una página vacía).
  useEffect(() => { setPage(1); }, [buscar, estadosKey, ciudadesKey, transitosKey, empresasKey, soatKey, impKey, autogestionSel]);

  // Carga la página actual desde el servidor con todos los filtros aplicados en SQL.
  useEffect(() => {
    setError(null); setSeleccion(new Set());
    const q = new URLSearchParams();
    if (buscar.trim()) q.set('buscar', buscar.trim());
    if (estadosSel.length) q.set('estados', estadosSel.join(','));
    if (transitosSel.length) q.set('transitos', transitosSel.join(','));
    if (ciudadesSel.length) q.set('ciudades', ciudadesSel.join(','));
    if (empresasSel.length) q.set('empresas', empresasSel.join(','));
    if (soatSel.length) q.set('soat', soatSel.join(','));
    if (impSel.length) q.set('impuesto', impSel.join(','));
    if (autogestionSel) q.set('autogestion', autogestionSel);
    q.set('page', String(page)); q.set('pageSize', String(PAGE_SIZE));
    api.get<Paginado>(`/flito/tramites?${q}`)
      .then((r) => { setData(r.items); setTotal(r.total); })
      .catch((e) => setError(errorMessage(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buscar, estadosKey, transitosKey, ciudadesKey, empresasKey, soatKey, impKey, autogestionSel, page, recarga]);

  // Facetas (opciones de los dropdowns) + clientes FLITO (para el multiselect de empresa gestora).
  useEffect(() => {
    api.get<Facetas>('/flito/tramites/facetas').then(setFacetas).catch(() => { /* dropdowns quedan vacíos */ });
    api.get<{ nit: string; nombre: string }[]>('/flito/parametrizacion/companias')
      .then((cs) => setEmpresasOpc(cs.map((c) => ({ nit: c.nit, nombre: c.nombre })).sort((a, b) => a.nombre.localeCompare(b.nombre))))
      .catch(() => setEmpresasOpc([]));
  }, [recarga]);

  useEffect(() => {
    if (!esOperaciones) return;
    api.get<Proveedor[]>('/flito/parametrizacion/proveedores-soat').then(setProveedores).catch(() => setProveedores([]));
    api.get<{ ultimaSincronizacion: string | null }>('/flito/sync/estado')
      .then((e) => setUltimaSync(e.ultimaSincronizacion)).catch(() => setUltimaSync(null));
  }, [esOperaciones, recarga]);

  const filas = data ?? [];
  const totalPaginas = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const refrescar = () => setRecarga((n) => n + 1);
  const ids = () => [...seleccion];
  const limpiar = () => setSeleccion(new Set());
  const n = seleccion.size;
  const hayFiltros = soatSel.length > 0 || impSel.length > 0 || empresasSel.length > 0 || estadosSel.length > 0 || ciudadesSel.length > 0 || transitosSel.length > 0 || autogestionSel !== '';
  const accionables = useMemo(() => filas.filter(esAccionable), [filas]);

  const ejecutar = async (fn: () => Promise<Resultado>) => {
    setEnProceso(true); setError(null);
    try { setResultado(await fn()); limpiar(); refrescar(); }
    catch (e) { setError(errorMessage(e)); }
    finally { setEnProceso(false); }
  };

  const solicitarImpuestosLote = (tramiteIds: string[]) => ejecutar(async () => ({ tipo: 'impuestos', impuestos: await api.post<ResImpuestos>('/flito/tramites/solicitar-impuestos', { tramiteIds }) }));
  const solicitarImpuestos = () => solicitarImpuestosLote(ids());
  const entregar = (tramiteIds: string[]) => ejecutar(async () => ({ tipo: 'entrega', entrega: await api.post<ResEntrega>('/flito/tramites/entregar', { tramiteIds }) }));

  // Ver la factura de venta de FLIT: el endpoint (auth) redirige a la URL S3 prefirmada; se descarga el
  // blob y se muestra en un visor (modal) desde el que también se puede descargar.
  const verFactura = async (impuestoId: string) => {
    setError(null);
    try {
      const blob = await api.get<Blob>(`/flito/impuestos/${impuestoId}/factura-venta`);
      setFactura({ url: URL.createObjectURL(blob), nombre: `factura-venta-${impuestoId}.pdf` });
    } catch (e) { setError(errorMessage(e)); }
  };
  const cerrarFactura = () => { if (factura) URL.revokeObjectURL(factura.url); setFactura(null); };

  const descargarZip = async () => {
    const impuestoIds = filas.filter((f) => seleccion.has(f.tramiteId) && f.impuesto && f.facturaVentaFlitId).map((f) => f.impuesto!.id);
    if (impuestoIds.length === 0) { setError('Ninguno de los seleccionados tiene factura de venta en FLIT.'); return; }
    setError(null);
    try { await api.downloadPost('/flito/impuestos/facturas-venta/zip', 'facturas-venta.zip', { ids: impuestoIds }); }
    catch (e) { setError(errorMessage(e)); }
  };

  const verHistorial = async (f: TramiteFila) => {
    setError(null);
    try {
      const items = await api.get<HistorialItem[]>(`/flito/tramites/${f.tramiteId}/historial`);
      setHistorial({ idFlit: f.idFlit, items });
    } catch (e) { setError(errorMessage(e)); }
  };

  const sincronizar = async () => {
    setSincronizando(true); setError(null); setResumenSync(null);
    try {
      // Manual (o primera vez) → manda la fecha elegida; si no, sync incremental (el backend usa la última).
      const cuerpo = mostrarCampoFecha ? { initialDate: fechaInicial } : {};
      const r = await api.post<Record<string, number> & { ultimaSincronizacion?: string }>('/flito/sync/sincronizar', cuerpo);
      setResumenSync(
        `${r.tramitesLeidos ?? 0} traídos de FLIT · ${r.tramitesNuevos ?? 0} nuevos · `
        + `${r.tramitesActualizados ?? 0} con cambios · ${r.tramitesSinCambios ?? 0} sin cambios · `
        + `${r.companiasFaltantes ?? 0} sin empresa · ${r.organismosSinEmparejar ?? 0} sin secretaría`,
      );
      if (r.ultimaSincronizacion) setUltimaSync(r.ultimaSincronizacion);
      setFechaManual(false); // tras sincronizar, vuelve a modo incremental
      refrescar();
    } catch (e) { setError(errorMessage(e)); }
    finally { setSincronizando(false); }
  };

  const hayTramitesSistema = facetas.estados.length > 0 || total > 0;

  return (
    <div className="space-y-4">
      <PageHeaderCard title="Gestión Trámites"
        subtitle="Centro de gestión de los trámites de FLIT: sincroniza y consulta su estado, y solicita SOAT e impuestos. Solo los trámites Asignados —con empresa y secretaría emparejadas— habilitan esas gestiones."
        actions={
          <div className="flex flex-wrap items-center gap-3">
            {esOperaciones && (
              <div className="flex flex-wrap items-center gap-3">
                <div className="text-right text-[11px] leading-tight" style={{ color: 'var(--flit-text-muted)' }}>
                  <div>Última actualización</div>
                  <div className="font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>{fechaHora(ultimaSync) ?? 'Nunca sincronizado'}</div>
                </div>
                {/* Campo de fecha: oculto por defecto; visible la primera vez o al activar "Elegir fecha". */}
                {!primeraVez && (
                  <label className="flex items-center gap-1.5 text-[11px] cursor-pointer" style={{ color: 'var(--flit-text-muted)' }}>
                    <input type="checkbox" checked={fechaManual} onChange={(e) => setFechaManual(e.target.checked)} />
                    Elegir fecha
                  </label>
                )}
                {mostrarCampoFecha && (
                  <label className="flex items-center gap-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
                    Desde
                    <input type="date" className={`${flitInp} h-10`} value={fechaInicial} max={new Date().toISOString().slice(0, 10)}
                      onChange={(e) => setFechaInicial(e.target.value)} />
                  </label>
                )}
                <button className={flitBtnPrimary} style={flitBtnPrimaryStyle}
                  disabled={sincronizando || (mostrarCampoFecha && !fechaInicial)}
                  title={mostrarCampoFecha ? 'Sincroniza desde la fecha elegida' : 'Sincroniza desde la última actualización'}
                  onClick={sincronizar}>
                  {sincronizando ? 'Sincronizando…' : 'Sincronizar FLIT'}
                </button>
                <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} title="Crea un trámite aprobado de prueba para Logística"
                  onClick={() => setCrearDemo(true)}>+ Trámite demo</button>
              </div>
            )}
          </div>
        } />

      {resumenSync && <FlitCard><p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}><strong style={{ color: 'var(--flit-blue-text)' }}>Sincronización:</strong> {resumenSync}</p></FlitCard>}

      {error && <FlitCard><p className="text-sm text-red-600">{error}</p></FlitCard>}

      {esOperaciones && n > 0 && (
        <FlitCard>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold" style={{ color: 'var(--flit-blue-text)' }}>{n} seleccionado(s)</span>
            <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} disabled={enProceso} onClick={() => setDialogo('soat')}>Solicitar SOAT</button>
            <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} disabled={enProceso} onClick={solicitarImpuestos}>Solicitar Impuestos</button>
            <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} disabled={enProceso} onClick={() => setDialogo('ambos')}>Solicitar ambos</button>
            <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={enProceso} onClick={() => entregar(ids())}>Entregar</button>
            <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={descargarZip}>Descargar facturas (zip)</button>
            <button className="text-xs font-semibold" style={{ color: 'var(--flit-text-muted)' }} onClick={limpiar}>Limpiar</button>
          </div>
        </FlitCard>
      )}

      {data !== null && !hayTramitesSistema && !hayFiltros && !buscar.trim() && (
        <FlitCard>
          <FlitEmpty>No hay trámites. Sincroniza desde FLIT para traer trámites.</FlitEmpty>
        </FlitCard>
      )}

      {data !== null && (hayTramitesSistema || hayFiltros || !!buscar.trim()) && (
        <FlitCard>
          {/* Barra superior: búsqueda global + total + paginación. Los filtros por columna viven en
              el encabezado de la tabla (abajo). */}
          <div className="mb-3 flex flex-wrap items-center gap-3 border-b pb-3" style={{ borderColor: 'var(--flit-border)' }}>
            <input className={`${flitInp} h-9 min-w-[18rem]`} placeholder="Buscar placa, VIN, id o comprador…"
              value={texto} onChange={(e) => setTexto(e.target.value)} />
            {/* Filtro rápido por autogestión de la empresa (SOAT e impuestos autogestionados). */}
            <div className="flex items-center gap-1" role="group" aria-label="Filtrar por autogestión">
              {([['', 'Todas'], ['si', 'Autogestionadas'], ['no', 'No autogestionadas']] as const).map(([val, label]) => {
                const activa = autogestionSel === val;
                return (
                  <button key={val || 'todas'} type="button" onClick={() => setAutogestionSel(val)}
                    className="h-9 rounded-lg border px-3 text-xs font-semibold transition-colors"
                    style={activa
                      ? { background: 'var(--flit-blue-text)', color: '#fff', borderColor: 'var(--flit-blue-text)' }
                      : { background: 'transparent', color: 'var(--flit-text-secondary)', borderColor: 'var(--flit-border-input)' }}>
                    {label}
                  </button>
                );
              })}
            </div>
            <span className="text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>{total.toLocaleString('es-CO')} trámite(s)</span>
            {total > PAGE_SIZE && (
              <div className="flex items-center gap-2 text-xs">
                <button className={paginaBtn} style={paginaBtnStyle} disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>‹ Anterior</button>
                <span className="font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>Página {page} de {totalPaginas}</span>
                <button className={paginaBtn} style={paginaBtnStyle} disabled={page >= totalPaginas} onClick={() => setPage((p) => Math.min(totalPaginas, p + 1))}>Siguiente ›</button>
              </div>
            )}
            {hayFiltros && (
              <button className="ml-auto text-xs font-semibold" style={{ color: 'var(--flit-blue-text)' }}
                onClick={() => { setSoatSel([]); setImpSel([]); setEmpresasSel([]); setEstadosSel([]); setTransitosSel([]); setCiudadesSel([]); setAutogestionSel(''); }}>Limpiar filtros</button>
            )}
          </div>
          {filas.length === 0 ? (
            <FlitEmpty>Ningún trámite coincide con el filtro.</FlitEmpty>
          ) : (
          <FlitTable>
            <thead>
              <FlitTr>
                {esOperaciones && (
                  <FlitTh>
                    <input type="checkbox" aria-label="Seleccionar accionables"
                      checked={accionables.length > 0 && accionables.every((f) => seleccion.has(f.tramiteId))}
                      onChange={(e) => setSeleccion(e.target.checked ? new Set(accionables.map((f) => f.tramiteId)) : new Set())} />
                  </FlitTh>
                )}
                <FlitTh>
                  Trámite
                  <ThFiltroMulti seleccion={estadosSel} onCambio={setEstadosSel} opciones={aOpc(facetas.estados)} placeholder="Todos los estados" />
                </FlitTh>
                <FlitTh>Vehículo</FlitTh>
                <FlitTh>Comprador</FlitTh>
                <FlitTh>
                  Empresa gestora
                  <ThFiltroMulti seleccion={empresasSel} onCambio={setEmpresasSel}
                    opciones={empresasOpc.map((e) => ({ value: e.nit, label: e.nombre }))} placeholder="Todas" />
                </FlitTh>
                <FlitTh>
                  Tránsito
                  <ThFiltroMulti seleccion={transitosSel} onCambio={setTransitosSel} opciones={aOpc(facetas.transitos)} placeholder="Todos" />
                </FlitTh>
                <FlitTh>
                  Ciudad
                  <ThFiltroMulti seleccion={ciudadesSel} onCambio={setCiudadesSel} opciones={aOpc(facetas.ciudades)} placeholder="Todas" />
                </FlitTh>
                <FlitTh>
                  SOAT
                  <ThFiltroMulti seleccion={soatSel} onCambio={(v) => setSoatSel(v as EstadoSoat[])} opciones={SOAT_OPC} placeholder="Todos" />
                </FlitTh>
                <FlitTh>
                  Impuestos
                  <ThFiltroMulti seleccion={impSel} onCambio={(v) => setImpSel(v as EstadoImpuesto[])} opciones={IMP_OPC} placeholder="Todos" />
                </FlitTh>
                <FlitTh>Logística</FlitTh>
                <FlitTh>Derechos de trámite</FlitTh>
              </FlitTr>
            </thead>
            <tbody>
              {filas.map((f) => (
                <FlitTr key={f.tramiteId}>
                  {esOperaciones && (
                    <td className="px-3 py-2">
                      <input type="checkbox" aria-label={`Seleccionar ${f.vehiculo.placa}`}
                        disabled={!esAccionable(f)} title={esAccionable(f) ? undefined : 'Solo Asignado con empresa y secretaría emparejadas'}
                        checked={seleccion.has(f.tramiteId)}
                        onChange={() => setSeleccion((s) => { const x = new Set(s); x.has(f.tramiteId) ? x.delete(f.tramiteId) : x.add(f.tramiteId); return x; })} />
                    </td>
                  )}
                  <td className="px-3 py-2 align-top">
                    <div className="text-xs tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>{f.idFlit}</div>
                    {f.tipoTramite && <div className="text-[11px]" style={{ color: 'var(--flit-text-secondary)' }}>{f.tipoTramite}</div>}
                    {/* Estado del trámite: al hacer click abre el historial (cursor pointer + hover). */}
                    <button type="button" onClick={() => verHistorial(f)} title="Ver historial del trámite"
                      className="mt-1 block cursor-pointer rounded transition-opacity hover:opacity-70">
                      <StatusChip tone={f.asignado ? 'active' : 'neutral'}>{f.estado}</StatusChip>
                    </button>
                    {f.listoParaEntregar && <div className="mt-1"><StatusChip tone="success">Listo para entregar</StatusChip></div>}
                  </td>
                  <td className="px-3 py-2 align-top">
                    <div className="font-medium">{f.vehiculo.placa ?? '—'}</div>
                    <div className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>{f.vehiculo.marca} {f.vehiculo.linea}{f.vehiculo.tipoVehiculo ? ` · ${f.vehiculo.tipoVehiculo}` : ''}</div>
                    <div className="text-[11px] tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>{f.vehiculo.vin}</div>
                    <div className="mt-1"><CeldaFacturaVenta fila={f} onVer={verFactura} /></div>
                  </td>
                  <td className="px-3 py-2 text-sm">
                    {f.compradorPrincipal ? (
                      <>
                        <div>{f.compradorPrincipal.nombreCompleto}</div>
                        <div className="text-[11px] tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>{f.compradorPrincipal.numeroDocumento}</div>
                        {f.compradores.length > 1 && <span className="text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>{f.compradores.length} propietarios</span>}
                      </>
                    ) : '—'}
                  </td>
                  {/* Empresa gestora (CompaniaGestora de FLIT ↔ cliente FLITO): nombre arriba, NIT abajo. */}
                  <td className="px-3 py-2 text-sm align-top">
                    {f.empresaExiste ? (
                      <>
                        <div>{f.companiaNombre}</div>
                        {f.empresaNit && <div className="text-[11px] tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>NIT {f.empresaNit}</div>}
                      </>
                    ) : (
                      <>
                        <div className="text-[11px] tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>{f.empresaNit ? `NIT ${f.empresaNit}` : '—'}</div>
                        <div className="mt-1"><StatusChip tone="danger">Empresa no existe</StatusChip></div>
                        {esOperaciones && f.empresaNit && (
                          <button className="mt-1 block text-[11px] font-semibold underline" style={{ color: 'var(--flit-blue-text)' }}
                            onClick={() => setCrearEmpresa(f)}>Crear empresa</button>
                        )}
                      </>
                    )}
                  </td>
                  {/* Tránsito (secretaría emparejada por ciudad→DIVIPOLA). */}
                  <td className="px-3 py-2 text-sm align-top">
                    <div>{f.organismoNombre ?? '—'}</div>
                    {!f.secretariaEmparejada && <div className="mt-1"><StatusChip tone="warning">Secretaría sin emparejar</StatusChip></div>}
                  </td>
                  <td className="px-3 py-2 text-xs align-top">{f.ciudad ?? '—'}</td>
                  <td className="px-3 py-2 align-top"><CeldaSoat fila={f} onSolicitar={esOperaciones ? () => { setFilaSolicitud(f.tramiteId); setDialogo('soat'); } : undefined} /></td>
                  <td className="px-3 py-2 align-top"><CeldaImpuesto fila={f} onSolicitar={esOperaciones ? () => solicitarImpuestosLote([f.tramiteId]) : undefined} /></td>
                  <td className="px-3 py-2 align-top"><TrackingLogistica estado={f.logistica?.estado ?? null} /></td>
                  <td className="px-3 py-2 text-sm align-top tabular-nums whitespace-nowrap">{pesos(DERECHO_TRAMITE)}</td>
                </FlitTr>
              ))}
            </tbody>
          </FlitTable>
          )}
        </FlitCard>
      )}

      {dialogo && (
        <DialogoProveedor tipo={dialogo} n={filaSolicitud ? 1 : n} proveedores={proveedores} enProceso={enProceso}
          onCancelar={() => { setDialogo(null); setFilaSolicitud(null); }}
          onConfirmar={(proveedorSoatId) => {
            const tramiteIds = filaSolicitud ? [filaSolicitud] : ids();
            setDialogo(null); setFilaSolicitud(null);
            ejecutar(async () => {
              if (dialogo === 'soat') return { tipo: 'soat', soat: await api.post<ResSoat>('/flito/tramites/solicitar-soat', { tramiteIds, proveedorSoatId }) };
              const r = await api.post<{ soat: ResSoat; impuestos: ResImpuestos }>('/flito/tramites/solicitar-ambos', { tramiteIds, proveedorSoatId });
              return { tipo: 'ambos', soat: r.soat, impuestos: r.impuestos };
            });
          }} />
      )}

      {resultado && <ModalResultado resultado={resultado} onCerrar={() => setResultado(null)} />}
      {historial && <ModalHistorial idFlit={historial.idFlit} items={historial.items} onCerrar={() => setHistorial(null)} />}
      {factura && <ModalFactura url={factura.url} nombre={factura.nombre} onCerrar={cerrarFactura} />}

      {crearEmpresa && (
        <ModalCrearEmpresa fila={crearEmpresa}
          onCerrar={() => setCrearEmpresa(null)}
          onCreado={() => { setCrearEmpresa(null); setRecarga((n) => n + 1); }} />
      )}

      {crearDemo && (
        <ModalCrearTramiteDemo onCerrar={() => setCrearDemo(false)}
          onCreado={() => { setCrearDemo(false); setRecarga((n) => n + 1); }} />
      )}
    </div>
  );
}

// Crea un trámite DEMO aprobado para probar Logística. Se puede pegar el código de la LT para prellenar
// placa/VIN/propietario; empresa y organismo se eligen de las parametrizadas (empresa NO autogestionada).
function ModalCrearTramiteDemo({ onCerrar, onCreado }: { onCerrar: () => void; onCreado: () => void }) {
  const [empresas, setEmpresas] = useState<{ id: number; nombre: string }[]>([]);
  const [organismos, setOrganismos] = useState<{ codigo: string; nombre: string }[]>([]);
  const [codigoLt, setCodigoLt] = useState('');
  const [placa, setPlaca] = useState('');
  const [vin, setVin] = useState('');
  const [propietario, setPropietario] = useState('');
  const [propietarioDoc, setPropietarioDoc] = useState('');
  const [marca, setMarca] = useState('');
  const [linea, setLinea] = useState('');
  const [modelo, setModelo] = useState('');
  const [companiaId, setCompaniaId] = useState('');
  const [organismoCodigo, setOrganismoCodigo] = useState('');
  const [transitoNombre, setTransitoNombre] = useState('');
  const [flitEstado, setFlitEstado] = useState('Aprobado');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ id: number; nombre: string; logisticaAutogestionable: boolean }[]>('/flito/parametrizacion/companias')
      .then((cs) => setEmpresas(cs.filter((c) => !c.logisticaAutogestionable).map((c) => ({ id: c.id, nombre: c.nombre })))).catch(() => {});
    api.get<{ codigo: string; nombre: string; activo: boolean }[]>('/flito/parametrizacion/organismos')
      .then((os) => setOrganismos(os.filter((o) => o.activo).map((o) => ({ codigo: o.codigo, nombre: o.nombre })))).catch(() => {});
  }, []);

  // Al pegar el código de la LT, prellena placa/VIN/propietario/documento.
  const onCodigo = (v: string) => {
    setCodigoLt(v);
    const p = v.trim() ? parseLicenciaTransito(v.trim()) : null;
    if (p) {
      setPlaca(p.placa); setVin(p.vin);
      if (p.propietarioNombre) setPropietario(p.propietarioNombre);
      if (p.propietarioDocumento) setPropietarioDoc(p.propietarioDocumento);
    }
  };

  const valido = placa.trim().length >= 4 && vin.trim().length === 17 && propietario.trim().length >= 2 && companiaId && organismoCodigo;

  const crear = async () => {
    setBusy(true); setError(null);
    try {
      await api.post('/flito/tramites/demo', {
        placa: placa.trim(), vin: vin.trim(), propietarioNombre: propietario.trim(),
        propietarioDocumento: propietarioDoc.trim() || undefined,
        marca: marca.trim() || undefined, linea: linea.trim() || undefined,
        modelo: modelo.trim() ? Number(modelo.trim()) : undefined,
        companiaId: Number(companiaId), organismoCodigo,
        transitoNombre: transitoNombre.trim() || undefined,
        flitEstado,
      });
      onCreado();
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };

  return (
    <FlitModal title="Crear trámite demo (Logística)" onClose={onCerrar} wide>
      <p className="mb-3 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
        Crea un trámite <strong>Aprobado</strong> de prueba para escanear su LT en Logística. Pega el código de la LT para prellenar, o llena a mano.
      </p>
      <FlitField label="Contenido del código de la LT (opcional, para prellenar)">
        <textarea className={flitInp} rows={2} placeholder="10038156339 C.C. … QOX858 LRWY… ELECTRICO" value={codigoLt} onChange={(e) => onCodigo(e.target.value)} />
      </FlitField>
      <div className="mt-3">
        <FlitField label="Estado del trámite *">
          <select className={flitInp} value={flitEstado} onChange={(e) => setFlitEstado(e.target.value)}>
            <option value="Aprobado">Aprobado — habilita Logística</option>
            <option value="Asignado">Asignado — habilita SOAT / Impuestos</option>
            <option value="Borrador">Borrador</option>
            <option value="Enviado a OT">Enviado a OT</option>
            <option value="Entregado">Entregado</option>
            <option value="Anulado">Anulado</option>
            <option value="Rechazado">Rechazado</option>
          </select>
        </FlitField>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <FlitField label="Placa *"><input className={flitInp} value={placa} onChange={(e) => setPlaca(e.target.value)} /></FlitField>
        <FlitField label="VIN * (17)"><input className={flitInp} value={vin} onChange={(e) => setVin(e.target.value)} /></FlitField>
        <FlitField label="Propietario *"><input className={flitInp} value={propietario} onChange={(e) => setPropietario(e.target.value)} /></FlitField>
        <FlitField label="Documento propietario"><input className={flitInp} value={propietarioDoc} onChange={(e) => setPropietarioDoc(e.target.value)} /></FlitField>
        <FlitField label="Marca"><input className={flitInp} value={marca} onChange={(e) => setMarca(e.target.value)} placeholder="TESLA" /></FlitField>
        <FlitField label="Línea"><input className={flitInp} value={linea} onChange={(e) => setLinea(e.target.value)} placeholder="MODELO Y" /></FlitField>
        <FlitField label="Modelo (año)"><input className={flitInp} inputMode="numeric" value={modelo} onChange={(e) => setModelo(e.target.value)} placeholder="2026" /></FlitField>
        <FlitField label="Empresa gestora *">
          <select className={flitInp} value={companiaId} onChange={(e) => setCompaniaId(e.target.value)}>
            <option value="">Selecciona…</option>
            {empresas.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
          </select>
        </FlitField>
        <FlitField label="Organismo (tránsito) *">
          <select className={flitInp} value={organismoCodigo} onChange={(e) => { setOrganismoCodigo(e.target.value); setTransitoNombre(organismos.find((o) => o.codigo === e.target.value)?.nombre ?? ''); }}>
            <option value="">Selecciona…</option>
            {organismos.map((o) => <option key={o.codigo} value={o.codigo}>{o.nombre}</option>)}
          </select>
        </FlitField>
      </div>
      {error && <p className="mt-3 text-sm" style={{ color: 'var(--flit-danger)' }}>{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onCerrar}>Cancelar</button>
        <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={busy || !valido} onClick={crear}>
          {busy ? 'Creando…' : 'Crear trámite'}
        </button>
      </div>
    </FlitModal>
  );
}

function ModalHistorial({ idFlit, items, onCerrar }: { idFlit: string; items: HistorialItem[]; onCerrar: () => void }) {
  const fh = (iso: string) => new Date(iso).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' });
  return (
    <FlitModal title={`Historial · ${idFlit}`} onClose={onCerrar} wide>
      {items.length === 0 ? (
        <FlitEmpty>Sin cambios registrados todavía.</FlitEmpty>
      ) : (
        <div className="max-h-[60vh] overflow-y-auto">
          <FlitTable>
            <thead>
              <FlitTr><FlitTh>Fecha</FlitTh><FlitTh>Campo</FlitTh><FlitTh>Antes</FlitTh><FlitTh>Después</FlitTh><FlitTh>Origen</FlitTh><FlitTh>Usuario</FlitTh></FlitTr>
            </thead>
            <tbody>
              {items.map((h) => (
                <FlitTr key={h.id}>
                  <td className="whitespace-nowrap px-3 py-1.5 text-xs" style={{ color: 'var(--flit-text-muted)' }}>{fh(h.creadoEn)}</td>
                  <td className="px-3 py-1.5 text-sm font-medium">{h.campo}</td>
                  <td className="px-3 py-1.5 text-xs" style={{ color: 'var(--flit-text-muted)' }}>{h.valorAnterior ?? '—'}</td>
                  <td className="px-3 py-1.5 text-xs font-semibold">{h.valorNuevo ?? '—'}</td>
                  <td className="px-3 py-1.5"><StatusChip tone={h.origen === 'api' ? 'neutral' : 'active'}>{h.origen === 'api' ? 'FLIT' : 'usuario'}</StatusChip></td>
                  <td className="px-3 py-1.5 text-xs">{h.usuarioNombre ?? '—'}</td>
                </FlitTr>
              ))}
            </tbody>
          </FlitTable>
        </div>
      )}
      <button className={`${flitBtnPrimary} mt-3`} style={flitBtnPrimaryStyle} onClick={onCerrar}>Cerrar</button>
    </FlitModal>
  );
}

// Crear la empresa (cliente) de un trámite cuya compañía FLIT no existe. El NIT viene precargado del
// trámite; al crearla el backend re-vincula los trámites de ese NIT (los deja accionables sin re-sync).
// Visor de la factura de venta: muestra el documento (PDF/imagen) embebido y permite descargarlo.
function ModalFactura({ url, nombre, onCerrar }: { url: string; nombre: string; onCerrar: () => void }) {
  return (
    <FlitModal title="Factura de venta" onClose={onCerrar}>
      <div className="space-y-3">
        <iframe src={url} title="Factura de venta" className="h-[70vh] w-full rounded border" style={{ borderColor: 'var(--flit-border)' }} />
        <div className="flex gap-2">
          <a className={flitBtnPrimary} style={flitBtnPrimaryStyle} href={url} download={nombre}>Descargar</a>
          <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onCerrar}>Cerrar</button>
        </div>
      </div>
    </FlitModal>
  );
}

function ModalCrearEmpresa({ fila, onCerrar, onCreado }: { fila: TramiteFila; onCerrar: () => void; onCreado: () => void }) {
  const [nombre, setNombre] = useState(fila.companiaNombre ?? '');
  const [soatAuto, setSoatAuto] = useState(false);
  const [impuestosAuto, setImpuestosAuto] = useState(false);
  const [logisticaAuto, setLogisticaAuto] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const crear = async () => {
    setGuardando(true); setError(null);
    try {
      await api.post('/flito/tramites/crear-empresa', {
        nombre, nit: fila.empresaNit,
        soatAutogestionable: soatAuto, impuestosAutogestionable: impuestosAuto, logisticaAutogestionable: logisticaAuto,
      });
      onCreado();
    } catch (e) { setError(errorMessage(e)); }
    finally { setGuardando(false); }
  };

  return (
    <FlitModal title="Crear empresa" onClose={onCerrar}>
      <div className="space-y-3">
        <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          Trámite <span className="font-semibold">{fila.idFlit}</span> · la compañía de FLIT aún no existe. Al crearla se
          vinculan automáticamente los trámites con este NIT.
        </p>
        <FlitField label="NIT"><input className={flitInp} value={fila.empresaNit ?? ''} readOnly /></FlitField>
        <FlitField label="Nombre o razón social *">
          <input className={flitInp} value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Razón social de la empresa" autoFocus />
        </FlitField>
        <div>
          <p className="mb-1 text-[11px] font-semibold" style={{ color: 'var(--flit-text-muted)' }}>Autogestión (qué gestiona la empresa por su cuenta)</p>
          <div className="flex flex-wrap gap-4 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={soatAuto} onChange={(e) => setSoatAuto(e.target.checked)} /> SOAT</label>
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={impuestosAuto} onChange={(e) => setImpuestosAuto(e.target.checked)} /> Impuestos</label>
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={logisticaAuto} onChange={(e) => setLogisticaAuto(e.target.checked)} /> Logística</label>
          </div>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-2">
          <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={guardando || !nombre.trim()} onClick={crear}>{guardando ? 'Creando…' : 'Crear empresa'}</button>
          <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onCerrar}>Cancelar</button>
        </div>
      </div>
    </FlitModal>
  );
}

// Botones de paginación (grandes y con contraste, no el texto minúsculo de antes).
const paginaBtn = 'rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40';
const paginaBtnStyle = { borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)', background: 'white' };

// Filtros embebidos en el encabezado de la tabla: multiselect compacto por columna que filtra en
// servidor. Reemplaza la antigua barra de filtros.
type Opc = { value: string; label: string };
const aOpc = (vs: string[]): Opc[] => vs.map((v) => ({ value: v, label: v }));
const SOAT_OPC: Opc[] = Object.values(EstadoSoat).map((e) => ({ value: e, label: ESTADO_SOAT_LABEL[e] }));
const IMP_OPC: Opc[] = Object.values(EstadoImpuesto).map((e) => ({ value: e, label: ESTADO_IMPUESTO_LABEL[e] }));

const thFiltroCls = 'mt-1 block w-full max-w-[12rem] rounded-md border bg-white px-1.5 py-1 text-[11px] font-normal normal-case outline-none';
const thFiltroStyle = { borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' };

// Filtro multiselect embebido en el encabezado: popover con checkboxes.
function ThFiltroMulti({ seleccion, onCambio, opciones, placeholder }: { seleccion: string[]; onCambio: (v: string[]) => void; opciones: Opc[]; placeholder: string }) {
  const alternar = (v: string) => onCambio(seleccion.includes(v) ? seleccion.filter((x) => x !== v) : [...seleccion, v]);
  return (
    <details className="relative mt-1">
      <summary className={`${thFiltroCls} cursor-pointer list-none`} style={thFiltroStyle}>
        {seleccion.length ? `${seleccion.length} seleccionado(s)` : placeholder}
      </summary>
      <div className="absolute z-20 mt-1 max-h-60 w-56 overflow-auto rounded-md border bg-white p-1 shadow-lg" style={{ borderColor: 'var(--flit-border-input)' }}>
        {opciones.length === 0 && <p className="px-2 py-1 text-[11px] font-normal normal-case" style={{ color: 'var(--flit-text-muted)' }}>Sin empresas registradas</p>}
        {opciones.map((o) => (
          <label key={o.value} className="flex cursor-pointer items-center gap-1.5 px-2 py-1 text-[11px] font-normal normal-case">
            <input type="checkbox" checked={seleccion.includes(o.value)} onChange={() => alternar(o.value)} />
            <span className="truncate" title={o.label}>{o.label}</span>
          </label>
        ))}
      </div>
    </details>
  );
}

// Botón "Solicitar" por fila (SOAT/impuestos): pequeño pero con cursor pointer, hover y separación.
function BotonSolicitar({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className="mt-1.5 inline-flex cursor-pointer items-center rounded-md px-2.5 py-1 text-[11px] font-semibold text-white transition-opacity hover:opacity-85"
      style={{ background: 'var(--flit-gradient-primary)' }}>
      Solicitar
    </button>
  );
}

function CeldaSoat({ fila, onSolicitar }: { fila: TramiteFila; onSolicitar?: () => void }) {
  if (fila.soatAutogestionado) return <StatusChip tone="neutral">SOAT autogestionado</StatusChip>;
  if (!fila.soat) return <span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Sin registro</span>;
  const s = fila.soat;
  const v = pesos(s.valorPagado);
  // Solicitud directa desde la columna (sin marcar el check): SOAT en Pendiente y trámite accionable.
  const puedeSolicitar = onSolicitar && esAccionable(fila) && s.estado === EstadoSoat.PENDIENTE;
  return (
    <div className="space-y-0.5">
      <StatusChip tone={TONO_SOAT[s.estado]}>{ESTADO_SOAT_LABEL[s.estado]}</StatusChip>
      {s.estancado && <div><StatusChip tone="danger">SLA vencido</StatusChip></div>}
      {s.enviadoEn && <p className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>Enviado {fecha(s.enviadoEn)}</p>}
      {v && <p className="text-xs font-semibold tabular-nums">{v}</p>}
      {s.motivoRechazo && <p className="text-[11px]" style={{ color: 'var(--flit-danger)' }} title={s.motivoRechazo}>{s.motivoRechazo.slice(0, 40)}</p>}
      {puedeSolicitar && <div><BotonSolicitar onClick={onSolicitar} /></div>}
    </div>
  );
}


// Factura de venta (viene de FLIT, id S3). Con factura → botón para verla; sin factura → aviso.
function CeldaFacturaVenta({ fila, onVer }: { fila: TramiteFila; onVer: (impuestoId: string) => void }) {
  if (fila.facturaVentaFlitId) {
    // El visor va por el impuesto (presigned S3). Sin impuesto todavía no hay a qué apuntar.
    return fila.impuesto
      ? <button className="text-[11px] font-semibold underline" style={{ color: 'var(--flit-blue-text)' }}
          onClick={() => onVer(fila.impuesto!.id)}>Ver factura de venta</button>
      : <span className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>Factura en FLIT</span>;
  }
  return <span className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>Sin factura de venta</span>;
}

function CeldaImpuesto({ fila, onSolicitar }: { fila: TramiteFila; onSolicitar?: () => void }) {
  // La autogestión la decide la bandera de la empresa (no la ausencia de registro): igual que SOAT.
  if (fila.impuestosAutogestionado) return <StatusChip tone="neutral">Impuestos autogestionado</StatusChip>;
  // Sin bandera y sin registro (p.ej. trámite no Asignado): sin registro, mismo criterio que SOAT.
  if (!fila.impuesto) return <span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Sin registro</span>;
  const imp = fila.impuesto;
  const liq = pesos(imp.valorLiquidado);
  const pag = pesos(imp.valorPagado);
  const puedeSolicitar = onSolicitar && esAccionable(fila) && imp.estado === EstadoImpuesto.PENDIENTE;
  return (
    <div className="space-y-0.5">
      <StatusChip tone={TONO_IMP[imp.estado]}>{ESTADO_IMPUESTO_LABEL[imp.estado]}</StatusChip>
      {imp.estancado && <div><StatusChip tone="danger">SLA vencido</StatusChip></div>}
      {imp.marcadoPorDiferencia && <div><StatusChip tone="warning">Diferencia de valor</StatusChip></div>}
      {imp.enviadoEn && <p className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>Enviado {fecha(imp.enviadoEn)}</p>}
      {liq && <p className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>Liquidado {liq}</p>}
      {pag && <p className="text-xs font-semibold tabular-nums">{pag}</p>}
      {imp.motivoRechazo && <p className="text-[11px]" style={{ color: 'var(--flit-danger)' }} title={imp.motivoRechazo}>{imp.motivoRechazo.slice(0, 40)}</p>}
      {puedeSolicitar && <div><BotonSolicitar onClick={onSolicitar} /></div>}
    </div>
  );
}

// Tracking logístico de la LT: línea horizontal con un punto por paso y, arriba, el estado actual
// (estilo seguimiento de pedido). Novedad/Devuelta se marcan en rojo sobre el paso donde ocurren.
// Tracking con el vocabulario SIMPLE (4 pasos lineales; «Con novedad» es un desvío lateral, no un paso).
const PASOS_LOG = ESTADOS_LOGISTICA_SIMPLE_ORDEN.map((key) => ({ key, label: ESTADO_LOGISTICA_SIMPLE_LABEL[key] }));
const IDX_SIMPLE: Record<EstadoLogisticaSimple, { idx: number; danger: boolean }> = {
  pendiente: { idx: 0, danger: false }, registrada: { idx: 1, danger: false },
  despachada: { idx: 2, danger: false }, entregada: { idx: 3, danger: false },
  novedad: { idx: 1, danger: true }, // se pinta en rojo sobre el paso de recogida
};

function TrackingLogistica({ estado }: { estado: string | null }) {
  if (!estado) return <span className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>No aplica</span>;
  const simple = simplificarEstadoLogistica(estado);
  const info = IDX_SIMPLE[simple];
  const color = info.danger ? 'var(--flit-danger)' : simple === 'entregada' ? 'var(--flit-success)' : 'var(--flit-blue-text)';
  const pct = (info.idx / (PASOS_LOG.length - 1)) * 100;
  return (
    <div className="min-w-[190px]">
      <div className="mb-2 text-[11px] font-semibold" style={{ color }}>{ESTADO_LOGISTICA_SIMPLE_LABEL[simple]}</div>
      <div className="relative flex items-center justify-between px-0.5">
        <div className="absolute inset-x-1 top-1/2 h-0.5 -translate-y-1/2 rounded" style={{ background: 'var(--flit-border-soft)' }} />
        <div className="absolute left-1 top-1/2 h-0.5 -translate-y-1/2 rounded" style={{ width: `calc(${pct}% - 4px)`, background: color }} />
        {PASOS_LOG.map((p, i) => {
          const hecho = i <= info.idx;
          const actual = i === info.idx;
          return (
            <span key={p.key} title={p.label} className="relative z-10 rounded-full transition-all"
              style={{
                width: actual ? 12 : 9, height: actual ? 12 : 9,
                background: hecho ? color : '#fff',
                border: `2px solid ${hecho ? color : 'var(--flit-border-soft)'}`,
                boxShadow: actual ? `0 0 0 3px ${info.danger ? 'rgba(228,61,48,0.18)' : 'rgba(48,102,190,0.18)'}` : 'none',
              }} />
          );
        })}
      </div>
    </div>
  );
}

function DialogoProveedor({ tipo, n, proveedores, enProceso, onConfirmar, onCancelar }: {
  tipo: 'soat' | 'ambos'; n: number; proveedores: Proveedor[]; enProceso: boolean;
  onConfirmar: (proveedorSoatId: string) => void; onCancelar: () => void;
}) {
  const [proveedorSoatId, setProveedorSoatId] = useState('');
  return (
    <FlitModal title={tipo === 'ambos' ? 'Solicitar SOAT e impuestos' : 'Solicitar SOAT'} onClose={onCancelar}>
      <div className="space-y-3">
        <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          Elige la aseguradora a la que se envían los {n} trámite(s). El SOAT va a ese proveedor; los impuestos van a su gestor según el organismo.
        </p>
        <FlitField label="Aseguradora">
          <select className={flitInp} value={proveedorSoatId} onChange={(e) => setProveedorSoatId(e.target.value)}>
            <option value="">Elige una aseguradora…</option>
            {proveedores.filter((p) => p.activo).map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
          </select>
        </FlitField>
        <div className="flex gap-2">
          <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={!proveedorSoatId || enProceso} onClick={() => onConfirmar(proveedorSoatId)}>
            {tipo === 'ambos' ? 'Solicitar ambos' : 'Solicitar SOAT'}
          </button>
          <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onCancelar}>Cancelar</button>
        </div>
      </div>
    </FlitModal>
  );
}

const TONO_COLOR: Record<ChipTone, string> = {
  success: 'var(--flit-success)', active: 'var(--flit-info)', warning: 'var(--flit-warning)',
  danger: 'var(--flit-danger)', draft: 'var(--flit-draft)', neutral: 'var(--flit-text-muted)',
};

function Linea({ tono, children }: { tono: ChipTone; children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-sm">
      <span aria-hidden="true" className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: TONO_COLOR[tono] }} />
      <span>{children}</span>
    </p>
  );
}

function DetalleSoat({ r }: { r: ResSoat }) {
  const vacio = !r.enviados && !r.yaEnviados && !r.autogestionados && !r.sinRegistro;
  return (
    <div className="space-y-1.5">
      {r.enviados > 0 && <Linea tono="success">{r.enviados} SOAT enviado(s): pasan a «En adquisición».</Linea>}
      {r.yaEnviados > 0 && <Linea tono="neutral">{r.yaEnviados} ya solicitados o pagados: no se reenvían.</Linea>}
      {r.autogestionados > 0 && <Linea tono="neutral">{r.autogestionados} no llevan SOAT: su compañía lo autogestiona.</Linea>}
      {r.sinRegistro > 0 && <Linea tono="neutral">{r.sinRegistro} sin registro de SOAT todavía.</Linea>}
      {vacio && <Linea tono="neutral">Ningún trámite tenía SOAT por enviar.</Linea>}
    </div>
  );
}

function DetalleImpuestos({ r }: { r: ResImpuestos }) {
  const vacio = !r.enviados && !r.yaEnviados && !r.noEnviables;
  return (
    <div className="space-y-1.5">
      {r.enviados > 0 && <Linea tono="success">{r.enviados} impuesto(s) enviado(s): pasan a «Solicitado».</Linea>}
      {r.yaEnviados > 0 && <Linea tono="neutral">{r.yaEnviados} ya solicitados o pagados: no se reenvían.</Linea>}
      {r.noEnviables > 0 && <Linea tono="neutral">{r.noEnviables} no enviables: autogestionados o no están en Pendiente.</Linea>}
      {vacio && <Linea tono="neutral">Ningún trámite tenía impuesto por enviar.</Linea>}
    </div>
  );
}

const TITULO: Record<Resultado['tipo'], string> = {
  soat: 'Resultado de solicitar SOAT', impuestos: 'Resultado de solicitar Impuestos',
  ambos: 'Resultado de solicitar SOAT e Impuestos', entrega: 'Resultado de la entrega',
};

function ModalResultado({ resultado, onCerrar }: { resultado: Resultado; onCerrar: () => void }) {
  return (
    <FlitModal title={TITULO[resultado.tipo]} onClose={onCerrar} wide>
      <div className="space-y-3">
        {resultado.tipo === 'soat' && <DetalleSoat r={resultado.soat} />}
        {resultado.tipo === 'impuestos' && <DetalleImpuestos r={resultado.impuestos} />}
        {resultado.tipo === 'ambos' && (
          <>
            <div><p className="mb-1 text-xs font-semibold uppercase" style={{ color: 'var(--flit-text-muted)' }}>SOAT</p><DetalleSoat r={resultado.soat} /></div>
            <div><p className="mb-1 text-xs font-semibold uppercase" style={{ color: 'var(--flit-text-muted)' }}>Impuestos</p><DetalleImpuestos r={resultado.impuestos} /></div>
          </>
        )}
        {resultado.tipo === 'entrega' && (
          <div className="space-y-1.5">
            {resultado.entrega.entregados > 0 && <Linea tono="success">{resultado.entrega.entregados} trámite(s) entregado(s).</Linea>}
            {resultado.entrega.noHabilitados.length > 0 && (
              <div>
                <Linea tono="warning">{resultado.entrega.noHabilitados.length} no estaban habilitados:</Linea>
                <ul className="mt-1 space-y-1">
                  {resultado.entrega.noHabilitados.map((t) => (
                    <li key={t.tramiteId} className="rounded-md border p-2 text-xs" style={{ borderColor: 'var(--flit-border-soft)' }}>
                      <span className="font-medium">{t.placa}</span> <span style={{ color: 'var(--flit-text-muted)' }}>— {t.motivo}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {!resultado.entrega.entregados && !resultado.entrega.noHabilitados.length && <Linea tono="neutral">No había trámites por entregar.</Linea>}
          </div>
        )}
        <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} onClick={onCerrar}>Entendido</button>
      </div>
    </FlitModal>
  );
}
