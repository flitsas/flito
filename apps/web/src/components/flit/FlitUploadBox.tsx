import { Icono } from './kit/Icono';

// FlitUploadBox — caja de carga de documentos del prototipo FLIT (p.15): borde
// punteado azul, icono centrado, texto azul, fondo blanco. Estados: idle /
// uploading / verified / rejected. Encapsula solo el contenedor visual + el
// <input type=file> (la lógica OCR/subida vive en el llamador).
interface FlitUploadBoxProps {
  label: string;
  required?: boolean;
  state: 'idle' | 'uploading' | 'verified' | 'rejected';
  count?: number;
  onFile: (file: File) => void;
  /**
   * Filtro del diálogo del sistema (`accept` del `<input type=file>`).
   *
   * Hasta la HU #11680 estaba QUEMADO a `.pdf,.png,.jpg,.jpeg`, que es lo que suben los soportes de
   * bolsas y de trámites; la carga de la boleta de conciliación es un `.xlsx` y con el filtro fijo
   * el archivo bueno salía en gris en el explorador. Se abre como prop OPCIONAL con ese mismo valor
   * por defecto: ningún llamador existente cambia de comportamiento.
   *
   * No es una validación —`accept` es una sugerencia del diálogo y se puede saltar arrastrando—:
   * quien decide de verdad es el servidor, que olfatea los bytes.
   */
  accept?: string;
  /**
   * Segunda línea dentro de la caja, bajo la etiqueta: qué archivo es el bueno («El archivo tal
   * como lo descargas del portal», «PDF, JPG o PNG · máximo 15 MB»).
   *
   * Va DENTRO de la caja y no al lado porque la caja entera es el `<label>` del input: lo que se
   * escribe fuera no forma parte del nombre accesible del control.
   */
  hint?: string;
  /** `aria-describedby` del input (HU #13270: el aviso de descarte se lee al llegar al campo). Opcional. */
  describedBy?: string;
  /**
   * Varios archivos a la vez (HU #13363, documentos adicionales del SOAT). Con `multiple` la caja
   * entrega la lista entera por `onFiles` y el input queda alcanzable con el tabulador (`sr-only` en
   * vez de `hidden`), con el foco y un velo de hover sobre la caja. Sin la prop, nada cambia.
   */
  multiple?: boolean;
  onFiles?: (files: File[]) => void;
  /**
   * HU #14134: lo mismo que `multiple` en cuanto a teclado y feedback (input `sr-only` alcanzable
   * con el tabulador, velo de hover y anillo de foco) pero para UN solo archivo. Opcional: sin la
   * prop, el comportamiento de los llamadores existentes no cambia.
   */
  alcanzable?: boolean;
}

const ACCEPT_POR_DEFECTO = '.pdf,.png,.jpg,.jpeg';

/** Hover (velo) y foco del kit sobre la caja cuando el input es alcanzable por teclado. */
// Zona de carga del UI Kit 2026 (`.carga` → `.carga--lista`): borde discontinuo azul de 1,5 px, al quedar lista
// borde verde sólido y fondo verde al 10 %; rechazada, borde naranja. Íconos del kit.
export default function FlitUploadBox(
  { label, required, state, count, onFile, accept = ACCEPT_POR_DEFECTO, hint, describedBy, multiple, onFiles, alcanzable }: FlitUploadBoxProps,
) {
  const conTeclado = multiple || alcanzable;
  const glifo = state === 'rejected' ? 'nube-alerta' : state === 'verified' ? 'check' : 'nube-subir';
  return (
    <label
      data-kit="carga"
      data-estado={state}
      className={`carga kit-carga${state === 'verified' ? ' carga--lista' : ''}${state === 'rejected' ? ' kit-carga--rechazada' : ''}${conTeclado ? ' focus-within:outline focus-within:outline-2 focus-within:outline-[var(--kit-azul)]' : ''}${state === 'uploading' ? ' pointer-events-none opacity-60' : ''}`}
    >
      <Icono nombre={glifo} size={36} />
      <span className="text-sm font-semibold text-[color:var(--color-text-primary)]">{label}{required ? ' *' : ''}</span>
      {hint && <small>{hint}</small>}
      {state === 'rejected' && <small className="font-semibold !text-[color:var(--flit-danger-ink)]">Rechazado — cargar otro</small>}
      {state === 'verified' && <small className="!text-[color:var(--flit-success-ink)]">{count} archivo(s)</small>}
      {state === 'uploading' && <small className="!text-[color:var(--color-action)]">Analizando...</small>}
      <input
        type="file"
        accept={accept}
        multiple={multiple}
        aria-describedby={describedBy}
        className={conTeclado ? 'sr-only' : 'hidden'}
        onChange={(e) => {
          const lista = Array.from(e.target.files ?? []);
          if (multiple && onFiles) { if (lista.length) onFiles(lista); }
          else if (lista[0]) onFile(lista[0]);
          e.target.value = '';
        }}
      />
    </label>
  );
}
