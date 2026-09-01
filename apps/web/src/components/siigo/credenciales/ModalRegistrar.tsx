// Alta de una credencial de Siigo (HU #11890, AC1 y AC2).
//
// Tres decisiones que se leen mal si no se dicen:
//
//   1. **El ambiente NO es un campo.** Va en el título y viaja desde la tarjeta que abrió el modal.
//      El error más caro de esta pantalla es registrar en producción una llave de pruebas, y un
//      `<select>` con valor por defecto es la forma estándar de cometerlo.
//   2. **El formulario nunca se inicializa desde una credencial del listado.** El listado devuelve
//      `accessKey: '••••••••'` —constante fija de ocho caracteres— y precargarlo pasaría el
//      `min(8)` del servidor guardando una credencial basura. Por eso no existe «editar»: para
//      cambiar la llave se registra otra, que es justo lo que hace el backend.
//   3. **Lo tecleado NO se pierde cuando el guardado falla** (ni en el 400, ni en el 503, ni en el
//      403, ni con la red caída). Solo se borra al recibir el 201. Obligar a volver a pegar una
//      llave de 300 caracteres porque al servidor le falta una variable de entorno es castigar a
//      quien no tiene la culpa.
//
// Regla 14 de AGENTS.md: el access key vive SOLO en el estado de este componente. Ni URL, ni
// `localStorage`, ni `sessionStorage`, ni `data-*`, ni un `console.log` del formulario —`{...form}`
// lleva la llave dentro—.

import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { ApiError, api, errorMessage } from '../../../lib/api';
import FlitModal from '../../flit/FlitModal';
import GradientButton from '../../flit/GradientButton';
import { flitBtnSecondary, flitBtnSecondaryStyle } from '../../flit/flitPageKit';
import { inputCls } from '../estilos';
import {
  ACCESS_KEY_MAX, ACCESS_KEY_MIN, AMBIENTE_EN_FRASE, ETIQUETA_AMBIENTE, NOTAS_MAX,
  USUARIO_MAX, USUARIO_MIN, type Ambiente, type SiigoCredencialPublica,
} from './tipos';

interface Props {
  ambiente: Ambiente;
  /** La activa de ESTE ambiente, si la hay: es a quien se va a reemplazar (AC1). */
  activa: SiigoCredencialPublica | null;
  onCerrar: () => void;
  /** Se llamó al 201: la pantalla recarga el listado y anuncia el éxito. */
  onRegistrada: () => void;
  /** 503 `codigo:'llave_maestra'`: enciende el banner de entorno de la página. */
  onLlaveMaestraRota: () => void;
  /** Dónde dejar el foco si el botón que abrió el modal ya no está: el título de la tarjeta. */
  restoreFocusRef: RefObject<HTMLElement | null>;
}

const MSG_USUARIO = `El usuario debe tener entre ${USUARIO_MIN} y ${USUARIO_MAX} caracteres.`;
const MSG_ACCESS_KEY = `La access key debe tener entre ${ACCESS_KEY_MIN} y ${ACCESS_KEY_MAX} caracteres.`;
const MSG_NOTAS = `Las notas no pueden pasar de ${NOTAS_MAX} caracteres.`;

type Campo = 'username' | 'accessKey' | 'notas';

