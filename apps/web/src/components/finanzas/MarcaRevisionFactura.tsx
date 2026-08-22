// Reporte de costos — la marca «pendiente de revisión» de una factura emitida (HU #11331, AC6).
//
// **Es una marca, NO un estado, y esa distinción es el criterio entero.** Una factura cuyo total no
// cuadra con lo que se esperaba sigue estando emitida: el documento existe ante la DIAN y existirá
// pase lo que pase. Convertir el descuadre en un estado —pintar «Descuadrada» en lugar de
// «Emitida»— haría desaparecer la primera mitad de la verdad, y quien concilia el cierre necesita
// las dos: que el documento está, y que hay que mirarlo.
//
// Por eso esto se pinta AL LADO del estado y nunca en su sitio, y por eso la propia pastilla se
// llama «Pendiente de revisión» y no «Error»: nadie tiene que deshacer nada, alguien tiene que
// comprobar una cifra.
//
// **Se pinta, no se calcula.** El servidor decide si hay descuadre al emitir (`revisionDeTotal`, en
// `facturacion.emision.service.ts`) y lo guarda en `siigo_facturas.requiere_revision`, que el
// reporte trae en cada fila. Recalcularlo en el navegador restando dos números de la pantalla daría
// otra respuesta: el total con el que se compara es la suma de los CONCEPTOS FACTURADOS, que desde
// que se eligen al enviar ya no coincide con el total de la liquidación a propósito.

import StatusChip from '../flit/StatusChip';

/** Lo que la marca significa, en una frase. Se usa como nombre accesible Y como `title`. */
export const TEXTO_REVISION =
  'Pendiente de revisión: el total de la factura no coincide con el de los conceptos facturados. '
  + 'La factura sigue emitida ante la DIAN.';

interface Props {
  /** `siigo_facturas.requiere_revision`, tal como llega en la fila del reporte. */
  requiereRevision: boolean;
}

export default function MarcaRevisionFactura({ requiereRevision }: Props) {
  // Nada que pintar —ni un hueco reservado— cuando el total cuadra, que es el caso normal: una
  // columna con un espacio en blanco por fila enseña a no mirar la columna.
  if (!requiereRevision) return null;

  return (
    // `role="note"` con el nombre completo: un `<span>` genérico no expone nombre accesible, así
    // que sin el rol el `aria-label` se perdería en la mayoría de lectores y la marca sería
    // información disponible solo para quien ve el color y puede parar el ratón encima.
    <span role="note" aria-label={TEXTO_REVISION} title={TEXTO_REVISION}
      data-testid="marca-revision-factura">
      {/* `warning` y no `danger`: el rojo del reporte está reservado a lo que salió mal —rechazada,
          falló al emitir—, y esto no salió mal, está por comprobar. */}
      <StatusChip tone="warning">Pendiente de revisión</StatusChip>
    </span>
  );
}
