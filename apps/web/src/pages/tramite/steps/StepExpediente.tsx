// TRAM-ARCH-01d · Paso 5 — Expediente digital, organismo de tránsito y cierre.
//
// Presentacional: el hook (useTramiteWizard) posee el estado y los handlers
// (confirmar organismo, guardar borrador, enviar a tránsito). Misma UX/markup.

import { useEffect, useState } from 'react';
import { computeChecklistWithOverride, type ChecklistOverride } from '@operaciones/shared-types';
import { api } from '../../../lib/api';
import ExpedienteVisor from '../../../components/ExpedienteVisor';
import ExpedienteTimeline from '../ExpedienteTimeline';
import MatriculaResumen from './MatriculaResumen';
import { DOC_TYPES, ORGANISMOS_TRANSITO } from '../../../constants/tramite';
import FlitModal from '../../../components/flit/FlitModal';
import { FLIT_OK, FLIT_INFO, FLIT_PRIMARY } from '../wizard/flitStepKit';
import TipologiaContextBanner from '../TipologiaContextBanner';
import FirmaPanel from '../FirmaPanel';
import type { VehiculoData, CompradorData, OcrResult, ArchivoData, ValidationStatus, OrgTransito } from '../wizard/types';

export interface StepExpedienteProps {
  tramiteId: number;
  vehiculo: VehiculoData | null;
  comprador: CompradorData;
  vin: string;
  archivos: ArchivoData[];
  ocrResults: Record<string, OcrResult>;
  validationStatus: ValidationStatus | null;
  emailSent: boolean;
  estadoTramite: string;
  tipologiaCodigo: string | null;
  checklistEstado: Record<string, boolean>;
  orgTransito: OrgTransito;
  setOrgTransito: (o: OrgTransito) => void;
  showOrgModal: boolean;
  setShowOrgModal: (v: boolean) => void;
  onConfirmarOrg: () => void;
  setStep: (n: number) => void;
  setOcrResults: (r: Record<string, OcrResult>) => void;
  onClose: () => void;
  onGuardarBorrador: () => void;
  onEnviarTransito: (todoListo: boolean) => void;
}

