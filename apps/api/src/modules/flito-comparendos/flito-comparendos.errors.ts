// FLITO comparendos — errores de dominio (Feature #11492 17a, HU #11497).
//
// Existen para que el servicio no tenga que saber de HTTP y la ruta no tenga que adivinar. Cada
// error lleva dos cosas: el `status` con el que sale y un `codigo` estable y en minúsculas.
//
// El `codigo` no es decoración. El mensaje está en español y se escribe para leerlo, así que va a
// cambiar —se afina, se traduce, se le añade contexto— y cualquier pantalla que se ramifique sobre
// él se rompe en silencio el día que alguien le quite una tilde. `nit_duplicado` y `nit_en_uso` los
// nombra el AC de la HU precisamente para que sean el contrato: se comparan, el texto se muestra.
//
// Ampliar este archivo, no reutilizarlo desde fuera: los errores de las HUs siguientes (token,
// clientes, sync) son de este módulo y caben aquí; los de otros dominios, no.

// Único import del archivo y sin peso en runtime (`import type` se borra al compilar): el
// vocabulario de las fuentes se declara junto a los DTOs crudos que lo usan, no duplicado aquí.
import type { ComparendosOrigenFuente } from './clients/types.js';

/** Raíz de los errores del módulo. Lo que NO herede de aquí es un fallo inesperado y sale como 500. */
export class ComparendosError extends Error {
  /** Estado HTTP con el que la ruta responde. */
  readonly status: number;
  /** Identificador estable para que quien consume el API se ramifique sin leer el mensaje. */
  readonly codigo: string;

  constructor(codigo: string, status: number, mensaje: string) {
    super(mensaje);
    // `new.target.name` y no una constante: cada subclase se identifica sola en las trazas.
    this.name = new.target.name;
    this.codigo = codigo;
    this.status = status;
  }
}

/** Códigos de duplicado, uno por catálogo. Enumerados para que no se inventen variantes al vuelo. */
export type CodigoDuplicado = 'nit_duplicado' | 'municipio_duplicado' | 'causal_duplicada';

/** Ya hay una fila con esa llave natural (NIT, código de fuente o nombre de causal). */
export class ComparendosDuplicadoError extends ComparendosError {
  constructor(codigo: CodigoDuplicado, mensaje: string) {
    super(codigo, 409, mensaje);
  }
}

/** La fila que se quería leer, actualizar o borrar no existe. */
export class ComparendosNoEncontradoError extends ComparendosError {
  constructor(mensaje: string) {
    super('no_encontrado', 404, mensaje);
  }
}

/**
 * El NIT ya trajo comparendos, así que no se borra: se desactiva.
 *
 * Borrarlo dejaría en `flito_comparendos_registros` filas cuyo `nit_monitoreado` no corresponde a
 * ningún NIT del catálogo — histórico huérfano que nadie sabría por qué está ahí ni quién lo pidió.
 * El mensaje dice el número de comparendos porque es justo el dato que convence de no insistir.
 */
export class ComparendosNitEnUsoError extends ComparendosError {
  constructor(comparendos: number) {
    super(
      'nit_en_uso',
      409,
      `El NIT ya tiene ${comparendos} comparendo(s) registrados y no se puede eliminar. `
      + 'Desactívalo (activo=false) para que deje de sincronizarse conservando su histórico.',
    );
  }
}

// ─────────────────────────── Token SIMIT (CF-03, HU #11498) ─────────────────────────────────────
//
// Los tres salen como 503 y no como 500 a propósito: el código está bien, lo que falta es
// configuración —la llave del entorno, el token, o una fila que quedó ilegible—. Un 500 le dice a
// quien opera «hay un bug»; un 503 con estos códigos le dice qué provisionar.

/**
 * Falta `COMPARENDOS_ENC_KEY` o no es una llave válida.
 *
 * Es la traducción al dominio de `ComparendosEncKeyError` (crypto): el servicio la captura para que
 * la ruta pueda responder sin importar nada de `shared/utils/crypto.js`, y para que el caso
 * «entorno mal configurado» no se confunda nunca con «el token está corrupto».
 */
export class ComparendosLlaveMaestraError extends ComparendosError {
  constructor(mensaje: string) {
    super('llave_maestra', 503, mensaje);
  }
}

