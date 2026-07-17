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
  const baseProps = {
    className: 'w-4 h-4 flit-tone-muted',
    viewBox: '0 0 24 24',
    fill: 'none' as const,
    stroke: 'currentColor',
    strokeWidth: 2,
    'aria-hidden': true,
  };
  if (mime === 'application/pdf') {
    return (
      <svg {...baseProps}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M14 2v6h6M9 13h6M9 17h4" />
      </svg>
    );
  }
  if (mime.startsWith('image/')) {
    return (
      <svg {...baseProps}>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 15l-5-5L5 21" />
      </svg>
    );
  }
  if (mime.includes('spreadsheet')) {
    return (
      <svg {...baseProps}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M14 2v6h6M8 13h8M8 17h8M8 9h2" />
      </svg>
    );
  }
  return (
    <svg {...baseProps}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M14 2v6h6M9 13h6M9 17h6M9 9h2" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
      <path strokeLinecap="round" d="M12 2a10 10 0 0110 10" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      <path strokeLinecap="round" d="M12 9v4M12 17h.01" />
    </svg>
  );
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
          className="flex items-start gap-2 p-3 rounded-xl flit-warning-bg text-[color:var(--flit-warning)] border border-warning/20"
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
          'rounded-xl border-2 border-dashed p-6 text-center transition-colors duration-150 motion-reduce:transition-none',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--color-surface)]',
          disabled || uploading
            ? 'cursor-not-allowed opacity-60 border-[color:var(--flit-border-soft)] bg-[color:var(--flit-bg-app)]'
            : dragOver
              ? 'border-[color:var(--flit-blue)] flit-tone-active-bg cursor-copy'
              : 'border-[color:var(--flit-border-soft)] bg-[color:var(--flit-bg-app)] hover:border-[color:var(--flit-blue)]/40 cursor-pointer',
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
        <div className="flex flex-col items-center gap-2 flit-tone-secondary">
          {uploading ? <SpinnerIcon /> : <UploadIcon />}
          <div className="text-sm font-medium flit-tone-primary">
            {uploading ? 'Subiendo…' : 'Arrastra un archivo o haz click'}
          </div>
          <div className="text-[11px] flit-tone-muted">
            PDF · JPG · PNG · XLSX · DOCX · hasta 20 MB
          </div>
          {!uploading && !disabled && (
            <div className="text-[11px] flit-tone-muted">
              También puedes pegar (Ctrl+V) una captura
            </div>
          )}
        </div>
      </div>

      {/* PESV-06: microcopy de retención e inmutabilidad (Ley 594/2000). */}
      <p className="text-[10px] leading-relaxed flit-tone-muted">
        Las evidencias adjuntas quedan inmutables tras el cierre del diagnóstico y se conservan 5 años (Ley 594/2000).
      </p>

      {/* Toast inline de error */}
      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 p-3 rounded-xl flit-danger-bg text-[color:var(--flit-danger)] border border-danger/20"
        >
          <AlertIcon />
          <span className="text-xs leading-relaxed">{error}</span>
        </div>
      )}

      {/* Lista evidencias */}
      {!isEmpty && (
        <ul className="space-y-1.5" aria-label="Evidencias adjuntas">
          {evidencias.map((ev) => {
            const isDeleting = deletingHash === ev.keyHash;
            return (
              <li
                key={ev.keyHash}
                className="flex items-center gap-2 p-2.5 rounded-xl border border-[color:var(--flit-border-soft)] bg-white hover:bg-[color:var(--flit-bg-app)]/60 transition-colors"
              >
                <FileIcon mime={ev.mime} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm flit-tone-primary truncate" title={ev.filename}>
                    {ev.filename}
                  </div>
                  <div className="text-[11px] flit-tone-muted tabular-nums">
                    {formatBytes(ev.sizeBytes)} · {formatRelativeTime(ev.uploadedAt)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onView(ev.keyHash)}
                  aria-label={`Ver evidencia ${ev.filename}`}
                  className="inline-flex items-center gap-1 h-7 px-2.5 rounded-lg border border-[color:var(--flit-border-soft)] bg-white flit-tone-secondary hover:bg-[color:var(--flit-bg-app)] hover:flit-tone-primary transition-colors text-[11px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <EyeIcon />
                  Ver
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(ev.keyHash)}
                  disabled={disabled || isDeleting}
                  aria-label={`Eliminar evidencia ${ev.filename}`}
                  className="inline-flex items-center gap-1 h-7 px-2.5 rounded-lg border border-[color:var(--flit-border-soft)] bg-white flit-tone-muted hover:flit-danger-bg hover:text-[color:var(--flit-danger)] hover:border-danger/20 transition-colors text-[11px] font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger"
                >
                  {isDeleting ? <SpinnerIcon /> : <TrashIcon />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
