// Modal preflight para cierre WORM del diagnóstico PESV.
//
// Sustituye al confirm() nativo que permitía cerrar diagnósticos con score 0% y
// 0 evidencias. El preflight es defensa en profundidad — el servidor recalcula
// y rechaza si puedeCerrar=false (BICHO A5). El cliente lo pinta para UX.
//
// WCAG 2.2 AA: role=dialog aria-modal=true, focus trap cíclico, Esc cierra,
// foco inicial en checkbox WORM (acción más importante).

import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import toast from 'react-hot-toast';
import { errorMessage } from '../../lib/api';
import { CloseIcon } from './shared';
import { makeFocusTrapHandler, SpinnerIcon, ChevronRightIcon } from './diagnostico-helpers';

export interface PreflightBloqueo {
  estandarId: number;
  codigo: string;
  motivo: 'sin_evaluar' | 'nivel_implementado_sin_evidencia' | 'nivel_sostenido_sin_evidencia';
}

export interface PreflightAdvertencia {
  estandarId: number;
  codigo: string;
  motivo: 'en_desarrollo_sin_comentario';
}

export interface Preflight {
  scoreProyectado: number;
  totalEstandares: number;
  evaluados: number;
  conEvidencia: number;
  bloqueos: PreflightBloqueo[];
  advertencias: PreflightAdvertencia[];
  puedeCerrar: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  diagnosticoId: number;
  preflight: Preflight | null;
  anio?: number;
  onConfirm: () => Promise<void>;
  onGoToStandard: (estandarId: number) => void;
}

const BLOQUEO_LABEL: Record<PreflightBloqueo['motivo'], string> = {
  sin_evaluar: 'Sin evaluar',
  nivel_implementado_sin_evidencia: 'Nivel Implementado sin evidencia adjunta',
  nivel_sostenido_sin_evidencia: 'Nivel Sostenido sin evidencia adjunta',
};

const ADVERTENCIA_LABEL: Record<PreflightAdvertencia['motivo'], string> = {
  en_desarrollo_sin_comentario: 'En desarrollo sin comentario justificativo',
};

function LockIcon() {
  return (
    <svg className="h-5 w-5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 11V7a5 5 0 0110 0v4" />
    </svg>
  );
}

function ResumenCard({ label, value, emphasis = false }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className="rounded-[12px] p-4" style={{ border: '1px solid var(--flit-border-soft)', background: 'var(--flit-bg-app)' }}>
      <div className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--flit-text-muted)' }}>{label}</div>
      <div className="mt-2 text-3xl tabular-nums tracking-tight" style={{ fontSize: emphasis ? undefined : '1.5rem', fontWeight: 700, color: emphasis ? 'var(--flit-blue)' : 'var(--flit-text-primary)' }}>
        {value}
      </div>
    </div>
  );
}

function RowAction({ codigo, motivo, onGoTo }: { codigo: string; motivo: string; onGoTo: () => void }) {
  return (
    <tr className="border-t" style={{ borderColor: 'var(--flit-border-soft)' }}>
      <td className="px-4 py-2 font-mono text-xs" style={{ color: 'var(--flit-text-primary)' }}>{codigo}</td>
      <td className="px-4 py-2 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{motivo}</td>
      <td className="px-4 py-2 text-right">
        <button
          type="button"
          onClick={onGoTo}
          className="flit-focus inline-flex h-7 items-center gap-1 rounded-[999px] border bg-white px-2.5 text-[11px] font-medium"
          style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-blue)' }}
        >
          Ir al estándar
          <ChevronRightIcon />
        </button>
      </td>
    </tr>
  );
}

function TableHeader() {
  return (
    <thead>
      <tr>
        <th className="px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-wide" style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>Código</th>
        <th className="px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-wide" style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>Motivo</th>
        <th className="px-4 py-2 text-right text-[11px] font-semibold uppercase tracking-wide" style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>Acción</th>
      </tr>
    </thead>
  );
}

