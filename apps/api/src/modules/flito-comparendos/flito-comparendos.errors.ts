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
