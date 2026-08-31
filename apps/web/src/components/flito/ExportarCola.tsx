// FLITO — SOAT e Impuestos: la descarga en Excel del conjunto filtrado (HU #11909, AC1..AC6).
//
// No es un patrón nuevo: es el de Comparendos (HU #11561,
// `components/flito/comparendos/ExportarComparendos.tsx`) traído a las dos colas que lo pedían, con
// una sola diferencia de contrato —aquí **todos** los filtros viajan en el CUERPO— y con el prefijo
// del nombre del archivo como parámetro, porque es lo único que distingue a las dos pantallas.
//
// Cuatro cosas lo definen, y las cuatro son las del vecino:
//
//   · **Manda exactamente lo que la tabla está enseñando.** El cuerpo se arma en la página, del
//     mismo estado del que sale la consulta de la cola; no hay aquí un segundo constructor de la
//     petición. Dos constructores son dos reglas que se separan, y separarse aquí significa
//     descargar un archivo distinto del que se ve — que es justo lo que este export existe para no
//     hacer.
//   · **Nada de esto toca la URL** (AGENTS.md §14). El buscador de estas dos colas admite nombre y
//     documento del comprador, así que el reparto «unos a la query, otros al cuerpo» del vecino aquí
//     se simplifica en la dirección segura: TODO al cuerpo del POST. No hay variante `GET` de estos
//     endpoints y no la puede haber; un `<a download href="…?buscar=…">` escribiría la cédula en el
//     historial, en el `Referer` y en el access log del proxy.
//   · **La página no viaja.** Un export no pagina: entrega el conjunto filtrado o no entrega nada.
//     `page` y `cursor` no están en `FiltrosExportCola` y por eso no pueden colarse por descuido.
//   · **El nombre del archivo lo pone el servidor** (`Content-Disposition`), con sello en hora de
//     Colombia. Uno fabricado aquí llevaría la hora del equipo de quien descarga.

import { useCallback, useRef, useState } from 'react';
import { ApiError, api } from '../../lib/api';
import { flitBtnSecondary, flitBtnSecondarySm, flitBtnSecondaryStyle } from '../flit/flitPageKit';

/**
 * El cuerpo del POST de export, **declarado aquí y no en `shared-types`** (HU #11909).
 *
 * Es una decisión de reparto de trabajo, no un descuido: el tipo compartido lo escribe el backend
 * con el esquema de validación al lado, que es donde puede ser verdad. Este de aquí describe lo que
 * esta pantalla manda; el día que el compartido exista, esta interfaz se sustituye por él y el
 * compilador dirá si sobraba o faltaba algo.
 *
 * Lo que NO tiene —y no puede tener— es paginación: ni `page`, ni `pageSize`, ni `cursor`.
 */
export interface FiltrosExportCola {
  /** Estados seleccionados. Vacío = «Todos»: la pastilla sin filtrar no manda la clave. */
  estados?: string[];
  /** Texto del buscador. **Admite nombre y documento del comprador: por eso va en el cuerpo.** */
  buscar?: string;
  /** Identificadores numéricos: el esquema del endpoint es `z.array(z.number())` y es `.strict()`. */
  companias?: number[];
  organismos?: string[];
  /** Solo SOAT. Impuestos no tiene proveedores. */
  proveedores?: string[];
  gestion?: string;
  solicitadoDesde?: string;
  solicitadoHasta?: string;
  pagadoDesde?: string;
  pagadoHasta?: string;
  /** Fecha de registro en FLITO (`created_at`), la del filtro «Creado en FLITO». */
  creadoDesde?: string;
  creadoHasta?: string;
  estancado?: boolean;
}

/** Lo único que distingue a las dos pantallas: el prefijo del archivo y cómo se la nombra al leerla. */
export interface ColaExportable {
  /** Ruta del POST, sin `/api`. */
  ruta: string;
  /** Prefijo del nombre del archivo que pone el servidor: `soat_…` / `impuestos_…`. */
  prefijo: 'soat' | 'impuestos';
  /** Cómo se nombra la cola en el anuncio sr-only: «Preparando el archivo de SOAT.» */
  nombreCola: string;
}

export const COLA_SOAT: ColaExportable = {
  ruta: '/flito/soat/export', prefijo: 'soat', nombreCola: 'SOAT',
};
export const COLA_IMPUESTOS: ColaExportable = {
  ruta: '/flito/impuestos/export', prefijo: 'impuestos', nombreCola: 'impuestos',
};

/**
 * Rango del sello del nombre. No es «cualquier cosa de cuatro cifras»: acota el nombre a instantes
 * que este producto puede haber generado, con holgura para un servidor con el reloj corrido.
 *
 * Deliberadamente NO se comprueba la cercanía a `Date.now()`, aunque sea lo primero que se ocurre:
 * el sello es hora de COLOMBIA y el reloj de quien descarga puede estar en cualquier huso —o mal—,
 * así que una ventana de proximidad convertiría un portátil con zona horaria de Madrid en rechazos
 * falsos. La validación por componentes es determinista y no depende de ningún reloj.
 */
