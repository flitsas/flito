// FLITO — Gestión Trámites · «Acceso a FLIT 2» (HU #13064, Feature #13057).
// Spec UX: `docs/ux/hu-13064-13069-acceso-flit2.md`. Contrato: `Flit2AccesoMeta` (shared-types).
//
// Botón secundario de la cabecera que abre un panel lateral con el estado del acceso con el que
// FLITO entra a FLIT 2 y, con permiso de guardar, el formulario para configurarlo o reemplazarlo.
//
// Reglas del secreto, heredadas de `comparendos/TokenSimitComparendos.tsx` (léelas allí completas):
//   · la contraseña NO se muestra nunca: el contrato ni siquiera la trae;
//   · el input de la contraseña es NO controlado (`ref`, sin `value`), sin `name`, `type=password`
//     y `autoComplete=new-password`: un input controlado escribe el ATRIBUTO `value` y el atributo
//     se serializa en `page.content()`;
//   · el formulario hace `preventDefault()` (un envío nativo lo mandaría por GET a la URL);
//   · el valor solo viaja en el cuerpo del PUT: nada de consola, storage, toast ni copy de error;
//   · los errores del API no se pintan tal cual: el copy es propio y se ramifica por estado/código.
//
// El GET se hace al ABRIR el panel, no al cargar la cola: la página no paga una petición que no usa.
//
// Al guardar (HU #13189, `docs/ux/hu-13189-flit2-en-vivo.md` §AC10): el toast dice qué pasa con la
// lectura automática según `automaticaActiva` (null = no se sabe: la frase neutra, sin promesas) y
// `onGuardado` pide un GET silencioso del estado para que la cabecera vea arrancar la lectura.

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { toastOk } from '../../flit/ToastFlito';
import type { Flit2AccesoMeta, Flit2GuardarAccesoInput } from '@operaciones/shared-types';
import { ApiError, api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import FlitModal from '../../flit/FlitModal';
import StatusChip, { type ChipTone } from '../../flit/StatusChip';
import {
  FlitField, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle, flitInp,
} from '../../flit/flitPageKit';
import { AvisoPruebaFlit2, BotonProbarConexion, usePruebaConexion } from './ProbarConexionFlit2';

const RUTA_ACCESO = '/flito/sync/flit2/acceso';
const FUNCION_VER = 'tramites.flit2.ver_acceso';
const FUNCION_GUARDAR = 'tramites.flit2.guardar_acceso';

/** Topes del servidor, replicados para no gastar un 400 evitable. */
const USUARIO_MAX = 120;
const CLAVE_MAX = 512;
const SIN_DATO = '—';

const fmtHora = new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', hour: 'numeric', minute: '2-digit' });
const fmtFechaHora = new Intl.DateTimeFormat('es-CO', {
  timeZone: 'America/Bogota', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
});

function formatear(iso: string | null, fmt: Intl.DateTimeFormat): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : fmt.format(d);
}

/** Chip de estado: siempre con texto, el tono no se transmite solo con color. */
function chipDe(meta: Flit2AccesoMeta): { tono: ChipTone; texto: string } {
  if (!meta.configurado) return { tono: 'neutral', texto: 'Sin acceso' };
  switch (meta.estado) {
    case 'vigente': return { tono: 'success', texto: 'Vigente' };
    case 'rechazado': return { tono: 'danger', texto: 'Rechazado por FLIT 2' };
    case 'bloqueado': {
      const hora = formatear(meta.bloqueadoHasta, fmtHora);
      return { tono: 'warning', texto: hora ? `En espera hasta las ${hora}` : 'En espera' };
    }
    default: return { tono: 'neutral', texto: 'Sin probar' };
  }
}

function codigoDeError(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const cuerpo = e.rawDetails as { codigo?: unknown } | null | undefined;
  return typeof cuerpo?.codigo === 'string' ? cuerpo.codigo : null;
}

/** Copy propio por caso (AC6). Ninguna rama repite al servidor ni deriva nada de lo escrito. */
function mensajeDeGuardado(e: unknown): { texto: string; conflicto: boolean } {
  if (codigoDeError(e) === 'llave_maestra') {
    return {
      texto: 'El servidor no puede cifrar la contraseña: falta la llave de cifrado. Avísale a quien administra el ambiente.',
      conflicto: false,
    };
  }
  if (e instanceof ApiError && e.status === 400) {
    return {
      texto: `Revisa los datos: el usuario admite hasta ${USUARIO_MAX} caracteres y la contraseña hasta ${CLAVE_MAX}.`,
      conflicto: false,
    };
  }
  if (e instanceof ApiError && e.status === 409) {
    return {
      texto: 'Alguien más guardó el acceso en este momento. Actualiza el estado y vuelve a intentarlo.',
      conflicto: true,
    };
  }
  return { texto: 'No se pudo guardar el acceso a FLIT 2. Vuelve a intentarlo.', conflicto: false };
}

