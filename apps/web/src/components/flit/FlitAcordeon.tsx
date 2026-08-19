// Acordeón del kit FLIT (HU #11210).
//
// Nace para el tablero de bolsas, donde clientes y organismos comparten pantalla y ninguno de los
// dos puede quedar escondido detrás de una pestaña. El estado de apertura NO vive aquí: lo pone
// quien lo usa, porque el tablero necesita poder abrir el acordeón de tránsitos cuando hay alguno en
// préstamo, y un componente que se acuerda solo de si estaba abierto no dejaría hacerlo.
//
// La acción del encabezado (un «+», por ejemplo) va FUERA del botón que despliega: un botón dentro
// de otro botón no es HTML válido y, en la práctica, pulsarla plegaría el acordeón.

import { type ReactNode, useId } from 'react';

interface Props {
  titulo: string;
  /** Cuántos elementos contiene. Se muestra junto al título para no obligar a desplegar y contar. */
  cantidad?: number;
  abierto: boolean;
  onToggle: () => void;
  /** Botón o controles del encabezado, a la derecha. Hermano del disparador, nunca su hijo. */
  accion?: ReactNode;
  descripcion?: string;
  children: ReactNode;
}

export default function FlitAcordeon({
  titulo, cantidad, abierto, onToggle, accion, descripcion, children,
}: Props) {
  const idPanel = useId();
  const idBoton = useId();

  return (
    <section
      className="overflow-hidden bg-white"
      style={{
        borderRadius: 'var(--flit-radius-card)',
        boxShadow: 'var(--flit-shadow-card)',
        border: '1px solid var(--flit-border-soft)',
      }}
    >
      <div className="flex items-center justify-between gap-3 px-5 py-4">
        <button
          type="button"
          id={idBoton}
          className="flit-focus flex min-w-0 flex-1 items-center gap-3 text-left"
          aria-expanded={abierto}
          aria-controls={idPanel}
          onClick={onToggle}
        >
          {/* El chevron es decorativo: quien no lo vea ya tiene el estado en aria-expanded. */}
          <span
            aria-hidden="true"
            className="inline-block text-xs transition-transform"
            style={{
              color: 'var(--flit-text-muted)',
              transform: abierto ? 'rotate(90deg)' : 'rotate(0deg)',
            }}
          >
            ▶
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>
              {titulo}
              {cantidad !== undefined && (
                <span className="ml-2 font-semibold tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>
                  ({cantidad})
                </span>
              )}
            </span>
            {descripcion && (
              <span className="mt-0.5 block text-xs" style={{ color: 'var(--flit-text-muted)' }}>
                {descripcion}
              </span>
            )}
          </span>
        </button>
        {accion}
      </div>

      {/* Desmontado y no solo oculto: el contenido de cada acordeón trae sus propias tarjetas y
          dejarlas en el DOM las pondría en el orden de tabulación de una sección que no se ve. */}
      {abierto && (
        <div
          id={idPanel}
          role="region"
          aria-labelledby={idBoton}
          className="border-t px-5 py-4"
          style={{ borderColor: 'var(--flit-border-soft)' }}
        >
          {children}
        </div>
      )}
    </section>
  );
}