const ANIO_MIN = 2020;
const ANIO_MAX = 2100;

/**
 * ¿El nombre que declaró el servidor tiene la forma esperada, `<prefijo>_AAAAMMDD-HHmm.xlsx`?
 *
 * **El nombre de un archivo es una superficie más por la que puede salir un dato personal.** Un
 * `Content-Disposition: attachment; filename="soat_900123456.xlsx"` pondría el documento del
 * comprador en dos sitios peores que la URL: el disco de quien descarga —de donde el archivo se
 * reenvía por correo, con el dato en el asunto y en la carpeta compartida— y el «Archivo
 * descargado: …» que esta misma pantalla pinta.
 *
 * Que el servidor no vaya a mandar eso es una promesa del emisor, no una comprobación del receptor,
 * y la distancia entre las dos es exactamente lo que este guardia cierra.
 *
 * **El sello se exige EXACTO y además se comprueba que sea un INSTANTE, no ocho dígitos.** `[\d-]+`
 * aceptaría `soat_900123456.xlsx` sin pestañear —un NIT es exactamente eso—, y `\d{8}-\d{4}` deja
 * pasar `soat_19345678-0304.xlsx`, que es una cédula colombiana con forma de sello. Validando los
 * componentes, `19345678` muere solo: mes 56 y día 78 no existen.
 *
 * **La extensión es un parámetro** (HU #11910) y no una tercera expresión regular: el ZIP de
 * soportes valida `soportes_AAAAMMDD-HHmm.zip` con este mismo guardia, y dos formas escritas por
 * separado son dos reglas que se separan. El defecto por defecto sigue siendo `xlsx`, así que los
 * dos llamadores de la #11909 no cambian.
 *
 * Si no encaja se cae al nombre de respaldo —nunca se propaga el nombre raro—, y eso vale también
 * para el día en que el API cambie el formato a propósito: el archivo se seguirá descargando, con un
 * nombre peor, y esto será lo que haya que actualizar. Se prefiere esa molestia visible a una
 * ventana silenciosa.
 */
export function esNombreDeExport(prefijo: string, nombre: string, extension = 'xlsx'): boolean {
  const forma = new RegExp(`^${prefijo}_(\\d{4})(\\d{2})(\\d{2})-(\\d{2})(\\d{2})\\.${extension}$`);
  const partes = forma.exec(nombre);
  if (!partes) return false;
  const [anio, mes, dia, hora, minuto] = partes.slice(1).map(Number);
  return anio >= ANIO_MIN && anio <= ANIO_MAX
    && mes >= 1 && mes <= 12
    && dia >= 1 && dia <= 31
    && hora >= 0 && hora <= 23
    && minuto >= 0 && minuto <= 59;
}

/**
 * Lanza el export y devuelve el nombre con el que se guardó el archivo.
 *
 * `downloadPostNamed` es lo que hace que un error VESTIDO de archivo no acabe en la carpeta de
 * descargas: `request()` mira el `content-type` antes que `res.ok`, así que un 422 con cabecera de
 * xlsx sale por la rama del blob. Ese guardia vive en `lib/api.ts`; aquí solo hay que usarlo.
 */
export async function exportarCola(cola: ColaExportable, filtros: FiltrosExportCola): Promise<string> {
  return api.downloadPostNamed(
    cola.ruta,
    `${cola.prefijo}.xlsx`,
    filtros,
    (nombre) => esNombreDeExport(cola.prefijo, nombre),
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
 * **El respaldo del tope no lleva cifra, y eso es lo importante de esta función.** El tope efectivo
 * es una variable de ENTORNO del API; el número de verdad solo lo sabe el 422, que lo trae escrito
 * en su propio mensaje. Cualquier cifra compilada aquí queda verde hoy y miente el día en que un
 * despliegue mueva la variable, sin que nadie se entere. Por eso el eco del texto del servidor no es
 * una comodidad: es la única implementación correcta del tope.
 *
 * El eco está acotado a dos casos —el 422 del tope y el 429 del limitador— porque son dos frases
 * FIJAS del código del servidor, sin ningún hueco por donde pueda entrar lo que se estaba
 * consultando. Un 500 no lo es: su texto sí puede llevar dentro el documento del comprador, así que
 * ahí manda el copy propio.
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
            + 'búsqueda —por ejemplo, con un rango de "Creado en FLITO" más corto— y vuelve a exportar.',
      };
    }
    // 429 del limitador del export, que es cuota SEPARADA de la del listado.
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
        texto: 'Tu usuario ya no puede exportar. Habla con un administrador.',
      };
    }
    // `status === 0` es a la vez «no me respondió a tiempo» y «no llegué a preguntar»: el cliente no
    // los distingue y quien lo consume trata ambos igual.
    if (e.status === 0) {
      return {
        tono: 'error',
        reintentable: true,
        texto: 'El archivo tardó demasiado en generarse. Vuelve a intentarlo con un filtro más estrecho.',
      };
    }
  }
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
 * El estado de la descarga, con el candado del doble clic.
 *
 * **El candado es una `ref` y no el `disabled` del botón**, y la diferencia es la lección que costó
 * un rojo intermitente en la HU #11562: `disabled` es una propiedad que React escribe en el DOM en
 * el commit SIGUIENTE al clic. Entre el primer clic y ese commit cabe un segundo —un doble clic
 * humano, un `click()` desde el teclado, un lector de pantalla que reenvía el evento— y ese segundo
 * clic encontraría el botón todavía habilitado y saldría a la red. «No admite un segundo clic» es
 * una afirmación sobre la PETICIÓN, no sobre un atributo.
 *
 * La `ref` se escribe y se lee en el mismo instante síncrono del evento, así que no hay ventana. El
 * `disabled` se queda porque es lo que lo hace visible y evita el clic accidental; no es lo que lo
 * impide.
 *
 * Los filtros se leen de una `ref` que se refresca en cada render en vez de entrar en las
 * dependencias del `useCallback`: lo que hay que exportar es lo que está en pantalla **en el
 * instante del clic**, y las páginas arman ese objeto en cada render (identidad nueva cada vez). Con
 * la `ref`, la identidad del objeto deja de importar y no hay forma de mandar un filtro viejo.
 */