/** No hay token SIMIT que usar: ni fila activa ni bootstrap de entorno. */
export class ComparendosTokenNoConfiguradoError extends ComparendosError {
  constructor() {
    super(
      'token_no_configurado',
      503,
      'No hay token SIMIT configurado. Regístralo en la configuración del módulo de comparendos '
      + '(PUT /api/flito/comparendos/config/token-simit) antes de sincronizar.',
    );
  }
}

/**
 * El ciphertext del token no verifica: la fila está corrupta o fue manipulada.
 *
 * La fila queda desactivada, igual que en `siigo_credenciales`: reintentar un ciphertext que no
 * autentica en cada corrida del sync solo produce ruido, y dejarla activa esconde que hay que
 * volver a registrar el token. El motivo se escribe en la propia fila, no solo en el log.
 */
export class ComparendosTokenDescifradoError extends ComparendosError {
  constructor() {
    super(
      'token_descifrado',
      503,
      'El token SIMIT guardado no pudo descifrarse y quedó desactivado. Regístralo de nuevo desde '
      + 'la configuración del módulo de comparendos.',
    );
  }
}

/**
 * Dos rotaciones del token a la vez: el índice único parcial dejó pasar solo una.
 *
 * Es 409 y no 503 porque no hay nada que provisionar: el token quedó bien guardado, solo que lo
 * guardó la otra petición. Reintentar es la respuesta correcta, y decirlo así evita que un 500
 * mande a alguien a buscar un fallo que no existe.
 */
export class ComparendosTokenRotacionConcurrenteError extends ComparendosError {
  constructor() {
    super(
      'token_rotacion_concurrente',
      409,
      'Otra actualización del token SIMIT se completó al mismo tiempo. Verifica cuál quedó activo y vuelve a intentarlo si hace falta.',
    );
  }
}

// ─────────────────────── Fuentes externas: Verifik y UTS (HU #11499) ────────────────────────────
//
// Los cuatro fallos de transporte que hay que poder distinguir en un `sync_run_step`, y una regla
// que vale para todos: **el mensaje de estos errores se escribe para acabar en un log y en la
// columna `mensaje` del step**, así que no lleva token, ni cabeceras, ni NIT. Ese es el motivo de
// que se construyan aquí y no en cada adapter: si cada cliente redactara su propio texto, la
// promesa «no se filtra la credencial» dependería de que nadie se despistara al añadir el quinto.
//
// Lo que sí llevan es `httpStatus` (el del PROVEEDOR, distinto del `status` con el que responde
// nuestra API) y `fuente`, que son exactamente las dos columnas que el sync necesita escribir.

/** Nombre legible de la fuente para los mensajes. El municipio se identifica por su código UTS. */
function etiquetaFuente(origen: ComparendosOrigenFuente, fuente: string): string {
  return origen === 'simit' ? 'Verifik SIMIT' : `el UTS municipal (fuente ${fuente})`;
}

/**
 * Raíz de los fallos de una fuente externa.
 *
 * Ojo con los dos «status»: `status` (heredado) es con lo que responde ESTA API y `httpStatus` es
 * lo que respondió el proveedor. Se llaman distinto justamente para que no se confundan al
 * escribir el step.
 */
export class ComparendosFuenteError extends ComparendosError {
  readonly origen: ComparendosOrigenFuente;
  /** `'simit'` o el `codigoFuente` del municipio. Va tal cual a `sync_run_steps.fuente`. */
  readonly fuente: string;
  /** Código HTTP del proveedor, o `null` cuando no llegó a haber respuesta (timeout, red, config). */
  readonly httpStatus: number | null;

  constructor(
    codigo: string, status: number,
    origen: ComparendosOrigenFuente, fuente: string, httpStatus: number | null,
    mensaje: string,
  ) {
    super(codigo, status, mensaje);
    this.origen = origen;
    this.fuente = fuente;
    this.httpStatus = httpStatus;
  }
}

/**
 * Falta la base URL del proveedor y el módulo está en modo `real`.
 *
 * 503 y no 500 por lo mismo que la llave maestra: no hay bug que arreglar, hay algo que
 * provisionar. Y falla explícito ANTES de construir nada — sin esto la petición saldría hacia una
 * URL con `undefined` dentro y el error llegaría disfrazado de fallo de red.
 */
export class ComparendosFuenteNoConfiguradaError extends ComparendosFuenteError {
  constructor(origen: ComparendosOrigenFuente, fuente: string, variable: string) {
    super(
      'fuente_no_configurada', 503, origen, fuente, null,
      `No hay base URL para ${etiquetaFuente(origen, fuente)}: define ${variable} en el entorno `
      + 'o deja COMPARENDOS_SIMIT_MODE=mock mientras no haya credenciales.',
    );
  }
}

