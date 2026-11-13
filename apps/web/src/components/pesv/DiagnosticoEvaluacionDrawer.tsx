// Drawer lateral para evaluar un estándar PESV individual.
//
// Sustituye al slider continuo de PesvDiagnostico.tsx con un workspace completo
// por estándar: norma + rúbrica + evidencias + comentario + historial.
//
// WCAG 2.2 AA: role=dialog aria-modal, focus trap cíclico, Esc cierra con
// prompt si hay cambios sin guardar, foco inicial en primer radio. Live region
// polite para anuncio "Guardado hace Xs". Optimistic UI con 409 conflict.
//
// Conserva 100% lógica del backend pesv/diagnostico.routes.ts:
//   PATCH /pesv/diagnostico/:id/items/:estandarId       (nivel + comentarios)
//   GET   /pesv/diagnostico/:id/items/:estandarId/historial
//   POST  /pesv/diagnostico/:id/items/:estandarId/evidencias  (multipart "archivo")
//   DELETE /pesv/diagnostico/:id/items/:estandarId/evidencias/:keyHash
//   GET   /pesv/diagnostico/:id/items/:estandarId/evidencias/:keyHash  → {url, expiresAt}

import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import toast from 'react-hot-toast';
import { api, ApiError, errorMessage } from '../../lib/api';
import RubricaRadioGroup, { type NivelRubrica } from './RubricaRadioGroup';
import EvidenciaUploader, { type Evidencia } from './EvidenciaUploader';
import { CloseIcon } from './shared';
import {
  formatRelativeTime,
  makeFocusTrapHandler,
  SpinnerIcon,
  ExternalLinkIcon,
  FASE_LABEL,
  HISTORIAL_ACTION_LABEL,
} from './diagnostico-helpers';
import ModalPortal from '../flit/ModalPortal';
import { claseBoton } from '../flit/GradientButton';
import { ActividadLinea } from '../flit/Bloques';
import { etiquetaKit } from '../flit/kit/tonos';

interface Item {
  estandarId: number;
  codigo: string;
  paso: number;
  fase: 'planear' | 'hacer' | 'verificar' | 'actuar';
  nombre: string;
  descripcion: string | null;
  scorePct: string;
  nivelRubrica: NivelRubrica;
  comentarios: string | null;
  evidencias: Evidencia[];
  updatedAt: string;
}

interface Historial {
  createdAt: string;
  userId: number;
  action: string;
  detail: string | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  diagnosticoId: number;
  item: Item | null;
  /** Diagnóstico cerrado → todo en modo lectura. */
  disabled: boolean;
  /** Callback tras guardar exitoso — parent recarga lista. */
  onSaved: () => void;
}

