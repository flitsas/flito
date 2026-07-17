// TRAM-TRASPASO-F1.5 — wizard de TRASPASO alineado a CEA (TransitoTraspasoWizard).
// 6 pasos: Vehículo → Validación legal → Vendedor → Comprador → Comercial → Documentos.
// NO redirige al wizard VIN-first de matrícula inicial. Reusa RUNT, pre-vuelo,
// firma B3 y radicado/STT de F1.

import { useCallback, useEffect, useMemo, useRef, useState, FormEvent, type Dispatch, type SetStateAction } from 'react';
import type { RuntPersonaResponse } from './tramite/wizard/types';
import { useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  ESTADO_STT_LABEL,
  impuestoIndicaPazSalvo,
  summarizeRuntMultasComparendos,
  mensajePartesTraspasoDuplicadas,
  normalizarDocumentoTraspaso,
  partesTraspasoDuplicadas,
  forzarContinuarActivo,
  maxPasoTraspasoAlcanzable,
  pasoTraspasoSoloLectura,
  puedeAvanzarDesdePasoTraspaso,
  puedeIrAPasoTraspaso,
  transicionesDesde,
  traspasoGestionCerrada,
  ultimaNotaSubsanacion,
  type TramiteEstadoStt,
  type TramiteWorkflowEvent,
} from '@operaciones/shared-types';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import TraspasoStepDocumentos from './tramite/TraspasoStepDocumentos';
import TraspasoStepComercial, { type ComercialData } from './tramite/TraspasoStepComercial';
import TraspasoOrganismoPicker, { resolveOrgFromRuntName } from './tramite/TraspasoOrganismoPicker';
import TraspasoExpedientePanel from './tramite/TraspasoExpedientePanel';
import CedulaCaptureOverlay, { type CedulaOcrData } from '../components/identidad/CedulaCaptureOverlay';
import type { OrgTransito } from './tramite/wizard/types';

interface Parte { nombre: string; documento: string; tipoDoc: string; direccion: string; telefono: string; email: string; ciudad: string }
const PARTE_VACIA: Parte = { nombre: '', documento: '', tipoDoc: 'CC', direccion: '', telefono: '', email: '', ciudad: '' };
interface PreflightCheck { key: string; label: string; status: string; message: string }

const PASOS = ['Vehículo', 'Validación legal', 'Vendedor', 'Comprador', 'Comercial', 'Documentos'];
const WIZARD_VERSION = '2026-06-10-cierre';
const ESTADO_TONE: Record<string, ChipTone> = {
  radicado: 'active', en_validacion: 'active', subsanacion: 'warning', en_tramite: 'active',
  aprobado: 'success', rechazado: 'danger', entregado: 'success', anulado: 'neutral',
};
const inputCls = 'flit-focus mt-1 w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-3 py-2 text-sm text-[color:var(--flit-text-primary)] outline-none';
const cardStyle: React.CSSProperties = { borderRadius: 'var(--flit-radius-card)', boxShadow: 'var(--flit-shadow-card)', border: '1px solid var(--flit-border-soft)' };

function Field({ label, value, onChange, error, errorId, hint, hintId, ...rest }: { label: string; value: string; onChange: (v: string) => void; error?: string; errorId?: string; hint?: string; hintId?: string } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const describedBy = [rest['aria-describedby'], hint && hintId ? hintId : undefined, error && errorId ? errorId : undefined].filter(Boolean).join(' ') || undefined;
  return (
    <label className="block text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
      {label}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={inputCls}
        aria-invalid={error ? true : rest['aria-invalid']}
        aria-describedby={describedBy}
        {...rest}
      />
      {hint && hintId ? (
        <p id={hintId} className="mt-1 text-[10px] font-normal" style={{ color: 'var(--flit-text-muted)' }}>
          {hint}
        </p>
      ) : null}
      {error && errorId ? (
        <p id={errorId} className="mt-1 text-[11px] font-semibold" style={{ color: 'var(--flit-danger)' }} role="alert">
          {error}
        </p>
      ) : null}
    </label>
  );
}

// Backup prod 2026-06-10 — banner «paso cerrado» (solo consulta) dentro del paso.
function PasoCerradoBanner() {
  return (
    <div className="mb-4 rounded-[10px] border-2 px-3 py-3" role="status"
      style={{ borderColor: 'var(--flit-success)', background: 'rgba(112,207,58,0.12)' }}>
      <p className="text-sm font-bold" style={{ color: 'var(--flit-success)' }}>Paso cerrado — solo consulta</p>
      <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
        Este paso ya fue validado y guardado. Los campos están bloqueados. Para avanzar usa el paso activo resaltado arriba.
      </p>
    </div>
  );
}

function PasoEditableBanner({ paso }: { paso: number }) {
  return (
    <div className="mb-4 rounded-[10px] border-2 px-3 py-2.5" role="status"
      style={{ borderColor: 'var(--flit-blue)', background: 'var(--flit-blue-soft)' }}>
      <p className="text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>
        Paso {paso} editable — completa y guarda para cerrarlo
      </p>
    </div>
  );
}

// Estado subsanación: el organismo devolvió el trámite — el gestor puede corregir.
function SubsanacionBanner({ nota }: { nota: string | null }) {
  return (
    <div className="rounded-[12px] border-2 px-4 py-3 lg:col-span-2" role="status"
      style={{ borderColor: 'var(--flit-warning)', background: 'rgba(240,90,53,0.08)' }}>
      <p className="text-sm font-bold" style={{ color: 'var(--flit-warning)' }}>
        Subsanación STT — puede corregir el expediente
      </p>
      <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
        El organismo de tránsito devolvió el trámite para correcciones. Complete los ajustes y vuelva a enviar a validación STT.
      </p>
      {nota && (
        <p className="mt-2 rounded-[8px] border px-3 py-2 text-xs font-semibold"
          style={{ borderColor: 'var(--flit-border-soft)', background: 'white', color: 'var(--flit-text-primary)' }}>
          Observación STT: {nota}
        </p>
      )}
    </div>
  );
}

// Gestión CEA cerrada (estado STT fuera de radicado/subsanación) → expediente bloqueado.
function GestionCerradaBanner({ estado, isTransito }: { estado: string; isTransito: boolean }) {
  const label = ESTADO_STT_LABEL[estado as TramiteEstadoStt] ?? estado;
  return (
    <div className="rounded-[12px] border-2 px-4 py-3 lg:col-span-2" role="status"
      style={{ borderColor: 'var(--flit-blue)', background: 'var(--flit-blue-soft)' }}>
      {isTransito ? (
        <>
          <p className="text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>
            Expediente STT en {label} — solo consulta
          </p>
          <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
            El CEA ya cerró la gestión. Revisa documentos e identidad abajo (solo lectura). Para avanzar el trámite usa
            los botones STT al final del paso <strong>Documentos</strong> o la <strong>bandeja Traspasos STT</strong>
            {' '}(Subsanación, En trámite, Rechazado…).
          </p>
        </>
      ) : (
        <>
          <p className="text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>
            Gestión enviada a STT — expediente bloqueado
          </p>
          <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
            Estado actual: <strong>{label}</strong>. Ya no puedes subir documentos ni modificar datos. Si el organismo
            pide correcciones, un operador de tránsito debe mover el trámite a <strong>Subsanación</strong>; entonces
            podrás editar de nuevo.
          </p>
        </>
      )}
    </div>
  );
}