/**
 * El proveedor no respondió dentro de `COMPARENDOS_HTTP_TIMEOUT_MS`.
 *
 * 504 para que se distinga de un error del proveedor: aquí no sabemos si la consulta salió bien o
 * mal, solo que no llegó a tiempo. Al sync le importa la diferencia — un timeout NO autoriza a
 * inactivar los comparendos de ese NIT (ADR-0001 §5).
 */
export class ComparendosFuenteTimeoutError extends ComparendosFuenteError {
  constructor(origen: ComparendosOrigenFuente, fuente: string, timeoutMs: number) {
    super(
      'fuente_timeout', 504, origen, fuente, null,
      `${etiquetaFuente(origen, fuente)} no respondió en ${timeoutMs} ms.`,
    );
  }
}

/**
 * El proveedor respondió, pero con un código que no es 2xx.
 *
 * El 401/403 se comenta aparte porque es, con diferencia, el fallo más probable de Verifik y el
 * mensaje decide cuánto tarda alguien en arreglarlo. Se nombra el token como algo a REVISAR; el
 * valor no aparece por ningún lado.
 */
export class ComparendosFuenteHttpError extends ComparendosFuenteError {
  constructor(origen: ComparendosOrigenFuente, fuente: string, httpStatus: number) {
    const pista = httpStatus === 401 || httpStatus === 403
      ? ' Revisa el token SIMIT configurado: puede haber expirado o no tener permiso sobre esta consulta.'
      : '';
    super(
      'fuente_http', 502, origen, fuente, httpStatus,
      `${etiquetaFuente(origen, fuente)} respondió HTTP ${httpStatus}.${pista}`,
    );
  }
}

/**
 * No hubo respuesta: DNS, conexión rechazada, TLS, socket cerrado a media.
 *
 * El mensaje lleva el `code` de Node (`ECONNREFUSED`, `ENOTFOUND`…) y NO el mensaje original del
 * error. Es deliberado: el `code` es un enumerado corto y seguro, mientras que un mensaje de
 * librería es texto arbitrario que podría arrastrar la URL, un cuerpo o cualquier cosa que
 * mañana alguien decida meter ahí. Lo que se pierde en detalle se recupera en el `err` estructurado
 * que el adapter registra, que no sale de los logs de la API.
 */
export class ComparendosFuenteRedError extends ComparendosFuenteError {
  constructor(origen: ComparendosOrigenFuente, fuente: string, codigoRed: string) {
    super(
      'fuente_red', 502, origen, fuente, null,
      `No se pudo contactar a ${etiquetaFuente(origen, fuente)} (código de red: ${codigoRed}).`,
    );
  }
}

/**
 * Respondió 2xx pero el cuerpo no trae ninguna lista de comparendos reconocible.
 *
 * Podría devolverse una lista vacía y seguir. **No se hace, y es la decisión más importante de este
 * archivo:** un «cero comparendos» que en realidad es «no entendí la respuesta» le diría al sync
 * que ese NIT ya no debe nada, y la regla de inactivación (ADR-0001 §5) apagaría todo su histórico.
 * Fallar aquí convierte un cambio de contrato del proveedor en un step fallido y visible, que es
 * exactamente lo que el spike #11501 necesita ver.
 *
 * `pista` describe la FORMA del cuerpo (nombres de clave o tamaño), nunca su contenido: los valores
 * son PII de tránsito y el objetivo es diagnosticar el contrato, no leer los datos.
 */
export class ComparendosFuenteRespuestaIlegibleError extends ComparendosFuenteError {
  constructor(origen: ComparendosOrigenFuente, fuente: string, httpStatus: number, pista: string) {
    super(
      'fuente_respuesta_ilegible', 502, origen, fuente, httpStatus,
      `La respuesta de ${etiquetaFuente(origen, fuente)} no contiene una lista de comparendos `
      + `reconocible (${pista}).`,
    );
  }
}

