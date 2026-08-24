// FLITO — Comparendos: el estado de la lista (HU #11560, Feature #11495 17b).
//
// Aquí vive todo lo que la pantalla necesita saber para pedir una página y nada de cómo se pinta:
// los criterios, la elección de ruta `GET`/`POST`, el cursor y los cuatro estados. La spec de UX
// (`docs/ux/flito-comparendos-visor.md`) fija las reglas duras que este archivo implementa:
//
//   · **La consulta NUNCA manda `limit`.** Ausente = `COMPARENDOS_REGISTROS_LIMIT_MAX` (50), que es
//     el tope Y el valor por defecto del router. Mandarlo sería repetir en la pantalla un número
//     que ya vive en shared-types, y es además la única forma de garantizar el AC5 sin un `Math.min`
//     que alguien pueda subir por descuido: no se puede pedir de más lo que no se pide.
//   · **El cursor se manda tal cual llegó**: opaco, sin construir, sin decodificar y sin recortar.
//   · **Ni el NIT ni la placa tocan la URL** (AGENTS.md §14, AC4): cuando alguno está puesto, la
//     consulta pasa por `POST /registros/buscar` con los dos en el CUERPO. La query sigue llevando
//     solo lo que no identifica a nadie —estado, `q`, los filtros de la #11555 y el cursor—.
//   · **Cambiar cualquier criterio descarta el cursor Y LA PILA ENTERA** (AC6). Lo segundo no lo
//     dice el AC y es la mitad que rompe: si la pila sobrevive, «Anterior» desde la primera página
//     del listado nuevo devuelve una página del listado viejo, con otros filtros, sin avisar. Aquí
//     los criterios y la pila son un solo estado (`Consulta`), así que no se pueden desincronizar.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ComparendoRegistro,
  ComparendosCausal,
  ComparendosExportRequest,
  ComparendosMunicipio,
  ComparendosNit,
  ComparendosOrigenMerge,
  ComparendosRegistroEstado,
  ComparendosRegistrosBusqueda,
  ComparendosRegistrosPagina,
  ComparendosRegistrosQuery,
} from '@operaciones/shared-types';
import { ApiError, api } from '../../../lib/api';

/** Base del módulo. La exporta para el export a Excel (HU #11561), que sale del mismo sitio. */
export const RUTA_COMPARENDOS = '/flito/comparendos';
const RUTA = RUTA_COMPARENDOS;

/**
 * Lo que el operador ha pedido ver.
 *
 * Los cuatro primeros son de esta HU. Los cuatro últimos son los filtros que la HU #11555 abrió en
 * el API (`municipio`, `fuente`, `causalId`, `sinCausal`) y que la **HU #11561** pondrá en pantalla:
 * están aquí, opcionales y ya cableados en la query, para que esa HU sea una barra de filtros nueva
 * y no un rediseño de este hook. Ningún control de esta HU los escribe.
 *
 * `estado` es `null` —y no `undefined`— cuando no se filtra: el ausente tiene que ser un valor que
 * el objeto lleve escrito, porque es lo que distingue «Todos» de «nadie ha tocado las pills».
 */
export interface CriteriosComparendos {
  estado: ComparendosRegistroEstado | null;
  /** Fragmento del NÚMERO de comparendo. Viaja en la query: no identifica a una persona. */
  q: string;
  /** Exacto y en el CUERPO. Nunca en la URL. */
  nit: string;
  /** Exacta y en el CUERPO. Nunca en la URL. */
  placa: string;
  municipio?: string;
  fuente?: ComparendosOrigenMerge;
  causalId?: string;
  sinCausal?: boolean;
}

export const CRITERIOS_VACIOS: CriteriosComparendos = { estado: null, q: '', nit: '', placa: '' };

/** ¿Hay algún criterio puesto? Es lo que separa el vacío A («no hay datos») del vacío B. */
export function hayCriterios(c: CriteriosComparendos): boolean {
  return Boolean(
    c.estado || c.q.trim() || c.nit.trim() || c.placa.trim()
    || c.municipio || c.fuente || c.causalId || c.sinCausal,
  );
}

/**
 * NIT como lo espera el API: sin puntos ni espacios, el guion del dígito de verificación intacto.
 *
 * Es el MISMO normalizador del servidor (`normalizarNit`). Se aplica al MANDARLO y no al
 * escribirlo: quien teclea «900.123.456» sigue viendo sus puntos, porque reescribir el campo bajo
 * los dedos es de las cosas más desconcertantes que puede hacer un formulario.
 */
