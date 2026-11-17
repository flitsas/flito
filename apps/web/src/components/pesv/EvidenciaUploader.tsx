// Dropzone + lista evidencias para módulo PESV.
//
// Reusa el contrato Evidencia de apps/api/src/modules/pesv/diagnostico.schemas.ts.
// Defensa cliente (mime + tamaño) duplicada del guard backend en
// diagnostico-evidencias.routes.ts — el backend valida con magic-number;
// aquí solo evitamos round-trip innecesario para errores obvios.
//
// Acepta drag-and-drop, click, y paste (Ctrl+V) de imágenes (caso típico
// captura de pantalla del acta/política). La paste captura cualquier
// `File` del clipboard, no inserta texto.

import { useCallback, useRef, useState } from 'react';
import type { DragEvent, ClipboardEvent, KeyboardEvent } from 'react';
import { Girador } from '../flit/Cargador';
import { claseBoton } from '../flit/GradientButton';
import { Icono } from '../flit/kit/Icono';

// Replica local del contrato Evidencia (esquema zod backend).
export interface Evidencia {
  keyHash: string;
  filename: string;
  sizeBytes: number;
  mime: string;
  uploadedAt: string;
  uploadedBy: number;
}

interface Props {
  evidencias: Evidencia[];
  onUpload: (file: File) => Promise<void>;
  onDelete: (keyHash: string) => Promise<void>;
  onView: (keyHash: string) => void;
  disabled?: boolean;
  /** Si true y evidencias.length===0, muestra warning amarillo (nivel ≥ implementado). */
  showWarningIfEmpty?: boolean;
}

