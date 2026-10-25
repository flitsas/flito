import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle } from 'lucide-react';
import StatusChip from '../flit/StatusChip';
import { flitBtnSecondarySm } from '../flit/flitPageKit';
import { entradaAyudaPorClave, puedeVerEntradaAyuda, type UsuarioAyuda } from '../../lib/ayudaFlito';
import type { FichaParseada } from '../../lib/ayudaFicha';
import {
  estadoReferencia, explicacionDeModulo, type MensajeDrFlit, type RefFicha,
} from '../../lib/drFlitConversacion';
import { seccionesDeFicha } from '../../lib/drFlitBusqueda';
import { esMensajeGestion } from '../../lib/drFlitGestion';
import { DR_FLIT_ASSETS } from './drFlitAssets';
import { COPY_DRFLIT_FUNCIONES } from './drFlitFunciones';

// Dr. Flit — pinta cada mensaje de la conversación (HU #13765; slim §4, spec UX «Explícame un
// módulo»). Viven dentro del `role="log"` del panel: la respuesta se anuncia sin mover el foco (AC5).
// Títulos y resúmenes se derivan aquí desde el catálogo y la ficha ya cargada, nunca del mensaje.
// HU #13766: `pregunta` / `citas` / `sinResultados`; F5 (#13695) cuelga «Necesito soporte» como
// segundo hijo de la fila de acciones de «sin resultados» (`DrFlitSinResultados`).

export const ENLACE_DRFLIT =
  'flit-focus inline-flex items-center gap-1 rounded-md font-medium text-[color:var(--flit-blue-text)] underline-offset-2 transition-colors hover:text-flit-ink hover:underline';

const BURBUJA_DRFLIT = 'rounded-flit-lg border border-flit-soft bg-flit-card p-4 text-sm text-flit-ink';

