// FLITO — Comparendos · Sincronización: la consola de disparo (HU #11635, Región A).
//
// Toda la máquina de estados vive en `useComparendosSync`; aquí solo se decide QUÉ se enseña en cada
// fase. La regla que ordena el archivo es una sola: **el formulario y el progreso nunca conviven**.
//
// Mientras hay una corrida viva —la mía o la de otra sesión— no se pinta ningún botón de disparo. No
// es cosmética: un `[Sincronizar]` visible sobre una corrida en curso invita exactamente al bucle
// que esta HU existe para cortar —el operador cree que no pasó nada, vuelve a pulsar, recibe un 409
// y ahora tiene dos mensajes y ninguna certeza—. Con el formulario fuera de la pantalla, la única
// acción posible es esperar, que es la correcta.
//
// Tres detalles de accesibilidad que se deciden aquí y se pagan caros si se hacen mal:
//
//   1. **La región viva NO está en este archivo.** Vive una sola vez en `VistaSyncComparendos` y
//      cubre la vista entera (`role="status"`, polite). Si cada tarjeta tuviera la suya, un lector
//      anunciaría el mismo cambio dos veces o —peor— uno solo de los dos, según el orden del DOM.
//   2. **`role="alert"` queda RESERVADO al error definitivo.** El progreso de una corrida de dos
//      minutos no puede interrumpir lo que el operador esté haciendo, y el paso al seguimiento no es
//      un fallo: usar `alert` ahí es gritar cada dos segundos y medio.
//   3. **La barra de progreso no lleva `aria-valuenow`.** El API no da porcentaje. Un número
//      inventado le diría a quien usa lector una cifra que no significa nada; una barra sin valor
//      dice lo que hay: esto está en marcha y no sabemos cuánto falta.
//
// El botón de disparo dice «Sincronizando…» **con texto** además de llevar `aria-busy`: ningún
// lector de pantalla anuncia el cambio de un atributo si el nombre accesible no cambió.

import { useCallback, useState } from 'react';
import type { ComparendosNit } from '@operaciones/shared-types';
import {
  FlitCard, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondarySm,
  flitBtnSecondaryStyle,
} from '../../flit/flitPageKit';
import { RUTA_COMPARENDOS, useCatalogoConfig } from './bloqueConfigComparendos';
import { ETIQUETA_ACCION, type AccionSync } from './erroresSync';
import { fechaHoraColombia } from './formato';
import type { NavComparendos } from './navegacionComparendos';
import type { SyncEnVivo } from './useComparendosSync';

const RUTA_NITS = `${RUTA_COMPARENDOS}/nits`;

/** El `id` que `BloqueConfig` genera para el bloque del token a partir de su título. Ver `irAlToken`. */
const ANCLA_TOKEN = 'bloque-token-simit';

/** Tope del servidor (`syncSchema`). Se comprueba aquí para no gastar un intento del limitador. */
const MAX_NITS_POR_CORRIDA = 200;

/**
 * El `id` del título de la consola. Se EXPORTA porque es el destino del foco cuando se llega aquí
 * desde el vacío del visor (HU #11637): el AC pide aterrizar en «Sincronizar ahora», no en el
 * encabezado del panel, y quien navega —`VistaRegistrosComparendos`— necesita nombrar ese nodo.
 */
export const ID_TITULO_CONSOLA_SYNC = 'consola-sync-comparendos';

interface Props {
  nav: NavComparendos;
  sync: SyncEnVivo;
}

/**
 * Lleva a Configuración y, si se pide un ancla, deja ese bloque A LA VISTA.
 *
 * El AC3 pide «un enlace al bloque del token», no «un enlace a Configuración»: la pantalla de
 * configuración son cuatro tarjetas y el token es la última, así que dejar al operador arriba del
 * todo con un «búscalo tú» convierte un error accionable en uno decorativo.
 *
 * Se resuelve sin tocar `navegacionComparendos.tsx` —que es de la HU #11633 y ya está certificado—
 * usando el `id` que `BloqueConfig` ya pone en el `<h2>` de cada bloque. Cambiar de pestaña desmonta
 * y remonta el marco, así que el destino no existe todavía cuando se pulsa: de ahí las cuatro
 * pasadas espaciadas. Se repite el desplazamiento aunque ya se haya encontrado el bloque porque el
 * marco mueve el foco a su propio encabezado al montarse y ese foco arrastra el scroll; la última
 * pasada es la que gana.
 *
 * Si el título del bloque cambiara, el `id` dejaría de encajar y lo único que se pierde es el
 * desplazamiento: la navegación a Configuración ocurre igual.
 */
