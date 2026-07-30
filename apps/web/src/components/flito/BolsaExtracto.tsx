// Detalle del cliente: el consumo desglosado por OT y por concepto, y la tendencia del saldo
// (HU #11127 · AC2).
//
// No pide nada: recibe lo que ya cargó la página para el cliente y el periodo elegidos. El extracto
// y el libro salen de la misma tabla, así que cuadran por construcción —saldo = entradas − salidas—
// y volver a pedirlos aquí solo abriría la puerta a pintar dos cifras distintas de lo mismo.

import {
  CONCEPTO_BOLSA_LABEL, NIVEL_RIESGO_BOLSA_LABEL,
  type BolsaConRiesgo, type ConceptoBolsa, type ExtractoCliente, type LineaAgrupada,
  type MovimientoBolsaDto,
} from '@operaciones/shared-types';
import { etiquetaOrganismo, etiquetaPeriodo, pesos, TONO_NIVEL } from '../../lib/bolsas';
import { FlitCard, FlitEmpty, FlitTable, FlitTh, FlitTr } from '../flit/flitPageKit';
import Sparkline from '../flit/Sparkline';
import StatusChip from '../flit/StatusChip';

interface Props {
  bolsa: BolsaConRiesgo;
  extracto: ExtractoCliente | null;
  /** Libro del periodo, del más reciente al más antiguo (tal y como lo devuelve la API). */
  movimientos: MovimientoBolsaDto[];
  periodo: string;
}

export default function BolsaExtracto({ bolsa, extracto, movimientos, periodo }: Props) {
  // La tendencia se lee de izquierda a derecha, así que el libro se invierte: la API lo entrega del
  // más reciente al más antiguo porque eso es lo que quiere la TABLA, no el gráfico.
  const tendencia = [...movimientos].reverse().map((m) => m.saldoResultante);

  return (
    <div className="space-y-4">
      <FlitCard>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold" style={{ color: 'var(--flit-blue-text)' }}>
                {bolsa.companiaNombre}
              </h2>
              <StatusChip tone={TONO_NIVEL[bolsa.nivel]}>{NIVEL_RIESGO_BOLSA_LABEL[bolsa.nivel]}</StatusChip>
            </div>
            <p className="mt-2 text-3xl font-bold tabular-nums leading-none"
              style={{ color: bolsa.saldo <= 0 ? 'var(--flit-danger)' : 'var(--flit-text-primary)' }}>
              {pesos(bolsa.saldo)}
            </p>
            <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
              {bolsa.ultimaRecargaEn
                ? `Última recarga: ${pesos(bolsa.ultimaRecargaValor ?? 0)} el ${new Date(bolsa.ultimaRecargaEn).toLocaleDateString('es-CO')}.`
                : 'Todavía no ha recibido ninguna recarga.'}
            </p>
          </div>

          <dl className="flex gap-6 text-sm">
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>
                Entradas
              </dt>
              <dd className="mt-1 font-bold tabular-nums" style={{ color: 'var(--flit-success)' }}>
                {extracto ? pesos(extracto.totalEntradas) : '—'}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>
                Salidas
              </dt>
              <dd className="mt-1 font-bold tabular-nums" style={{ color: 'var(--flit-warning)' }}>
                {extracto ? pesos(extracto.totalSalidas) : '—'}
              </dd>
            </div>
          </dl>
        </div>

        <div className="mt-4">
          <p className="mb-1 text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
            Tendencia del saldo · {etiquetaPeriodo(periodo)}
          </p>
          {tendencia.length >= 2 ? (
            <>
              <Sparkline data={tendencia} className="h-16 w-full" />
              <p className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>
                {tendencia.length} movimiento(s): de {pesos(tendencia[0])} a {pesos(tendencia[tendencia.length - 1])}.
              </p>
            </>
          ) : (
            <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
              Hacen falta al menos dos movimientos en el periodo para dibujar una tendencia.
            </p>
          )}
        </div>
      </FlitCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <Desglose titulo="Consumo por organismo de tránsito"
          nota="Las recargas y los honorarios de FLIT —trámite digital y logística— no tienen OT: se agrupan aparte."
          lineas={extracto?.porOrganismo ?? []} etiqueta={etiquetaOrganismo} columna="Organismo" />
        <Desglose titulo="Consumo por concepto"
          nota="Los cinco conceptos que sella la liquidación. La entrada sin concepto es una recarga."
          lineas={extracto?.porConcepto ?? []}
          etiqueta={(c) => CONCEPTO_BOLSA_LABEL[c as ConceptoBolsa] ?? 'Recarga o ajuste sin concepto'}
          columna="Concepto" />
      </div>
    </div>
  );
}

function Desglose({ titulo, nota, lineas, etiqueta, columna }: {
  titulo: string;
  nota: string;
  lineas: LineaAgrupada[];
  etiqueta: (clave: string) => string;
  columna: string;
}) {
  // De mayor a menor consumo: el desglose se mira para saber en qué se fue el saldo, y eso es una
  // pregunta ordenada por importe, no por nombre.
  const orden = [...lineas].sort((a, b) => b.salidas - a.salidas);
  const totalSalidas = orden.reduce((s, l) => s + l.salidas, 0);

  return (
    <FlitCard>
      <h3 className="text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>{titulo}</h3>
      <p className="mb-3 mt-1 text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>{nota}</p>
      {orden.length === 0 ? (
        <FlitEmpty>Sin movimientos en el periodo.</FlitEmpty>
      ) : (
        <FlitTable>
          <thead>
            <tr>
              <FlitTh>{columna}</FlitTh>
              <FlitTh center>Entradas</FlitTh>
              <FlitTh center>Salidas</FlitTh>
              <FlitTh center>Movs.</FlitTh>
            </tr>
          </thead>
          <tbody>
            {orden.map((l) => (
              <FlitTr key={l.clave}>
                <td className="px-4 py-2 text-sm">{etiqueta(l.clave)}</td>
                <td className="px-4 py-2 text-right text-sm tabular-nums">
                  {l.entradas > 0 ? pesos(l.entradas) : '—'}
                </td>
                <td className="px-4 py-2 text-right text-sm font-semibold tabular-nums">
                  {l.salidas > 0 ? pesos(l.salidas) : '—'}
                </td>
                <td className="px-4 py-2 text-right text-sm tabular-nums">{l.movimientos}</td>
              </FlitTr>
            ))}
          </tbody>
          <tfoot>
            <FlitTr>
              <td className="px-4 py-2 text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
                Total consumido
              </td>
              <td />
              <td className="px-4 py-2 text-right text-sm font-bold tabular-nums" style={{ color: 'var(--flit-blue-text)' }}>
                {pesos(totalSalidas)}
              </td>
              <td />
            </FlitTr>
          </tfoot>
        </FlitTable>
      )}
    </FlitCard>
  );
}
