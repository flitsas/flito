// FLITO — Impuestos (Fase 6). Porta packages/client/src/paginas/impuestos/* al kit flit/ + api.
// Cola con las 2 fronteras (resueltas en el backend: autogestión CA-05, organismo del gestor CA-10).
// Factura de venta como precondición del envío, envío atómico al gestor, carga masiva de recibos
// (→ Pagado) y rechazo/reactivación/reversa. Operaciones ve todo; el gestor solo su organismo y
// nunca los Pendiente; Auditoría es solo lectura.

import { puedeOperar } from '../lib/permissions';
import { useEffect, useMemo, useState } from 'react';
import { ESTADO_IMPUESTO_LABEL, EstadoImpuesto } from '@operaciones/shared-types';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import FlitModal from '../components/flit/FlitModal';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import {
  FlitCard, FlitTable, FlitTh, FlitTr, FlitField, FlitEmpty, FlitPillGroup, FlitPillButton,
  flitInp, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../components/flit/flitPageKit';

interface ImpuestoItem {
  id: string; tramiteId: string; idFlit: string; placa: string | null; vin: string;
  estado: EstadoImpuesto; compradorNombre: string | null; compradorDocumento: string | null;
  companiaNombre: string; organismoCodigo: string; organismoNombre: string | null;
  valorLiquidado: number | null; valorPagado: number | null; marcadoPorDiferencia: boolean;
  tieneFacturaVenta: boolean; enviadoPorNombre: string | null; enviadoEn: string | null;
  estancado: boolean; motivoRechazo: string | null; creadoEn: string;
}

const TONO: Record<EstadoImpuesto, ChipTone> = {
  sin_factura: 'draft', retenido: 'warning', pendiente: 'draft', en_gestion: 'active',
  pagado: 'success', rechazado: 'danger', no_aplica: 'neutral',
};
const pesos = (v: number | null) => v === null ? '—'
  : new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(v);
const fecha = (iso: string | null) => iso ? new Date(iso).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' }) : '—';

const ESTADOS_OPERACIONES: EstadoImpuesto[] = [
  EstadoImpuesto.SIN_FACTURA, EstadoImpuesto.RETENIDO, EstadoImpuesto.PENDIENTE,
  EstadoImpuesto.EN_GESTION, EstadoImpuesto.PAGADO, EstadoImpuesto.RECHAZADO, EstadoImpuesto.NO_APLICA,
];
const ESTADOS_GESTOR: EstadoImpuesto[] = [EstadoImpuesto.EN_GESTION, EstadoImpuesto.PAGADO];

export default function FlitoImpuestos() {
  const { user } = useAuth();
  const esOperaciones = puedeOperar(user?.role);
  const esGestor = user?.role === 'gestor_impuestos';
  const soloLectura = user?.role === 'auditor';

  const estadosDisponibles = esGestor ? ESTADOS_GESTOR : ESTADOS_OPERACIONES;
  const [estado, setEstado] = useState<EstadoImpuesto | 'todos'>(esGestor ? EstadoImpuesto.EN_GESTION : 'todos');
  const [buscar, setBuscar] = useState('');
  const [data, setData] = useState<ImpuestoItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set());
  const [detalleId, setDetalleId] = useState<string | null>(null);
  const [cargaRecibos, setCargaRecibos] = useState(false);
  const [recarga, setRecarga] = useState(0);

  useEffect(() => {
    setError(null); setData(null); setSeleccion(new Set());
    const q = new URLSearchParams();
    if (estado !== 'todos') q.set('estado', estado);
    if (buscar.trim()) q.set('buscar', buscar.trim());
    api.get<ImpuestoItem[]>(`/flito/impuestos?${q}`).then(setData).catch((e) => setError(errorMessage(e)));
  }, [estado, buscar, recarga]);

  const filas = data ?? [];
  const seleccionables = useMemo(() => filas.filter((f) => f.estado === EstadoImpuesto.PENDIENTE), [filas]);
  const detalle = filas.find((f) => f.id === detalleId) ?? null;
  const refrescar = () => setRecarga((n) => n + 1);

  const toggle = (id: string) => setSeleccion((s) => {
    const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n;
  });

  return (
    <div className="space-y-4">
      <PageHeaderCard
        title="Impuestos"
        subtitle="Gestión del impuesto vehicular por organismo. La factura de venta es precondición del envío; el pago deriva del recibo validado."
        actions={(esOperaciones || esGestor) && (
          <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} onClick={() => setCargaRecibos(true)}>
            Cargar recibos (masivo)
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
              <FlitPillButton key={e} active={estado === e} onClick={() => setEstado(e)}>{ESTADO_IMPUESTO_LABEL[e]}</FlitPillButton>
            ))}
          </FlitPillGroup>
          <input className={`${flitInp} max-w-xs`} placeholder="Buscar placa, VIN, trámite, comprador…"
            value={buscar} onChange={(e) => setBuscar(e.target.value)} />
        </div>
      </FlitCard>

      {error && <FlitCard><p className="text-sm text-red-600">{error}</p></FlitCard>}

      {esOperaciones && seleccion.size > 0 && (
        <BarraEnvio ids={[...seleccion]} onEnviado={() => { setSeleccion(new Set()); refrescar(); }} onError={setError} />
      )}

      {data && filas.length === 0 && (
        <FlitCard><FlitEmpty>No hay impuestos en esta vista. Sincroniza desde el Tablero para traer trámites nuevos.</FlitEmpty></FlitCard>
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
                <FlitTh>Placa</FlitTh><FlitTh>Trámite</FlitTh><FlitTh>Compañía</FlitTh>
                <FlitTh>Organismo</FlitTh><FlitTh>Estado</FlitTh><FlitTh>Liquidado</FlitTh><FlitTh>Pagado</FlitTh><FlitTh />
              </FlitTr>
            </thead>
            <tbody>
              {filas.map((f) => (
                <FlitTr key={f.id}>
                  {esOperaciones && seleccionables.length > 0 && (
                    <td className="px-3 py-2">
                      {f.estado === EstadoImpuesto.PENDIENTE && (
                        <input type="checkbox" aria-label={`Seleccionar ${f.placa}`}
                          checked={seleccion.has(f.id)} onChange={() => toggle(f.id)} />
                      )}
                    </td>
                  )}
                  <td className="px-3 py-2 font-medium">
                    {f.placa ?? '—'}
                    <div className="text-[11px] tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>{f.vin}</div>
                  </td>
                  <td className="px-3 py-2 text-xs tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>{f.idFlit}</td>
                  <td className="px-3 py-2 text-sm">{f.companiaNombre}</td>
                  <td className="px-3 py-2 text-sm">{f.organismoNombre ?? f.organismoCodigo}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-col items-start gap-1">
                      <StatusChip tone={TONO[f.estado]}>{ESTADO_IMPUESTO_LABEL[f.estado]}</StatusChip>
                      {f.estancado && <StatusChip tone="warning">SLA vencido</StatusChip>}
                      {f.marcadoPorDiferencia && <StatusChip tone="warning">Diferencia de valor</StatusChip>}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-sm tabular-nums">{pesos(f.valorLiquidado)}</td>
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
        <DetalleImpuesto imp={detalle} esOperaciones={esOperaciones} esGestor={esGestor} soloLectura={soloLectura}
          onClose={() => setDetalleId(null)} onCambio={() => { setDetalleId(null); refrescar(); }} />
      )}

      {cargaRecibos && (
        <CargaRecibos onClose={() => setCargaRecibos(false)} onListo={() => { setCargaRecibos(false); refrescar(); }} />
      )}
    </div>
  );
}

function BarraEnvio({ ids, onEnviado, onError }: { ids: string[]; onEnviado: () => void; onError: (m: string) => void }) {
  const [enviando, setEnviando] = useState(false);
  const enviar = async () => {
    setEnviando(true);
    try { await api.post('/flito/impuestos/enviar', { ids }); onEnviado(); }
    catch (e) { onError(errorMessage(e)); }
    finally { setEnviando(false); }
  };
  return (
    <FlitCard>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-semibold" style={{ color: 'var(--flit-blue-text)' }}>{ids.length} seleccionado(s)</span>
        <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={enviando} onClick={enviar}>
          {enviando ? 'Enviando…' : 'Enviar al gestor'}
        </button>
      </div>
    </FlitCard>
  );
}

type Accion = 'idle' | 'rechazar' | 'reactivar' | 'reversar';

function DetalleImpuesto({ imp, esOperaciones, esGestor, soloLectura, onClose, onCambio }: {
  imp: ImpuestoItem; esOperaciones: boolean; esGestor: boolean; soloLectura: boolean;
  onClose: () => void; onCambio: () => void;
}) {
  const [accion, setAccion] = useState<Accion>('idle');
  const [motivo, setMotivo] = useState('');
  const [estadoDestino, setEstadoDestino] = useState<EstadoImpuesto>(EstadoImpuesto.PENDIENTE);
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const enGestion = imp.estado === EstadoImpuesto.EN_GESTION;
  const rechazado = imp.estado === EstadoImpuesto.RECHAZADO;
  const sinFactura = imp.estado === EstadoImpuesto.SIN_FACTURA;

  const ejecutar = async (fn: () => Promise<unknown>) => {
    setEnviando(true); setError(null);
    try { await fn(); onCambio(); }
    catch (e) { setError(errorMessage(e)); }
    finally { setEnviando(false); }
  };

  const subirFacturaVenta = (file: File) => ejecutar(() => {
    const form = new FormData(); form.append('archivo', file);
    return api.post(`/flito/impuestos/${imp.id}/factura-venta`, form);
  });

  return (
    <FlitModal title={`Impuesto · ${imp.placa ?? imp.vin}`} onClose={onClose} wide>
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip tone={TONO[imp.estado]}>{ESTADO_IMPUESTO_LABEL[imp.estado]}</StatusChip>
          {imp.estancado && <StatusChip tone="warning">SLA vencido</StatusChip>}
          {imp.marcadoPorDiferencia && <StatusChip tone="warning">Diferencia de valor</StatusChip>}
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5">
          <Dato k="VIN" v={imp.vin} /><Dato k="Trámite FLIT" v={imp.idFlit} />
          <Dato k="Compañía" v={imp.companiaNombre} /><Dato k="Organismo" v={imp.organismoNombre ?? imp.organismoCodigo} />
          <Dato k="Comprador" v={imp.compradorNombre ?? '—'} /><Dato k="Documento" v={imp.compradorDocumento ?? '—'} />
          <Dato k="Valor liquidado" v={pesos(imp.valorLiquidado)} /><Dato k="Valor pagado" v={pesos(imp.valorPagado)} />
          <Dato k="Factura de venta" v={imp.tieneFacturaVenta ? 'Cargada' : 'Falta'} />
          <Dato k="Enviado por" v={imp.enviadoPorNombre ?? '—'} /><Dato k="Enviado" v={fecha(imp.enviadoEn)} />
        </dl>

        {imp.motivoRechazo && <p className="rounded-md bg-red-50 p-2 text-red-700">Motivo de rechazo: {imp.motivoRechazo}</p>}
        {soloLectura && <div className="rounded-md bg-blue-50 p-2 text-blue-800">Solo lectura · Auditoría observa, no ejecuta acciones.</div>}
        {error && <p className="text-sm text-red-600">{error}</p>}

        {!soloLectura && accion === 'idle' && (
          <div className="flex flex-wrap gap-2 pt-1">
            {sinFactura && esOperaciones && (
              <label className={`${flitBtnPrimary} cursor-pointer`} style={flitBtnPrimaryStyle}>
                {enviando ? 'Cargando…' : 'Cargar factura de venta'}
                <input type="file" accept=".pdf,.png,.jpg,.jpeg" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) subirFacturaVenta(f); e.target.value = ''; }} />
              </label>
            )}
            {enGestion && (esOperaciones || esGestor) && (
              <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setAccion('rechazar')}>Rechazar</button>
            )}
            {rechazado && esOperaciones && (
              <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setAccion('reactivar')}>Reactivar</button>
            )}
            {esOperaciones && (
              <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setAccion('reversar')}>Reversar</button>
            )}
          </div>
        )}

        {(accion === 'rechazar' || accion === 'reactivar') && (
          <FormMotivo etiqueta={accion === 'rechazar' ? 'Motivo del rechazo' : 'Motivo de la corrección'}
            motivo={motivo} setMotivo={setMotivo} enviando={enviando} onCancelar={() => { setAccion('idle'); setMotivo(''); }}
            onConfirmar={() => ejecutar(() => api.post(`/flito/impuestos/${imp.id}/${accion}`, { motivo }))} />
        )}

        {accion === 'reversar' && (
          <div className="rounded-lg border p-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
            <FlitField label="Estado destino">
              <select className={flitInp} value={estadoDestino} onChange={(e) => setEstadoDestino(e.target.value as EstadoImpuesto)}>
                {ESTADOS_OPERACIONES.map((e) => <option key={e} value={e}>{ESTADO_IMPUESTO_LABEL[e]}</option>)}
              </select>
            </FlitField>
            <FormMotivo etiqueta="Motivo de la reversa (mín. 5 caracteres)" motivo={motivo} setMotivo={setMotivo}
              enviando={enviando} minLen={5} onCancelar={() => { setAccion('idle'); setMotivo(''); }}
              onConfirmar={() => ejecutar(() => api.post(`/flito/impuestos/${imp.id}/reversar`, { estadoDestino, motivo }))} />
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

function FormMotivo({ etiqueta, motivo, setMotivo, enviando, minLen = 1, onConfirmar, onCancelar }: {
  etiqueta: string; motivo: string; setMotivo: (v: string) => void; enviando: boolean; minLen?: number;
  onConfirmar: () => void; onCancelar: () => void;
}) {
  return (
    <div className="mt-2 space-y-2">
      <FlitField label={etiqueta}>
        <textarea className={`${flitInp} min-h-[64px]`} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
      </FlitField>
      <div className="flex gap-2">
        <button className={flitBtnPrimary} style={flitBtnPrimaryStyle}
          disabled={enviando || motivo.trim().length < minLen} onClick={onConfirmar}>
          {enviando ? 'Enviando…' : 'Confirmar'}
        </button>
        <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onCancelar}>Cancelar</button>
      </div>
    </div>
  );
}

interface ResultadoRecibos {
  conciliados: { archivo: string; detalle: string }[]; enRevision: { archivo: string; detalle: string }[];
  complementos: { archivo: string; detalle: string }[]; duplicados: { archivo: string; detalle: string }[];
  noAsociados: { archivo: string; detalle: string }[];
}

function CargaRecibos({ onClose, onListo }: { onClose: () => void; onListo: () => void }) {
  const [archivos, setArchivos] = useState<File[]>([]);
  const [sinMarca, setSinMarca] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [resultado, setResultado] = useState<ResultadoRecibos | null>(null);

  const subir = async () => {
    if (archivos.length === 0) return;
    setEnviando(true); setError(null);
    try {
      const form = new FormData();
      for (const f of archivos) form.append('archivos', f);
      form.append('sinMarcaDeAgua', String(sinMarca));
      const r = await api.post<ResultadoRecibos>('/flito/impuestos/recibos', form);
      setResultado(r);
    } catch (e) { setError(errorMessage(e)); }
    finally { setEnviando(false); }
  };

  return (
    <FlitModal title="Carga masiva de recibos de impuesto" onClose={resultado ? onListo : onClose} wide>
      {!resultado ? (
        <div className="space-y-3">
          <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            Sube varios PDF/imágenes o un ZIP. El OCR cruza cada recibo con su impuesto en gestión por la placa; los que cuadran pasan a Pagado, el resto va a revisión.
          </p>
          <input type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.zip" className={flitInp}
            onChange={(e) => setArchivos(Array.from(e.target.files ?? []))} />
          <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            <input type="checkbox" checked={sinMarca} onChange={(e) => setSinMarca(e.target.checked)} />
            Archivos sueltos sin marca de agua (en ZIP se deduce por carpeta)
          </label>
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
        <div className="space-y-3 text-sm">
          <GrupoResultado titulo="Conciliados" tono="success" items={resultado.conciliados} />
          <GrupoResultado titulo="En revisión" tono="warning" items={resultado.enRevision} />
          <GrupoResultado titulo="Complementos" tono="active" items={resultado.complementos} />
          <GrupoResultado titulo="Duplicados" tono="neutral" items={resultado.duplicados} />
          <GrupoResultado titulo="Sin asociar" tono="danger" items={resultado.noAsociados} />
          <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} onClick={onListo}>Listo</button>
        </div>
      )}
    </FlitModal>
  );
}

function GrupoResultado({ titulo, tono, items }: { titulo: string; tono: ChipTone; items: { archivo: string; detalle: string }[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <StatusChip tone={tono}>{titulo} ({items.length})</StatusChip>
      <ul className="mt-1 space-y-0.5">
        {items.map((i, idx) => (
          <li key={idx} className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
            <span className="font-medium">{i.archivo}</span> — {i.detalle}
          </li>
        ))}
      </ul>
    </div>
  );
}