/**
 * La meta con sus estados de carga. Al fallar se BORRA: no queda un «Vigente» sin confirmar.
 * `refrescar` vuelve a pedirla SIN esqueleto (tras «Probar conexión», HU #13069).
 */
function useMetaAcceso() {
  const [meta, setMeta] = useState<Flit2AccesoMeta | null>(null);
  const [estado, setEstado] = useState<'cargando' | 'error' | 'ok'>('cargando');
  const [intento, setIntento] = useState(0);
  const silencioso = useRef(false);

  useEffect(() => {
    let vigente = true;
    if (!silencioso.current) setEstado('cargando');
    silencioso.current = false;
    api.get<Flit2AccesoMeta>(RUTA_ACCESO)
      .then((respuesta) => {
        if (!vigente) return;
        if (typeof respuesta?.configurado !== 'boolean') { setMeta(null); setEstado('error'); return; }
        setMeta(respuesta);
        setEstado('ok');
      })
      .catch(() => {
        if (!vigente) return;
        setMeta(null);
        setEstado('error');
      });
    return () => { vigente = false; };
  }, [intento]);

  const recargar = useCallback(() => setIntento((i) => i + 1), []);
  const refrescar = useCallback(() => { silencioso.current = true; setIntento((i) => i + 1); }, []);
  return { meta, estado, setMeta, recargar, refrescar };
}

function Dato({ etiqueta, children }: { etiqueta: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 py-1.5 sm:grid-cols-[10rem_1fr] sm:gap-3">
      <dt className="text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>{etiqueta}</dt>
      <dd className="text-sm break-words" style={{ color: 'var(--flit-text-primary)' }}>{children}</dd>
    </div>
  );
}

function Esqueleto() {
  return (
    <div aria-busy="true" aria-label="Cargando el acceso a FLIT 2" role="status" className="space-y-3 py-1.5">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="grid gap-1.5 sm:grid-cols-[10rem_1fr] sm:gap-3" aria-hidden="true">
          <div className="h-3 w-24 animate-pulse rounded" style={{ background: 'var(--flit-bg-hover)' }} />
          <div className="h-4 w-40 animate-pulse rounded" style={{ background: 'var(--flit-bg-hover)' }} />
        </div>
      ))}
    </div>
  );
}

function Aviso({ rol, children }: { rol: 'alert' | 'status'; children: ReactNode }) {
  return (
    <div
      role={rol}
      className="rounded-lg px-3 py-2.5 text-sm"
      style={{
        border: '1px solid var(--flit-border-soft)',
        background: 'var(--flit-bg-card)',
        color: rol === 'alert' ? 'var(--flit-danger-ink)' : 'var(--flit-text-primary)',
      }}
    >
      {children}
    </div>
  );
}

/** Toast al guardar según la lectura automática (spec §AC10). ~6 s: son dos frases. */
function toastGuardado(automaticaActiva: boolean | null) {
  const texto = automaticaActiva === true
    ? 'Acceso guardado. La primera lectura empieza en unos segundos; el resultado se ve en el panel de Gestión Trámites.'
    : automaticaActiva === false
      ? 'Acceso guardado. La lectura automática está apagada en este ambiente, así que FLITO no leerá FLIT 2 hasta que quien administra el ambiente la encienda.'
      : 'Acceso a FLIT 2 guardado.';
  toastOk(texto, { id: 'flit2-acceso-guardado', duracionMs: automaticaActiva === null ? 4_000 : 6_000 });
}

interface PropsAcceso {
  /** `automatica.activa` del estado de FLIT 2; null sin `sync.sync.ver_estado` o sin estado cargado. */
  automaticaActiva?: boolean | null;
  /** Tras guardar un acceso válido: GET silencioso del estado. */
  onGuardado?: () => void;
  /** HU #13238: clases extra del botón (ancho completo en móvil dentro de la sección Sincronización). */
  claseBoton?: string;
}

