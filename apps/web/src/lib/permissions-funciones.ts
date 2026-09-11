// HU #12170 — Helper puro de funciones efectivas (sin deps de shared-types / nav).
// `permissions.ts` lo reexporta; AuthProvider carga `/permisos/mios` y las pantallas preguntan aquí.

/**
 * Conjunto de funciones que pintan botones. `null` = `/mios` aún no llegó: fail-closed (AC1).
 * Un array vacío es «llegó y no tiene ninguna» (CF-21), distinto de «todavía no sabemos».
 */
export type FuncionesEfectivas = ReadonlySet<string> | null;

/** Convierte la lista de `/mios` en Set. `null`/`undefined` → no listo (fail-closed). */
export function effectiveFunctions(funciones: readonly string[] | null | undefined): FuncionesEfectivas {
  if (funciones == null) return null;
  return new Set(funciones);
}

/**
 * ¿Puede esta operación? Única pregunta de botones (AC1/AC3). Mientras el conjunto no ha llegado,
 * siempre `false` — ningún control se pinta permitido (AC1).
 */
export function hasFuncion(
  funciones: readonly string[] | null | undefined,
  codigo: string,
): boolean {
  if (funciones == null) return false;
  return funciones.includes(codigo);
}

/**
 * Motivo visible cuando un control no se puede pulsar (AC4 / RN-A9).
 * Distingue «sin el módulo» de «el módulo sí, esa función no».
 */
export function motivoSinFuncion(opts: {
  tieneModulo: boolean;
  nombreFuncion?: string;
}): string {
  if (!opts.tieneModulo) {
    return 'No tiene acceso a este módulo.';
  }
  return opts.nombreFuncion
    ? `Su rol no tiene la función «${opts.nombreFuncion}».`
    : 'Su rol no tiene esa función.';
}

/** Copy de pantalla vacía cuando el usuario no tiene ninguna función del módulo (CF-21 / AC4). */
export const COPY_SIN_FUNCIONES_PANTALLA =
  'Su usuario no tiene ninguna función habilitada en esta pantalla. Si cree que debería operar aquí, pida a un administrador que revise el cuadro de su rol.';
