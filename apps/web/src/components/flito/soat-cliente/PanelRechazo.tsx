// FLITO — canal Cliente: el formulario de RECHAZO de una solicitud (HU #11915, AC2).
//
// ── Por qué es un componente propio y no un `FormMotivo` más ────────────────────────────────────
//
// `FormMotivo` (`FlitoSoat.tsx`) es el patrón de las otras seis acciones del modal y no sirve aquí,
// por dos diferencias que el diseño midió (`docs/ux/revision-rechazo-y-subsanacion.md` §3.2):
//
//   1. **Son DOS campos obligatorios, y uno de ellos es un catálogo que viaja por red.** `FormMotivo`
//      tiene uno solo, de texto, sin `aria-invalid`, sin mensaje por campo y sin estados de carga.
//      Ensancharlo para este caso es como se rompen los seis que ya funcionan.
//   2. **El botón de confirmar NO se deshabilita por los campos: valida al PULSAR.** `FormMotivo`
//      lo deshabilita mientras el motivo no llega al mínimo. Con dos campos un botón muerto no dice
//      cuál de los dos falta —y «demasiado corta» no es lo mismo que «vacía»—, así que no puede
//      llevar el foco al control que hay que corregir. El AC2 se cumple igual por las dos vías;
//      esta además EXPLICA. (Sí se deshabilita mientras el catálogo carga o falló: ahí no hay nada
//      que validar porque no hay nada que elegir.)
//
// ── La observación la lee una empresa TERCERA ───────────────────────────────────────────────────
//
// Es la única cadena de todo el Feature que un empleado de FLIT escribe y una compañía cliente lee
// entera y literal (`CorreccionSolicitud.tsx`, bloque «Por qué se rechazó»). Tres cosas la contienen
// y ninguna es un tooltip: el RÓTULO lo dice («Observación para el cliente»), la ayuda va debajo del
// campo SIEMPRE VISIBLE y enlazada por `aria-describedby`, y hay contador. Un aviso que solo se ve
// al pasar el ratón se lee después de haber escrito, que es tarde.

import { useEffect, useRef, useState } from 'react';
import { CodigoErrorSolicitudSoat, type CausalRechazoSoat } from '@operaciones/shared-types';
import { api } from '../../../lib/api';
import { leerFallo } from '../../../lib/soatCliente';
import FlitSelect from '../../flit/FlitSelect';
import { flitInp, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle } from '../../flit/flitPageKit';
import { useFocoPrimerError } from './bloques';

/** Tope que cuenta la pantalla y que el servidor impone en su Zod. La columna es `text`. */
const MAX_OBSERVACION = 500;
/** Mismo umbral que el `min(5)` del servidor y que la reversa y el traspaso ya exigen a su motivo. */
const MIN_OBSERVACION = 5;

/** Id ESTABLE del textarea: es a donde va el foco cuando la observación es el primer error. */
const ID_OBSERVACION = 'soat-rechazo-observacion';

/** Lo que la pantalla necesita decidir sobre un fallo del `POST`. */
interface FalloAccion {
  mensaje: string;
  /** El 409 de «ya la revisaron»: la única salida es refrescar la cola, no reintentar el envío. */
  recargar: boolean;
}

