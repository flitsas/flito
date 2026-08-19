// FLITO — Comparendos: la descarga en Excel del conjunto filtrado (HU #11561, AC3..AC6).
//
// Es la única acción de la pantalla con datos propios, así que tiene sus cuatro estados —reposo,
// ocupado, error y hecho— como cualquier otra superficie. Cuatro cosas la definen:
//
//   · **Manda exactamente lo que la tabla está enseñando**, porque el reparto de criterios es el
//     MISMO que usa la consulta (`repartirCriterios`). No hay aquí un segundo constructor de la
//     petición: dos constructores son dos reglas que se separan, y separarse aquí significa
//     descargar un archivo distinto del que se ve — que es exactamente lo que este export existe
//     para no hacer.
//   · **Ni el NIT ni la placa tocan la URL** (AGENTS.md §14). El endpoint lo impone además por los
//     dos lados: `exportQuerySchema` es `.strict()` y rechaza `?nit=`, y `registrosBusquedaSchema`
//     —también `.strict()`— solo admite `nit` y `placa` en el cuerpo. Cualquiera de los dos errores
//     es un 400 ruidoso. El tercero, el silencioso, es no mandar los filtros en NINGUNA parte: eso
//     responde 200 con la tabla entera dentro.
//   · **El `cursor` no viaja.** `exportQuerySchema` lo OMITE y es `.strict()`, así que exportar
//     desde la página 3 con el cursor puesto sería un 400. Un export no pagina: entrega el conjunto
//     filtrado o no entrega nada.
//   · **El nombre del archivo lo pone el servidor** (`Content-Disposition`), no esta pantalla. Lleva
//     sello de tiempo en hora de Colombia; uno fabricado aquí llevaría la hora del equipo de quien
//     descarga.

import { useCallback, useRef, useState } from 'react';
import { ApiError, api } from '../../../lib/api';
import { flitBtnSecondary, flitBtnSecondarySm, flitBtnSecondaryStyle } from '../../flit/flitPageKit';
import {
  RUTA_COMPARENDOS, repartirCriterios, sufijoQuery, type CriteriosComparendos,
} from './useComparendosLista';

/**
 * Nombre de respaldo, solo para el caso en que el servidor no declare `Content-Disposition`.
 *
 * Va sin fecha a propósito: el sello del nombre real es de Colombia y lo calcula el API; uno puesto
 * aquí con el reloj del navegador diría otra hora —otro día, incluso— y sería una fecha que parece
 * la del servidor sin serlo. Sin NIT ni placa en el nombre, en ningún caso: un archivo se reenvía
 * por correo y su nombre acaba en asuntos, en carpetas compartidas y en copias de seguridad.
 */
const NOMBRE_RESPALDO = 'comparendos.xlsx';

/**
 * La forma que tiene que tener el nombre del servidor: `comparendos_YYYYMMDD-HHmm.xlsx`.
 *
 * **El nombre de un archivo es una superficie más por la que podría salir un dato personal, y hasta
 * aquí era la única del módulo sin llave.** El resto de la pantalla lleva dos Features cuidando que
 * un NIT o una placa no lleguen a la URL, ni al historial, ni al `Referer`, ni al eco de un mensaje
 * de error; un `Content-Disposition: attachment; filename="comparendos_900123456.xlsx"` los pondría
 * en dos sitios peores todavía: **el disco del usuario** —de donde el archivo se reenvía por correo,
 * con el NIT en el asunto y en la carpeta compartida— y el «Archivo descargado: …» que esta misma
 * pantalla pinta.
 *
 * Hoy el servidor no puede mandar eso: `nombreArchivoExport()` compone el nombre con un sello de
 * tiempo y su docstring dice expresamente que el filtro NO va en el nombre. Pero esa es una promesa
 * del emisor, no una comprobación del receptor, y la distancia entre las dos es exactamente lo que
 * esta constante cierra. Es el mismo motivo por el que `avisoDeError` lee `rawDetails.error` en vez
 * de `ApiError.message`: del otro lado del cable se confía en lo que se ha verificado, no en lo que
 * se ha prometido.
 *
 * **El sello se exige EXACTO —`\d{8}-\d{4}`— y no como «dígitos y guiones», y la diferencia no es
 * de estilo: es la única versión que cumple lo que este guardia promete.** Un `[\d-]+` acepta
 * `comparendos_900123456.xlsx` sin pestañear, porque un NIT es exactamente eso, dígitos; el guardia
 * quedaría escrito, comentado y probado, y dejaría pasar el único caso para el que existe. Se
 * descubrió porque el test del NIT salió en rojo con el patrón laxo — de ahí que ese test se quede
 * clavado en el spec.
 *
 * Los cuatro tramos salen de `nombreArchivoExport()`: `FORMATO_INSTANTE` es `en-CA` con `year:
 * 'numeric'`, mes, día, hora y minuto a `2-digit` y `hourCycle: 'h23'`, así que el sello es siempre
 * ocho dígitos, un guion y cuatro dígitos. No hay segundos y no hay ninguna variante local.
 *
 * Si no encaja se cae al respaldo —nunca se propaga el nombre raro—, y eso vale también para el día
 * en que el API cambie el formato a propósito: el archivo se seguirá descargando, con un nombre
 * peor, y este `regex` será lo que haya que actualizar. Se prefiere esa molestia visible a una
 * ventana silenciosa.
 */
