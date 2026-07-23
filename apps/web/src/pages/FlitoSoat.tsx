// FLITO — Portal SOAT (Fase 6). Porta packages/client/src/paginas/soat/* al kit flit/ + api.
// Cola con las 3 fronteras (resueltas en el backend), envío atómico al gestor, carga de factura
// (única vía a Pagado, RN-03), rechazo/reactivación/reversa/cambio de proveedor y carga masiva.
// La visibilidad la impone el servidor: Operaciones ve todo; el gestor solo su proveedor y nunca
// los Pendiente; Auditoría es solo lectura.

import { puedeOperar } from '../lib/permissions';
import { useEffect, useMemo, useState } from 'react';
import { ESTADO_SOAT_LABEL, EstadoSoat } from '@operaciones/shared-types';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import FlitModal from '../components/flit/FlitModal';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import {
  FlitCard, FlitTable, FlitTh, FlitTr, FlitField, FlitEmpty, FlitPillGroup, FlitPillButton,
  flitInp, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../components/flit/flitPageKit';

interface SoatItem {
  id: string; vin: string; placa: string | null; marca: string | null; linea: string | null;
  estado: EstadoSoat; esMultiplePropietario: boolean; companiaNombre: string;
  organismoNombre: string | null; proveedorSoatId: string | null; proveedorSoatNombre: string | null;
  compradores: Array<{ nombreCompleto: string; numeroDocumento: string; orden: number; porcentajeParticipacion: number | null }>;
  tramitesFlit: string[]; enviadoPorNombre: string | null; enviadoEn: string | null;
  valorPagado: number | null; estancado: boolean; motivoRechazo: string | null; creadoEn: string;
}
interface Proveedor { id: string; nombre: string; activo: boolean }

const TONO: Record<EstadoSoat, ChipTone> = {
  pendiente: 'draft', solicitado: 'active', con_novedad: 'danger', pagado: 'success',
};
const pesos = (v: number | null) => v === null ? '—'
  : new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(v);
const fecha = (iso: string | null) => iso ? new Date(iso).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' }) : '—';

const ESTADOS_OPERACIONES: EstadoSoat[] = [EstadoSoat.PENDIENTE, EstadoSoat.SOLICITADO, EstadoSoat.PAGADO, EstadoSoat.CON_NOVEDAD];
const ESTADOS_GESTOR: EstadoSoat[] = [EstadoSoat.SOLICITADO, EstadoSoat.PAGADO];

export default function FlitoSoat() {
  const { user } = useAuth();
  const esOperaciones = puedeOperar(user?.role);
  const esGestor = user?.role === 'proveedor';
  const soloLectura = user?.role === 'auditor';

  const estadosDisponibles = esGestor ? ESTADOS_GESTOR : ESTADOS_OPERACIONES;
  const [estado, setEstado] = useState<EstadoSoat | 'todos'>(esGestor ? EstadoSoat.SOLICITADO : 'todos');
  const [buscar, setBuscar] = useState('');
  const [data, setData] = useState<SoatItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set());
  const [detalleId, setDetalleId] = useState<string | null>(null);
  const [cargaMasiva, setCargaMasiva] = useState(false);
  const [proveedores, setProveedores] = useState<Proveedor[]>([]);
  const [recarga, setRecarga] = useState(0);

  useEffect(() => {
    setError(null); setData(null); setSeleccion(new Set());
    const q = new URLSearchParams();
    if (estado !== 'todos') q.set('estado', estado);
    if (buscar.trim()) q.set('buscar', buscar.trim());
    api.get<SoatItem[]>(`/flito/soat?${q}`).then(setData).catch((e) => setError(errorMessage(e)));
  }, [estado, buscar, recarga]);

  useEffect(() => {
    if (!esOperaciones) return;
    api.get<Proveedor[]>('/flito/parametrizacion/proveedores-soat').then(setProveedores).catch(() => setProveedores([]));
  }, [esOperaciones]);

  const filas = data ?? [];
  const seleccionables = useMemo(() => filas.filter((f) => f.estado === EstadoSoat.PENDIENTE), [filas]);
  const detalle = filas.find((f) => f.id === detalleId) ?? null;
  const refrescar = () => setRecarga((n) => n + 1);

  const toggle = (id: string) => setSeleccion((s) => {
    const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n;
  });

  return (
    <div className="space-y-4">
      <PageHeaderCard
        title="SOAT"
        subtitle="Cola de adquisición del SOAT. El SOAT se ancla al VIN y solo pasa a Pagado con una factura validada."
        actions={(esOperaciones || esGestor) && (
          <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} onClick={() => setCargaMasiva(true)}>
            Cargar facturas (masivo)
          </button>
        )}
      />

      <FlitCard>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <FlitPillGroup>
            {!esGestor && (
              <FlitPillButton active={estado === 'todos'} onClick={() => setEstado('todos')}>Todos</FlitPillButton>
            )}
            {estadosDisponibles.map((e) => (
              <FlitPillButton key={e} active={estado === e} onClick={() => setEstado(e)}>{ESTADO_SOAT_LABEL[e]}</FlitPillButton>
            ))}
          </FlitPillGroup>
          <input className={`${flitInp} max-w-xs`} placeholder="Buscar placa, VIN, comprador…"
            value={buscar} onChange={(e) => setBuscar(e.target.value)} />
        </div>
      </FlitCard>

      {error && <FlitCard><p className="text-sm text-red-600">{error}</p></FlitCard>}

      {esOperaciones && seleccion.size > 0 && (
        <BarraEnvio ids={[...seleccion]} proveedores={proveedores}
          onEnviado={() => { setSeleccion(new Set()); refrescar(); }} onError={setError} />
      )}

      {data && filas.length === 0 && (
        <FlitCard><FlitEmpty>No hay SOAT en esta vista. Sincroniza desde el Tablero para traer trámites nuevos.</FlitEmpty></FlitCard>
      )}

      {filas.length > 0 && (
        <FlitCard>
          <FlitTable>
            <thead>
              <FlitTr>
                {esOperaciones && seleccionables.length > 0 && (
                  <FlitTh>
                    <input type="checkbox" aria-label="Seleccionar todos los pendientes"
                      checked={seleccion.size > 0 && seleccion.size === seleccionables.length}
                      onChange={(e) => setSeleccion(e.target.checked ? new Set(seleccionables.map((f) => f.id)) : new Set())} />
                  </FlitTh>
                )}
                <FlitTh>Placa</FlitTh><FlitTh>Vehículo</FlitTh><FlitTh>Compañía</FlitTh>
                <FlitTh>Proveedor</FlitTh><FlitTh>Estado</FlitTh><FlitTh>Valor</FlitTh><FlitTh />
              </FlitTr>
            </thead>
            <tbody>
              {filas.map((f) => (
                <FlitTr key={f.id}>
                  {esOperaciones && seleccionables.length > 0 && (
                    <td className="px-3 py-2">
                      {f.estado === EstadoSoat.PENDIENTE && (
                        <input type="checkbox" aria-label={`Seleccionar ${f.placa}`}
                          checked={seleccion.has(f.id)} onChange={() => toggle(f.id)} />
                      )}
                    </td>
                  )}
                  <td className="px-3 py-2 font-medium">
                    {f.placa ?? '—'}
                    {f.esMultiplePropietario && <span className="ml-1 text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>multi</span>}
                  </td>
                  <td className="px-3 py-2 text-sm">
                    <div>{f.marca} {f.linea}</div>
                    <div className="text-[11px] tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>{f.vin}</div>
                  </td>
                  <td className="px-3 py-2 text-sm">{f.companiaNombre}</td>
                  <td className="px-3 py-2 text-sm">{f.proveedorSoatNombre ?? '—'}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-col items-start gap-1">
                      <StatusChip tone={TONO[f.estado]}>{ESTADO_SOAT_LABEL[f.estado]}</StatusChip>
                      {f.estancado && <StatusChip tone="warning">SLA vencido</StatusChip>}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-sm tabular-nums">{pesos(f.valorPagado)}</td>
                  <td className="px-3 py-2">
                    <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setDetalleId(f.id)}>Ver</button>
                  </td>
                </FlitTr>
              ))}
            </tbody>
          </FlitTable>
        </FlitCard>
      )}

      {detalle && (
        <DetalleSoat soat={detalle} esOperaciones={esOperaciones} esGestor={esGestor} soloLectura={soloLectura}
          proveedores={proveedores} onClose={() => setDetalleId(null)}
          onCambio={() => { setDetalleId(null); refrescar(); }} />
      )}

      {cargaMasiva && (
        <CargaMasiva onClose={() => setCargaMasiva(false)} onListo={() => { setCargaMasiva(false); refrescar(); }} />
      )}
    </div>
  );
}

