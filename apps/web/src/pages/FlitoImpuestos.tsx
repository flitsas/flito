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
import AntiguedadPill from '../components/flit/AntiguedadPill';
import ThFiltroMulti from '../components/flit/ThFiltroMulti';
import ChipSinGestion from '../components/flit/ChipSinGestion';
import Paginacion from '../components/flit/Paginacion';
import useDebounce from '../lib/useDebounce';
import {
  FlitCard, FlitTable, FlitTh, FlitTr, FlitField, FlitEmpty, FlitPillGroup, FlitPillButton,
  flitInp, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../components/flit/flitPageKit';

interface ImpuestoItem {
  id: string; tramiteId: string; idFlit: string; placa: string | null; vin: string;
  estado: EstadoImpuesto; compradorNombre: string | null; compradorDocumento: string | null;
  companiaNombre: string; organismoCodigo: string; organismoNombre: string | null;
  valorLiquidado: number | null; valorPagado: number | null; marcadoPorDiferencia: boolean;
  tieneFacturaVenta: boolean; enviadoPorNombre: string | null; enviadoEn: string | null; pagadoEn: string | null;
  estancado: boolean; motivoRechazo: string | null; creadoEn: string;
}
interface ColaImpuestos { items: ImpuestoItem[]; total: number; page: number; pageSize: number }
interface FacetasImpuestos {
  companias: { id: number; nombre: string }[];
  organismos: { codigo: string; nombre: string | null }[];
}

const TONO: Record<EstadoImpuesto, ChipTone> = {
  pendiente: 'draft', solicitado: 'active', con_novedad: 'danger', pagado: 'success',
};
const pesos = (v: number | null) => v === null ? '—'
  : new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(v);
const fecha = (iso: string | null) => iso ? new Date(iso).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' }) : '—';

const ESTADOS_OPERACIONES: EstadoImpuesto[] = [
  EstadoImpuesto.PENDIENTE, EstadoImpuesto.SOLICITADO, EstadoImpuesto.CON_NOVEDAD, EstadoImpuesto.PAGADO,
];
const ESTADOS_GESTOR: EstadoImpuesto[] = [EstadoImpuesto.SOLICITADO, EstadoImpuesto.PAGADO];

export default function FlitoImpuestos() {
  const { user } = useAuth();
  const esOperaciones = puedeOperar(user?.role);
  const esGestor = user?.role === 'gestor_impuestos';
  const soloLectura = user?.role === 'auditor';

  const estadosDisponibles = esGestor ? ESTADOS_GESTOR : ESTADOS_OPERACIONES;
  const [estado, setEstado] = useState<EstadoImpuesto | 'todos'>(esGestor ? EstadoImpuesto.SOLICITADO : 'todos');
  const [texto, setTexto] = useState('');
  // Antes se consultaba en cada tecla; con la cola paginada eso es una consulta con COUNT por
  // pulsación. Se espera a que el usuario deje de escribir.
  const buscar = useDebounce(texto, 300);
  const [data, setData] = useState<ColaImpuestos | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set());
  const [detalleId, setDetalleId] = useState<string | null>(null);
  const [cargaRecibos, setCargaRecibos] = useState(false);
  const [recarga, setRecarga] = useState(0);

  const [facetas, setFacetas] = useState<FacetasImpuestos | null>(null);
  const [companiasSel, setCompaniasSel] = useState<string[]>([]);
  const [organismosSel, setOrganismosSel] = useState<string[]>([]);
  const [solicitadoDesde, setSolicitadoDesde] = useState('');
  const [solicitadoHasta, setSolicitadoHasta] = useState('');
  const [pagadoDesde, setPagadoDesde] = useState('');
  const [pagadoHasta, setPagadoHasta] = useState('');
  const [soloEstancado, setSoloEstancado] = useState(false);
  const [page, setPage] = useState(1);

  const compKey = companiasSel.join(','); const orgKey = organismosSel.join(',');

  const hayFiltros = companiasSel.length > 0 || organismosSel.length > 0
    || !!solicitadoDesde || !!solicitadoHasta || !!pagadoDesde || !!pagadoHasta || soloEstancado;

  const limpiarFiltros = () => {
    setCompaniasSel([]); setOrganismosSel([]);
    setSolicitadoDesde(''); setSolicitadoHasta(''); setPagadoDesde(''); setPagadoHasta('');
    setSoloEstancado(false); setTexto('');
  };

  // Cualquier cambio de filtro vuelve a la página 1: si no, se queda en una página que ya no existe.
  useEffect(() => { setPage(1); }, [estado, buscar, compKey, orgKey, solicitadoDesde, solicitadoHasta, pagadoDesde, pagadoHasta, soloEstancado]);

  useEffect(() => {
    setError(null); setSeleccion(new Set());
    const q = new URLSearchParams();
    if (estado !== 'todos') q.set('estado', estado);
    if (buscar.trim()) q.set('buscar', buscar.trim());
    if (companiasSel.length) q.set('companias', companiasSel.join(','));
    if (organismosSel.length) q.set('organismos', organismosSel.join(','));
    if (solicitadoDesde) q.set('solicitadoDesde', solicitadoDesde);
    if (solicitadoHasta) q.set('solicitadoHasta', solicitadoHasta);
    if (pagadoDesde) q.set('pagadoDesde', pagadoDesde);
    if (pagadoHasta) q.set('pagadoHasta', pagadoHasta);
    if (soloEstancado) q.set('estancado', 'si');
    q.set('page', String(page));
    api.get<ColaImpuestos>(`/flito/impuestos?${q}`).then(setData).catch((e) => setError(errorMessage(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estado, buscar, compKey, orgKey, solicitadoDesde, solicitadoHasta, pagadoDesde, pagadoHasta, soloEstancado, page, recarga]);

  useEffect(() => {
    api.get<FacetasImpuestos>('/flito/impuestos/facetas').then(setFacetas).catch(() => setFacetas(null));
  }, []);

  const filas = data?.items ?? [];
  const totalPaginas = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
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
            value={texto} onChange={(e) => setTexto(e.target.value)} />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-3">
          <ThFiltroMulti seleccion={companiasSel} onCambio={setCompaniasSel} placeholder="Compañía"
            vacio="Sin compañías en la cola"
            opciones={(facetas?.companias ?? []).map((c) => ({ value: String(c.id), label: c.nombre }))} />
          {/* Al gestor no se le ofrece: ya está atado a su organismo y elegir otro solo vaciaría la cola. */}
          {!esGestor && (
            <ThFiltroMulti seleccion={organismosSel} onCambio={setOrganismosSel} placeholder="Organismo"
              vacio="Sin organismos en la cola"
              opciones={(facetas?.organismos ?? []).map((o) => ({ value: o.codigo, label: o.nombre ?? o.codigo }))} />
          )}

          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>Solicitado</span>
            <input type="date" aria-label="Solicitado desde" className={flitInp} value={solicitadoDesde} onChange={(e) => setSolicitadoDesde(e.target.value)} />
            <span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>a</span>
            <input type="date" aria-label="Solicitado hasta" className={flitInp} value={solicitadoHasta} onChange={(e) => setSolicitadoHasta(e.target.value)} />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>Pagado</span>
            <input type="date" aria-label="Pagado desde" className={flitInp} value={pagadoDesde} onChange={(e) => setPagadoDesde(e.target.value)} />
            <span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>a</span>
            <input type="date" aria-label="Pagado hasta" className={flitInp} value={pagadoHasta} onChange={(e) => setPagadoHasta(e.target.value)} />
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
            <input type="checkbox" checked={soloEstancado} onChange={(e) => setSoloEstancado(e.target.checked)} />
            Solo sin gestión
          </label>

          {(hayFiltros || !!texto) && (
            <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={limpiarFiltros}>Limpiar filtros</button>
          )}
        </div>
      </FlitCard>

      {error && <FlitCard><p className="text-sm text-red-600">{error}</p></FlitCard>}

      {esOperaciones && seleccion.size > 0 && (
        <BarraEnvio ids={[...seleccion]} onEnviado={() => { setSeleccion(new Set()); refrescar(); }} onError={setError} />
      )}

      {data && filas.length === 0 && (
        <FlitCard>
          <FlitEmpty>
            {hayFiltros || texto.trim()
              ? 'Ningún impuesto coincide con los filtros.'
              : 'No hay impuestos en esta vista. Sincroniza desde el Tablero para traer trámites nuevos.'}
          </FlitEmpty>
        </FlitCard>
      )}

      {filas.length > 0 && (
        <FlitCard>
          <div className="mb-3">
            <Paginacion total={data!.total} page={data!.page} totalPaginas={totalPaginas} sustantivo="impuestos"
              onPrev={() => setPage((p) => Math.max(1, p - 1))} onNext={() => setPage((p) => p + 1)} />
          </div>
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
                <FlitTh>Organismo</FlitTh><FlitTh>Estado</FlitTh>
                <FlitTh>Solicitado</FlitTh><FlitTh>Fecha pago</FlitTh>
                <FlitTh>Liquidado</FlitTh><FlitTh>Pagado</FlitTh><FlitTh />
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
                      {f.estancado && <ChipSinGestion desde={f.enviadoEn} />}
                      {f.marcadoPorDiferencia && <StatusChip tone="warning">Diferencia de valor</StatusChip>}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-sm">
                    <div className="tabular-nums">{f.enviadoEn ? fecha(f.enviadoEn) : '—'}</div>
                    {/* Ya pagado: los días desde la solicitud dejan de ser señal de riesgo y solo
                        ensucian. El chip de sin gestión ya desaparece al pagar. */}
                    {f.enviadoEn && f.estado !== EstadoImpuesto.PAGADO && (
                      <div className="mt-1"><AntiguedadPill desde={f.enviadoEn} /></div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-sm tabular-nums">{f.pagadoEn ? fecha(f.pagadoEn) : '—'}</td>
                  <td className="px-3 py-2 text-sm tabular-nums">{pesos(f.valorLiquidado)}</td>
                  <td className="px-3 py-2 text-sm tabular-nums">{pesos(f.valorPagado)}</td>
                  <td className="px-3 py-2">
                    <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setDetalleId(f.id)}>Ver</button>
                  </td>
                </FlitTr>
              ))}
            </tbody>
          </FlitTable>
          <div className="mt-3">
            <Paginacion total={data!.total} page={data!.page} totalPaginas={totalPaginas} sustantivo="impuestos"
              onPrev={() => setPage((p) => Math.max(1, p - 1))} onNext={() => setPage((p) => p + 1)} />
          </div>
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

  const enGestion = imp.estado === EstadoImpuesto.SOLICITADO;
  const rechazado = imp.estado === EstadoImpuesto.CON_NOVEDAD;

  const ejecutar = async (fn: () => Promise<unknown>) => {
    setEnviando(true); setError(null);
    try { await fn(); onCambio(); }
    catch (e) { setError(errorMessage(e)); }
    finally { setEnviando(false); }
  };

  // Factura de venta: viene de FLIT. Ver/descargar via presigned (el endpoint redirige; se sigue el
  // redirect y se abre el blob). Integración FLIT (Fase 8).
  const verFactura = async () => {
    setError(null);
    try {
      const blob = await api.get<Blob>(`/flito/impuestos/${imp.id}/factura-venta`);
      window.open(URL.createObjectURL(blob), '_blank', 'noopener');
    } catch (e) { setError(errorMessage(e)); }
  };

  return (
    <FlitModal title={`Impuesto · ${imp.placa ?? imp.vin}`} onClose={onClose} wide>
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip tone={TONO[imp.estado]}>{ESTADO_IMPUESTO_LABEL[imp.estado]}</StatusChip>
          {imp.estancado && <ChipSinGestion desde={imp.enviadoEn} />}
          {imp.marcadoPorDiferencia && <StatusChip tone="warning">Diferencia de valor</StatusChip>}
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5">
          <Dato k="VIN" v={imp.vin} /><Dato k="Trámite FLIT" v={imp.idFlit} />
          <Dato k="Compañía" v={imp.companiaNombre} /><Dato k="Organismo" v={imp.organismoNombre ?? imp.organismoCodigo} />
          <Dato k="Comprador" v={imp.compradorNombre ?? '—'} /><Dato k="Documento" v={imp.compradorDocumento ?? '—'} />
          <Dato k="Valor liquidado" v={pesos(imp.valorLiquidado)} /><Dato k="Valor pagado" v={pesos(imp.valorPagado)} />
          <div>
            <dt className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>Factura de venta</dt>
            <dd className="text-sm">
              {imp.tieneFacturaVenta
                ? <button className="font-semibold underline" style={{ color: 'var(--flit-blue-text)' }} onClick={verFactura}>En FLIT · Ver / descargar</button>
                : <span style={{ color: 'var(--flit-warning)' }}>Sin factura en FLIT</span>}
            </dd>
          </div>
          <Dato k="Enviado por" v={imp.enviadoPorNombre ?? '—'} /><Dato k="Enviado" v={fecha(imp.enviadoEn)} />
        </dl>

        {imp.motivoRechazo && <p className="rounded-md bg-red-50 p-2 text-red-700">Motivo de rechazo: {imp.motivoRechazo}</p>}
        {soloLectura && <div className="rounded-md bg-blue-50 p-2 text-blue-800">Solo lectura · Auditoría observa, no ejecuta acciones.</div>}
        {error && <p className="text-sm text-red-600">{error}</p>}

        {!soloLectura && accion === 'idle' && (
          <div className="flex flex-wrap gap-2 pt-1">
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
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <StatusChip tone="success">Conciliados {resultado.conciliados.length}</StatusChip>
            <StatusChip tone="warning">En revisión {resultado.enRevision.length}</StatusChip>
            <StatusChip tone="active">Complementos {resultado.complementos.length}</StatusChip>
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

// Resultado del OCR masivo en TABLA: cada recibo analizado en su propia fila.
function TablaResultadoOcr({ resultado }: { resultado: ResultadoRecibos }) {
  const filas: { archivo: string; detalle: string; resultado: string; tono: ChipTone }[] = [
    ...resultado.conciliados.map((i) => ({ ...i, resultado: 'Conciliado', tono: 'success' as ChipTone })),
    ...resultado.enRevision.map((i) => ({ ...i, resultado: 'En revisión', tono: 'warning' as ChipTone })),
    ...resultado.complementos.map((i) => ({ ...i, resultado: 'Complemento', tono: 'active' as ChipTone })),
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
