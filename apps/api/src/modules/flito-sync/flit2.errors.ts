// Errores de dominio del acceso de FLITO a FLIT 2 (Feature #13057, HU #13061).
//
// Cada uno lleva su estado HTTP y un `codigo` estable; la ruta solo los traduce. Ningún mensaje de
// este archivo incluye —ni recortada— la contraseña del usuario de servicio: nada de lo que se
// lanza desde aquí puede acabar en un log o en una respuesta con material de la credencial dentro.
// Los errores del pase (rechazado, bloqueado, no responde…) son de la HU #13063: los lanzan
// `obtenerPase`/`conPase` a los procesos automáticos; «Probar conexión» los traduce a un 200.

export class Flit2Error extends Error {
  /** Estado HTTP con el que la ruta responde. */
  readonly status: number;
  /** Identificador estable para que quien consume el API se ramifique sin leer el mensaje. */
  readonly codigo: string;

  constructor(codigo: string, status: number, mensaje: string) {
    super(mensaje);
    this.name = new.target.name;
    this.codigo = codigo;
    this.status = status;
  }
}

/** Falta `FLIT2_ENC_KEY` o es inválida. La fila guardada está sana: lo que está mal es el entorno. */
export class Flit2LlaveMaestraError extends Flit2Error {
  constructor(mensaje: string) {
    super('llave_maestra', 503, mensaje);
  }
}

/** Dos reemplazos a la vez: el segundo choca contra el índice único parcial de la fila activa. */
export class Flit2AccesoRotacionConcurrenteError extends Flit2Error {
  constructor() {
    super(
      'acceso_rotacion_concurrente',
      409,
      'Otra actualización del acceso a FLIT 2 se completó al mismo tiempo. Verifica cuál quedó vigente y vuelve a intentarlo si hace falta.',
    );
  }
}

/** No hay acceso vigente que usar. */
export class Flit2SinAccesoError extends Flit2Error {
  constructor() {
    super('sin_acceso', 503, 'No hay acceso a FLIT 2 configurado. Regístralo en la configuración de la sincronización.');
  }
}

/** La contraseña guardada no autentica (corrupta o manipulada): la fila queda desactivada (RN-10). */
export class Flit2AccesoDescifradoError extends Flit2Error {
  constructor() {
    super(
      'acceso_descifrado',
      503,
      'El acceso a FLIT 2 guardado no pudo leerse y se desactivó. Vuelve a registrar el usuario de servicio y la contraseña.',
    );
  }
}

/** Motivo con el que FLIT 2 rechazó el acceso (marca durable en la fila vigente). */
export type Flit2MotivoRechazo = 'invalid_client' | 'secret_rotation_required';
/** Motivo de la pausa: 423 `client_locked` (15 min) o 429 `rate_limited` (`Retry-After`). */
export type Flit2MotivoBloqueo = 'client_locked' | 'rate_limited';

/** Sin `FLIT2_BASE_URL`: no se llama a FLIT 2. */
export class Flit2NoConfiguradoError extends Flit2Error {
  constructor() {
    super('no_configurado', 503, 'FLIT 2 no está configurado en este ambiente.');
  }
}

/** FLIT 2 rechazó el acceso vigente. Mientras la fila siga marcada, no se vuelve a llamar. */
export class Flit2RechazadoError extends Flit2Error {
  readonly motivo: Flit2MotivoRechazo;
  constructor(motivo: Flit2MotivoRechazo) {
    super(
      'rechazado',
      503,
      motivo === 'secret_rotation_required'
        ? 'FLIT 2 exige cambiar la contraseña de este acceso.'
        : 'Usuario o contraseña rechazados por FLIT 2.',
    );
    this.motivo = motivo;
  }
}

/** Pausa vigente (423 o 429): no se llama a FLIT 2 hasta `hasta`. */
export class Flit2BloqueadoError extends Flit2Error {
  readonly motivo: Flit2MotivoBloqueo;
  readonly hasta: Date;
  constructor(motivo: Flit2MotivoBloqueo, hasta: Date) {
    super(
      motivo === 'rate_limited' ? 'espera' : 'bloqueado',
      503,
      motivo === 'rate_limited'
        ? 'FLIT 2 pidió esperar antes de volver a pedir acceso.'
        : 'FLIT 2 bloqueó temporalmente el acceso.',
    );
    this.motivo = motivo;
    this.hasta = hasta;
  }
}

/** Timeout, red caída o 5xx. Sin marca: el siguiente intento vuelve a llamar. */
export class Flit2NoRespondeError extends Flit2Error {
  constructor() {
    super('no_responde', 503, 'FLIT 2 no responde.');
  }
}

/** Código `23505` de Postgres en el error o en su cadena de causas (Drizzle lo envuelve). */
export function esViolacionDeUnicidad(e: unknown): boolean {
  for (let actual: unknown = e, saltos = 0; actual != null && saltos < 5; saltos++) {
    if (typeof actual !== 'object') break;
    if ((actual as { code?: unknown }).code === '23505') return true;
    actual = (actual as { cause?: unknown }).cause;
  }
  return false;
}
