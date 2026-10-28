// HU #14134 — los dos pasos de la carga masiva: descargar la plantilla y subir el archivo.
import type { ReactNode } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { flitBtnSecondary, flitBtnSecondaryStyle } from '../../../flit/flitPageKit';
import { COPY_MASIVO } from './copyMasivo';
import type { TipoMasivo } from './tiposMasivo';

export default function PasoPlantilla({ tipo, descargando, onDescargar, children }: {
  tipo: TipoMasivo;
  descargando: boolean;
  onDescargar: () => void;
  /** El paso 2 (zona de carga). */
  children: ReactNode;
}) {
  const copy = COPY_MASIVO[tipo];
  return (
    <ol className="space-y-4">
      <li className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 text-sm" style={{ color: 'var(--flit-text-primary)' }}>
          <span className="font-semibold">1. </span>{copy.paso1}
        </p>
        <button
          type="button" className={`${flitBtnSecondary} w-full justify-center sm:w-auto`} style={flitBtnSecondaryStyle}
          aria-disabled={descargando || undefined} onClick={() => { if (!descargando) onDescargar(); }}
        >
          {descargando
            ? <Loader2 size={16} aria-hidden="true" className="animate-spin" />
            : <Download size={16} aria-hidden="true" />}
          {descargando ? 'Descargando…' : 'Descargar plantilla'}
        </button>
      </li>
      <li className="space-y-2">
        <p className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
          <span className="font-semibold">2. </span>{copy.paso2}
        </p>
        {children}
      </li>
    </ol>
  );
}
