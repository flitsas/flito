// FLITO — Comparendos: la vista de Sincronización (HU #11635).
//
// La pestaña nació vacía en la HU #11633 porque era un DESTINO —el vacío del visor enlaza aquí y
// `?vista=sincronizacion` tenía que llevar a algo— y explícitamente SIN un botón inhabilitado: un
// control que no puede funcionar todavía es peor que su ausencia. Aquí es donde el botón aparece,
// ya con algo detrás.
//
// La vista tiene cuatro piezas y una de ellas es invisible:
//
//   1. **La región viva, única para toda la vista.** Vive AQUÍ y no dentro de la consola porque la
//      consola no es la única que anuncia: el desenlace de la corrida lo publica el resultado, que
//      es otra tarjeta. Una sola región `role="status"` (polite, implícito en el rol) recibe todos
//      los cambios de fase; con una por tarjeta, un lector anunciaría el mismo cambio dos veces o
//      solo uno de los dos, según el orden del DOM. Está montada SIEMPRE, también vacía: una región
//      viva que aparece con su texto dentro no se anuncia —el lector observa cambios dentro de una
//      región que ya existía—, y ese es el error clásico que deja a quien usa lector sin enterarse
//      de que la sincronización terminó.
//   2. **La consola** (Región A de la spec de UX): disparo, progreso y errores accionables.
//   3. **El resultado**, en su propia tarjeta y solo cuando hay uno confirmado.
//   4. **El historial** (Región B, HU #11636), debajo del resultado: las corridas anteriores y el
//      modal de detalle, que reutiliza `ResultadoSyncComparendos` para los contadores y los pasos.
//
// La consola y el historial se tocan en UN punto y en una sola dirección: `sync.resultado`. Cuando
// la consola confirma el desenlace de una corrida, el historial se entera y se refresca UNA vez
// —nunca sondea por su cuenta (enmienda de UX, decisión 13: sería duplicar las peticiones y las
// filas de `pii_access_log` sobre el mismo dato)— y de paso funde esa corrida en su primera fila
// para que el chip salga correcto en el mismo fotograma en que aparece la tarjeta de resultado.
//
// La señal va hacia ABAJO a propósito: `useComparendosSync` no sabe que existe un historial. Meter
// la lista dentro de ese hook habría atado la paginación del archivo a la máquina de estados de la
// corrida viva, y cada transición de fase habría recargado la tabla.
//
// El estado de la corrida vive en el hook y se pasa hacia abajo en vez de que cada tarjeta llame a
// `useComparendosSync()`: dos llamadas serían dos máquinas de estados sondeando la misma corrida por
// separado —dos veces las peticiones, dos veces las filas de `pii_access_log`— y podrían discrepar.

import ConsolaSyncComparendos from './ConsolaSyncComparendos';
import HistorialSyncComparendos from './HistorialSyncComparendos';
import ResultadoSyncComparendos from './ResultadoSyncComparendos';
import { MarcoComparendos, type NavComparendos } from './navegacionComparendos';
import { useComparendosSync } from './useComparendosSync';

export default function VistaSyncComparendos({ nav }: { nav: NavComparendos }) {
  const sync = useComparendosSync();

  return (
    <MarcoComparendos nav={nav}>
      {/* `role="status"` ya implica `aria-live="polite"` y `aria-atomic="true"`. Es `sr-only` porque
          todo lo que anuncia se ve en pantalla escrito de otra forma: duplicarlo visible sería
          repetir la misma frase dos veces a quien sí ve la pantalla. */}
      <p className="sr-only" role="status">{sync.anuncio}</p>

      <ConsolaSyncComparendos nav={nav} sync={sync} />

      {sync.fase === 'resultado' && sync.resultado && (
        <ResultadoSyncComparendos resultado={sync.resultado} ajena={sync.ajena} />
      )}

      <HistorialSyncComparendos desenlace={sync.resultado} />
    </MarcoComparendos>
  );
}