function BarraEnvio({ ids, proveedores, onEnviado, onError }: {
  ids: string[]; proveedores: Proveedor[]; onEnviado: () => void; onError: (m: string) => void;
}) {
  const [proveedorSoatId, setProveedorSoatId] = useState('');
  const [enviando, setEnviando] = useState(false);
  const enviar = async () => {
    setEnviando(true);
    try {
      await api.post('/flito/soat/enviar', { ids, ...(proveedorSoatId ? { proveedorSoatId } : {}) });
      onEnviado();
    } catch (e) { onError(errorMessage(e)); }
    finally { setEnviando(false); }
  };
  return (
    <FlitCard>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-semibold" style={{ color: 'var(--flit-blue-text)' }}>{ids.length} seleccionado(s)</span>
        <select className={`${flitInp} max-w-xs`} value={proveedorSoatId} onChange={(e) => setProveedorSoatId(e.target.value)}>
          <option value="">Proveedor por regla de enrutamiento</option>
          {proveedores.filter((p) => p.activo).map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
        </select>
        <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={enviando} onClick={enviar}>
          {enviando ? 'Enviando…' : 'Enviar al gestor'}
        </button>
      </div>
    </FlitCard>
  );
}

type Accion = 'idle' | 'rechazar' | 'reactivar' | 'reversar' | 'proveedor' | 'factura';

function DetalleSoat({ soat, esOperaciones, esGestor, soloLectura, proveedores, onClose, onCambio }: {
  soat: SoatItem; esOperaciones: boolean; esGestor: boolean; soloLectura: boolean;
  proveedores: Proveedor[]; onClose: () => void; onCambio: () => void;
}) {
  const [accion, setAccion] = useState<Accion>('idle');
  const [motivo, setMotivo] = useState('');
  const [estadoDestino, setEstadoDestino] = useState<EstadoSoat>(EstadoSoat.PENDIENTE);
  const [proveedorSoatId, setProveedorSoatId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const enAdquisicion = soat.estado === EstadoSoat.SOLICITADO;
  const rechazado = soat.estado === EstadoSoat.CON_NOVEDAD;

  const ejecutar = async (fn: () => Promise<unknown>) => {
    setEnviando(true); setError(null);
    try { await fn(); onCambio(); }
    catch (e) { setError(errorMessage(e)); }
    finally { setEnviando(false); }
  };

  const subirFactura = (file: File) => ejecutar(() => {
    const form = new FormData(); form.append('archivo', file);
    return api.post(`/flito/soat/${soat.id}/factura`, form);
  });

  return (
    <FlitModal title={`SOAT · ${soat.placa ?? soat.vin}`} onClose={onClose} wide>
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip tone={TONO[soat.estado]}>{ESTADO_SOAT_LABEL[soat.estado]}</StatusChip>
          {soat.estancado && <StatusChip tone="warning">SLA vencido</StatusChip>}
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5">
          <Dato k="VIN" v={soat.vin} /><Dato k="Vehículo" v={`${soat.marca ?? ''} ${soat.linea ?? ''}`.trim() || '—'} />
          <Dato k="Compañía" v={soat.companiaNombre} /><Dato k="Organismo" v={soat.organismoNombre ?? '—'} />
          <Dato k="Proveedor" v={soat.proveedorSoatNombre ?? '—'} /><Dato k="Trámites FLIT" v={soat.tramitesFlit.join(', ') || '—'} />
          <Dato k="Enviado por" v={soat.enviadoPorNombre ?? '—'} /><Dato k="Enviado" v={fecha(soat.enviadoEn)} />
          <Dato k="Valor pagado" v={pesos(soat.valorPagado)} />
        </dl>

        {soat.compradores.length > 0 && (
          <div>
            <p className="mb-1 text-[11px] font-semibold uppercase" style={{ color: 'var(--flit-text-muted)' }}>Compradores</p>
            <ul className="space-y-0.5">
              {soat.compradores.map((c) => (
                <li key={c.orden} className="flex justify-between gap-3">
                  <span>{c.nombreCompleto} · {c.numeroDocumento}</span>
                  {c.porcentajeParticipacion !== null && <span className="tabular-nums">{c.porcentajeParticipacion}%</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {soat.motivoRechazo && <p className="rounded-md bg-red-50 p-2 text-red-700">Motivo de rechazo: {soat.motivoRechazo}</p>}
        {soloLectura && <div className="rounded-md bg-blue-50 p-2 text-blue-800">Solo lectura · Auditoría observa, no ejecuta acciones.</div>}
        {error && <p className="text-sm text-red-600">{error}</p>}

        {!soloLectura && accion === 'idle' && (
          <div className="flex flex-wrap gap-2 pt-1">
            {enAdquisicion && (esOperaciones || esGestor) && (
              <label className={`${flitBtnPrimary} cursor-pointer`} style={flitBtnPrimaryStyle}>
                {enviando ? 'Cargando…' : 'Cargar factura'}
                <input type="file" accept=".pdf,.png,.jpg,.jpeg" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) subirFactura(f); e.target.value = ''; }} />
              </label>
            )}
            {enAdquisicion && (esOperaciones || esGestor) && (
              <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setAccion('rechazar')}>Rechazar</button>
            )}
            {rechazado && esOperaciones && (
              <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setAccion('reactivar')}>Reactivar</button>
            )}
            {esOperaciones && (
              <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setAccion('reversar')}>Reversar</button>
            )}
            {esOperaciones && !enAdquisicion && (
              <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setAccion('proveedor')}>Cambiar proveedor</button>
            )}
          </div>
        )}

        {(accion === 'rechazar' || accion === 'reactivar') && (
          <FormMotivo etiqueta={accion === 'rechazar' ? 'Motivo del rechazo' : 'Motivo de la corrección'}
            motivo={motivo} setMotivo={setMotivo} enviando={enviando} onCancelar={() => { setAccion('idle'); setMotivo(''); }}
            onConfirmar={() => ejecutar(() => api.post(`/flito/soat/${soat.id}/${accion}`, { motivo }))} />
        )}

        {accion === 'reversar' && (
          <div className="rounded-lg border p-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
            <FlitField label="Estado destino">
              <select className={flitInp} value={estadoDestino} onChange={(e) => setEstadoDestino(e.target.value as EstadoSoat)}>
                {ESTADOS_OPERACIONES.map((e) => <option key={e} value={e}>{ESTADO_SOAT_LABEL[e]}</option>)}
              </select>
            </FlitField>
            <FormMotivo etiqueta="Motivo de la reversa (mín. 5 caracteres)" motivo={motivo} setMotivo={setMotivo}
              enviando={enviando} minLen={5} onCancelar={() => { setAccion('idle'); setMotivo(''); }}
              onConfirmar={() => ejecutar(() => api.post(`/flito/soat/${soat.id}/reversar`, { estadoDestino, motivo }))} />
          </div>
        )}

        {accion === 'proveedor' && (
          <div className="rounded-lg border p-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
            <FlitField label="Nuevo proveedor">
              <select className={flitInp} value={proveedorSoatId} onChange={(e) => setProveedorSoatId(e.target.value)}>
                <option value="">Selecciona…</option>
                {proveedores.filter((p) => p.activo).map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
              </select>
            </FlitField>
            <FormMotivo etiqueta="Motivo del cambio" motivo={motivo} setMotivo={setMotivo} enviando={enviando}
              deshabilitado={!proveedorSoatId} onCancelar={() => { setAccion('idle'); setMotivo(''); }}
              onConfirmar={() => ejecutar(() => api.post(`/flito/soat/${soat.id}/proveedor`, { proveedorSoatId, motivo }))} />
          </div>
        )}
      </div>
    </FlitModal>
  );
}

function Dato({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-[11px] uppercase" style={{ color: 'var(--flit-text-muted)' }}>{k}</dt>
      <dd className="font-medium">{v}</dd>
    </div>
  );
}

function FormMotivo({ etiqueta, motivo, setMotivo, enviando, minLen = 1, deshabilitado = false, onConfirmar, onCancelar }: {
  etiqueta: string; motivo: string; setMotivo: (v: string) => void; enviando: boolean; minLen?: number;
  deshabilitado?: boolean; onConfirmar: () => void; onCancelar: () => void;
}) {
  return (
    <div className="mt-2 space-y-2">
      <FlitField label={etiqueta}>
        <textarea className={`${flitInp} min-h-[64px]`} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
      </FlitField>
      <div className="flex gap-2">
        <button className={flitBtnPrimary} style={flitBtnPrimaryStyle}
          disabled={enviando || deshabilitado || motivo.trim().length < minLen} onClick={onConfirmar}>
          {enviando ? 'Enviando…' : 'Confirmar'}
        </button>
        <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onCancelar}>Cancelar</button>
      </div>
    </div>
  );
}

interface ResultadoMasivo {
  pagados: { archivo: string; detalle: string }[]; enRevision: { archivo: string; detalle: string }[];
  duplicados: { archivo: string; detalle: string }[]; noAsociados: { archivo: string; detalle: string }[];
}

function CargaMasiva({ onClose, onListo }: { onClose: () => void; onListo: () => void }) {
  const [archivos, setArchivos] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [resultado, setResultado] = useState<ResultadoMasivo | null>(null);

  const subir = async () => {
    if (archivos.length === 0) return;
    setEnviando(true); setError(null);
    try {
      const form = new FormData();
      for (const f of archivos) form.append('archivos', f);
      const r = await api.post<ResultadoMasivo>('/flito/soat/facturas', form);
      setResultado(r);
    } catch (e) { setError(errorMessage(e)); }
    finally { setEnviando(false); }
  };

  return (
    <FlitModal title="Carga masiva de facturas SOAT" onClose={resultado ? onListo : onClose} wide>
      {!resultado ? (
        <div className="space-y-3">
          <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            Sube varios PDF/imágenes o un ZIP. El OCR cruza cada comprobante con un SOAT solicitado: los que superan el umbral pasan a Pagado; el resto va a revisión.
          </p>
          <input type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.zip" className={flitInp}
            onChange={(e) => setArchivos(Array.from(e.target.files ?? []))} />
          {archivos.length > 0 && <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>{archivos.length} archivo(s) listos.</p>}
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex gap-2">
            <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={enviando || archivos.length === 0} onClick={subir}>
              {enviando ? 'Procesando…' : 'Subir y procesar'}
            </button>
            <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onClose}>Cancelar</button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <StatusChip tone="success">Pagados {resultado.pagados.length}</StatusChip>
            <StatusChip tone="warning">En revisión {resultado.enRevision.length}</StatusChip>
            <StatusChip tone="neutral">Duplicados {resultado.duplicados.length}</StatusChip>
            <StatusChip tone="danger">Sin asociar {resultado.noAsociados.length}</StatusChip>
          </div>
          <TablaResultadoOcr resultado={resultado} />
          <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} onClick={onListo}>Listo</button>
        </div>
      )}
    </FlitModal>
  );
}