export function normalizarNit(valor: string): string {
  return valor.replace(/[\s.]/g, '');
}

/**
 * Error de la consulta: qué se le dice al usuario y qué se le ofrece hacer.
 *
 * **El texto del servidor NO se hace eco**, y esta HU hereda la regla tal cual la dejó la #11559:
 * el copy se deriva del código de estado. El filtro que intentaba sanear ese texto en el cliente
 * dejaba pasar un NIT con separadores («900.123.456-7», que es como lo escriben SIMIT y los
 * organismos), cédulas con puntos, placas, hosts internos e IPs privadas — y un filtro por forma
 * siempre va una versión por detrás del siguiente formato. Lo que se pierde vale poco: para quien
 * mira la tabla, «no se pudo cargar, reintenta» y la traza del backend llevan a la misma acción.
 *
 * Aquí no hay ningún `console.*`: el módulo trata datos personales y la consola del navegador no
 * está bajo la retención que la Ley 1581 exige.
 */
export interface ErrorVista {
  texto: string;
  /** `reintentar` repite la misma consulta; `reiniciar` vuelve a la primera página. */
  accion: 'reintentar' | 'reiniciar' | null;
}

/** `codigo` del cuerpo de error, que `ApiError.rawDetails` conserva. NO se mira el texto. */
function codigoDe(e: ApiError): string | null {
  const cuerpo = e.rawDetails as { codigo?: unknown } | null | undefined;
  return typeof cuerpo?.codigo === 'string' ? cuerpo.codigo : null;
}

export function errorDeVista(e: unknown): ErrorVista {
  if (e instanceof ApiError) {
    // El cursor caducó porque el listado cambió mientras se paginaba. El mensaje real del backend
    // («…o pertenece a otra versión del listado. Pide la primera página sin `cursor`») es correcto
    // para quien integra e incomprensible para quien solo pasaba de página. Se detecta por `codigo`.
    if (e.status === 400 && codigoDe(e) === 'cursor_invalido') {
      return {
        texto: 'El listado cambió mientras cargabas más comparendos y esta página ya no existe. '
          + 'Vuelve al principio para ver los datos actuales.',
        accion: 'reiniciar',
      };
    }
    if (e.status === 403) {
      return {
        texto: 'Tu usuario ya no tiene acceso a los comparendos. Habla con un administrador.',
        accion: null,
      };
    }
    if (e.status === 429) {
      return {
        texto: 'Se hicieron demasiadas consultas seguidas. Espera un minuto y vuelve a intentarlo. '
          + 'El módulo limita las consultas porque cada página trae datos personales.',
        accion: 'reintentar',
      };
    }
    if (e.status === 0) {
      // Sin respuesta: se agotó el tiempo o no hubo red. Es la única distinción que la pantalla
      // puede hacer sin repetir nada de lo que dijo el servidor, porque el servidor no dijo nada.
      return {
        texto: 'No hubo respuesta del servidor al cargar los comparendos. Revisa tu conexión y vuelve a intentarlo.',
        accion: 'reintentar',
      };
    }
  }
  return {
    texto: 'No se pudieron cargar los comparendos. Vuelve a intentarlo; si sigue fallando, avisa a soporte.',
    accion: 'reintentar',
  };
}

/**
 * Lo que va en la URL: el contrato del export MENOS los dos filtros de identidad.
 *
 * El tipo se deriva de `ComparendosExportRequest` a propósito y no se escribe a mano: es lo que hace
 * que «la query lleva todo menos NIT y placa» sea una afirmación que el compilador sostiene. El día
 * que el API añada un filtro al export, esta clave aparece aquí sola y `repartirCriterios` deja de
 * compilar hasta que alguien decida de qué lado de la línea del §14 cae.
 */
export type QueryComparendos = Omit<ComparendosExportRequest, keyof ComparendosRegistrosBusqueda>;

