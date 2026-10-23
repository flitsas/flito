import { Link } from 'react-router-dom';
import { flitBtnSecondarySm } from '../flit/flitPageKit';
import { entradaAyudaPorClave, puedeVerEntradaAyuda, type UsuarioAyuda } from '../../lib/ayudaFlito';
import type { FichaParseada } from '../../lib/ayudaFicha';
import { seccionesDeFicha } from '../../lib/drFlitBusqueda';
import type { MensajeDrFlit, RefFicha } from '../../lib/drFlitConversacion';
import { restaurarRespuesta } from '../../lib/drFlitIa';
import { BotonNecesitoSoporte, BurbujaDrFlit, CITA_DRFLIT, NO_DISPONIBLE } from './DrFlitMensaje';

// Dr. Flit IA — respuesta de texto de la IA (HU #13857 IA-5; spec `docs/ux/flito-dr-flit-f4-ia.md`
// §IA.5). El `reply` se pinta SOLO como texto (nunca HTML ni Markdown) y ningún enlace sale de él:
// los únicos enlaces son las citas, hacia las fichas de la Ayuda que el usuario puede ver.

type MapaMascara = Parameters<typeof restaurarRespuesta>[1];
type MensajeIa = Extract<MensajeDrFlit, { tipo: 'respuestaIa' }>;

const RE_TOKEN = /\[(PLACA|VIN|DOC|CORREO|TRAMITE)_\d+\]/g;
const OCULTO: Record<string, string> = {
  PLACA: '(placa oculta)', VIN: '(VIN oculto)', DOC: '(documento oculto)', CORREO: '(correo oculto)',
  TRAMITE: '(id FLIT oculto)',
};

/**
 * Texto para la pantalla: con el mapa del envío en memoria, el valor del propio usuario; sin él (tras
 * recargar, o token desconocido), una palabra legible. Nunca un token crudo en el DOM (IA.5).
 */
export function textoVisibleIa(texto: string, mapa: MapaMascara | undefined): string {
  const restaurado = mapa ? restaurarRespuesta(texto, mapa) : texto;
  return restaurado.replace(RE_TOKEN, (_m, tipo: string) => OCULTO[tipo] ?? '');
}

/**
 * Cita de la IA con el render de F3. Sección si el ancla existe en la ficha cargada (`anclaExiste`);
 * si no, la ficha completa en una sola línea. Sin permiso: «Esta referencia ya no está disponible».
 */
function CitaIa({ refFicha, user, fichas, onNavegar }: {
  refFicha: RefFicha; user: UsuarioAyuda | null; fichas: ReadonlyMap<string, FichaParseada | null>; onNavegar: () => void;
}) {
  const entrada = entradaAyudaPorClave(refFicha.clave);
  if (!entrada || !puedeVerEntradaAyuda(user, entrada)) {
    return <p className="px-3 py-2 text-flit-muted">{NO_DISPONIBLE}</p>;
  }
  const ficha = fichas.get(entrada.clave);
  const seccion = ficha && refFicha.ancla
    ? seccionesDeFicha(entrada, ficha).find((s) => s.ancla === refFicha.ancla)
    : undefined;
  return (
    <Link
      to={seccion ? `/flito/ayuda/${entrada.clave}#${seccion.ancla}` : `/flito/ayuda/${entrada.clave}`}
      onClick={onNavegar}
      className={CITA_DRFLIT}
    >
      <span className="min-w-0 flex-1">
        {seccion ? (
          <>
            <span className="block break-words text-xs text-flit-muted">{seccion.tituloFicha}</span>
            <span className="sr-only">, </span>
            <span className="block break-words font-medium text-flit-ink underline-offset-2 group-hover:underline">
              {seccion.tituloSeccion}
            </span>
          </>
        ) : (
          <span className="block break-words font-medium text-flit-ink underline-offset-2 group-hover:underline">
            {entrada.etiqueta}
          </span>
        )}
      </span>
      <span aria-hidden="true" className="shrink-0 text-[color:var(--flit-blue-text)]">→</span>
    </Link>
  );
}

export default function DrFlitRespuestaIa({ mensaje, mapa, user, fichas, onNavegar, onSoporte }: {
  mensaje: MensajeIa;
  mapa: MapaMascara | undefined;
  user: UsuarioAyuda | null;
  fichas: ReadonlyMap<string, FichaParseada | null>;
  onNavegar: () => void;
  onSoporte?: (abridor: string) => void;
}) {
  // `no_claro`: la pregunta de seguimiento, como mensaje normal (sin citas ni marca, AC6).
  if (mensaje.intent === 'no_claro') {
    return (
      <BurbujaDrFlit>
        <p className="whitespace-pre-line break-words">{textoVisibleIa(mensaje.texto ?? '', mapa)}</p>
      </BurbujaDrFlit>
    );
  }
  const conCitas = mensaje.enManuales && mensaje.refs.length > 0;
  if (!conCitas) {
    // AC6: no está en los manuales → Ayuda o soporte (F3/F5).
    return (
      <BurbujaDrFlit>
        <p className="whitespace-pre-line break-words">
          {mensaje.texto ? textoVisibleIa(mensaje.texto, mapa) : 'No encontré eso en sus manuales.'}
        </p>
        <p className="mt-2 text-xs text-flit-secondary">Respondido con IA.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link to="/flito/ayuda" onClick={onNavegar} className={flitBtnSecondarySm}>
            Abrir la Ayuda FLITO
          </Link>
          {onSoporte && <BotonNecesitoSoporte abridor={mensaje.id} onClick={() => onSoporte(mensaje.id)} />}
        </div>
      </BurbujaDrFlit>
    );
  }
  const n = mensaje.refs.length;
  return (
    <BurbujaDrFlit>
      {mensaje.texto && <p className="whitespace-pre-line break-words">{textoVisibleIa(mensaje.texto, mapa)}</p>}
      <span className="sr-only">{n === 1 ? ' Con 1 referencia a sus manuales.' : ` Con ${n} referencias a sus manuales.`}</span>
      <div aria-live="off">
        <p className="mt-3 text-xs text-flit-muted">En sus manuales:</p>
        <ul className="mt-2 flex flex-col gap-2">
          {mensaje.refs.map((r, i) => (
            <li key={`${i}-${r.clave}#${r.ancla ?? ''}`}>
              <CitaIa refFicha={r} user={user} fichas={fichas} onNavegar={onNavegar} />
            </li>
          ))}
        </ul>
      </div>
      <p className="mt-2 text-xs text-flit-secondary">Respondido con IA; confirme en la ficha citada.</p>
    </BurbujaDrFlit>
  );
}
