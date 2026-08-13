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

/**
 * `unique_violation` de PostgreSQL.
 *
 * Se comprueba ADEMÁS de consultar antes si la fila existe, no en su lugar. La consulta previa da el
 * mensaje bueno en el caso normal; esto cubre la carrera: entre el SELECT y el INSERT cabe otra
 * petición, y sin esto ese caso —raro, pero real— saldría como 500 en vez de como el 409 que es.
 */
export function esViolacionDeUnicidad(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '23505';
}