const FORMA_DEL_NOMBRE = /^comparendos_\d{8}-\d{4}\.xlsx$/;

/**
 * Lanza el export y devuelve el nombre con el que se guardó el archivo.
 *
 * El reparto se parte en dos justo aquí, y el corte ES la norma del §14: `query` a la URL, `cuerpo`
 * al cuerpo del POST. No hay variante `GET` de este endpoint y no la puede haber.
 */
export async function exportarComparendos(c: CriteriosComparendos): Promise<string> {
  const { query, cuerpo } = repartirCriterios(c);
  return api.downloadPostNamed(
    `${RUTA_COMPARENDOS}/registros/export${sufijoQuery(query)}`,
    NOMBRE_RESPALDO,
    cuerpo,
    (nombre) => FORMA_DEL_NOMBRE.test(nombre),
  );
}

/** `codigo` estable del cuerpo de error. NO se mira el texto para DECIDIR nada. */
function codigoDe(e: ApiError): string | null {
  const cuerpo = e.rawDetails as { codigo?: unknown } | null | undefined;
  return typeof cuerpo?.codigo === 'string' ? cuerpo.codigo : null;
}

/**
 * El texto que escribió el SERVIDOR, leído de su propio campo y no del mensaje ya derivado.
 *
 * Se lee `rawDetails.error` y no `ApiError.message` porque `statusToMessage` rellena ese mensaje con
 * un genérico cuando el cuerpo no trae nada, y entonces no habría forma de distinguir «el servidor
 * dijo esto» de «el cliente se lo inventó». Devuelve `null` cuando no hay texto propio, y quien
 * llama pone el suyo.
 */
function textoDelServidor(e: ApiError): string | null {
  const cuerpo = e.rawDetails as { error?: unknown } | null | undefined;
  const texto = typeof cuerpo?.error === 'string' ? cuerpo.error.trim() : '';
  return texto.length > 0 ? texto : null;
}

export interface AvisoExport {
  tono: 'ok' | 'error';
  texto: string;
  /** ¿Tiene sentido repetir la misma petición? El 422 del tope, por ejemplo, no lo tiene. */
  reintentable: boolean;
}

