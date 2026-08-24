// FLITO — Comparendos · Sincronización: el desenlace de una corrida (HU #11635, AC1).
//
// **Archivo propio a propósito, aunque hoy solo lo use la consola.** La HU #11636 abre el historial
// de corridas y su modal de detalle pinta EXACTAMENTE esto mismo —el detalle de una corrida es el
// detalle de una corrida, la mire uno recién lanzada o tres días después—. Tenerlo dentro de la
// consola obligaría a esa HU a copiarlo, y dos copias de una tabla de contadores es cómo se arregla
// el redondeo de la duración en un sitio y no en el otro.
//
// Tres reglas que este componente sostiene y que no se ven en el JSX:
//
//   · **Los ceros no siempre significan cero.** `abortadaPorTiempo` e `inactivacionOmitida` cambian
//     el significado de «Inactivados 0»: en un caso es «no había nada que apagar» y en el otro «no
//     se llegó a mirar» o «no se apagó nada a propósito». Por eso los avisos van ARRIBA de la tabla
//     y no como una nota al pie: quien lee el número tiene que haber leído antes la advertencia.
//   · **`partial` no se distingue por el color.** El chip lleva la palabra «Parcial» y debajo va la
//     ayuda de cobertura, porque el tono `warning` no le dice nada a quien no lo percibe —ni a quien
//     imprima la pantalla— y porque «parcial» suena a «casi bien» cuando significa que hay NIT a los
//     que no se les inactivó nada aunque en la fuente parezcan ausentes (CF-10).
//   · **`itemsLeidos: null` se pinta con guion, nunca con cero.** `null` es «no se llegó a leer» y
//     un 0 sería una afirmación sobre datos que nadie consultó.
//
// El `mensaje` de un paso SÍ se pinta, y es la única excepción a la regla de «no se hace eco del
// servidor» del módulo: no es el mensaje de un error HTTP, es una columna persistida que los errores
// del dominio construyen sin token, sin cabeceras y sin PII a propósito (`flito-comparendos.errors.ts`).

import { useId } from 'react';
import type {
  ComparendosSyncEstado, ComparendosSyncResultado, ComparendosSyncResumen, ComparendosSyncStep,
} from '@operaciones/shared-types';
import StatusChip, { type ChipTone } from '../../flit/StatusChip';
import { FlitCard, FlitTable, FlitTh, FlitTr } from '../../flit/flitPageKit';
import { SIN_DATO, duracionCorta, fechaHoraColombia, mensajePaso } from './formato';

/** Etiqueta y tono de cada estado de corrida. Los exporta el historial de la HU #11636. */
export const ESTADO_SYNC: Record<ComparendosSyncEstado, { etiqueta: string; tono: ChipTone }> = {
  running: { etiqueta: 'En curso', tono: 'warning' },
  completed: { etiqueta: 'Completada', tono: 'success' },
  partial: { etiqueta: 'Parcial', tono: 'warning' },
  failed: { etiqueta: 'Fallida', tono: 'danger' },
};

/**
 * El estado de la corrida, con su palabra dentro del chip.
 *
 * Respaldo por el valor crudo: el `estado` llega por la red y un backend un paso por delante
 * mandaría uno que este mapa todavía no tiene. Mejor una etiqueta fea que «undefined».
 */
export function ChipEstadoSync({ estado }: { estado: ComparendosSyncEstado }) {
  const info = (ESTADO_SYNC as Record<string, { etiqueta: string; tono: ChipTone } | undefined>)[estado];
  return <StatusChip tone={info?.tono ?? 'neutral'}>{info?.etiqueta ?? estado}</StatusChip>;
}

/** Cuánto duró, con los DOS instantes del servidor. Nunca contra el reloj del navegador. */
function duracionDeCorrida(iniciadoEn: string, finalizadoEn: string | null): string | null {
  if (!finalizadoEn) return null;
  const inicio = new Date(iniciadoEn).getTime();
  const fin = new Date(finalizadoEn).getTime();
  if (Number.isNaN(inicio) || Number.isNaN(fin)) return null;
  return duracionCorta(fin - inicio);
}

/**
 * Los contadores, en dos líneas y **como texto de una pieza**.
 *
 * Etiqueta y número van en el mismo nodo de texto («Upserts 340») en vez de en celdas separadas:
 * `Nuevos` es `primeraLlegada` y `Reaparecidos` es `reactivados` —los nombres del contrato no son
 * los de la pantalla— y ese mapeo es justo el que se puede cruzar sin que nadie lo note.
 */
