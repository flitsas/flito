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
import ModalPortal from '../flit/ModalPortal';
import { claseBoton } from '../flit/GradientButton';
import { Icono } from '../flit/kit/Icono';

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

function ResumenCard({ label, value, emphasis = false }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className="rounded-[9px] border border-[color:var(--color-border)] bg-[color:var(--kit-hover)] p-4">
      <div className="text-xs font-semibold uppercase tracking-wider text-[color:var(--color-text-tertiary)]">{label}</div>
      <div className={`mt-2 font-bold tabular-nums tracking-tight ${emphasis ? 'text-3xl text-[color:var(--color-action)]' : 'text-2xl text-[color:var(--color-text-primary)]'}`}>
        {value}
      </div>
    </div>
  );
}

function RowAction({ codigo, motivo, onGoTo }: { codigo: string; motivo: string; onGoTo: () => void }) {
  return (
    <tr>
      <td data-etiqueta="Código" className="font-mono text-xs">{codigo}</td>
      <td data-etiqueta="Motivo" className="text-xs text-[color:var(--color-text-secondary)]">{motivo}</td>
      <td data-etiqueta="Acción" className="text-right">
        <button
          type="button"
          onClick={onGoTo}
          className={claseBoton('secondary', 'sm', 'inline-flex items-center gap-1')}
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
        <th className="text-left">Código</th>
        <th className="text-left">Motivo</th>
        <th className="text-right">Acción</th>
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
    <ModalPortal>
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="cierre-modal-title"
      className="flit-modal kit-velo items-center justify-center p-3 sm:p-6"
      onKeyDown={handleKeyDown}
    >
      <div
        className="absolute inset-0"
        onClick={() => !submitting && onClose()}
        aria-hidden="true"
      />

      <div
        ref={modalRef}
        className="kit-modal my-auto max-h-[min(90vh,calc(100dvh-2rem))] max-w-[720px] overflow-hidden"
      >
        <header className="kit-modal__cabeza">
          <Icono nombre="candado" disco size={52} />
          <div className="min-w-0">
            <h2 id="cierre-modal-title" className="kit-modal__titulo">
              Cerrar diagnóstico {anio ?? ''}
            </h2>
            <p className="mt-1 text-sm text-[color:var(--color-text-secondary)]">
              Antes de cerrar definitivamente, revise el siguiente expediente.
            </p>
          </div>
          <button
            type="button"
            onClick={() => !submitting && onClose()}
            disabled={submitting}
            aria-label="Cerrar modal"
            className="kit-modal__cerrar"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </header>

        <div className="kit-modal__cuerpo @container min-h-0 flex-1 space-y-5 overflow-y-auto">
          {!preflight ? (
            <p className="text-sm italic text-[color:var(--color-text-tertiary)]">Calculando preflight…</p>
          ) : (
            <div className="grid grid-cols-1 gap-3 @md:grid-cols-3">
              <ResumenCard label="Score proyectado" value={`${preflight.scoreProyectado.toFixed(1)}%`} emphasis />
              <ResumenCard label="Evaluados" value={`${preflight.evaluados} / ${preflight.totalEstandares}`} />
              <ResumenCard label="Con evidencia" value={`${preflight.conEvidencia} / ${preflight.totalEstandares}`} />
            </div>
          )}

          {preflight && hasBlocks && (
            <section aria-labelledby="bloqueos-titulo" className="overflow-hidden rounded-[9px] border border-[color:var(--kit-rojo)] bg-[color:var(--color-surface-elevated)]">
              <div className="border-b border-[color:var(--kit-rojo)] px-4 py-3">
                <h3 id="bloqueos-titulo" className="text-sm font-semibold text-[color:var(--kit-rojo-texto)]">
                  Bloqueos ({preflight.bloqueos.length})
                </h3>
                <p className="mt-0.5 text-xs text-[color:var(--kit-rojo-texto)]">
                  El diagnóstico no puede cerrarse hasta resolver estos puntos.
                </p>
              </div>
              <div className="tabla-wrap rounded-none border-0"><table className="w-full text-sm">
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
              </table></div>
            </section>
          )}

          {preflight && hasWarnings && (
            <section aria-labelledby="warnings-titulo" className="overflow-hidden rounded-[9px] border border-[color:var(--kit-naranja)] bg-[color:var(--color-surface-elevated)]">
              <div className="border-b border-[color:var(--kit-naranja)] px-4 py-3">
                <h3 id="warnings-titulo" className="text-sm font-semibold text-[color:var(--kit-naranja-texto)]">
                  Advertencias ({preflight.advertencias.length})
                </h3>
                <p className="mt-0.5 text-xs text-[color:var(--kit-naranja-texto)]">
                  Se puede cerrar, pero se recomienda resolver antes de auditoría externa.
                </p>
              </div>
              <div className="tabla-wrap rounded-none border-0"><table className="w-full text-sm">
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
              </table></div>
            </section>
          )}

          <section aria-labelledby="worm-titulo" className="rounded-[9px] border border-[color:var(--color-border)] bg-[color:var(--kit-hover)] p-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex-shrink-0 text-[color:var(--color-action)]">
                <Icono nombre="candado" className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 id="worm-titulo" className="mb-1 text-sm font-semibold text-[color:var(--color-text-primary)]">
                  Cierre inmutable (WORM)
                </h3>
                <p className="text-xs leading-relaxed text-[color:var(--color-text-secondary)]">
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
                    className="mt-0.5 h-4 w-4 rounded accent-[color:var(--kit-azul)] disabled:cursor-not-allowed disabled:opacity-50"
                  />
                  <span className="text-xs leading-relaxed text-[color:var(--color-text-secondary)] transition-colors group-hover:text-[color:var(--color-text-primary)]">
                    Confirmo que la evidencia adjunta es veraz y exporto bajo mi
                    responsabilidad como líder PESV.
                  </span>
                </label>
                {hasBlocks && (
                  <p className="mt-2 text-xs text-[color:var(--kit-rojo-texto)]">
                    Resuelve los bloqueos antes de marcar esta confirmación.
                  </p>
                )}
              </div>
            </div>
          </section>
        </div>

        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-[color:var(--color-border)] px-6 py-4">
          <button
            ref={cancelRef}
            type="button"
            onClick={() => !submitting && onClose()}
            disabled={submitting}
            data-variante="secundario"
            className={claseBoton('secondary')}
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!canConfirm}
            data-variante="alerta"
            className={claseBoton('alerta', 'md', 'inline-flex items-center gap-2')}
          >
            {submitting && <SpinnerIcon />}
            {submitting ? 'Cerrando…' : 'Cerrar definitivamente'}
          </button>
        </footer>
      </div>
    </div>
    </ModalPortal>
  );
}
