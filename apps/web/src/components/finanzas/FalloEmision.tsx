// Reporte de costos — por qué falló la emisión de una factura, y qué hacer (HU #11331, AC5).
//
// **La pantalla no traduce ni un código de Siigo.** El texto que se lee aquí es
// `siigo_cola_facturacion.error_detalle`, y lo que hay guardado ahí es la `descripcionOperativa`
// del catálogo del servidor (`siigo.errors.ts`, vía `describirFallo()` en
// `facturacion.emision.service.ts`) ya saneada por `siigo.redaccion.ts`. Es decir: el mensaje llega
// TRADUCIDO. Un diccionario de códigos en el frontend sería una segunda copia de ese catálogo, y de
// dos copias siempre hay una que se queda vieja — con el agravante de que la que miente es la que
// se le enseña a quien tiene que arreglar la factura.
//
// El código crudo se muestra igualmente, pero DEBAJO y en pequeño: sirve para buscar en Siigo Nube
// o para pegarlo en un ticket, no para entender qué pasó. El criterio prohíbe que el mensaje crudo
// sea la única explicación, no que se pueda consultar.
//
// **«Qué hacer» sale del estado de la COLA, no del error.** Si la fila se reintenta sola o si ya se
// dio por perdida es una propiedad del trabajo pendiente —la cola—, y esa clasificación la hace el
// servidor: aquí solo se traduce a la frase que le sirve a quien mira, con las etiquetas que
// `@operaciones/shared-types` ya define para esos mismos estados.

import { SIIGO_COLA_ESTADO_ETIQUETA, type SiigoColaItem } from '@operaciones/shared-types';
import { fechaCorta } from './tiposFacturacion';

interface Props {
  /**
   * La fila de cola del trámite. `null` = el trámite no tiene trabajo registrado en la cola.
   *
   * No es lo mismo que «no falló», y por eso el componente lo dice en vez de callarse: una emisión
   * puede haber fallado por una vía que no pasó por la cola, y afirmar que no hay motivo cuando
   * nadie lo ha buscado es la clase de silencio que manda a alguien a mirar a Siigo sin saberlo.
   */
  cola: SiigoColaItem | null;
}

/**
 * Qué hacer con esta fila, según lo que la cola diga de ella.
 *
 * Los cuatro casos están cubiertos porque el `Record` obliga: si mañana se añade un estado de cola,
 * el compilador para aquí en vez de dejar un hueco en la única frase que dice si hay que actuar.
 */
const QUE_HACER: Record<SiigoColaItem['estado'], string> = {
  pendiente: 'Está en cola y saldrá sola. No hay que hacer nada.',
  enviado: 'El trabajo de la cola terminó. Lo que se vea arriba es el desenlace.',
  error: 'Se reintenta sola. Si el motivo es de datos, corrígelo antes del siguiente intento: '
    + 'reintentar sin cambiar nada devuelve el mismo error.',
  fallido_definitivo: 'No se reintenta sola. Corrige lo que dice el motivo y vuelve a enviarla a '
    + 'facturación electrónica desde el reporte, marcando la reactivación.',
};

export default function FalloEmision({ cola }: Props) {
  return (
    <section className="rounded-lg px-3 py-2" style={{ background: '#FBE4E2' }}>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide"
        style={{ color: 'var(--flit-danger-ink)' }}>
        Por qué falló la emisión
      </h3>

      {cola === null ? (
        <p style={{ color: 'var(--flit-text-primary)' }}>
          Este trámite no tiene trabajo registrado en la cola de emisión, así que aquí no hay motivo
          que mostrar. El recorrido completo está en la línea de tiempo del trámite.
        </p>
      ) : (
        <>
          <p style={{ color: 'var(--flit-text-primary)' }}>
            {cola.errorDetalle ?? 'La cola no guardó motivo de este fallo.'}
          </p>

          <p className="mt-1" style={{ color: 'var(--flit-text-secondary)' }}>
            <strong>{SIIGO_COLA_ESTADO_ETIQUETA[cola.estado]}.</strong> {QUE_HACER[cola.estado]}
          </p>

          {/* Los intentos, con su techo: «lleva 4» no dice nada sin saber que el quinto es el
              último. Y el último intento, no el próximo: la pregunta de quien abre esto es desde
              cuándo lleva así. */}
          <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
            Intentos: <strong className="tabular-nums">{cola.intentos}</strong> de{' '}
            <span className="tabular-nums">{cola.maxIntentos}</span>
            {' · '}Último intento: {fechaCorta(cola.ultimoIntentoAt)}
            {cola.estado === 'error' && ` · Próximo: ${fechaCorta(cola.proximoIntentoAt)}`}
          </p>

          {/* `text-secondary` y no `muted`, aunque «apagado» sea la intención: sobre el rojo pálido
              de esta tarjeta el tono muted mide 4,22 y no llega al 4,5:1 de la SC 1.4.3 (el
              secundario da 4,72). Lo que baja el peso de esta línea es el tamaño, no un gris que
              no se lee. */}
          {cola.errorCode && (
            <p className="mt-1 text-[11px]" style={{ color: 'var(--flit-text-secondary)' }}>
              Código de Siigo: {cola.errorCode}
            </p>
          )}
        </>
      )}
    </section>
  );
}
