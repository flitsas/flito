import { useState } from 'react';
import { Icono } from '../flit/kit/Icono';

// Imagen de una ficha de Ayuda (Feature #13691 · HU #13707, diseño slim §6).
// - `src` ya viene validado por el parser (`/ayuda/<clave>/<archivo>?v=<version>`): fuera del grafo de
//   Vite, se pide solo al abrir la ficha (`loading="lazy"`).
// - Caja 16:10 con `object-fit: contain`: el espacio queda reservado antes de cargar (sin salto de
//   layout) y la imagen nunca desborda el contenedor (decisión cerrada con el humano).
// - SVG solo como `<img>` (no ejecuta scripts). Si el archivo no carga, el alt en texto (AC5).
// - `en`: `figure` cuando la imagen es el párrafo entero; `span` (bloque) si va dentro de un texto,
//   porque un `<figure>` no puede vivir dentro de un `<p>`.
export default function AyudaImagen({ alt, src, en }: { alt: string; src: string; en: 'figure' | 'span' }) {
  const [rota, setRota] = useState(false);
  const Raiz = en;
  const Pie = en === 'figure' ? 'figcaption' : 'span';

  if (rota) {
    return (
      <Raiz
        data-testid="ayuda-imagen-rota"
        className="flex items-start gap-2 rounded-[9px] border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-3 py-2 text-sm text-[color:var(--color-text-secondary)]"
      >
        <Icono nombre="nube-sin" size={16} className="mt-0.5 shrink-0" />
        <span className="break-words">Imagen no disponible: {alt}</span>
      </Raiz>
    );
  }

  return (
    <Raiz data-testid="ayuda-imagen" className="block w-full max-w-full space-y-1">
      <span
        className="block aspect-[16/10] w-full overflow-hidden rounded-[9px] border border-[color:var(--color-border)] bg-[color:var(--color-surface)]"
      >
        <img
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          className="block h-full w-full max-w-full object-contain"
          onError={() => setRota(true)}
        />
      </span>
      <Pie className="block text-xs">
        <a
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          className="flit-focus inline-flex items-center gap-1 rounded-sm underline transition-colors text-[color:var(--color-action)] hover:text-[color:var(--color-text-primary)]"
        >
          Ver en tamaño completo
          <Icono nombre="externo" size={12} />
          <span className="sr-only"> (se abre en otra pestaña): {alt}</span>
        </a>
      </Pie>
    </Raiz>
  );
}
