// FLITO — Comparendos · Configuración: bloque 4, token SIMIT (HU #11634, AC3 y AC4).
//
// ══════════════════════════════════════════════════════════════════════════════════════════════
// EL TOKEN ES DE ESCRITURA Y NADA MÁS
//
// Este bloque no muestra el token. Ni entero, ni recortado, ni «••••ab12». El enunciado del Feature
// dice «enmascarado» y el contrato manda sobre él: `ComparendosTokenSimitMeta` no tiene campo
// `token`, el `GET` no lo devuelve y el `PUT` responde la misma meta sin eco (ADR-0002). Un prefijo
// sigue siendo material de la credencial, así que aquí no hay nada que enmascarar: lo que se pinta
// es si está configurado, quién lo tocó, cuándo y bajo qué versión de llave.
//
// De ahí salen cuatro reglas que se ven en el código y conviene leer antes de tocarlo:
//
//   1. **No hay control de «ver el actual».** No es que esté oculto: no existe el dato con el que
//      pintarlo. Añadirlo exigiría cambiar el API, y el API dice que no.
//   2. **El campo se vacía al guardar con éxito** (AC3). Un token que se queda en pantalla acaba en
//      una captura, en un portapapeles o en la sesión de escritorio compartido de al lado.
//   3. **El valor no viaja a ningún sitio que no sea el cuerpo del `PUT`.** No hay `console.*`, no
//      hay `localStorage`/`sessionStorage`, no entra en la URL, no entra en el toast ni en el texto
//      de ningún error. Dos detalles del marcado sostienen lo de la URL: el `onSubmit` hace
//      `preventDefault()` —un envío nativo mandaría el formulario por GET y dejaría el secreto en la
//      barra de direcciones— y el input **no lleva `name`**, así que ni siquiera un envío nativo que
//      se escapara podría serializarlo. El segundo detalle es redundante a propósito.
//   3.bis **Y tampoco al DOM SERIALIZADO**, que es el canal que se nos escapó en la primera versión
//      y que el gate de seguridad hizo bien en no dar por bueno sin medirlo. El input es **no
//      controlado** (`ref`, sin `value` ni `defaultValue`): con un input controlado, React 18
//      escribe el valor en el ATRIBUTO `value` además de en la propiedad, y el atributo sí aparece
//      en `outerHTML` / `document.documentElement.outerHTML`. Medido, no supuesto: con `value={…}`
//      el TC30 encontraba `value="tok-simit-DEMO-…"` en `page.content()` mientras el token estaba
//      escrito —que es justo el rato largo, porque tras un 429 se conserva a propósito—. Eso es lo
//      que copia un «Guardar como…», lo que se lleva un informe de error automático y lo que lee
//      cualquier extensión con permiso sobre la página. Al no estar controlado, lo tecleado vive
//      solo en la propiedad del nodo y no se serializa. **No lo vuelvas a hacer controlado**: TC30
//      lo vigila.
//   4. **Los errores del servidor no se pintan tal cual.** Se ramifica por `codigo` y por estado, y
//      el copy es nuestro (misma postura que la #11559). Además de la razón de siempre —el mensaje
//      del API cambia—, aquí hay otra: cuanto menos se reproduzca de la respuesta, menos posibilidad
//      hay de que un día se cuele en pantalla algo derivado de la credencial.
// ══════════════════════════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import toast from 'react-hot-toast';
import type { ComparendosTokenSimitMeta } from '@operaciones/shared-types';
import { ApiError, api } from '../../../lib/api';
import StatusChip from '../../flit/StatusChip';
import { FlitField, flitBtnPrimary, flitBtnPrimaryStyle, flitInp } from '../../flit/flitPageKit';
import { BloqueConfig, ErrorFormulario, RUTA_COMPARENDOS } from './bloqueConfigComparendos';
import { SIN_DATO, fechaHoraColombia } from './formato';
import { codigoDeError } from './useComparendoDetalle';

const RUTA_TOKEN = `${RUTA_COMPARENDOS}/config/token-simit`;

/** Lo que admite `tokenSimitSchema` en el servidor. Se replica para no gastar un 400 evitable. */
const TOKEN_MAX = 2048;

/**
 * La meta del token, con los mismos tres estados que un catálogo — pero **no** con
 * `useCatalogoConfig`.
 *
 * Aquel hook es para LISTAS: comprueba `Array.isArray` y publica `[]` ante cualquier otra cosa, así
 * que servido con el objeto de la meta lo tomaría por un cuerpo inesperado, lo convertiría en lista
 * vacía y anunciaría `ok`. La pantalla diría «Sin configurar» sobre un token que sí está puesto, que
 * es exactamente el fallo que este bloque no se puede permitir. Lo que sí se conserva es su forma
 * —estado, reintento, y la petición aislada del resto de bloques— y su cuidado: al fallar, la meta
 * se BORRA en vez de dejar en pantalla un «Configurado» que ya nadie puede confirmar.
 */
