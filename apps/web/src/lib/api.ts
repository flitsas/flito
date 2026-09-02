const BASE = '/api';

// Tope duro de tiempo por petición. Sin esto, un fetch contra una dependencia
// lenta que nunca responde (p.ej. la cadena RUNT del SOAT) deja la promesa
// colgada para siempre → el `finally` que apaga el spinner nunca corre.
// 90s da margen al peor caso de RUNT (captcha + sub-peticiones) pero garantiza
// que el cliente SIEMPRE resuelve o falla con un error legible.
//
// El tope cubre la petición ENTERA —cabeceras y cuerpo—, no solo el `fetch`. `fetch` resuelve en
// cuanto llegan las cabeceras y el cuerpo se lee después (`res.json()`, `res.blob()`): apagar el
// reloj ahí dejaría sin reloj justo la parte que puede estancarse durante minutos, que es lo que
// pasa cuando el servidor responde 200 y luego se queda a medias. Ver `request`.
const REQUEST_TIMEOUT_MS = 90_000;

/**
 * Techo duro para el tope POR PETICIÓN (`postConTimeout`). No sube el de arriba: son cosas distintas.
 *
 * `REQUEST_TIMEOUT_MS` lo comparten ~500 llamadas de toda la app y su valor está justificado por el
 * peor caso de RUNT; subirlo para que una pantalla pueda esperar más cambiaría el comportamiento de
 * todas las demás. Lo que se añade es la posibilidad de que UNA llamada pida más tiempo, y este
 * techo es lo que impide que ese permiso se convierta en «el que llama decide sin límite».
 *
 * El techo va siempre por DEBAJO del corte del proxy: pasado ese punto quien corta es nginx y el
 * cliente recibe un 502/504 en vez de su propio abort — el llamador perdería la distinción entre
 * «se me acabó el tiempo a mí» y «el servidor falló», que es justo la que la consola de
 * sincronización necesita para no pintar un fallo rojo definitivo (HU #11635).
 *
 * Era 115 s cuando `proxy_read_timeout` valía 120 s. Ese corte sube a 900 s en
 * `apps/web/nginx.conf.template` para que quepa la carga masiva de SOAT e impuestos: su OCR es
 * secuencial (~3,4 s por comprobante) y una tanda llena pasa de los tres minutos. 600 s deja margen
 * de sobra por debajo de los 900 del proxy.
 *
 * **Los dos valores están acoplados**: si alguien baja el `proxy_read_timeout` de la plantilla, hay
 * que bajar este techo con él, o se pierde la distinción de arriba.
 */
const TIMEOUT_MAX_MS = 600_000;

/**
 * Tope efectivo de una petición: el pedido, acotado al techo, o el de siempre si no se pide nada.
 *
 * Un valor no finito o ≤ 0 cae al de siempre en vez de abortar al instante: un `NaN` colado en un
 * cálculo del llamador dejaría la petición muerta antes de salir, y eso se diagnostica fatal.
 */
function topeDeTiempo(pedido?: number): number {
  if (pedido === undefined || !Number.isFinite(pedido) || pedido <= 0) return REQUEST_TIMEOUT_MS;
  return Math.min(pedido, TIMEOUT_MAX_MS);
}

function getToken(): string | null {
  return localStorage.getItem('token');
}

export function setToken(token: string) {
  localStorage.setItem('token', token);
}

export function clearToken() {
  localStorage.removeItem('token');
}

// ---------------------------------------------------------------------------
// Fin de sesión (F-2): en vez de window.location.href (recarga dura que pierde
// el contexto y el motivo), emitimos un evento que AuthProvider escucha para
// hacer logout vía router (navegación SPA). Guardamos el motivo y la ruta para
// que Login muestre el mensaje correcto y devuelva al usuario a donde estaba.
// ---------------------------------------------------------------------------
export const SESSION_ENDED_EVENT = 'auth:session-ended';
export type SessionEndReason = 'invalidated' | 'expired';

