// FLITO — Trámites unificado (Fase 6). Porta packages/client/src/paginas/tramites/tramites.tsx al kit
// flit/ + api. Una fila por trámite: solicita SOAT/impuestos/ambos, sigue su estado y entrega en lote.
// Es la vista de quien despacha (Operaciones); Auditoría entra en solo lectura. Los gestores NO entran:
// cada uno sigue en su propia cola. Las reglas viven en el backend; aquí solo se orquesta y reporta.

import { puedeOperar } from '../lib/permissions';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  ESTADO_IMPUESTO_LABEL, ESTADO_SOAT_LABEL, EstadoImpuesto, EstadoSoat,
} from '@operaciones/shared-types';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import FlitModal from '../components/flit/FlitModal';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import {
  FlitCard, FlitTable, FlitTh, FlitTr, FlitField, FlitEmpty, FlitPillGroup, FlitPillButton,
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
type SemaforoTramite = 'autogestionada' | 'rojo' | 'amarillo' | 'verde';
interface TramiteFila {
  tramiteId: string; idFlit: string; estado: string; asignado: boolean;
  semaforo: SemaforoTramite;
  tipoTramite: string | null; ciudad: string | null; fechaAprobacion: string | null;
  companiaNombre: string | null; empresaExiste: boolean; empresaNit: string | null;
  organismoNombre: string | null; secretariaEmparejada: boolean; transitoNombre: string | null;
  facturaVentaFlitId: string | null;
  vehiculo: { vin: string | null; placa: string | null; marca: string | null; linea: string | null; tipoVehiculo: string | null };
  compradorPrincipal: { nombreCompleto: string; numeroDocumento: string } | null;
  compradores: unknown[]; soat: FilaSoat | null; soatAutogestionado: boolean; impuesto: FilaImpuesto | null;
  soatResuelto: boolean; impuestosResueltos: boolean; listoParaEntregar: boolean;
  valorSoat: number | null; valorImpuesto: number | null; sincronizadoEn: string;
}
// Un trámite habilita SOAT/impuestos solo si está Asignado y con empresa + secretaría emparejadas.
const esAccionable = (f: TramiteFila) => f.asignado && f.empresaExiste && f.secretariaEmparejada;
interface Proveedor { id: string; nombre: string; activo: boolean }
interface HistorialItem { id: string; campo: string; valorAnterior: string | null; valorNuevo: string | null; origen: string; usuarioNombre: string | null; creadoEn: string }

interface ResSoat { enviados: number; yaEnviados: number; autogestionados: number; sinRegistro: number }
interface Ref { tramiteId: string; idFlit: string; placa: string | null }
interface ResImpuestos { enviados: number; yaEnviados: number; requierenFactura: Ref[]; noAplica: number; retenidos: Ref[] }
interface ResEntrega { entregados: number; noHabilitados: Array<{ tramiteId: string; idFlit: string; placa: string; motivo: string }> }
type Resultado =
  | { tipo: 'soat'; soat: ResSoat }
  | { tipo: 'impuestos'; impuestos: ResImpuestos }
  | { tipo: 'ambos'; soat: ResSoat; impuestos: ResImpuestos }
  | { tipo: 'entrega'; entrega: ResEntrega };

const TONO_SOAT: Record<EstadoSoat, ChipTone> = { pendiente: 'draft', en_adquisicion: 'active', pagado: 'success', rechazado: 'danger' };
const TONO_IMP: Record<EstadoImpuesto, ChipTone> = {
  sin_factura: 'draft', retenido: 'warning', pendiente: 'draft', en_gestion: 'active', pagado: 'success', rechazado: 'danger', no_aplica: 'neutral',
};
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
  const [error, setError] = useState<string | null>(null);
  const [proveedores, setProveedores] = useState<Proveedor[]>([]);
  const [dialogo, setDialogo] = useState<null | 'soat' | 'ambos'>(null);
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

  // Filtros de columna (cliente): además del buscar global (placa/VIN/id/comprador).
  const [fEstado, setFEstado] = useState('');
  const [fCiudad, setFCiudad] = useState('');
  const [fTramite, setFTramite] = useState('');
  const [fTransito, setFTransito] = useState('');
  const [fCompania, setFCompania] = useState('');

  useEffect(() => {
    setError(null); setData(null); setSeleccion(new Set());
    const q = new URLSearchParams();
    if (buscar.trim()) q.set('buscar', buscar.trim());
    api.get<TramiteFila[]>(`/flito/tramites?${q}`).then(setData).catch((e) => setError(errorMessage(e)));
  }, [buscar, recarga]);

  useEffect(() => {
    if (!esOperaciones) return;
    api.get<Proveedor[]>('/flito/parametrizacion/proveedores-soat').then(setProveedores).catch(() => setProveedores([]));
    api.get<{ ultimaSincronizacion: string | null }>('/flito/sync/estado')
      .then((e) => setUltimaSync(e.ultimaSincronizacion)).catch(() => setUltimaSync(null));
  }, [esOperaciones]);

  const todas = data ?? [];
  const inc = (v: string | null, q: string) => q === '' || (v ?? '').toLowerCase().includes(q.toLowerCase());
  const filas = useMemo(() => todas.filter((f) => {
    const soatOk = soatSel.length === 0 || (f.soat != null && soatSel.includes(f.soat.estado));
    const impOk = impSel.length === 0 || (f.impuesto != null && impSel.includes(f.impuesto.estado));
    return soatOk && impOk
      && (fEstado === '' || f.estado === fEstado)
      && (fCiudad === '' || f.ciudad === fCiudad)
      && (fTramite === '' || f.tipoTramite === fTramite)
      && (fTransito === '' || f.organismoNombre === fTransito)
      && inc(f.companiaNombre, fCompania);
  }), [todas, soatSel, impSel, fEstado, fCiudad, fTramite, fTransito, fCompania]);

  const refrescar = () => setRecarga((n) => n + 1);
  const ids = () => [...seleccion];
  const limpiar = () => setSeleccion(new Set());
  const n = seleccion.size;
  const hayFiltros = soatSel.length > 0 || impSel.length > 0 || !!(fEstado || fCiudad || fTramite || fTransito || fCompania);
  const accionables = useMemo(() => filas.filter(esAccionable), [filas]);

  const ejecutar = async (fn: () => Promise<Resultado>) => {
    setEnProceso(true); setError(null);
    try { setResultado(await fn()); limpiar(); refrescar(); }
    catch (e) { setError(errorMessage(e)); }
    finally { setEnProceso(false); }
  };

  const solicitarImpuestos = () => ejecutar(async () => ({ tipo: 'impuestos', impuestos: await api.post<ResImpuestos>('/flito/tramites/solicitar-impuestos', { tramiteIds: ids() }) }));
  const entregar = (tramiteIds: string[]) => ejecutar(async () => ({ tipo: 'entrega', entrega: await api.post<ResEntrega>('/flito/tramites/entregar', { tramiteIds }) }));

  // Ver la factura de venta de FLIT: el endpoint (auth) redirige a la URL S3 prefirmada; se descarga el
  // blob (fetch sigue el redirect) y se abre en una pestaña.
  const verFactura = async (impuestoId: string) => {
    setError(null);
    try {
      const blob = await api.get<Blob>(`/flito/impuestos/${impuestoId}/factura-venta`);
      window.open(URL.createObjectURL(blob), '_blank', 'noopener');
    } catch (e) { setError(errorMessage(e)); }
  };

  const descargarZip = async () => {
    const impuestoIds = todas.filter((f) => seleccion.has(f.tramiteId) && f.impuesto && f.facturaVentaFlitId).map((f) => f.impuesto!.id);
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

  // Opciones de filtro derivadas de los datos (estado, ciudad, tipo de trámite, tránsito).
  const opciones = useMemo(() => {
    const uniq = (vs: (string | null)[]) => [...new Set(vs.filter((v): v is string => !!v))].sort();
    return {
      estados: uniq(todas.map((f) => f.estado)),
      ciudades: uniq(todas.map((f) => f.ciudad)),
      tramites: uniq(todas.map((f) => f.tipoTramite)),
      transitos: uniq(todas.map((f) => f.organismoNombre)),
    };
  }, [todas]);

  return (
    <div className="space-y-4">
      <PageHeaderCard title="Trámites"
        subtitle="Todos los trámites de FLIT. Solo los Asignados (con empresa y secretaría) habilitan SOAT e impuestos."
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <input className={`${flitInp} max-w-[14rem]`} placeholder="Buscar placa, VIN, id o comprador…"
              value={texto} onChange={(e) => setTexto(e.target.value)} />
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

      {data && todas.length === 0 && (
        <FlitCard>
          <FlitEmpty>{buscar ? 'Ningún trámite coincide con la búsqueda.' : 'No hay trámites. Sincroniza desde FLIT para traer trámites.'}</FlitEmpty>
        </FlitCard>
      )}

      {todas.length > 0 && (
        <FlitCard>
          {/* Filtros embebidos en la parte superior de la tabla. */}
          <div className="mb-3 space-y-2 border-b pb-3" style={{ borderColor: 'var(--flit-border)' }}>
            <div className="flex flex-wrap items-end gap-3">
              <FiltroSelect label="Estado" value={fEstado} onChange={setFEstado} opciones={opciones.estados} />
              <FiltroSelect label="Trámite" value={fTramite} onChange={setFTramite} opciones={opciones.tramites} />
              <FiltroSelect label="Tránsito" value={fTransito} onChange={setFTransito} opciones={opciones.transitos} />
              <FiltroSelect label="Ciudad" value={fCiudad} onChange={setFCiudad} opciones={opciones.ciudades} />
              <FiltroTexto label="Compañía" value={fCompania} onChange={setFCompania} />
            </div>
            <GrupoFiltro titulo="SOAT" estados={Object.values(EstadoSoat)} etiqueta={(e) => ESTADO_SOAT_LABEL[e]} seleccion={soatSel} onCambio={setSoatSel} />
            <GrupoFiltro titulo="Impuestos" estados={Object.values(EstadoImpuesto)} etiqueta={(e) => ESTADO_IMPUESTO_LABEL[e]} seleccion={impSel} onCambio={setImpSel} />
            <div className="flex items-center gap-3">
              <span className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>{filas.length} de {todas.length} trámites</span>
              {hayFiltros && (
                <button className="text-xs font-semibold" style={{ color: 'var(--flit-blue-text)' }}
                  onClick={() => { setSoatSel([]); setImpSel([]); setFEstado(''); setFTramite(''); setFTransito(''); setFCiudad(''); setFCompania(''); }}>Limpiar filtros</button>
              )}
            </div>
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
                <FlitTh>Trámite</FlitTh><FlitTh>Vehículo</FlitTh><FlitTh>Comprador</FlitTh>
                <FlitTh>Tránsito / Compañía</FlitTh><FlitTh>Ciudad</FlitTh><FlitTh>SOAT</FlitTh>
                <FlitTh>Impuestos</FlitTh>
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
                    <div className="mt-1"><SemaforoChip semaforo={f.semaforo} /></div>
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
                  <td className="px-3 py-2 text-sm">
                    <div>{f.organismoNombre ?? '—'}</div>
                    {/* Empresa gestora (CompaniaGestora de FLIT ↔ cliente FLITO): nombre arriba, NIT abajo. */}
                    <div className="mt-1">
                      {f.empresaExiste
                        ? <>
                            <div>{f.companiaNombre}</div>
                            {f.empresaNit && <div className="text-[11px] tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>NIT {f.empresaNit}</div>}
                          </>
                        : <div className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>{f.empresaNit ? `NIT ${f.empresaNit} · sin empresa` : 'sin empresa'}</div>}
                    </div>
                    <CeldaIndicadores fila={f} />
                    {esOperaciones && !f.empresaExiste && f.empresaNit && (
                      <button className="mt-1 text-[11px] font-semibold underline" style={{ color: 'var(--flit-blue-text)' }}
                        onClick={() => setCrearEmpresa(f)}>Crear empresa</button>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs align-top">{f.ciudad ?? '—'}</td>
                  <td className="px-3 py-2 align-top"><CeldaSoat fila={f} /></td>
                  <td className="px-3 py-2 align-top"><CeldaImpuesto fila={f} /></td>
                </FlitTr>
              ))}
            </tbody>
          </FlitTable>
          )}
        </FlitCard>
      )}

      {dialogo && (
        <DialogoProveedor tipo={dialogo} n={n} proveedores={proveedores} enProceso={enProceso}
          onCancelar={() => setDialogo(null)}
          onConfirmar={(proveedorSoatId) => {
            const tramiteIds = ids();
            setDialogo(null);
            ejecutar(async () => {
              if (dialogo === 'soat') return { tipo: 'soat', soat: await api.post<ResSoat>('/flito/tramites/solicitar-soat', { tramiteIds, proveedorSoatId }) };
              const r = await api.post<{ soat: ResSoat; impuestos: ResImpuestos }>('/flito/tramites/solicitar-ambos', { tramiteIds, proveedorSoatId });
              return { tipo: 'ambos', soat: r.soat, impuestos: r.impuestos };
            });
          }} />
      )}

      {resultado && <ModalResultado resultado={resultado} onCerrar={() => setResultado(null)} />}
      {historial && <ModalHistorial idFlit={historial.idFlit} items={historial.items} onCerrar={() => setHistorial(null)} />}

      {crearEmpresa && (
        <ModalCrearEmpresa fila={crearEmpresa}
          onCerrar={() => setCrearEmpresa(null)}
          onCreado={() => { setCrearEmpresa(null); setRecarga((n) => n + 1); }} />
      )}
    </div>
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
function ModalCrearEmpresa({ fila, onCerrar, onCreado }: { fila: TramiteFila; onCerrar: () => void; onCreado: () => void }) {
  const [nombre, setNombre] = useState(fila.companiaNombre ?? '');
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const crear = async () => {
    setGuardando(true); setError(null);
    try {
      const r = await api.post<{ revinculados: number; yaExistia: boolean }>('/flito/tramites/crear-empresa', { nombre, nit: fila.empresaNit });
      void r;
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
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-2">
          <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={guardando || !nombre.trim()} onClick={crear}>{guardando ? 'Creando…' : 'Crear empresa'}</button>
          <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onCerrar}>Cancelar</button>
        </div>
      </div>
    </FlitModal>
  );
}

function GrupoFiltro<T extends string>({ titulo, estados, etiqueta, seleccion, onCambio }: {
  titulo: string; estados: readonly T[]; etiqueta: (e: T) => string; seleccion: T[]; onCambio: (v: T[]) => void;
}) {
  const alternar = (e: T) => onCambio(seleccion.includes(e) ? seleccion.filter((x) => x !== e) : [...seleccion, e]);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-semibold" style={{ color: 'var(--flit-text-muted)' }}>{titulo}:</span>
      <FlitPillGroup>
        {estados.map((e) => <FlitPillButton key={e} active={seleccion.includes(e)} onClick={() => alternar(e)}>{etiqueta(e)}</FlitPillButton>)}
      </FlitPillGroup>
    </div>
  );
}

