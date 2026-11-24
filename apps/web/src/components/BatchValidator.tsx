import { useState, useRef, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import toast from 'react-hot-toast';
import { flitInp, FlitCard } from './flit/flitPageKit';
import GradientButton, { claseBoton } from './flit/GradientButton';
import StatusChip from './flit/StatusChip';
import DataTable, { type ColumnaTabla } from './flit/DataTable';
import Placa from './flit/Placa';
import { Girador } from './flit/Cargador';
import { Icono } from './flit/kit/Icono';

interface BatchResult {
  vin: string; plate: string | null; ownerName: string | null;
  brand: string | null; model: string | null;
  linea: string | null; claseVehiculo: string | null;
  docType: string | null; docNumber: string | null;
  phone: string | null; email: string | null; city: string | null;
  soatInsurer: string | null; soatPolicy: string | null;
  soatExpiry: string | null; soatStatus: string | null;
  hasSoat: boolean; runtOk: boolean; error: string | null;
}

interface SingleVeh {
  placa?: string; marca?: string; linea?: string; modelo?: string;
  claseVehiculo?: string; clase?: string; estadoAutomotor?: string;
  tipoServicio?: string; color?: string; tipoCombustible?: string;
}
interface SingleSoat {
  numSoat?: string; razonSocialAsegur?: string;
  fechaInicioPoliza?: string; fechaVencimSoat?: string;
}
interface Solicitud { entidad?: string; estado?: string; tramitesRealizados?: string; }
interface SingleResult {
  veh: SingleVeh;
  soat: SingleSoat | null;
  solicitudes: Solicitud[] | null;
  tipoDocPropietario?: string;
}

interface Props {
  onSendToRequests?: (items: BatchResult[]) => void;
}

interface SoatReq { id: number; vin: string; plate: string | null; ownerName: string | null; status: string; }
interface VerifiedData { numSoat?: string; razonSocialAsegur?: string; fechaInicioPoliza?: string; fechaVencimSoat?: string; }

const inputCls = `${flitInp} font-mono`;

export default function BatchValidator({ onSendToRequests }: Props) {
  const [singleVin, setSingleVin] = useState('');
  const [singleLoading, setSingleLoading] = useState(false);
  const [singleResult, setSingleResult] = useState<SingleResult | null>(null);

  const handleSingleVerify = async () => {
    if (!singleVin.trim()) { toast.error('Ingresa un VIN'); return; }
    setSingleLoading(true); setSingleResult(null);
    try {
      const res = await api.post<{ ok: boolean; data?: { vehiculo: SingleVeh; soat?: SingleSoat | SingleSoat[]; solicitudes?: Solicitud[]; tipoDocPropietario?: string }; message?: string }>('/runt/consulta-vehiculo', { vin: singleVin.trim() });
      if (res.ok && res.data) {
        const soat = Array.isArray(res.data.soat) ? res.data.soat[0] : res.data.soat ?? null;
        setSingleResult({ veh: res.data.vehiculo, soat, solicitudes: res.data.solicitudes ?? null, tipoDocPropietario: res.data.tipoDocPropietario });
      } else { toast.error(res.message || 'No encontrado en RUNT'); }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error';
      toast.error(msg);
    } finally { setSingleLoading(false); }
  };

  const [results, setResults] = useState<BatchResult[]>([]);
  const [summary, setSummary] = useState<{ total: number; withSoat: number; withoutSoat: number; errors: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const reloadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [purchased, setPurchased] = useState<SoatReq[]>([]);
  const [verifyingId, setVerifyingId] = useState<number | null>(null);
  const [transitioning, setTransitioning] = useState<number | null>(null);

  const loadPurchased = useCallback(async () => {
    const reqs = await api.get<SoatReq[]>('/soat?status=comprado');
    setPurchased(reqs);
  }, []);

  const [verifiedData, setVerifiedData] = useState<Record<number, VerifiedData>>({});
  const [failedIds, setFailedIds] = useState<Set<number>>(new Set());

  const verifyOne = async (req: SoatReq) => {
    setVerifyingId(req.id);
    setFailedIds((p) => { const n = new Set(p); n.delete(req.id); return n; });
    const token = localStorage.getItem('token');
    try {
      const refreshRes = await fetch(`/api/soat/${req.id}/refresh-runt`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
        // Tope duro: la cadena RUNT puede no responder; sin esto el spinner
        // (verifyingId) se queda colgado para siempre. Aborta a los 90s.
        signal: AbortSignal.timeout(90_000),
      });
      const refreshData = await refreshRes.json().catch(() => ({}));
      if (refreshData?.reason === 'SOAT_NOT_INDEXED_YET' || refreshData?.reason === 'OWNER_SYNC_PENDING') {
        setFailedIds((p) => new Set(p).add(req.id));
        return;
      }
      if (refreshRes.status === 404) { setFailedIds((p) => new Set(p).add(req.id)); return; }
      if (!refreshRes.ok) { toast.error(refreshData.error || 'No se pudo actualizar desde RUNT'); return; }

      const verifyRes = await fetch(`/api/soat/${req.id}/verify`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(90_000),
      });
      if (!verifyRes.ok) {
        const d = await verifyRes.json().catch(() => ({}));
        toast.error(d.error || 'Error al verificar');
        return;
      }

      setVerifiedData((p) => ({ ...p, [req.id]: {
        numSoat: refreshData.policyNumber,
        razonSocialAsegur: refreshData.insurer,
        fechaInicioPoliza: refreshData.purchaseDate,
        fechaVencimSoat: refreshData.expiryDate,
      } }));
      toast.success(`${req.plate || req.vin} — SOAT verificado`);
      setTransitioning(req.id);
      reloadTimeoutRef.current = setTimeout(() => {
        setPurchased((p) => p.filter((x) => x.id !== req.id));
        setTransitioning(null);
        setVerifiedData((p) => { const n = { ...p }; delete n[req.id]; return n; });
      }, 1500);
    } catch (err) {
      const msg = err instanceof DOMException && err.name === 'TimeoutError'
        ? 'La consulta a RUNT tardó demasiado. Intente de nuevo.'
        : err instanceof Error ? err.message : 'Error';
      toast.error(msg);
    }
    finally { setVerifyingId(null); }
  };

  useEffect(() => { loadPurchased(); }, [loadPurchased]);
  useEffect(() => () => { if (reloadTimeoutRef.current) clearTimeout(reloadTimeoutRef.current); }, []);

  const handleUpload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setLoading(true);
    setResults([]);
    setSummary(null);
    setProgress('Enviando archivo...');

    try {
      const form = new FormData();
      form.append('file', file);

      const token = localStorage.getItem('token');
      const response = await fetch('/api/soat/batch-validate', {
        method: 'POST',
        headers: token ? { 'Authorization': `Bearer ${token}` } : {},
        body: form,
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ message: 'Error' }));
        throw new Error(err.message || `Error ${response.status}`);
      }

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.t === 'progress') {
              setProgress(`${msg.i}/${msg.n} — ${msg.vin}`);
            } else if (msg.t === 'done') {
              setResults(msg.results);
              setSummary({ total: msg.total, withSoat: msg.withSoat, withoutSoat: msg.withoutSoat, errors: msg.errors });
              toast.success(`${msg.total} VINs procesados`);
            }
          } catch { /* skip malformed lines */ }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error';
      toast.error(msg);
    } finally {
      setLoading(false);
      setProgress('');
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleRegisterPurchased = async (vinValue: string, v: SingleVeh, s: SingleSoat | null) => {
    try {
      await api.post('/vehicles', {
        vin: vinValue, plate: v.placa || undefined,
        brand: v.marca || undefined, model: v.linea || undefined,
        year: parseInt(v.modelo || '') || undefined,
        vehicleClass: v.claseVehiculo || v.clase || undefined,
      }).catch(() => null);

      const vehs = await api.get<{ id: number; vin: string }[]>('/vehicles');
      const veh = vehs.find((vh) => vh.vin === vinValue);
      if (!veh) { toast.error('No se pudo encontrar el vehículo'); return; }

      await api.post('/soat', { vehicleIds: [veh.id] });

      const reqs = await api.get<{ id: number; vin: string }[]>('/soat?status=pendiente');
      const req = reqs.find((r) => r.vin === vinValue);
      if (req && s) {
        await api.patch(`/soat/${req.id}/purchase`, {
          policyNumber: s.numSoat, insurer: s.razonSocialAsegur,
          purchaseDate: s.fechaInicioPoliza?.split('T')[0],
          expiryDate: s.fechaVencimSoat?.split('T')[0],
        });
      }
      toast.success('Registrado como comprado');
      setSingleResult(null); setSingleVin(''); loadPurchased();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error registrando';
      toast.error(msg);
    }
  };

  const fmtDate = (d: string | null | undefined) => {
    if (!d) return '—';
    try { return new Date(d).toLocaleDateString('es-CO'); } catch { return d; }
  };

  const filasResultado = results.map((r, i) => ({ r, i }));
  const columnasResultado: ColumnaTabla<{ r: BatchResult; i: number }>[] = [
    { key: 'vin', header: 'VIN', render: ({ r }) => <span className="font-mono text-xs text-[color:var(--color-text-secondary)]">{r.vin}</span> },
    { key: 'placa', header: 'Placa', render: ({ r }) => (r.plate ? <Placa placa={r.plate} /> : <span className="text-[color:var(--color-text-tertiary)]">—</span>) },
    { key: 'propietario', header: 'Propietario', render: ({ r }) => <span className="block max-w-[150px] truncate text-xs">{r.ownerName || '—'}</span> },
    { key: 'vehiculo', header: 'Vehículo', render: ({ r }) => <span className="text-xs">{r.model || '—'}</span> },
    {
      key: 'soat', header: 'SOAT', render: ({ r }) => (r.hasSoat
        ? <StatusChip tone="success">Comprado</StatusChip>
        : r.runtOk ? <StatusChip tone="danger">Sin SOAT</StatusChip> : <StatusChip tone="warning">Error</StatusChip>),
    },
    { key: 'aseguradora', header: 'Aseguradora', render: ({ r }) => <span className="text-xs">{r.soatInsurer || '—'}</span> },
    { key: 'vencimiento', header: 'Vencimiento', render: ({ r }) => <span className="text-xs">{fmtDate(r.soatExpiry)}</span> },
    { key: 'estado', header: 'Estado', render: ({ r }) => <span className="text-xs text-[color:var(--color-text-tertiary)]">{r.error || r.soatStatus || '—'}</span> },
  ];

  return (
    <div>
      <FlitCard className="mb-4">
        <h3 className="mb-3 text-sm font-semibold text-[color:var(--color-text-primary)]">Consulta individual por VIN</h3>
        <div className="flex flex-wrap gap-2">
          <label className="min-w-0 flex-1 basis-[14rem]">
            <span className="sr-only">VIN del vehículo</span>
            <input value={singleVin} onChange={(e) => setSingleVin(e.target.value.toUpperCase())}
              placeholder="Ingresa el VIN del vehículo..."
              className={`${inputCls} font-mono`} />
          </label>
          <GradientButton type="button" onClick={handleSingleVerify} disabled={singleLoading} ocupado={singleLoading} className="shrink-0">
            {singleLoading ? 'Consultando...' : 'Consultar RUNT'}
          </GradientButton>
        </div>
        {singleResult && (() => {
          const v = singleResult.veh || {};
          const s = singleResult.soat;
          const lastSol = singleResult.solicitudes?.[0];
          return (
            <div className={`mt-3 overflow-hidden rounded-[9px] border ${s ? 'border-[color:var(--kit-verde)]' : 'border-[color:var(--kit-naranja)]'}`}>
              <div className="p-4">
                {v.placa && <div className="mb-3"><Placa placa={v.placa} /></div>}
                <div className="grid grid-cols-1 gap-x-4 gap-y-1.5 text-xs min-[380px]:grid-cols-2 lg:grid-cols-4">
                  <Dato etiqueta="Placa" valor={v.placa || '—'} fuerte />
                  <Dato etiqueta="Marca / Línea" valor={`${v.marca || '—'} ${v.linea || ''}`} />
                  <Dato etiqueta="Modelo" valor={v.modelo || '—'} />
                  <Dato etiqueta="Clase" valor={v.claseVehiculo || v.clase || '—'} />
                  <Dato etiqueta="Estado vehículo" valor={v.estadoAutomotor || '—'} />
                  <Dato etiqueta="Servicio" valor={v.tipoServicio || '—'} />
                  <Dato etiqueta="Color" valor={v.color || '—'} />
                  <Dato etiqueta="Combustible" valor={v.tipoCombustible || '—'} />
                </div>
                {lastSol && (
                  <div className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 border-t border-[color:var(--color-border)] pt-2 text-xs min-[380px]:grid-cols-2 lg:grid-cols-3">
                    <Dato etiqueta="Secretaría" valor={lastSol.entidad || '—'} />
                    <Dato etiqueta="Estado trámite" valor={lastSol.estado || '—'} />
                    <Dato etiqueta="Trámite" valor={lastSol.tramitesRealizados || '—'} />
                  </div>
                )}
                {singleResult.tipoDocPropietario && (
                  <div className="mt-2 border-t border-[color:var(--color-border)] pt-2 text-xs">
                    <Dato etiqueta="Tipo doc. propietario" valor={singleResult.tipoDocPropietario} />
                  </div>
                )}
              </div>
              {s ? (
                <div className="border-t border-[color:var(--kit-verde)] bg-[color:color-mix(in_srgb,var(--kit-verde)_10%,transparent)] p-4">
                  <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.3em] text-[color:var(--kit-verde-texto)]">SOAT</p>
                  <div className="grid grid-cols-1 gap-2 text-xs min-[380px]:grid-cols-2 lg:grid-cols-4">
                    <Dato etiqueta="Aseguradora" valor={s.razonSocialAsegur || '—'} />
                    <Dato etiqueta="Póliza" valor={s.numSoat || '—'} />
                    <Dato etiqueta="Inicio" valor={fmtDate(s.fechaInicioPoliza)} />
                    <Dato etiqueta="Vence" valor={fmtDate(s.fechaVencimSoat)} />
                  </div>
                  <GradientButton type="button" variant="success" size="sm" className="mt-3" onClick={() => handleRegisterPurchased(singleVin, v, s)}>
                    Registrar como comprado
                  </GradientButton>
                </div>
              ) : (
                <div className="border-t border-[color:var(--kit-naranja)] p-4">
                  <StatusChip tone="warning">Sin SOAT registrado en RUNT</StatusChip>
                </div>
              )}
            </div>
          );
        })()}
      </FlitCard>

      {purchased.length > 0 && (
        <FlitCard className="mb-4">
          <h3 className="mb-1 text-sm font-semibold text-[color:var(--color-text-primary)]">Comprados pendientes de verificación RUNT</h3>
          <p className="mb-3 text-xs text-[color:var(--color-text-tertiary)]">{purchased.length} SOAT comprados — verifica que aparezcan en RUNT</p>
          <div className="space-y-2">
            {purchased.map((r) => {
              const vd = verifiedData[r.id];
              const failed = failedIds.has(r.id);
              const isTransitioning = transitioning === r.id;
              const borde = isTransitioning || vd ? 'border-[color:var(--kit-verde)]' : failed ? 'border-[color:var(--kit-naranja)]' : 'border-[color:var(--color-border)]';
              return (
                <div key={r.id} className={`rounded-[9px] border p-3 transition-colors ${borde}`}>
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        {r.plate ? <Placa placa={r.plate} /> : <span className="text-sm font-semibold text-[color:var(--color-text-primary)]">—</span>}
                        <span className="text-xs text-[color:var(--color-text-tertiary)]">{r.ownerName || ''}</span>
                      </div>
                      {isTransitioning && (
                        <p className="mt-1 text-[11px] font-medium text-[color:var(--kit-verde-texto)]">Verificado — movido a Gestión de compras</p>
                      )}
                      {!isTransitioning && vd && (
                        <div className="mt-1.5 grid grid-cols-1 gap-2 text-[11px] min-[380px]:grid-cols-2 md:grid-cols-4">
                          <Dato etiqueta="Póliza" valor={vd.numSoat || '—'} />
                          <Dato etiqueta="Aseguradora" valor={vd.razonSocialAsegur || '—'} />
                          <Dato etiqueta="Inicio" valor={vd.fechaInicioPoliza ? fmtDate(vd.fechaInicioPoliza) : '—'} />
                          <Dato etiqueta="Vence" valor={vd.fechaVencimSoat ? fmtDate(vd.fechaVencimSoat) : '—'} />
                        </div>
                      )}
                      {failed && <p className="mt-1 text-[11px] text-[color:var(--kit-naranja-texto)]">RUNT aún no indexa este SOAT o hay un traspaso en sincronización. Normal dentro de 24-72h hábiles — reintenta más tarde.</p>}
                    </div>
                    {isTransitioning || vd ? (
                      <StatusChip tone="success" icono={<Icono nombre="check" size={14} />}>Verificado</StatusChip>
                    ) : (
                      <GradientButton type="button" size="sm" onClick={() => verifyOne(r)} disabled={verifyingId === r.id} ocupado={verifyingId === r.id} className="shrink-0">
                        {verifyingId === r.id ? 'Consultando...' : 'Verificar RUNT'}
                      </GradientButton>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </FlitCard>
      )}

      <FlitCard className="mb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-[color:var(--color-text-primary)]">Validación masiva SOAT</h3>
            <p className="mt-1 text-xs text-[color:var(--color-text-tertiary)]">Sube el Excel de matrículas. El sistema consulta el RUNT por cada VIN y verifica si tiene SOAT.</p>
          </div>
          <label className={`${claseBoton('primary')} cursor-pointer focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--kit-azul)] ${loading ? 'pointer-events-none opacity-50' : ''}`} data-variante="primario">
            <Icono nombre="archivo-subir" size={16} />
            {loading ? 'Procesando...' : 'Subir Excel de matrículas'}
            <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleUpload} disabled={loading} />
          </label>
        </div>

        {loading && (
          <div className="mt-4 flex items-center gap-2 text-sm text-[color:var(--color-text-tertiary)]" role="status">
            <Girador />
            {progress}
          </div>
        )}
      </FlitCard>

      {summary && (
        <div className="mb-4 grid grid-cols-1 gap-3 min-[380px]:grid-cols-2 lg:grid-cols-4">
          <Stat label="Total procesados" value={summary.total} tone="accent" />
          <Stat label="Con SOAT" value={summary.withSoat} tone="success" />
          <Stat label="Sin SOAT" value={summary.withoutSoat} tone="danger" />
          <Stat label="Errores" value={summary.errors} tone="warning" />
        </div>
      )}

      {summary && summary.withoutSoat > 0 && onSendToRequests && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[9px] border border-[color:var(--kit-naranja)] bg-[color:color-mix(in_srgb,var(--kit-naranja)_10%,transparent)] p-4">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-[color:var(--kit-naranja-texto)]">{summary.withoutSoat} vehículos necesitan SOAT</p>
            <p className="mt-0.5 text-xs text-[color:var(--color-text-secondary)]">Envíalos a solicitudes para gestionar la compra con el proveedor</p>
          </div>
          <GradientButton type="button" onClick={() => onSendToRequests(results.filter((r) => !r.hasSoat && r.runtOk))} className="shrink-0">
            <Icono nombre="derecha" size={16} />
            Enviar a solicitudes
          </GradientButton>
        </div>
      )}

      {results.length > 0 && (
        <DataTable
          ariaLabel="Resultados de la validación masiva SOAT"
          columnas={columnasResultado}
          filas={filasResultado}
          getKey={({ i }) => String(i)}
        />
      )}
    </div>
  );
}

function Dato({ etiqueta, valor, fuerte }: { etiqueta: string; valor: string; fuerte?: boolean }) {
  return (
    <div className="min-w-0 break-words">
      <span className="text-[color:var(--color-text-tertiary)]">{etiqueta}: </span>
      <span className={`text-[color:var(--color-text-primary)] ${fuerte ? 'text-sm font-semibold' : 'font-medium'}`}>{valor}</span>
    </div>
  );
}

const COLOR_STAT = {
  accent: 'text-[color:var(--color-action)]',
  success: 'text-[color:var(--kit-verde-texto)]',
  danger: 'text-[color:var(--kit-rojo-texto)]',
  warning: 'text-[color:var(--kit-naranja-texto)]',
} as const;

function Stat({ label, value, tone }: { label: string; value: number; tone: keyof typeof COLOR_STAT }) {
  return (
    <div className="rounded-[9px] border border-[color:var(--color-border)] bg-[var(--color-surface-elevated)] p-4">
      <p className={`text-2xl font-semibold tabular-nums ${COLOR_STAT[tone]}`}>{value}</p>
      <p className="mt-0.5 text-xs text-[color:var(--color-text-tertiary)]">{label}</p>
    </div>
  );
}
