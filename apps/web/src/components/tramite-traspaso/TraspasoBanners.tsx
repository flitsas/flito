import type { ReactNode } from 'react';
import { ESTADO_STT_LABEL, type TramiteEstadoStt } from '@operaciones/shared-types';

// Aviso en página del UI Kit 2026 (marcado de InlineAlert: `.kit-alerta` + `data-tono`). Se usa el marcado y no el
// componente porque estos avisos son `role="status"` en todos los tonos (InlineAlert pasa warn a `role="alert"`).
const ICONO = { info: '/kit/aviso-info.svg', ok: '/kit/aviso-ok.svg', warn: '/kit/aviso-alerta.svg' } as const;
function AvisoPagina({ tono, className = '', children }: { tono: keyof typeof ICONO; className?: string; children: ReactNode }) {
  return (
    <div className={`kit-alerta ${className}`} data-tono={tono} data-kit="alerta" role="status">
      <img src={ICONO[tono]} alt="" aria-hidden="true" className="kit-alerta__icono" />
      <div className="min-w-0 flex-1 text-sm">{children}</div>
    </div>
  );
}

const textoSec = { color: 'var(--color-text-secondary)' };

// Backup prod 2026-06-10 — banner «paso cerrado» (solo consulta) dentro del paso.
export function PasoCerradoBanner() {
  return (
    <AvisoPagina tono="ok" className="mb-4">
      <p className="m-0 text-sm font-bold" style={{ color: 'var(--kit-verde-texto)' }}>Paso cerrado — solo consulta</p>
      <p className="m-0 mt-1 text-xs" style={textoSec}>
        Este paso ya fue validado y guardado. Los campos están bloqueados. Para avanzar usa el paso activo resaltado arriba.
      </p>
    </AvisoPagina>
  );
}

export function PasoEditableBanner({ paso }: { paso: number }) {
  return (
    <AvisoPagina tono="info" className="mb-4">
      <p className="m-0 text-sm font-bold" style={{ color: 'var(--color-action)' }}>
        Paso {paso} editable — completa y guarda para cerrarlo
      </p>
    </AvisoPagina>
  );
}

// Estado subsanación: el organismo devolvió el trámite — el gestor puede corregir.
export function SubsanacionBanner({ nota }: { nota: string | null }) {
  return (
    <AvisoPagina tono="warn">
      <p className="m-0 text-sm font-bold" style={{ color: 'var(--kit-naranja-texto)' }}>
        Subsanación STT — puede corregir el expediente
      </p>
      <p className="m-0 mt-1 text-xs" style={textoSec}>
        El organismo de tránsito devolvió el trámite para correcciones. Complete los ajustes y vuelva a enviar a validación STT.
      </p>
      {nota && (
        <p className="m-0 mt-2 rounded-[9px] border px-3 py-2 text-xs font-semibold"
          style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-elevated)', color: 'var(--color-text-primary)' }}>
          Observación STT: {nota}
        </p>
      )}
    </AvisoPagina>
  );
}

// Gestión CEA cerrada (estado STT fuera de radicado/subsanación) → expediente bloqueado.
export function GestionCerradaBanner({ estado, isTransito }: { estado: string; isTransito: boolean }) {
  const label = ESTADO_STT_LABEL[estado as TramiteEstadoStt] ?? estado;
  return (
    <AvisoPagina tono="info">
      {isTransito ? (
        <>
          <p className="m-0 text-sm font-bold" style={{ color: 'var(--color-action)' }}>
            Expediente STT en {label} — solo consulta
          </p>
          <p className="m-0 mt-1 text-xs" style={textoSec}>
            El CEA ya cerró la gestión. Revisa documentos e identidad abajo (solo lectura). Para avanzar el trámite usa
            los botones STT al final del paso <strong>Documentos</strong> o la <strong>bandeja Traspasos STT</strong>
            {' '}(Subsanación, En trámite, Rechazado…).
          </p>
        </>
      ) : (
        <>
          <p className="m-0 text-sm font-bold" style={{ color: 'var(--color-action)' }}>
            Gestión enviada a STT — expediente bloqueado
          </p>
          <p className="m-0 mt-1 text-xs" style={textoSec}>
            Estado actual: <strong>{label}</strong>. Ya no puedes subir documentos ni modificar datos. Si el organismo
            pide correcciones, un operador de tránsito debe mover el trámite a <strong>Subsanación</strong>; entonces
            podrás editar de nuevo.
          </p>
        </>
      )}
    </AvisoPagina>
  );
}
