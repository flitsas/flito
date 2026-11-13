// FLITO Logística (Fase 2 · Inc 4) — captura de firma en canvas para la entrega (RN-03/CA-05).
// El receptor firma con el dedo/lápiz en el teléfono; se exporta como PNG (dataURL) y se envía con la
// entrega. Sin dependencias: Pointer Events + canvas nativo.

import { useEffect, useRef, useState } from 'react';
import GradientButton from '../flit/GradientButton';

export default function FirmaCanvas({ onChange, label = 'Firma del receptor' }: { onChange: (dataUrl: string | null) => void; label?: string }) {
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
    // Tinta fija del kit (igual en claro y oscuro): la firma exportada conserva el mismo color de
    // trazo en los dos temas, porque viaja a la entrega y se pinta sobre papel.
    const tinta = getComputedStyle(canvas).getPropertyValue('--kit-tinta-fija').trim();
    ctx.strokeStyle = tinta || 'rgb(22, 39, 68)';
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
      {/* Lienzo = papel: blanco y tinta fija en los dos temas, para que el trazo se lea igual en pantalla
          que en la imagen exportada (blanco fijo del kit, --kit-sobre-relleno, igual en los dos temas). */}
      <canvas
        ref={ref}
        role="img"
        aria-label={label}
        className="h-48 w-full touch-none rounded-[9px] border border-[color:var(--color-border-control)] bg-[var(--kit-sobre-relleno)]"
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerLeave={end}
      />
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="text-xs text-[color:var(--color-text-tertiary)]">{vacia ? 'Firme aquí' : 'Firmado'}</span>
        <GradientButton type="button" variant="ghost" size="sm" onClick={limpiar}>Limpiar</GradientButton>
      </div>
    </div>
  );
}
