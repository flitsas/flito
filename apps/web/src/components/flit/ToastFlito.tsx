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
import { Icono } from './kit/Icono';

interface OpcionesToast {
  /** Id estable: un segundo toast con el mismo id SUSTITUYE al primero (un toast por acción). */
  id?: string;
  /** Solo `toastOk`: el default (4 s) no alcanza para leer dos frases. */
  duracionMs?: number;
}

function ToastFlito({ t, texto, error, onReintentar }: {
  t: Toast; texto: string; error: boolean; onReintentar?: () => void;
}) {
  // Aviso del UI Kit 2026: borde y fondo semántico al 10 %, ícono aviso-*.svg de 30 px, cerrable.
  return (
    <div role={error ? 'alert' : 'status'} className="kit-aviso" data-tono={error ? 'danger' : 'ok'} data-kit="aviso">
      <img src={error ? '/kit/aviso-error.svg' : '/kit/aviso-ok.svg'} alt="" aria-hidden="true" className="kit-aviso__icono" />
      <p className="kit-aviso__texto m-0 whitespace-pre-line">{texto}</p>
      {onReintentar && (
        <button type="button" className="btn ghost sm" onClick={() => { toast.dismiss(t.id); onReintentar(); }}>
          <Icono nombre="reintento" size={16} />
          Reintentar
        </button>
      )}
      <button type="button" aria-label="Cerrar aviso" title="Cerrar aviso" className="kit-aviso__cerrar" onClick={() => toast.dismiss(t.id)}>
        <Icono nombre="cerrar" size={16} />
      </button>
    </div>
  );
}

export function toastOk(texto: string, opciones: OpcionesToast = {}): string {
  return toast.custom((t) => <ToastFlito t={t} texto={texto} error={false} />, { id: opciones.id, duration: opciones.duracionMs ?? 4_000 });
}

export function toastError(texto: string, onReintentar?: () => void, opciones: OpcionesToast = {}): string {
  return toast.custom(
    (t) => <ToastFlito t={t} texto={texto} error onReintentar={onReintentar} />,
    { id: opciones.id, duration: 10_000 },
  );
}
