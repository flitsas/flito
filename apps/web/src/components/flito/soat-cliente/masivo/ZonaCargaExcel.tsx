// HU #14134 — elegir el .xlsx y cargarlo. Validación del cliente: solo la extensión (AC4); vacío y
// más de 200 filas los decide el servidor y su copy sale del diccionario, nunca del mensaje del API.
import AvisoProcesando from '../../../flit/AvisoProcesando';
import FlitUploadBox from '../../../flit/FlitUploadBox';
import { flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle } from '../../../flit/flitPageKit';
import { COPY_COMUN, COPY_MASIVO, type ErrorSubida } from './copyMasivo';
import type { TipoMasivo } from './tiposMasivo';

export default function ZonaCargaExcel({ tipo, archivo, errorArchivo, subiendo, errorSubida, faltaCompania, onElegir, onCargar }: {
  tipo: TipoMasivo;
  archivo: File | null;
  errorArchivo: string | null;
  subiendo: boolean;
  errorSubida: ErrorSubida | null;
  faltaCompania: boolean;
  onElegir: (f: File) => void;
  onCargar: () => void;
}) {
  const copy = COPY_MASIVO[tipo];
  const aviso = errorArchivo ?? errorSubida?.texto ?? null;
  const razon = faltaCompania ? COPY_COMUN.elijaCompania : !archivo ? COPY_COMUN.elijaArchivo : null;
  const bloqueado = subiendo || razon !== null;
  return (
    <div className="space-y-3">
      <div className={subiendo ? 'pointer-events-none opacity-60' : undefined} aria-busy={subiendo}>
        <FlitUploadBox
          label={archivo?.name ?? copy.etiquetaCaja}
          state={errorArchivo || errorSubida?.accion === 'elegir' ? 'rejected' : archivo ? 'verified' : 'idle'}
          count={1}
          accept=".xlsx"
          hint={copy.hintCaja}
          describedBy={aviso ? 'masivo-aviso-archivo' : razon ? 'masivo-razon' : undefined}
          alcanzable
          onFile={(f) => { if (!subiendo) onElegir(f); }}
        />
      </div>
      {aviso && (
        <p id="masivo-aviso-archivo" role="alert" className="text-sm font-semibold" style={{ color: 'var(--flit-danger-text)' }}>{aviso}</p>
      )}
      {subiendo && <AvisoProcesando texto={COPY_COMUN.recibiendo} />}
      <div className="flex flex-wrap items-center justify-end gap-3">
        {razon && !subiendo && <p id="masivo-razon" className="min-w-0 flex-1 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{razon}</p>}
        {errorSubida?.accion === 'reintentar' && !subiendo && (
          <button type="button" className={`${flitBtnSecondary} w-full justify-center sm:w-auto`} style={flitBtnSecondaryStyle} onClick={onCargar}>
            Reintentar
          </button>
        )}
        <button
          type="button" className={`${flitBtnPrimary} w-full justify-center sm:w-auto`} style={flitBtnPrimaryStyle}
          aria-disabled={bloqueado || undefined} aria-describedby={razon ? 'masivo-razon' : undefined}
          onClick={() => { if (!bloqueado) onCargar(); }}
        >
          {subiendo ? 'Cargando…' : copy.botonCargar}
        </button>
      </div>
    </div>
  );
}
