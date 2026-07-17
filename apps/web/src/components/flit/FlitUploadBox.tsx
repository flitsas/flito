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
}

export default function FlitUploadBox({ label, required, state, count, onFile }: FlitUploadBoxProps) {
  const color =
    state === 'rejected' ? 'var(--flit-danger)'
    : state === 'verified' ? 'var(--flit-success)'
    : 'var(--flit-blue)';
  const bg =
    state === 'rejected' ? 'rgba(228,61,48,0.06)'
    : state === 'verified' ? 'rgba(112,207,58,0.08)'
    : '#fff';
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
        {state === 'rejected' && <p className="mt-1 text-[10px] font-semibold" style={{ color: 'var(--flit-danger)' }}>Rechazado — cargar otro</p>}
        {state === 'verified' && <p className="mt-1 text-[10px]" style={{ color: 'var(--flit-success)' }}>{count} archivo(s)</p>}
        {state === 'uploading' && <p className="mt-1 text-[10px]" style={{ color: 'var(--flit-blue)' }}>Analizando...</p>}
      </div>
      <input
        type="file"
        accept=".pdf,.png,.jpg,.jpeg"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }}
      />
    </label>
  );
}