export function BurbujaDrFlit({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <img
        src={DR_FLIT_ASSETS.header}
        alt=""
        aria-hidden="true"
        width={32}
        height={32}
        loading="lazy"
        className="h-8 w-8 shrink-0 rounded-full object-cover"
      />
      <div className={`min-w-0 flex-1 ${BURBUJA_DRFLIT}`}>
        <span className="sr-only">Dr. Flit: </span>
        {children}
      </div>
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
  /** Texto de la pregunta a la que responde un `sinResultados` (se lee, no se copia al mensaje). */
  textoRespondeA?: string;
  /**
   * HU #13806: «Necesito soporte» en «sin resultados». Sin él (soporte no disponible o aún sin saber)
   * el botón no se pinta. Recibe el id del mensaje para devolverle el foco con «Ahora no».
   */
  onSoporte?: (abridor: string) => void;
  /**
   * HU #13767: el panel está cargando las fichas de una conversación restaurada. Una respuesta cuyas
   * referencias aún no se pueden comprobar pinta «Dr. Flit está buscando…» mientras tanto, y nada si
   * la carga falló (el error con «Reintentar» va al final de la conversación).
   */
  verificando?: boolean;
}

export default function DrFlitMensaje({
  mensaje, user, fichas, onNavegar, textoRespondeA, verificando = false, onSoporte,
}: DrFlitMensajeProps) {
  // HU #13836: oferta, resultado y marcador de gestión los pinta el panel (`gestion/`).
  if (esMensajeGestion(mensaje)) return null;
  // HU #13857: la respuesta de la IA la pinta el panel (`DrFlitRespuestaIa`, necesita el mapa del envío).
  if (mensaje.tipo === 'respuestaIa') return null;
  if (mensaje.tipo === 'casoRadicado') return <DrFlitCasoRadicado numero={mensaje.numero} />;
  // HU #13942: solo el texto (sin enlaces, sin «Reintentar», sin «Necesito soporte»); no es una falla.
  if (mensaje.tipo === 'avisoFuncion') return <DrFlitAvisoFuncion texto={COPY_DRFLIT_FUNCIONES[mensaje.motivo]} />;
  if (mensaje.tipo === 'modulo') {
    const entrada = entradaAyudaPorClave(mensaje.clave);
    return <BurbujaUsuario>Explíqueme {entrada?.etiqueta ?? 'un módulo'}</BurbujaUsuario>;
  }
  if (mensaje.tipo === 'pregunta') return <BurbujaUsuario>{mensaje.texto}</BurbujaUsuario>;
  if (mensaje.tipo === 'citas') {
    if (mensaje.refs.some((r) => estadoReferencia(user, r, fichas) === 'por-verificar')) {
      return verificando ? <DrFlitBuscando /> : null;
    }
    return <DrFlitCitas refs={mensaje.refs} user={user} fichas={fichas} onNavegar={onNavegar} />;
  }
  if (mensaje.tipo === 'sinResultados') {
    return (
      <DrFlitSinResultados
        consulta={textoRespondeA}
        onNavegar={onNavegar}
        onSoporte={onSoporte ? () => onSoporte(mensaje.id) : undefined}
        abridor={mensaje.id}
      />
    );
  }

  // Fail-closed: si el permiso cambió o el ancla ya no existe, no se cita nada de esa ficha (AC5).
  const estado = estadoReferencia(user, mensaje.ref, fichas);
  if (estado === 'por-verificar') return verificando ? <DrFlitBuscando /> : null;
  const entrada = entradaAyudaPorClave(mensaje.ref.clave);
  if (estado === 'no-disponible' || !entrada) {
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

/** HU #13942: Dr. Flit no puede atender lo pedido sin la función; o el saludo vacío (copys 1 y 2). */
export function DrFlitAvisoFuncion({ texto }: { texto: string }) {
  return (
    <BurbujaDrFlit>
      <p className="break-words">{texto}</p>
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

export const NO_DISPONIBLE = 'Esta referencia ya no está disponible';

export const CITA_DRFLIT =
  'flit-focus flex min-h-11 w-full items-center gap-3 rounded-flit-lg border border-flit-soft px-3 py-2 transition-colors hover:bg-[var(--flit-bg-hover)] group';

/** Una cita: título de ficha y de sección derivados de la ficha ya cargada; fail-closed sin permiso o ancla. */
function CitaDrFlit({ refFicha, user, fichas, onNavegar }: {
  refFicha: RefFicha; user: UsuarioAyuda | null; fichas: ReadonlyMap<string, FichaParseada | null>; onNavegar: () => void;
}) {
  const entrada = entradaAyudaPorClave(refFicha.clave);
  const ficha = entrada && puedeVerEntradaAyuda(user, entrada) ? fichas.get(entrada.clave) : undefined;
  const seccion = entrada && ficha && refFicha.ancla
    ? seccionesDeFicha(entrada, ficha).find((s) => s.ancla === refFicha.ancla)
    : undefined;
  if (!entrada || !seccion) return <p className="px-3 py-2 text-flit-muted">{NO_DISPONIBLE}</p>;
  return (
    <Link to={`/flito/ayuda/${entrada.clave}#${seccion.ancla}`} onClick={onNavegar} className={CITA_DRFLIT}>
      <span className="min-w-0 flex-1">
        <span className="block break-words text-xs text-flit-muted">{seccion.tituloFicha}</span>
        <span className="sr-only">, </span>
        <span className="block break-words font-medium text-flit-ink underline-offset-2 group-hover:underline">
          {seccion.tituloSeccion}
        </span>
      </span>
      <span aria-hidden="true" className="shrink-0 text-[color:var(--flit-blue-text)]">→</span>
    </Link>
  );
}

function DrFlitCitas({ refs, user, fichas, onNavegar }: {
  refs: RefFicha[]; user: UsuarioAyuda | null; fichas: ReadonlyMap<string, FichaParseada | null>; onNavegar: () => void;
}) {
  return (
    <BurbujaDrFlit>
      <p>Esto es lo que encontré en sus manuales:</p>
      <ul className="mt-3 flex flex-col gap-2">
        {refs.map((r) => (
          <li key={`${r.clave}#${r.ancla ?? ''}`}>
            <CitaDrFlit refFicha={r} user={user} fichas={fichas} onNavegar={onNavegar} />
          </li>
        ))}
      </ul>
    </BurbujaDrFlit>
  );
}

const MAX_CONSULTA_VISIBLE = 60;

/** Marca del botón que abrió el asistente de soporte: «Ahora no» le devuelve el foco (F5.6). */
export const ATRIBUTO_ABRIDOR_SOPORTE = 'data-drflit-soporte-abridor';

/** HU #13806: «Necesito soporte» (anexo UX F5.1), mismo botón en el saludo y en «sin resultados». */
export function BotonNecesitoSoporte({ abridor, onClick }: { abridor: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={flitBtnSecondarySm} {...{ [ATRIBUTO_ABRIDOR_SOPORTE]: abridor }}>
      Necesito soporte
    </button>
  );
}

/** HU #13806: el caso quedó radicado. Solo el número: sin enlace ni nombre del proyecto (F5.4 J). */
function DrFlitCasoRadicado({ numero }: { numero: number }) {
  return (
    <BurbujaDrFlit>
      <p className="break-words">
        Su caso <span className="font-semibold">#{numero}</span> quedó radicado.
      </p>
      <p className="mt-1 break-words text-flit-secondary">
        El equipo de soporte lo revisará. Guarde este número: es la referencia de su caso.
      </p>
    </BurbujaDrFlit>
  );
}

/** «Sin resultados» (AC5). HU #13806 cuelga «Necesito soporte» como segundo hijo de la fila. */
function DrFlitSinResultados({ consulta, onNavegar, onSoporte, abridor }: {
  consulta?: string; onNavegar: () => void; onSoporte?: () => void; abridor: string;
}) {
  const corta = consulta && consulta.length > MAX_CONSULTA_VISIBLE
    ? `${consulta.slice(0, MAX_CONSULTA_VISIBLE)}…`
    : consulta;
  return (
    <BurbujaDrFlit>
      <p className="break-words">
        {corta ? `No encontré nada sobre "${corta}" en sus manuales.` : 'No encontré nada sobre su pregunta en sus manuales.'}
      </p>
      <p className="mt-1 text-flit-secondary">
        Pruebe con otras palabras, por ejemplo el nombre del módulo o de la pantalla.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Link to="/flito/ayuda" onClick={onNavegar} className={flitBtnSecondarySm}>
          Abrir la Ayuda FLITO
        </Link>
        {onSoporte && <BotonNecesitoSoporte abridor={abridor} onClick={onSoporte} />}
      </div>
    </BurbujaDrFlit>
  );
}

/** Error al revisar los manuales (AC8): «Reintentar» reenvía la misma pregunta. */
export function DrFlitErrorPregunta({ onReintentar }: { onReintentar: () => void }) {
  return (
    <BurbujaDrFlit>
      <div className="flex items-start gap-2">
        <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--flit-danger-ink)]" />
        <div className="min-w-0">
          <p>No pude revisar sus manuales en este momento.</p>
          <p className="mt-1 text-flit-secondary">Revise su conexión e intente de nuevo.</p>
          <button type="button" onClick={onReintentar} className={`${flitBtnSecondarySm} mt-3`}>
            Reintentar
          </button>
        </div>
      </div>
    </BurbujaDrFlit>
  );
}

/** Falla la carga de las fichas al restaurar la conversación (HU #13767, spec UX). */
export function DrFlitErrorRestaurar({ onReintentar }: { onReintentar: () => void }) {
  return (
    <BurbujaDrFlit>
      <div className="flex items-start gap-2">
        <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--flit-danger-ink)]" />
        <div className="min-w-0">
          <p>No pude recuperar las referencias de esta conversación.</p>
          <p className="mt-1 text-flit-secondary">Revise su conexión e intente de nuevo.</p>
          <button type="button" onClick={onReintentar} className={`${flitBtnSecondarySm} mt-3`}>
            Reintentar
          </button>
        </div>
      </div>
    </BurbujaDrFlit>
  );
}
