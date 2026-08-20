// FLITO — Comparendos · Sincronización: el historial de corridas (HU #11636, Región B).
//
// La tabla de arriba responde «¿cuándo se sincronizó y cómo fue?». Todo lo demás —los NIT del
// alcance, quién la lanzó, qué pasó en cada fuente— vive en el modal de detalle, y esa frontera no
// es de comodidad visual:
//
//   · **El alcance son NIT, y en la fila va solo el conteo** (AC1). Volcar veinte números de
//     identificación en una celda de una tabla que se recorre de un vistazo esparce cuasi-PII
//     (AGENTS.md §14) por una superficie que nadie vino a leer, y de paso hace la columna ilegible.
//     En el detalle sí se listan: ahí quien abre está preguntando justamente por eso.
//   · **Ni aquí ni en el modal hay región viva.** La vista Sincronización tiene UNA, la de
//     `VistaSyncComparendos`, y el TC62 de la HU #11635 cuenta que sea exactamente una. Por eso este
//     archivo no reutiliza `BloqueConfig`, que sería el atajo natural: su esqueleto monta un
//     `role="status"` —correcto en la vista de Configuración, que no tiene ninguna— y aquí sería la
//     segunda, compitiendo con el anuncio del desenlace justo mientras se publica.
//   · **El error del historial no lleva `role="alert"`,** por lo mismo y por una razón más del AC3:
//     no puede tumbar la consola de arriba. Que no se pueda leer el archivo de corridas anteriores
//     no es una urgencia que deba interrumpir a quien está mirando cómo va la de ahora. Es un texto
//     con su botón, dentro de esta tarjeta y sin salir de ella.
//
// ── Por qué esta tabla es una superficie de desenlace ───────────────────────────────────────────
//
// Al descartarse los toasts de sincronización (enmienda de UX, decisión 14), la primera fila es
// —con la tarjeta de resultado— donde queda visible cómo terminó la corrida para quien estaba
// mirando hacia abajo cuando acabó. `useHistorialSync` se encarga de que llegue con el chip correcto
// en el mismo fotograma; aquí lo único que hace falta es no estorbar: nada de ordenar por fecha en
// el cliente, nada de recargar la lista por cuenta propia.

import { useRef, useState } from 'react';
import type { ComparendosSyncResultado, ComparendosSyncRun } from '@operaciones/shared-types';
import {
  FlitCard, FlitEmpty, FlitTable, FlitTh, FlitTr,
  flitBtnSecondary, flitBtnSecondarySm, flitBtnSecondaryStyle,
} from '../../flit/flitPageKit';
import PanelDetalleSyncRun from './PanelDetalleSyncRun';
import { ChipEstadoSync } from './ResultadoSyncComparendos';
import { SIN_DATO, fechaHoraCortaColombia } from './formato';
import { useHistorialSync } from './useHistorialSync';

const ID_TITULO = 'historial-sync-comparendos';

/** Una pieza del resumen en sus dos formas: la que se ve —abreviada— y la que se escucha. */
interface PiezaResumen { corta: string; completa: string }

/**
 * Los tres o cuatro números que dicen si esa corrida hizo algo. **No es el resumen entero**: el
 * bloque completo de contadores está en el detalle, y meterlo en una celda obligaría a leer nueve
 * cifras para ver que una corrida no trajo nada.
 *
 * `upserts` va siempre —incluso en cero, que es un dato: la corrida terminó y no cambió nada— y el
 * resto solo cuando hay algo que contar. El modo simulado se nombra el PRIMERO porque cambia cómo se
 * leen todos los números que vienen detrás: no salieron del proveedor real.
 *
 * **Cada pieza se devuelve abreviada Y completa** (HU #11652, AC5). Abreviar en una tabla densa es
 * legítimo para quien mira —«3 inact. · 2 err SIMIT» cabe en la celda y se entiende de un vistazo—,
 * pero leído en voz alta es «tres inact punto, dos err SIMIT», que no es información. Las dos formas
 * dicen lo mismo; la celda decide cuál enseña a quién.
 *
 * `upserts` y «modo simulado» no se tocan: no son abreviaturas, y son el vocabulario con el que el
 * detalle de la corrida nombra esos mismos contadores.
 */