function PanelAccesoFlit2({ onCerrar, automaticaActiva = null, onGuardado }: PropsAcceso & { onCerrar: () => void }) {
  const { hasFuncion } = useAuth();
  const puedeGuardar = hasFuncion(FUNCION_GUARDAR);
  const { meta, estado, setMeta, recargar, refrescar } = useMetaAcceso();
  const prueba = usePruebaConexion(refrescar);

  const [usuario, setUsuario] = useState('');
  /** La contraseña vive en el NODO, nunca en estado de React (ver cabecera). */
  const claveRef = useRef<HTMLInputElement | null>(null);
  const [errUsuario, setErrUsuario] = useState<string | null>(null);
  const [errClave, setErrClave] = useState<string | null>(null);
  const [errorGuardar, setErrorGuardar] = useState<{ texto: string; conflicto: boolean } | null>(null);
  const [guardando, setGuardando] = useState(false);

  const guardar = async (e: FormEvent) => {
    e.preventDefault();
    if (guardando) return;
    const campo = claveRef.current;
    const clave = campo?.value ?? '';
    const usuarioLimpio = usuario.trim();
    const eu = usuarioLimpio === '' ? 'Escribe el usuario de servicio.'
      : usuarioLimpio.length > USUARIO_MAX ? `El usuario admite hasta ${USUARIO_MAX} caracteres.` : null;
    // Contra la cadena vacía, no contra `trim()`: recortar un secreto es adivinar.
    const ec = clave === '' ? 'Escribe la contraseña.'
      : clave.length > CLAVE_MAX ? `La contraseña admite hasta ${CLAVE_MAX} caracteres.` : null;
    setErrUsuario(eu);
    setErrClave(ec);
    setErrorGuardar(null);
    if (eu || ec) return;
    setGuardando(true);
    try {
      const cuerpo: Flit2GuardarAccesoInput = { clientId: usuarioLimpio, clientSecret: clave };
      const actualizada = await api.put<Flit2AccesoMeta>(RUTA_ACCESO, cuerpo);
      // Primero se vacían los campos (AC4): el secreto sale de pantalla aunque lo que sigue lance.
      if (campo) campo.value = '';
      setUsuario('');
      setMeta(actualizada);
      prueba.limpiar(); // el aviso era del acceso anterior
      toastGuardado(automaticaActiva);
      onGuardado?.();
    } catch (err) {
      // Se conserva lo escrito (el input no controlado lo conserva solo); el copy es propio.
      setErrorGuardar(mensajeDeGuardado(err));
    } finally {
      setGuardando(false);
    }
  };

  const chip = meta ? chipDe(meta) : null;

  return (
    <FlitModal title="Acceso a FLIT 2" onClose={onCerrar} lateral cierreBloqueado={guardando || prueba.probando}>
      <div className="h-full space-y-4 overflow-y-auto pb-2">
        <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          Con qué usuario entra FLITO a FLIT 2 para leer sus trámites. La contraseña se cifra al guardar
          y no vuelve a mostrarse.
        </p>

        {estado === 'cargando' && <Esqueleto />}

        {estado === 'error' && (
          <Aviso rol="alert">
            <p>No se pudo consultar el acceso a FLIT 2. Vuelve a intentarlo.</p>
            <button type="button" className={`${flitBtnSecondary} mt-2 w-full sm:w-auto`} style={flitBtnSecondaryStyle}
              onClick={recargar}>
              Reintentar
            </button>
          </Aviso>
        )}

        {estado === 'ok' && meta && chip && (
          <>
            <dl>
              <Dato etiqueta="Estado"><StatusChip tone={chip.tono}>{chip.texto}</StatusChip></Dato>
              {meta.configurado && (
                <>
                  <Dato etiqueta="Usuario de servicio">{meta.clientId ?? SIN_DATO}</Dato>
                  <Dato etiqueta="Guardado por">{meta.actualizadoPor?.nombre ?? SIN_DATO}</Dato>
                  <Dato etiqueta="Desde">{formatear(meta.actualizadoEn, fmtFechaHora) ?? SIN_DATO}</Dato>
                </>
              )}
            </dl>

            {!meta.configurado && (
              <Aviso rol="status">
                <p>FLITO aún no tiene acceso a FLIT 2 en este ambiente.</p>
                <p className="mt-1" style={{ color: 'var(--flit-text-secondary)' }}>
                  {puedeGuardar
                    ? 'Escribe el usuario de servicio y la contraseña que entregó FLIT 2.'
                    : 'Pídele a un administrador con permiso de guardar el acceso que lo configure.'}
                </p>
              </Aviso>
            )}

            {/* HU #13069: «Probar conexión» (secundario, solo con «guardar» y `configurado: true`; sin
                acceso no se pinta ni deshabilitado) y su aviso, junto a la ficha que comprueban. El
                aviso sobrevive a un `sin_acceso`, que deja la ficha sin botón. */}
            {puedeGuardar && meta.configurado && (
              <BotonProbarConexion probando={prueba.probando} onProbar={() => { void prueba.probar(); }} />
            )}
            {prueba.aviso && <AvisoPruebaFlit2 aviso={prueba.aviso} />}

            {puedeGuardar && (
              <form onSubmit={guardar} noValidate className="space-y-3 pt-4"
                style={{ borderTop: '1px solid var(--flit-border-soft)' }} aria-labelledby="flit2-acceso-form-titulo">
                <h3 id="flit2-acceso-form-titulo" className="text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>
                  {meta.configurado ? 'Reemplazar acceso' : 'Configurar acceso'}
                </h3>
                <FlitField label="Usuario de servicio">
                  <input
                    id="flit2-acceso-usuario"
                    className={flitInp}
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={USUARIO_MAX}
                    value={usuario}
                    onChange={(e) => setUsuario(e.target.value)}
                    aria-invalid={errUsuario ? true : undefined}
                    aria-describedby={errUsuario ? 'flit2-acceso-usuario-error' : undefined}
                  />
                </FlitField>
                {errUsuario && (
                  <p id="flit2-acceso-usuario-error" className="text-xs" style={{ color: 'var(--flit-danger-ink)' }}>{errUsuario}</p>
                )}
                <FlitField label="Contraseña">
                  {/* No controlado, sin `name` y sin `maxLength` (el recorte de un secreto no se ve). */}
                  <input
                    id="flit2-acceso-clave"
                    ref={claveRef}
                    className={flitInp}
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    aria-invalid={errClave ? true : undefined}
                    aria-describedby={errClave ? 'flit2-acceso-clave-error flit2-acceso-ayuda' : 'flit2-acceso-ayuda'}
                  />
                </FlitField>
                {errClave && (
                  <p id="flit2-acceso-clave-error" className="text-xs" style={{ color: 'var(--flit-danger-ink)' }}>{errClave}</p>
                )}
                <p id="flit2-acceso-ayuda" className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
                  Los campos se vacían al guardar. No pegues la contraseña en chats ni la dejes en capturas.
                </p>
                {errorGuardar && (
                  <Aviso rol="alert">
                    <p>{errorGuardar.texto}</p>
                    {errorGuardar.conflicto && (
                      <button type="button" className={`${flitBtnSecondary} mt-2 w-full sm:w-auto`} style={flitBtnSecondaryStyle}
                        onClick={() => { setErrorGuardar(null); recargar(); }}>
                        Actualizar estado
                      </button>
                    )}
                  </Aviso>
                )}
                <div className="flex justify-end">
                  <button type="submit" className={`${flitBtnPrimary} w-full sm:w-auto`} style={flitBtnPrimaryStyle}
                    disabled={guardando} aria-busy={guardando}>
                    {guardando ? 'Guardando…' : 'Guardar acceso'}
                  </button>
                </div>
              </form>
            )}
          </>
        )}
      </div>
    </FlitModal>
  );
}

/**
 * Botón de la cabecera de Gestión Trámites (AC1): solo existe con «Ver el acceso a FLIT 2». El panel
 * se monta al pulsarlo, y con él la consulta del estado.
 */
export default function AccesoFlit2({ automaticaActiva = null, onGuardado, claseBoton = '' }: PropsAcceso) {
  const { hasFuncion } = useAuth();
  const [abierto, setAbierto] = useState(false);
  if (!hasFuncion(FUNCION_VER)) return null;
  return (
    <>
      <button type="button" className={`${flitBtnSecondary} ${claseBoton}`} style={flitBtnSecondaryStyle} onClick={() => setAbierto(true)}>
        Acceso a FLIT 2
      </button>
      {abierto && <PanelAccesoFlit2 onCerrar={() => setAbierto(false)} automaticaActiva={automaticaActiva} onGuardado={onGuardado} />}
    </>
  );
}
