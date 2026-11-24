import { AlertCircle } from 'lucide-react';
import FlitUploadBox from '../flit/FlitUploadBox';
import { FlitPillGroup, flitBtnSecondarySm, flitPillBtn, flitPillBtnClase } from '../flit/flitPageKit';
import {
  agregarArchivos, elegirAdjuntar, quitarArchivo, type BorradorSoporte,
} from '../../lib/drFlitSoporte';
import {
  ACCEPT_ADJUNTOS, errorDeArchivos, formatoTamano, textoRechazo, topeEnMb, type LimitesAdjuntos,
} from '../../lib/drFlitSoporteModelo';

// Dr. Flit — paso «Archivos» del asistente de soporte (HU #13807; anexo UX F5.4 F, F5.7, F5.9, F5.12–F5.14).
// Sí/No con radios nativos (cara de pill, empieza en «No»), `FlitUploadBox multiple`, avisos de descarte del
// cliente en `role="status"` y la lista con nombre, tamaño y «Quitar» (aria-label con el nombre). Los `File`
// viven en el almacén en memoria; el nombre solo se pinta aquí y en el resumen.

/** Contenedor del selector: el asistente enfoca su `<input type=file>` por aquí. */
export const ID_CAJA_ARCHIVOS = 'drflit-soporte-archivos-caja';
export const idQuitarArchivo = (i: number) => `drflit-soporte-quitar-${i}`;
const ID_ERROR = 'drflit-soporte-archivos-error';
const ID_AVISOS = 'drflit-soporte-archivos-avisos';
const ROTULO = 'mb-1 block text-[11px] font-semibold text-[color:var(--flit-text-primary)]';
const ERROR = 'flex items-start gap-1 break-words text-xs text-[color:var(--flit-danger-text)]';
const QUITAR = `${flitBtnSecondarySm} max-lg:h-11 shrink-0`;