// Barra de progreso del wizard (pills): cerrado / activo / pendiente.
function ProgresoTraspasoPills({ step, pasoActivo, pasoSoloLectura, pasoNavHabilitado, onIrPaso }: {
  step: number;
  pasoActivo: number;
  pasoSoloLectura: (n: number) => boolean;
  pasoNavHabilitado: (n: number) => boolean;
  onIrPaso: (n: number) => void;
}) {
  return (
    <div className="rounded-[12px] border px-3 py-2.5 lg:col-span-2"
      style={{ borderColor: 'var(--flit-border-soft)', background: 'white', boxShadow: 'var(--flit-shadow-card)' }}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[11px] font-bold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>
          Progreso del traspaso
        </p>
        <span className="font-mono text-[9px]" style={{ color: 'var(--flit-text-muted)' }} title="Versión del wizard">
          {WIZARD_VERSION}
        </span>
      </div>
      <div className="flex gap-1 overflow-x-auto pb-1">
        {PASOS.map((label, i) => {
          const n = i + 1;
          const cerrado = pasoSoloLectura(n);
          const activo = n === pasoActivo;
          const actual = n === step;
          const navOk = pasoNavHabilitado(n);
          const estilo: React.CSSProperties = cerrado
            ? { borderColor: 'var(--flit-success)', color: 'var(--flit-success)', background: 'rgba(112,207,58,0.10)' }
            : activo
              ? { borderColor: 'var(--flit-blue)', color: 'var(--flit-blue)', background: 'var(--flit-blue-soft)', fontWeight: 700 }
              : { borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-muted)', background: 'var(--flit-bg-app)' };
          return (
            <button key={label} type="button" disabled={!navOk} onClick={() => onIrPaso(n)}
              title={cerrado ? `${label} — cerrado` : activo ? `${label} — editable` : label}
              className="flit-focus shrink-0 rounded-[999px] border px-2.5 py-1 text-[10px] disabled:opacity-40"
              style={{ ...estilo, outline: actual ? '2px solid var(--flit-blue)' : undefined }}>
              {cerrado ? '✓' : `${n}.`} {label}
            </button>
          );
        })}
      </div>
      <p className="mt-1 text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>
        ✓ = cerrado (solo lectura) · paso {pasoActivo} editable · {pasoActivo > 1 ? `${pasoActivo - 1} paso(s) ya cerrados` : 'Aún no hay pasos cerrados'}
      </p>
    </div>
  );
}

