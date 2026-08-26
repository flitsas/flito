// Reporte de costos — la celda «Factura DIAN» de cada fila (HU #11337, ampliada por la #11331).
//
// Componente propio, minúsculo, y aun así separado: la pantalla que lo aloja está pegada al techo
// de líneas del repositorio y la celda ha crecido dos veces ya. Es más barato nacer fuera que salir
// después.
//
// LO QUE LA CELDA AFIRMA, Y DE DÓNDE LO SACA (AC3 de la HU #11331)
//
//   · **El estado sale de la FILA, no de la ficha.** La consulta de fichas
//     (`/siigo/facturacion/tramites`) es un lote aparte que puede fallar sin tumbar el reporte, y
//     antes la celda lo tomaba como fuente principal: cuando ese lote fallaba, la columna entera se
//     pintaba igual que los trámites que nunca se enviaron. **Un fallo dibujado como ausencia**, que
//     es la afirmación más cara que puede hacer una pantalla de control, porque no parece un fallo:
//     parece trabajo que no existe. El reporte manda `estadoFacturacion` en CADA fila y no falla
//     aparte, así que es él quien pinta. La ficha solo enriquece: el motivo del rechazo en el título.
//
//   · **«Nunca enviado» se dice, no se insinúa con una raya.** Antes, `no_enviado` era un guion.
//     Un guion en una tabla se lee como «no hay dato», que es exactamente de lo que hay que
//     distinguirlo: «Sin enviar» es una afirmación sobre el trámite, y además usa el mismo lenguaje
//     visual —una pastilla— que el resto de estados de la pantalla, que es lo que el criterio pide.
//
//   · **El número de la factura va en la fila.** Emitida sin número obligaba a abrir el detalle para
//     copiar un dato de una línea. Sale de la ficha si está y de la fila si no; las dos las escribe
//     el servidor sobre LA MISMA factura, la que manda para ese trámite.

import { SIIGO_ESTADO_REPORTE_ETIQUETA, type SiigoEstadoReporte } from '@operaciones/shared-types';
import StatusChip from '../flit/StatusChip';
import MarcaRevisionFactura from './MarcaRevisionFactura';
import { TONO_CHIP_ESTADO, type FacturacionTramite } from './tiposFacturacion';

interface Props {
  /** `undefined` = este trámite no tiene factura. NO significa que la carga fallara. */
  ficha: FacturacionTramite | undefined;
  /** El estado que el reporte trae en la fila. Es el que pinta: siempre está y nunca falla aparte. */
  estadoFila: SiigoEstadoReporte;
  /** El número de la factura según la fila del reporte. `null` mientras no exista documento. */
  numeroFila: string | null;
  /** `siigo_facturas.requiere_revision` de la fila (AC6). Se pinta; no se recalcula aquí. */
  requiereRevision: boolean;
  /** Abre el detalle. Se ofrece SIEMPRE: el detalle explica también los estados sin documento. */
  onAbrir: () => void;
}

export default function CeldaFacturacion({
  ficha, estadoFila, numeroFila, requiereRevision, onAbrir,
}: Props) {
  // La ficha gana cuando existe: trae el pronunciamiento de la DIAN, que es más específico. Cuando
  // no existe manda la fila, que siempre está. Nunca se cae a «no hay nada»: eso era el fallo.
  const estado = ficha?.estado ?? estadoFila;
  const numero = ficha?.numero ?? numeroFila;
  const necesitaAtencion = estado === 'rechazado' || estado === 'fallido';

  return (
    <button
      type="button"
      onClick={onAbrir}
      className="flit-focus inline-flex flex-col items-center gap-1"
      // El título adelanta lo esencial sin abrir nada: en una tabla de doscientas filas, obligar a
      // abrir un modal por fila para saber por qué falló es hacer doscientos clics para un informe.
      title={necesitaAtencion && ficha?.motivo
        ? ficha.motivo
        : `${SIIGO_ESTADO_REPORTE_ETIQUETA[estado]} — ver detalle`}
    >
      <span className="inline-flex items-center gap-1.5">
        <StatusChip tone={TONO_CHIP_ESTADO[estado]}>{SIIGO_ESTADO_REPORTE_ETIQUETA[estado]}</StatusChip>
        {/* Un rechazo sin motivo consultado todavía se marca, para que no parezca sin causa. */}
        {ficha?.motivoPendiente && (
          <span className="text-[10px]" style={{ color: 'var(--flit-text-muted)' }}
            title="El motivo aún no se ha podido consultar">?</span>
        )}
      </span>

      {/* Debajo y en pequeño: identifica el documento sin competir con el estado, que es lo que se
          lee al recorrer la columna de arriba abajo. */}
      {numero && (
        <span className="text-[11px] tabular-nums" style={{ color: 'var(--flit-text-secondary)' }}>
          Factura {numero}
        </span>
      )}

      {/* AC6 — la marca va JUNTO al estado, nunca en su lugar: la factura sigue emitida. */}
      <MarcaRevisionFactura requiereRevision={requiereRevision} />
    </button>
  );
}
