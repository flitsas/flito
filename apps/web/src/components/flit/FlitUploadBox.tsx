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
}

const ACCEPT_POR_DEFECTO = '.pdf,.png,.jpg,.jpeg';

export default function FlitUploadBox(
  { label, required, state, count, onFile, accept = ACCEPT_POR_DEFECTO, hint }: FlitUploadBoxProps,
) {
  const color =
    state === 'rejected' ? 'var(--flit-danger)'
    : state === 'verified' ? 'var(--flit-success)'
    : 'var(--flit-blue)';
  const bg =
    state === 'rejected' ? 'rgba(228,61,48,0.06)'
    : state === 'verified' ? 'rgba(112,207,58,0.08)'
    // Antes '#fff' fijo: el recuadro en reposo se quedaba blanco con la app en oscuro.
    // Los tintes de verified/rejected son translúcidos y sí componen sobre el nuevo fondo.
    : 'var(--flit-bg-card)';
  const icon =
    state === 'rejected' ? 'M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z'
    : state === 'verified' ? 'M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z'
    : 'M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5';

  return (
    <label
      className={`flit-focus relative block cursor-pointer rounded-[12px] p-4 transition-colors ${state === 'uploading' ? 'pointer-events-none opacity-60' : ''}`}
      style={{ border: `2px dashed ${color}`, background: bg }}
    >
      <div className="text-center">
        <svg className="mx-auto mb-2 h-8 w-8" style={{ color }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d={icon} />
        </svg>
        <p className="text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{label}{required ? ' *' : ''}</p>
        {hint && <p className="mt-1 text-[11px]" style={{ color: 'var(--flit-text-secondary)' }}>{hint}</p>}
        {state === 'rejected' && <p className="mt-1 text-[10px] font-semibold" style={{ color: 'var(--flit-danger)' }}>Rechazado — cargar otro</p>}
        {state === 'verified' && <p className="mt-1 text-[10px]" style={{ color: 'var(--flit-success)' }}>{count} archivo(s)</p>}
        {state === 'uploading' && <p className="mt-1 text-[10px]" style={{ color: 'var(--flit-blue)' }}>Analizando...</p>}
      </div>
      <input
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }}
      />
    </label>
  );
}
