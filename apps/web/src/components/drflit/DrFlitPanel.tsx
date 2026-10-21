import { Link } from 'react-router-dom';

// Dr. Flit — contenido del panel (HU #13764, Feature #13694). Se carga con `lazy()` solo tras el
// primer clic en «Abrir Dr. Flit» (AC8); el marco (cabecera, «Cerrar», carga y error) vive en el
// chunk del Layout (`DrFlitMarco`). HU-1 entrega solo la bienvenida con el enlace a la Ayuda.
// Enganches previstos por el slim (`docs/diseno/feature-13694-dr-flit-panel-slim.md`):
// - HU #13765: «¿Por dónde empezamos?» + «Explícame un módulo» bajo el saludo.
// - HU #13766: «Tengo una pregunta» + caja «Escriba su pregunta» en el pie.
// - HU #13767: conversación restaurada de `sessionStorage` en lugar del saludo.

export interface DrFlitPanelProps {
  /** Se llama al seguir un enlace del panel: en <lg el montaje cierra el panel para ver la página. */
  onNavegar: () => void;
}

export default function DrFlitPanel({ onNavegar }: DrFlitPanelProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Conversación: región con scroll propio. Con la conversación vacía, el saludo. */}
      <div
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label="Conversación con Dr. Flit"
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
      >
        <div className="rounded-flit-lg border border-flit-soft bg-flit-card p-4 text-sm text-flit-ink">
          <p className="break-words">
            <span className="sr-only">Dr. Flit: </span>
            Hola, soy Dr. Flit. Le ayudo a encontrar respuestas en los manuales de los módulos que usted usa.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link
              to="/flito/ayuda"
              onClick={onNavegar}
              className="flit-focus inline-flex items-center gap-1 rounded-md font-medium text-[color:var(--flit-blue-text)] underline-offset-2 transition-colors hover:text-flit-ink hover:underline"
            >
              Abrir la Ayuda FLITO
              <span aria-hidden="true">→</span>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