/**
 * Qué se le dice al usuario cuando el export falla.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * **Aquí SÍ se hace eco del texto del servidor, en dos casos y solo en dos.** El módulo tiene la
 * regla contraria desde la #11559 (`errorDeVista`, en el hook) y esto es una excepción razonada, no
 * un olvido de quien no leyó aquel comentario:
 *
 *   · La regla existe para no **reflejar en pantalla lo que vino de la consulta del titular**: el
 *     filtro que intentaba sanear el texto del backend dejaba pasar NIT con separadores, cédulas con
 *     puntos, placas, hosts internos e IP privadas. El riesgo es el DATO CONSULTADO volviendo al DOM.
 *   · Estos dos mensajes no son eso. Son dos frases FIJAS, escritas en el código del servidor
 *     (`ComparendosExportDemasiadoGrandeError` y el `message` del `exportLimiter`), sin ningún hueco
 *     donde pueda entrar nada de la consulta. No hay ninguna ruta por la que un NIT llegue a ellas.
 *   · Y el eco es la ÚNICA implementación correcta del tope, que es lo que lo obliga: el tope
 *     efectivo es `COMPARENDOS_EXPORT_MAX_FILAS` del ENTORNO (mín. 1, máx. 20 000), el cuerpo del 422
 *     es `{ error, codigo }` sin campo `tope`, y `shared-types` advierte expresamente de que su
 *     constante es solo el valor POR DEFECTO. Escribir «5.000» en la pantalla sería escribir una
 *     cifra que cualquier despliegue puede desmentir sin que nadie se entere.
 *
 * Mejora pendiente, anotada y NO hecha aquí porque es superficie de backend: que el 422 lleve `tope`
 * como campo del cuerpo. Con eso la pantalla podría redactar su propio copy sin adivinar el número
 * y esta excepción sobraría.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
export function avisoDeError(e: unknown): AvisoExport {
  if (e instanceof ApiError) {
    // 422 del tope: repetir la misma petición daría el mismo 422, así que no se ofrece reintento —
    // lo que hay que cambiar es el filtro, y eso lo dice el propio mensaje.
    if (e.status === 422 && codigoDe(e) === 'export_demasiado_grande') {
      return {
        tono: 'error',
        reintentable: false,
        texto: textoDelServidor(e)
          ?? 'El filtro que tienes puesto trae más filas de las que admite un archivo. Acota la '
            + 'búsqueda y vuelve a exportar.',
      };
    }
    // 429 del limitador del export: son 5 por minuto y usuario, cuota SEPARADA de la del listado.
    // El texto del servidor ya dice cuánto esperar; el respaldo lo dice igual por si no viene.
    if (e.status === 429) {
      return {
        tono: 'error',
        reintentable: true,
        texto: textoDelServidor(e)
          ?? 'Se descargaron demasiados archivos seguidos. Espera 1 minuto y vuelve a intentarlo.',
      };
    }
    if (e.status === 403) {
      return {
        tono: 'error',
        reintentable: false,
        texto: 'Tu usuario ya no puede exportar comparendos. Habla con un administrador.',
      };
    }
    if (e.status === 0) {
      return {
        tono: 'error',
        reintentable: true,
        texto: 'El archivo tardó demasiado en generarse. Vuelve a intentarlo con un filtro más estrecho.',
      };
    }
  }
  // Todo lo demás sigue la regla del módulo: copy propio, derivado del código de estado. Un 500 sí
  // puede llevar en su texto lo que se estaba consultando.
  return {
    tono: 'error',
    reintentable: true,
    texto: 'No se pudo generar el archivo. Vuelve a intentarlo; si sigue fallando, avisa a soporte.',
  };
}

export interface EstadoExport {
  ocupado: boolean;
  aviso: AvisoExport | null;
  exportar: () => void;
  descartar: () => void;
}

/**
 * El estado de la descarga, con el candado del AC4.
 *
 * **El candado es una `ref` y no el `disabled` del botón**, y la diferencia es la lección que costó
 * un rojo intermitente en la HU #11562: `disabled` es una propiedad que React escribe en el DOM en
 * el commit SIGUIENTE al clic. Entre el primer clic y ese commit cabe un segundo clic —un doble clic
 * humano, un `click()` desde el teclado, un lector de pantalla que reenvía el evento— y ese segundo
 * clic encontraría el botón todavía habilitado y saldría a la red. «No admite un segundo clic» es
 * una afirmación sobre la PETICIÓN, no sobre un atributo.
 *
 * La `ref` se escribe y se lee en el mismo instante síncrono del evento, así que no hay ventana. El
 * `disabled` se queda porque es lo que lo hace visible y evita el clic accidental; no es lo que lo
 * impide.
 */
export function useExportComparendos(criterios: CriteriosComparendos): EstadoExport {
  const [ocupado, setOcupado] = useState(false);
  const [aviso, setAviso] = useState<AvisoExport | null>(null);
  const enVuelo = useRef(false);

  const exportar = useCallback(() => {
    if (enVuelo.current) return;
    enVuelo.current = true;
    setOcupado(true);
    setAviso(null);

    exportarComparendos(criterios)
      .then((nombre) => setAviso({ tono: 'ok', reintentable: false, texto: `Archivo descargado: ${nombre}` }))
      .catch((e) => setAviso(avisoDeError(e)))
      .finally(() => {
        enVuelo.current = false;
        setOcupado(false);
      });
  }, [criterios]);

  const descartar = useCallback(() => setAviso(null), []);

  return { ocupado, aviso, exportar, descartar };
}