function lineasDeResumen(r: ComparendosSyncResumen): string[] {
  return [
    `NITs procesados ${r.nitsProcesados} · SIMIT ok ${r.llamadasSimitOk} / err ${r.llamadasSimitError}`
    + ` · Municipal ok ${r.llamadasMunicipalOk} / err ${r.llamadasMunicipalError}`,
    `Upserts ${r.upserts} · Nuevos ${r.primeraLlegada} · Inactivados ${r.inactivados}`
    + ` · Reaparecidos ${r.reactivados} · Ignorados ${r.itemsIgnorados}`,
  ];
}

/**
 * Las advertencias que cambian cómo se leen los números. Se pintan **solo si aplican**.
 *
 * El copy sale del catálogo de `docs/ux/flito-comparendos-config-sync.md`, que es el índice canónico
 * del documento. La ayuda de `partial` está redactada de dos formas distintas en esa spec (la tabla
 * de tonos dice otra cosa); manda el catálogo, y la discrepancia queda anotada en el HANDOFF.
 *
 * `inactivacionOmitida: 'deadline'` no tenía copy en la spec: es el mismo hecho que
 * `abortadaPorTiempo` visto desde el barrido, y se redacta aquí como lo que significa —no se apagó
 * nada porque la corrida se cortó antes—.
 */
function avisosDeResumen(estado: ComparendosSyncEstado, r: ComparendosSyncResumen): string[] {
  const avisos: string[] = [];
  if (estado === 'partial' || r.nitsSinInactivacion > 0) {
    avisos.push('Con cobertura incompleta no se inactivan comparendos de esos NIT aunque «falten» en una fuente.');
  }
  if (r.nitsSinInactivacion > 0) {
    avisos.push(`${r.nitsSinInactivacion} NIT sin inactivación por cobertura incompleta.`);
  }
  if (r.abortadaPorTiempo) {
    avisos.push('La corrida se cortó por tiempo: lo no consultado no significa ausencia.');
  }
  if (r.inactivacionOmitida === 'umbral') {
    avisos.push('No se inactivó nada: el volumen a apagar superaba el tope de seguridad.');
  }
  if (r.inactivacionOmitida === 'deadline') {
    avisos.push('No se inactivó nada: la corrida se cortó por tiempo y el barrido no se ejecutó.');
  }
  if (r.modo === 'mock') {
    avisos.push('Modo simulado — los datos no vinieron del proveedor real.');
  }
  return avisos;
}

/** «SIMIT» para la fuente nacional; el resto es el código de la fuente municipal, tal cual. */
function etiquetaFuente(fuente: string): string {
  return fuente === 'simit' ? 'SIMIT' : fuente;
}

interface Props {
  resultado: ComparendosSyncResultado;
  /** La corrida la inició otra sesión: se dice, para que su desenlace no pase por propio. */
  ajena?: boolean;
  /**
   * Encabezado de la tarjeta, que es también el nombre accesible de su región.
   *
   * Lo cambia el modal del historial (HU #11636): allí la corrida puede ser de hace tres días —o
   * seguir en curso—, y «Resultado de la corrida» prometería el desenlace de algo que se acaba de
   * lanzar. De paso, deja ese nombre accesible existiendo UNA sola vez en la vista aunque el modal
   * esté abierto encima de la tarjeta de la consola: dos regiones con el mismo nombre son, para
   * quien navega por regiones, dos sitios indistinguibles.
   */
  titulo?: string;
}

