// FLITO — la ranura viva de los dos modales de carga masiva SOAT / Impuestos
// (HU #12050 / #12051 / #12056).
//
// Los modales siguen SIN unificarse a propósito (Impuestos tiene el checkbox de marca de agua y
// SOAT no), pero lo que va entre el picker y los botones es la misma línea de vida en los dos:
// «Abriendo…» → contador (+ descartes) → error → progreso. Tenerla dos veces era garantía de que
// una de las dos se quedara atrás; y la regla de accesibilidad —UNA sola región `status` que
// aloje el conteo y el descarte juntos, para que el descarte no se anuncie huérfano— vale más si
// vive en un solo sitio.
//
// Este componente no decide nada: todo el texto sale de `lib/carga-masiva`.

import {
  textoAbriendoZip, textoContadorCargaMasiva, textoDescartadosZip, textoProgresoCarga,
  type SeleccionCarga,
} from '../../lib/carga-masiva';

export default function RanuraCargaMasiva({ seleccion, abriendo, errorValidacion, error, progreso }: {
  seleccion: SeleccionCarga;
  /** Nombres de los ZIP que se están leyendo; `null` = no se está leyendo nada. */
  abriendo: string[] | null;
  /** Tope pasado. Además del alert, pinta el contador en rojo: es el número que no cabe. */
  errorValidacion: string | null;
  /** Fallo del envío (413/504/…). No pinta el contador: lo que se eligió sí cabía. */
  error: string | null;
  progreso: { desde: number; total: number } | null;
}) {
  const descartados = textoDescartadosZip(seleccion);
  const textoProgreso = progreso ? textoProgresoCarga(progreso.desde, progreso.total) : null;

  return (
    <>
      {(abriendo || seleccion.items.length > 0) && (
        <div role="status" aria-live="polite" className="space-y-1 text-xs">
          {abriendo ? (
            <p style={{ color: 'var(--flit-text-muted)' }}>{textoAbriendoZip(abriendo)}</p>
          ) : (
            <>
              <p className={errorValidacion ? 'text-red-600' : ''}
                style={errorValidacion ? undefined : { color: 'var(--flit-text-muted)' }}>
                {textoContadorCargaMasiva(seleccion)}
              </p>
              {descartados && <p style={{ color: 'var(--flit-text-muted)' }}>{descartados}</p>}
            </>
          )}
        </div>
      )}
      {(errorValidacion || error) && <p role="alert" className="text-sm text-red-600">{errorValidacion ?? error}</p>}
      {progreso && textoProgreso && (
        <p role="status" aria-live="polite" className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
          {textoProgreso}
        </p>
      )}
    </>
  );
}