export function useExportCola(cola: ColaExportable, filtros: FiltrosExportCola): EstadoExport {
  const [ocupado, setOcupado] = useState(false);
  const [aviso, setAviso] = useState<AvisoExport | null>(null);
  const enVuelo = useRef(false);
  const ultimosFiltros = useRef(filtros);
  ultimosFiltros.current = filtros;

  const exportar = useCallback(() => {
    if (enVuelo.current) return;
    enVuelo.current = true;
    setOcupado(true);
    setAviso(null);

    exportarCola(cola, ultimosFiltros.current)
      .then((nombre) => setAviso({ tono: 'ok', reintentable: false, texto: `Archivo descargado: ${nombre}` }))
      .catch((e) => setAviso(avisoDeError(e)))
      .finally(() => {
        enVuelo.current = false;
        setOcupado(false);
      });
  }, [cola]);

  const descartar = useCallback(() => setAviso(null), []);

  return { ocupado, aviso, exportar, descartar };
}

/**
 * El botón y su línea de ayuda, para el hueco de acciones de la cabecera.
 *
 * Secundario y sin icono: en estas dos colas el primario ya está ocupado por «Cargar facturas
 * (masivo)» / «Cargar recibos (masivo)», que es la acción del día.
 *
 * `aria-busy` además del texto: quien navega con lector no ve que el rótulo cambió, y «Preparando el
 * archivo…» sin `aria-busy` es solo otra etiqueta.
 */
export function BotonExportarCola({ ocupado, onExportar }: { ocupado: boolean; onExportar: () => void }) {
  return (
    <div className="flex flex-col items-end gap-1">
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
      {/* Lo que el usuario no puede deducir del botón: que la descarga NO es la página que está
          viendo. Sin cifra del tope a propósito — el número lo trae el 422. */}
      <span className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
        Se exporta el conjunto filtrado que estás viendo, no solo esta página.
      </span>
    </div>
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
 *
 * El foco no se mueve ni al empezar ni al terminar: se queda en el botón, que sigue existiendo. La
 * banda es una región anunciada, no un diálogo.
 */
export function AvisoExportCola(
  { cola, ocupado, aviso, onReintentar, onDescartar }:
  {
    cola: ColaExportable; ocupado: boolean; aviso: AvisoExport | null;
    onReintentar: () => void; onDescartar: () => void;
  },
) {
  const esError = aviso?.tono === 'error';
  const anuncio = ocupado
    ? `Preparando el archivo de ${cola.nombreCola}.`
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

/**
 * La tarjeta del aviso. **Exportada desde la HU #11910**, que la reutiliza tal cual para el ZIP de
 * soportes: clonarla es garantizar que dentro de tres meses las dos tengan bordes distintos.
 *
 * No sabe nada de exports ni de ZIP —solo de tono, texto y dos botones— y por eso se puede compartir
 * sin que el nombre del módulo mienta.
 */
export function AvisoVisible(
  { aviso, onReintentar, onDescartar }:
  { aviso: AvisoExport; onReintentar: () => void; onDescartar: () => void },
) {
  const esError = aviso.tono === 'error';
  return (
    <div
      role={esError ? 'alert' : undefined}
      className="flex flex-wrap items-center justify-between gap-3 bg-flit-card px-6 py-4"
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
            {/* «Reintentar» a secas colisionaría con el de la banda de error de la COLA, que en SOAT
                puede estar en pantalla a la vez: dos botones con el mismo nombre accesible y dos
                efectos distintos. */}
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
