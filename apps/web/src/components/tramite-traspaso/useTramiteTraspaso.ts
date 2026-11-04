// Estado, efectos y acciones del asistente de traspaso (HU #13988: extraído de pages/TramiteTraspaso.tsx).
// El orden de los hooks y de los efectos es el del componente original: no reordenar.

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  ESTADO_STT_LABEL,
  impuestoIndicaPazSalvo,
  mensajePartesTraspasoDuplicadas,
  partesTraspasoDuplicadas,
  forzarContinuarActivo,
  maxPasoTraspasoAlcanzable,
  pasoTraspasoSoloLectura,
  puedeAvanzarDesdePasoTraspaso,
  puedeIrAPasoTraspaso,
  traspasoGestionCerrada,
  type TramiteEstadoStt,
  type TramiteWorkflowEvent,
} from '@operaciones/shared-types';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import type TraspasoStepDocumentos from '../../pages/tramite/TraspasoStepDocumentos';
import type { ComercialData } from '../../pages/tramite/TraspasoStepComercial';
import { resolveOrgFromRuntName } from '../../pages/tramite/TraspasoOrganismoPicker';
import type { OrgTransito } from '../../pages/tramite/wizard/types';
import { PARTE_VACIA } from './constantes';
import type { Parte, PreflightCheck } from './tipos';

type OnPatchDocumentos = ComponentProps<typeof TraspasoStepDocumentos>['onPatch'];

export function useTramiteTraspaso() {
  const [params] = useSearchParams();
  const resumeId = params.get('id');
  const { hasFuncion } = useAuth();
  // HU #12170: forzar continuidad = función del catálogo; bandeja de tránsito sin forzar = gestor OT.
  const isAdmin = hasFuncion('tramite.tramite.forzar_continuar');
  const isTransito = hasFuncion('transito.tramite.tomar') && !isAdmin;

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

  // Paso 2 — «Reintentar pre-vuelo».
  const reintentarPreflight = () => { preflightBooted.current = null; void ejecutarPreflight(); };

  // Paso 6 — callbacks del organismo y de los documentos.
  const cambiarOrganismo = (org: OrgTransito) => { guardarOrganismo(org).catch((e) => toast.error(errorMessage(e))); };
  const patchDocumentos: OnPatchDocumentos = async (body) => {
    if ('tipologiaCodigo' in body) setTipologiaCodigo(body.tipologiaCodigo as string);
    if ('checklistEstado' in body) setChecklistEstado(body.checklistEstado as Record<string, boolean>);
    await api.patch(`/tramites/${tramiteId}`, body);
  };
  const registrarPazSalvoSubido = async () => {
    const payload = { verificado: true, metodo: 'upload', at: new Date().toISOString() };
    setPazSalvoImpuesto(payload);
    await patch({ _pazSalvoImpuesto: payload }, {}, 6);
  };

  return {
    isAdmin, isTransito,
    step, tramiteId, radicado, estado, workflow, furGenerado, busy,
    placa, setPlaca, docPropietario, setDocPropietario, vehiculo,
    preflight, preflightLoading, preflightError,
    vendedor, setVendedor, comprador, setComprador,
    valorVenta, causal, observaciones,
    tipologiaCodigo, checklistEstado, orgTransito, pazSalvoImpuesto, impuestoConsulta,
    preflightBloquea, impuestoUnknown, pazSalvoOk, forzarActivo, gateCtx, maxPaso, gestionCerrada, pasoSoloLectura,
    consultar, radicar, ejecutarPreflight, reintentarPreflight, confirmarPazSalvoManual, consultarImpuesto,
    guardarVendedor, guardarComprador, guardarComercial,
    activarForzarContinuar, desactivarForzarContinuar,
    irPaso, continuarDesdePaso, transicionar, pasoNavHabilitado,
    cambiarOrganismo, patchDocumentos, registrarPazSalvoSubido,
  };
}

export type UseTramiteTraspaso = ReturnType<typeof useTramiteTraspaso>;