function irAConfiguracion(nav: NavComparendos, ancla?: string) {
  nav.cambiar('configuracion');
  if (!ancla) return;
  for (const espera of [0, 80, 160, 260]) {
    setTimeout(() => {
      document.getElementById(ancla)?.scrollIntoView({ block: 'start', behavior: 'auto' });
    }, espera);
  }
}

export default function ConsolaSyncComparendos({ nav, sync }: Props) {
  const catalogo = useCatalogoConfig<ComparendosNit>(RUTA_NITS);
  const activos = catalogo.items.filter((n) => n.activo);

  const [soloEstos, setSoloEstos] = useState(false);
  // Se guardan los NIT y no los ids: es lo que viaja en el cuerpo, y así una recarga del catálogo
  // no puede desalinear la selección con las filas.
  const [elegidos, setElegidos] = useState<string[]>([]);

  // El orden del envío es el del catálogo, no el de los clics: dos operadores que eligen los mismos
  // NIT mandan el mismo cuerpo.
  const seleccion = activos.filter((n) => elegidos.includes(n.nit)).map((n) => n.nit);
  const alcance = soloEstos ? seleccion : null;

  const alternar = useCallback((nit: string) => {
    setElegidos((previos) => (previos.includes(nit) ? previos.filter((n) => n !== nit) : [...previos, nit]));
  }, []);

  const enCurso = sync.fase === 'enviando' || sync.fase === 'localizando' || sync.fase === 'siguiendo';
  const hidratando = sync.fase === 'hidratando';
  const sobrepasaTope = seleccion.length > MAX_NITS_POR_CORRIDA;
  const sinSeleccion = soloEstos && seleccion.length === 0;

  const lanzar = () => sync.lanzar(alcance);

  return (
    <section role="region" aria-labelledby={ID_TITULO_CONSOLA_SYNC}>
      <FlitCard>
        {/* `tabIndex={-1}` es lo único que este archivo pone para la HU #11637: sin él, el `.focus()`
            que llega desde el vacío del visor no hace nada y el foco se queda en `<body>` tras el
            cambio de pestaña. El título ya se ve, así que no necesita el `sr-only focus:not-sr-only`
            de los encabezados del marco; sí lleva `flit-focus` para que el anillo sea el del sistema
            y no el del navegador. */}
        <h2
          id={ID_TITULO_CONSOLA_SYNC}
          tabIndex={-1}
          className="flit-focus rounded text-sm font-semibold"
          style={{ color: 'var(--flit-text-primary)' }}
        >
          Sincronizar ahora
        </h2>
        <p className="mt-1 max-w-3xl text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          Consulta las fuentes sobre los NIT activos. Puede tardar más de un minuto; no cierres la
          pestaña. Si el tiempo se agota en el navegador, la corrida sigue en el servidor y aquí se
          sigue su progreso.
        </p>

        {sync.aviso && !enCurso && (
          <p className="mt-3 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{sync.aviso}</p>
        )}

        {sync.error && <BandaError sync={sync} nav={nav} alcance={alcance} seleccion={seleccion} />}

        {sync.fase === 'sin_confirmar' && (
          <div
            className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg p-3"
            style={{ background: 'var(--flit-bg-app)' }}
          >
            {/* Ni `alert` ni rojo: la corrida puede haber terminado perfectamente y lo único cierto
                es que no lo pudimos confirmar. Pintarlo como un fallo sería afirmar lo que no se sabe. */}
            <p className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
              La corrida sigue en el servidor. Revisa el historial en unos minutos.
            </p>
            <button
              type="button"
              className={flitBtnSecondary}
              style={flitBtnSecondaryStyle}
              onClick={sync.volverAConsultar}
            >
              Volver a consultar
            </button>
          </div>
        )}

        {enCurso ? (
          <PanelEnCurso sync={sync} />
        ) : (
          <div className="mt-4 space-y-4">
            <fieldset>
              <legend className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>
                Alcance
              </legend>
              <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2">
                <OpcionAlcance
                  etiqueta="Todos los NIT activos"
                  marcada={!soloEstos}
                  alElegir={() => setSoloEstos(false)}
                />
                <OpcionAlcance
                  etiqueta="Solo estos NIT"
                  marcada={soloEstos}
                  alElegir={() => setSoloEstos(true)}
                />
              </div>
            </fieldset>

            {soloEstos && (
              <SelectorNits
                activos={activos}
                elegidos={elegidos}
                estado={catalogo.estado}
                alternar={alternar}
                onReintentar={catalogo.recargar}
                onIrAConfiguracion={() => irAConfiguracion(nav)}
              />
            )}

            {sobrepasaTope && (
              <p className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>
                Como máximo {MAX_NITS_POR_CORRIDA} NIT por corrida. Quita alguno y repite con el resto.
              </p>
            )}

            <button
              type="button"
              className={flitBtnPrimary}
              style={flitBtnPrimaryStyle}
              disabled={hidratando || sinSeleccion || sobrepasaTope}
              onClick={lanzar}
            >
              Sincronizar
            </button>
          </div>
        )}
      </FlitCard>
    </section>
  );
}