/**
 * El reparto `CriteriosComparendos → (query, cuerpo)`. **Uno solo para la consulta y para el
 * export**, y el cursor es lo único que los distingue.
 *
 * Que sea uno solo es el requisito, no una limpieza: el export existe para entregar LO QUE EL
 * OPERADOR ESTÁ VIENDO, así que dos copias de esta función serían dos reglas que pueden separarse, y
 * separarse aquí significa descargar un archivo distinto de la tabla sin que nada avise. Hay además
 * tres formas de equivocarse que este reparto cierra de una vez para las dos rutas:
 *
 *   · **Mandarlo todo en el cuerpo → 400.** `registrosBusquedaSchema` es `.strict()` y solo admite
 *     `nit` y `placa`.
 *   · **Mandar `nit`/`placa` en la query → 400**, y antes de eso una fuga: es la línea del §14.
 *   · **No mandar los filtros no-identitarios en ninguna parte → 200 con la tabla ENTERA.** Es el
 *     peor de los tres porque no falla: entrega un archivo con NIT, placa y observaciones que nadie
 *     pidió. Aquí no puede pasar, porque `query` y `cuerpo` salen del mismo objeto de criterios.
 *
 * `limit` y `cursor` no están y no pueden estar: `exportQuerySchema` los OMITE y es `.strict()`, así
 * que un cursor colado en el export es un 400. Quien pagina lo añade fuera, en `pedirPagina`.
 */
export interface RepartoComparendos {
  query: QueryComparendos;
  cuerpo: ComparendosRegistrosBusqueda;
  /** ¿Hay filtro de identidad? Es lo que decide `GET /registros` vs `POST /registros/buscar`. */
  hayIdentidad: boolean;
}

export function repartirCriterios(c: CriteriosComparendos): RepartoComparendos {
  const query: QueryComparendos = {};
  if (c.estado) query.estado = c.estado;
  const q = c.q.trim();
  if (q) query.q = q;
  if (c.municipio) query.municipio = c.municipio;
  if (c.fuente) query.fuente = c.fuente;
  if (c.causalId) query.causalId = c.causalId;
  if (c.sinCausal) query.sinCausal = true;

  // El NIT se normaliza al MANDARLO, nunca al escribirlo (ver `normalizarNit`).
  const cuerpo: ComparendosRegistrosBusqueda = {};
  const nit = normalizarNit(c.nit).trim();
  const placa = c.placa.trim();
  if (nit) cuerpo.nit = nit;
  if (placa) cuerpo.placa = placa;

  return { query, cuerpo, hayIdentidad: Boolean(nit || placa) };
}

/** `?a=1&b=2` a partir del objeto tipado, o cadena vacía si no hay nada que mandar. */
export function sufijoQuery(query: object): string {
  const params = new URLSearchParams(
    Object.entries(query)
      .filter(([, valor]) => valor !== undefined && valor !== null)
      .map(([clave, valor]) => [clave, String(valor)] as [string, string]),
  );
  return params.toString() ? `?${params}` : '';
}

/**
 * Pide una página. La ruta la decide la presencia de NIT o placa, no un flag del que acordarse.
 *
 * Lo único que esta función añade al reparto compartido es el `cursor`, y va TAL CUAL llegó: opaco,
 * sin construir y sin recortar (`URLSearchParams` lo codifica para la URL y el servidor lo
 * decodifica; eso no es reconstruirlo).
 */
async function pedirPagina(
  c: CriteriosComparendos,
  cursor: string | null,
): Promise<ComparendosRegistrosPagina> {
  const { query, cuerpo, hayIdentidad } = repartirCriterios(c);
  const conCursor: ComparendosRegistrosQuery = cursor ? { ...query, cursor } : query;
  const sufijo = sufijoQuery(conCursor);

  if (hayIdentidad) {
    return api.post<ComparendosRegistrosPagina>(`${RUTA}/registros/buscar${sufijo}`, cuerpo);
  }
  return api.get<ComparendosRegistrosPagina>(`${RUTA}/registros${sufijo}`);
}

