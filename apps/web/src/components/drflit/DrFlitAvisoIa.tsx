import type { AvisoIa } from './useIaDrFlit';

// Dr. Flit IA — aviso persistente del pie, sobre la caja (HU #13857; spec `docs/ux/flito-dr-flit-f4-ia.md`
// §IA.3). A, B y C son la misma pieza: tarjeta de estado (`role="status"`), sin icono ni ✕; no es toast.

const ENLACE_AVISO =
  'flit-focus inline-flex min-h-11 items-center rounded-md font-medium text-[color:var(--flit-blue-text)] underline-offset-2 transition-colors hover:text-flit-ink hover:underline lg:min-h-0';

export const COPY_CUPO_AGOTADO =
  'Por hoy alcanzó el límite de preguntas con IA. Sigo ayudándole con la búsqueda en los manuales; el cupo se renueva a la medianoche.';

export default function DrFlitAvisoIa({ aviso, onAbrirAutorizacion }: {
  aviso: Exclude<AvisoIa, null>;
  onAbrirAutorizacion: () => void;
}) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-flit-lg border border-flit-soft bg-flit-app px-3 py-2 text-sm text-flit-secondary"
    >
      {aviso === 'A' && <p className="break-words">{COPY_CUPO_AGOTADO}</p>}
      {aviso === 'B' && (
        <>
          <p className="break-words">Le respondo con la búsqueda en los manuales.</p>
          <button type="button" onClick={onAbrirAutorizacion} className={ENLACE_AVISO}>
            Activar respuestas con IA
          </button>
        </>
      )}
      {aviso === 'C' && (
        <>
          <p className="break-words">Cambiaron las condiciones de uso de la IA.</p>
          <button type="button" onClick={onAbrirAutorizacion} className={ENLACE_AVISO}>
            Revisar y aceptar
          </button>
        </>
      )}
    </div>
  );
}
