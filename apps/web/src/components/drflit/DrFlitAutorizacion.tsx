import type { ReactNode, RefObject } from 'react';
import { AlertCircle } from 'lucide-react';
import type { FinalidadDrFlit } from '@operaciones/shared-types';
import { flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondarySm } from '../flit/flitPageKit';

// Dr. Flit — vista de autorización (anexo UX F5, wireframe C), UN SOLO componente parametrizado por
// `finalidad` (HU #13857 IA-5, spec `docs/ux/flito-dr-flit-f4-ia.md` §IA.4): `soporte` la usa el
// asistente de F5 y `ia` el panel antes de responder con IA. Solo pinta: quien la usa decide qué hace
// cada botón y dónde vive su estado. El texto vigente es el del servidor, como texto plano.

/** Botones que en <lg suben a 44 px de alto (objetivo táctil, F5.12); en lg+ la altura del kit. */
const PRIMARIA = `${flitBtnPrimary} max-lg:h-11`;
const SECUNDARIA = `${flitBtnSecondary} max-lg:h-11`;

/** `version`: el servidor dijo que la versión mostrada ya no es la vigente (409 / 400 `version-no-vigente`). */
export type ErrorAutorizacion = 'red' | 'version' | null;

interface CopyAutorizacion {
  titulo: string;
  entradilla: string | null;
  aceptar: string;
  recargando: string;
  /** Aviso no bloqueante: el texto cambió y ya se recargó. */
  avisoCambio: string;
  error: { titulo: string; detalle: string };
  errorVersion: { titulo: string; detalle: string };
  /** `true` = el error lleva su propio «Reintentar» (IA.4); F5 reintenta con «Acepto». */
  reintentarEnError: boolean;
}

const COPY: Record<FinalidadDrFlit, CopyAutorizacion> = {
  soporte: {
    titulo: 'Antes de radicar su caso',
    entradilla: null,
    aceptar: 'Acepto',
    recargando: 'Preparando su caso…',
    avisoCambio: 'El texto de la autorización cambió. Léalo y acéptelo para radicar su caso.',
    error: { titulo: 'No pude registrar su autorización.', detalle: 'Intente de nuevo.' },
    errorVersion: { titulo: 'No pude registrar su autorización.', detalle: 'Intente de nuevo.' },
    reintentarEnError: false,
  },
  ia: {
    titulo: 'Antes de usar la IA',
    entradilla:
      'Para responderle con sus propias palabras, Dr. Flit puede usar inteligencia artificial. Lea las condiciones:',
    aceptar: 'Aceptar',
    recargando: 'Cargando las condiciones…',
    avisoCambio: 'Las condiciones cambiaron mientras las leía. Revise el texto actualizado y vuelva a aceptar.',
    error: { titulo: 'No pude registrar su autorización.', detalle: 'Revise su conexión e intente de nuevo.' },
    errorVersion: {
      titulo: 'Las condiciones cambiaron mientras las leía.',
      detalle: 'Revise el texto actualizado y vuelva a aceptar.',
    },
    reintentarEnError: true,
  },
};

export interface DrFlitAutorizacionProps {
  finalidad: FinalidadDrFlit;
  /** `null` = aún sin el texto vigente (cargando). */
  textoVigente: string | null;
  recargando: boolean;
  enviando: boolean;
  /** El texto cambió y ya se muestra el nuevo (aviso de estado, no error). */
  avisoCambio: boolean;
  error: ErrorAutorizacion;
  onAceptar: () => void;
  onAhoraNo: () => void;
  /** Solo `ia`: «Reintentar» del error (repite el POST o recarga el texto vigente). */
  onReintentar?: () => void;
  tituloRef: RefObject<HTMLHeadingElement>;
  tituloId: string;
  primariaRef?: RefObject<HTMLButtonElement>;
}

/** Cuerpo y pie de la vista; quien la usa los coloca en su marco (scroll del cuerpo + pie fijo). */
export function vistaAutorizacion(p: DrFlitAutorizacionProps): { contenido: ReactNode; pie: ReactNode } {
  const c = COPY[p.finalidad];
  const inactivo = p.enviando || p.recargando || p.textoVigente === null;
  const error = p.error === 'version' ? c.errorVersion : p.error === 'red' ? c.error : null;
  return {
    contenido: (
      <>
        <h3
          ref={p.tituloRef}
          id={p.tituloId}
          tabIndex={-1}
          className="flit-focus mt-3 rounded-md text-base font-semibold text-flit-ink"
        >
          {c.titulo}
        </h3>
        {c.entradilla && <p className="mt-3 break-words text-sm text-flit-secondary">{c.entradilla}</p>}
        {p.avisoCambio && (
          <p role="status" className="mt-3 rounded-flit-lg border border-flit-soft bg-flit-app p-3 text-sm text-flit-ink">
            {c.avisoCambio}
          </p>
        )}
        {p.recargando || p.textoVigente === null
          ? <p role="status" className="mt-3 text-sm text-flit-secondary">{c.recargando}</p>
          : <p className="mt-3 whitespace-pre-line break-words text-sm text-flit-ink">{p.textoVigente}</p>}
        {error && (
          <div role="alert" className="mt-4 rounded-flit-lg border border-flit-soft bg-flit-app p-3 text-sm text-flit-ink">
            <div className="flex items-start gap-2">
              <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--flit-danger-text)]" />
              <div className="min-w-0">
                <p className="break-words">{error.titulo}</p>
                <p className="mt-1 break-words text-flit-secondary">{error.detalle}</p>
                {c.reintentarEnError && p.onReintentar && (
                  <button
                    type="button"
                    onClick={() => { if (!inactivo) p.onReintentar?.(); }}
                    aria-disabled={inactivo || undefined}
                    className={`${flitBtnSecondarySm} mt-3 max-lg:h-11`}
                  >
                    Reintentar
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </>
    ),
    pie: (
      <>
        <button
          type="button"
          onClick={() => { if (!p.enviando) p.onAhoraNo(); }}
          aria-disabled={p.enviando || undefined}
          className={SECUNDARIA}
        >
          Ahora no
        </button>
        <button
          ref={p.primariaRef}
          type="button"
          onClick={() => { if (!inactivo) p.onAceptar(); }}
          aria-disabled={inactivo || undefined}
          className={PRIMARIA}
          style={flitBtnPrimaryStyle}
        >
          {p.enviando ? 'Registrando…' : c.aceptar}
        </button>
      </>
    ),
  };
}
