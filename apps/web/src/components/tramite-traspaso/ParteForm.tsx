// Formulario de una parte del traspaso (vendedor / comprador): RUNT, SIMIT, OCR de cédula y email.

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import toast from 'react-hot-toast';
import { normalizarDocumentoTraspaso, summarizeRuntMultasComparendos } from '@operaciones/shared-types';
import type { RuntPersonaResponse } from '../../pages/tramite/wizard/types';
import { api, errorMessage } from '../../lib/api';
import GradientButton from '../flit/GradientButton';
import { Icono } from '../flit/kit/Icono';
import CedulaCaptureOverlay, { type CedulaOcrData } from '../identidad/CedulaCaptureOverlay';
import Field from './TraspasoField';
import { inputCls } from './constantes';
import type { Parte, RuntConsultaPersist } from './tipos';

const TIPOS_DOC = ['CC', 'CE', 'NIT', 'PAS', 'TI'];

interface SimitState { total: number; totalMonto: number; loading: boolean; consultado: boolean; fuente?: 'runt' | 'simit' }
interface SimitInicial { documento?: string; consultado?: boolean; total?: number; totalMonto?: number; fuente?: 'runt' | 'simit' }

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

export default function ParteForm({ titulo, parte, setParte, onContinuar, busy, readOnly, enableSimit, enableOcr, simitInicial, runtInicial, runtPersistKey, forzarContinuar }: { titulo: string; parte: Parte; setParte: (u: (p: Parte) => Parte) => void; onContinuar: (extraVeh?: Record<string, unknown>) => void; busy: boolean; readOnly?: boolean; enableSimit?: boolean; enableOcr?: boolean; forzarContinuar?: boolean; simitInicial?: SimitInicial; runtInicial?: RuntConsultaPersist; runtPersistKey?: '_runtVendedor' | '_runtComprador' }) {
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
      <p className="m-0 mb-3 text-base font-bold" style={{ color: 'var(--color-action)' }}>{titulo}</p>
      <p className="mb-3 text-xs" style={{ color: 'var(--color-text-tertiary)' }}>Ingresa el documento y consulta RUNT — es obligatorio para verificar la identidad.</p>
      {enableOcr && !readOnly && (
        <>
          <div className="mb-3 flex items-center gap-3">
            <div className="h-px flex-1" style={{ background: 'var(--color-border)' }} />
            <span className="text-xs uppercase" style={{ color: 'var(--color-text-tertiary)' }}>o leer cédula</span>
            <div className="h-px flex-1" style={{ background: 'var(--color-border)' }} />
          </div>
          <button
            type="button"
            onClick={() => setCedulaOverlayOpen(true)}
            disabled={cedulaOverlayOpen || busy}
            className="flit-focus mb-4 flex w-full cursor-pointer items-center justify-center gap-2 rounded-[9px] border-[1.5px] border-dashed border-[color:var(--kit-azul)] bg-[var(--color-surface-elevated)] px-4 py-3 transition-colors hover:bg-[var(--kit-hover)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Icono nombre="credencial" size={20} style={{ color: 'var(--kit-azul)' }} />
            <span className="text-sm font-semibold" style={{ color: 'var(--color-action)' }}>Capturar documento</span>
          </button>
          <CedulaCaptureOverlay
            open={cedulaOverlayOpen}
            onClose={() => setCedulaOverlayOpen(false)}
            onCaptured={handleCedulaCaptured}
          />
        </>
      )}
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="block text-xs font-semibold sm:w-28" style={{ color: 'var(--color-text-primary)' }}>
          Tipo doc
          <select value={parte.tipoDoc} onChange={(e) => set('tipoDoc')(e.target.value)} disabled={readOnly} className={inputCls} aria-label={`${titulo} tipo de documento`}>
            {TIPOS_DOC.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="block flex-1 text-xs font-semibold" style={{ color: 'var(--color-text-primary)' }}>
          Documento *
          <input value={parte.documento} onChange={(e) => set('documento')(e.target.value)} readOnly={readOnly} maxLength={20} aria-label={`${titulo} documento`}
            className={inputCls}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (!readOnly) consultarRunt(); } }} />
        </label>
        {!readOnly && (
          <GradientButton type="button" onClick={consultarRunt} disabled={busy || runtBusy} className="sm:mb-0">
            {runtBusy ? 'Consultando…' : 'Consultar RUNT'}
          </GradientButton>
        )}
      </div>
      {runtPendiente && (
        <p className="mb-4 text-xs font-semibold" style={{ color: 'var(--kit-naranja-texto)' }} role="status">
          Consulta RUNT obligatoria — verifique la identidad antes de continuar.
        </p>
      )}
      {enableSimit && (
        <div className="mb-4 rounded-[9px] border p-3" style={{ borderColor: simitMultas ? 'var(--kit-rojo)' : simitPendiente ? 'var(--kit-naranja)' : 'var(--color-border)', background: simitMultas ? 'color-mix(in srgb, var(--kit-rojo) 6%, transparent)' : simitPendiente ? 'color-mix(in srgb, var(--kit-naranja) 6%, transparent)' : 'transparent' }}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="m-0 text-xs font-bold" style={{ color: simitMultas ? 'var(--kit-rojo-texto)' : simitPendiente ? 'var(--kit-naranja-texto)' : 'var(--color-text-secondary)' }}>
              Comparendos del comprador {simit.consultado && simit.fuente === 'runt' ? '(RUNT)' : simit.consultado ? '(SIMIT)' : ''}
            </p>
            {!simit.consultado && !readOnly && (
              <GradientButton type="button" variant="secondary" size="sm" onClick={consultarSimit} disabled={simit.loading || busy} className="shrink-0">
                {simit.loading ? 'Consultando…' : 'Consultar SIMIT directo'}
              </GradientButton>
            )}
          </div>
          {simitPendiente ? (
            <p className="mt-2 text-xs font-semibold" style={{ color: 'var(--kit-naranja-texto)' }} role="status">
              Use «Consultar RUNT» arriba — trae multas y comparendos. SIMIT directo solo si RUNT no responde.
            </p>
          ) : simit.consultado ? (
            simit.total > 0
              ? <p className="mt-2 text-xs font-semibold" style={{ color: 'var(--kit-rojo-texto)' }} role="alert">{simit.total} comparendo(s) pendientes ({new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(simit.totalMonto)}). No puede continuar hasta sanear.</p>
              : <p className="mt-2 text-xs font-semibold" style={{ color: 'var(--kit-verde-texto)' }}>Sin comparendos pendientes {simit.fuente === 'runt' ? 'según RUNT' : 'según SIMIT'}.</p>
          ) : null}
          {simitError && !simitPendiente ? (
            <p className="mt-2 text-xs font-semibold" style={{ color: 'var(--kit-rojo-texto)' }} role="alert">{simitError}</p>
          ) : null}
        </div>
      )}
      {runtPersona?.persona && (
        <div className="mb-4 rounded-[9px] border p-3" style={{ borderColor: 'color-mix(in srgb, var(--kit-verde) 30%, transparent)', background: 'color-mix(in srgb, var(--kit-verde) 10%, transparent)' }}>
          <p className="text-xs font-semibold" style={{ color: 'var(--kit-verde-texto)' }}>
            Persona en RUNT: {[runtPersona.persona.nombres, runtPersona.persona.apellidos].filter(Boolean).join(' ')}
            {runtPersona.persona.estadoPersona ? ` — ${runtPersona.persona.estadoPersona}` : ''}
          </p>
          {runtPersona.multas && (() => {
            const s = summarizeRuntMultasComparendos(runtPersona.multas);
            if (!s?.resolved) return null;
            if (s.total > 0) {
              return <p className="mt-1 text-xs" style={{ color: 'var(--kit-rojo-texto)' }}>RUNT reporta {s.total} comparendo(s) pendiente(s).</p>;
            }
            return <p className="mt-1 text-xs" style={{ color: 'var(--kit-verde-texto)' }}>RUNT: sin comparendos pendientes.</p>;
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
