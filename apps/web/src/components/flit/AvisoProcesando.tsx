// AvisoProcesando — pastilla tonal con spinner para lo que «se está analizando/procesando»
// (HU #14137, docs/ux/flito-soat-inicial-masiva-y-pendientes.md «Aviso de procesamiento»).
//
// Mismos pares de color del `StatusChip` (tokens con par oscuro, sin HEX). No es interactivo.
// `role="status" aria-live="polite"`: un anuncio al aparecer. Con `anuncio`, el texto visible queda
// `aria-hidden` y lo que se lee es ese texto estable aparte: así un número que cambia cada sondeo
// (12 de 40 → 20 de 40) se actualiza a la vista sin re-anunciarse cada 2,5 s.
// Con `prefers-reduced-motion` el spinner no gira (el texto sigue siendo el portador del estado).
import { Loader2 } from 'lucide-react';

const TONOS = {
  activo: { bg: 'var(--flit-chip-active-bg)', ink: 'var(--flit-blue-ink)' },
  neutro: { bg: 'var(--flit-chip-draft-bg)', ink: 'var(--flit-chip-draft-ink)' },
} as const;

export default function AvisoProcesando({ texto, tono = 'activo', className = '', anuncio }: {
  /** Frase completa con puntos suspensivos. */
  texto: string;
  tono?: keyof typeof TONOS;
  className?: string;
  /** Texto estable para el lector de pantalla cuando `texto` cambia a menudo. */
  anuncio?: string;
}) {
  const t = TONOS[tono];
  return (
    <div
      role="status" aria-live="polite"
      className={`flex w-full items-start gap-2 rounded-2xl border px-3.5 py-1.5 text-[13px] font-semibold lg:inline-flex lg:w-auto lg:items-center lg:rounded-full ${className}`.trim()}
      style={{ background: t.bg, color: t.ink, borderColor: `color-mix(in srgb, ${t.ink} 45%, transparent)` }}
    >
      <Loader2 size={14} aria-hidden="true" className="mt-0.5 shrink-0 animate-spin motion-reduce:animate-none lg:mt-0" />
      {anuncio ? (
        <>
          <span aria-hidden="true" className="min-w-0">{texto}</span>
          <span className="sr-only">{anuncio}</span>
        </>
      ) : <span className="min-w-0">{texto}</span>}
    </div>
  );
}