function piezasDelResumen(run: ComparendosSyncRun): PiezaResumen[] | null {
  const r = run.resumen;
  if (!r) return null;
  const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;
  return [
    r.modo === 'mock' ? { corta: 'modo simulado', completa: 'modo simulado' } : null,
    { corta: `${r.upserts} upserts`, completa: `${r.upserts} upserts` },
    r.inactivados > 0
      ? { corta: `${r.inactivados} inact.`, completa: plural(r.inactivados, 'inactivado', 'inactivados') }
      : null,
    r.llamadasSimitError > 0
      ? {
        corta: `${r.llamadasSimitError} err SIMIT`,
        completa: plural(r.llamadasSimitError, 'error de SIMIT', 'errores de SIMIT'),
      }
      : null,
    r.llamadasMunicipalError > 0
      ? {
        corta: `${r.llamadasMunicipalError} err mun.`,
        completa: plural(r.llamadasMunicipalError, 'error municipal', 'errores municipales'),
      }
      : null,
  ].filter((pieza): pieza is PiezaResumen => pieza !== null);
}

/**
 * La celda del resumen: lo abreviado a la vista, lo completo al oído.
 *
 * El `aria-hidden` sobre lo visible y el `sr-only` con el texto entero son el par que ya usa el
 * módulo (`PanelDetalleComparendo`, el «Ver detalle de la corrida del …» de aquí abajo): ni se
 * duplica el anuncio ni se sustituye lo que el operador lee en pantalla.
 *
 * Sin `resumen` se pinta un guion, nunca ceros: una corrida que murió sin escribir sus contadores no
 * es una corrida que no hizo nada, y esa diferencia es la que el guion conserva. El guion suelto
 * tampoco se puede escuchar, así que lleva su `sr-only` detrás igual que los demás huecos del módulo.
 */
function CeldaResumen({ run }: { run: ComparendosSyncRun }) {
  const piezas = piezasDelResumen(run);
  if (!piezas) return <>{SIN_DATO}<span className="sr-only">Sin resumen</span></>;
  return (
    <>
      <span aria-hidden="true">{piezas.map((p) => p.corta).join(' · ')}</span>
      {/* Con comas y no con el punto medio: el separador de la vista no es una pausa al oído. */}
      <span className="sr-only">{piezas.map((p) => p.completa).join(', ')}</span>
    </>
  );
}

interface Props {
  /**
   * El desenlace que la consola acaba de confirmar, o `null`. Es la única señal que cruza entre las
   * dos piezas: llega hacia abajo, no se pregunta hacia arriba. Ver `useHistorialSync`.
   */
  desenlace: ComparendosSyncResultado | null;
}

