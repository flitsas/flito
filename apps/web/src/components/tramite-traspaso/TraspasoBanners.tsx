import { ESTADO_STT_LABEL, type TramiteEstadoStt } from '@operaciones/shared-types';

// Backup prod 2026-06-10 — banner «paso cerrado» (solo consulta) dentro del paso.
export function PasoCerradoBanner() {
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

export function PasoEditableBanner({ paso }: { paso: number }) {
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
export function SubsanacionBanner({ nota }: { nota: string | null }) {
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
export function GestionCerradaBanner({ estado, isTransito }: { estado: string; isTransito: boolean }) {
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
