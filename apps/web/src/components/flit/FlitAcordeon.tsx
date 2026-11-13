// Acordeón del kit FLIT (HU #11210).
//
// Nace para el tablero de bolsas, donde clientes y organismos comparten pantalla y ninguno de los
// dos puede quedar escondido detrás de una pestaña. El estado de apertura NO vive aquí: lo pone
// quien lo usa, porque el tablero necesita poder abrir el acordeón de tránsitos cuando hay alguno en
// préstamo, y un componente que se acuerda solo de si estaba abierto no dejaría hacerlo.
//
// La acción del encabezado (un «+», por ejemplo) va FUERA del botón que despliega: un botón dentro
// de otro botón no es HTML válido y, en la práctica, pulsarla plegaría el acordeón.
//
// HU #13238 (sección Sincronización de Gestión Trámites): `resumen` deja ver el estado sin desplegar
// (contenido en línea, va dentro del botón y forma parte de su nombre), `nivel` envuelve el disparador
// en un encabezado (patrón WAI-ARIA de acordeón) y `testId` lo deja localizar. El disparador gana
// hover sutil y el chevron respeta `prefers-reduced-motion`.

import { type ReactNode, useId } from 'react';
import { Icono } from './kit/Icono';

interface Props {
  titulo: string;
  /** Cuántos elementos contiene. Se muestra junto al título para no obligar a desplegar y contar. */
  cantidad?: number;
  abierto: boolean;
  onToggle: () => void;
  /** Botón o controles del encabezado, a la derecha. Hermano del disparador, nunca su hijo. */
  accion?: ReactNode;
  descripcion?: string;
  /** Resumen en línea bajo el título (sin bloques: vive dentro del botón). Sustituye a `descripcion`. */
  resumen?: ReactNode;
  /** Envuelve el disparador en `<h2>`/`<h3>` cuando el acordeón es una sección de la página. */
  nivel?: 2 | 3;
  /** `data-testid` del botón disparador. */
  testId?: string;
  children: ReactNode;
}

export default function FlitAcordeon({
  titulo, cantidad, abierto, onToggle, accion, descripcion, resumen, nivel, testId, children,
}: Props) {
  const idPanel = useId();
  const idBoton = useId();
  const idTitulo = useId();
  const Encabezado = nivel === 2 ? 'h2' : nivel === 3 ? 'h3' : null;

  const disparador = (
    <button
      type="button"
      id={idBoton}
      data-testid={testId}
      className="-mx-2 -my-1 flex min-w-0 flex-1 items-center gap-3 rounded-[9px] px-2 py-1 text-left transition-colors hover:bg-[var(--kit-hover)]"
      aria-expanded={abierto}
      aria-controls={idPanel}
      onClick={onToggle}
    >
      {/* El chevron es decorativo: quien no lo vea ya tiene el estado en aria-expanded. */}
      <Icono
        nombre="derecha"
        size={18}
        className={`shrink-0 transition-transform motion-reduce:transition-none ${abierto ? 'rotate-90 text-[color:var(--color-action)]' : 'text-[color:var(--color-text-tertiary)]'}`}
      />
      <span className="min-w-0 flex-1">
        <span id={idTitulo} className="block text-base font-semibold text-[color:var(--color-text-primary)]">
          {titulo}
          {cantidad !== undefined && (
            <span className="acordeon__cuenta ml-2 !inline-grid !h-6 !min-w-6 text-xs tabular-nums">
              ({cantidad})
            </span>
          )}
        </span>
        {resumen !== undefined ? (
          <span className="mt-0.5 block text-[0.8125rem] text-[color:var(--color-text-tertiary)]">
            {resumen}
          </span>
        ) : descripcion && (
          <span className="mt-0.5 block text-[0.8125rem] text-[color:var(--color-text-tertiary)]">
            {descripcion}
          </span>
        )}
      </span>
    </button>
  );

  return (
    <section className="acordeon" data-kit="acordeon">
      <div className={`flex min-h-14 items-center justify-between gap-3 px-4 py-2 transition-colors${abierto ? ' bg-[var(--kit-hover)]' : ''}`}>
        {Encabezado
          ? <Encabezado className="m-0 flex min-w-0 flex-1 text-sm font-normal">{disparador}</Encabezado>
          : disparador}
        {accion}
      </div>

      {/* Desmontado y no solo oculto: el contenido de cada acordeón trae sus propias tarjetas y
          dejarlas en el DOM las pondría en el orden de tabulación de una sección que no se ve. */}
      {abierto && (
        <div
          id={idPanel}
          role="region"
          aria-labelledby={resumen !== undefined ? idTitulo : idBoton}
          className="border-t border-[color:var(--color-divider)] px-5 py-4"
        >
          {children}
        </div>
      )}
    </section>
  );
}
