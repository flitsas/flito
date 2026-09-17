// Reporte de costos — la celda de un honorario con su origen y su diferencia documental (HU #12655).
//
// Trámite digital y logística pintan el importe (`Monto`, sin cambio) y, DEBAJO, un renglón con
// hasta dos chips: de dónde salió el valor («Documento» / «Tarifa», tono neutral: informa, no pide
// nada) y, si el comprobante no cuadra con la tarifa, la diferencia con su signo («Difiere de tarifa
// +$5.000», warning: la única llamada de la celda) o su constancia («Diferencia aceptada +$15.000»,
// neutral). Servicios adicionales solo lleva el segundo: el catálogo siempre manda y no hay origen.
//
// Va en archivo propio por lo mismo que `MarcaSoatConciliado`: la tabla está pegada al techo de
// líneas, y la marca tiene reglas propias —revelado por foco Y por puntero, nombre accesible que no
// depende de ninguno de los dos, y NADA que pintar sin importe—. Es el MISMO patrón de aquella
// marca (`role="note"` + `tabIndex=0` + `aria-label` + globo `aria-hidden`): cero patrones nuevos.
//
// Qué NO decide: el importe. En trámite digital y logística el API ya manda el documental
// (`COALESCE`); en servicios adicionales manda Σ catálogo. Aquí solo se dice de dónde vino.

import { useState } from 'react';
import StatusChip from '../flit/StatusChip';
import Monto from './Monto';
import type { Falta, Fila } from './tiposReporteCostos';
import {
  conceptoMarcable, origenDe, textoDiferencia, textoOrigen, valorDocumentalDe, type ChipDiferencia, type ConceptoDocumental,
} from '../../lib/diferenciaDocumental';

/** La marca de diferencia: se ve el chip, se escucha el nombre completo, se revela el globo. */
function MarcaDiferencia({ chip }: { chip: ChipDiferencia }) {
  const [revelado, setRevelado] = useState(false);
  return (
    <span
      className="flit-focus relative inline-flex rounded"
      data-testid="marca-diferencia"
      tabIndex={0}
      role="note"
      aria-label={chip.accesible}
      onMouseEnter={() => setRevelado(true)}
      onMouseLeave={() => setRevelado(false)}
      onFocus={() => setRevelado(true)}
      onBlur={() => setRevelado(false)}
      // WCAG 1.4.13: lo revelado se descarta sin mover el foco.
      onKeyDown={(e) => { if (e.key === 'Escape') setRevelado(false); }}
    >
      <StatusChip tone={chip.tono}>{chip.texto}</StatusChip>
      {revelado && (
        <span aria-hidden="true"
          className="absolute right-0 top-full z-30 mt-1 whitespace-nowrap rounded-lg border bg-white px-2.5 py-1.5 text-left text-xs font-normal shadow-lg"
          style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>
          {chip.globo}
        </span>
      )}
    </span>
  );
}

/**
 * El segundo renglón de la celda: origen y diferencia, alineados a la derecha como el importe, y
 * que pueden envolver a un tercero (nunca `whitespace-nowrap` en la celda entera). `null` cuando
 * el concepto no es marcable en esta fila (AC3: `origenes.<concepto>` en null, aunque haya
 * comprobante) o no hay nada que decir.
 */
export function ChipsDocumentales({ fila, concepto }: { fila: Fila; concepto: ConceptoDocumental }) {
  if (!conceptoMarcable(fila, concepto)) return null;
  const origen = textoOrigen(origenDe(fila, concepto));
  const diferencia = textoDiferencia(concepto, valorDocumentalDe(fila, concepto));
  if (!origen && !diferencia) return null;
  return (
    <span className="mt-1 flex flex-wrap justify-end gap-1">
      {origen && <StatusChip tone="neutral">{origen}</StatusChip>}
      {diferencia && <MarcaDiferencia chip={diferencia} />}
    </span>
  );
}

/**
 * Trámite digital y logística. Sin importe (`No configurado`, `Autogestiona`, `—`) la celda es la
 * de siempre y sin chips: el origen solo acompaña a un importe (regla 2.1-5 del slim).
 */
export default function CeldaHonorario({ fila, concepto, valor, falta }: {
  fila: Fila; concepto: 'tramiteDigital' | 'logistica'; valor: number | null; falta: Falta | undefined;
}) {
  return (
    <td className="px-3 py-2 text-right tabular-nums">
      <Monto v={valor} falta={falta} />
      {valor !== null && <ChipsDocumentales fila={fila} concepto={concepto} />}
    </td>
  );
}
