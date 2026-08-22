// Reporte de costos — la marca «pendiente de revisión» de una factura emitida (HU #11331, AC6).
//
// **Es una marca, NO un estado, y esa distinción es el criterio entero.** Una factura señalada para
// revisión sigue estando emitida: el documento existe ante la DIAN y existirá pase lo que pase.
// Convertir el motivo en un estado —pintar «Descuadrada» en lugar de «Emitida»— haría desaparecer
// la primera mitad de la verdad, y quien concilia el cierre necesita las dos: que el documento
// está, y que hay que mirarlo.
//
// Por eso esto se pinta AL LADO del estado y nunca en su sitio, y por eso la propia pastilla se
// llama «Pendiente de revisión» y no «Error»: nadie tiene que deshacer nada, alguien tiene que
// comprobar algo.
//
// **Se pinta, no se calcula.** El servidor decide si hay que revisarla y lo guarda en
// `siigo_facturas.requiere_revision`, que el reporte trae en cada fila. Recalcularlo en el navegador
// restando dos números de la pantalla daría otra respuesta: el total con el que se compara es la
// suma de los CONCEPTOS FACTURADOS, que desde que se eligen al enviar ya no coincide con el total de
// la liquidación a propósito.
//
// **Y EL MOTIVO TAMPOCO SE INTERPRETA — se enseña entero.** La frase de `revisionMotivo` la escribe
// el servidor y tiene tres autores distintos: el descuadre de totales (`revisionDeTotal`, que ya
// lleva dentro los dos totales y la diferencia, que es lo que el AC6 pide leer), la reconciliación
// que no puede concluir, y la resolución a mano de una persona. Por eso aquí no hay rótulo fijo
// encima ni troceo del texto para sacarle cifras: un encabezado que dijera «diferencia de totales»
// sería falso en dos de los tres casos, y en una pantalla de control un título equivocado manda a
// buscar una avería inexistente con más eficacia que un dato ausente. El único encabezado es la
// propia pastilla, que dice lo que vale para los tres: hay algo que comprobar.

import StatusChip from '../flit/StatusChip';

/** Lo que la marca significa, en una frase. Se usa como nombre accesible Y como `title`. */
export const TEXTO_REVISION =
  'Pendiente de revisión: FLITO encontró algo que hay que comprobar en esta factura. '
  + 'La factura sigue emitida ante la DIAN.';

/**
 * Qué se lee cuando la marca está puesta y el motivo es `null`.
 *
 * Existe porque el hueco sería peor que la marca: quien abre el detalle viene justo a preguntar por
 * qué, y encontrarse la pastilla sola se lee como una pantalla a medio cargar. Se dice que no quedó
 * escrito —que es lo único que se sabe— y adónde ir, en lugar de inventar una causa.
 */
export const TEXTO_REVISION_SIN_MOTIVO =
  'No quedó escrito por qué. La marca está puesta, así que hay que comprobar la factura contra los '
  + 'conceptos facturados en Siigo Nube; el recorrido completo está en la línea de tiempo del '
  + 'trámite.';

interface Props {
  /** `siigo_facturas.requiere_revision`, tal como llega en la fila del reporte. */
  requiereRevision: boolean;
  /**
   * La frase del servidor (`FacturacionTramite.revisionMotivo`), o `null` si no quedó ninguna.
   *
   * **`undefined` no es lo mismo que `null`, y esa diferencia es lo que separa la fila del
   * detalle.** `undefined` = no se pide el párrafo: es la fila del reporte, que no recibe el motivo
   * —doscientas filas por página no pueden llevar un párrafo cada una— y solo lleva la pastilla.
   * `null` = sí se pide, pero el servidor no escribió motivo, y entonces se dice eso mismo.
   */
  motivo?: string | null;
}

export default function MarcaRevisionFactura({ requiereRevision, motivo }: Props) {
  // Nada que pintar —ni un hueco reservado— cuando no hay nada que revisar, que es el caso normal:
  // una columna con un espacio en blanco por fila enseña a no mirar la columna.
  if (!requiereRevision) return null;

  const pastilla = (
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

  // La fila: solo la marca. El `<span>` se queda suelto porque la celda lo mete dentro de un botón,
  // donde un `<section>` con párrafo no cabría ni tendría sentido.
  if (motivo === undefined) return pastilla;

  return (
    <section className="rounded-lg px-3 py-2" data-testid="motivo-revision-factura"
      // El mismo fondo que la pastilla `warning`, para que el bloque se lea como su ampliación y no
      // como un aviso aparte que compite con el fallo de emisión, que sí es rojo.
      style={{ background: '#FDE8E3' }}>
      {pastilla}
      {/* Tal cual la escribió el servidor. Si es `null`, lo que se dice es que no quedó escrita. */}
      <p className="mt-1.5" style={{ color: 'var(--flit-text-primary)' }}>
        {motivo ?? TEXTO_REVISION_SIN_MOTIVO}
      </p>
    </section>
  );
}