export default function StepExpediente({
  tramiteId, vehiculo, comprador, vin, archivos, ocrResults, validationStatus, emailSent,
  estadoTramite, tipologiaCodigo, checklistEstado, orgTransito, setOrgTransito, showOrgModal,
  setShowOrgModal, onConfirmarOrg, setStep, setOcrResults, onClose, onGuardarBorrador, onEnviarTransito,
}: StepExpedienteProps) {
  const docsRechazados = Object.values(ocrResults).filter((d) => d._rechazado);
  const docsRequeridos = DOC_TYPES.filter((d) => d.required);
  const docsFaltantes = docsRequeridos.filter((d) => !archivos.some((a) => a.tipo === d.key));
  const identidadAprobada = validationStatus?.estado === 'aprobado';
  const orgSeleccionado = !!orgTransito.nombre;
  const [checklistOverride, setChecklistOverride] = useState<ChecklistOverride | null>(null);

  useEffect(() => {
    if (!orgTransito.codigo || !tipologiaCodigo) {
      setChecklistOverride(null);
      return;
    }
    let cancelled = false;
    api.get<{ override: ChecklistOverride }>(`/transito/organismos-config/${orgTransito.codigo}/checklist/${tipologiaCodigo}`)
      .then((d) => { if (!cancelled) setChecklistOverride(d.override ?? null); })
      .catch(() => { if (!cancelled) setChecklistOverride(null); });
    return () => { cancelled = true; };
  }, [orgTransito.codigo, tipologiaCodigo]);

  // A5 + TRAM-MT-02 F2: obligatorios efectivos según organismo destino.
  const checklistRes = computeChecklistWithOverride(
    tipologiaCodigo, checklistEstado, archivos.map((a) => a.tipo), checklistOverride,
  );
  const checklistOk = !checklistRes || checklistRes.completo;
  const todoListo = docsRechazados.length === 0 && docsFaltantes.length === 0 && identidadAprobada && orgSeleccionado && checklistOk;

  return (
    <div>
      <TipologiaContextBanner codigo={tipologiaCodigo} paso={5} className="mb-4" />
      {/* Modal secretaría de tránsito — OBLIGATORIA */}
      {showOrgModal && (
        <FlitModal title="Secretaría de Tránsito" onClose={() => setShowOrgModal(false)}>
          <p className="text-sm mb-5" style={{ color: 'var(--flit-text-secondary)' }}>Seleccione en qué secretaría de tránsito desea realizar la matrícula inicial. Este dato es obligatorio para generar el FUR.</p>
          {/* Sugerencia RUNT */}
          {vehiculo?.organismoTransito && !orgTransito.nombre && (
            <button onClick={() => {
              const name = vehiculo?.organismoTransito;
              if (!name) return;
              const found = ORGANISMOS_TRANSITO.find((o) => name.toUpperCase().includes(o.ciudad.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')));
              setOrgTransito({ nombre: name, ciudad: found?.ciudad || '', codigo: found?.codigo || '' });
            }}
              className="flit-focus mb-4 w-full rounded-xl py-3 px-4 text-left text-sm font-semibold" style={FLIT_INFO}>
              Usar organismo registrado en RUNT:<br/><span className="text-xs font-normal text-[color:var(--flit-blue)]">{vehiculo.organismoTransito}</span>
            </button>
          )}

          {/* Buscador */}
          <div className="mb-3">
            <label className="block text-xs font-semibold text-[color:var(--flit-text-muted)] mb-1.5">Buscar por ciudad</label>
            <input placeholder="Escriba el nombre de la ciudad..." autoFocus
              className="w-full px-4 py-3 rounded-xl text-sm border border-[color:var(--flit-border-input)] focus:border-[color:var(--flit-blue)] focus:ring-2 focus:ring-[color:var(--flit-blue)]/30 outline-none"
              onChange={(e) => {
                const q = e.target.value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
                document.querySelectorAll<HTMLElement>('[data-org-item]').forEach((el) => {
                  el.style.display = q.length < 2 || el.dataset.orgItem!.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes(q) ? '' : 'none';
                });
              }} />
          </div>

          {/* Lista de organismos */}
          <div className="max-h-52 overflow-auto border border-[color:var(--flit-border-input)] rounded-xl mb-4">
            {ORGANISMOS_TRANSITO.map((o) => {
              const selected = orgTransito.codigo === o.codigo;
              return (
                <button key={o.codigo} data-org-item={`${o.nombre} ${o.ciudad}`}
                  onClick={() => setOrgTransito({ nombre: o.nombre, ciudad: o.ciudad, codigo: o.codigo })}
                  className={`flit-focus w-full border-b border-[color:var(--flit-border-soft)] px-4 py-2.5 text-left text-sm transition-colors last:border-0 ${selected ? 'font-semibold' : 'hover:bg-[color:var(--flit-bg-app)]'}`}
                  style={selected ? { background: 'rgba(79,116,201,0.12)', color: 'var(--flit-blue)' } : undefined}>
                  <div className="flex items-center justify-between">
                    <span className="truncate">{o.nombre}</span>
                    <span className="text-[10px] font-mono text-[color:var(--flit-text-muted)] ml-2 flex-shrink-0">{o.codigo}</span>
                  </div>
                  <span className="text-[10px] text-[color:var(--flit-text-muted)]">{o.ciudad}</span>
                </button>
              );
            })}
          </div>

          {/* Selección actual */}
          {orgTransito.nombre && (
            <div className="mb-4 flex items-center gap-2 rounded-xl border p-3" style={FLIT_OK}>
              <svg className="w-4 h-4 shrink-0" style={{ color: 'var(--flit-success)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
              <div>
                <p className="text-xs font-bold" style={{ color: 'var(--flit-success)' }}>{orgTransito.nombre}</p>
                <p className="text-[10px]" style={{ color: 'var(--flit-success)' }}>{orgTransito.ciudad} · Código: {orgTransito.codigo}</p>
              </div>
            </div>
          )}

          <button onClick={onConfirmarOrg}
            disabled={!orgTransito.nombre}
            className={`flit-focus inline-flex h-11 w-full items-center justify-center rounded-[999px] px-5 text-sm font-semibold text-white transition-opacity ${!orgTransito.nombre ? 'cursor-not-allowed opacity-50' : ''}`}
            style={orgTransito.nombre ? { background: 'var(--flit-gradient-success)' } : { background: 'var(--flit-text-muted)' }}>
            Confirmar selección
          </button>
        </FlitModal>
      )}

      {/* Seleccion de secretaria */}
      {!orgTransito.nombre && (
        <div className="mb-4 flex items-center justify-between rounded-[12px] p-4" style={{ background: 'rgba(240,90,53,0.10)', border: '1px solid rgba(240,90,53,0.30)' }}>
          <div>
            <p className="text-sm font-semibold" style={{ color: 'var(--flit-warning)' }}>Selecciona la secretaría de tránsito</p>
            <p className="mt-0.5 text-xs" style={{ color: 'var(--flit-warning)' }}>Requerido para generar el FUR</p>
          </div>
          <button onClick={() => setShowOrgModal(true)} className={`${FLIT_PRIMARY} shrink-0`} style={{ background: 'var(--flit-gradient-primary)' }}>
            Seleccionar
          </button>
        </div>
      )}
      {orgTransito.nombre && (
        <div className=" border rounded-xl p-3 mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-[color:var(--flit-success)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            <div>
              <p className="text-xs font-bold text-[color:var(--flit-success)]">{orgTransito.nombre}</p>
              <p className="text-[10px] text-[color:var(--flit-success)]">{[orgTransito.ciudad, orgTransito.codigo].filter(Boolean).join(' · ')}</p>
            </div>
          </div>
          <button onClick={() => setShowOrgModal(true)} className="text-xs text-[color:var(--flit-blue)] font-medium hover:underline">Cambiar</button>
        </div>
      )}

      {/* TRAM-INNOV-B3: firma electrónica de compraventa (solo traspaso_standard). */}
      {tipologiaCodigo === 'traspaso_standard' && <FirmaPanel tramiteId={tramiteId} />}

      {/* Resumen consolidado del estado de la matrícula (todo de un vistazo). */}
      <MatriculaResumen
        estado={estadoTramite}
        vehiculo={vehiculo}
        comprador={comprador}
        vin={vin}
        archivosCount={archivos.length}
        identidadAprobada={identidadAprobada}
        orgTransito={orgTransito}
      />

      <ExpedienteVisor tramiteId={tramiteId} vehiculo={vehiculo || {}} comprador={comprador} vin={vin} archivos={archivos} validationStatus={validationStatus} emailSent={emailSent} orgTransito={orgTransito} />

      {/* A2: timeline del expediente + QR de verificación pública */}
      <ExpedienteTimeline tramiteId={tramiteId} />

      {/* Banner de estado procesado por tránsito */}
      {['placa_preasignada', 'solicitud_soat', 'soat_comprado', 'soat_verificado', 'completado'].includes(estadoTramite) && (
        <div className="mt-4  border rounded-xl p-4 flex items-center gap-3">
          <svg className="w-6 h-6 text-[color:var(--flit-success)] flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          <div>
            <p className="text-sm font-bold text-[color:var(--flit-success)]">
              {estadoTramite === 'solicitud_soat' ? 'Placa asignada — pendiente SOAT'
                : estadoTramite === 'placa_preasignada' ? 'Placa asignada por tránsito'
                : 'Placa asignada — SOAT vigente'}
            </p>
            {vehiculo?.placa && (
              <p className="text-xl font-semibold text-[color:var(--flit-success)] tracking-widest font-mono mt-0.5">{vehiculo.placa}</p>
            )}
            <p className="text-xs text-[color:var(--flit-success)] mt-0.5">
              {estadoTramite === 'solicitud_soat'
                ? 'Tránsito asignó la placa. El trámite está en espera de la póliza SOAT.'
                : estadoTramite === 'placa_preasignada'
                  ? 'Tránsito confirmó la asignación de placa.'
                  : 'La matrícula cuenta con SOAT vigente; no se requiere solicitarlo.'}
            </p>
          </div>
        </div>
      )}
      {['enviado_transito', 'recibido_transito'].includes(estadoTramite) && (
        <div className="mt-4 flex items-center gap-3 rounded-xl p-4" style={FLIT_INFO}>
          <svg className="w-5 h-5 text-[color:var(--flit-blue)] flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6l4 2m6-2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          <div>
            <p className="text-sm font-bold text-[color:var(--flit-blue)]">Trámite en proceso en tránsito</p>
            <p className="text-xs text-[color:var(--flit-blue)] mt-0.5">
              {estadoTramite === 'enviado_transito' && 'Enviado a tránsito — esperando recepción.'}
              {estadoTramite === 'recibido_transito' && 'Recibido por tránsito — en revisión.'}
              {estadoTramite === 'placa_preasignada' && 'Placa preasignada — esperando confirmación final.'}
            </p>
          </div>
        </div>
      )}

      {/* Resumen de pendientes */}
      {!todoListo && (
        <div className=" border rounded-xl p-4 mt-4">
          <p className="text-sm font-bold text-[color:var(--flit-warning)] mb-3">Pendientes para enviar a tránsito</p>
          <div className="space-y-2 text-xs">
            {docsFaltantes.length > 0 && (
              <div className="p-2.5 bg-white rounded-xl border">
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2 text-[color:var(--flit-warning)]">
                    <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" /></svg>
                    <span className="font-semibold">Documentos faltantes:</span>
                  </div>
                  <button onClick={() => { setOcrResults({}); setStep(2); }} className="flit-focus rounded-xl px-3 py-1.5 text-[11px] font-bold" style={{ background: 'rgba(79,116,201,0.12)', color: 'var(--flit-blue)' }}>
                    Ir a documentos
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5 ml-6">
                  {docsFaltantes.map((d) => (
                    <span key={d.key} className="px-2 py-0.5 rounded text-[10px] font-semibold  text-[color:var(--flit-danger)]">{d.label}</span>
                  ))}
                </div>
              </div>
            )}
            {docsRechazados.length > 0 && (
              <div className="p-2.5 bg-white rounded-xl border">
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2 text-[color:var(--flit-danger)]">
                    <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                    <span className="font-semibold">Documentos rechazados:</span>
                  </div>
                  <button onClick={() => { setOcrResults({}); setStep(2); }} className="flit-focus rounded-xl px-3 py-1.5 text-[11px] font-bold" style={{ background: 'rgba(79,116,201,0.12)', color: 'var(--flit-blue)' }}>
                    Corregir
                  </button>
                </div>
                <div className="ml-6 space-y-1">
                  {docsRechazados.map((d, i) => (
                    <p key={i} className="text-[10px] text-[color:var(--flit-danger)]">{d._motivo}</p>
                  ))}
                </div>
              </div>
            )}
            {!identidadAprobada && (
              <div className="flex items-center justify-between p-2.5 bg-white rounded-xl border">
                <div className="flex items-center gap-2 text-[color:var(--flit-warning)]">
                  <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0" /></svg>
                  <span>Validación de identidad pendiente</span>
                </div>
                <button onClick={() => setStep(4)} className="flit-focus rounded-xl px-3 py-1.5 text-[11px] font-bold" style={{ background: 'rgba(79,116,201,0.12)', color: 'var(--flit-blue)' }}>
                  Ir a identidad
                </button>
              </div>
            )}
            {!orgSeleccionado && (
              <div className="flex items-center justify-between p-2.5 bg-white rounded-xl border">
                <div className="flex items-center gap-2 text-[color:var(--flit-warning)]">
                  <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 21h19.5m-18-18v18m10.5-18v18m6-13.5V21" /></svg>
                  <span>Falta seleccionar secretaría de tránsito</span>
                </div>
                <button onClick={() => setShowOrgModal(true)} className="flit-focus rounded-xl px-3 py-1.5 text-[11px] font-bold" style={{ background: 'rgba(79,116,201,0.12)', color: 'var(--flit-blue)' }}>
                  Seleccionar
                </button>
              </div>
            )}
            {checklistRes && !checklistRes.completo && (
              <div className="flex items-center justify-between p-2.5 bg-white rounded-xl border">
                <div className="flex items-center gap-2 text-[color:var(--flit-warning)]">
                  <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                  <span>Checklist {checklistRes.nombre}: faltan {checklistRes.faltanObligatorios.length} obligatorio(s)</span>
                </div>
                <button onClick={() => setStep(1)} className="flit-focus rounded-xl px-3 py-1.5 text-[11px] font-bold" style={{ background: 'rgba(79,116,201,0.12)', color: 'var(--flit-blue)' }}>
                  Ir al checklist
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="mt-4 flex flex-wrap justify-between gap-3">
        <button onClick={onClose} className="flit-focus inline-flex h-11 items-center rounded-[999px] border bg-white px-5 text-sm font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>Volver a la lista</button>
        <div className="flex gap-2">
          {/* Guardar borrador SOLO en estados editables: desde estados avanzados
              (enviado_transito, solicitud_soat…) el backend rechaza la transición
              a 'borrador' (409) y el botón quedaba inerte/confuso. */}
          {['borrador', 'rechazado'].includes(estadoTramite) && (
            <button onClick={onGuardarBorrador} className="flit-focus inline-flex h-11 items-center rounded-[999px] border bg-white px-6 text-sm font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>
              Guardar borrador
            </button>
          )}
          {/* Solo si estado es borrador o aprobado: enviar a transito */}
          {['borrador', 'aprobado'].includes(estadoTramite) && (
            <button onClick={() => onEnviarTransito(todoListo)} disabled={!todoListo}
              className="flit-focus inline-flex h-11 items-center rounded-[999px] px-6 text-sm font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
              style={{ background: 'var(--flit-gradient-success)' }}>
              Enviar a tránsito
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
