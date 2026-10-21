// Tabla de contenido de una ficha de Ayuda FLITO (Feature #13691 · HU #13705, diseño slim §7; UX HU-3).
// Un enlace por `h2` (el `h1` del .md se pinta como `h2`) y los `h3` anidados. `≥ lg`: columna derecha
// pegajosa. `< lg`: acordeón del kit, cerrado, arriba del artículo; al elegir sección se cierra.
// Sin scrollspy: solo se marca la sección del `#ancla` actual.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { textoPlano, type MdBlock } from '../../lib/ayudaMarkdown';
import FlitAcordeon from '../flit/FlitAcordeon';

export interface SeccionFicha {
  id: string;
  texto: string;
  nivel: 2 | 3;
}

/** Secciones de la TOC a partir del AST de la ficha. */
export function seccionesDeFicha(bloques: MdBlock[]): SeccionFicha[] {
  const out: SeccionFicha[] = [];
  for (const b of bloques) {
    if (b.type === 'h1' || b.type === 'h2') out.push({ id: b.id, texto: textoPlano(b.children), nivel: 2 });
    else if (b.type === 'h3') out.push({ id: b.id, texto: textoPlano(b.children), nivel: 3 });
  }
  return out;
}

/** Solo hay TOC con ≥ 2 secciones de nivel 2: con menos, la columna no existe (UX HU-3). */
export function fichaConTabla(secciones: SeccionFicha[]): boolean {
  return secciones.filter((s) => s.nivel === 2).length >= 2;
}

function Lista(
  { secciones, actual, onElegir }: { secciones: SeccionFicha[]; actual: string; onElegir?: () => void },
) {
  return (
    <ul className="space-y-0.5">
      {secciones.map((s) => {
        const activa = s.id === actual;
        return (
          <li key={s.id} className={s.nivel === 3 ? 'pl-3' : undefined}>
            <Link
              to={{ hash: s.id }}
              onClick={onElegir}
              aria-current={activa ? 'location' : undefined}
              className={`flit-focus block break-words rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-[color:var(--flit-bg-hover)]${activa ? ' font-semibold' : ''}`}
              style={{ color: activa ? 'var(--flit-blue-text)' : 'var(--flit-text-secondary)' }}
            >
              {s.texto}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

const ROTULO = 'Contenido de la ficha';

/** Columna derecha (`≥ lg`). */
export function TablaContenidoLateral({ secciones, actual }: { secciones: SeccionFicha[]; actual: string }) {
  return (
    <nav
      aria-label={ROTULO}
      className="hidden lg:sticky lg:top-24 lg:block lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto"
      data-testid="ayuda-toc-lateral"
    >
      <p className="mb-2 px-2 text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: 'var(--flit-text-secondary)' }}>
        {ROTULO}
      </p>
      <Lista secciones={secciones} actual={actual} />
    </nav>
  );
}

/** Acordeón plegado arriba del cuerpo (`< lg`). */
export function TablaContenidoPlegable({ secciones, actual }: { secciones: SeccionFicha[]; actual: string }) {
  const [abierto, setAbierto] = useState(false);
  return (
    <div
      className="lg:hidden"
      style={{
        borderRadius: 'var(--flit-radius-card)',
        border: '1px solid var(--flit-border-soft)',
        background: 'var(--flit-bg-card)',
      }}
    >
      <FlitAcordeon
        titulo={ROTULO}
        cantidad={secciones.length}
        abierto={abierto}
        onToggle={() => setAbierto((a) => !a)}
        testId="ayuda-toc-plegable"
      >
        <nav aria-label={ROTULO} className="pb-2">
          <Lista secciones={secciones} actual={actual} onElegir={() => setAbierto(false)} />
        </nav>
      </FlitAcordeon>
    </div>
  );
}
