// FLITO Conciliación — la tabla de cuadre (HU #11680, AC3).
//
// Una fila por línea del Excel, con las cinco columnas que el AC pide y el motivo debajo del chip.
// Tres decisiones que no son de estilo:
//
//   · **El motivo es TEXTO estático, no un tooltip ni un «ver más».** El AC3 dice «muestra su
//     motivo»: un tooltip no se muestra, se pide. Y con 500 filas, pedirlo 500 veces no es una
//     pantalla, es un castigo. Por lo mismo las filas no son enfocables y no tienen ningún control
//     dentro: esconder el motivo detrás de un clic añadiría 500 paradas de tabulador.
//   · **La placa sale del SOAT cruzado, y el Excel no la trae**, así que hay filas que no pueden
//     tenerla. Nunca se deja la celda vacía ni con un guion: dice «Sin identificar» o «N SOAT
//     posibles», que es lo que de verdad pasa. Igual en VALOR SOAT, donde tampoco se pinta «$ 0».
//   · **El filtro «Solo las que no cuadran» tiene `aria-pressed`** y no es decoración: con 500
//     líneas y 3 malas, encontrarlas a ojo no es viable.

import { useEffect, useState } from 'react';
import { EstadoBoleta, ResultadoCruce, type BoletaDetalleDto } from '@operaciones/shared-types';
import { pesos } from '../../../lib/bolsas';
import {
  ETIQUETA_RESULTADO, NOTA_YA_DESCONTADO, TONO_RESULTADO, motivoDeLinea, textoContador, textoPlaca,
  textoValorSoat,
} from '../../../lib/conciliacion';
import StatusChip from '../../flit/StatusChip';
import {
  FlitCard, FlitEmpty, FlitPillButton, FlitPillGroup, FlitTable, FlitTh, FlitTr,
} from '../../flit/flitPageKit';

const MUTED = { color: 'var(--flit-text-muted)' } as const;
const SECUNDARIO = { color: 'var(--flit-text-secondary)' } as const;

export default function TablaCuadre({ boleta }: { boleta: BoletaDetalleDto }) {
  const [soloMalas, setSoloMalas] = useState(false);
  const conciliada = boleta.estado === EstadoBoleta.CONCILIADA;
  const sinCuadrar = boleta.sinCuadrar;

  // Si un re-cruce resuelve la última línea mala, el filtro deja de tener sentido: se quita solo en
  // vez de dejar la tabla vacía con un vacío que ya no explica nada.
  useEffect(() => { if (sinCuadrar === 0) setSoloMalas(false); }, [sinCuadrar]);

  const lineas = soloMalas
    ? boleta.lineas.filter((l) => l.resultado !== ResultadoCruce.OK)
    : boleta.lineas;

  return (
    <FlitCard>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        {/* El contador es la ÚNICA región viva de esta superficie: un re-cruce lo anuncia sin que
            haya que ir a buscarlo. El texto bloqueante de arriba dice el mismo número, pero no se
            anuncia por su cuenta para no leer dos regiones encima de la otra. */}
        <p role="status" aria-live="polite" className="text-sm font-semibold"
          style={{ color: 'var(--flit-text-primary)' }}>
          {textoContador(boleta.filas, sinCuadrar, conciliada)}
        </p>
        {sinCuadrar > 0 && (
          <FlitPillGroup>
            <FlitPillButton active={!soloMalas} pressed={!soloMalas} onClick={() => setSoloMalas(false)}>
              Todas las líneas · {boleta.filas}
            </FlitPillButton>
            <FlitPillButton active={soloMalas} pressed={soloMalas} onClick={() => setSoloMalas(true)}>
              Solo las que no cuadran · {sinCuadrar}
            </FlitPillButton>
          </FlitPillGroup>
        )}
      </div>

      {lineas.length === 0 ? (
        <FlitEmpty>
          <p className="font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
            Ya no queda ninguna línea sin cuadrar.
          </p>
          <button
            type="button"
            className="flit-focus mt-3 rounded-[999px] border bg-white px-4 py-1.5 text-xs font-medium"
            style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}
            onClick={() => setSoloMalas(false)}
          >
            Ver todas las líneas
          </button>
        </FlitEmpty>
      ) : (
        // `label` no es opcional en la práctica: sin él, la región de scroll de la tabla queda
        // anunciada sin nombre cuando desborda en horizontal.
        <FlitTable label={`Cuadre de la boleta ${boleta.referencia}`}>
          <thead>
            <tr>
              <FlitTh>Fila</FlitTh>
              <FlitTh>Número de póliza</FlitTh>
              <FlitTh>Placa</FlitTh>
              <FlitTh>Valor boleta</FlitTh>
              <FlitTh>Valor SOAT</FlitTh>
              <FlitTh>Resultado</FlitTh>
            </tr>
          </thead>
          <tbody>
            {lineas.map((linea) => {
              const placa = textoPlaca(linea);
              const valorSoat = textoValorSoat(linea);
              const motivo = motivoDeLinea(linea, boleta.companiaNombre);
              return (
                <FlitTr key={linea.id}>
                  <td className="px-4 py-3 text-sm tabular-nums" style={SECUNDARIO}>{linea.filaNumero}</td>
                  {/* Tabular: son 16 dígitos que se comparan a ojo contra el Excel. */}
                  <td className="px-4 py-3 text-sm tabular-nums" style={{ color: 'var(--flit-text-primary)' }}>
                    {linea.numeroPolizaNorm}
                  </td>
                  <td className="px-4 py-3 text-sm tabular-nums" style={placa.esDato ? undefined : MUTED}>
                    {placa.texto}
                  </td>
                  <td className="px-4 py-3 text-sm tabular-nums" style={{ color: 'var(--flit-text-primary)' }}>
                    {pesos(linea.valorDeclarado)}
                  </td>
                  <td className="px-4 py-3 text-sm tabular-nums" style={valorSoat.esDato ? undefined : MUTED}>
                    {valorSoat.texto}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <StatusChip tone={TONO_RESULTADO[linea.resultado]}>
                      {ETIQUETA_RESULTADO[linea.resultado]}
                    </StatusChip>
                    {motivo && (
                      <div className="mt-1 max-w-[38rem] space-y-1 text-xs" style={SECUNDARIO}>
                        <p>{motivo.motivo}</p>
                        <p>{motivo.queHacer}</p>
                      </div>
                    )}
                    {/* La línea cuadra, pero su SOAT ya salió de la bolsa al liquidar el trámite.
                        No bloquea: está aquí para que el aviso de éxito no anuncie un cobro que no
                        ocurrió. */}
                    {!motivo && linea.yaDescontadoEnLiquidacion && (
                      <p className="mt-1 max-w-[38rem] text-xs" style={SECUNDARIO}>{NOTA_YA_DESCONTADO}</p>
                    )}
                  </td>
                </FlitTr>
              );
            })}
          </tbody>
        </FlitTable>
      )}
    </FlitCard>
  );
}
