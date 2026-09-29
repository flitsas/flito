// Errores de dominio del acceso de FLITO a FLIT 2 (Feature #13057, HU #13061).
//
// Cada uno lleva su estado HTTP y un `codigo` estable; la ruta solo los traduce. Ningún mensaje de
// este archivo incluye —ni recortada— la contraseña del usuario de servicio: nada de lo que se
// lanza desde aquí puede acabar en un log o en una respuesta con material de la credencial dentro.
// Los errores del pase (rechazado, bloqueado, no responde…) llegan con la HU #13063.

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

/** Código `23505` de Postgres en el error o en su cadena de causas (Drizzle lo envuelve). */
export function esViolacionDeUnicidad(e: unknown): boolean {
  for (let actual: unknown = e, saltos = 0; actual != null && saltos < 5; saltos++) {
    if (typeof actual !== 'object') break;
    if ((actual as { code?: unknown }).code === '23505') return true;
    actual = (actual as { cause?: unknown }).cause;
  }
  return false;
}
