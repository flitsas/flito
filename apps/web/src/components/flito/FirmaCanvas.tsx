// FLITO Logística (Fase 2 · Inc 4) — captura de firma en canvas para la entrega (RN-03/CA-05).
// El receptor firma con el dedo/lápiz en el teléfono; se exporta como PNG (dataURL) y se envía con la
// entrega. Sin dependencias: Pointer Events + canvas nativo.

import { useEffect, useRef, useState } from 'react';

export default function FirmaCanvas({ onChange }: { onChange: (dataUrl: string | null) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dibujando = useRef(false);
  const tieneTrazo = useRef(false); // ref, no estado: `end` lo lee sin cierre obsoleto
  const [vacia, setVacia] = useState(true);

  useEffect(() => {
    const canvas = ref.current!;
    // Ajusta el bitmap al tamaño real en píxeles (nítido en pantallas HiDPI).
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#162744';
  }, []);

  const pos = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const start = (e: React.PointerEvent) => {
    e.preventDefault();
    dibujando.current = true;
    const ctx = ref.current!.getContext('2d')!;
    const { x, y } = pos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  };
  const move = (e: React.PointerEvent) => {
    if (!dibujando.current) return;
    const ctx = ref.current!.getContext('2d')!;
    const { x, y } = pos(e);
    ctx.lineTo(x, y);
    ctx.stroke();
    if (!tieneTrazo.current) { tieneTrazo.current = true; setVacia(false); }
  };
  const end = () => {
    if (!dibujando.current) return;
    dibujando.current = false;
    onChange(tieneTrazo.current ? ref.current!.toDataURL('image/png') : null);
  };
  const limpiar = () => {
    const canvas = ref.current!;
    canvas.getContext('2d')!.clearRect(0, 0, canvas.width, canvas.height);
    tieneTrazo.current = false;
    setVacia(true);
    onChange(null);
  };

  return (
    <div>
      <canvas
        ref={ref}
        aria-label="Firma del receptor"
        className="h-36 w-full touch-none rounded-lg border bg-white"
        style={{ borderColor: 'var(--flit-border-input)' }}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerLeave={end}
      />
      <div className="mt-1 flex items-center justify-between">
        <span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>{vacia ? 'Firme aquí' : 'Firmado'}</span>
        <button type="button" className="text-xs font-semibold" style={{ color: 'var(--flit-blue-text)' }} onClick={limpiar}>Limpiar</button>
      </div>
    </div>
  );
}
