// Toast del kit FLITO (HU #12819). Sale del `ToastComprobante` de la descarga individual del SOAT
// (HU #12816), que ya era cerrable y estaba probado en E2E, y se promueve al kit para que ninguna
// pantalla vuelva a usar `toast.success` de react-hot-toast, que NO se puede cerrar.
//
// Reglas (AGENTS.md §13 y regla 16 del frontend-agent): una frase, qué pasó y qué sigue; siempre
// cerrable; nunca el error crudo del API. Un toast por acción. El estado persistente NO va aquí: va en
// un aviso de página (`role="status"`).
//
//   · `toastOk(texto)`     — 4 s, `role="status"`.
//   · `toastError(texto, onReintentar?)` — 10 s, `role="alert"`, con «Reintentar» solo cuando otro
//     intento puede salir distinto.
//
// Los nombres accesibles son los de siempre y los E2E los buscan literales: «Reintentar» y
// «Cerrar aviso».
import toast, { type Toast } from 'react-hot-toast';
import { RotateCw, X } from 'lucide-react';

interface OpcionesToast {
  /** Id estable: un segundo toast con el mismo id SUSTITUYE al primero (un toast por acción). */
  id?: string;
}

function ToastFlito({ t, texto, error, onReintentar }: {
  t: Toast; texto: string; error: boolean; onReintentar?: () => void;
}) {
  return (
    <div role={error ? 'alert' : 'status'} className="flex max-w-sm items-start gap-3 rounded-lg border p-3 text-sm"
      style={{ background: 'var(--flit-bg-card)', color: 'var(--flit-text-primary)', borderColor: 'var(--flit-border-soft)' }}>
      <p className="flex-1 self-center">{texto}</p>
      <div className="flex shrink-0 items-center gap-1">
        {onReintentar && (
          <button type="button"
            className="flit-focus inline-flex items-center gap-1.5 rounded px-2 py-1 font-semibold transition-colors hover:bg-[var(--flit-bg-hover)]"
            style={{ color: 'var(--flit-blue-text)' }}
            onClick={() => { toast.dismiss(t.id); onReintentar(); }}>
            <RotateCw size={16} aria-hidden="true" className="shrink-0" />
            Reintentar
          </button>
        )}
        <button type="button" aria-label="Cerrar aviso" title="Cerrar aviso"
          className="flit-focus grid h-7 w-7 place-items-center rounded transition-colors hover:bg-[var(--flit-bg-hover)]"
          style={{ color: 'var(--flit-text-secondary)' }} onClick={() => toast.dismiss(t.id)}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export function toastOk(texto: string, opciones: OpcionesToast = {}): string {
  return toast.custom((t) => <ToastFlito t={t} texto={texto} error={false} />, { id: opciones.id, duration: 4_000 });
}

export function toastError(texto: string, onReintentar?: () => void, opciones: OpcionesToast = {}): string {
  return toast.custom(
    (t) => <ToastFlito t={t} texto={texto} error onReintentar={onReintentar} />,
    { id: opciones.id, duration: 10_000 },
  );
}
