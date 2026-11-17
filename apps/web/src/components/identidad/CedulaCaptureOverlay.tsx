import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import toast from 'react-hot-toast';
import { api } from '../../lib/api';

export interface CedulaOcrData {
  firstName?: string;
  secondName?: string;
  lastName?: string;
  secondLastName?: string;
  documentNumber?: string;
  documentType?: string;
}

interface OcrResponse {
  ok: boolean;
  data?: CedulaOcrData;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onCaptured: (data: CedulaOcrData) => void;
}

type CaptureStep = 'frente' | 'reverso';
type StatusTone = 'idle' | 'analyzing' | 'success' | 'danger';

interface StatusState {
  message: string;
  tone: StatusTone;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export default function CedulaCaptureOverlay({ open, onClose, onCaptured }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [step, setStep] = useState<CaptureStep>('frente');
  const [status, setStatus] = useState<StatusState>({ message: '', tone: 'idle' });
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

  const stopStream = useCallback(() => {
    const s = streamRef.current;
    if (s) {
      s.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  const close = useCallback(() => {
    stopStream();
    setStep('frente');
    setStatus({ message: '', tone: 'idle' });
    setBusy(false);
    setReady(false);
    onClose();
  }, [onClose, stopStream]);

  // Init camera on open
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
        setReady(true);
      } catch {
        toast.error('No se pudo acceder a la camara');
        onClose();
      }
    })();
    return () => {
      cancelled = true;
      stopStream();
    };
  }, [open, onClose, stopStream]);

  // Esc cierra (si no está procesando)
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) close();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, busy, close]);

  const captureFrame = (): string | null => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return null;
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(v, 0, 0);
    return canvas.toDataURL('image/jpeg', 0.85);
  };

  const handleCapture = async () => {
    const image = captureFrame();
    if (!image) {
      setStatus({ message: 'Camara aun no lista, intente de nuevo', tone: 'danger' });
      return;
    }
    setBusy(true);
    setStatus({ message: step === 'frente' ? 'Analizando frente...' : 'Analizando reverso...', tone: 'analyzing' });

    try {
      const r = await api.post<OcrResponse>('/runt/ocr-cedula', { image, lado: step === 'frente' ? 'frontal' : 'reverso' });
      if (r.ok && r.data) {
        if (step === 'frente') {
          const d = r.data;
          const count = [d.firstName, d.lastName, d.documentNumber].filter(Boolean).length;
          setStatus({ message: `Frente OK · ${count} campos extraidos`, tone: 'success' });
          onCaptured(d);
          await sleep(800);
          setStep('reverso');
          setStatus({ message: '', tone: 'idle' });
        } else {
          setStatus({ message: 'Reverso OK · leido', tone: 'success' });
          await sleep(1000);
          close();
          return;
        }
      } else {
        setStatus({
          message: step === 'frente' ? 'No se pudo leer el frente' : 'No se pudo leer el reverso',
          tone: 'danger',
        });
      }
    } catch {
      setStatus({
        message: step === 'frente' ? 'Error leyendo frente' : 'Error leyendo reverso',
        tone: 'danger',
      });
    } finally {
      setBusy(false);
    }
  };

  const handleSkip = () => {
    if (step === 'frente') {
      setStep('reverso');
      setStatus({ message: '', tone: 'idle' });
    } else {
      close();
    }
  };

  if (!open) return null;

  const statusColorClass: Record<StatusTone, string> = {
    idle: 'text-[color:var(--color-capture-on-dark)]',
    analyzing: 'text-[color:var(--kit-naranja-texto)]',
    success: 'text-[color:var(--kit-verde-texto)]',
    danger: 'text-[color:var(--kit-rojo-texto)]',
  };

  const titleByStep: Record<CaptureStep, string> = {
    frente: 'PASO 1 — FRENTE',
    reverso: 'PASO 2 — REVERSO',
  };
  const hintByStep: Record<CaptureStep, string> = {
    frente: 'Ubique el FRENTE del documento de identidad en el recuadro',
    reverso: 'Ahora voltee el documento y ubique el REVERSO en el recuadro',
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="cedula-capture-title"
      aria-describedby="cedula-capture-hint"
      className="fixed inset-0 z-[99999] flex flex-col items-center justify-center gap-4 p-4 bg-[color:var(--color-capture-overlay-bg)]"
    >
      <span
        id="cedula-capture-title"
        className="px-4 py-1.5 rounded-pill bg-[color:var(--kit-azul-relleno)] text-[color:var(--kit-sobre-relleno)] text-xs font-bold uppercase tracking-[0.18em]"
      >
        {titleByStep[step]}
      </span>

      <p
        id="cedula-capture-hint"
        className="text-sm font-semibold text-center max-w-[400px] text-[color:var(--color-capture-on-dark)]"
      >
        {hintByStep[step]}
      </p>

      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="max-w-[88vw] max-h-[50vh] rounded-[9px] border-[3px] border-[color:var(--kit-azul)]"
      />

      <div className={`text-xs font-bold min-h-[18px] ${statusColorClass[status.tone]}`} aria-live="polite">
        {status.message}
      </div>

      <div className="flex gap-3">
        <button
          type="button"
          onClick={handleCapture}
          disabled={busy || !ready}
          className="px-9 py-3.5 rounded-[9px] flit-focus bg-[color:var(--kit-azul-relleno)] text-[color:var(--kit-sobre-relleno)] text-base font-extrabold hover:opacity-90 transition-[colors,opacity] disabled:opacity-50 disabled:cursor-wait"
        >
          {busy ? 'Procesando...' : 'Capturar'}
        </button>
        <button
          type="button"
          onClick={handleSkip}
          disabled={busy}
          className="flit-focus px-7 py-3.5 rounded-[9px] border-2 border-[color:var(--color-capture-border-on-dark)] bg-transparent text-[color:var(--color-capture-on-dark-soft)] text-sm font-semibold hover:text-[color:var(--color-capture-on-dark)] hover:border-[color:var(--color-capture-on-dark)] transition-colors disabled:opacity-30"
        >
          {step === 'reverso' ? 'Cerrar' : 'Omitir'}
        </button>
      </div>
    </div>,
    document.body,
  );
}
