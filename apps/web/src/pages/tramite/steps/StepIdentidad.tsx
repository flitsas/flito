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
    <div className="bg-[var(--color-surface-elevated)] rounded-[9px] border border-[color:var(--color-border)] p-6">
      <h3 className="text-lg font-bold mb-1" style={{ color: 'var(--color-action)' }}>Validación de identidad</h3>
      <p className="text-sm mb-5" style={{ color: 'var(--color-text-tertiary)' }}>Envia un enlace al comprador para que valide su identidad con selfie y documento</p>

      {/* Info comprador */}
      <div className="rounded-[9px] p-4 mb-5" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
          <div><span style={{ color: 'var(--color-text-tertiary)' }}>Comprador: </span><span className="font-medium" style={{ color: 'var(--color-text-primary)' }}>{comprador.nombre || '—'}</span></div>
          <div><span style={{ color: 'var(--color-text-tertiary)' }}>Documento: </span><span className="font-medium" style={{ color: 'var(--color-text-primary)' }}>{comprador.tipoDoc} {comprador.documento}</span></div>
          <div><span style={{ color: 'var(--color-text-tertiary)' }}>Email: </span><span className="font-medium" style={{ color: 'var(--color-text-primary)' }}>{comprador.email || 'Sin email'}</span></div>
        </div>
      </div>

      {/* Enlace manual (fallback): el correo no salió, pero el enlace es válido */}
      {enlaceManual && (
        <div className="rounded-[9px] p-4 mb-4" style={{ background: 'color-mix(in srgb, var(--kit-naranja) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--kit-naranja) 30%, transparent)' }}>
          <p className="text-xs font-bold mb-1" style={{ color: 'var(--kit-naranja-texto)' }}>No se pudo enviar el correo — envía el enlace manualmente</p>
          <p className="text-xs mb-2" style={{ color: 'var(--color-text-tertiary)' }}>El enlace ya es válido (expira en 24h). Cópialo y envíalo al comprador por WhatsApp/correo; al validar, esta pantalla se actualiza sola.</p>
          <div className="flex items-center gap-2">
            <input readOnly value={enlaceManual} onFocus={(e) => e.currentTarget.select()} className="flit-focus flex-1 px-3 py-2 rounded-[9px] text-xs border bg-[var(--color-surface-elevated)] font-mono outline-none" style={{ borderColor: 'var(--color-border-control)', color: 'var(--color-text-primary)' }} />
            <button onClick={() => { navigator.clipboard?.writeText(enlaceManual).then(() => toast.success('Enlace copiado')).catch(() => {}); }} className="flit-focus px-3 py-2 rounded-[999px] text-xs font-semibold text-white shrink-0" style={{ background: 'var(--kit-azul-relleno)' }}>Copiar</button>
          </div>
        </div>
      )}

      {/* Estado: no enviado */}
      {!emailSent && !validationStatus && (
        <div className="text-center py-6">
          <svg className="w-16 h-16 mx-auto mb-4" style={{ color: 'var(--color-action)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
          </svg>
          <p className="text-sm mb-1" style={{ color: 'var(--color-text-secondary)' }}>Se enviara un enlace de validación biométrica al correo del comprador</p>
          <p className="text-xs mb-5" style={{ color: 'var(--color-text-tertiary)' }}>El comprador capturara selfie + cedula desde su dispositivo. El enlace expira en 24 horas.</p>
          <button onClick={onEnviarEmail} disabled={emailSending || !comprador.email}
            className="flit-focus inline-flex items-center h-11 px-6 rounded-[999px] text-sm font-semibold text-white transition-transform motion-safe:active:scale-[0.99] disabled:opacity-50" style={{ background: 'var(--kit-azul-relleno)' }}>
            {emailSending ? 'Enviando...' : 'Enviar enlace de validación'}
          </button>
        </div>
      )}

      {/* Estado: email enviado, esperando */}
      {emailSent && (!validationStatus || validationStatus.estado === 'enviado') && (
        <div className="text-center py-6">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full flex items-center justify-center" style={{ background: 'color-mix(in srgb, var(--kit-naranja) 14%, transparent)' }}>
            <svg className="w-8 h-8" style={{ color: 'var(--kit-naranja-texto)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <p className="text-sm font-semibold mb-1" style={{ color: 'var(--kit-naranja-texto)' }}>Esperando validación del comprador</p>
          <p className="text-xs mb-1" style={{ color: 'var(--color-text-tertiary)' }}>Se envio un enlace a <strong>{comprador.email}</strong></p>
          <p className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>Esta pagina se actualiza automáticamente cada 5 segundos</p>
        </div>
      )}

      {/* Estado: en proceso */}
      {validationStatus?.estado === 'en_proceso' && (
        <div className="text-center py-6">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full flex items-center justify-center" style={{ background: 'color-mix(in srgb, var(--kit-azul) 14%, transparent)' }}>
            <svg className="w-8 h-8 animate-spin motion-reduce:animate-none" style={{ color: 'var(--color-action)' }} fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          </div>
          <p className="text-sm font-semibold" style={{ color: 'var(--color-action)' }}>Verificación forense en curso...</p>
          <p className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>Procesando captura biometrica y prueba de vida.</p>
        </div>
      )}

      {/* Estado: aprobado */}
      {validationStatus?.estado === 'aprobado' && (
        <div className="rounded-[9px] p-5 text-center" style={{ background: 'color-mix(in srgb, var(--kit-verde) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--kit-verde) 30%, transparent)' }}>
          <div className="w-14 h-14 mx-auto mb-3 rounded-full flex items-center justify-center" style={{ background: 'var(--kit-verde)' }}>
            <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
          </div>
          <p className="text-lg font-bold" style={{ color: 'var(--kit-verde-texto)' }}>Identidad verificada</p>
          <p className="text-3xl font-semibold my-2" style={{ color: 'var(--kit-verde-texto)' }}>{validationStatus.score}/100</p>
          <p className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>{validationStatus.nombre} — {validationStatus.documento}</p>
        </div>
      )}

      {/* Estado: rechazado */}
      {validationStatus?.estado === 'rechazado' && (
        <div className="rounded-[9px] p-5 text-center" style={{ background: 'color-mix(in srgb, var(--kit-rojo) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--kit-rojo) 30%, transparent)' }}>
          <div className="w-14 h-14 mx-auto mb-3 rounded-full flex items-center justify-center" style={{ background: 'var(--kit-rojo)' }}>
            <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </div>
          <p className="text-lg font-bold" style={{ color: 'var(--kit-rojo-texto)' }}>Validación rechazada</p>
          <p className="text-3xl font-semibold my-2" style={{ color: 'var(--kit-rojo-texto)' }}>{validationStatus.score || 0}/100</p>
          <p className="text-xs mb-3" style={{ color: 'var(--color-text-secondary)' }}>Intentos: {validationStatus.intentos}/5</p>
          <button onClick={onReenviar}
            className="flit-focus px-5 py-2 rounded-[999px] text-xs font-semibold text-white" style={{ background: 'var(--kit-naranja-boton)' }}>Reenviar enlace</button>
        </div>
      )}

      {/* A3: invitar comprador/vendedor por magic link */}
      {tramiteId && <InvitarParticipantes tramiteId={tramiteId} />}

      <div className="flex justify-between mt-5">
        <button onClick={onAtras} className="flit-focus px-5 py-2.5 rounded-[999px] text-sm font-medium border bg-[var(--color-surface-elevated)]" style={{ borderColor: 'var(--color-border-control)', color: 'var(--color-text-secondary)' }}>Atras</button>
        <button onClick={onContinuar}
          disabled={validationStatus?.estado !== 'aprobado'}
          className="flit-focus inline-flex items-center h-10 px-5 rounded-[999px] text-sm font-semibold text-white transition-opacity"
          style={validationStatus?.estado === 'aprobado'
            ? { background: 'var(--kit-verde)', color: 'var(--kit-tinta-fija)' }
            : { background: 'var(--color-text-tertiary)', opacity: 0.5, cursor: 'not-allowed' }}>
          Continuar
        </button>
      </div>
    </div>
  );
}