function endSession(reason: SessionEndReason): void {
  clearToken();
  try {
    sessionStorage.setItem('auth:end-reason', reason);
    const current = window.location.pathname + window.location.search;
    if (!current.startsWith('/login')) sessionStorage.setItem('auth:redirect', current);
  } catch { /* sessionStorage no disponible */ }
  window.dispatchEvent(new CustomEvent(SESSION_ENDED_EVENT));
}

/** Lee y limpia el motivo de fin de sesión (consumido una vez por Login). */
export function consumeSessionEndReason(): SessionEndReason | null {
  try {
    const r = sessionStorage.getItem('auth:end-reason');
    if (r === 'invalidated' || r === 'expired') {
      sessionStorage.removeItem('auth:end-reason');
      return r;
    }
  } catch { /* ignore */ }
  return null;
}

/** Lee y limpia la ruta previa para volver tras re-login. Default '/'. */
export function consumeRedirectPath(): string {
  try {
    const p = sessionStorage.getItem('auth:redirect');
    sessionStorage.removeItem('auth:redirect');
    if (p && p.startsWith('/') && !p.startsWith('/login')) return p;
  } catch { /* ignore */ }
  return '/';
}

/**
 * Error de API con contexto preservado: status HTTP, mensaje del backend, y fieldErrors zod.
 * Permite al frontend distinguir entre validación, conflicto, no autorizado, etc.
 */
export class ApiError extends Error {
  public readonly status: number;
  public readonly fieldErrors?: Record<string, string[]>;
  public readonly rawDetails?: unknown;

  constructor(status: number, message: string, fieldErrors?: Record<string, string[]>, rawDetails?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.fieldErrors = fieldErrors;
    this.rawDetails = rawDetails;
  }

  /** Texto legible para mostrar al usuario, con detalles de validación si los hay. */
  toUserMessage(): string {
    if (this.fieldErrors) {
      const flat = Object.entries(this.fieldErrors)
        .flatMap(([field, msgs]) => msgs.map((m) => `${field}: ${m}`));
      if (flat.length > 0) return flat.join(' · ');
    }
    return this.message;
  }
}

function statusToMessage(status: number, backendMsg?: string): string {
  if (backendMsg) return backendMsg;
  if (status === 0) return 'Sin conexión con el servidor';
  if (status === 400) return 'Solicitud inválida';
  if (status === 403) return 'Sin permisos para esta operación';
  if (status === 404) return 'Recurso no encontrado';
  if (status === 409) return 'Conflicto — recargue y reintente';
  if (status === 429) return 'Demasiadas solicitudes, espere un momento';
  if (status >= 500 && status < 600) return 'Error del servidor — intente más tarde';
  return `Error ${status}`;
}

/**
 * Gancho de SOLO LECTURA sobre la respuesta cruda, antes de que `request` consuma el cuerpo.
 *
 * Existe por una pérdida concreta: `request` devuelve `res.json()` o `res.blob()` y con ello se va
 * el objeto `Response` entero, incluidas sus cabeceras. El nombre de un archivo lo decide el
 * SERVIDOR en `Content-Disposition` —en comparendos, con la hora de Colombia— y sin este gancho el
 * llamador no tiene forma de leerlo: se lo tiene que inventar.
 *
 * No puede alterar nada: no devuelve valor y se llama antes de tocar el cuerpo, así que no compite
 * con quien lo lee después.
 */
type GanchoRespuesta = (res: Response) => void;