// Semáforo de gestión FLITO: gris (autogestionada) · rojo (nada resuelto) · amarillo (uno) · verde (ambos).
const SEMAFORO: Record<SemaforoTramite, { tone: ChipTone; label: string }> = {
  autogestionada: { tone: 'neutral', label: 'Autogestionada' },
  rojo: { tone: 'danger', label: 'SOAT e impuestos pendientes' },
  amarillo: { tone: 'warning', label: 'Falta uno (SOAT o impuestos)' },
  verde: { tone: 'success', label: 'SOAT e impuestos listos' },
};
function SemaforoChip({ semaforo }: { semaforo: SemaforoTramite }) {
  const s = SEMAFORO[semaforo];
  if (!s) return null;
  return <StatusChip tone={s.tone}>{s.label}</StatusChip>;
}

function CeldaSoat({ fila }: { fila: TramiteFila }) {
  if (fila.soatAutogestionado) return <span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Autogestionado</span>;
  if (!fila.soat) return <span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Sin registro</span>;
  const s = fila.soat;
  const v = pesos(s.valorPagado);
  return (
    <div className="space-y-0.5">
      <StatusChip tone={TONO_SOAT[s.estado]}>{ESTADO_SOAT_LABEL[s.estado]}</StatusChip>
      {s.estancado && <div><StatusChip tone="danger">SLA vencido</StatusChip></div>}
      {s.proveedorSoatNombre && <p className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>{s.proveedorSoatNombre}</p>}
      {s.enviadoEn && <p className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>Enviado {fecha(s.enviadoEn)}</p>}
      {v && <p className="text-xs font-semibold tabular-nums">{v}</p>}
      {s.motivoRechazo && <p className="text-[11px]" style={{ color: 'var(--flit-danger)' }} title={s.motivoRechazo}>{s.motivoRechazo.slice(0, 40)}</p>}
    </div>
  );
}

