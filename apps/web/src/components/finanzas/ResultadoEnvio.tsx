// Envío a facturación electrónica — cómo se leen N resultados sin que sea un muro (HU #11329).
//
// Vive aparte de `DialogoEnvioFacturacion` a propósito: son dos responsabilidades con ritmos de
// cambio distintos. El diálogo es el ciclo de la petición —fases, errores, permisos—; esto es la
// presentación de un catálogo que va a crecer (cada desenlace nuevo de `SIIGO_RESULTADOS_ENVIO` se
// pinta aquí). Juntos, cada retoque de copy obligaría a leer la lógica del `POST`.
//
// **Encabezado con tres números, cuerpo agrupado por desenlace, y dentro de cada grupo el detalle
// por trámite** (AC5). Ningún grupo con cero se pinta. Y el resultado no se resume en un mensaje:
// quien envió cincuenta trámites necesita saber cuáles entraron y cuáles no, uno a uno.

import type { RefObject } from 'react';
import {
  SIIGO_RESULTADO_ENVIO_ETIQUETA, SIIGO_RESULTADO_ENVIO_EXPLICACION,
  type SiigoEnvioTramite, type SiigoResultadoEnvio, type SiigoResumenEnvio,
} from '@operaciones/shared-types';
import StatusChip, { type ChipTone } from '../flit/StatusChip';
import { flitBtnSecondarySm } from '../flit/flitPageKit';

/**
 * El orden: **lo que exige que alguien actúe va arriba.** El éxito no se lee; se comprueba de un
 * vistazo en el encabezado.
 */
const ORDEN: readonly SiigoResultadoEnvio[] = [
  'error', 'no_elegible', 'fallido_definitivo', 'encolado', 'reactivado', 'ya_en_cola', 'ya_enviado',
];

/**
 * `error` y `no_elegible` **no se leen igual**: uno es que el sistema falló al registrar ese
 * trámite, el otro que el servidor lo revisó y no procede. Se separan en tres ejes a la vez —tono,
 * texto y tener o no botón de reintento—, porque el color solo no puede cargar con la diferencia
 * (regla 12): quien no distingue rojo de gris lee «No se pudo encolar» frente a «No se puede
 * facturar todavía» y entiende lo mismo.
 */
const TONO: Record<SiigoResultadoEnvio, ChipTone> = {
  encolado: 'active',
  reactivado: 'active',
  ya_en_cola: 'neutral',
  ya_enviado: 'neutral',
  fallido_definitivo: 'danger',
  no_elegible: 'draft',
  error: 'danger',
};

/** Lo que pide acción nace abierto; la repetición inocua, plegada. */
const ABIERTO: Record<SiigoResultadoEnvio, boolean> = {
  error: true, no_elegible: true, fallido_definitivo: true, encolado: true, reactivado: true,
  ya_en_cola: false, ya_enviado: false,
};

interface Props {
  items: SiigoEnvioTramite[];
  /** Los tres números salen del `resumen` de la respuesta: no se recalculan (`resumirEnvio` existe
   *  precisamente para que la pantalla y el servidor no cuenten distinto). */
  resumen: SiigoResumenEnvio;
  idFlitDe: (tramiteId: string) => string;
  /** El servidor exige `reactivar` por separado; ofrecer un botón que devolverá 403 es lo que el
   *  AC4 prohíbe. */
  puedeReactivar: boolean;
  onReenviar: (tramiteIds: string[], reactivar: boolean) => void;
  encabezadoRef: RefObject<HTMLHeadingElement>;
}