export default function HistorialSyncComparendos({ desenlace }: Props) {
  const historial = useHistorialSync(desenlace);
  const [abierta, setAbierta] = useState<ComparendosSyncRun | null>(null);
  // Respaldo del foco al cerrar el modal: la fila que lo abrió puede haber desaparecido si la lista
  // se refrescó mientras tanto (ver `PanelDetalleSyncRun`).
  const tituloRef = useRef<HTMLHeadingElement>(null);

  const { corridas, estado } = historial;

  return (
    <section role="region" aria-labelledby={ID_TITULO} aria-busy={estado === 'cargando'}>
      <FlitCard>
        <h2
          id={ID_TITULO}
          ref={tituloRef}
          tabIndex={-1}
          className="flit-focus rounded text-sm font-semibold"
          style={{ color: 'var(--flit-text-primary)' }}
        >
          Historial de sincronizaciones
        </h2>
        <p className="mt-1 max-w-3xl text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          Las últimas corridas, de la más reciente a la más antigua. Los NIT de cada alcance y el
          detalle por fuente están en «Ver detalle».
        </p>

        <div className="mt-4">
          {/* El ERROR va antes que el vacío, como en todo el módulo: si la consulta falló no se sabe
              si hay corridas, y decir «todavía no hay» sería afirmar lo que nadie comprobó. */}
          {estado === 'cargando' && <EsqueletoHistorial />}

          {estado === 'error' && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>
                No se pudo cargar el historial de sincronizaciones.
              </p>
              <button
                type="button"
                className={flitBtnSecondary}
                style={flitBtnSecondaryStyle}
                onClick={historial.recargar}
              >
                Reintentar
              </button>
            </div>
          )}

          {estado === 'ok' && corridas.length === 0 && (
            <FlitEmpty>Todavía no hay sincronizaciones. Lanza la primera desde el panel de arriba.</FlitEmpty>
          )}

          {estado === 'ok' && corridas.length > 0 && (
            <>
              <FlitTable>
                <caption className="sr-only">
                  Corridas de sincronización, de la más reciente a la más antigua: cuándo empezó cada
                  una, cómo terminó, sobre cuántos NIT se consultó y qué movió en los registros.
                </caption>
                <thead>
                  <FlitTr>
                    <FlitTh>Inicio</FlitTh>
                    <FlitTh>Estado</FlitTh>
                    <FlitTh>Alcance</FlitTh>
                    <FlitTh>Resumen rápido</FlitTh>
                    {/* La columna de la acción se nombra, como en los catálogos de Configuración:
                        una cabecera vacía deja la columna sin anunciar al recorrer la tabla con
                        lector, y es el nombre de la del wireframe. */}
                    <FlitTh>Detalle</FlitTh>
                  </FlitTr>
                </thead>
                <tbody>
                  {corridas.map((run) => (
                    <FilaCorrida key={run.runId} run={run} onVerDetalle={() => setAbierta(run)} />
                  ))}
                </tbody>
              </FlitTable>

              {historial.hayMas && (
                <div className="mt-3">
                  <button
                    type="button"
                    className={flitBtnSecondary}
                    style={flitBtnSecondaryStyle}
                    onClick={historial.cargarMas}
                  >
                    Cargar más corridas
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </FlitCard>

      {abierta && (
        <PanelDetalleSyncRun
          // La `key` es el `runId`: sin ella, abrir otra corrida sin cerrar la primera reutilizaría
          // el estado del hook de detalle y enseñaría los pasos de la anterior mientras carga.
          key={abierta.runId}
          fila={abierta}
          onCerrar={() => setAbierta(null)}
          respaldoFocoRef={tituloRef}
        />
      )}
    </section>
  );
}

/**
 * Una fila = una corrida.
 *
 * El botón dice «Ver detalle» a la vista y «Ver detalle de la corrida del 14 de ago, 15:02» a un
 * lector de pantalla. Sin ese añadido `sr-only`, una lista de veinte botones con el mismo nombre
 * accesible obliga a recorrer la tabla celda a celda para saber cuál se está pulsando — y el
 * `aria-label` no vale como alternativa: sustituiría al texto visible y rompería a quien busca el
 * control por lo que ve escrito.
 */
function FilaCorrida({ run, onVerDetalle }: { run: ComparendosSyncRun; onVerDetalle: () => void }) {
  const celda = 'px-4 py-2.5 text-sm align-middle';
  const inicio = fechaHoraCortaColombia(run.iniciadoEn);

  return (
    <FlitTr>
      <td className={celda} style={{ color: 'var(--flit-text-primary)' }}>{inicio}</td>
      <td className={celda}><ChipEstadoSync estado={run.estado} /></td>
      {/* Solo el conteo (AC1). Los NIT completos, en el modal. */}
      <td className={celda} style={{ color: 'var(--flit-text-primary)' }}>
        {run.scopeNits.length > 0 ? `${run.scopeNits.length} NIT` : SIN_DATO}
      </td>
      <td className={celda} style={{ color: 'var(--flit-text-primary)' }}><CeldaResumen run={run} /></td>
      <td className={`${celda} text-right`}>
        <button type="button" className={flitBtnSecondarySm} style={flitBtnSecondaryStyle} onClick={onVerDetalle}>
          Ver detalle<span className="sr-only">{` de la corrida del ${inicio}`}</span>
        </button>
      </td>
    </FlitTr>
  );
}

/**
 * Cinco filas fantasma. Sin `role="status"` —ver la cabecera— y con la línea que dice qué pasa en
 * `sr-only`: quien recorra la tarjeta la lee, y a quien esté escuchando el progreso de una corrida
 * no se le interrumpe con un anuncio que no pidió.
 *
 * `aria-busy` no va aquí sino en la región de la tarjeta, que es la que tiene nombre: sobre un `div`
 * sin rol, ningún lector expone nada.
 */
function EsqueletoHistorial() {
  return (
    <div className="space-y-2">
      <p className="sr-only">Cargando el historial de sincronizaciones…</p>
      <div className="animate-pulse space-y-2 motion-reduce:animate-none">
        {Array.from({ length: 5 }, (_, fila) => (
          <div key={fila} className="h-9" style={{ background: 'var(--flit-border-soft)', borderRadius: 8 }} />
        ))}
      </div>
    </div>
  );
}
