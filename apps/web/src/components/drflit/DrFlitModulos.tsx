import { useEffect, useRef, type KeyboardEvent } from 'react';
import StatusChip from '../flit/StatusChip';
import { flitBtnSecondarySm } from '../flit/flitPageKit';
import { GRUPO_AYUDA_LABEL, GRUPOS_ORDEN, type EntradaAyuda } from '../../content/ayuda/catalogo';
import { existeFichaMd } from '../../content/ayuda/cargarFichas';

// Dr. Flit — lista de «Explícame un módulo» (HU #13765 AC1/AC5). Paso transitorio al final de la
// conversación (no es un mensaje): «Cancelar» o Esc la quitan sin dejar rastro. Recibe la lista YA
// filtrada por permiso y en el orden del índice (`capitulosEnOrdenDeIndice`); nunca `hasPage`.

export const DRFLIT_MODULOS_ID = 'drflit-modulos';

export interface DrFlitModulosProps {
  modulos: readonly EntradaAyuda[];
  onElegir: (entrada: EntradaAyuda) => void;
  onCancelar: () => void;
}

const BOTON_MODULO =
  'flit-focus flex min-h-11 w-full min-w-0 flex-wrap items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm font-medium text-flit-ink transition-colors hover:bg-[var(--flit-bg-hover)]';

export default function DrFlitModulos({ modulos, onElegir, onCancelar }: DrFlitModulosProps) {
  const tituloRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    tituloRef.current?.focus();
  }, []);

  const grupos = GRUPOS_ORDEN.map((g) => ({ grupo: g, items: modulos.filter((m) => m.grupo === g) })).filter(
    (g) => g.items.length > 0,
  );
  const conRotulos = grupos.length > 1;

  // Esc cierra primero lo transitorio: no llega al marco (que cerraría el panel).
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onCancelar();
    }
  };

  return (
    <div
      id={DRFLIT_MODULOS_ID}
      role="group"
      aria-labelledby="drflit-modulos-titulo"
      onKeyDown={onKeyDown}
      className="rounded-flit-lg border border-flit-soft bg-flit-card p-3 text-sm text-flit-ink"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 px-1">
        <p id="drflit-modulos-titulo" ref={tituloRef} tabIndex={-1} className="flit-focus rounded-md font-semibold">
          ¿Qué módulo quiere conocer?
        </p>
        <button type="button" onClick={onCancelar} className={flitBtnSecondarySm}>
          Cancelar
        </button>
      </div>
      {grupos.map(({ grupo, items }) => (
        <div key={grupo} className="mt-2">
          {conRotulos && (
            <p className="px-1 pb-1 text-xs font-semibold uppercase tracking-wide text-flit-secondary">
              {GRUPO_AYUDA_LABEL[grupo]}
            </p>
          )}
          <ul className="flex flex-col gap-1">
            {items.map((m) => (
              <li key={m.clave}>
                <button type="button" onClick={() => onElegir(m)} className={BOTON_MODULO}>
                  <span className="min-w-0 break-words">{m.etiqueta}</span>
                  {!existeFichaMd(m.clave) && <StatusChip tone="active">Ficha pendiente</StatusChip>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