export function PasoArchivos({ b, mostrar, limites, inactivo }: {
  b: BorradorSoporte;
  /** El error del paso se ve tras el primer «Siguiente» (o al volver por un rechazo del servidor). */
  mostrar: boolean;
  limites: LimitesAdjuntos;
  inactivo: boolean;
}) {
  const error = mostrar ? errorDeArchivos(b.adjuntar, b.adjuntos, limites) : null;
  // El error de una fila ya se lee en su «Quitar»; el del paso solo cuando no es de una fila.
  const errorPaso = error && !b.adjuntos.some((a) => a.rechazo) ? error : null;
  const lleno = b.adjuntos.length >= limites.maxArchivos;
  const describe = [errorPaso && ID_ERROR, b.avisosAdjuntos.length > 0 && ID_AVISOS].filter(Boolean).join(' ') || undefined;
  return (
    <div className="mt-4 flex min-w-0 flex-col gap-4">
      <fieldset className="min-w-0">
        <legend className={ROTULO}>¿Quiere adjuntar capturas o documentos?</legend>
        <FlitPillGroup>
          {([['si', 'Sí', true], ['no', 'No', false]] as const).map(([valor, etiqueta, si]) => (
            <label
              key={valor}
              className={`${flitPillBtnClase} cursor-pointer has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[color:var(--flit-border-focus)]`}
              style={{ ...flitPillBtn(b.adjuntar === si), textTransform: 'none' }}
            >
              <input
                type="radio"
                name="drflit-soporte-adjuntar"
                value={valor}
                checked={b.adjuntar === si}
                onChange={() => { if (!inactivo) elegirAdjuntar(si); }}
                aria-describedby={errorPaso && !b.adjuntar ? ID_ERROR : undefined}
                className="sr-only"
              />
              {etiqueta}
            </label>
          ))}
        </FlitPillGroup>
      </fieldset>

      {b.adjuntar && (
        <>
          {lleno ? (
            <p id={ID_CAJA_ARCHIVOS} tabIndex={-1} className="flit-focus rounded-md break-words text-sm text-flit-secondary">
              Ya tiene {limites.maxArchivos} archivos, el máximo. Quite uno para adjuntar otro.
            </p>
          ) : (
            <div id={ID_CAJA_ARCHIVOS} className="min-w-0">
              <FlitUploadBox
                label="Elegir archivos"
                hint={`PNG, JPG o PDF · hasta ${limites.maxArchivos} archivos de ${topeEnMb(limites.maxBytesArchivo)} cada uno`}
                state="idle"
                accept={ACCEPT_ADJUNTOS}
                multiple
                describedBy={describe}
                onFile={(f) => agregarArchivos([f])}
                onFiles={(fs) => agregarArchivos(fs)}
              />
            </div>
          )}
          {errorPaso && (
            <p id={ID_ERROR} className={ERROR}>
              <AlertCircle aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0">{errorPaso}</span>
            </p>
          )}
          <div id={ID_AVISOS} role="status" className="flex flex-col gap-1 empty:hidden">
            {b.avisosAdjuntos.map((t, i) => (
              <p key={i} className={ERROR}>
                <AlertCircle aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 [overflow-wrap:anywhere]">{t}</span>
              </p>
            ))}
          </div>
          {b.adjuntos.length > 0 && (
            <ul aria-label="Archivos adjuntos" className="min-w-0 rounded-flit-lg border border-flit-soft">
              {b.adjuntos.map((a, i) => {
                const idRechazo = `drflit-soporte-rechazo-${a.id}`;
                return (
                  <li
                    key={a.id}
                    data-rechazado={a.rechazo ? 'true' : undefined}
                    className="flex min-w-0 items-start justify-between gap-3 border-t border-flit-soft p-3 first:border-t-0"
                  >
                    <div className="min-w-0">
                      <p className="break-all text-sm text-flit-ink">{a.file.name}</p>
                      <p className="mt-0.5 text-xs text-flit-secondary">{formatoTamano(a.file.size)}</p>
                      {a.rechazo && (
                        <p id={idRechazo} className={`${ERROR} mt-1`}>
                          <AlertCircle aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
                          <span className="min-w-0">{textoRechazo(a.rechazo, limites)}</span>
                        </p>
                      )}
                    </div>
                    <button
                      id={idQuitarArchivo(i)}
                      type="button"
                      onClick={() => { if (!inactivo) quitarArchivo(a.id); }}
                      aria-disabled={inactivo || undefined}
                      aria-label={`Quitar ${a.file.name}`}
                      aria-describedby={a.rechazo ? idRechazo : undefined}
                      className={QUITAR}
                    >
                      Quitar
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/** Foco del paso (F5.14). Error: «Quitar» de la fila rechazada, si no el selector, si no el primer «Quitar». */
export function enfocarArchivos(
  b: BorradorSoporte, a: 'primerError' | 'primerCampo' | 'archivos' | 'quitar', i?: number,
): void {
  const caja = () => {
    const el = document.getElementById(ID_CAJA_ARCHIVOS);
    (el?.querySelector<HTMLElement>('input[type=file]') ?? el)?.focus();
  };
  if (a === 'quitar' && i !== undefined) {
    document.getElementById(idQuitarArchivo(i))?.focus();
    return;
  }
  if (a === 'archivos') {
    caja();
    return;
  }
  // «Corregir archivos» o «No» elegido: la pregunta Sí/No.
  if (a === 'primerCampo' || !b.adjuntar) {
    document.querySelector<HTMLElement>('input[name="drflit-soporte-adjuntar"]:checked')?.focus();
    return;
  }
  const rechazado = b.adjuntos.findIndex((x) => x.rechazo);
  if (rechazado >= 0) document.getElementById(idQuitarArchivo(rechazado))?.focus();
  else if (b.adjuntos.length === 0) caja();
  else document.getElementById(idQuitarArchivo(0))?.focus();
}