/**
 * Respondió 2xx con ítems, pero (casi) ninguno traía un número de comparendo reconocible.
 *
 * Es la hermana pequeña de `ComparendosFuenteRespuestaIlegibleError` y existe por lo mismo: el
 * cuerpo tenía forma de lista, así que el adapter lo dio por bueno, pero el mapa de homologación no
 * le saca la llave a las filas. Un `source_path` equivocado en `flito_comparendos_field_map` o un
 * campo que el proveedor renombró producen exactamente esto, y **pasan la validación de RN-12**, que
 * solo comprueba que EXISTA algún candidato para `numeroComparendo`, no que acierte. Sin este error
 * el paso quedaría `ok`, el NIT saldría con cobertura completa y el barrido apagaría su histórico
 * entero por una ausencia que solo existe en la homologación.
 *
 * El mensaje lleva CONTEOS y el nombre de la fuente, nunca valores: se persiste en
 * `sync_steps.mensaje` y ahí no entra PII de tránsito (RN-20).
 */
export class ComparendosHomologacionIlegibleError extends ComparendosFuenteError {
  constructor(
    origen: ComparendosOrigenFuente, fuente: string, httpStatus: number | null,
    ignorados: number, leidos: number,
  ) {
    super(
      'homologacion_ilegible', 502, origen, fuente, httpStatus,
      `${ignorados} de ${leidos} ítems de ${etiquetaFuente(origen, fuente)} no traen un número de `
      + 'comparendo reconocible: revisa la versión vigente de flito_comparendos_field_map. No se '
      + 'inactivó nada de este NIT por esta fuente.',
    );
  }
}

// ─────────────────────────── Sincronización (CF-05/CF-06, HU #11500) ────────────────────────────
//
// Precondiciones de la corrida. Todas se comprueban ANTES de llamar a ningún proveedor: gastar
// cuota de Verifik para descubrir después que la corrida no se podía escribir sería tirar dinero y,
// en el caso del modo simulado, escribir datos inventados en producción.

/**
 * Ya hay una corrida en marcha (CF-06).
 *
 * 409 y no 429: no es que se esté pidiendo demasiado, es que este recurso admite exactamente un
 * escritor a la vez. Dos syncs simultáneos sobre las mismas tablas competirían por el mismo
 * `numero_comparendo` y, peor, cada uno vería como «ausentes» los comparendos que el otro todavía no
 * ha escrito: el resultado serían inactivaciones en falso.
 */
export class ComparendosSyncEnCursoError extends ComparendosError {
  constructor() {
    super(
      'sync_en_curso',
      409,
      'Ya hay una sincronización de comparendos en curso. Espera a que termine antes de lanzar otra.',
    );
  }
}

/** No hay ningún NIT activo que sincronizar: el catálogo está vacío o todos están desactivados. */
export class ComparendosSinNitsActivosError extends ComparendosError {
  constructor() {
    super(
      'sin_nits_activos',
      400,
      'No hay NITs activos en el catálogo de monitoreo. Agrega al menos uno (o reactívalo) antes de sincronizar.',
    );
  }
}

/**
 * El filtro `nits` nombra NITs que no están activos en el catálogo.
 *
 * Se listan los valores rechazados —vienen del propio cuerpo de la petición, así que no se le está
 * contando nada nuevo a quien la mandó— porque la alternativa («alguno de los NITs no es válido»)
 * obliga a probar de uno en uno. No van al log: ahí el NIT viaja enmascarado.
 */
export class ComparendosFiltroNitsInvalidoError extends ComparendosError {
  constructor(desconocidos: readonly string[]) {
    super(
      'nits_filtro_invalido',
      400,
      `Estos NITs no están activos en el catálogo de monitoreo: ${desconocidos.join(', ')}.`,
    );
  }
}

/**
 * `COMPARENDOS_SIMIT_MODE=mock` en producción: la corrida se aborta ANTES de escribir nada.
 *
 * Es el hallazgo que dejó abierto el gate de la HU #11499 y no es una comprobación de higiene. En
 * `mock` los adapters devuelven comparendos INVENTADOS —y deterministas, con números `MOCK-…`—; si
 * la variable no se provisiona en PDN, el modo por defecto es precisamente `mock` y el sync
 * escribiría esos datos fabricados en la base productiva creyéndolos reales, marcaría los NITs como
 * cubiertos e **inactivaría el histórico verdadero** por «ausencia». Un dato inventado se puede
 * borrar; un histórico apagado con su timeline reescrito, no.
 *
 * 503 y no 500: el código está bien, lo que falta es provisionar la variable.
 */
export class ComparendosModoSimuladoEnProduccionError extends ComparendosError {
  constructor() {
    super(
      'modo_simulado_en_produccion',
      503,
      'La sincronización está en modo simulado (COMPARENDOS_SIMIT_MODE=mock) y el entorno es de '
      + 'producción: se abortó para no escribir comparendos fabricados. Define '
      + 'COMPARENDOS_SIMIT_MODE=real con las credenciales del proveedor.',
    );
  }
}

