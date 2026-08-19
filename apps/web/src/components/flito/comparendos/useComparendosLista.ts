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

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ComparendoRegistro,
  ComparendosCausal,
  ComparendosMunicipio,
  ComparendosNit,
  ComparendosOrigenMerge,
  ComparendosRegistroEstado,
  ComparendosRegistrosBusqueda,
  ComparendosRegistrosPagina,
  ComparendosRegistrosQuery,
} from '@operaciones/shared-types';
import { ApiError, api } from '../../../lib/api';

const RUTA = '/flito/comparendos';

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
 * Pide una página. La ruta la decide la presencia de NIT o placa, no un flag del que acordarse.
 *
 * `query` se declara con el tipo del contrato en vez de escribir las claves sueltas en un
 * `URLSearchParams`: así, el día que el API renombre un filtro, esto no compila — que es justo lo
 * que no pasa con una cadena.
 */
async function pedirPagina(
  c: CriteriosComparendos,
  cursor: string | null,
): Promise<ComparendosRegistrosPagina> {
  const query: ComparendosRegistrosQuery = {};
  if (c.estado) query.estado = c.estado;
  const q = c.q.trim();
  if (q) query.q = q;
  if (c.municipio) query.municipio = c.municipio;
  if (c.fuente) query.fuente = c.fuente;
  if (c.causalId) query.causalId = c.causalId;
  if (c.sinCausal) query.sinCausal = true;
  // El cursor va tal cual llegó. `URLSearchParams` lo codifica para la URL y el servidor lo
  // decodifica: eso NO es reconstruirlo.
  if (cursor) query.cursor = cursor;

  const params = new URLSearchParams(
    Object.entries(query).map(([clave, valor]) => [clave, String(valor)]),
  );
  const sufijo = params.toString() ? `?${params}` : '';

  const nit = normalizarNit(c.nit).trim();
  const placa = c.placa.trim();
  if (nit || placa) {
    const cuerpo: ComparendosRegistrosBusqueda = {};
    if (nit) cuerpo.nit = nit;
    if (placa) cuerpo.placa = placa;
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
  };
}

/**
 * Catálogos de etiqueta: municipio, causal y alias del NIT.
 *
 * Se piden una sola vez por montaje y **su fallo nunca bloquea la tabla**: son etiquetas, no datos.
 * Una pantalla que no muestra ni un comparendo porque no pudo traducir «ITAGUI» a «Itagüí» estaría
 * cambiando información por cosmética. Por eso cada `catch` deja el mapa vacío y la celda cae al
 * valor crudo, que sigue siendo cierto.
 */
export interface CatalogosComparendos {
  /** `codigoFuente` → nombre. */
  municipios: Record<string, string>;
  /** `id` de la causal → nombre. */
  causales: Record<string, string>;
  /** NIT → alias. */
  alias: Record<string, string>;
}

const CATALOGOS_VACIOS: CatalogosComparendos = { municipios: {}, causales: {}, alias: {} };

export function useCatalogosComparendos(): CatalogosComparendos {
  const [catalogos, setCatalogos] = useState<CatalogosComparendos>(CATALOGOS_VACIOS);

  useEffect(() => {
    let vigente = true;
    // Cada `catch` es propio: que falle el catálogo de municipios no puede dejar sin alias al NIT.
    Promise.all([
      api.get<ComparendosMunicipio[]>(`${RUTA}/municipios`).catch(() => [] as ComparendosMunicipio[]),
      api.get<ComparendosCausal[]>(`${RUTA}/causales`).catch(() => [] as ComparendosCausal[]),
      api.get<ComparendosNit[]>(`${RUTA}/nits`).catch(() => [] as ComparendosNit[]),
    ]).then(([municipios, causales, nits]) => {
      if (!vigente) return;
      setCatalogos({
        municipios: Object.fromEntries((municipios ?? []).map((m) => [m.codigoFuente, m.nombre])),
        causales: Object.fromEntries((causales ?? []).map((c) => [c.id, c.nombre])),
        alias: Object.fromEntries(
          (nits ?? []).filter((n) => n.alias).map((n) => [n.nit, n.alias as string]),
        ),
      });
    });
    return () => { vigente = false; };
  }, []);

  return catalogos;
}