export default function ResultadoSyncComparendos(
  { resultado, ajena = false, titulo = 'Resultado de la corrida' }: Props,
) {
  const { estado, resumen, steps, iniciadoEn, finalizadoEn } = resultado;
  // Generado y no constante: con el modal del historial abierto hay DOS de estas tarjetas montadas a
  // la vez, y dos `id` iguales dejan a los dos `aria-labelledby` apuntando al primero —el nombre de
  // la región del modal sería el título de la tarjeta de debajo—.
  const idTitulo = useId();
  const duracion = duracionDeCorrida(iniciadoEn, finalizadoEn);
  const avisos = resumen ? avisosDeResumen(estado, resumen) : [];

  return (
    <section role="region" aria-labelledby={idTitulo}>
      <FlitCard>
        <h2 id={idTitulo} className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
          {titulo}
        </h2>

        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <ChipEstadoSync estado={estado} />
          <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            {resumen ? `modo ${resumen.modo === 'mock' ? 'simulado' : 'real'} · ` : ''}
            {fechaHoraColombia(finalizadoEn ?? iniciadoEn)}
            {duracion ? ` · duró ${duracion}` : ''}
          </p>
        </div>

        {ajena && (
          <p className="mt-2 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            Esta corrida la inició otra sesión: no es la que lanzaste tú.
          </p>
        )}

        {resumen ? (
          <div className="mt-3 space-y-1">
            {lineasDeResumen(resumen).map((linea) => (
              <p key={linea} className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>{linea}</p>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            Esta corrida no dejó contadores: se cerró sin escribir su resumen.
          </p>
        )}

        {avisos.length > 0 && (
          <ul className="mt-3 space-y-1">
            {avisos.map((aviso) => (
              <li key={aviso} className="text-sm" style={{ color: 'var(--flit-warning-ink)' }}>
                <span aria-hidden="true">⚠ </span>{aviso}
              </li>
            ))}
          </ul>
        )}

        <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>
          Detalle por fuente
        </h3>

        {steps.length === 0 ? (
          <p className="mt-2 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            Esta corrida no registró pasos.
          </p>
        ) : (
          <div className="mt-2">
            <FlitTable>
              <caption className="sr-only">
                Detalle por fuente: una fila por cada consulta a una fuente, con su resultado, el
                código HTTP del proveedor, los ítems leídos y lo que tardó.
              </caption>
              <thead>
                <FlitTr>
                  <FlitTh>NIT</FlitTh>
                  <FlitTh>Fuente</FlitTh>
                  <FlitTh>Resultado</FlitTh>
                  <FlitTh>HTTP</FlitTh>
                  <FlitTh>Ítems</FlitTh>
                  <FlitTh>Tiempo</FlitTh>
                </FlitTr>
              </thead>
              <tbody>
                {steps.map((paso, indice) => <FilaPaso key={`${paso.nit}-${paso.fuente}-${indice}`} paso={paso} />)}
              </tbody>
            </FlitTable>
          </div>
        )}
      </FlitCard>
    </section>
  );
}

/**
 * Una fila = una llamada a una fuente para un NIT.
 *
 * El mensaje del paso fallido va DENTRO de la misma fila, bajo el chip de resultado, y no en una
 * fila aparte con `colSpan`: una fila de continuación se lee como un registro más en cualquier
 * lector de pantalla y descuadra el conteo de filas de la tabla. Aquí, quien recorra la fila del
 * paso que falló oye el error como parte de esa fila, que es de lo que habla.
 */
function FilaPaso({ paso }: { paso: ComparendosSyncStep }) {
  const celda = 'px-4 py-2.5 text-sm align-top';
  // El mensaje pasa por `mensajePaso` y NO se lee de `paso.mensaje`: es el único punto por el que
  // salen los pasos a pantalla —esta fila la pinta la tarjeta de resultado de la consola y también
  // el modal de detalle del historial, que reusan este componente—, así que aquí es donde el alias
  // del histórico (HU #11797) alcanza a las dos superficies a la vez. Ver `formato.ts`.
  const mensaje = mensajePaso(paso);
  return (
    <FlitTr>
      <td className={celda} style={{ color: 'var(--flit-text-primary)' }}>{paso.nit}</td>
      <td className={celda} style={{ color: 'var(--flit-text-primary)' }}>{etiquetaFuente(paso.fuente)}</td>
      <td className={`${celda} max-w-md`}>
        <StatusChip tone={paso.ok ? 'success' : 'danger'}>{paso.ok ? 'Ok' : 'Error'}</StatusChip>
        {mensaje && (
          <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{mensaje}</p>
        )}
      </td>
      <td className={celda} style={{ color: 'var(--flit-text-primary)' }}>{paso.httpStatus ?? SIN_DATO}</td>
      <td className={celda} style={{ color: 'var(--flit-text-primary)' }}>{paso.itemsLeidos ?? SIN_DATO}</td>
      <td className={celda} style={{ color: 'var(--flit-text-primary)' }}>{duracionCorta(paso.duracionMs)}</td>
    </FlitTr>
  );
}