const MAX_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB
const ALLOWED_MIMES = new Set<string>([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
const ACCEPT_ATTR = '.pdf,.jpg,.jpeg,.png,.xlsx,.docx,application/pdf,image/jpeg,image/png,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function formatRelativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  const s = Math.round(diff / 1000);
  if (s < 60) return 'hace unos segundos';
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h}h`;
  const d = Math.round(h / 24);
  if (d < 30) return `hace ${d}d`;
  return new Date(iso).toLocaleDateString('es-CO');
}

function FileIcon({ mime }: { mime: string }) {
  const nombre = mime === 'application/pdf' ? 'documento' : mime.startsWith('image/') ? 'impronta' : mime.includes('spreadsheet') ? 'reportes' : 'archivo';
  return <Icono nombre={nombre} className="h-5 w-5 flex-shrink-0 text-[color:var(--color-text-tertiary)]" />;
}

function AlertIcon() {
  return <Icono nombre="alerta" className="h-4 w-4 flex-shrink-0" />;
}

export default function EvidenciaUploader({
  evidencias,
  onUpload,
  onDelete,
  onView,
  disabled = false,
  showWarningIfEmpty = false,
}: Props) {
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingHash, setDeletingHash] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const validateAndUpload = useCallback(async (file: File) => {
    setError(null);
    if (file.size > MAX_SIZE_BYTES) {
      setError(`Archivo supera 20 MB (actual: ${formatBytes(file.size)}). Comprime o divide.`);
      return;
    }
    if (!ALLOWED_MIMES.has(file.type)) {
      setError(`Tipo no permitido (${file.type || 'desconocido'}). Acepta PDF, JPG, PNG, XLSX, DOCX.`);
      return;
    }
    setUploading(true);
    try {
      await onUpload(file);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al subir');
    } finally {
      setUploading(false);
    }
  }, [onUpload]);

  const handleFiles = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return;
    // Sprint 1: un archivo a la vez. Múltiples → primer item (mantiene UX simple).
    validateAndUpload(files[0]);
  }, [validateAndUpload]);

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    if (disabled || uploading) return;
    handleFiles(e.dataTransfer.files);
  };

  const handlePaste = (e: ClipboardEvent<HTMLDivElement>) => {
    if (disabled || uploading) return;
    const files: File[] = [];
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      validateAndUpload(files[0]);
    }
  };

  const handleKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || uploading) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      inputRef.current?.click();
    }
  };

  const handleDelete = async (keyHash: string) => {
    if (disabled) return;
    setDeletingHash(keyHash);
    try {
      await onDelete(keyHash);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al eliminar');
    } finally {
      setDeletingHash(null);
    }
  };

  const isEmpty = evidencias.length === 0;

  return (
    <div className="space-y-3">
      {/* Helper warning si nivel ≥ implementado y no hay evidencia */}
      {showWarningIfEmpty && isEmpty && (
        <div
          role="status"
          data-kit="alerta"
          data-tono="warn"
          className="flex items-start gap-2 rounded-[9px] border border-[color:var(--kit-naranja)] bg-[color:var(--color-surface-elevated)] p-3 text-[color:var(--kit-naranja-texto)]"
        >
          <AlertIcon />
          <span className="text-xs leading-relaxed">
            Este nivel requiere al menos una evidencia para ser válido ante auditor.
          </span>
        </div>
      )}

      {/* Dropzone */}
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label="Arrastra archivos o presiona Enter para seleccionar"
        aria-disabled={disabled || uploading}
        onClick={() => !disabled && !uploading && inputRef.current?.click()}
        onKeyDown={handleKey}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled && !uploading) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onPaste={handlePaste}
        className={[
          'carga kit-carga transition-colors duration-150 motion-reduce:transition-none',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kit-azul)]',
          isEmpty ? '' : 'carga--lista',
          disabled || uploading
            ? 'cursor-not-allowed opacity-60'
            : dragOver
              ? 'cursor-copy bg-[color:var(--kit-hover)]'
              : 'cursor-pointer',
        ].join(' ')}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT_ATTR}
          disabled={disabled || uploading}
          className="sr-only"
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = ''; // permite re-subir mismo archivo
          }}
        />
        <div className="flex flex-col items-center gap-2 text-[color:var(--color-action)]">
          {uploading ? <Girador /> : <Icono nombre="archivo-subir" size={44} />}
          <div className="text-sm font-medium text-[color:var(--color-text-primary)]">
            {uploading ? 'Subiendo…' : 'Arrastra un archivo o haz click'}
          </div>
          <div className="text-xs text-[color:var(--color-text-tertiary)]">
            PDF · JPG · PNG · XLSX · DOCX · hasta 20 MB
          </div>
          {!uploading && !disabled && (
            <div className="text-xs text-[color:var(--color-text-tertiary)]">
              También puedes pegar (Ctrl+V) una captura
            </div>
          )}
        </div>
      </div>

      {/* PESV-06: microcopy de retención e inmutabilidad (Ley 594/2000). */}
      <p className="text-xs leading-relaxed text-[color:var(--color-text-tertiary)]">
        Las evidencias adjuntas quedan inmutables tras el cierre del diagnóstico y se conservan 5 años (Ley 594/2000).
      </p>

      {/* Toast inline de error */}
      {error && (
        <div
          role="alert"
          data-kit="alerta"
          data-tono="danger"
          className="flex items-start gap-2 rounded-[9px] border border-[color:var(--kit-rojo)] bg-[color:var(--color-surface-elevated)] p-3 text-[color:var(--kit-rojo-texto)]"
        >
          <AlertIcon />
          <span className="text-xs leading-relaxed">{error}</span>
        </div>
      )}

      {/* Lista evidencias */}
      {!isEmpty && (
        <ul className="lista-fila rounded-[9px] border border-[color:var(--color-border)] bg-[color:var(--color-surface-elevated)] px-3 py-3" data-kit="lista-fila" aria-label="Evidencias adjuntas">
          {evidencias.map((ev) => {
            const isDeleting = deletingHash === ev.keyHash;
            return (
              <li
                key={ev.keyHash}
                className="!flex-nowrap !gap-2"
              >
                <FileIcon mime={ev.mime} />
                <div className="lista-fila__texto flex-1 min-w-0">
                  <div className="truncate text-sm font-medium text-[color:var(--color-text-primary)]" title={ev.filename}>
                    {ev.filename}
                  </div>
                  <div className="text-xs tabular-nums text-[color:var(--color-text-tertiary)]">
                    {formatBytes(ev.sizeBytes)} · {formatRelativeTime(ev.uploadedAt)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onView(ev.keyHash)}
                  aria-label={`Ver evidencia ${ev.filename}`}
                  data-variante="secundario"
                  className={claseBoton('secondary', 'sm', 'inline-flex flex-shrink-0 items-center gap-1')}
                >
                  <Icono nombre="ojo" className="h-3.5 w-3.5" />
                  Ver
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(ev.keyHash)}
                  disabled={disabled || isDeleting}
                  aria-label={`Eliminar evidencia ${ev.filename}`}
                  data-variante="alerta"
                  className={claseBoton('alerta', 'sm', 'inline-flex flex-shrink-0 items-center gap-1')}
                >
                  {isDeleting ? <Girador /> : <Icono nombre="papelera" className="h-3.5 w-3.5" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
