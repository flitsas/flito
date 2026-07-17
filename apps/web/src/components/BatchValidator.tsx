import { useState, useRef, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import toast from 'react-hot-toast';
import { flitInp, FlitCard, FlitTable, FlitTh, FlitTr } from './flit/flitPageKit';

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

  return (
    <div>
      <div className="bg-white rounded-xl border border-[color:var(--flit-border-soft)] p-5 mb-4 shadow-[var(--flit-shadow-card)]">
        <h3 className="text-sm font-semibold flit-tone-primary mb-3">Consulta individual por VIN</h3>
        <div className="flex gap-2">
          <input value={singleVin} onChange={(e) => setSingleVin(e.target.value.toUpperCase())}
            placeholder="Ingresa el VIN del vehículo..."
            className={`${inputCls} font-mono`} />
          <button onClick={handleSingleVerify} disabled={singleLoading}
            className="flit-focus inline-flex h-10 flex-shrink-0 items-center rounded-[999px] px-5 text-sm font-semibold text-white disabled:opacity-50" style={{ background: 'var(--flit-gradient-primary)' }}>
            {singleLoading ? 'Consultando...' : 'Consultar RUNT'}
          </button>
        </div>
        {singleResult && (() => {
          const v = singleResult.veh || {};
          const s = singleResult.soat;
          const lastSol = singleResult.solicitudes?.[0];
          const wrapTone = s ? 'border-[color:var(--flit-success)]/30' : 'border-[color:var(--flit-warning)]/30';
          const headTone = s ? 'flit-success-bg' : 'flit-warning-bg';
          return (
            <div className={`mt-3 rounded-xl border overflow-hidden ${wrapTone}`}>
              <div className={`p-4 ${headTone}`}>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-1.5 text-xs">
                  <div><span className="flit-tone-muted">Placa: </span><span className="font-semibold flit-tone-primary text-sm">{v.placa || '—'}</span></div>
                  <div><span className="flit-tone-muted">Marca / Línea: </span><span className="font-medium flit-tone-primary">{v.marca || '—'} {v.linea || ''}</span></div>
                  <div><span className="flit-tone-muted">Modelo: </span><span className="font-medium flit-tone-primary">{v.modelo || '—'}</span></div>
                  <div><span className="flit-tone-muted">Clase: </span><span className="font-medium flit-tone-primary">{v.claseVehiculo || v.clase || '—'}</span></div>
                  <div><span className="flit-tone-muted">Estado vehículo: </span><span className="font-medium flit-tone-primary">{v.estadoAutomotor || '—'}</span></div>
                  <div><span className="flit-tone-muted">Servicio: </span><span className="font-medium flit-tone-primary">{v.tipoServicio || '—'}</span></div>
                  <div><span className="flit-tone-muted">Color: </span><span className="font-medium flit-tone-primary">{v.color || '—'}</span></div>
                  <div><span className="flit-tone-muted">Combustible: </span><span className="font-medium flit-tone-primary">{v.tipoCombustible || '—'}</span></div>
                </div>
                {lastSol && (
                  <div className="grid grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-1 text-xs mt-2 pt-2 border-t border-[color:var(--flit-border-soft)]/50">
                    <div><span className="flit-tone-muted">Secretaría: </span><span className="font-medium flit-tone-primary">{lastSol.entidad || '—'}</span></div>
                    <div><span className="flit-tone-muted">Estado trámite: </span><span className="font-medium flit-tone-primary">{lastSol.estado || '—'}</span></div>
                    <div><span className="flit-tone-muted">Trámite: </span><span className="font-medium text-[11px] flit-tone-primary">{lastSol.tramitesRealizados || '—'}</span></div>
                  </div>
                )}
                {singleResult.tipoDocPropietario && (
                  <div className="text-xs mt-2 pt-2 border-t border-[color:var(--flit-border-soft)]/50">
                    <span className="flit-tone-muted">Tipo doc. propietario: </span><span className="font-medium flit-tone-primary">{singleResult.tipoDocPropietario}</span>
                  </div>
                )}
              </div>
              {s ? (
                <div className="p-4 flit-success-bg border-t border-[color:var(--flit-success)]/20">
                  <p className="text-[10px] font-semibold text-[color:var(--flit-success)] uppercase tracking-[0.3em] mb-1.5">SOAT</p>
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 text-xs">
                    <div><span className="flit-tone-muted">Aseguradora: </span><span className="font-medium text-[color:var(--flit-success)]">{s.razonSocialAsegur || '—'}</span></div>
                    <div><span className="flit-tone-muted">Póliza: </span><span className="font-medium text-[color:var(--flit-success)]">{s.numSoat || '—'}</span></div>
                    <div><span className="flit-tone-muted">Inicio: </span><span className="font-medium flit-tone-primary">{fmtDate(s.fechaInicioPoliza)}</span></div>
                    <div><span className="flit-tone-muted">Vence: </span><span className="font-medium flit-tone-primary">{fmtDate(s.fechaVencimSoat)}</span></div>
                  </div>
                  <button onClick={() => handleRegisterPurchased(singleVin, v, s)}
                    className="mt-3 inline-flex items-center h-9 px-4 rounded-xl bg-[color:var(--flit-success)] text-[color:var(--flit-success)]-foreground hover:opacity-90 transition-opacity text-xs font-medium">
                    Registrar como comprado
                  </button>
                </div>
              ) : (
                <div className="p-4 flit-warning-bg border-t border-[color:var(--flit-warning)]/20">
                  <p className="text-[11px] text-[color:var(--flit-warning)] font-medium">Sin SOAT registrado en RUNT</p>
                </div>
              )}
            </div>
          );
        })()}
      </div>

      {purchased.length > 0 && (
        <div className="bg-white rounded-xl border border-[color:var(--flit-border-soft)] p-5 mb-4 shadow-[var(--flit-shadow-card)]">
          <h3 className="text-sm font-semibold flit-tone-primary mb-1">Comprados pendientes de verificación RUNT</h3>
          <p className="text-xs flit-tone-muted mb-3">{purchased.length} SOAT comprados — verifica que aparezcan en RUNT</p>
          <div className="space-y-2">
            {purchased.map((r) => {
              const vd = verifiedData[r.id];
              const failed = failedIds.has(r.id);
              const isTransitioning = transitioning === r.id;
              const wrapCls = isTransitioning
                ? 'flit-success-bg border-[color:var(--flit-success)]/40'
                : vd
                  ? 'flit-success-bg border-[color:var(--flit-success)]/30'
                  : failed
                    ? 'flit-warning-bg border-[color:var(--flit-warning)]/30'
                    : 'flit-warning-bg border-[color:var(--flit-warning)]/20';
              return (
                <div key={r.id} className={`p-3 rounded-xl border transition-all ${wrapCls}`}>
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold flit-tone-primary">{r.plate || '—'}</span>
                        <span className="text-xs flit-tone-muted">{r.ownerName || ''}</span>
                      </div>
                      {isTransitioning && (
                        <p className="text-[11px] text-[color:var(--flit-success)] font-medium mt-1">Verificado — movido a Gestión de compras</p>
                      )}
                      {!isTransitioning && vd && (
                        <div className="grid grid-cols-4 gap-2 mt-1.5 text-[11px]">
                          <div><span className="flit-tone-muted">Póliza: </span><span className="font-medium flit-tone-primary">{vd.numSoat || '—'}</span></div>
                          <div><span className="flit-tone-muted">Aseguradora: </span><span className="font-medium flit-tone-primary">{vd.razonSocialAsegur || '—'}</span></div>
                          <div><span className="flit-tone-muted">Inicio: </span><span className="font-medium flit-tone-primary">{vd.fechaInicioPoliza ? fmtDate(vd.fechaInicioPoliza) : '—'}</span></div>
                          <div><span className="flit-tone-muted">Vence: </span><span className="font-medium flit-tone-primary">{vd.fechaVencimSoat ? fmtDate(vd.fechaVencimSoat) : '—'}</span></div>
                        </div>
                      )}
                      {failed && <p className="text-[11px] text-[color:var(--flit-warning)] mt-1">RUNT aún no indexa este SOAT o hay un traspaso en sincronización. Normal dentro de 24-72h hábiles — reintenta más tarde.</p>}
                    </div>
                    {isTransitioning ? (
                      <span className="inline-flex items-center gap-1 h-9 px-3 rounded-xl text-xs font-medium bg-[color:var(--flit-success)] text-[color:var(--flit-success)]-foreground flex-shrink-0">
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
                        Verificado
                      </span>
                    ) : vd ? (
                      <span className="inline-flex items-center gap-1 h-9 px-3 rounded-xl text-xs font-medium bg-[color:var(--flit-success)] text-[color:var(--flit-success)]-foreground flex-shrink-0">
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
                        Verificado
                      </span>
                    ) : (
                      <button onClick={() => verifyOne(r)} disabled={verifyingId === r.id}
                        className="flit-focus inline-flex h-9 flex-shrink-0 items-center rounded-[999px] px-4 text-xs font-semibold text-white disabled:opacity-50" style={{ background: 'var(--flit-gradient-primary)' }}>
                        {verifyingId === r.id ? 'Consultando...' : 'Verificar RUNT'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border border-[color:var(--flit-border-soft)] p-5 mb-4 shadow-[var(--flit-shadow-card)]">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h3 className="text-sm font-semibold flit-tone-primary">Validación masiva SOAT</h3>
            <p className="text-xs flit-tone-muted mt-1">Sube el Excel de matrículas. El sistema consulta el RUNT por cada VIN y verifica si tiene SOAT.</p>
          </div>
          <label className={`flit-focus inline-flex h-10 cursor-pointer items-center gap-2 rounded-[999px] px-5 text-sm font-semibold text-white ${loading ? 'pointer-events-none opacity-50' : ''}`} style={{ background: 'var(--flit-gradient-primary)' }}>
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
            </svg>
            {loading ? 'Procesando...' : 'Subir Excel de matrículas'}
            <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleUpload} disabled={loading} />
          </label>
        </div>

        {loading && (
          <div className="mt-4 flex items-center gap-2 text-sm flit-tone-muted">
            <svg className="animate-spin motion-reduce:animate-none h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            {progress}
          </div>
        )}
      </div>

      {summary && (
        <div className="grid grid-cols-4 gap-3 mb-4">
          <Stat label="Total procesados" value={summary.total} tone="accent" />
          <Stat label="Con SOAT" value={summary.withSoat} tone="success" />
          <Stat label="Sin SOAT" value={summary.withoutSoat} tone="danger" />
          <Stat label="Errores" value={summary.errors} tone="warning" />
        </div>
      )}

      {summary && summary.withoutSoat > 0 && onSendToRequests && (
        <div className="flit-danger-bg border border-[color:var(--flit-danger)]/30 rounded-xl p-4 mb-4 flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p className="text-sm font-semibold text-[color:var(--flit-danger)]">{summary.withoutSoat} vehículos necesitan SOAT</p>
            <p className="text-xs text-[color:var(--flit-danger)] opacity-80 mt-0.5">Envíalos a solicitudes para gestionar la compra con el proveedor</p>
          </div>
          <button onClick={() => onSendToRequests(results.filter((r) => !r.hasSoat && r.runtOk))}
            className="inline-flex items-center gap-2 h-10 px-5 rounded-xl bg-danger text-[color:var(--flit-danger)]-foreground hover:opacity-90 transition-opacity text-sm font-medium flex-shrink-0">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
            </svg>
            Enviar a solicitudes
          </button>
        </div>
      )}

      {results.length > 0 && (
        <div className="bg-white rounded-xl border border-[color:var(--flit-border-soft)] overflow-hidden shadow-[var(--flit-shadow-card)]">
          <div className="max-h-[60vh] overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0">
                <tr>
                  <Th>VIN</Th>
                  <Th>Placa</Th>
                  <Th>Propietario</Th>
                  <Th>Vehículo</Th>
                  <Th>SOAT</Th>
                  <Th>Aseguradora</Th>
                  <Th>Vencimiento</Th>
                  <Th>Estado</Th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => {
                  const rowTone = r.hasSoat ? 'flit-success-bg/30' : r.runtOk ? 'flit-danger-bg/30' : 'flit-warning-bg/30';
                  return (
                    <tr key={i} className={`border-t border-[color:var(--flit-border-soft)] ${rowTone}`}>
                      <td className="px-3 py-2 font-mono text-xs flit-tone-secondary">{r.vin}</td>
                      <td className="px-3 py-2 font-semibold flit-tone-primary">{r.plate || '—'}</td>
                      <td className="px-3 py-2 text-xs flit-tone-secondary truncate max-w-[150px]">{r.ownerName || '—'}</td>
                      <td className="px-3 py-2 text-xs flit-tone-secondary">{r.model || '—'}</td>
                      <td className="px-3 py-2">
                        {r.hasSoat ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium flit-success-bg text-[color:var(--flit-success)]">
                            <span className="w-1.5 h-1.5 rounded-full bg-[color:var(--flit-success)]" /> Comprado
                          </span>
                        ) : r.runtOk ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium flit-danger-bg text-[color:var(--flit-danger)]">
                            <span className="w-1.5 h-1.5 rounded-full bg-danger" /> Sin SOAT
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium flit-warning-bg text-[color:var(--flit-warning)]">
                            <span className="w-1.5 h-1.5 rounded-full bg-warning" /> Error
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs flit-tone-secondary">{r.soatInsurer || '—'}</td>
                      <td className="px-3 py-2 text-xs flit-tone-secondary">{fmtDate(r.soatExpiry)}</td>
                      <td className="px-3 py-2 text-xs flit-tone-muted">{r.error || r.soatStatus || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="bg-[color:var(--flit-bg-app)] flit-tone-muted text-[10px] uppercase tracking-wide font-semibold py-2.5 px-3 text-left">{children}</th>;
}

function Stat({ label, value, tone }: { label: string; value: number; tone: 'accent' | 'success' | 'danger' | 'warning' }) {
  const color = tone === 'accent' ? 'var(--flit-blue)' : tone === 'success' ? '#16a34a' : tone === 'danger' ? '#dc2626' : '#d97706';
  return (
    <div className="bg-white p-4" style={{ borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-[var(--flit-shadow-card)])' }}>
      <p className="text-2xl font-semibold" style={{ color }}>{value}</p>
      <p className="mt-0.5 text-xs" style={{ color: 'var(--flit-text-muted)' }}>{label}</p>
    </div>
  );
}
