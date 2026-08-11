// Reporte de costos — la acción «Enviar a facturación» de una fila, y su porqué (HU #11329).
//
// **Un botón inhabilitado no es alcanzable, así que el motivo va en un control aparte.** `disabled`
// saca el botón del orden de tabulación: un `title` con la causa es invisible para teclado y para
// lector de pantalla. Por eso el AC4 se resuelve con DOS elementos —el botón apagado, que comunica
// «aquí no», y un «¿Por qué no?» enfocable, que comunica el porqué—. Es el mismo reparto que la
// pantalla ya hace con «Liquidar» inhabilitado y el texto «Falta: …» al lado.
//
// **Cada motivo es un `<li>` con una frase completa**, con el texto que devolvió el servidor palabra
// por palabra. Un lector de pantalla los anuncia «lista de 2 elementos, elemento 1…», que es
// literalmente el «uno por uno» del AC4. Nada de motivos concatenados con comas ni escondidos en un
// `title`, y nada de redactar aquí una segunda versión del diagnóstico.

import { useState } from 'react';
import type { ElegibilidadTramite } from '@operaciones/shared-types';
import { flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondarySm } from '../flit/flitPageKit';

interface Props {
  tramiteId: string;
  idFlit: string;
  /** El veredicto del servidor. `undefined` = todavía no se sabe; nunca significa «sí». */
  veredicto: ElegibilidadTramite | undefined;
  /** La consulta de elegibilidad está en curso: la acción nace inhabilitada, no se habilita luego. */
  cargando: boolean;
  /** La consulta falló. En vez del porqué se ofrece el mismo reintento que la tarjeta. */
  error: boolean;
  onReintentar: () => void;
  onEnviar: () => void;
}

const SECUNDARIO = { borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' } as const;

export default function AccionEnviarFactura({
  tramiteId, idFlit, veredicto, cargando, error, onReintentar, onEnviar,
}: Props) {
  const [abierto, setAbierto] = useState(false);
  const elegible = veredicto?.elegible === true;
  const motivos = veredicto?.motivos ?? [];
  const idMotivos = `motivos-envio-${tramiteId}`;

  return (
    <>
      <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle}
        disabled={!elegible}
        // El texto visible se repite en 50 filas; el nombre accesible tiene que distinguirlas,
        // igual que ya hace la casilla de selección.
        aria-label={`Enviar ${idFlit} a facturación electrónica`}
        onClick={onEnviar}>
        Enviar a facturación
      </button>

      {error && (
        <button type="button" className={flitBtnSecondarySm} style={SECUNDARIO} onClick={onReintentar}>
          Reintentar
        </button>
      )}

      {!error && !cargando && !elegible && motivos.length > 0 && (
        <button type="button" className={flitBtnSecondarySm} style={SECUNDARIO}
          aria-expanded={abierto} aria-controls={idMotivos}
          aria-label={`Por qué ${idFlit} no se puede enviar a facturación electrónica`}
          // Sin petición: el veredicto y sus motivos ya están en la caché de la vista.
          onClick={() => setAbierto((v) => !v)}>
          ¿Por qué no?
        </button>
      )}

      <ul id={idMotivos} hidden={!abierto} className="w-full list-disc pl-4 text-[11px]"
        style={{ color: 'var(--flit-text-secondary)' }}>
        {motivos.map((m) => <li key={m.motivo}>{m.detalle}</li>)}
      </ul>
    </>
  );
}
