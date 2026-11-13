import { NavLink } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useDesbordeScroll } from './kit/useDesbordeScroll';

/**
 * Pestañas del UI Kit 2026 (`.pestanas`): línea inferior gris 2 px, mayúscula 14 bold; activa azul con 3 px.
 * Se desliza en horizontal en teléfono. Dos modos: enlaces (`to`) o pestañas en página (`onElegir`, role tablist).
 */
export interface Pestana { id: string; etiqueta: ReactNode; to?: string; cuenta?: number }

export default function Pestanas({ pestanas, activa, onElegir, etiqueta }: {
  pestanas: Pestana[]; activa?: string; onElegir?: (id: string) => void; etiqueta: string;
}) {
  // Pista de desborde (V6): `data-desborda` mientras queden pestañas ocultas a la derecha.
  const tiraRef = useDesbordeScroll<HTMLDivElement>();
  if (!onElegir) {
    return (
      <nav ref={tiraRef} aria-label={etiqueta} className="kit-pestanas" data-kit="pestanas">
        {pestanas.map((p) => (
          <NavLink key={p.id} to={p.to ?? '#'} end className="kit-pestana">
            {p.etiqueta}{p.cuenta !== undefined && <span className="acordeon__cuenta !h-6 !min-w-6 text-xs">{p.cuenta}</span>}
          </NavLink>
        ))}
      </nav>
    );
  }
  return (
    <div ref={tiraRef} role="tablist" aria-label={etiqueta} className="kit-pestanas" data-kit="pestanas">
      {pestanas.map((p) => (
        <button key={p.id} type="button" role="tab" aria-selected={p.id === activa} className="kit-pestana" onClick={() => onElegir(p.id)}>
          {p.etiqueta}{p.cuenta !== undefined && <span className="acordeon__cuenta !h-6 !min-w-6 text-xs">{p.cuenta}</span>}
        </button>
      ))}
    </div>
  );
}