/** AbortError = se cumplió el tope de tiempo (no es «sin conexión»), lo pare el `fetch` o el cuerpo. */
function esCorteDelTope(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

const errorDeTope = () => new ApiError(0, 'La consulta tardó demasiado. Intente de nuevo.');

/**
 * Lee el cuerpo BAJO el tope de tiempo.
 *
 * Cuando el tope se cumple mientras el cuerpo se está leyendo, quien rechaza es el stream y lo hace
 * con un `AbortError`: se traduce al MISMO error que sale al agotarse esperando las cabeceras,
 * porque para quien llama es el mismo suceso y no tiene por qué distinguirlos.
 *
 * Cualquier otro fallo sale tal cual. Un JSON malformado no es un corte de tiempo, y disfrazarlo de
 * uno mandaría a reintentar contra un cuerpo que no va a parsear nunca.
 */
async function leerCuerpo<T>(leer: () => Promise<T>): Promise<T> {
  try {
    return await leer();
  } catch (e) {
    throw esCorteDelTope(e) ? errorDeTope() : e;
  }
}

async function request<T>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>, alRecibir?: GanchoRespuesta, timeoutMs?: number): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (extraHeaders) Object.assign(headers, extraHeaders);

  const opts: RequestInit = { method, headers };

  if (body instanceof FormData) {
    opts.body = body;
  } else if (body) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  const controller = new AbortController();
  opts.signal = controller.signal;
  const timeoutId = setTimeout(() => controller.abort(), topeDeTiempo(timeoutMs));

  // `await` y no `return` a secas: el `finally` apaga el reloj, y devolver la promesa sin esperarla
  // lo apagaría con el cuerpo todavía a medio leer — que es exactamente el agujero que se cerró.
  try {
    return await pedirYLeer<T>(path, opts, alRecibir);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * La petición y la lectura de su cuerpo, ambas dentro del tope que `request` mantiene armado.
 *
 * Está separada de `request` por eso: el reloj se apaga en el `finally` de allí, así que todo lo que
 * toque el cuerpo tiene que quedar dentro de esta función y ser esperado.
 */
async function pedirYLeer<T>(path: string, opts: RequestInit, alRecibir?: GanchoRespuesta): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, opts);
  } catch (e) {
    if (esCorteDelTope(e)) throw errorDeTope();
    throw new ApiError(0, statusToMessage(0));
  }

  // Antes del 401, del blob y del `!res.ok`: quien lo pasa quiere las cabeceras pase lo que pase
  // después, incluidas las de una respuesta de error.
  alRecibir?.(res);

  // 401 global → fin de sesión vía evento (navegación SPA), no recarga dura.
  // EXCEPCIÓN: el propio /auth/login devuelve 401 para credenciales inválidas.
  // No disparar ahí — dejamos que el componente Login muestre el mensaje real
  // ("Credenciales inválidas") en el toast.
  if (res.status === 401 && !path.startsWith('/auth/login')) {
    const data = await res.json().catch(() => ({} as Record<string, unknown>));
    const backendMsg = typeof data?.error === 'string' ? data.error : '';
    // El backend distingue "Sesión invalidada…" (permisos cambiados por admin) del
    // resto (token expirado/ inválido). Mapeamos a un motivo legible para Login.
    endSession(/invalidad/i.test(backendMsg) ? 'invalidated' : 'expired');
    throw new ApiError(401, backendMsg || 'Sesión expirada');
  }

  // File downloads — pasar a través como blob.
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('spreadsheet') || ct.includes('octet-stream') || ct.includes('zip') || ct.includes('pdf') || ct.includes('csv') || ct.includes('image/')) {
    return leerCuerpo(() => res.blob() as unknown as Promise<T>);
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({} as Record<string, unknown>));
    // Algunos handlers devuelven `error`, otros `message` (p.ej. vehicles/ocr).
    // Aceptamos ambos para no caer al genérico cuando el backend ya dio contexto.
    const backendMsg = typeof data?.error === 'string'
      ? data.error
      : typeof data?.message === 'string'
        ? data.message
        : undefined;
    const details = (data?.details ?? null) as { fieldErrors?: Record<string, string[]> } | null;
    throw new ApiError(res.status, statusToMessage(res.status, backendMsg), details?.fieldErrors, data);
  }

  // 204 No Content (típicamente DELETE) y respuestas vacías: no parsear JSON.
  if (res.status === 204 || res.headers.get('content-length') === '0') return undefined as unknown as T;
  return leerCuerpo<T>(() => res.json() as Promise<T>);
}

