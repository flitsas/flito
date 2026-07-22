// FLITO Logística (Fase 2 · Inc 4) — escáner de códigos (barras/QR) para verificar la recogida.
// Capa OPCIONAL (§13.2): usa la API nativa BarcodeDetector si el navegador la soporta; si no, el
// mensajero marca a mano (el botón ni siquiera aparece). Modelado sobre el overlay de cámara existente.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export function escaneoDisponible(): boolean {
  return typeof window !== 'undefined' && 'BarcodeDetector' in window;
}

export default function Escaner({ onScan, onClose }: { onScan: (code: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let detenido = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Detector = (window as any).BarcodeDetector;
    const detector = new Detector();

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        const v = videoRef.current!;
        v.srcObject = stream;
        await v.play();
        const tick = async () => {
          if (detenido) return;
          try {
            const codes = await detector.detect(v);
            if (codes && codes.length) { onScan(codes[0].rawValue); return; }
          } catch { /* frame sin código */ }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch { setError('No se pudo abrir la cámara.'); }
    })();

    return () => { detenido = true; cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); };
  }, [onScan]);

  return createPortal(
    <div className="fixed inset-0 z-[70] flex flex-col bg-black">
      <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-cover" />
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-32 w-72 -translate-x-1/2 -translate-y-1/2 rounded-xl border-2 border-white/80" />
      {error && <div className="absolute inset-x-0 top-6 px-4 text-center text-white">{error}</div>}
      <button type="button" onClick={onClose} className="absolute right-4 top-4 rounded-lg bg-white/90 px-4 py-2 text-sm font-semibold" style={{ color: 'var(--flit-blue-dark)' }}>
        Cerrar
      </button>
      <p className="absolute inset-x-0 bottom-8 text-center text-sm text-white/90">Apunta al código de la licencia o placa</p>
    </div>,
    document.body,
  );
}
