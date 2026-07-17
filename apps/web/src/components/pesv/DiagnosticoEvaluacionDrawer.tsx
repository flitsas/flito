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
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="evaluacion-drawer-title"
      // z-50: por encima del shell FLIT (sidebar/topbar). Antes z-40 empataba
      // con la barra superior y el shell interceptaba el pointer (PESV-09).
      className="fixed inset-0 z-50 flex justify-end"
      onKeyDown={handleKeyDown}
    >
      <div
        className="absolute inset-0"
        style={{ background: 'rgba(22, 39, 68, 0.45)', backdropFilter: 'blur(6px)' }}
        onClick={tryClose}
        aria-hidden="true"
      />

      <div
        ref={drawerRef}
        className="relative flex h-full w-full max-w-[480px] flex-col animate-in slide-in-from-right-4 duration-300 ease-out motion-reduce:animate-none"
        style={{ background: 'var(--flit-bg-modal)', borderLeft: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-modal)' }}
      >
        {/* Header sticky */}
        <header className="sticky top-0 z-10 flex items-start justify-between gap-3 p-5" style={{ borderBottom: '1px solid var(--flit-border-soft)', background: 'var(--flit-bg-modal)' }}>
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-2">
              <span className="inline-flex items-center rounded-[999px] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider" style={{ background: 'rgba(79,116,201,0.14)', color: 'var(--flit-blue)' }}>
                Paso {item.paso} · {FASE_LABEL[item.fase]}
              </span>
              <span className="font-mono text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>{item.codigo}</span>
            </div>
            <h2
              id="evaluacion-drawer-title"
              className="text-lg font-bold leading-snug tracking-tight"
              style={{ color: 'var(--flit-text-primary)' }}
            >
              {item.nombre}
            </h2>
          </div>
          <button
            type="button"
            onClick={tryClose}
            aria-label="Cerrar evaluación"
            className="flit-focus inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl border bg-white transition-colors hover:bg-[color:var(--flit-bg-app)]"
            style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}
          >
            <CloseIcon />
          </button>
        </header>

        {/* Scroll body */}
        <div className="flex-1 space-y-6 overflow-y-auto p-5">
          {/* Qué dice la norma */}
          <section aria-labelledby="seccion-norma">
            <h3 id="seccion-norma" className="mb-2 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--flit-text-muted)' }}>
              Qué dice la norma
            </h3>
            <div className="rounded-[12px] p-3 text-sm leading-relaxed" style={{ border: '1px solid var(--flit-border-soft)', background: 'var(--flit-bg-app)', color: 'var(--flit-text-secondary)' }}>
              {item.descripcion || <span className="italic" style={{ color: 'var(--flit-text-muted)' }}>Sin descripción registrada en catálogo.</span>}
            </div>
            <a
              href="/pesv/normativa"
              className="flit-focus mt-2 inline-flex items-center gap-1 rounded text-[11px] font-medium"
              style={{ color: 'var(--flit-blue)' }}
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
            <p className="mt-2 text-[11px] leading-relaxed" style={{ color: 'var(--flit-text-muted)' }}>
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
            <h3 id="seccion-evidencias" className="mb-2 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--flit-text-muted)' }}>
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
            <label htmlFor="comentarios" className="mb-2 block text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--flit-text-muted)' }}>
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
              className="flit-focus w-full rounded-[10px] border bg-white px-4 py-2.5 text-sm outline-none transition-shadow disabled:cursor-not-allowed disabled:opacity-60"
              style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}
            />
            <div className="mt-1 flex items-center justify-between">
              {enDesarrolloSinComentario ? (
                <span className="text-[11px]" style={{ color: 'var(--flit-warning)' }}>
                  Nivel En desarrollo requiere comentario justificativo (mínimo 10 caracteres).
                </span>
              ) : <span />}
              <span className="text-[11px] tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>
                {comentarios.length} / 2000
              </span>
            </div>
          </section>

          {/* Historial */}
          <section aria-labelledby="seccion-historial">
            <h3 id="seccion-historial" className="mb-2 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--flit-text-muted)' }}>
              Historial de cambios
            </h3>
            {loadingHistorial ? (
              <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Cargando…</p>
            ) : historial.length === 0 ? (
              <p className="text-xs italic" style={{ color: 'var(--flit-text-muted)' }}>Sin movimientos registrados.</p>
            ) : (
              <ol className="max-h-40 space-y-1.5 overflow-y-auto">
                {historial.map((h, i) => (
                  <li key={i} className="flex items-start gap-2 text-[11px] leading-relaxed">
                    <span className="w-20 flex-shrink-0 tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>
                      {formatRelativeTime(h.createdAt)}
                    </span>
                    <span className="flex-1" style={{ color: 'var(--flit-text-secondary)' }}>
                      <span className="font-medium" style={{ color: 'var(--flit-text-primary)' }}>{HISTORIAL_ACTION_LABEL[h.action] || h.action}</span>
                      {h.detail && <span> · {h.detail}</span>}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        <footer className="sticky bottom-0 z-10 flex items-center justify-between gap-3 p-4" style={{ borderTop: '1px solid var(--flit-border-soft)', background: 'var(--flit-bg-modal)' }}>
          <div className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }} role="status" aria-live="polite">
            {savedAt ? `Guardado ${formatRelativeTime(savedAt)}` : ''}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={tryClose} className="flit-focus inline-flex h-9 items-center rounded-[999px] border bg-white px-3.5 text-sm font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}>
              Cancelar
            </button>
            <button type="button" onClick={handleSave} disabled={disabled || saving || !dirty} className="flit-focus inline-flex h-9 items-center gap-2 rounded-[999px] px-4 text-sm font-semibold text-white transition-transform motion-safe:active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50" style={{ background: 'var(--flit-gradient-primary)', boxShadow: 'var(--flit-shadow-button)' }}>
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
  );
}

function ConflictDialog({ onClose, onReload }: { onClose: () => void; onReload: () => void }) {
  return (
    <div role="alertdialog" aria-modal="true" aria-labelledby="conflict-title" className="absolute inset-0 z-50 flex items-center justify-center p-6">
      <div className="absolute inset-0" style={{ background: 'rgba(22, 39, 68, 0.45)', backdropFilter: 'blur(6px)' }} />
      <div className="relative w-full max-w-md p-6" style={{ background: 'var(--flit-bg-modal)', borderRadius: 'var(--flit-radius-xl)', boxShadow: 'var(--flit-shadow-modal)', border: '1px solid var(--flit-border-soft)' }}>
        <h3 id="conflict-title" className="mb-2 text-base font-bold" style={{ color: 'var(--flit-blue-text)' }}>
          Cambios detectados desde otra sesión
        </h3>
        <p className="mb-5 text-sm leading-relaxed" style={{ color: 'var(--flit-text-secondary)' }}>
          Otro usuario modificó este estándar mientras lo editabas. Recarga para ver los cambios actuales y vuelve a aplicar tu edición.
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="flit-focus inline-flex h-9 items-center rounded-[999px] border bg-white px-3.5 text-sm font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}>
            Cerrar
          </button>
          <button type="button" onClick={onReload} className="flit-focus inline-flex h-9 items-center rounded-[999px] px-4 text-sm font-semibold text-white" style={{ background: 'var(--flit-gradient-primary)', boxShadow: 'var(--flit-shadow-button)' }}>
            Recargar
          </button>
        </div>
      </div>
    </div>
  );
}