export default function ModalRegistrar(
  { ambiente, activa, onCerrar, onRegistrada, onLlaveMaestraRota, restoreFocusRef }: Props,
) {
  const [username, setUsername] = useState('');
  const [accessKey, setAccessKey] = useState('');
  const [notas, setNotas] = useState('');
  const [mostrar, setMostrar] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [errores, setErrores] = useState<Partial<Record<Campo, string>>>({});
  const [alerta, setAlerta] = useState<string | null>(null);
  /** Tras un 503 de llave maestra, reintentar sin que nadie toque el servidor da otro 503. */
  const [bloqueado, setBloqueado] = useState(false);

  const refUsuario = useRef<HTMLInputElement>(null);
  const refAccessKey = useRef<HTMLInputElement>(null);
  const refNotas = useRef<HTMLTextAreaElement>(null);
  const refAlerta = useRef<HTMLParagraphElement>(null);

  // El foco entra por el campo Usuario y no por el secreto: enfocar de entrada un campo enmascarado
  // invita a pegar sin haber leído la advertencia que está justo debajo. La trampa de foco de
  // FlitModal ya corrió (efecto de un componente hijo), así que esto la remata sin pelearse con ella.
  useEffect(() => { refUsuario.current?.focus(); }, []);

  const base = `siigo-cred-${ambiente}`;
  const idUsuario = `${base}-usuario`;
  const idAccessKey = `${base}-access-key`;
  const idNotas = `${base}-notas`;
  const idAyudaUsuario = `${idUsuario}-ayuda`;
  const idAyudaAccessKey = `${idAccessKey}-ayuda`;
  const idAyudaNotas = `${idNotas}-ayuda`;

  const enfocar = (campo: Campo) => {
    if (campo === 'username') refUsuario.current?.focus();
    else if (campo === 'accessKey') refAccessKey.current?.focus();
    else refNotas.current?.focus();
  };

  const validar = (): Partial<Record<Campo, string>> => {
    const e: Partial<Record<Campo, string>> = {};
    const u = username.trim();
    if (u.length < USUARIO_MIN || u.length > USUARIO_MAX) e.username = MSG_USUARIO;
    // La access key NO se recorta: el esquema del servidor es `z.string().min(8)` sin `trim`, y
    // recortar por nuestra cuenta cambiaría un secreto que quizá tiene un carácter significativo al
    // borde. Si sobra un espacio pegado, lo dirá «Probar conexión» con `credenciales_rechazadas`.
    if (accessKey.length < ACCESS_KEY_MIN || accessKey.length > ACCESS_KEY_MAX) e.accessKey = MSG_ACCESS_KEY;
    if (notas.length > NOTAS_MAX) e.notas = MSG_NOTAS;
    return e;
  };

  const guardar = async (ev: FormEvent) => {
    ev.preventDefault();
    if (guardando || bloqueado) return;

    const locales = validar();
    setErrores(locales);
    const primero = (['username', 'accessKey', 'notas'] as Campo[]).find((c) => locales[c]);
    if (primero) { enfocar(primero); return; }

    setAlerta(null);
    setGuardando(true);
    // Al enviar, el secreto vuelve a ocultarse: a partir de aquí ya no hay nada que verificar a ojo.
    setMostrar(false);
    try {
      await api.post('/siigo/credenciales', {
        // `trim()` en el usuario porque el servidor hace `z.string().trim()`; en la clave, no.
        ambiente,
        username: username.trim(),
        accessKey,
        ...(notas.trim() ? { notas: notas.trim() } : {}),
      });
      // Solo aquí se borra el secreto de memoria.
      setAccessKey('');
      setUsername('');
      setNotas('');
      onRegistrada();
    } catch (e) {
      const api503 = e instanceof ApiError
        && e.status === 503
        && (e.rawDetails as { codigo?: string } | null)?.codigo === 'llave_maestra';
      if (api503) {
        // Lenguaje de ENTORNO, distinto del 400 de datos: no se guardó nada y no hay nada que
        // corregir en lo que se escribió.
        setAlerta('No se guardó nada. Falta la llave maestra de cifrado del servidor '
          + '(SIIGO_ENC_KEY): es un problema del entorno, no de lo que escribiste. Lo resuelve '
          + 'quien administra el servidor.');
        setBloqueado(true);
        onLlaveMaestraRota();
      } else if (e instanceof ApiError && e.status === 400) {
        const fe = e.fieldErrors ?? {};
        const nuevos: Partial<Record<Campo, string>> = {};
        if (fe.username) nuevos.username = MSG_USUARIO;
        if (fe.accessKey) nuevos.accessKey = MSG_ACCESS_KEY;
        if (fe.notas) nuevos.notas = MSG_NOTAS;
        const otros = Object.keys(fe).filter((k) => !['username', 'accessKey', 'notas'].includes(k));
        setErrores(nuevos);
        const campo = (['username', 'accessKey', 'notas'] as Campo[]).find((c) => nuevos[c]);
        // Resumen SIEMPRE, y el detalle bajo cada campo. Nunca el JSON crudo de `details`: lo que
        // no tiene campo en pantalla se queda en esta frase, que además es lo que distingue este
        // fallo —de DATOS— del 503 de entorno de arriba.
        setAlerta(
          otros.length > 0
            // El `ambiente` no se edita aquí: si el servidor lo rechaza, decir «revisa los campos»
            // mandaría a corregir algo que no está en pantalla.
            ? 'El servidor rechazó los datos, incluido algo que este formulario no edita. Vuelve a abrirlo desde la tarjeta del ambiente.'
            : campo
              ? 'El servidor rechazó los datos. Revisa lo que está marcado bajo cada campo.'
              : 'El servidor rechazó los datos. Revisa el usuario y la access key.',
        );
        if (campo) enfocar(campo);
      } else if (e instanceof ApiError && e.status === 403) {
        setAlerta('Tu usuario no tiene permiso para registrar credenciales.');
      } else {
        setAlerta(`No se pudo guardar: ${errorMessage(e)}.`);
      }
    } finally {
      setGuardando(false);
    }
  };

  // El foco va a la alerta solo cuando NO hay un campo marcado: si lo hay, el sitio donde se
  // corrige es el campo, y llevar allí es más útil que llevar al resumen.
  useEffect(() => {
    if (alerta && Object.keys(errores).length === 0) refAlerta.current?.focus();
  }, [alerta, errores]);

  const esProduccion = ambiente === 'produccion';

  return (
    <FlitModal
      title={`Registrar credencial · ${ETIQUETA_AMBIENTE[ambiente]}`}
      onClose={onCerrar}
      wide
      restoreFocusRef={restoreFocusRef}
    >
      <form onSubmit={guardar} className="flex flex-col gap-4" noValidate>
        <div
          className="px-4 py-3 text-sm"
          style={{
            borderRadius: 'var(--flit-radius-card)',
            borderLeft: `4px solid ${esProduccion ? 'var(--flit-danger)' : 'var(--flit-border-input)'}`,
            background: 'white',
            color: 'var(--flit-text-primary)',
          }}
        >
          <p style={esProduccion ? { color: 'var(--flit-danger-ink)', fontWeight: 600 } : undefined}>
            {esProduccion && <span aria-hidden="true">⚠ </span>}
            {esProduccion
              ? 'Vas a registrar la credencial de PRODUCCIÓN. Desde que guardes, es la que FLITO usará para emitir facturas ante la DIAN.'
              : 'Es el ambiente de pruebas: nada de lo que se emita aquí llega a la DIAN.'}
          </p>
          {/* Solo si hay una activa: advertir de un reemplazo que no existe sería ruido. */}
          {activa && (
            <p className="mt-2">
              Reemplaza a la credencial activa de {activa.username}, que quedará desactivada. El
              historial se conserva.
            </p>
          )}
        </div>

        <div>
          <label htmlFor={idUsuario} className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
            Usuario de Siigo *
          </label>
          <input
            id={idUsuario}
            ref={refUsuario}
            className={inputCls}
            value={username}
            maxLength={USUARIO_MAX}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-invalid={Boolean(errores.username)}
            aria-describedby={idAyudaUsuario}
            onChange={(e) => setUsername(e.target.value)}
          />
          <p
            id={idAyudaUsuario}
            role={errores.username ? 'alert' : undefined}
            className="mt-1 text-xs"
            style={{ color: errores.username ? 'var(--flit-danger-ink)' : 'var(--flit-text-secondary)' }}
          >
            {errores.username ?? `El usuario de la cuenta de Siigo Nube. Entre ${USUARIO_MIN} y ${USUARIO_MAX} caracteres.`}
          </p>
        </div>

        <div>
          <label htmlFor={idAccessKey} className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
            Access key *
          </label>
          <div className="flex items-start gap-2">
            <input
              id={idAccessKey}
              ref={refAccessKey}
              // Enmascarado por defecto: esta pantalla se usa casi siempre acompañado (soporte de
              // Siigo al lado, pantalla compartida), así que el valor por defecto es el seguro.
              type={mostrar ? 'text' : 'password'}
              className={inputCls}
              value={accessKey}
              maxLength={ACCESS_KEY_MAX}
              // `name` que NO dice «password»: reduce la heurística del gestor del navegador. No la
              // elimina — de ahí la nota del pie.
              name="siigo-access-key"
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              data-lpignore="true"
              aria-invalid={Boolean(errores.accessKey)}
              aria-describedby={idAyudaAccessKey}
              onChange={(e) => setAccessKey(e.target.value)}
              // Se re-enmascara al SALIR del campo, que es exactamente cuando aparece el riesgo de
              // la mirada ajena. Sin temporizadores: un campo que cambia solo mientras lo miras es
              // un fantasma que nadie sabe explicar.
              onBlur={() => setMostrar(false)}
            />
            <button
              type="button"
              aria-pressed={mostrar}
              onClick={() => setMostrar((v) => !v)}
              className={`${flitBtnSecondary} shrink-0`}
              style={flitBtnSecondaryStyle}
            >
              <span aria-hidden="true">👁 </span>
              {mostrar ? 'Ocultar' : 'Mostrar'}
              <span className="sr-only"> la access key</span>
            </button>
          </div>
          <p
            id={idAyudaAccessKey}
            role={errores.accessKey ? 'alert' : undefined}
            className="mt-1 text-xs"
            style={{ color: errores.accessKey ? 'var(--flit-danger-ink)' : 'var(--flit-text-secondary)' }}
          >
            {errores.accessKey
              ?? `Se genera en Siigo Nube, en Configuración › API. Entre ${ACCESS_KEY_MIN} y ${ACCESS_KEY_MAX} caracteres.`}
          </p>
          <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
            <span aria-hidden="true">🔒 </span>
            Se cifra al guardar y NO se puede volver a consultar desde FLITO. Si la pierdes, genera
            una nueva en Siigo Nube y regístrala otra vez.
          </p>
        </div>

        <div>
          <label htmlFor={idNotas} className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
            Notas (opcional)
          </label>
          <textarea
            id={idNotas}
            ref={refNotas}
            className={inputCls}
            rows={2}
            value={notas}
            maxLength={NOTAS_MAX}
            autoComplete="off"
            aria-invalid={Boolean(errores.notas)}
            aria-describedby={idAyudaNotas}
            onChange={(e) => setNotas(e.target.value)}
          />
          <p
            id={idAyudaNotas}
            role={errores.notas ? 'alert' : undefined}
            className="mt-1 text-xs"
            style={{ color: errores.notas ? 'var(--flit-danger-ink)' : 'var(--flit-text-secondary)' }}
          >
            {errores.notas ?? 'Para recordar de qué cuenta es. No escribas aquí la clave.'}
            {' '}{notas.length}/{NOTAS_MAX}
          </p>
        </div>

        {alerta && (
          <p
            ref={refAlerta}
            role="alert"
            tabIndex={-1}
            className="flit-focus rounded px-1 text-sm font-semibold"
            style={{ color: 'var(--flit-danger-ink)' }}
          >
            <span aria-hidden="true">⚠ </span>{alerta}
          </p>
        )}

        <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
          Es una llave de la empresa: no la guardes en el gestor de contraseñas de tu navegador
          personal.
        </p>

        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onCerrar} className={flitBtnSecondary} style={flitBtnSecondaryStyle}>
            Cancelar
          </button>
          <GradientButton type="submit" disabled={guardando || bloqueado}>
            {guardando ? 'Guardando…' : 'Guardar y cifrar'}
            <span className="sr-only"> la credencial de {AMBIENTE_EN_FRASE[ambiente]}</span>
          </GradientButton>
        </div>
      </form>
    </FlitModal>
  );
}
