// FLITO — Comparendos: la vista de Sincronización, montada pero todavía sin consola (HU #11633).
//
// La pestaña existe desde esta HU porque es un DESTINO: el vacío del visor va a enlazar aquí
// (HU #11637) y `?vista=sincronizacion` tiene que llevar a algo desde el primer día. La consola de
// disparo, el progreso y el historial de corridas son las HUs #11635 y #11636.
//
// Lo que se pinta hasta entonces dice exactamente eso y nada más. En concreto **no hay un botón
// «Sincronizar» inhabilitado**: un control que no puede funcionar todavía es peor que su ausencia
// —se pulsa, no pasa nada y quien lo pulsó no sabe si falló él o el sistema— y además haría creer
// que la corrida existe pero está rota.

import { FlitCard } from '../../flit/flitPageKit';
import { MarcoComparendos, type NavComparendos } from './navegacionComparendos';

export default function VistaSyncComparendos({ nav }: { nav: NavComparendos }) {
  return (
    <MarcoComparendos nav={nav}>
      <FlitCard>
        <h2 className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
          Sincronizar ahora
        </h2>
        <p className="mt-2 max-w-3xl text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          El disparo de la sincronización y el historial de corridas llegan en la próxima entrega.
          Mientras tanto, deja listos en Configuración los NIT que se vigilan y los municipios que se
          consultan: sin eso, la sincronización no tendría qué preguntar.
        </p>
      </FlitCard>
    </MarcoComparendos>
  );
}