function useMetaToken() {
  const [meta, setMeta] = useState<ComparendosTokenSimitMeta | null>(null);
  const [estado, setEstado] = useState<'cargando' | 'error' | 'ok'>('cargando');
  const [intento, setIntento] = useState(0);

  useEffect(() => {
    let vigente = true;
    setEstado('cargando');
    api.get<ComparendosTokenSimitMeta>(RUTA_TOKEN)
      .then((respuesta) => {
        if (!vigente) return;
        // `configurado` es lo único que se exige para dar la respuesta por buena: es el campo del
        // que cuelga todo lo que se pinta, y un cuerpo sin él no es una meta.
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
  return { meta, estado, setMeta, recargar };
}

/**
 * Copy accionable por caso (AC4). Cada rama dice qué hacer, y ninguna repite al servidor.
 *
 * El 429 sale del limitador PROPIO de la ruta (10/min y usuario), no del global: por eso su texto
 * habla del token y no de «peticiones».
 */
function mensajeDeGuardado(e: unknown): string {
  if (codigoDeError(e) === 'llave_maestra') {
    return 'El servidor no puede cifrar el token: falta la llave de cifrado del módulo. Avisa a '
      + 'quien administra el ambiente.';
  }
  if (e instanceof ApiError && e.status === 429) {
    return 'Ya se actualizó el token varias veces en el último minuto. Espera un minuto.';
  }
  if (e instanceof ApiError && e.status === 400) {
    return `Revisa el token: admite entre 1 y ${TOKEN_MAX} caracteres.`;
  }
  if (e instanceof ApiError && e.status === 503) {
    return 'El servidor no pudo guardar el token por un problema de configuración del ambiente. '
      + 'Avisa a quien lo administra.';
  }
  return 'No se pudo guardar el token SIMIT. Vuelve a intentarlo.';
}

/** Una fila de la ficha: etiqueta a la izquierda, dato a la derecha. Mismo patrón que el detalle. */
function Dato({ etiqueta, children }: { etiqueta: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 py-1.5 sm:grid-cols-[13rem_1fr] sm:gap-3">
      <dt className="text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{etiqueta}</dt>
      <dd className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>{children}</dd>
    </div>
  );
}

export default function TokenSimitComparendos() {
  const { meta, estado, setMeta, recargar } = useMetaToken();
  /**
   * El token vive en el NODO, no en el estado de React (ver regla 3.bis de la cabecera).
   *
   * Es la única excepción del módulo a «los formularios son controlados», y el motivo es medible:
   * un input controlado refleja su valor al atributo `value` del DOM y el atributo se serializa.
   * Aquí no hay nada que el render necesite saber de lo tecleado —no se valida al vuelo, no se
   * habilita ni deshabilita nada con ello, no se pinta en ninguna parte—, así que subirlo a estado
   * solo aportaba el canal de fuga.
   */
  const campoRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const guardar = async (e: FormEvent) => {
    e.preventDefault();
    const campo = campoRef.current;
    // `?? ''` y no un `if (!campo) return`: sin nodo no hay nada escrito, que es exactamente el caso
    // que la primera validación ya sabe explicar. Una salida silenciosa dejaría el botón pulsado sin
    // que pasara nada visible.
    const escrito = campo?.value ?? '';
    // La comparación es contra la cadena vacía y NO contra `escrito.trim()`: el servidor no recorta
    // (`tokenSimitSchema` no lleva `.trim()`, y con razón — recortar un secreto es adivinar), así
    // que un token con espacios significativos es un token válido y no se le puede negar el envío.
    if (escrito === '') { setError('Escribe el token nuevo antes de guardar.'); return; }
    if (escrito.length > TOKEN_MAX) { setError(`El token admite hasta ${TOKEN_MAX} caracteres.`); return; }
    setError(null);
    setOcupado(true);
    try {
      const actualizada = await api.put<ComparendosTokenSimitMeta>(RUTA_TOKEN, { token: escrito });
      // El orden importa: primero se BORRA el valor del campo y después todo lo demás (AC3).
      // Hacerlo lo primero deja el secreto fuera de la pantalla aunque algo de lo que sigue lance.
      if (campo) campo.value = '';
      setError(null);
      // El `PUT` responde la meta ya actualizada: parcharla en sitio es el «refrescar» del AC3 sin
      // una segunda petición que devolvería exactamente lo mismo.
      setMeta(actualizada);
      toast.success('Token SIMIT guardado.');
    } catch (err) {
      // El valor escrito NO se limpia al fallar: reescribir un token de mil caracteres a mano por
      // un 429 sería castigar al operador por un límite que no es suyo. Con el input no controlado
      // esto es, además, lo que ocurre solo: no tocarlo es conservarlo. Y lo que se pinta es el copy
      // propio, jamás algo derivado de lo escrito.
      setError(mensajeDeGuardado(err));
    } finally {
      setOcupado(false);
    }
  };

  return (
    <BloqueConfig
      titulo="Token SIMIT"
      descripcion={
        'Credencial de Verifik. Se cifra al guardar y no vuelve a mostrarse: ni completa ni '
        + 'enmascarada. Aquí solo ves si está configurado, quién lo tocó y cuándo.'
      }
      // Sin acción en la cabecera: la única que hay es [Guardar token], y vive junto al campo que
      // guarda. Un botón arriba, lejos del input, no tendría qué enviar.
      accion={null}
      estado={estado}
      // El bloque no tiene estado «vacío»: `configurado: false` es el estado LLENO sin secreto (spec
      // de UX § bloque 4). Pintar un `FlitEmpty` ahí escondería el formulario justo cuando es lo
      // único que hace falta — configurar el token por primera vez.
      hayItems={meta !== null}
      vacio={null}
      textoError="No se pudo consultar el estado del token SIMIT. Vuelve a intentarlo."
      etiquetaCarga="Cargando estado del token SIMIT"
      filasCarga={3}
      onReintentar={recargar}
    >
      {meta && (
        <div className="space-y-5">
          <dl className="max-w-3xl divide-y" style={{ borderColor: 'var(--flit-border-soft)' }}>
            <Dato etiqueta="Estado">
              {/* La etiqueta va DENTRO del chip: el punto de color es decorativo y `aria-hidden`, así
                  que sin texto el estado quedaría dicho solo por el color. */}
              <StatusChip tone={meta.configurado ? 'success' : 'neutral'}>
                {meta.configurado ? 'Configurado' : 'Sin configurar'}
              </StatusChip>
            </Dato>
            {/* Sin token no hay fecha, ni autor, ni versión de llave que enseñar: las tres filas
                dirían «—» tres veces y el estado ya lo dijo todo (spec de UX § bloque 4). */}
            {meta.configurado && (
              <>
                <Dato etiqueta="Última actualización">
                  {`${fechaHoraColombia(meta.actualizadoEn)} · ${meta.actualizadoPor?.nombre ?? SIN_DATO}`}
                </Dato>
                <Dato etiqueta="Versión de llave">
                  {meta.keyVersion ?? SIN_DATO}
                </Dato>
              </>
            )}
          </dl>

          <form className="max-w-xl space-y-3" onSubmit={guardar}>
            {/* La etiqueta es «Nuevo token» TAMBIÉN cuando no hay ninguno, y no cambia al guardar.
                Un `label` que se reescribe bajo los dedos —«Token» antes de guardar, «Nuevo token»
                después— es un control que cambia de nombre sin que nadie lo haya pedido: quien
                navega con lector de pantalla oye otro campo donde estaba el suyo. Y «nuevo» es
                exacto en los dos casos, porque lo que se escribe aquí es siempre el token que va a
                quedar, nunca el que hay. */}
            <FlitField label="Nuevo token">
              {/* `type="password"` de ESCRITURA: no oculta nada que ya estuviera, porque nunca hay
                  nada que ocultar. Sin `name` a propósito (ver cabecera). `autoComplete="off"` para
                  que ningún gestor de contraseñas lo guarde como si fuera del usuario.

                  Y **sin `maxLength`**, que es lo contrario de lo que se hace en los campos de los
                  otros bloques. Recortar un alias de más de 120 caracteres se ve mientras se
                  escribe; recortar un secreto pegado desde el portapapeles no se ve —el campo es de
                  puntos— y guardaría un token TRUNCADO que cifra igual de bien, deja
                  `configurado: true` en pantalla y solo se delata semanas después, en un 401 del
                  proveedor que nadie ata a esta pantalla. Aquí el largo se comprueba al enviar y se
                  dice en voz alta. Es el mismo motivo por el que el servidor tampoco recorta. */}
              <input
                id="token-simit-nuevo"
                ref={campoRef}
                className={flitInp}
                type="password"
                autoComplete="off"
                spellCheck={false}
                aria-describedby="token-simit-ayuda"
              />
            </FlitField>
            <p id="token-simit-ayuda" className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
              El valor se borra del campo en cuanto se guarda. No lo pegues en chats ni lo dejes en
              capturas de pantalla.
            </p>
            {error && <ErrorFormulario>{error}</ErrorFormulario>}
            <div className="flex justify-end">
              <button
                type="submit"
                className={flitBtnPrimary}
                style={flitBtnPrimaryStyle}
                disabled={ocupado}
                aria-busy={ocupado}
              >
                {ocupado ? 'Guardando…' : 'Guardar token'}
              </button>
            </div>
          </form>
        </div>
      )}
    </BloqueConfig>
  );
}
