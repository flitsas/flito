// TRAM-ARCH-01c · Paso 4 — Validación de identidad por email (selfie + cédula).
//
// Presentacional: el shell posee el estado (envío, polling) y pasa callbacks.
// Misma UX/markup que el bloque inline previo.

import toast from 'react-hot-toast';
import InvitarParticipantes from '../InvitarParticipantes';
import type { CompradorData, ValidationStatus } from '../wizard/types';

export interface StepIdentidadProps {
  comprador: CompradorData;
  enlaceManual: string | null;
  emailSent: boolean;
  validationStatus: ValidationStatus | null;
  onEnviarEmail: () => void;
  emailSending: boolean;
  tramiteId: number | null;
  onReenviar: () => void;
  onAtras: () => void;
  onContinuar: () => void;
}

export default function StepIdentidad({
  comprador, enlaceManual, emailSent, validationStatus, onEnviarEmail, emailSending,
  tramiteId, onReenviar, onAtras, onContinuar,
}: StepIdentidadProps) {
  return (
    <div className="bg-white rounded-[18px] border border-[color:var(--flit-border-soft)] shadow-[0_8px_24px_rgba(22,39,68,0.08)] p-6">
      <h3 className="text-lg font-bold mb-1" style={{ color: 'var(--flit-blue-text)' }}>Validación de identidad</h3>
      <p className="text-sm mb-5" style={{ color: 'var(--flit-text-muted)' }}>Envia un enlace al comprador para que valide su identidad con selfie y documento</p>

      {/* Info comprador */}
      <div className="rounded-[12px] p-4 mb-5" style={{ background: 'var(--flit-bg-app)', border: '1px solid var(--flit-border-soft)' }}>
        <div className="grid grid-cols-3 gap-3 text-xs">
          <div><span style={{ color: 'var(--flit-text-muted)' }}>Comprador: </span><span className="font-medium" style={{ color: 'var(--flit-text-primary)' }}>{comprador.nombre || '—'}</span></div>
          <div><span style={{ color: 'var(--flit-text-muted)' }}>Documento: </span><span className="font-medium" style={{ color: 'var(--flit-text-primary)' }}>{comprador.tipoDoc} {comprador.documento}</span></div>
          <div><span style={{ color: 'var(--flit-text-muted)' }}>Email: </span><span className="font-medium" style={{ color: 'var(--flit-text-primary)' }}>{comprador.email || 'Sin email'}</span></div>
        </div>
      </div>

      {/* Enlace manual (fallback): el correo no salió, pero el enlace es válido */}
      {enlaceManual && (
        <div className="rounded-[12px] p-4 mb-4" style={{ background: 'rgba(240,90,53,0.10)', border: '1px solid rgba(240,90,53,0.30)' }}>
          <p className="text-xs font-bold mb-1" style={{ color: 'var(--flit-warning)' }}>No se pudo enviar el correo — envía el enlace manualmente</p>
          <p className="text-[11px] mb-2" style={{ color: 'var(--flit-text-muted)' }}>El enlace ya es válido (expira en 24h). Cópialo y envíalo al comprador por WhatsApp/correo; al validar, esta pantalla se actualiza sola.</p>
          <div className="flex items-center gap-2">
            <input readOnly value={enlaceManual} onFocus={(e) => e.currentTarget.select()} className="flit-focus flex-1 px-3 py-2 rounded-[10px] text-xs border bg-white font-mono outline-none" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }} />
            <button onClick={() => { navigator.clipboard?.writeText(enlaceManual).then(() => toast.success('Enlace copiado')).catch(() => {}); }} className="flit-focus px-3 py-2 rounded-[999px] text-xs font-semibold text-white shrink-0" style={{ background: 'var(--flit-gradient-primary)' }}>Copiar</button>
          </div>
        </div>
      )}

      {/* Estado: no enviado */}
      {!emailSent && !validationStatus && (
        <div className="text-center py-6">
          <svg className="w-16 h-16 mx-auto mb-4" style={{ color: 'var(--flit-blue)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
          </svg>
          <p className="text-sm mb-1" style={{ color: 'var(--flit-text-secondary)' }}>Se enviara un enlace de validación biométrica al correo del comprador</p>
          <p className="text-xs mb-5" style={{ color: 'var(--flit-text-muted)' }}>El comprador capturara selfie + cedula desde su dispositivo. El enlace expira en 24 horas.</p>
          <button onClick={onEnviarEmail} disabled={emailSending || !comprador.email}
            className="flit-focus inline-flex items-center h-11 px-6 rounded-[999px] text-sm font-semibold text-white transition-transform motion-safe:active:scale-[0.99] disabled:opacity-50" style={{ background: 'var(--flit-gradient-primary)', boxShadow: 'var(--flit-shadow-button)' }}>
            {emailSending ? 'Enviando...' : 'Enviar enlace de validación'}
          </button>
        </div>
      )}

      {/* Estado: email enviado, esperando */}
      {emailSent && (!validationStatus || validationStatus.estado === 'enviado') && (
        <div className="text-center py-6">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full flex items-center justify-center" style={{ background: 'rgba(240,90,53,0.14)' }}>
            <svg className="w-8 h-8 animate-pulse motion-reduce:animate-none" style={{ color: 'var(--flit-warning)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <p className="text-sm font-semibold mb-1" style={{ color: 'var(--flit-warning)' }}>Esperando validación del comprador</p>
          <p className="text-xs mb-1" style={{ color: 'var(--flit-text-muted)' }}>Se envio un enlace a <strong>{comprador.email}</strong></p>
          <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Esta pagina se actualiza automáticamente cada 5 segundos</p>
        </div>
      )}

      {/* Estado: en proceso */}
      {validationStatus?.estado === 'en_proceso' && (
        <div className="text-center py-6">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full flex items-center justify-center" style={{ background: 'rgba(79,116,201,0.14)' }}>
            <svg className="w-8 h-8 animate-spin motion-reduce:animate-none" style={{ color: 'var(--flit-blue)' }} fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          </div>
          <p className="text-sm font-semibold" style={{ color: 'var(--flit-blue)' }}>Verificación forense en curso...</p>
          <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Procesando captura biometrica y prueba de vida.</p>
        </div>
      )}

      {/* Estado: aprobado */}
      {validationStatus?.estado === 'aprobado' && (
        <div className="rounded-[12px] p-5 text-center" style={{ background: 'rgba(112,207,58,0.10)', border: '1px solid rgba(112,207,58,0.30)' }}>
          <div className="w-14 h-14 mx-auto mb-3 rounded-full flex items-center justify-center" style={{ background: 'var(--flit-success)' }}>
            <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
          </div>
          <p className="text-lg font-bold" style={{ color: 'var(--flit-success)' }}>Identidad verificada</p>
          <p className="text-3xl font-semibold my-2" style={{ color: 'var(--flit-success)' }}>{validationStatus.score}/100</p>
          <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{validationStatus.nombre} — {validationStatus.documento}</p>
        </div>
      )}

      {/* Estado: rechazado */}
      {validationStatus?.estado === 'rechazado' && (
        <div className="rounded-[12px] p-5 text-center" style={{ background: 'rgba(228,61,48,0.10)', border: '1px solid rgba(228,61,48,0.30)' }}>
          <div className="w-14 h-14 mx-auto mb-3 rounded-full flex items-center justify-center" style={{ background: 'var(--flit-danger)' }}>
            <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </div>
          <p className="text-lg font-bold" style={{ color: 'var(--flit-danger)' }}>Validación rechazada</p>
          <p className="text-3xl font-semibold my-2" style={{ color: 'var(--flit-danger)' }}>{validationStatus.score || 0}/100</p>
          <p className="text-xs mb-3" style={{ color: 'var(--flit-text-secondary)' }}>Intentos: {validationStatus.intentos}/5</p>
          <button onClick={onReenviar}
            className="flit-focus px-5 py-2 rounded-[999px] text-xs font-semibold text-white" style={{ background: 'var(--flit-gradient-danger)' }}>Reenviar enlace</button>
        </div>
      )}

      {/* A3: invitar comprador/vendedor por magic link */}
      {tramiteId && <InvitarParticipantes tramiteId={tramiteId} />}

      <div className="flex justify-between mt-5">
        <button onClick={onAtras} className="flit-focus px-5 py-2.5 rounded-[999px] text-sm font-medium border bg-white" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>Atras</button>
        <button onClick={onContinuar}
          disabled={validationStatus?.estado !== 'aprobado'}
          className="flit-focus inline-flex items-center h-10 px-5 rounded-[999px] text-sm font-semibold text-white transition-opacity"
          style={validationStatus?.estado === 'aprobado'
            ? { background: 'var(--flit-gradient-success)', boxShadow: 'var(--flit-shadow-button)' }
            : { background: 'var(--flit-text-muted)', opacity: 0.5, cursor: 'not-allowed' }}>
          Continuar
        </button>
      </div>
    </div>
  );
}