export interface ListaComparendos {
  /** Lo que se está consultando ahora mismo. La barra de filtros pinta a partir de esto. */
  criterios: CriteriosComparendos;
  /** `null` = todavía no se sabe (cargando o error). Nunca son «cero filas». */
  items: ComparendoRegistro[] | null;
  cargando: boolean;
  error: ErrorVista | null;
  /** 1-based, y sale del alto de la pila. NO es «página 3 de 47»: el total no existe. */
  pagina: number;
  hayAnterior: boolean;
  haySiguiente: boolean;
  /** Aplica un cambio parcial de criterios. Vacía la pila: es el AC6. */
  aplicar: (parcial: Partial<CriteriosComparendos>) => void;
  limpiar: () => void;
  anterior: () => void;
  siguiente: () => void;
  /** Repite la consulta vigente, con los mismos criterios y la misma página. */
  recargar: () => void;
  /** Vuelve a la primera página tirando la pila. Es la salida del `cursor_invalido`. */
  volverAlPrincipio: () => void;
  /**
   * Reemplaza UNA fila con el registro que devolvió el `PATCH` de gestión (HU #11562, AC3).
   *
   * **No vuelve a pedir la página, y eso es el requisito, no un atajo.** Volver a pedirla movería la
   * lista bajo los pies de quien acaba de gestionar —con cursor, una fila reordenada puede
   * desaparecer de la vista— y además gastaría una consulta del limitador y una fila del registro de
   * acceso PII por cada gestión. La respuesta del PATCH ya es el registro completo, así que aquí no
   * se compara nada ni se mezclan campos: la fila vieja se sustituye entera por la nueva.
   *
   * Si el id no está en la página que se está viendo, no hace nada: no se inventa una fila que el
   * filtro puesto no eligió.
   */
  parchearItem: (registro: ComparendoRegistro) => void;
}

/**
 * Lo que define UNA consulta: los criterios, la pila de cursores que llevó hasta esta página y un
 * nonce para poder repetirla.
 *
 * Van juntos en un solo estado y no en tres `useState`, y no es una preferencia de estilo: es lo
 * que hace **imposible** consultar unos criterios nuevos con el cursor de los viejos. Con estados
 * separados, cambiar un filtro dejaría la pila en pie durante un render —el `setPila([])` de otro
 * efecto llega un commit tarde— y esa consulta intermedia ya habría salido a la red, con un cursor
 * que apunta a una posición dentro de un orden que el filtro acaba de cambiar. Aquí el cambio de
 * criterios y el vaciado de la pila son la MISMA transición de estado.
 */
interface Consulta {
  criterios: CriteriosComparendos;
  /** Cursores usados para llegar aquí. Vacía = primera página. El último es el de esta página. */
  pila: string[];
  nonce: number;
}

/** ¿Son la misma pregunta? Evita tirar la paginación —y escribir una fila en el registro de acceso
 *  PII— cuando alguien vuelve a pulsar la pill que ya estaba puesta. */
function mismosCriterios(a: CriteriosComparendos, b: CriteriosComparendos): boolean {
  return a.estado === b.estado && a.q.trim() === b.q.trim()
    && a.nit.trim() === b.nit.trim() && a.placa.trim() === b.placa.trim()
    && a.municipio === b.municipio && a.fuente === b.fuente
    && a.causalId === b.causalId && Boolean(a.sinCausal) === Boolean(b.sinCausal);
}