/**
 * El nombre del archivo tal y como lo declara el servidor en `Content-Disposition`.
 *
 * Se prefiere el del servidor al que pueda componer la pantalla porque el sello de tiempo del
 * archivo es SUYO: en comparendos, `nombreArchivoExport()` lo calcula en hora de Colombia, y un
 * nombre fabricado en el cliente llevaría la hora del sistema operativo de quien descarga —que en
 * un equipo con otra zona horaria nombraría el mismo archivo con otro día—.
 *
 * Se admiten las dos formas del RFC 6266 y gana `filename*`, que es la que declara su codificación.
 * Devuelve `null` cuando no hay cabecera, cuando no es interpretable o cuando lo que queda tras
 * sanear está vacío: el llamador siempre tiene que traer un nombre de respaldo.
 */
export function nombreDeContentDisposition(cabecera: string | null): string | null {
  if (!cabecera) return null;
  const extendido = /filename\*\s*=\s*([^;]+)/i.exec(cabecera);
  if (extendido) {
    const valor = extendido[1].trim();
    // `UTF-8''nombre.xlsx` → se descarta el juego de caracteres y el idioma y se decodifica el resto.
    const partes = valor.split("''");
    const texto = partes.length > 1 ? partes.slice(1).join("''") : valor;
    try { return saneaNombreDeArchivo(decodeURIComponent(texto)); } catch { return saneaNombreDeArchivo(texto); }
  }
  const simple = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(cabecera);
  return simple ? saneaNombreDeArchivo(simple[1] ?? simple[2]) : null;
}

/**
 * El nombre viene de la red, así que se trata como tal aunque lo haya escrito nuestro propio API.
 *
 * Se queda con el último segmento —un `filename` con separadores no puede proponer una ruta— y
 * quita comillas y caracteres de control, que es lo que un nombre con `\r\n` usaría para escribirse
 * de más en la carpeta de descargas.
 */