// Filtros de columna.
function FiltroSelect({ label, value, onChange, opciones }: { label: string; value: string; onChange: (v: string) => void; opciones: string[] }) {
  return (
    <label className="flex flex-col gap-0.5 text-[11px] font-semibold" style={{ color: 'var(--flit-text-muted)' }}>
      {label}
      <select className={`${flitInp} h-9 min-w-[10rem]`} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Todos</option>
        {opciones.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}
function FiltroTexto({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-0.5 text-[11px] font-semibold" style={{ color: 'var(--flit-text-muted)' }}>
      {label}
      <input className={`${flitInp} h-9 min-w-[10rem]`} value={value} onChange={(e) => onChange(e.target.value)} placeholder="Todas" />
    </label>
  );
}

// Indicadores de emparejamiento/autogestión que gobiernan el gating (integración FLIT).
function CeldaIndicadores({ fila }: { fila: TramiteFila }) {
  const chips: ReactNode[] = [];
  if (!fila.empresaExiste) chips.push(<StatusChip key="e" tone="danger">Empresa no existe</StatusChip>);
  else if (fila.soatAutogestionado) chips.push(<StatusChip key="sa" tone="neutral">SOAT autogestionado</StatusChip>);
  if (!fila.secretariaEmparejada) chips.push(<StatusChip key="s" tone="warning">Secretaría sin emparejar</StatusChip>);
  if (chips.length === 0) return null;
  return <div className="mt-1 flex flex-wrap gap-1">{chips}</div>;
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

function CeldaImpuesto({ fila }: { fila: TramiteFila }) {
  if (!fila.impuesto) return <span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Sin registro</span>;
  const imp = fila.impuesto;
  const liq = pesos(imp.valorLiquidado);
  const pag = pesos(imp.valorPagado);
  return (
    <div className="space-y-0.5">
      <StatusChip tone={TONO_IMP[imp.estado]}>{ESTADO_IMPUESTO_LABEL[imp.estado]}</StatusChip>
      {imp.estancado && <div><StatusChip tone="danger">SLA vencido</StatusChip></div>}
      {imp.marcadoPorDiferencia && <div><StatusChip tone="warning">Diferencia de valor</StatusChip></div>}
      {liq && <p className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>Liquidado {liq}</p>}
      {pag && <p className="text-xs font-semibold tabular-nums">{pag}</p>}
      {imp.motivoRechazo && <p className="text-[11px]" style={{ color: 'var(--flit-danger)' }} title={imp.motivoRechazo}>{imp.motivoRechazo.slice(0, 40)}</p>}
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
  const vacio = !r.enviados && !r.yaEnviados && !r.requierenFactura.length && !r.retenidos.length && !r.noAplica;
  return (
    <div className="space-y-1.5">
      {r.enviados > 0 && <Linea tono="success">{r.enviados} impuesto(s) enviado(s): pasan a «En gestión».</Linea>}
      {r.yaEnviados > 0 && <Linea tono="neutral">{r.yaEnviados} ya en gestión o pagados: no se reenvían.</Linea>}
      {r.requierenFactura.length > 0 && <Linea tono="warning">Requieren factura de venta antes de enviarse ({r.requierenFactura.length}): {r.requierenFactura.map((x) => x.placa).join(', ')}</Linea>}
      {r.retenidos.length > 0 && <Linea tono="warning">Retenidos por organismo sin clasificar ({r.retenidos.length}): {r.retenidos.map((x) => x.placa).join(', ')}</Linea>}
      {r.noAplica > 0 && <Linea tono="neutral">{r.noAplica} no aplican: compañía u organismo autogestionado.</Linea>}
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