export function useComparendosLista(): ListaComparendos {
  const [consulta, setConsulta] = useState<Consulta>({
    criterios: CRITERIOS_VACIOS, pila: [], nonce: 0,
  });
  const [items, setItems] = useState<ComparendoRegistro[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<ErrorVista | null>(null);
  // Una petición por vuelo, la última gana: la respuesta de una consulta que ya no es la vigente se
  // descarta en vez de pintarse encima de la que el usuario acaba de pedir.
  const vuelo = useRef(0);

  useEffect(() => {
    const turno = vuelo.current + 1;
    vuelo.current = turno;
    setItems(null);
    setError(null);
    setNextCursor(null);
    // El cursor de ESTA página es el último de la pila; en la primera no hay ninguno y la consulta
    // sale sin `cursor`, que es lo que el AC6 exige tras cambiar de criterio.
    const cursor = consulta.pila.length ? consulta.pila[consulta.pila.length - 1] : null;
    pedirPagina(consulta.criterios, cursor)
      .then((pagina) => {
        if (turno !== vuelo.current) return;
        setItems(pagina?.items ?? []);
        setNextCursor(pagina?.nextCursor ?? null);
      })
      .catch((e) => { if (turno === vuelo.current) setError(errorDeVista(e)); });
  }, [consulta]);

  const aplicar = useCallback((parcial: Partial<CriteriosComparendos>) => {
    setConsulta((c) => {
      const criterios = { ...c.criterios, ...parcial };
      if (mismosCriterios(criterios, c.criterios)) return c;
      return { criterios, pila: [], nonce: c.nonce };
    });
  }, []);

  const limpiar = useCallback(() => {
    setConsulta((c) => (hayCriterios(c.criterios)
      ? { criterios: CRITERIOS_VACIOS, pila: [], nonce: c.nonce }
      : c));
  }, []);

  const recargar = useCallback(() => setConsulta((c) => ({ ...c, nonce: c.nonce + 1 })), []);

  const volverAlPrincipio = useCallback(
    () => setConsulta((c) => ({ criterios: c.criterios, pila: [], nonce: c.nonce + 1 })),
    [],
  );

  // El cursor se apila TAL CUAL llegó: opaco, sin construir y sin recortar.
  const siguiente = useCallback(() => {
    if (!nextCursor) return;
    setConsulta((c) => ({ ...c, pila: [...c.pila, nextCursor] }));
  }, [nextCursor]);

  // Retroceder con un cursor keyset es desapilar: el API solo sabe ir hacia adelante desde una
  // posición, así que la única forma de volver a la página anterior es volver a pedirla con el
  // cursor con el que se pidió la primera vez.
  const anterior = useCallback(() => {
    setConsulta((c) => (c.pila.length ? { ...c, pila: c.pila.slice(0, -1) } : c));
  }, []);

  // Solo toca `items`. `consulta` no se mueve, así que el efecto de la petición NO se vuelve a
  // disparar: es lo que hace que refrescar la fila no sea re-consultar.
  const parchearItem = useCallback((registro: ComparendoRegistro) => {
    setItems((prev) => (prev
      ? prev.map((i) => (i.id === registro.id ? registro : i))
      : prev));
  }, []);

  return {
    criterios: consulta.criterios,
    items,
    cargando: items === null && error === null,
    error,
    pagina: consulta.pila.length + 1,
    hayAnterior: consulta.pila.length > 0,
    haySiguiente: nextCursor !== null,
    aplicar,
    limpiar,
    anterior,
    siguiente,
    recargar,
    volverAlPrincipio,
    parchearItem,
  };
}

/**
 * Catálogos de municipio, causal y alias del NIT. Dos oficios en el mismo sitio, y desde la
 * HU #11561 el segundo manda más que el primero.
 *
 *   1. **Etiquetas de la tabla** (HU #11560): traducen «ITAGUI» a «Itagüí» y el id de una causal a
 *      su nombre. Para eso su fallo NUNCA puede bloquear nada —una pantalla que no muestra ni un
 *      comparendo porque no pudo traducir un código estaría cambiando información por cosmética—, y
 *      por eso la celda cae al valor crudo, que sigue siendo cierto.
 *   2. **Opciones de los selectores de filtro** (HU #11561, AC2). Aquí el fallo SÍ se nota: un
 *      selector sin opciones no es un selector, es un control que miente. El AC pide que un catálogo
 *      caído deshabilite **su** selector con **su** mensaje y sin tumbar la página.
 *
 * De ahí que el estado sea **por catálogo y no compartido**: con un único indicador, que fallara el
 * de municipios dejaría también muerto el de causales, que había cargado bien. Un `Promise.all`
 * tampoco vale para esto —aunque cada `catch` fuera propio— porque publica los tres a la vez y el
 * selector de causales se quedaría en «cargando» esperando a un municipio que no va a llegar.
 * Aquí cada catálogo es una petición, un estado y un reintento independientes.
 */
export type EstadoCatalogo = 'cargando' | 'ok' | 'error';

/** Los tres catálogos del módulo, cada uno con su estado. */
export type ClaveCatalogo = 'municipios' | 'causales' | 'nits';

export interface CatalogosComparendos {
  /** `codigoFuente` → nombre. */
  municipios: Record<string, string>;
  /** `id` de la causal → nombre. */
  causales: Record<string, string>;
  /** NIT → alias. */
  alias: Record<string, string>;
  /**
   * El catálogo de causales SIN aplanar (HU #11562).
   *
   * La tabla solo necesita el nombre, pero el selector del formulario de gestión necesita además
   * `orden` —que existe para que la lista no se ordene alfabéticamente— y `activo` —para dejar en
   * la lista la causal inactiva que ya está asignada, y solo esa—. Se guarda la lista tal cual
   * llegó en vez de añadir dos mapas más: el mapa de nombres se deriva de ella y no pueden
   * separarse.
   */
  listaCausales: ComparendosCausal[];
  /**
   * El catálogo de municipios SIN aplanar (HU #11561), por el mismo motivo que el de causales: el
   * selector de filtro necesita `activo` para no ofrecer fuentes dadas de baja, y `codigoFuente`
   * —que es el valor que viaja al API— además del nombre que se enseña.
   */
  listaMunicipios: ComparendosMunicipio[];
  /** `cargando | ok | error` de cada uno. Es lo que deshabilita UN selector y no los dos. */
  estado: Record<ClaveCatalogo, EstadoCatalogo>;
  /** Vuelve a pedir UN catálogo. Es el reintento del estado de error del AC2. */
  recargar: (cual: ClaveCatalogo) => void;
}

/**
 * Un catálogo: su lista, su estado y su reintento.
 *
 * Se escribe una vez y se usa tres veces en lugar de repetir el bloque: tres copias del mismo
 * `then`/`catch` son tres sitios donde el estado de error puede olvidarse en uno solo, que es
 * exactamente el fallo que el AC2 describe.
 */
function useCatalogo<T>(ruta: string): { datos: T[]; estado: EstadoCatalogo; recargar: () => void } {
  const [datos, setDatos] = useState<T[]>([]);
  const [estado, setEstado] = useState<EstadoCatalogo>('cargando');
  const [intento, setIntento] = useState(0);

  useEffect(() => {
    let vigente = true;
    setEstado('cargando');
    api.get<T[]>(ruta)
      .then((lista) => {
        if (!vigente) return;
        // **`Array.isArray` y no `?? []`**: si el endpoint responde 200 con algo que no es una
        // lista, guardarlo tal cual haría que el `.map()` de abajo reventara EN RENDER y, con él,
        // la pantalla entera — que es justo lo contrario de lo que este hook promete («el fallo de
        // un catálogo de etiquetas no bloquea la tabla»). Un cuerpo inesperado se trata como un
        // catálogo vacío, que es lo que en la práctica es.
        setDatos(Array.isArray(lista) ? lista : []);
        setEstado('ok');
      })
      .catch(() => {
        if (!vigente) return;
        // La lista se VACÍA al fallar: dejar las opciones de un intento anterior junto a un mensaje
        // de error sería ofrecer para elegir algo que no se pudo confirmar.
        setDatos([]);
        setEstado('error');
      });
    return () => { vigente = false; };
  }, [ruta, intento]);

  const recargar = useCallback(() => setIntento((i) => i + 1), []);
  return { datos, estado, recargar };
}

export function useCatalogosComparendos(): CatalogosComparendos {
  // Se desestructura en vez de guardar los tres objetos: `useCatalogo` devuelve un objeto nuevo en
  // cada render, así que dependiendo de él las memos de abajo no memorizarían nada. Lo que sí es
  // estable es cada `datos`, cada `estado` y cada `recargar`, y son los que van en las dependencias.
  const {
    datos: listaMunicipios, estado: estadoMunicipios, recargar: recargarMunicipios,
  } = useCatalogo<ComparendosMunicipio>(`${RUTA}/municipios`);
  const {
    datos: listaCausales, estado: estadoCausales, recargar: recargarCausales,
  } = useCatalogo<ComparendosCausal>(`${RUTA}/causales`);
  const {
    datos: listaNits, estado: estadoNits, recargar: recargarNits,
  } = useCatalogo<ComparendosNit>(`${RUTA}/nits`);

  const recargar = useCallback((cual: ClaveCatalogo) => {
    if (cual === 'municipios') recargarMunicipios();
    else if (cual === 'causales') recargarCausales();
    else recargarNits();
  }, [recargarMunicipios, recargarCausales, recargarNits]);

  return useMemo(() => ({
    municipios: Object.fromEntries(listaMunicipios.map((m) => [m.codigoFuente, m.nombre])),
    causales: Object.fromEntries(listaCausales.map((c) => [c.id, c.nombre])),
    alias: Object.fromEntries(
      listaNits.filter((n) => n.alias).map((n) => [n.nit, n.alias as string]),
    ),
    listaCausales,
    listaMunicipios,
    estado: { municipios: estadoMunicipios, causales: estadoCausales, nits: estadoNits },
    recargar,
  }), [listaMunicipios, listaCausales, listaNits,
    estadoMunicipios, estadoCausales, estadoNits, recargar]);
}