// Resultado del OCR masivo en TABLA: cada archivo analizado en su propia fila (archivo · resultado ·
// detalle), en vez de listas apretadas.
function TablaResultadoOcr({ resultado }: { resultado: ResultadoMasivo }) {
  const filas: { archivo: string; detalle: string; resultado: string; tono: ChipTone }[] = [
    ...resultado.pagados.map((i) => ({ ...i, resultado: 'Pagado', tono: 'success' as ChipTone })),
    ...resultado.enRevision.map((i) => ({ ...i, resultado: 'En revisión', tono: 'warning' as ChipTone })),
    ...resultado.duplicados.map((i) => ({ ...i, resultado: 'Duplicado', tono: 'neutral' as ChipTone })),
    ...resultado.noAsociados.map((i) => ({ ...i, resultado: 'Sin asociar', tono: 'danger' as ChipTone })),
  ];
  if (filas.length === 0) return <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>No se procesó ningún archivo.</p>;
  const th = 'px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide';
  return (
    <div className="max-h-[55vh] overflow-auto rounded-lg border" style={{ borderColor: 'var(--flit-border-soft)' }}>
      <table className="w-full text-sm">
        <thead>
          <tr style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>
            <th className={th}>Archivo</th><th className={th}>Resultado</th><th className={th}>Detalle del análisis OCR</th>
          </tr>
        </thead>
        <tbody>
          {filas.map((f, idx) => (
            <tr key={idx} className="border-t" style={{ borderColor: 'var(--flit-border-soft)' }}>
              <td className="px-3 py-2 font-medium align-top" style={{ color: 'var(--flit-text-primary)' }}>{f.archivo}</td>
              <td className="px-3 py-2 align-top"><StatusChip tone={f.tono}>{f.resultado}</StatusChip></td>
              <td className="px-3 py-2 align-top" style={{ color: 'var(--flit-text-secondary)' }}>{f.detalle}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