export default function TramiteTraspaso() {
  const [params] = useSearchParams();
  const resumeId = params.get('id');
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const isTransito = user?.role === 'transito';

  const [step, setStep] = useState(1);
  const [tramiteId, setTramiteId] = useState<number | null>(resumeId ? Number(resumeId) : null);
  const [radicado, setRadicado] = useState<string | null>(null);
  const [estado, setEstado] = useState('radicado');
  const [workflow, setWorkflow] = useState<TramiteWorkflowEvent[]>([]);
  const [furGenerado, setFurGenerado] = useState(false);
  const [busy, setBusy] = useState(false);

  // Paso 1 — vehículo
  const [placa, setPlaca] = useState('');
  const [docPropietario, setDocPropietario] = useState('');
  const [vehiculo, setVehiculo] = useState<Record<string, unknown> | null>(null);
  // Paso 2 — pre-vuelo
  const [preflight, setPreflight] = useState<{ overall: string; checks: PreflightCheck[] } | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const preflightBooted = useRef<number | null>(null);
  // Paso 3/4 — partes
  const [vendedor, setVendedor] = useState<Parte>({ ...PARTE_VACIA });
  const [comprador, setComprador] = useState<Parte>({ ...PARTE_VACIA });
  // Paso 5 — comercial
  const [valorVenta, setValorVenta] = useState('');
  const [causal, setCausal] = useState('COMPRAVENTA');
  const [observaciones, setObservaciones] = useState('');
  // Paso 6 — documentos (F2)
  const [tipologiaCodigo, setTipologiaCodigo] = useState<string | null>(null);
  const [checklistEstado, setChecklistEstado] = useState<Record<string, boolean>>({});
  const [orgTransito, setOrgTransito] = useState<OrgTransito>({ nombre: '', ciudad: '', codigo: '' });
  const [pazSalvoImpuesto, setPazSalvoImpuesto] = useState<{ verificado: boolean; metodo?: string } | null>(null);
  const [impuestoConsulta, setImpuestoConsulta] = useState<{ fuente: string; datos: Record<string, unknown>; advertencia?: string | null } | null>(null);

  const hydrate = useCallback(async (id: number) => {
    try {
      const t = await api.get<any>(`/tramites/${id}`);
      setTramiteId(id); setRadicado(t.numeroRadicado ?? null); setEstado(t.estado);
      setWorkflow(Array.isArray(t.workflow) ? (t.workflow as TramiteWorkflowEvent[]) : []);
      setFurGenerado(Boolean(t.furGenerado));
      setPlaca(t.placa || '');
      setTipologiaCodigo(t.tipologiaCodigo ?? t.tipologia ?? 'traspaso_standard');
      setChecklistEstado((t.checklistEstado as Record<string, boolean>) || {});
      const veh = (t.vehiculo || {}) as Record<string, any>;
      setVehiculo(veh);
      if (veh._vendedor) setVendedor((v) => ({ ...v, ...veh._vendedor }));
      const comMerged = { ...(veh._comprador || {}), ...(t.comprador || {}) };
      if (Object.keys(comMerged).length) setComprador((c) => ({ ...c, ...comMerged }));
      if (veh._comercial) {
        setValorVenta(String(veh._comercial.valorVenta ?? ''));
        setCausal(veh._comercial.causal || 'COMPRAVENTA');
        setObservaciones(veh._comercial.observaciones || '');
      }
      if (veh.organismoTransito) {
        const resolved = resolveOrgFromRuntName(String(veh.organismoTransito));
        if (resolved) setOrgTransito(resolved);
        else if (veh._orgTransito?.nombre) setOrgTransito(veh._orgTransito as OrgTransito);
      } else if (veh._orgTransito?.nombre) {
        setOrgTransito(veh._orgTransito as OrgTransito);
      }
      if (veh._pazSalvoImpuesto) setPazSalvoImpuesto(veh._pazSalvoImpuesto as { verificado: boolean; metodo?: string });
      if (veh._impuestoConsulta) setImpuestoConsulta(veh._impuestoConsulta as { fuente: string; datos: Record<string, unknown>; advertencia?: string | null });
      setStep(t.paso && t.paso >= 1 && t.paso <= 6 ? t.paso : 2);
      // Backup prod: recalcular el paso activo con gates (datos + pre-vuelo cacheado)
      // para retomar siempre en el primer paso incompleto (pasos previos quedan cerrados).
      void (async () => {
        let pf: { overall: string; checks: PreflightCheck[] } | null = null;
        try {
          const cached = await api.get<{ preflight: { overall: string; checks: PreflightCheck[] } | null }>(`/tramites/${id}/preflight`);
          if (cached.preflight?.checks?.length) {
            pf = { overall: cached.preflight.overall, checks: cached.preflight.checks };
            setPreflight(pf);
          }
        } catch { /* sin pre-vuelo cacheado */ }
        const pasoActivoCalc = maxPasoTraspasoAlcanzable({
          tramiteId: id,
          vehiculo: veh,
          comprador: comMerged,
          preflight: pf,
          pazSalvoImpuesto: veh._pazSalvoImpuesto,
          forzarContinuar: forzarContinuarActivo(veh),
        });
        setStep(pasoActivoCalc);
      })();
    } catch (e) { toast.error(errorMessage(e)); }
  }, []);

  useEffect(() => { if (resumeId) hydrate(Number(resumeId)); }, [resumeId, hydrate]);

  // Guarda progreso (merge en el JSONB vehiculo + comprador + paso).
  const patch = useCallback(async (extraVeh: Record<string, unknown>, body: Record<string, unknown>, paso: number) => {
    if (!tramiteId) return;
    const vehMerged = { ...(vehiculo ?? {}), ...extraVeh };
    setVehiculo(vehMerged);
    await api.patch(`/tramites/${tramiteId}`, { vehiculo: vehMerged, paso, ...body });
  }, [tramiteId, vehiculo]);

  // ---- Paso 1 ----
  const consultar = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const p = placa.trim().toUpperCase();
    if (!p || !docPropietario.trim()) { toast.error('Placa y documento del propietario son obligatorios'); return; }
    setBusy(true);
    try {
      const r = await api.post<{ ok: boolean; data?: { vehiculo?: Record<string, unknown> }; message?: string }>('/runt/consulta-vehiculo', { placa: p, documento: docPropietario.trim() });
      if (!r.ok || !r.data?.vehiculo) { toast.error(r.message || 'Vehículo no encontrado en RUNT'); return; }
      setVehiculo(r.data.vehiculo);
      const orgRunt = resolveOrgFromRuntName(String(r.data.vehiculo.organismoTransito || ''));
      if (orgRunt) setOrgTransito(orgRunt);
      // Prefill del vendedor (= propietario actual) desde RUNT personas (best-effort).
      try {
        const per = await api.post<any>('/runt/consulta-persona', { documento: docPropietario.trim(), tipoDocumento: 'CC' });
        const nombre = [per?.persona?.nombres, per?.persona?.apellidos].filter(Boolean).join(' ').trim();
        setVendedor((v) => ({ ...v, documento: docPropietario.trim(), nombre: nombre || v.nombre }));
      } catch { setVendedor((v) => ({ ...v, documento: docPropietario.trim() })); }
    } catch (err) { toast.error(errorMessage(err)); } finally { setBusy(false); }
  };

  const radicar = async () => {
    if (busy || !vehiculo) return;
    setBusy(true);
    try {
      const vehPayload = orgTransito.codigo
        ? { ...(vehiculo ?? {}), _orgTransito: orgTransito }
        : vehiculo;
      const t = await api.post<any>('/tramites', {
        modalidadEntrada: 'traspaso', placa: placa.trim().toUpperCase(), vehiculo: vehPayload,
        vendedor: { documento: docPropietario.trim(), nombre: vendedor.nombre, tipoDoc: 'CC' },
      });
      setTramiteId(t.id); setRadicado(t.numeroRadicado ?? null); setEstado(t.estado);
      toast.success(`Traspaso radicado ${t.numeroRadicado ?? ''}`);
      setStep(2);
    } catch (err) { toast.error(errorMessage(err)); } finally { setBusy(false); }
  };

  // ---- Paso 2 ----
  const ejecutarPreflight = useCallback(async () => {
    if (!tramiteId) return;
    setPreflightLoading(true);
    setPreflightError(null);
    setBusy(true);
    try {
      const snap = await api.post<{ overall: string; checks: PreflightCheck[] }>('/tramites/preflight', {
        tramiteId, vin: (vehiculo?.vin as string) || undefined, placa: placa.trim().toUpperCase() || undefined,
        vendedorDoc: docPropietario.trim() || vendedor.documento || undefined,
      });
      setPreflight(snap);
    } catch (e) {
      const msg = errorMessage(e);
      setPreflightError(msg);
      toast.error(msg);
    } finally {
      setPreflightLoading(false);
      setBusy(false);
    }
  }, [tramiteId, vehiculo, placa, docPropietario, vendedor.documento]);

  useEffect(() => {
    if (step !== 2 || !tramiteId || preflight || preflightLoading) return;
    if (preflightBooted.current === tramiteId) return;
    preflightBooted.current = tramiteId;
    let cancelled = false;
    (async () => {
      setPreflightLoading(true);
      setPreflightError(null);
      try {
        const cached = await api.get<{ preflight: { overall: string; checks: PreflightCheck[] } | null }>(`/tramites/${tramiteId}/preflight`);
        if (cancelled) return;
        if (cached.preflight?.checks?.length) {
          setPreflight({ overall: cached.preflight.overall, checks: cached.preflight.checks });
          return;
        }
        const snap = await api.post<{ overall: string; checks: PreflightCheck[] }>('/tramites/preflight', {
          tramiteId, vin: (vehiculo?.vin as string) || undefined, placa: placa.trim().toUpperCase() || undefined,
          vendedorDoc: docPropietario.trim() || vendedor.documento || undefined,
        });
        if (!cancelled) setPreflight(snap);
      } catch (e) {
        if (!cancelled) {
          const msg = errorMessage(e);
          setPreflightError(msg);
          toast.error(msg);
        }
      } finally {
        if (!cancelled) setPreflightLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [step, tramiteId, preflight, preflightLoading, vehiculo, placa, docPropietario, vendedor.documento]);

  const preflightBloquea = preflight?.overall === 'red';
  const impuestoUnknown = preflight?.checks.some((c) => c.key === 'impuesto_vehicular' && c.status === 'unknown');
  const pazSalvoOk = Boolean(pazSalvoImpuesto?.verificado);
  const forzarActivo = forzarContinuarActivo(vehiculo);

  const compradorColumna = useMemo(() => ({
    documento: comprador.documento.trim(),
    nombre: comprador.nombre.trim(),
    tipoDoc: comprador.tipoDoc || 'CC',
    email: comprador.email.trim(),
    telefono: comprador.telefono?.trim() || undefined,
    direccion: comprador.direccion?.trim() || undefined,
    ciudad: comprador.ciudad?.trim() || undefined,
  }), [comprador]);

  const gateCtx = useMemo(() => ({
    tramiteId,
    vehiculo,
    comprador: compradorColumna,
    preflight,
    pazSalvoImpuesto,
    forzarContinuar: forzarActivo,
  }), [tramiteId, vehiculo, compradorColumna, preflight, pazSalvoImpuesto, forzarActivo]);

  const maxPaso = useMemo(() => maxPasoTraspasoAlcanzable(gateCtx), [gateCtx]);
  // Dual-actor: gestión CEA cerrada cuando el estado STT salió de radicado/subsanación.
  const gestionCerrada = traspasoGestionCerrada(estado);
  // Paso en solo lectura: gestión cerrada (todo bloqueado) o paso ya validado (< paso activo).
  const pasoSoloLectura = useCallback(
    (n: number) => gestionCerrada || pasoTraspasoSoloLectura(n, gateCtx),
    [gestionCerrada, gateCtx],
  );

  const confirmarPazSalvoManual = async () => {
    if (!tramiteId) return;
    const payload = { verificado: true, metodo: 'manual', at: new Date().toISOString() };
    setPazSalvoImpuesto(payload);
    const nextChecklist = { ...checklistEstado, paz_salvo: true };
    setChecklistEstado(nextChecklist);
    await patch({ _pazSalvoImpuesto: payload }, { checklistEstado: nextChecklist }, 2);
    toast.success('Paz y salvo impuesto registrado (verificación manual)');
    if (tramiteId) {
      const snap = await api.post<{ overall: string; checks: PreflightCheck[] }>('/tramites/preflight', {
        tramiteId, placa: placa.trim().toUpperCase() || undefined,
        vendedorDoc: docPropietario.trim() || vendedor.documento || undefined,
      });
      setPreflight(snap);
    }
  };

  const consultarImpuesto = async () => {
    const placaUp = placa.trim().toUpperCase();
    if (!placaUp) { toast.error('Ingrese la placa del vehículo'); return; }
    setBusy(true);
    try {
      const r = await api.post<{ ok: boolean; fuente?: string; datos?: Record<string, unknown>; advertencia?: string | null; error?: string }>(
        '/tramites/impuesto-vehicular/consultar',
        {
          placa: placaUp,
          docNumber: docPropietario.trim() || vendedor.documento || undefined,
          organismoCodigo: orgTransito.codigo || undefined,
        },
      );
      if (!r.ok || !r.datos) { toast.error(r.error || 'No se pudo consultar impuesto'); return; }
      const snapshot = { fuente: r.fuente || 'Manual', datos: r.datos, advertencia: r.advertencia ?? null };
      setImpuestoConsulta(snapshot);
      await patch({ _impuestoConsulta: snapshot }, {}, 2);
      if (impuestoIndicaPazSalvo(r.datos)) {
        const payload = { verificado: true, metodo: 'consulta', at: new Date().toISOString(), fuente: r.fuente };
        setPazSalvoImpuesto(payload);
        const nextChecklist = { ...checklistEstado, paz_salvo: true };
        setChecklistEstado(nextChecklist);
        await patch({ _pazSalvoImpuesto: payload }, { checklistEstado: nextChecklist }, 2);
        toast.success('Impuesto al día — paz y salvo registrado automáticamente');
      } else {
        toast.success(`Consulta impuesto (${r.fuente || 'Manual'})`);
      }
      const snap = await api.post<{ overall: string; checks: PreflightCheck[] }>('/tramites/preflight', {
        tramiteId, placa: placaUp,
        vendedorDoc: docPropietario.trim() || vendedor.documento || undefined,
      });
      setPreflight(snap);
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };

  const guardarOrganismo = useCallback(async (org: OrgTransito) => {
    setOrgTransito(org);
    if (!tramiteId || !org.codigo || gestionCerrada) return;
    await patch({ _orgTransito: org }, {}, step);
  }, [tramiteId, step, patch, gestionCerrada]);

  // Traspaso: organismo FUR = matrícula RUNT (no manual). Sin re-PATCH si ya está
  // persistido y nunca con la gestión cerrada (expediente bloqueado).
  useEffect(() => {
    if (gestionCerrada) return;
    const runtName = vehiculo?.organismoTransito as string | undefined;
    const resolved = resolveOrgFromRuntName(runtName);
    if (!resolved?.codigo) return;
    const persistido = (vehiculo?._orgTransito as OrgTransito | undefined)?.codigo;
    setOrgTransito(resolved);
    if (orgTransito.codigo === resolved.codigo && persistido === resolved.codigo) return;
    if (!tramiteId || persistido === resolved.codigo) return;
    patch({ _orgTransito: resolved }, {}, step).catch((e) => toast.error(errorMessage(e)));
  }, [vehiculo?.organismoTransito, vehiculo?._orgTransito, orgTransito.codigo, tramiteId, step, patch, gestionCerrada]);

  // ---- guardar pasos 3-5 ----
  const conflictoPartes = (v: Parte, c: Parte) => mensajePartesTraspasoDuplicadas(partesTraspasoDuplicadas(v, c));

  const guardarVendedor = async (extraVeh: Record<string, unknown> = {}) => {
    if (!vendedor.nombre.trim() || !vendedor.documento.trim()) { toast.error('Nombre y documento del vendedor son obligatorios'); return; }
    if (!vendedor.email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(vendedor.email.trim())) {
      toast.error('El email del vendedor es obligatorio para la validación biométrica');
      return;
    }
    const dupMsg = conflictoPartes(vendedor, comprador);
    if (dupMsg && (comprador.documento.trim() || comprador.email.trim())) {
      toast.error(dupMsg);
      return;
    }
    setBusy(true);
    try { await patch({ _vendedor: vendedor, ...extraVeh }, {}, 3); setStep(4); } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  const guardarComprador = async (extraVeh: Record<string, unknown> = {}) => {
    if (!comprador.nombre.trim() || !comprador.documento.trim()) { toast.error('Nombre y documento del comprador son obligatorios'); return; }
    if (!comprador.email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(comprador.email.trim())) {
      toast.error('El email del comprador es obligatorio para la firma y validación biométrica');
      return;
    }
    const dupMsg = conflictoPartes(vendedor, comprador);
    if (dupMsg) {
      toast.error(dupMsg);
      return;
    }
    setBusy(true);
    try {
      const compradorPayload = {
        documento: comprador.documento.trim(),
        nombre: comprador.nombre.trim(),
        tipoDoc: comprador.tipoDoc || 'CC',
        email: comprador.email.trim(),
        telefono: comprador.telefono?.trim() || undefined,
        direccion: comprador.direccion?.trim() || undefined,
        ciudad: comprador.ciudad?.trim() || undefined,
      };
      await patch({ _comprador: comprador, ...extraVeh }, { comprador: compradorPayload }, 4);
      setStep(5);
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  const guardarComercial = async (d: ComercialData) => {
    if (!d.valorVenta || d.valorVenta <= 0) {
      toast.error('Ingresa un valor de venta mayor a cero');
      return;
    }
    setBusy(true);
    setValorVenta(String(d.valorVenta)); setCausal(d.causal); setObservaciones(d.observaciones);
    try { await patch({ _comercial: d }, {}, 6); setStep(6); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };

  const activarForzarContinuar = async (motivo?: string) => {
    if (!tramiteId || !isAdmin) return;
    setBusy(true);
    try {
      await patch({ _forzarContinuar: { motivo: motivo || 'Override admin traspaso' } }, {}, step);
      toast.success('Forzar continuar activado — queda registrado en auditoría');
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };

  const desactivarForzarContinuar = async () => {
    if (!tramiteId || !isAdmin) return;
    setBusy(true);
    try {
      const nextVeh = { ...(vehiculo ?? {}) };
      delete nextVeh._forzarContinuar;
      setVehiculo(nextVeh);
      await api.patch(`/tramites/${tramiteId}`, { vehiculo: nextVeh });
      toast.success('Forzar continuar desactivado');
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };

  const irPaso = (n: number) => {
    const r = puedeIrAPasoTraspaso({ ...gateCtx, pasoActual: step, targetPaso: n });
    if (!r.ok) {
      toast.error(r.message || 'Completa los pasos anteriores');
      return;
    }
    setStep(n);
  };

  const continuarDesdePaso = async (paso: number) => {
    const r = puedeAvanzarDesdePasoTraspaso(paso, gateCtx);
    if (!r.ok) {
      toast.error(r.message || 'No puedes continuar aún');
      return;
    }
    const siguiente = paso + 1;
    if (!tramiteId) {
      setStep(siguiente);
      return;
    }
    setBusy(true);
    try {
      await patch({}, {}, siguiente);
      setStep(siguiente);
      toast.success(`Paso ${paso} cerrado — continúa en paso ${siguiente}`);
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };

  // Transición STT. El backend valida 409 (biometria_gate, transicion_invalida,
  // gestion_cerrada…) y errorMessage muestra el mensaje del servidor.
  const transicionar = async (e: string) => {
    if (!tramiteId || busy) return;
    setBusy(true);
    try {
      const r = await api.patch<{ estado: string }>(`/tramites/${tramiteId}/estado`, { estado: e });
      setEstado(r.estado);
      toast.success(`Estado: ${ESTADO_STT_LABEL[e as TramiteEstadoStt] ?? e}`);
      if (e === 'en_validacion') {
        toast.success('Gestión cerrada — el traspaso pasó a validación STT. Sigue el avance en la bandeja Traspasos STT.', { duration: 6000 });
      }
    } catch (err) { toast.error(errorMessage(err)); } finally { setBusy(false); }
  };

  const pasoNavHabilitado = (n: number) => {
    if (!tramiteId && n > 1) return false;
    if (n <= maxPaso) return true;
    return puedeIrAPasoTraspaso({ ...gateCtx, pasoActual: step, targetPaso: n }).ok;
  };

  return (
    <div className="mx-auto grid max-w-4xl gap-5 lg:grid-cols-[200px_1fr] lg:gap-6">
      <div className="lg:col-span-2">
        <PageHeaderCard title="Traspaso de vehículo" subtitle={radicado ? `Radicado ${radicado}` : 'Trámite de traspaso por placa (Res. 12379/2012)'} />
      </div>

      {tramiteId && estado === 'subsanacion' && <SubsanacionBanner nota={ultimaNotaSubsanacion(workflow)} />}
      {tramiteId && gestionCerrada && <GestionCerradaBanner estado={estado} isTransito={isTransito} />}
      {tramiteId && (
        <ProgresoTraspasoPills
          step={step}
          pasoActivo={maxPaso}
          pasoSoloLectura={pasoSoloLectura}
          pasoNavHabilitado={pasoNavHabilitado}
          onIrPaso={irPaso}
        />
      )}

      {/* Sidebar de pasos (FLIT) */}
      <nav aria-label="Pasos del traspaso" className="hidden bg-white p-4 lg:block" style={cardStyle}>
        <ol className="flex flex-col gap-1.5">
          {PASOS.map((label, i) => {
            const n = i + 1; const active = step === n; const cerrado = pasoSoloLectura(n);
            const navOk = pasoNavHabilitado(n);
            return (
              <li key={label}>
                <button type="button" onClick={() => irPaso(n)} disabled={!navOk}
                  title={!navOk ? 'Completa los pasos anteriores' : cerrado ? 'Paso cerrado — solo consulta' : n === maxPaso ? 'Paso activo' : undefined}
                  className="flit-focus flex w-full items-center gap-2 rounded-[10px] px-2 py-1.5 text-left text-xs disabled:opacity-40"
                  style={active ? { background: 'var(--flit-blue-soft)', color: 'var(--flit-blue)', fontWeight: 700 } : { color: 'var(--flit-text-secondary)' }}>
                  <span className="grid h-5 w-5 place-items-center rounded-full text-[10px] font-bold" style={{ background: cerrado ? 'var(--flit-success)' : active ? 'var(--flit-blue)' : navOk ? 'var(--flit-border-soft)' : 'var(--flit-bg-app)', color: cerrado || active ? 'white' : 'var(--flit-text-muted)' }}>{cerrado ? '✓' : n}</span>
                  {label}{cerrado ? ' · cerrado' : n === maxPaso ? ' · editable' : ''}
                </button>
              </li>
            );
          })}
        </ol>
        {radicado && (
          <div className="mt-3 border-t pt-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
            <StatusChip tone={ESTADO_TONE[estado] ?? 'neutral'}>{ESTADO_STT_LABEL[estado as TramiteEstadoStt] ?? estado}</StatusChip>
            <p className="mt-2 text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>Paso activo: {maxPaso}{maxPaso > 1 ? ` · ${maxPaso - 1} cerrado(s)` : ''}</p>
          </div>
        )}
      </nav>

      <section className="bg-white p-6" style={cardStyle} aria-label={`Paso ${step}: ${PASOS[step - 1]}`}>
        {tramiteId && step === maxPaso && !pasoSoloLectura(step) && step < 6 && <PasoEditableBanner paso={step} />}
        {step === 1 && (
          <>
            {tramiteId && pasoSoloLectura(1) && <PasoCerradoBanner />}
            <form onSubmit={consultar}>
              <p className="mb-3 text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>1. Vehículo y propietario</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Placa" value={placa} onChange={setPlaca} maxLength={10} placeholder="ABC123" aria-label="Placa" />
                <Field label="Documento del propietario" value={docPropietario} onChange={setDocPropietario} maxLength={20} placeholder="CC / NIT" aria-label="Documento propietario" />
              </div>
              <div className="mt-4 flex items-center gap-3">
                <GradientButton type="submit" disabled={busy || Boolean(tramiteId && pasoSoloLectura(1))}>{busy ? 'Consultando…' : 'Consultar RUNT'}</GradientButton>
              </div>
              {vehiculo && !tramiteId && (
                <div className="mt-5 rounded-[12px] border p-4" style={{ borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-app)' }}>
                  <p className="text-[10px] uppercase" style={{ color: 'var(--flit-text-muted)' }}>Vehículo (RUNT)</p>
                  <p className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{[vehiculo.marca, vehiculo.linea, vehiculo.modelo].filter(Boolean).join(' ') || '—'}</p>
                  <GradientButton type="button" onClick={radicar} disabled={busy} className="mt-3">{busy ? 'Radicando…' : 'Radicar y continuar'}</GradientButton>
                </div>
              )}
            </form>
          </>
        )}

        {step === 2 && (
          <div>
            {pasoSoloLectura(2) && <PasoCerradoBanner />}
            <p className="mb-3 text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>2. Validación legal (RUNT/SIMIT)</p>
            {!preflight && preflightLoading && (
              <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Consultando RUNT, SIMIT e impuesto… (puede tardar ~30 s)</p>
            )}
            {preflightError && !preflight && (
              <div className="mb-3 rounded-[10px] border p-3" style={{ borderColor: 'var(--flit-danger)', background: 'rgba(228,61,48,0.06)' }}>
                <p className="text-xs font-semibold" style={{ color: 'var(--flit-danger)' }}>No se pudo completar el pre-vuelo</p>
                <p className="mt-1 text-[11px]" style={{ color: 'var(--flit-text-secondary)' }}>{preflightError}</p>
                <GradientButton type="button" className="mt-2" onClick={() => { preflightBooted.current = null; void ejecutarPreflight(); }} disabled={preflightLoading}>
                  Reintentar pre-vuelo
                </GradientButton>
              </div>
            )}
            {preflight ? (
              <ul className="flex flex-col gap-2">
                {preflight.checks.map((c) => (
                  <li key={c.key} className="flex items-start gap-2 rounded-[10px] border p-2.5" style={{ borderColor: 'var(--flit-border-soft)' }}>
                    <StatusChip tone={c.status === 'ok' ? 'success' : c.status === 'fail' ? 'danger' : c.status === 'warn' ? 'warning' : 'neutral'}>{c.status}</StatusChip>
                    <div><p className="text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{c.label}</p><p className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>{c.message}</p></div>
                  </li>
                ))}
              </ul>
            ) : !preflightLoading && !preflightError ? (
              <GradientButton type="button" onClick={ejecutarPreflight} disabled={busy || preflightLoading || pasoSoloLectura(2)}>Ejecutar pre-vuelo</GradientButton>
            ) : null}
            {preflightBloquea && !forzarActivo && <p className="mt-3 text-xs font-semibold" style={{ color: 'var(--flit-danger)' }}>Hay bloqueos críticos (SOAT/RTM). Subsana antes de continuar.</p>}
            {forzarActivo && (
              <p className="mt-3 rounded-[8px] px-3 py-2 text-[11px] font-semibold" style={{ background: 'rgba(240,90,53,0.08)', color: 'var(--flit-warning)' }}>
                Modo admin: forzar continuar activo — bloqueos de pre-vuelo/SIMIT ignorados.
              </p>
            )}
            {isAdmin && (preflightBloquea || (impuestoUnknown && !pazSalvoOk)) && !forzarActivo && !pasoSoloLectura(2) && (
              <button type="button" onClick={() => activarForzarContinuar()} disabled={busy}
                className="flit-focus mt-2 rounded-[999px] px-3 py-1.5 text-[11px] font-semibold"
                style={{ color: 'var(--flit-warning)', background: 'rgba(240,90,53,0.12)' }}>
                Forzar continuar (admin)
              </button>
            )}
            {isAdmin && forzarActivo && (
              <button type="button" onClick={() => desactivarForzarContinuar()} disabled={busy}
                className="flit-focus mt-2 rounded-[999px] px-3 py-1.5 text-[11px] font-semibold"
                style={{ color: 'var(--flit-text-muted)', background: 'var(--flit-bg-app)' }}>
                Desactivar forzar continuar
              </button>
            )}
            {impuestoUnknown && (
              <div className="mt-4 rounded-[12px] border p-3" style={{ borderColor: pazSalvoOk ? 'rgba(112,207,58,0.35)' : 'var(--flit-warning)', background: pazSalvoOk ? 'rgba(112,207,58,0.08)' : 'rgba(240,90,53,0.06)' }}>
                <p className="text-xs font-bold" style={{ color: pazSalvoOk ? 'var(--flit-success)' : 'var(--flit-warning)' }}>Impuesto vehicular — paz y salvo</p>
                <p className="mt-1 text-[11px]" style={{ color: 'var(--flit-text-secondary)' }}>
                  Consulta la gobernación departamental o confirma manualmente. También puedes subir el paz y salvo en el paso 6.
                </p>
                {impuestoConsulta && (
                  <div className="mt-2 rounded-[8px] border px-2.5 py-2 text-[11px]" style={{ borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-app)' }}>
                    <p className="font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
                      Fuente: {impuestoConsulta.fuente}
                      {impuestoConsulta.datos.estadoPago ? ` · ${String(impuestoConsulta.datos.estadoPago)}` : ''}
                    </p>
                    {typeof impuestoConsulta.datos.totalPagar === 'number' && (
                      <p style={{ color: 'var(--flit-text-muted)' }}>
                        Total vigencia: ${Number(impuestoConsulta.datos.totalPagar).toLocaleString('es-CO')}
                      </p>
                    )}
                    {impuestoConsulta.advertencia && (
                      <p className="mt-0.5" style={{ color: 'var(--flit-warning)' }}>{impuestoConsulta.advertencia}</p>
                    )}
                  </div>
                )}
                <div className="mt-2 flex flex-wrap gap-2">
                  {!pazSalvoOk && !pasoSoloLectura(2) && (
                    <>
                      <GradientButton type="button" onClick={consultarImpuesto} disabled={busy}>
                        {busy ? 'Consultando…' : 'Consultar impuesto'}
                      </GradientButton>
                      <button type="button" onClick={confirmarPazSalvoManual} disabled={busy}
                        className="flit-focus rounded-[999px] px-3 py-1.5 text-[11px] font-semibold"
                        style={{ color: 'var(--flit-blue)', background: 'rgba(79,116,201,0.12)' }}>
                        Confirmar verificación manual
                      </button>
                    </>
                  )}
                </div>
                {pazSalvoOk && (
                  <p className="mt-2 text-[11px] font-semibold" style={{ color: 'var(--flit-success)' }}>
                    Paz y salvo registrado ({pazSalvoImpuesto?.metodo === 'upload' ? 'documento' : pazSalvoImpuesto?.metodo === 'consulta' ? 'consulta gobernación' : 'manual'}).
                  </p>
                )}
              </div>
            )}
            {!pasoSoloLectura(2) && (
              <div className="mt-4 flex justify-end">
                <GradientButton type="button" onClick={() => continuarDesdePaso(2)} disabled={busy || !puedeAvanzarDesdePasoTraspaso(2, gateCtx).ok}>
                  Continuar
                </GradientButton>
              </div>
            )}
          </div>
        )}

        {step === 3 && (
          <>
            {pasoSoloLectura(3) && <PasoCerradoBanner />}
            <ParteForm
              titulo="3. Vendedor (titular saliente)"
              parte={vendedor}
              setParte={setVendedor}
              onContinuar={guardarVendedor}
              busy={busy}
              readOnly={pasoSoloLectura(3)}
              enableOcr
              runtPersistKey="_runtVendedor"
              runtInicial={(vehiculo?._runtVendedor as RuntConsultaPersist | undefined)}
            />
          </>
        )}
        {step === 4 && (
          <>
            {pasoSoloLectura(4) && <PasoCerradoBanner />}
            {isAdmin && !forzarActivo && !pasoSoloLectura(4) && (
              <p className="mb-3 text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>
                Si el comprador tiene comparendos excepcionales autorizados, el admin puede{' '}
                <button type="button" onClick={() => activarForzarContinuar('SIMIT override paso 4')} disabled={busy}
                  className="flit-focus font-semibold underline" style={{ color: 'var(--flit-warning)' }}>
                  forzar continuar
                </button>.
              </p>
            )}
            <ParteForm
              titulo="4. Comprador (adquiriente)"
              parte={comprador}
              setParte={setComprador}
              onContinuar={guardarComprador}
              busy={busy}
              readOnly={pasoSoloLectura(4)}
              enableSimit
              enableOcr
              forzarContinuar={forzarActivo}
              runtPersistKey="_runtComprador"
              runtInicial={(vehiculo?._runtComprador as RuntConsultaPersist | undefined)}
              simitInicial={(vehiculo?._simitComprador as { documento?: string; consultado?: boolean; total?: number; totalMonto?: number } | undefined)}
            />
          </>
        )}

        {step === 5 && (
          <>
            {pasoSoloLectura(5) && <PasoCerradoBanner />}
            <TraspasoStepComercial
              vehiculo={vehiculo ?? {}}
              inicial={(vehiculo?._comercial as Partial<ComercialData>) || { valorVenta: Number(valorVenta) || 0, causal, observaciones }}
              busy={busy}
              readOnly={pasoSoloLectura(5)}
              onGuardar={guardarComercial}
            />
          </>
        )}

        {step === 6 && tramiteId && (
          <div className="flex flex-col gap-4">
            <TraspasoOrganismoPicker
              org={orgTransito}
              onChange={(org) => { guardarOrganismo(org).catch((e) => toast.error(errorMessage(e))); }}
              runtOrganismo={vehiculo?.organismoTransito as string | undefined}
              disabled={busy || gestionCerrada}
            />
            <TraspasoExpedientePanel
              tramiteId={tramiteId}
              radicado={radicado}
              estado={estado}
              vehiculo={vehiculo ?? {}}
              comprador={comprador}
              orgTransito={orgTransito}
              tipologiaCodigo={tipologiaCodigo}
              checklistEstado={checklistEstado}
            />
            <TraspasoStepDocumentos
              tramiteId={tramiteId}
              estado={estado}
              furGenerado={furGenerado}
              sttBusy={busy}
              soloLectura={gestionCerrada}
              onTransicionStt={transicionar}
              tipologiaCodigo={tipologiaCodigo}
              checklistEstado={checklistEstado}
              organismoCodigo={orgTransito.codigo || null}
              org={orgTransito.codigo ? { orgNombre: orgTransito.nombre, orgCiudad: orgTransito.ciudad, orgCodigo: orgTransito.codigo } : undefined}
              vin={(vehiculo?.vin as string) || undefined}
              vendedor={{ nombre: vendedor.nombre, documento: vendedor.documento, email: vendedor.email }}
              comprador={{ nombre: comprador.nombre, documento: comprador.documento, email: comprador.email }}
              docsGenerados={(vehiculo?._docs_generados as { contratoAt?: string; improntasAt?: string; furAt?: string; improntasHash?: string }) || undefined}
              onPatch={async (body) => {
                if ('tipologiaCodigo' in body) setTipologiaCodigo(body.tipologiaCodigo as string);
                if ('checklistEstado' in body) setChecklistEstado(body.checklistEstado as Record<string, boolean>);
                await api.patch(`/tramites/${tramiteId}`, body);
              }}
              onPazSalvoUploaded={async () => {
                const payload = { verificado: true, metodo: 'upload', at: new Date().toISOString() };
                setPazSalvoImpuesto(payload);
                await patch({ _pazSalvoImpuesto: payload }, {}, 6);
              }}
            />
          </div>
        )}
      </section>
    </div>
  );
}

const TIPOS_DOC = ['CC', 'CE', 'NIT', 'PAS', 'TI'];

interface SimitState { total: number; totalMonto: number; loading: boolean; consultado: boolean; fuente?: 'runt' | 'simit' }
interface SimitInicial { documento?: string; consultado?: boolean; total?: number; totalMonto?: number; fuente?: 'runt' | 'simit' }
interface RuntConsultaPersist { documento?: string; tipoDoc?: string; consultado?: boolean; consultadoAt?: string; nombreRunt?: string }

function runtMatchesParte(runt: RuntConsultaPersist | undefined, parte: Parte): boolean {
  if (!runt?.consultado || !runt.documento) return false;
  return runt.documento === parte.documento.trim() && (runt.tipoDoc || 'CC') === (parte.tipoDoc || 'CC');
}

function applyRuntMultasToSimit(
  multas: unknown,
  setSimit: Dispatch<SetStateAction<SimitState>>,
  setSimitError: Dispatch<SetStateAction<string | null>>,
): boolean {
  const summary = summarizeRuntMultasComparendos(multas);
  if (!summary?.resolved) return false;
  setSimit({ total: summary.total, totalMonto: summary.totalMonto, loading: false, consultado: true, fuente: 'runt' });
  if (summary.total > 0) {
    setSimitError(`Comparendos según RUNT: ${summary.total} pendiente(s)`);
  } else {
    setSimitError(null);
  }
  return true;
}

function summaryRuntMultasToast(multas: unknown): string {
  const s = summarizeRuntMultasComparendos(multas);
  if (!s) return 'Persona encontrada en RUNT';
  if (s.total > 0) return `RUNT: ${s.total} comparendo(s) pendiente(s)`;
  return 'RUNT: sin comparendos pendientes — puede continuar';
}

function ParteForm({ titulo, parte, setParte, onContinuar, busy, readOnly, enableSimit, enableOcr, simitInicial, runtInicial, runtPersistKey, forzarContinuar }: { titulo: string; parte: Parte; setParte: (u: (p: Parte) => Parte) => void; onContinuar: (extraVeh?: Record<string, unknown>) => void; busy: boolean; readOnly?: boolean; enableSimit?: boolean; enableOcr?: boolean; forzarContinuar?: boolean; simitInicial?: SimitInicial; runtInicial?: RuntConsultaPersist; runtPersistKey?: '_runtVendedor' | '_runtComprador' }) {
  const [runtBusy, setRuntBusy] = useState(false);
  const [runtPersona, setRuntPersona] = useState<RuntPersonaResponse | null>(null);
  const [runtConsultado, setRuntConsultado] = useState(() => runtMatchesParte(runtInicial, parte));
  const [simit, setSimit] = useState<SimitState>(() => (
    simitInicial?.consultado && simitInicial.documento
      ? { total: simitInicial.total ?? 0, totalMonto: simitInicial.totalMonto ?? 0, loading: false, consultado: true, fuente: simitInicial.fuente }
      : { total: 0, totalMonto: 0, loading: false, consultado: false }
  ));
  const [simitError, setSimitError] = useState<string | null>(null);
  const [cedulaOverlayOpen, setCedulaOverlayOpen] = useState(false);
  const [ocrAnnounce, setOcrAnnounce] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const slug = titulo.replace(/\s+/g, '-').toLowerCase();
  const set = (k: keyof Parte) => (v: string) => {
    if (k === 'email') setEmailError(null);
    setParte((p) => ({ ...p, [k]: v }));
  };

  // Documento previo (normalizado) para detectar cambio de PERSONA, no de typo.
  const prevDocRef = useRef(normalizarDocumentoTraspaso(parte.documento));

  // Invalidar verificación RUNT si cambia documento o tipo.
  useEffect(() => {
    const curDoc = normalizarDocumentoTraspaso(parte.documento);
    if (runtMatchesParte(runtInicial, parte)) {
      setRuntConsultado(true);
      prevDocRef.current = curDoc;
      return;
    }
    setRuntConsultado(false);
    setRuntPersona(null);
    // Causa raíz "esquema muerto": al corregir el comprador equivocado solo se
    // cambia el documento, pero dirección/correo/teléfono/nombre quedan del
    // comprador anterior y terminan en el contrato. Si el documento cambió a OTRA
    // persona (había uno antes y ahora es distinto), limpiar los campos dependientes
    // para forzar recaptura limpia. No limpia si es la primera captura.
    const prevDoc = prevDocRef.current;
    if (prevDoc && curDoc && prevDoc !== curDoc) {
      setParte((p) => ({ ...p, nombre: '', email: '', direccion: '', telefono: '', ciudad: '' }));
      toast('Cambió el documento: revise nombre, correo y dirección del comprador');
    }
    prevDocRef.current = curDoc;
  }, [parte.documento, parte.tipoDoc, runtInicial]);

  // MIMI H1: invalidar consulta SIMIT si cambia el documento del comprador.
  useEffect(() => {
    if (!enableSimit) return;
    if (simitInicial?.consultado && simitInicial.documento === parte.documento.trim()) {
      setSimit({ total: simitInicial.total ?? 0, totalMonto: simitInicial.totalMonto ?? 0, loading: false, consultado: true, fuente: simitInicial.fuente });
      setSimitError(null);
      return;
    }
    setSimit({ total: 0, totalMonto: 0, loading: false, consultado: false, fuente: undefined });
    setSimitError(null);
  }, [parte.documento, enableSimit, simitInicial]);

  useEffect(() => {
    if (!enableSimit || simit.consultado || !runtPersona?.multas) return;
    applyRuntMultasToSimit(runtPersona.multas, setSimit, setSimitError);
  }, [enableSimit, runtPersona, simit.consultado]);

  const consultarSimit = async () => {
    const doc = parte.documento.trim();
    if (!doc) { toast.error('Ingresa el documento del comprador'); return; }
    setSimit((s) => ({ ...s, loading: true }));
    setSimitError(null);
    try {
      const r = await api.post<{ ok: boolean; total: number; totalMonto: number; message?: string }>('/simit/consulta', { filtro: doc });
      if (r.ok) {
        setSimit({ total: r.total, totalMonto: r.totalMonto, loading: false, consultado: true, fuente: 'simit' });
        if (r.total > 0) {
          const msg = `Comprador con ${r.total} comparendo(s) SIMIT pendientes`;
          setSimitError(msg);
          toast.error(msg);
        } else {
          setSimitError(null);
          toast.success('Comprador sin multas SIMIT');
        }
      } else {
        setSimit((s) => ({ ...s, loading: false, consultado: false, fuente: undefined }));
        setSimitError(r.message || 'No se pudo consultar SIMIT');
        toast.error(r.message || 'No se pudo consultar SIMIT');
      }
    } catch (err) {
      const msg = errorMessage(err);
      setSimit((s) => ({ ...s, loading: false, consultado: false, fuente: undefined }));
      setSimitError(msg);
      toast.error(msg);
    }
  };

  const handleCedulaCaptured = (d: CedulaOcrData) => {
    const nombre = [d.firstName, d.secondName, d.lastName, d.secondLastName].filter(Boolean).join(' ').trim();
    const tipoMap: Record<string, string> = { cedula_extranjeria: 'CE', pasaporte: 'PAS', tarjeta_identidad: 'TI' };
    setParte((p) => ({
      ...p,
      nombre: nombre || p.nombre,
      documento: d.documentNumber || p.documento,
      tipoDoc: d.documentType?.startsWith('cc') ? 'CC' : tipoMap[d.documentType || ''] || p.tipoDoc || 'CC',
    }));
    const announce = `Cédula leída: ${nombre || 'nombre pendiente'}, documento ${d.documentNumber || parte.documento}. Verifica los datos.`;
    setOcrAnnounce(announce);
    toast.success('Cédula leída — verifica los datos');
  };

  const simitMultas = enableSimit && simit.consultado && simit.total > 0;
  const simitPendiente = enableSimit && runtConsultado && !simit.consultado;
  const runtPendiente = !runtConsultado;
  const simitGateBlocked = enableSimit && runtConsultado && (!simit.consultado || simit.total > 0) && !forzarContinuar;
  const continuarGateBlocked = runtPendiente || simitGateBlocked;
  const continuar = () => {
    if (!parte.email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parte.email.trim())) {
      const msg = 'El email es obligatorio y debe ser válido para la firma electrónica';
      setEmailError(msg);
      toast.error(msg);
      return;
    }
    setEmailError(null);
    if (runtPendiente) {
      toast.error('Consulte RUNT para verificar la identidad antes de continuar');
      return;
    }
    if (simitPendiente) {
      toast.error('Consulta SIMIT del comprador antes de continuar');
      return;
    }
    if (simitMultas) { toast.error('El comprador tiene comparendos SIMIT pendientes'); return; }
    const extra: Record<string, unknown> = {};
    if (runtPersistKey) {
      extra[runtPersistKey] = {
        documento: parte.documento.trim(),
        tipoDoc: parte.tipoDoc || 'CC',
        consultado: true,
        consultadoAt: new Date().toISOString(),
        nombreRunt: parte.nombre.trim(),
      };
    }
    if (enableSimit) {
      extra._simitComprador = {
        documento: parte.documento.trim(),
        consultado: true,
        total: simit.total,
        totalMonto: simit.totalMonto,
        fuente: simit.fuente || 'simit',
        consultadoAt: new Date().toISOString(),
      };
    }
    onContinuar(Object.keys(extra).length ? extra : undefined);
  };

  const consultarRunt = async () => {
    const doc = parte.documento.trim();
    if (!doc) { toast.error('Ingresa el número de documento'); return; }
    setRuntBusy(true);
    setRuntPersona(null);
    try {
      const res = await api.post<RuntPersonaResponse>('/runt/consulta-persona', { documento: doc, tipoDocumento: parte.tipoDoc || 'CC' });
      if (res.ok && res.persona) {
        setRuntPersona(res);
        setRuntConsultado(true);
        const fullName = [res.persona.nombres, res.persona.apellidos].filter(Boolean).join(' ').trim();
        setParte((p) => ({ ...p, documento: doc, nombre: fullName || p.nombre }));
        if (enableSimit && applyRuntMultasToSimit(res.multas, setSimit, setSimitError)) {
          toast.success(summaryRuntMultasToast(res.multas));
        } else {
          toast.success(`${fullName || 'Persona'} encontrado en RUNT`);
        }
      } else {
        toast.error(res.message || 'Persona no encontrada en RUNT');
      }
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setRuntBusy(false); }
  };

  return (
    <div>
      <p className="sr-only" aria-live="polite" aria-atomic="true">{ocrAnnounce}</p>
      <p className="mb-3 text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>{titulo}</p>
      <p className="mb-3 text-xs" style={{ color: 'var(--flit-text-muted)' }}>Ingresa el documento y consulta RUNT — es obligatorio para verificar la identidad.</p>
      {enableOcr && !readOnly && (
        <>
          <div className="mb-3 flex items-center gap-3">
            <div className="h-px flex-1" style={{ background: 'var(--flit-border-soft)' }} />
            <span className="text-[10px] uppercase" style={{ color: 'var(--flit-text-muted)' }}>o leer cédula</span>
            <div className="h-px flex-1" style={{ background: 'var(--flit-border-soft)' }} />
          </div>
          <button
            type="button"
            onClick={() => setCedulaOverlayOpen(true)}
            disabled={cedulaOverlayOpen || busy}
            className="flit-focus mb-4 flex w-full cursor-pointer items-center justify-center gap-2 rounded-[12px] border-2 border-dashed px-4 py-3 transition-all disabled:opacity-50"
            style={{ borderColor: 'var(--flit-border-input)' }}
          >
            <svg className="h-5 w-5" style={{ color: 'var(--flit-blue)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0zM18.75 10.5h.008v.008h-.008V10.5z" />
            </svg>
            <span className="text-sm font-semibold" style={{ color: 'var(--flit-blue)' }}>Capturar documento</span>
          </button>
          <CedulaCaptureOverlay
            open={cedulaOverlayOpen}
            onClose={() => setCedulaOverlayOpen(false)}
            onCaptured={handleCedulaCaptured}
          />
        </>
      )}
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="block text-xs font-semibold sm:w-28" style={{ color: 'var(--flit-text-secondary)' }}>
          Tipo doc
          <select value={parte.tipoDoc} onChange={(e) => set('tipoDoc')(e.target.value)} disabled={readOnly} className={inputCls} aria-label={`${titulo} tipo de documento`}>
            {TIPOS_DOC.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="block flex-1 text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
          Documento *
          <input value={parte.documento} onChange={(e) => set('documento')(e.target.value)} readOnly={readOnly} maxLength={20} aria-label={`${titulo} documento`}
            className={inputCls} style={readOnly ? { background: 'var(--flit-bg-app)', color: 'var(--flit-text-secondary)' } : undefined}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (!readOnly) consultarRunt(); } }} />
        </label>
        {!readOnly && (
          <GradientButton type="button" onClick={consultarRunt} disabled={busy || runtBusy} className="sm:mb-0">
            {runtBusy ? 'Consultando…' : 'Consultar RUNT'}
          </GradientButton>
        )}
      </div>
      {runtPendiente && (
        <p className="mb-4 text-xs font-semibold" style={{ color: 'var(--flit-warning)' }} role="status">
          Consulta RUNT obligatoria — verifique la identidad antes de continuar.
        </p>
      )}
      {enableSimit && (
        <div className="mb-4 rounded-[12px] border p-3" style={{ borderColor: simitMultas ? 'var(--flit-danger)' : simitPendiente ? 'var(--flit-warning)' : 'var(--flit-border-soft)', background: simitMultas ? 'rgba(228,61,48,0.06)' : simitPendiente ? 'rgba(240,90,53,0.06)' : 'transparent' }}>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-bold" style={{ color: simitMultas ? 'var(--flit-danger)' : simitPendiente ? 'var(--flit-warning)' : 'var(--flit-text-secondary)' }}>
              Comparendos del comprador {simit.consultado && simit.fuente === 'runt' ? '(RUNT)' : simit.consultado ? '(SIMIT)' : ''}
            </p>
            {!simit.consultado && !readOnly && (
              <button type="button" onClick={consultarSimit} disabled={simit.loading || busy}
                className="flit-focus shrink-0 rounded-[999px] px-3 py-1 text-[11px] font-semibold disabled:opacity-50"
                style={{ color: 'var(--flit-blue)', background: 'rgba(79,116,201,0.12)' }}>
                {simit.loading ? 'Consultando…' : 'Consultar SIMIT directo'}
              </button>
            )}
          </div>
          {simitPendiente ? (
            <p className="mt-2 text-xs font-semibold" style={{ color: 'var(--flit-warning)' }} role="status">
              Use «Consultar RUNT» arriba — trae multas y comparendos. SIMIT directo solo si RUNT no responde.
            </p>
          ) : simit.consultado ? (
            simit.total > 0
              ? <p className="mt-2 text-xs font-semibold" style={{ color: 'var(--flit-danger)' }} role="alert">{simit.total} comparendo(s) pendientes ({new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(simit.totalMonto)}). No puede continuar hasta sanear.</p>
              : <p className="mt-2 text-xs font-semibold" style={{ color: 'var(--flit-success)' }}>Sin comparendos pendientes {simit.fuente === 'runt' ? 'según RUNT' : 'según SIMIT'}.</p>
          ) : null}
          {simitError && !simitPendiente ? (
            <p className="mt-2 text-xs font-semibold" style={{ color: 'var(--flit-danger)' }} role="alert">{simitError}</p>
          ) : null}
        </div>
      )}
      {runtPersona?.persona && (
        <div className="mb-4 rounded-[12px] border p-3" style={{ borderColor: 'rgba(112,207,58,0.30)', background: 'rgba(112,207,58,0.10)' }}>
          <p className="text-xs font-semibold" style={{ color: 'var(--flit-success)' }}>
            Persona en RUNT: {[runtPersona.persona.nombres, runtPersona.persona.apellidos].filter(Boolean).join(' ')}
            {runtPersona.persona.estadoPersona ? ` — ${runtPersona.persona.estadoPersona}` : ''}
          </p>
          {runtPersona.multas && (() => {
            const s = summarizeRuntMultasComparendos(runtPersona.multas);
            if (!s?.resolved) return null;
            if (s.total > 0) {
              return <p className="mt-1 text-[11px]" style={{ color: 'var(--flit-danger)' }}>RUNT reporta {s.total} comparendo(s) pendiente(s).</p>;
            }
            return <p className="mt-1 text-[11px]" style={{ color: 'var(--flit-success)' }}>RUNT: sin comparendos pendientes.</p>;
          })()}
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Nombre completo *" value={parte.nombre} onChange={set('nombre')} maxLength={200} aria-label={`${titulo} nombre`} readOnly={readOnly} />
        <Field
          label="Email *"
          value={parte.email}
          onChange={set('email')}
          maxLength={150}
          type="email"
          aria-label={`${titulo} email`}
          hint={readOnly ? undefined : 'Se enviará el enlace de firma electrónica y validación biométrica a este correo.'}
          hintId={`${slug}-email-hint`}
          error={emailError ?? undefined}
          errorId={`${slug}-email-error`}
          readOnly={readOnly}
        />
        <Field label="Teléfono" value={parte.telefono} onChange={set('telefono')} maxLength={30} readOnly={readOnly} />
        <Field label="Dirección" value={parte.direccion} onChange={set('direccion')} maxLength={200} readOnly={readOnly} />
        <Field label="Ciudad" value={parte.ciudad} onChange={set('ciudad')} maxLength={100} readOnly={readOnly} />
      </div>
      {!readOnly && (
        <div className="mt-4 flex justify-end">
          <GradientButton type="button" onClick={continuar} disabled={busy || continuarGateBlocked} aria-disabled={busy || continuarGateBlocked}>
            Guardar y continuar
          </GradientButton>
        </div>
      )}
    </div>
  );
}
