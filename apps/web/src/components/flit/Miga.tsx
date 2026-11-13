import { Link } from 'react-router-dom';

/** Miga de pan del UI Kit 2026 (`.miga`): anteriores en gris, actual en azul subrayado; siempre empieza en Inicio. */
export interface PasoMiga { etiqueta: string; to?: string }

export default function Miga({ pasos, actual }: { pasos: PasoMiga[]; actual: string }) {
  const todos: PasoMiga[] = [{ etiqueta: 'Inicio', to: '/' }, ...pasos.filter((p) => p.etiqueta !== 'Inicio')];
  return (
    <nav aria-label="Miga de pan" className="miga">
      {todos.map((p) => (
        <span key={p.etiqueta} className="contents">
          {p.to ? <Link to={p.to}>{p.etiqueta}</Link> : <span>{p.etiqueta}</span>}
          <i aria-hidden="true">›</i>
        </span>
      ))}
      <span className="miga__actual" aria-current="page">{actual}</span>
    </nav>
  );
}