/**
 * El botón, para el hueco de acciones de la cabecera.
 *
 * `aria-busy` además del texto: quien navega con lector no ve que el rótulo cambió, y «Preparando el
 * archivo…» sin `aria-busy` es solo otra etiqueta.
 */
export function BotonExportarComparendos({ ocupado, onExportar }: { ocupado: boolean; onExportar: () => void }) {
  return (
    <button
      type="button"
      className={flitBtnSecondary}
      style={flitBtnSecondaryStyle}
      onClick={onExportar}
      disabled={ocupado}
      aria-busy={ocupado || undefined}
    >
      {ocupado ? 'Preparando el archivo…' : 'Exportar a Excel'}
    </button>
  );
}

/**
 * La banda de resultado, bajo la cabecera, y el anuncio de los cuatro estados de la acción.
 *
 * Va SEPARADA del botón y no dentro del hueco de acciones porque el mensaje del tope es una frase
 * larga: metido junto al botón aplastaría el título de la pantalla en cuanto la ventana se estreche.
 *
 * **El reparto entre las dos regiones no es simetría, es lo que hace que se oigan:**
 *
 *   · `ocupado` y `hecho` van por una `role="status"` **siempre montada** que solo cambia de
 *     contenido. Una región polite que se monta ya rellena no dispara anuncio en varios lectores: lo
 *     que anuncian es el cambio DENTRO de una región que ya estaba. Y hace falta, porque lo único
 *     que cambia al empezar la descarga es el rótulo del botón, y un cambio de nombre accesible no
 *     se anuncia solo.
 *   · El error va por `role="alert"` en la banda visible, que sí se anuncia al insertarse por ser
 *     assertive, y por eso NO se repite en la región polite: dicho dos veces se oye dos veces.
 */
export function AvisoExportComparendos(
  { ocupado, aviso, onReintentar, onDescartar }:
  { ocupado: boolean; aviso: AvisoExport | null; onReintentar: () => void; onDescartar: () => void },
) {
  const esError = aviso?.tono === 'error';
  const anuncio = ocupado
    ? 'Preparando el archivo de comparendos.'
    : (aviso && !esError ? aviso.texto : '');

  return (
    <>
      <p className="sr-only" role="status">{anuncio}</p>
      {!ocupado && aviso && (
        <AvisoVisible aviso={aviso} onReintentar={onReintentar} onDescartar={onDescartar} />
      )}
    </>
  );
}

function AvisoVisible(
  { aviso, onReintentar, onDescartar }:
  { aviso: AvisoExport; onReintentar: () => void; onDescartar: () => void },
) {
  const esError = aviso.tono === 'error';
  return (
    <div
      role={esError ? 'alert' : undefined}
      className="flex flex-wrap items-center justify-between gap-3 bg-white px-6 py-4"
      style={{
        borderRadius: 'var(--flit-radius-card)',
        border: '1px solid var(--flit-border-soft)',
        boxShadow: 'var(--flit-shadow-card)',
      }}
    >
      {/* Tinta y no color de superficie: `--flit-danger` como letra de 14px sobre blanco se queda
          en 4,19 y axe lo marca `serious` (Bug #11604). */}
      <p
        className="text-sm"
        style={{ color: esError ? 'var(--flit-danger-ink)' : 'var(--flit-text-primary)' }}
      >
        {aviso.texto}
      </p>
      <div className="flex items-center gap-2">
        {aviso.reintentable && (
          <button
            type="button"
            className={flitBtnSecondarySm}
            style={flitBtnSecondaryStyle}
            onClick={onReintentar}
          >
            {/* «Reintentar» a secas colisionaría con el de la banda de error de la TABLA, que puede
                estar en pantalla a la vez: dos botones con el mismo nombre accesible y dos efectos
                distintos. */}
            Reintentar la descarga
          </button>
        )}
        <button
          type="button"
          className={flitBtnSecondarySm}
          style={flitBtnSecondaryStyle}
          onClick={onDescartar}
        >
          Cerrar el aviso
        </button>
      </div>
    </div>
  );
}