/**
 * El alcance pedido no cabe en el tiempo máximo de una corrida (RN-21).
 *
 * La corrida es síncrona y se protege con un lock de TTL derivado del alcance, y ese TTL tiene un
 * techo: es también el tiempo que el módulo quedaría bloqueado si el proceso muriese a mitad. Un
 * alcance que no quepa se rechaza ANTES de empezar en vez de arrancar una corrida que se cortará por
 * deadline a la mitad — habiendo gastado ya cuota del proveedor.
 *
 * 400 y no 503: no hay nada que provisionar, hay que pedir menos NITs por corrida. El mensaje dice
 * cuántos caben con el catálogo de municipios y el timeout actuales, que es el dato accionable.
 */
export class ComparendosScopeDemasiadoGrandeError extends ComparendosError {
  constructor(pedidos: number, maximo: number) {
    super(
      'scope_demasiado_grande',
      400,
      `El alcance pedido (${pedidos} NIT(s)) no cabe en el tiempo máximo de una corrida con los `
      + `municipios activos y el timeout configurados. Sincroniza como máximo ${maximo} NIT(s) por `
      + 'corrida usando el filtro `nits`, o desactiva municipios del catálogo.',
    );
  }
}

/**
 * `flito_comparendos_field_map` no tiene un mapa utilizable (RN-12).
 *
 * Sin homologación no se puede leer el número de comparendo de ningún ítem, así que TODAS las
 * fuentes parecerían devolver listas vacías y la inactivación apagaría el histórico completo. Se
 * falla antes de llamar a nadie.
 */
export class ComparendosMapaHomologacionVacioError extends ComparendosError {
  constructor() {
    super(
      'mapa_homologacion_vacio',
      503,
      'No hay un mapa de homologación utilizable en flito_comparendos_field_map. La migración 0150 '
      + 'siembra la versión 1: restáurala antes de sincronizar.',
    );
  }
}

// ─────────────────────── Lectura del consolidado (CF-09, HU #11502) ─────────────────────────────

/**
 * El `cursor` de `GET /registros` no es uno de los que este módulo emite.
 *
 * 400 y no 404: el cursor no nombra un recurso, describe por dónde iba la lista. Y se responde con
 * un código propio en vez de tratarlo como «sin resultados» porque un cursor corrupto —recortado al
 * copiarlo, o de una versión anterior del formato— devolvería silenciosamente la PRIMERA página, y
 * quien pagina lo leería como que la lista se acabó y volvió a empezar. Mejor decir que el cursor no
 * sirve y que se pida la primera página a propósito.
 *
 * El mensaje no repite el valor recibido: es un dato opaco que no aporta nada al leerlo.
 */
export class ComparendosCursorInvalidoError extends ComparendosError {
  constructor() {
    super(
      'cursor_invalido',
      400,
      'El cursor de paginación no es válido o pertenece a otra versión del listado. '
      + 'Pide la primera página sin `cursor`.',
    );
  }
}

/**
 * `unique_violation` de PostgreSQL.
 *
 * Se comprueba ADEMÁS de consultar antes si la fila existe, no en su lugar. La consulta previa da el
 * mensaje bueno en el caso normal; esto cubre la carrera: entre el SELECT y el INSERT cabe otra
 * petición, y sin esto ese caso —raro, pero real— saldría como 500 en vez de como el 409 que es.
 *
 * **Recorre la cadena de `cause`, y no es defensa preventiva:** desde la 0.44, `drizzle-orm` envuelve
 * toda excepción de query en un `DrizzleQueryError` y deja la original en `cause`
 * (`drizzle-orm/pg-core/session.cjs`, versión instalada 0.45.2). Mirando solo el nivel superior,
 * `code` es `undefined` y la carrera saldría como 500 — exactamente lo que este helper existe para
 * evitar. Los tests con mock no lo detectan porque lanzan el error de PostgreSQL en crudo.
 */
export function esViolacionDeUnicidad(e: unknown): boolean {
  // Tope de profundidad: una cadena de causas cíclica colgaría el proceso, y ningún driver anida
  // más de un par de niveles.
  for (let actual: unknown = e, saltos = 0; actual != null && saltos < 5; saltos++) {
    if (typeof actual !== 'object') break;
    if ((actual as { code?: unknown }).code === '23505') return true;
    actual = (actual as { cause?: unknown }).cause;
  }
  return false;
}
