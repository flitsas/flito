// HU #13684 — Aviso «Hay N trámites nuevos · Ver» entre la barra superior de Gestión Trámites y la
// tabla (o encima del vacío). Spec: docs/ux/flito-tramites-sincronizacion-simplificada.md §#13684.
//
// La región `role="status"` (aria-live polite) está SIEMPRE montada para que el lector anuncie el
// texto al aparecer sin mover el foco (AC5). Sin novedades no hay caja ni hueco.

import { flitBtnSecondary, flitBtnSecondaryStyle } from '../../flit/flitPageKit';
import type { Novedades } from './useNovedadesTramites';

/** Copy exacto de la spec UX. Los actualizados no se cuentan (AC2). */
export function textoNovedades({ nuevos, actualizados }: Novedades): string {
  if (nuevos <= 0) return 'Hay trámites actualizados';
  const cuantos = nuevos > 99 ? 'más de 99 trámites nuevos' : nuevos === 1 ? '1 trámite nuevo' : `${nuevos} trámites nuevos`;
  return actualizados > 0 ? `Hay ${cuantos} y otros actualizados` : `Hay ${cuantos}`;
}

function etiquetaVer({ nuevos, actualizados }: Novedades): string {
  if (nuevos > 0 && actualizados > 0) return 'Ver los trámites nuevos y actualizados';
  return nuevos > 0 ? 'Ver los trámites nuevos' : 'Ver los trámites actualizados';
}

interface Props {
  aviso: Novedades | null;
  /** Texto solo para lector de pantalla (p. ej. «Lista actualizada.» tras «Ver»). */
  anuncio: string;
  onVer: () => void;
}

export default function AvisoNovedadesTramites({ aviso, anuncio, onVer }: Props) {
  return (
    <div role="status" aria-live="polite" data-testid="aviso-novedades-tramites">
      {aviso ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2.5 text-sm"
          style={{ borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-card)', color: 'var(--flit-text-primary)' }}>
          <span>{textoNovedades(aviso)}</span>
          <button type="button" className={`${flitBtnSecondary} ml-auto`} style={flitBtnSecondaryStyle}
            aria-label={etiquetaVer(aviso)} onClick={onVer}>
            Ver
          </button>
        </div>
      ) : anuncio ? <span className="sr-only">{anuncio}</span> : null}
    </div>
  );
}
