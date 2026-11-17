import { useEffect, useState } from 'react';

// `lg` del kit (1024 px): desde ahí hay dock; por debajo, ☰ + menú lateral (shell) y tarjetas en vez de tabla
// (Logística). Un solo hook para que shell y páginas cambien de modo en el mismo píxel.
const LG = '(min-width: 1024px)';

/** `true` desde `lg` (≥1024 px). Escucha el cambio del media query, no el `resize`. */
export function useDesdeLg(): boolean {
  const [desde, setDesde] = useState(() => typeof window === 'undefined' || window.matchMedia(LG).matches);
  useEffect(() => {
    const m = window.matchMedia(LG);
    const alCambiar = () => setDesde(m.matches);
    alCambiar();
    m.addEventListener('change', alCambiar);
    return () => m.removeEventListener('change', alCambiar);
  }, []);
  return desde;
}
