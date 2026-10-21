import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle } from 'lucide-react';
import StatusChip from '../flit/StatusChip';
import { flitBtnSecondarySm } from '../flit/flitPageKit';
import { entradaAyudaPorClave, puedeVerEntradaAyuda, type UsuarioAyuda } from '../../lib/ayudaFlito';
import type { FichaParseada } from '../../lib/ayudaFicha';
import { explicacionDeModulo, type MensajeDrFlit } from '../../lib/drFlitConversacion';

// Dr. Flit — pinta cada mensaje de la conversación (HU #13765; slim §4, spec UX «Explícame un
// módulo»). Viven dentro del `role="log"` del panel: la respuesta se anuncia sin mover el foco (AC5).
// Títulos y resúmenes se derivan aquí desde el catálogo y la ficha ya cargada, nunca del mensaje.
// #13766 añade aquí `citas` / `sinResultados` (y F5 cuelga «Necesito soporte» de este archivo).

export const ENLACE_DRFLIT =
  'flit-focus inline-flex items-center gap-1 rounded-md font-medium text-[color:var(--flit-blue-text)] underline-offset-2 transition-colors hover:text-flit-ink hover:underline';

const BURBUJA_DRFLIT = 'rounded-flit-lg border border-flit-soft bg-flit-card p-4 text-sm text-flit-ink';

export function BurbujaDrFlit({ children }: { children: ReactNode }) {
  return (
    <div className={BURBUJA_DRFLIT}>
      <span className="sr-only">Dr. Flit: </span>
      {children}
    </div>
  );
}

function BurbujaUsuario({ children }: { children: ReactNode }) {
  return (
    <div className="ml-8 rounded-flit-lg bg-flit-app p-3 text-sm text-flit-ink">
      <p className="break-words">
        <span className="sr-only">Usted: </span>
        {children}
      </p>
    </div>
  );
}

export interface DrFlitMensajeProps {
  mensaje: MensajeDrFlit;
  user: UsuarioAyuda | null;
  /** Fichas ya cargadas en esta sesión de panel (`null` = pendiente). */
  fichas: ReadonlyMap<string, FichaParseada | null>;
  onNavegar: () => void;
}

export default function DrFlitMensaje({ mensaje, user, fichas, onNavegar }: DrFlitMensajeProps) {
  if (mensaje.tipo === 'modulo') {
    const entrada = entradaAyudaPorClave(mensaje.clave);
    return <BurbujaUsuario>Explíqueme {entrada?.etiqueta ?? 'un módulo'}</BurbujaUsuario>;
  }

  const entrada = entradaAyudaPorClave(mensaje.ref.clave);
  // Fail-closed: si el permiso cambió (o la ficha no se cargó), no se cita nada de esa ficha.
  if (!entrada || !puedeVerEntradaAyuda(user, entrada) || !fichas.has(entrada.clave)) {
    return (
      <BurbujaDrFlit>
        <p>Esta referencia ya no está disponible.</p>
      </BurbujaDrFlit>
    );
  }
  const { etiqueta, resumen, href } = explicacionDeModulo(entrada, fichas.get(entrada.clave) ?? null);
  return (
    <BurbujaDrFlit>
      <p className="break-words font-semibold">{etiqueta}</p>
      {resumen && <p className="mt-1 break-words text-flit-secondary">{resumen}</p>}
      {href ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Link to={href} onClick={onNavegar} className={ENLACE_DRFLIT}>
            Abrir la ficha<span className="sr-only"> de {etiqueta}</span>
            <span aria-hidden="true">→</span>
          </Link>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <StatusChip tone="active">Ficha pendiente</StatusChip>
          <p>Su ficha está pendiente.</p>
        </div>
      )}
    </BurbujaDrFlit>
  );
}

/** «Dr. Flit está buscando…»: una línea, sin spinner; el `log` lo anuncia una vez (AC4). */
export function DrFlitBuscando() {
  return (
    <BurbujaDrFlit>
      <p>Dr. Flit está buscando…</p>
    </BurbujaDrFlit>
  );
}

/** Error de carga de la ficha dentro de la conversación; el panel no se cierra (AC4). */
export function DrFlitErrorModulo({ etiqueta, onReintentar }: { etiqueta: string; onReintentar: () => void }) {
  return (
    <BurbujaDrFlit>
      <div className="flex items-start gap-2">
        <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--flit-danger-ink)]" />
        <div className="min-w-0">
          <p className="break-words">No pude cargar la ficha de {etiqueta}.</p>
          <p className="mt-1 text-flit-secondary">Revise su conexión e intente de nuevo.</p>
          <button type="button" onClick={onReintentar} className={`${flitBtnSecondarySm} mt-3`}>
            Reintentar
          </button>
        </div>
      </div>
    </BurbujaDrFlit>
  );
}