export default function PanelRechazo({ soatId, onRechazada, onActualizarCola, onCancelar }: {
  soatId: string;
  /** Rechazo confirmado: cierra el detalle y refresca la cola. */
  onRechazada: () => void;
  /** «Actualizar la cola» del 409. Mismo efecto, otra intención: aquí no se rechazó nada. */
  onActualizarCola: () => void;
  onCancelar: () => void;
}) {
  // ── Estado 1..4 del catálogo. `null` es «todavía no sé», `[]` es «no hay ninguna». ────────────
  const [causales, setCausales] = useState<CausalRechazoSoat[] | null>(null);
  const [falloCatalogo, setFalloCatalogo] = useState(false);
  const [recargaCatalogo, setRecargaCatalogo] = useState(0);

  const [causalId, setCausalId] = useState('');
  const [observacion, setObservacion] = useState('');
  const [errores, setErrores] = useState<{ causal?: string; observacion?: string }>({});
  // Lo que fuerza a repetir el foco cuando se vuelve a pulsar con exactamente el mismo error.
  const [intento, setIntento] = useState(0);
  const [resumen, setResumen] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [fallo, setFallo] = useState<FalloAccion | null>(null);

  // Al `<h4>` y no al primer campo, y SOLO al montar: es lo NUEVO que apareció, y el lector anuncia
  // el nombre del panel antes de que el usuario tabule hasta el aviso de «la lee la empresa
  // cliente». Sin esto el foco cae a `<body>`, porque el botón que se pulsó desaparece al montarse
  // el panel. Con un `ref` de callback en línea se robaría el foco en CADA repintado —es decir, en
  // cada tecla del textarea—, así que va por efecto de montaje.
  const refTitulo = useRef<HTMLHeadingElement>(null);
  useEffect(() => { refTitulo.current?.focus(); }, []);

  // El catálogo se pide al ABRIR el formulario y no al montar la cola: casi ninguna apertura del
  // detalle acaba en un rechazo, y pedirlo antes sería una consulta por cada «Ver».
  useEffect(() => {
    let vivo = true;
    setCausales(null);
    setFalloCatalogo(false);
    api.get<CausalRechazoSoat[]>('/flito/soat/causales-rechazo')
      .then((c) => { if (vivo) setCausales(c); })
      .catch(() => { if (vivo) setFalloCatalogo(true); });
    return () => { vivo = false; };
  }, [recargaCatalogo]);

  // El foco va al PRIMER control inválido. Cuando el primero es el selector, `null`: `FlitSelect` se
  // enfoca a sí mismo en cuanto recibe `error`, y duplicarlo aquí sería una segunda fuente de verdad.
  useFocoPrimerError(errores.causal ? null : errores.observacion ? ID_OBSERVACION : null, intento);

  const cargando = causales === null && !falloCatalogo;
  const vacio = causales !== null && causales.length === 0;
  // Sin causal no se puede rechazar: mientras el catálogo no esté resuelto no hay nada que validar.
  const confirmarBloqueado = enviando || cargando || falloCatalogo;

  const confirmar = async () => {
    const errs: { causal?: string; observacion?: string } = {};
    if (!causalId) errs.causal = 'Elija la causal del rechazo.';
    const obs = observacion.trim();
    if (!obs) errs.observacion = 'Escriba la observación que va a leer el cliente.';
    else if (obs.length < MIN_OBSERVACION) {
      errs.observacion = 'La observación es demasiado corta. Dígale al cliente qué tiene que corregir, en una frase.';
    }
    setErrores(errs);
    setIntento((n) => n + 1);
    if (errs.causal || errs.observacion) {
      setResumen('Falta la causal o la observación. Sin las dos, la solicitud no cambia de estado.');
      return;
    }

    setResumen(null);
    setFallo(null);
    setEnviando(true);
    try {
      // La observación viaja en el CUERPO, nunca en la URL: la escribe una persona sobre un caso
      // concreto y puede nombrar al propietario (AGENTS.md §14).
      await api.post(`/flito/soat/${soatId}/rechazar-solicitud`, { causalId, observacion: obs });
      onRechazada();
    } catch (e) {
      // Por el `codigo` y jamás por el texto: los dos desenlaces comparten pantalla y tienen
      // arreglos distintos, y comparar el mensaje se rompe con la próxima corrección de una tilde.
      const f = leerFallo(e);
      if (f.codigo === CodigoErrorSolicitudSoat.ESTADO_NO_PERMITE) {
        setFallo({
          mensaje: 'Esta solicitud ya no está pendiente de revisión: alguien la revisó mientras usted la tenía abierta.',
          recargar: true,
        });
      } else if (f.codigo === CodigoErrorSolicitudSoat.CAUSAL_INVALIDA) {
        setFallo({ mensaje: 'Esa causal ya no está disponible. Vuelva a cargar las causales y elija otra.', recargar: false });
      } else {
        setFallo({ mensaje: 'No se pudo rechazar la solicitud. Vuelva a intentarlo.', recargar: false });
      }
    } finally {
      setEnviando(false);
    }
  };

  const idAyudaObs = `${ID_OBSERVACION}-ayuda`;
  const idContador = `${ID_OBSERVACION}-contador`;
  const idErrorObs = `${ID_OBSERVACION}-error`;

  return (
    <div className="mt-3 rounded-lg border p-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
      <h4 ref={refTitulo} tabIndex={-1} className="flit-focus text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>
        Rechazar la solicitud
      </h4>
      <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
        El cliente verá la causal y la observación, y podrá corregir y volver a enviarla.
      </p>

      <div className="mt-3 space-y-3">
        {/* Estado 3 · el catálogo respondió 200 con CERO causales activas — el caso del día 1 si la
            siembra no corrió. No se pinta un selector vacío: el admin elegiría nada, confirmaría y
            comería un 400 que no puede arreglar. */}
        {vacio ? (
          <p role="alert" className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>
            Todavía no hay causales de rechazo configuradas, y sin una causal no se puede rechazar una
            solicitud. Avísele al equipo que administra el catálogo de FLITO.
          </p>
        ) : (
          <FlitSelect
            label="Causal del rechazo"
            value={causalId}
            disabled={cargando || falloCatalogo}
            opciones={
              cargando ? [{ valor: '', etiqueta: 'Cargando causales…' }]
                : falloCatalogo ? [{ valor: '', etiqueta: 'Elija la causal…' }]
                  : [{ valor: '', etiqueta: 'Elija la causal…' },
                    ...(causales ?? []).map((c) => ({ valor: c.id, etiqueta: c.nombre }))]
            }
            onChange={(v) => { setCausalId(v); setErrores((e) => ({ ...e, causal: undefined })); }}
            ayuda="El cliente ve esta causal, tal cual, junto con su observación."
            mensaje={cargando ? 'Cargando causales…'
              : falloCatalogo ? 'No se pudieron cargar las causales de rechazo.' : null}
            fallo={falloCatalogo}
            onReintentar={falloCatalogo ? () => setRecargaCatalogo((n) => n + 1) : undefined}
            textoReintento="Volver a cargar las causales"
            error={errores.causal ?? null}
          />
        )}

        {!vacio && (
          <div>
            <label htmlFor={ID_OBSERVACION} className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
              Observación para el cliente *
            </label>
            <textarea
              id={ID_OBSERVACION}
              className={`${flitInp} min-h-[80px]`}
              value={observacion}
              maxLength={MAX_OBSERVACION}
              aria-invalid={errores.observacion ? true : undefined}
              aria-describedby={`${idAyudaObs} ${idContador}${errores.observacion ? ` ${idErrorObs}` : ''}`}
              onChange={(e) => {
                setObservacion(e.target.value);
                setErrores((x) => ({ ...x, observacion: undefined }));
              }}
            />
            {/* VISIBLE y enlazada, no un `title`: es la única contención de la fuga de lenguaje
                interno hacia una empresa tercera. */}
            <p id={idAyudaObs} className="mt-1 text-[11px]" style={{ color: 'var(--flit-text-secondary)' }}>
              La lee la empresa cliente tal como la escriba. Dígale qué tiene que corregir. No escriba
              notas internas ni nombres de compañeros.
            </p>
            {/* El contador NO es una región viva: un `aria-live` que se dispara en cada tecla es la
                forma más rápida de que alguien apague el lector. Va enlazado por `aria-describedby`. */}
            <p id={idContador} className="mt-1 text-right text-[11px] tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>
              {observacion.length}/{MAX_OBSERVACION}
            </p>
            {errores.observacion && (
              <p id={idErrorObs} role="alert" className="mt-1 text-xs" style={{ color: 'var(--flit-danger-ink)' }}>
                {errores.observacion}
              </p>
            )}
          </div>
        )}

        {resumen && (
          <p role="alert" className="text-xs font-semibold" style={{ color: 'var(--flit-danger-ink)' }}>{resumen}</p>
        )}

        {fallo && (
          <div className="space-y-2">
            <p role="alert" className="text-xs font-semibold" style={{ color: 'var(--flit-danger-ink)' }}>{fallo.mensaje}</p>
            {fallo.recargar && (
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onActualizarCola}>
                Actualizar la cola
              </button>
            )}
          </div>
        )}

        {/* Región viva montada desde el principio: una `role="status"` que APARECE ya rellena no
            dispara anuncio en varios lectores; lo que se anuncia es el CAMBIO de su contenido. */}
        <span role="status" className="sr-only">{enviando ? 'Rechazando…' : ''}</span>

        <div className="flex flex-wrap gap-2">
          {/* En el catálogo vacío el confirmar NO se pinta: no hay ninguna causal que elegir. El
              botón «Rechazar la solicitud» del bloque de revisión sigue existiendo, porque
              esconderlo haría creer que el rechazo no existe en el producto. */}
          {!vacio && (
            <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle}
              disabled={confirmarBloqueado} onClick={confirmar}>
              {enviando ? 'Rechazando…' : 'Confirmar el rechazo'}
            </button>
          )}
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onCancelar}>
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}