export default function DiagnosticoCierreModal({
  open,
  onClose,
  preflight,
  anio,
  onConfirm,
  onGoToStandard,
}: Props) {
  const [accepted, setAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);
  const checkboxRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      setAccepted(false);
      setSubmitting(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => {
      const hasBlocks = (preflight?.bloqueos.length ?? 0) > 0;
      if (hasBlocks) cancelRef.current?.focus();
      else checkboxRef.current?.focus();
    }, 50);
    return () => {
      clearTimeout(t);
      previousFocusRef.current?.focus?.();
    };
  }, [open, preflight?.bloqueos.length]);

  const trapHandler = makeFocusTrapHandler(modalRef);

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (!submitting) onClose();
      return;
    }
    trapHandler(e);
  };

  const handleConfirm = useCallback(async () => {
    if (!preflight || preflight.bloqueos.length > 0 || !accepted) return;
    setSubmitting(true);
    try {
      await onConfirm();
    } catch (e) {
      toast.error(errorMessage(e));
      setSubmitting(false);
    }
    // Si éxito, parent cierra y navega — no reseteamos submitting.
  }, [preflight, accepted, onConfirm]);

  if (!open) return null;

  const hasBlocks = (preflight?.bloqueos.length ?? 0) > 0;
  const hasWarnings = (preflight?.advertencias.length ?? 0) > 0;
  const canConfirm = !!preflight && !hasBlocks && accepted && !submitting;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="cierre-modal-title"
      className="fixed inset-0 z-40 flex items-center justify-center p-6"
      onKeyDown={handleKeyDown}
    >
      <div
        className="absolute inset-0"
        style={{ background: 'rgba(22, 39, 68, 0.45)', backdropFilter: 'blur(6px)' }}
        onClick={() => !submitting && onClose()}
        aria-hidden="true"
      />

      <div
        ref={modalRef}
        className="relative flex max-h-[90vh] w-full max-w-[720px] flex-col animate-in fade-in zoom-in-95 duration-200 ease-out motion-reduce:animate-none"
        style={{ background: 'var(--flit-bg-modal)', borderRadius: 'var(--flit-radius-xl)', boxShadow: 'var(--flit-shadow-modal)', border: '1px solid var(--flit-border-soft)' }}
      >
        <header className="flex items-start justify-between gap-3 p-6" style={{ borderBottom: '1px solid var(--flit-border-soft)' }}>
          <div className="min-w-0">
            <h2 id="cierre-modal-title" className="text-2xl font-bold tracking-tight" style={{ color: 'var(--flit-blue-text)' }}>
              Cerrar diagnóstico {anio ?? ''}
            </h2>
            <p className="mt-1 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
              Antes de cerrar definitivamente, revise el siguiente expediente.
            </p>
          </div>
          <button
            type="button"
            onClick={() => !submitting && onClose()}
            disabled={submitting}
            aria-label="Cerrar modal"
            className="flit-focus inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl border bg-white transition-colors hover:bg-[color:var(--flit-bg-app)] disabled:opacity-50"
            style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}
          >
            <CloseIcon />
          </button>
        </header>

        <div className="@container flex-1 space-y-5 overflow-y-auto p-6">
          {!preflight ? (
            <p className="text-sm italic" style={{ color: 'var(--flit-text-muted)' }}>Calculando preflight…</p>
          ) : (
            <div className="grid grid-cols-1 gap-3 @md:grid-cols-3">
              <ResumenCard label="Score proyectado" value={`${preflight.scoreProyectado.toFixed(1)}%`} emphasis />
              <ResumenCard label="Evaluados" value={`${preflight.evaluados} / ${preflight.totalEstandares}`} />
              <ResumenCard label="Con evidencia" value={`${preflight.conEvidencia} / ${preflight.totalEstandares}`} />
            </div>
          )}

          {preflight && hasBlocks && (
            <section aria-labelledby="bloqueos-titulo" className="overflow-hidden rounded-[12px]" style={{ border: '1px solid rgba(228,61,48,0.20)', background: 'rgba(228,61,48,0.06)' }}>
              <div className="px-4 py-3" style={{ borderBottom: '1px solid rgba(228,61,48,0.20)' }}>
                <h3 id="bloqueos-titulo" className="text-sm font-semibold" style={{ color: 'var(--flit-danger)' }}>
                  Bloqueos ({preflight.bloqueos.length})
                </h3>
                <p className="mt-0.5 text-[11px]" style={{ color: 'var(--flit-danger)', opacity: 0.8 }}>
                  El diagnóstico no puede cerrarse hasta resolver estos puntos.
                </p>
              </div>
              <table className="w-full text-sm">
                <TableHeader />
                <tbody>
                  {preflight.bloqueos.map((b) => (
                    <RowAction
                      key={b.estandarId}
                      codigo={b.codigo}
                      motivo={BLOQUEO_LABEL[b.motivo]}
                      onGoTo={() => onGoToStandard(b.estandarId)}
                    />
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {preflight && hasWarnings && (
            <section aria-labelledby="warnings-titulo" className="overflow-hidden rounded-[12px]" style={{ border: '1px solid rgba(240,90,53,0.20)', background: 'rgba(240,90,53,0.06)' }}>
              <div className="px-4 py-3" style={{ borderBottom: '1px solid rgba(240,90,53,0.20)' }}>
                <h3 id="warnings-titulo" className="text-sm font-semibold" style={{ color: 'var(--flit-warning)' }}>
                  Advertencias ({preflight.advertencias.length})
                </h3>
                <p className="mt-0.5 text-[11px]" style={{ color: 'var(--flit-warning)', opacity: 0.8 }}>
                  Se puede cerrar, pero se recomienda resolver antes de auditoría externa.
                </p>
              </div>
              <table className="w-full text-sm">
                <TableHeader />
                <tbody>
                  {preflight.advertencias.map((a) => (
                    <RowAction
                      key={a.estandarId}
                      codigo={a.codigo}
                      motivo={ADVERTENCIA_LABEL[a.motivo]}
                      onGoTo={() => onGoToStandard(a.estandarId)}
                    />
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <section aria-labelledby="worm-titulo" className="rounded-[12px] p-4" style={{ border: '1px solid var(--flit-border-soft)', background: 'var(--flit-bg-app)' }}>
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex-shrink-0" style={{ color: 'var(--flit-blue)' }}>
                <LockIcon />
              </div>
              <div className="min-w-0 flex-1">
                <h3 id="worm-titulo" className="mb-1 text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
                  Cierre inmutable (WORM)
                </h3>
                <p className="text-xs leading-relaxed" style={{ color: 'var(--flit-text-secondary)' }}>
                  Al cerrar este diagnóstico, las evaluaciones quedan inmutables conforme a
                  controles WORM (Write Once Read Many). Cualquier corrección posterior
                  requiere abrir un nuevo diagnóstico para el siguiente periodo. El
                  expediente quedará disponible para auditores de MinTransporte,
                  SuperTransporte y ONAC.
                </p>
                <label className="group mt-3 flex cursor-pointer items-start gap-2">
                  <input
                    ref={checkboxRef}
                    type="checkbox"
                    checked={accepted}
                    onChange={(e) => setAccepted(e.target.checked)}
                    disabled={hasBlocks || submitting}
                    className="mt-0.5 h-4 w-4 rounded disabled:cursor-not-allowed disabled:opacity-50"
                    style={{ accentColor: 'var(--flit-blue)' }}
                  />
                  <span className="text-xs leading-relaxed transition-colors" style={{ color: 'var(--flit-text-secondary)' }}>
                    Confirmo que la evidencia adjunta es veraz y exporto bajo mi
                    responsabilidad como líder PESV.
                  </span>
                </label>
                {hasBlocks && (
                  <p className="mt-2 text-[11px]" style={{ color: 'var(--flit-danger)' }}>
                    Resuelve los bloqueos antes de marcar esta confirmación.
                  </p>
                )}
              </div>
            </div>
          </section>
        </div>

        <footer className="flex items-center justify-end gap-2 p-4" style={{ borderTop: '1px solid var(--flit-border-soft)' }}>
          <button
            ref={cancelRef}
            type="button"
            onClick={() => !submitting && onClose()}
            disabled={submitting}
            className="flit-focus inline-flex h-10 items-center rounded-[999px] border bg-white px-4 text-sm font-medium disabled:opacity-50"
            style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!canConfirm}
            className="flit-focus inline-flex h-10 items-center gap-2 rounded-[999px] px-4 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            style={{ background: 'var(--flit-gradient-danger)', boxShadow: 'var(--flit-shadow-button)' }}
          >
            {submitting && <SpinnerIcon />}
            {submitting ? 'Cerrando…' : 'Cerrar definitivamente'}
          </button>
        </footer>
      </div>
    </div>
  );
}
