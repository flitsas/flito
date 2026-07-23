// FLITO Logística (Fase 2 · Inc 4) — escáner CONTINUO de la LT: en un mismo apuntado lee el PDF417 y,
// con el boundingBox del código, recorta la banda inferior para OCR del N.º de LT (impreso debajo, no
// viaja en el barcode). El mensajero recoge VARIAS LT seguidas: tras cada lectura emite el resultado y
// sigue escaneando (deduplica por contenido para no repetir la misma LT), hasta que pulsa «Listo».
//
// Requiere BarcodeDetector + contexto seguro (HTTPS/localhost). Robusto ante el doble-montaje (StrictMode).

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { parseLicenciaTransito } from '@operaciones/shared-types';
import { ocrNumeroLt, precargarOcr } from '../../lib/ocrLt';

export function escaneoDisponible(): boolean {
  return typeof window !== 'undefined' && 'BarcodeDetector' in window;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** Recorta la banda justo debajo del código (donde va el N.º de LT), reescalada y en gris para el OCR. */
function recortarDebajo(video: HTMLVideoElement, bb?: DOMRectReadOnly): HTMLCanvasElement {
  const W = video.videoWidth; const H = video.videoHeight;
  const frame = document.createElement('canvas');
  frame.width = W; frame.height = H;
  frame.getContext('2d')!.drawImage(video, 0, 0, W, H);

  let x: number; let y: number; let w: number; let h: number;
  if (bb && bb.width > 0) {
    w = Math.min(bb.width * 1.06, W);
    x = Math.max(0, bb.x - bb.width * 0.03);
    y = Math.min(H - 1, bb.y + bb.height);
    h = Math.min(bb.height * 0.5, H - y);
  } else {
    w = W * 0.8; x = W * 0.1; y = H * 0.62; h = H * 0.16;
  }
  if (h < 8) h = Math.min(48, H - y);

  const escala = Math.max(1, Math.min(4, 220 / h)); // sube resolución del número para un OCR nítido
  const out = document.createElement('canvas');
  out.width = Math.round(w * escala);
  out.height = Math.round(h * escala);
  const ctx = out.getContext('2d')!;
  ctx.drawImage(frame, x, y, w, h, 0, 0, out.width, out.height);
  // Solo escala de grises: el umbral DURO mataba el texto claro de las fotos (número tenue sobre fondo
  // con textura). Tesseract binariza mejor a partir de la imagen en grises.
  const img = ctx.getImageData(0, 0, out.width, out.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

export default function Escaner({ onScan, onClose }: { onScan: (code: string, numeroLt?: string | null) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;
  const yaVistos = useRef<Set<string>>(new Set()); // deduplica el mismo código mientras sigue en cuadro
  const [error, setError] = useState<string | null>(null);
  const [listo, setListo] = useState(false);
  const [leyendo, setLeyendo] = useState(false);
  const [conteo, setConteo] = useState(0);
  const [ultima, setUltima] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: number | null = null;
    let cancelado = false;

    precargarOcr();

    (async () => {
      try {
        const BD = (window as Any).BarcodeDetector as Any;
        let formats: string[] | undefined;
        try { formats = await BD.getSupportedFormats?.(); } catch { /* default */ }
        const detector: Any = formats?.length ? new BD({ formats }) : new BD();

        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        });
        if (cancelado) { stream.getTracks().forEach((t) => t.stop()); return; }

        try {
          const track = stream.getVideoTracks()[0] as Any;
          const caps = track.getCapabilities?.();
          if (caps?.focusMode?.includes?.('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
        } catch { /* sin control de enfoque */ }

        const v = videoRef.current!;
        v.srcObject = stream;
        try { await v.play(); } catch { /* AbortError por re-render */ }
        if (cancelado) return;
        setListo(true);

        const tick = async () => {
          if (cancelado) return;
          if (v.readyState >= 2 && v.videoWidth > 0) {
            try {
              const codes = await detector.detect(v);
              const code = codes && codes[0];
              if (code && !yaVistos.current.has(code.rawValue)) {
                yaVistos.current.add(code.rawValue);
                setLeyendo(true);
                const recorte = recortarDebajo(v, code.boundingBox);
                let numeroLt: string | null = null;
                try {
                  numeroLt = await Promise.race([
                    ocrNumeroLt(recorte),
                    new Promise<null>((r) => window.setTimeout(() => r(null), 9000)),
                  ]);
                } catch { /* OCR falló → queda manual */ }
                setLeyendo(false);
                if (cancelado) return;
                onScanRef.current(code.rawValue, numeroLt);
                setConteo((n) => n + 1);
                setUltima(parseLicenciaTransito(code.rawValue)?.placa ?? '—');
                timer = window.setTimeout(tick, 900); // pausa para retirar la LT y poner la siguiente
                return;
              }
            } catch { /* frame sin código legible */ }
          }
          timer = window.setTimeout(tick, 200);
        };
        tick();
      } catch {
        if (!cancelado) setError('No se pudo abrir la cámara. Revisa el permiso de cámara y que la conexión sea segura (HTTPS).');
      }
    })();

    return () => {
      cancelado = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return createPortal(
    <div className="fixed inset-0 z-[70] flex flex-col bg-black">
      <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-cover" />
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-40 w-[90vw] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border-2 border-white/80" />
      {error && <div className="absolute inset-x-0 top-6 px-4 text-center text-sm text-white">{error}</div>}
      {!error && !listo && <div className="absolute inset-x-0 top-6 px-4 text-center text-sm text-white/90">Abriendo cámara…</div>}
      {leyendo && (
        <div className="absolute inset-x-0 top-6 flex justify-center">
          <div className="rounded-full bg-white/90 px-4 py-1.5 text-sm font-semibold" style={{ color: 'var(--flit-blue-dark)' }}>Leyendo N.º de LT…</div>
        </div>
      )}
      {conteo > 0 && !leyendo && (
        <div className="absolute inset-x-0 top-6 flex justify-center">
          <div className="rounded-full bg-white/90 px-4 py-1.5 text-sm font-semibold" style={{ color: 'var(--flit-success)' }}>✓ {conteo} escaneada(s){ultima ? ` · última ${ultima}` : ''}</div>
        </div>
      )}
      <button type="button" onClick={onClose} className="absolute right-4 top-4 rounded-lg bg-white px-4 py-2 text-sm font-semibold" style={{ color: 'var(--flit-blue-dark)' }}>
        Listo{conteo > 0 ? ` (${conteo})` : ''}
      </button>
      <p className="absolute inset-x-0 bottom-8 text-center text-sm text-white/90">Escanea cada LT: apunta al PDF417 con el N.º de LT visible debajo</p>
    </div>,
    document.body,
  );
}
