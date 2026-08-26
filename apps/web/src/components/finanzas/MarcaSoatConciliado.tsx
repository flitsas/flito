// Reporte de costos — la marca «Conciliado · bolsa» de la celda de SOAT (HU #11681, Feature #11623).
//
// Componente propio y al lado de `CeldaFacturacion.tsx` por el mismo motivo que aquel: la pantalla
// que lo aloja ya está pegada al techo de líneas del repositorio, y esta marca tiene reglas propias
// —revelado por foco Y por puntero, texto accesible que no depende de ninguno de los dos, y NADA
// que pintar cuando el SOAT no está conciliado— que dentro de la tabla se leerían como ruido.
//
// Qué responde: «este SOAT ya se descontó de la bolsa al conciliar una boleta de pago externo, así
// que NO hay que volver a cobrarlo en el cierre». Es la diferencia entre cobrar dos veces y no
// cobrar, y por eso no puede quedarse en un color.

import { useId, useState } from 'react';
import { fechaCorta } from '../flit/columnasComunes';
import StatusChip from '../flit/StatusChip';

interface Props {
  /** `true` = el SOAT de esta fila ya se descontó de bolsa en una boleta conciliada (HU #11679). */
  conciliado: boolean;
  /** Referencia legible de la boleta ('BOL-000123'). El backend no expone su nombre de archivo. */
  referencia: string | null;
  /** Cuándo se selló la conciliación de ESTE SOAT, en ISO. */
  conciliadoEn: string | null;
}

/**
 * El detalle que se revela: de qué boleta salió y cuándo se selló.
 *
 * Se calcula aparte porque lo usan las DOS salidas —el globo que se ve y el nombre accesible que se
 * escucha—, y con el texto escrito dos veces bastaría con tocar uno para que quien navega con lector
 * de pantalla leyera una cosa distinta de la que se ve en pantalla.
 *
 * `referencia` en `null` no debería llegar nunca —el backend deriva `soatConciliado` de que HAYA
 * referencia—, pero si llegara, se dice: «conciliado sin boleta a la que ir» es exactamente el dato
 * que hay que poder ver, no uno que convenga esconder detrás de una cadena vacía.
 */
function detalleDe(referencia: string | null, conciliadoEn: string | null): string {
  const boleta = referencia === null ? 'Sin referencia de boleta' : `Boleta ${referencia}`;
  return conciliadoEn === null ? boleta : `${boleta} · ${fechaCorta(conciliadoEn)}`;
}

export default function MarcaSoatConciliado({ conciliado, referencia, conciliadoEn }: Props) {
  const id = useId();
  const [revelado, setRevelado] = useState(false);

  // Los hooks van ARRIBA del corte a propósito (`scan-rules-of-hooks`): el corte es lo último.
  //
  // Y el corte devuelve `null`, sin envoltorio ni hueco de reserva (AC2). Reservar el alto de la
  // marca «para que la tabla no salte al pasar el ratón» es la tentación evidente y es justo lo que
  // el criterio prohíbe: la fila sin conciliar tiene que verse EXACTAMENTE como antes de esta
  // historia. El salto no existe además, porque el globo se posiciona en absoluto y no empuja nada.
  if (!conciliado) return null;

  const detalle = detalleDe(referencia, conciliadoEn);

  return (
    // Envoltorio de bloque para que la marca caiga DEBAJO del valor y no a su derecha: la columna es
    // estrecha y, en línea, el chip empujaría el importe fuera de la rejilla de cifras. `justify-end`
    // porque toda la columna está alineada a la derecha.
    <span className="mt-1 flex justify-end">
      <span
        className="flit-focus relative inline-flex rounded"
        data-testid="marca-soat-conciliado"
        // Enfocable aunque no sea un control: es el único modo de que el detalle salga también por
        // teclado (AC1). Sin `tabIndex` la marca sería información accesible SOLO con ratón.
        tabIndex={0}
        // `note` + `aria-label`: un `<span>` genérico no expone nombre accesible, así que sin el rol
        // el `aria-label` se perdería en la mayoría de lectores. El nombre lleva el detalle COMPLETO,
        // que es lo que hace que esto no dependa ni del color ni de poder pasar el puntero.
        role="note"
        aria-label={`SOAT conciliado con la bolsa. ${detalle}.`}
        onMouseEnter={() => setRevelado(true)}
        onMouseLeave={() => setRevelado(false)}
        onFocus={() => setRevelado(true)}
        onBlur={() => setRevelado(false)}
        // WCAG 1.4.13: lo que aparece al enfocar o al apuntar tiene que poder descartarse sin mover el
        // foco. El globo tapa la celda de al lado mientras está abierto.
        onKeyDown={(e) => { if (e.key === 'Escape') setRevelado(false); }}
      >
        {/* El texto va escrito, no insinuado por el tono: «Conciliado · bolsa» se lee igual con o sin
            percepción del color, que es la mitad del criterio. */}
        <StatusChip tone="active">Conciliado · bolsa</StatusChip>

        {revelado && (
          <span
            id={id}
            // `aria-hidden` y no `role="tooltip"` + `aria-describedby`: el detalle ya viaja ENTERO en
            // el nombre accesible de la marca, disponible sin hover y sin foco. Exponerlo otra vez al
            // revelarse haría que un lector de pantalla leyera la misma frase dos veces seguidas, y
            // encima solo a quien pudiera provocar el revelado —que es la dependencia que este
            // criterio viene a quitar—. Aquí el globo es la versión VISUAL de algo ya dicho.
            aria-hidden="true"
            // Absoluto: la fila no cambia de alto al revelar, así que la tabla no se mueve bajo el
            // puntero. `whitespace-nowrap` porque la celda es estrecha y el detalle es una sola línea.
            className="absolute right-0 top-full z-30 mt-1 whitespace-nowrap rounded-lg border bg-white px-2.5 py-1.5 text-left text-xs font-normal shadow-lg"
            style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}
          >
            {detalle}
          </span>
        )}
      </span>
    </span>
  );
}