function saneaNombreDeArchivo(valor: string | undefined): string | null {
  const base = (valor ?? '').split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex -- es justo lo que hay que quitar.
  const limpio = base.replace(/[\u0000-\u001F\u007F"]/g, '').trim();
  return limpio && limpio !== '.' && limpio !== '..' ? limpio : null;
}

/**
 * Entrega el blob al navegador y **libera el object URL DESPUÉS de la descarga**, no en la misma
 * vuelta síncrona.
 *
 * Revocar en la misma vuelta del `a.click()` funciona en Chromium porque la descarga queda
 * registrada durante el despacho del clic, pero es una carrera que depende del navegador: revocar
 * la URL antes de que la descarga haya empezado a leer el blob la deja sin origen. Aquí se cede el
 * turno primero (`setTimeout`), que es lo que convierte «se libera después de la descarga» en una
 * afirmación cierta y no en una que suele cumplirse.
 *
 * El ancla se ADJUNTA al documento antes de pulsarla y se retira después: hay navegadores que
 * ignoran el clic sobre un ancla que no está en el árbol.
 *
 * La usan las TRES formas de descargar de este módulo —`download`, `downloadPost` y
 * `downloadPostNamed`—: `download` y `downloadPost` nacieron con la revocación síncrona y se
 * migraron aquí en la HU #11652, que es cuando dejaron de estar sin test (AC2).
 */
function entregarArchivo(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Un error que llegó VESTIDO de archivo.
 *
 * `request` mira el `content-type` ANTES que `res.ok`, así que una respuesta de error con
 * `content-type` de xlsx no entra por la rama de error: sale como blob y acaba en la carpeta de
 * descargas del usuario, con extensión `.xlsx` y un JSON dentro. El caso normal no ocurre —el 422
 * del tope y el 429 del limitador responden JSON y sí lanzan `ApiError`—, pero el que ocurra
 * depende de una cabecera que pone el servidor, y eso no es una garantía del cliente.
 *
 * Se reconstruye aquí el mismo `ApiError` que habría salido por la rama buena, leyendo el cuerpo
 * que ya se consumió como blob.
 */
async function errorVestidoDeArchivo(status: number, blob: Blob): Promise<ApiError> {
  let cuerpo: Record<string, unknown> = {};
  try { cuerpo = JSON.parse(await blob.text()) as Record<string, unknown>; } catch { /* no era JSON */ }
  const backendMsg = typeof cuerpo.error === 'string'
    ? cuerpo.error
    : typeof cuerpo.message === 'string' ? cuerpo.message : undefined;
  const details = (cuerpo.details ?? null) as { fieldErrors?: Record<string, string[]> } | null;
  return new ApiError(status, statusToMessage(status, backendMsg), details?.fieldErrors, cuerpo);
}

export const api = {
  get: <T>(path: string, extraHeaders?: Record<string, string>) => request<T>('GET', path, undefined, extraHeaders),
  post: <T>(path: string, body?: unknown, extraHeaders?: Record<string, string>) => request<T>('POST', path, body, extraHeaders),
  /**
   * POST que puede esperar MÁS (o menos) que el tope compartido, acotado por `TIMEOUT_MAX_MS`.
   *
   * Se añade en vez de meter un parámetro en `post` —mismo criterio que `downloadPostNamed`— porque
   * `post` lo llaman cientos de sitios y su firma no se mueve por una pantalla. Lo pide el disparo
   * de la sincronización de comparendos (HU #11635), que es síncrono en el servidor y tarda minutos.
   *
   * **Cuánto tiempo se pide lo decide el llamador, no este archivo**: aquí no se sabe qué rutas hay
   * ni cuánto tarda cada una. Lo único que este módulo garantiza es el techo.
   *
   * Al agotarse sale un `ApiError` con `status === 0` —el mismo que un fallo de red— y eso es
   * deliberado: el cliente no puede distinguir «no me respondió a tiempo» de «no llegué a
   * preguntar», y quien lo consume trata ambos igual.
   */
  postConTimeout: <T>(path: string, body: unknown, timeoutMs: number, extraHeaders?: Record<string, string>) =>
    request<T>('POST', path, body, extraHeaders, undefined, timeoutMs),
  patch: <T>(path: string, body?: unknown, extraHeaders?: Record<string, string>) => request<T>('PATCH', path, body, extraHeaders),
  put: <T>(path: string, body?: unknown, extraHeaders?: Record<string, string>) => request<T>('PUT', path, body, extraHeaders),
  delete: <T>(path: string, extraHeaders?: Record<string, string>) => request<T>('DELETE', path, undefined, extraHeaders),
  upload: <T>(path: string, file: File, fieldName = 'file', fields?: Record<string, string>) => {
    const form = new FormData();
    form.append(fieldName, file);
    if (fields) for (const [k, v] of Object.entries(fields)) form.append(k, v);
    return request<T>('POST', path, form);
  },
  /** Carga varios archivos bajo el MISMO campo (multer `upload.array`), p.ej. un lote de recibos. */
  uploadMany: <T>(path: string, files: File[], fieldName = 'archivos', fields?: Record<string, string>) => {
    const form = new FormData();
    for (const file of files) form.append(fieldName, file);
    if (fields) for (const [k, v] of Object.entries(fields)) form.append(k, v);
    return request<T>('POST', path, form);
  },
  download: async (path: string, filename: string) => {
    const blob = await request<Blob>('GET', path);
    entregarArchivo(blob, filename);
  },
  /**
   * GET que devuelve un blob **y el nombre que declaró el servidor** (HU #11910).
   *
   * Es `downloadPostNamed` sin la entrega: quien llama no quiere guardar el archivo todavía —lo va a
   * pintar en un visor— pero sí necesita con qué nombre ofrecerlo después. Sin esto, la única forma
   * de nombrar un blob traído por `get` es fabricar el nombre en el cliente, y eso es lo que dejaba
   * la descarga individual con una convención distinta de la del ZIP.
   *
   * `aceptaNombre` decide qué forma se admite, igual que allí: lo que este módulo garantiza es que
   * el nombre no sea una ruta ni lleve caracteres de control; lo que SIGNIFICA se valida donde se
   * sabe. Si el predicado dice que no, se usa el respaldo.
   */
  getBlobNamed: async (
    path: string,
    respaldo: string,
    aceptaNombre?: (nombre: string) => boolean,
  ): Promise<{ blob: Blob; nombre: string }> => {
    let nombre = respaldo;
    const blob = await request<Blob>('GET', path, undefined, undefined, (res) => {
      const declarado = nombreDeContentDisposition(res.headers.get('content-disposition'));
      nombre = declarado && (!aceptaNombre || aceptaNombre(declarado)) ? declarado : respaldo;
    });
    return { blob, nombre };
  },
  /** POST que devuelve un PDF/blob (p.ej. generación de documentos legales) y lo descarga. */
  downloadPost: async (path: string, filename: string, body?: unknown) => {
    const blob = await request<Blob>('POST', path, body);
    entregarArchivo(blob, filename);
  },
  /**
   * POST que descarga un archivo **con el nombre que decide el SERVIDOR** (HU #11561).
   *
   * Se añade en vez de tocar `downloadPost` porque aquel obliga al llamador a inventarse el nombre
   * y lo consumen ya varias pantallas; su firma no se mueve. Las tres diferencias son:
   *
   *   · el nombre sale de `Content-Disposition` y `respaldo` solo se usa si no viene;
   *   · una respuesta de error con `content-type` de archivo **no se descarga**, se lanza;
   *   · el object URL se libera después de la descarga, no en la misma vuelta síncrona.
   *
   * `aceptaNombre` deja que **el llamador** decida qué forma admite, porque solo él la conoce: aquí
   * no se puede saber si un `.xlsx` de comparendos o un `.pdf` de expediente es lo esperado. Lo que
   * este módulo garantiza es que el nombre no sea una ruta ni lleve caracteres de control
   * (`saneaNombreDeArchivo`); lo que SIGNIFICA el nombre se valida donde se sabe. Si el predicado
   * dice que no, se usa el respaldo: nunca se propaga un nombre que no encaja.
   *
   * Devuelve el nombre con el que se guardó, que es lo que la pantalla necesita para poder decir
   * «Archivo descargado: …» sin volver a adivinarlo.
   *
   * `alLeerCabeceras` (HU #11910) es el único hueco por el que una pantalla puede enterarse de algo
   * que la respuesta declaró FUERA del cuerpo — las cabeceras de conteo del ZIP parcial, que son lo
   * que convierte «ZIP descargado» en «2 de las 5 filas marcadas tenían recibo». Cuál de ellas se lee
   * lo decide quien llama y no este módulo (ver `CABECERAS_ZIP_SOPORTES`). Recibe un LECTOR y
   * no el `Response` entero: con el objeto en la mano cualquier llamador podría intentar volver a
   * leer el cuerpo —que aquí ya se está consumiendo como blob— y quedarse con un stream a medias.
   * Se invoca también en las respuestas de ERROR, igual que el resto de este gancho.
   */
  downloadPostNamed: async (
    path: string,
    respaldo: string,
    body?: unknown,
    aceptaNombre?: (nombre: string) => boolean,
    alLeerCabeceras?: (leer: (cabecera: string) => string | null) => void,
  ): Promise<string> => {
    let nombre = respaldo;
    let respuesta = { ok: true, status: 200 };
    const blob = await request<Blob>('POST', path, body, undefined, (res) => {
      respuesta = { ok: res.ok, status: res.status };
      const declarado = nombreDeContentDisposition(res.headers.get('content-disposition'));
      nombre = declarado && (!aceptaNombre || aceptaNombre(declarado)) ? declarado : respaldo;
      alLeerCabeceras?.((cabecera) => res.headers.get(cabecera));
    });
    if (!respuesta.ok) throw await errorVestidoDeArchivo(respuesta.status, blob);
    entregarArchivo(blob, nombre);
    return nombre;
  },
};

/** Helper para extraer un mensaje útil de cualquier error (incluyendo ApiError y otros). */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.toUserMessage();
  if (err instanceof Error) return err.message;
  return 'Error desconocido';
}