export default function DiagnosticoEvaluacionDrawer({
  open,
  onClose,
  diagnosticoId,
  item,
  disabled,
  onSaved,
}: Props) {
  const [nivel, setNivel] = useState<NivelRubrica>('no_implementado');
  const [comentarios, setComentarios] = useState('');
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [historial, setHistorial] = useState<Historial[]>([]);
  const [loadingHistorial, setLoadingHistorial] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const firstRadioRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Hidratar estado al recibir item nuevo
  useEffect(() => {
    if (item) {
      setNivel(item.nivelRubrica);
      setComentarios(item.comentarios ?? '');
      // PESV-09: inicializar desde updatedAt (verdad del servidor) en lugar de null,
      // para que el banner "Guardado hace Xs" sobreviva a un reload del detalle.
      setSavedAt(item.updatedAt ?? null);
      setConflict(false);
    }
  }, [item?.estandarId, item?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cargar historial al abrir
  useEffect(() => {
    if (!open || !item) return;
    let cancelled = false;
    setLoadingHistorial(true);
    api
      .get<{ data: Historial[] }>(`/pesv/diagnostico/${diagnosticoId}/items/${item.estandarId}/historial`)
      .then((r) => { if (!cancelled) setHistorial(r.data); })
      .catch(() => { if (!cancelled) setHistorial([]); })
      .finally(() => { if (!cancelled) setLoadingHistorial(false); });
    return () => { cancelled = true; };
  }, [open, item?.estandarId, diagnosticoId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus inicial + restauración foco previo
  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => firstRadioRef.current?.focus(), 50);
    return () => {
      clearTimeout(t);
      previousFocusRef.current?.focus?.();
    };
  }, [open]);

  const dirty =
    item !== null &&
    (nivel !== item.nivelRubrica || (comentarios || null) !== (item.comentarios ?? null));

  const trapHandler = makeFocusTrapHandler(drawerRef);

  const tryClose = useCallback(() => {
    if (dirty && !saving) {
      // eslint-disable-next-line no-alert
      if (!window.confirm('Tienes cambios sin guardar. ¿Cerrar sin guardar?')) return;
    }
    onClose();
  }, [dirty, saving, onClose]);

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      tryClose();
      return;
    }
    trapHandler(e);
  };

  const handleSave = async () => {
    if (!item || !dirty || disabled) return;
    setSaving(true);
    try {
      await api.patch(`/pesv/diagnostico/${diagnosticoId}/items/${item.estandarId}`, {
        nivelRubrica: nivel,
        comentarios: comentarios.trim() || null,
      });
      setSavedAt(new Date().toISOString());
      onSaved();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setConflict(true);
      } else {
        toast.error(errorMessage(e));
      }
    } finally {
      setSaving(false);
    }
  };

  const handleUpload = async (file: File) => {
    if (!item) throw new Error('Sin item activo');
    const form = new FormData();
    form.append('archivo', file);
    await api.post(`/pesv/diagnostico/${diagnosticoId}/items/${item.estandarId}/evidencias`, form);
    onSaved();
  };

  const handleDelete = async (keyHash: string) => {
    if (!item) throw new Error('Sin item activo');
    await api.delete(`/pesv/diagnostico/${diagnosticoId}/items/${item.estandarId}/evidencias/${keyHash}`);
    onSaved();
  };

  const handleView = async (keyHash: string) => {
    if (!item) return;
    try {
      const r = await api.get<{ url: string; expiresAt: string }>(
        `/pesv/diagnostico/${diagnosticoId}/items/${item.estandarId}/evidencias/${keyHash}`,
      );
      window.open(r.url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  if (!open || !item) return null;

  const nivelRequiereEvidencia = nivel === 'implementado' || nivel === 'sostenido';
  const enDesarrolloSinComentario = nivel === 'en_desarrollo' && comentarios.trim().length < 10;

  return (
    <ModalPortal>
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="evaluacion-drawer-title"
      // z-50: por encima del shell FLIT (sidebar/topbar). Antes z-40 empataba
      // con la barra superior y el shell interceptaba el pointer (PESV-09).
      className="flit-modal kit-velo items-stretch justify-end"
      onKeyDown={handleKeyDown}
    >
      <div
        className="absolute inset-0"
        onClick={tryClose}
        aria-hidden="true"
      />

      <div
        ref={drawerRef}
        className="kit-modal kit-modal--lateral max-w-[min(30rem,100vw)] overflow-hidden"
      >
        {/* Header sticky */}
        <header className="kit-modal__cabeza border-b border-[color:var(--color-border)]">
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-2">
              <span {...etiquetaKit('info')}>
                Paso {item.paso} · {FASE_LABEL[item.fase]}
              </span>
              <span className="font-mono text-xs text-[color:var(--color-text-tertiary)]">{item.codigo}</span>
            </div>
            <h2
              id="evaluacion-drawer-title"
              className="kit-modal__titulo text-lg leading-snug"
            >
              {item.nombre}
            </h2>
          </div>
          <button
            type="button"
            onClick={tryClose}
            aria-label="Cerrar evaluación"
            className="kit-modal__cerrar"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </header>

        {/* Scroll body */}
        <div className="kit-modal__cuerpo min-h-0 flex-1 space-y-6 overflow-y-auto">
          {/* Qué dice la norma */}
          <section aria-labelledby="seccion-norma">
            <h3 id="seccion-norma" className="mb-2 text-xs font-semibold uppercase tracking-wider text-[color:var(--color-text-tertiary)]">
              Qué dice la norma
            </h3>
            <div className="rounded-[9px] border border-[color:var(--color-border)] bg-[color:var(--kit-hover)] p-3 text-sm leading-relaxed text-[color:var(--color-text-secondary)]">
              {item.descripcion || <span className="italic text-[color:var(--color-text-tertiary)]">Sin descripción registrada en catálogo.</span>}
            </div>
            <a
              href="/pesv/normativa"
              className="mt-2 inline-flex items-center gap-1 rounded text-xs font-medium text-[color:var(--color-action)] transition-colors hover:underline"
            >
              Ver Res. 40595/2022 · {item.codigo}
              <ExternalLinkIcon />
            </a>
          </section>

          {/* Rúbrica */}
          <section aria-labelledby="seccion-rubrica">
            <RubricaRadioGroup
              value={nivel}
              onChange={setNivel}
              disabled={disabled || saving}
              legend="Nivel de cumplimiento"
            />
            <p className="mt-2 text-xs leading-relaxed text-[color:var(--color-text-tertiary)]">
              Selecciona el nivel basado en evidencia objetiva, no en intención de implementar.
            </p>
            {/* Anchor focus inicial al primer radio del fieldset adyacente */}
            <input
              ref={firstRadioRef}
              type="radio"
              name="_rubrica_focus_anchor"
              tabIndex={-1}
              className="sr-only"
              aria-hidden="true"
              readOnly
            />
          </section>

          {/* Evidencias */}
          <section aria-labelledby="seccion-evidencias">
            <h3 id="seccion-evidencias" className="mb-2 text-xs font-semibold uppercase tracking-wider text-[color:var(--color-text-tertiary)]">
              Evidencia documental
            </h3>
            <EvidenciaUploader
              evidencias={item.evidencias}
              onUpload={handleUpload}
              onDelete={handleDelete}
              onView={handleView}
              disabled={disabled || saving}
              showWarningIfEmpty={nivelRequiereEvidencia}
            />
          </section>

          {/* Comentarios */}
          <section aria-labelledby="seccion-comentarios">
            <label htmlFor="comentarios" className="mb-2 block text-xs font-semibold uppercase tracking-wider text-[color:var(--color-text-tertiary)]">
              Comentarios
            </label>
            <textarea
              id="comentarios"
              rows={4}
              maxLength={2000}
              disabled={disabled || saving}
              value={comentarios}
              onChange={(e) => setComentarios(e.target.value)}
              placeholder="Notas, vigencia, responsable, observación auditor…"
              className="control w-full disabled:cursor-not-allowed"
            />
            <div className="mt-1 flex items-center justify-between">
              {enDesarrolloSinComentario ? (
                <span className="text-xs text-[color:var(--kit-naranja-texto)]">
                  Nivel En desarrollo requiere comentario justificativo (mínimo 10 caracteres).
                </span>
              ) : <span />}
              <span className="text-xs tabular-nums text-[color:var(--color-text-tertiary)]">
                {comentarios.length} / 2000
              </span>
            </div>
          </section>

          {/* Historial */}
          <section aria-labelledby="seccion-historial">
            <h3 id="seccion-historial" className="mb-2 text-xs font-semibold uppercase tracking-wider text-[color:var(--color-text-tertiary)]">
              Historial de cambios
            </h3>
            {loadingHistorial ? (
              <p className="text-xs text-[color:var(--color-text-tertiary)]">Cargando…</p>
            ) : historial.length === 0 ? (
              <p className="text-xs italic text-[color:var(--color-text-tertiary)]">Sin movimientos registrados.</p>
            ) : (
              <div className="max-h-40 overflow-y-auto">
                <ActividadLinea
                  eventos={historial.map((h, i) => ({
                    id: String(i),
                    cuando: formatRelativeTime(h.createdAt),
                    fechaIso: h.createdAt,
                    texto: (
                      <span className="text-[color:var(--color-text-secondary)]">
                        <span className="font-medium text-[color:var(--color-text-primary)]">{HISTORIAL_ACTION_LABEL[h.action] || h.action}</span>
                        {h.detail && <span> · {h.detail}</span>}
                      </span>
                    ),
                  }))}
                />
              </div>
            )}
          </section>
        </div>

        <footer className="flex flex-none flex-wrap items-center justify-between gap-3 border-t border-[color:var(--color-border)] bg-[color:var(--color-surface-elevated)] px-6 py-4">
          <div className="text-xs text-[color:var(--color-text-tertiary)]" role="status" aria-live="polite">
            {savedAt ? `Guardado ${formatRelativeTime(savedAt)}` : ''}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={tryClose} data-variante="secundario" className={claseBoton('secondary', 'sm')}>
              Cancelar
            </button>
            <button type="button" onClick={handleSave} disabled={disabled || saving || !dirty} data-variante="primario" className={claseBoton('primary', 'sm', 'inline-flex items-center gap-2')}>
              {saving && <SpinnerIcon />}
              {saving ? 'Guardando…' : 'Guardar cambios'}
            </button>
          </div>
        </footer>
      </div>

      {conflict && (
        <ConflictDialog onClose={() => setConflict(false)} onReload={() => { setConflict(false); onSaved(); }} />
      )}
    </div>
    </ModalPortal>
  );
}

function ConflictDialog({ onClose, onReload }: { onClose: () => void; onReload: () => void }) {
  return (
    <div role="alertdialog" aria-modal="true" aria-labelledby="conflict-title" className="absolute inset-0 z-50 flex items-center justify-center p-6">
      <div className="kit-velo absolute" />
      <div className="kit-modal max-w-md p-6">
        <h3 id="conflict-title" className="kit-modal__titulo mb-2 text-base">
          Cambios detectados desde otra sesión
        </h3>
        <p className="mb-5 text-sm leading-relaxed text-[color:var(--color-text-secondary)]">
          Otro usuario modificó este estándar mientras lo editabas. Recarga para ver los cambios actuales y vuelve a aplicar tu edición.
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} data-variante="secundario" className={claseBoton('secondary', 'sm')}>
            Cerrar
          </button>
          <button type="button" onClick={onReload} data-variante="primario" className={claseBoton('primary', 'sm')}>
            Recargar
          </button>
        </div>
      </div>
    </div>
  );
}