function OpcionAlcance({ etiqueta, marcada, alElegir }: { etiqueta: string; marcada: boolean; alElegir: () => void }) {
  return (
    <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--flit-text-primary)' }}>
      <input
        type="radio"
        name="alcance-sync-comparendos"
        className="flit-focus h-4 w-4"
        checked={marcada}
        onChange={alElegir}
      />
      {etiqueta}
    </label>
  );
}

/**
 * El selector de alcance, con sus cuatro estados.
 *
 * **Solo se ofrecen los NIT activos** (`activo === true`). Ofrecer un inactivo terminaría en un 400
 * `nits_filtro_invalido` que el operador no puede entender, porque se lo tendió la pantalla misma.
 *
 * El estado de carga NO usa `role="status"`: la vista tiene una sola región viva (ver la cabecera de
 * este archivo) y una segunda aquí competiría con ella justo mientras se anuncia el progreso de una
 * corrida. `aria-busy` sobre el grupo dice lo mismo sin abrir otro canal.
 */
function SelectorNits({
  activos, elegidos, estado, alternar, onReintentar, onIrAConfiguracion,
}: {
  activos: ComparendosNit[];
  elegidos: string[];
  estado: 'cargando' | 'error' | 'ok';
  alternar: (nit: string) => void;
  onReintentar: () => void;
  onIrAConfiguracion: () => void;
}) {
  return (
    <fieldset aria-busy={estado === 'cargando'}>
      <legend className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>
        NIT activos a sincronizar
      </legend>

      {estado === 'cargando' && (
        <p className="mt-2 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>Cargando los NIT activos…</p>
      )}

      {/* El error va ANTES que el vacío, como en el resto del módulo: si la consulta falló no se
          sabe si hay NIT, y decir «no hay» sería afirmar algo que nadie comprobó. */}
      {estado === 'error' && (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <p className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>
            No se pudieron cargar los NIT del catálogo.
          </p>
          <button type="button" className={flitBtnSecondarySm} style={flitBtnSecondaryStyle} onClick={onReintentar}>
            Reintentar
          </button>
        </div>
      )}

      {estado === 'ok' && activos.length === 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            No hay NIT activos en el catálogo.
          </p>
          <button
            type="button"
            className={flitBtnSecondarySm}
            style={flitBtnSecondaryStyle}
            onClick={onIrAConfiguracion}
          >
            Ir a Configuración
          </button>
        </div>
      )}

      {estado === 'ok' && activos.length > 0 && (
        <>
          <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2">
            {activos.map((n) => (
              <label
                key={n.id}
                className="flex items-center gap-2 text-sm"
                style={{ color: 'var(--flit-text-primary)' }}
              >
                <input
                  type="checkbox"
                  className="flit-focus h-4 w-4"
                  checked={elegidos.includes(n.nit)}
                  onChange={() => alternar(n.nit)}
                />
                {n.alias ? `${n.nit} · ${n.alias}` : n.nit}
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
            Solo se listan los NIT activos en Configuración. Máximo {MAX_NITS_POR_CORRIDA} por corrida.
          </p>
        </>
      )}
    </fieldset>
  );
}

/**
 * Corrida en marcha: el POST vivo, la búsqueda de la corrida tras un corte, o el seguimiento.
 *
 * Las tres se pintan IGUAL a propósito. Para quien mira, «mi petición sigue abierta», «no sé cuál es
 * la corrida» y «la estoy sondeando» son la misma situación —hay trabajo en curso y hay que
 * esperar—, y distinguirlas en pantalla solo trasladaría al operador un detalle de implementación.
 *
 * No hay botón de cancelar, y no es un olvido: abortar el POST no detiene nada en el servidor. Un
 * control que dijera «cancelar» mentiría, y por eso tampoco aparece la palabra en ningún copy.
 */
function PanelEnCurso({ sync }: { sync: SyncEnVivo }) {
  const { corrida, alcance, ajena, contactoPerdido } = sync;
  const contexto = corrida
    ? `Iniciada el ${fechaHoraColombia(corrida.iniciadoEn)} · alcance: ${corrida.scopeNits.length} NIT`
    : `Alcance: ${alcance ? `${alcance.length} NIT` : 'todos los NIT activos'}`;

  return (
    <div className="mt-4 space-y-3">
      <h3 className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
        Sincronización en curso
      </h3>
      <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{contexto}</p>

      {ajena && (
        <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          Ya hay una sincronización en curso, iniciada desde otra sesión. Se sigue su progreso; cuando
          termine podrás lanzar la tuya.
        </p>
      )}

      {contactoPerdido && (
        <p className="text-sm" style={{ color: 'var(--flit-warning-ink)' }}>
          Perdimos contacto con el servidor; seguimos intentando.
        </p>
      )}

      {/* Indeterminada: el API no da porcentaje y no se inventa uno. `motion-reduce` la deja quieta
          —quien pidió menos movimiento no necesita una barra latiendo dos minutos— y el texto de
          arriba sigue diciendo lo mismo. */}
      <div
        role="progressbar"
        aria-label="Sincronización en curso"
        className="h-2 w-full max-w-md animate-pulse motion-reduce:animate-none"
        style={{ background: 'var(--flit-border-soft)', borderRadius: 999 }}
      />

      <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled aria-busy="true">
        Sincronizando…
      </button>
    </div>
  );
}

/**
 * El error definitivo: la ÚNICA `role="alert"` de la vista.
 *
 * `nombraSeleccion` es lo que resuelve `nits_filtro_invalido` sin hacer eco del servidor: el backend
 * responde con los NIT rechazados dentro de la frase, y parsear esa frase para sacarlos es un
 * analizador de prosa que se rompe en silencio —además de meter en el DOM un dato personal por una
 * vía que nadie revisó—. Los NIT que se pintan son los que el propio operador acaba de elegir, que
 * la pantalla ya tiene.
 */
function BandaError({ sync, nav, alcance, seleccion }: {
  sync: SyncEnVivo;
  nav: NavComparendos;
  /** El alcance TAL Y COMO está el formulario ahora: reintentar es volver a lanzar lo mismo. */
  alcance: string[] | null;
  seleccion: string[];
}) {
  const error = sync.error;
  if (!error) return null;

  const alPulsar: Record<Exclude<AccionSync, 'seleccion' | null>, () => void> = {
    reintentar: () => sync.lanzar(alcance),
    configuracion: () => irAConfiguracion(nav),
    token: () => irAConfiguracion(nav, ANCLA_TOKEN),
  };
  const accion = error.accion === 'seleccion' || error.accion === null ? null : error.accion;

  return (
    <div
      role="alert"
      className="mt-4 flex flex-wrap items-start justify-between gap-3 rounded-lg p-3"
      style={{ background: 'var(--flit-bg-app)' }}
    >
      <div className="min-w-0 max-w-2xl space-y-1">
        <p className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>{error.texto}</p>
        {error.nombraSeleccion && (
          <p className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
            {seleccion.length > 0 ? seleccion.join(' · ') : 'Revisa la selección de alcance.'}
          </p>
        )}
      </div>
      {accion && (
        <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={alPulsar[accion]}>
          {ETIQUETA_ACCION[accion]}
        </button>
      )}
    </div>
  );
}
