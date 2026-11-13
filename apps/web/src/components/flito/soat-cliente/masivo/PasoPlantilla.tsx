// HU #14134 — los dos pasos de la carga masiva: descargar la plantilla y subir el archivo.
import type { ReactNode } from 'react';
import { Icono } from '../../../flit/kit/Icono';
import { Girador } from '../../../flit/Cargador';
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
        <div className="min-w-0 space-y-1">
          <p className="text-sm text-[color:var(--color-text-primary)]">
            <span className="font-semibold">1. </span>{copy.paso1}
          </p>
          {copy.notaPaso1 && (
            <p className="text-xs text-[color:var(--color-text-secondary)]">{copy.notaPaso1}</p>
          )}
        </div>
        <button
          type="button" className={`${flitBtnSecondary} w-full justify-center sm:w-auto`} style={flitBtnSecondaryStyle}
          aria-disabled={descargando || undefined} onClick={() => { if (!descargando) onDescargar(); }}
        >
          {descargando
            ? <Girador />
            : <Icono nombre="nube-bajar" size={16} />}
          {descargando ? 'Descargando…' : 'Descargar plantilla'}
        </button>
      </li>
      <li className="space-y-2">
        <p className="text-sm text-[color:var(--color-text-primary)]">
          <span className="font-semibold">2. </span>{copy.paso2}
        </p>
        {children}
      </li>
    </ol>
  );
}