export default function ResultadoEnvio({
  items, resumen, idFlitDe, puedeReactivar, onReenviar, encabezadoRef,
}: Props) {
  const conErrores = items.filter((i) => i.resultado === 'error');
  const perdidos = items.filter((i) => i.resultado === 'fallido_definitivo');

  return (
    <div className="space-y-3 text-sm">
      {/* Al pasar de «enviando» a «resultado» el contenido cambia entero bajo el mismo diálogo, así
          que el foco viene aquí: quien navega con teclado se quedaría si no en un botón que ya no
          significa lo mismo. */}
      <h3 ref={encabezadoRef} tabIndex={-1} className="font-semibold"
        style={{ color: 'var(--flit-text-primary)' }}>
        {resumen.encolados} enviados a la cola · {resumen.yaEstaban} ya estaban ·{' '}
        {resumen.rechazados} no se pudieron enviar
      </h3>

      {ORDEN.map((r) => {
        const grupo = items.filter((i) => i.resultado === r);
        if (grupo.length === 0) return null;
        return (
          // El `open` va sin estado propio: React no reescribe un atributo cuyo valor no cambia
          // entre renders, así que plegar o desplegar a mano se respeta. `<details>` y no un
          // acordeón propio: el navegador ya resuelve abrir, cerrar y teclado.
          <details key={r} {...(ABIERTO[r] ? { open: true } : {})}
            className="rounded-lg border px-3 py-2" style={{ borderColor: 'var(--flit-border-soft)' }}>
            <summary className="flit-focus flex cursor-pointer list-none items-center gap-2">
              <StatusChip tone={TONO[r]}>{SIIGO_RESULTADO_ENVIO_ETIQUETA[r]}</StatusChip>
              <span className="tabular-nums" style={{ color: 'var(--flit-text-secondary)' }}>
                ({grupo.length})
              </span>
            </summary>

            <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
              {SIIGO_RESULTADO_ENVIO_EXPLICACION[r]}
            </p>

            {r === 'no_elegible' ? (
              <ul className="mt-2 space-y-2">
                {grupo.map((i) => (
                  <li key={i.tramiteId}>
                    <span className="font-semibold">{idFlitDe(i.tramiteId)}</span>
                    {/* Los motivos del servidor, uno por línea y palabra por palabra (AC4). */}
                    <ul className="list-disc pl-5 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
                      {i.motivos.map((m) => <li key={m.motivo}>{m.detalle}</li>)}
                    </ul>
                  </li>
                ))}
              </ul>
            ) : r === 'error' ? (
              <ul className="mt-2 space-y-1 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
                {grupo.map((i) => (
                  <li key={i.tramiteId}>
                    <span className="font-semibold">{idFlitDe(i.tramiteId)}</span>
                    {i.detalle ? ` — ${i.detalle}` : ''}
                  </li>
                ))}
              </ul>
            ) : (
              <Identificadores ids={grupo.map((i) => idFlitDe(i.tramiteId))} />
            )}

            {r === 'error' && (
              <button type="button" className={`${flitBtnSecondarySm} mt-2`} style={SECUNDARIO}
                onClick={() => onReenviar(conErrores.map((i) => i.tramiteId), false)}>
                Reintentar {conErrores.length} que {conErrores.length === 1 ? 'falló' : 'fallaron'}
              </button>
            )}

            {r === 'fallido_definitivo' && puedeReactivar && (
              <button type="button" className={`${flitBtnSecondarySm} mt-2`} style={SECUNDARIO}
                onClick={() => onReenviar(perdidos.map((i) => i.tramiteId), true)}>
                Volver a intentar los {perdidos.length} dados por perdidos
              </button>
            )}
          </details>
        );
      })}
    </div>
  );
}

const SECUNDARIO = { borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' } as const;

/** Identificadores en fila. Son texto, no controles: sin `role` y sin `tabIndex`. */
function Identificadores({ ids }: { ids: string[] }) {
  return (
    <div className="mt-2 flex max-h-40 flex-wrap gap-1 overflow-y-auto">
      {ids.map((id) => (
        <span key={id} className="rounded-[999px] px-2 py-0.5 text-xs"
          style={{ background: 'var(--flit-bg-app)', color: 'var(--flit-text-secondary)' }}>
          {id}
        </span>
      ))}
    </div>
  );
}
