// Siigo — el catálogo de acciones de facturación electrónica (HU #11342, movido en la #11337).
//
// Vive en tipos compartidos porque lo leen el servidor y la pantalla. Desde la HU #13423 (Épica
// #13411, ADR-0023) aquí NO se decide quién puede qué: cada acción es la función del motor
// `siigo.factura.<accion>` (servidor: `exigirAccionSiigo`; pantalla: `hasFuncion`). La tabla de roles
// por acción que vivía aquí desapareció: su reparto lo sembró la migración 0230.

/**
 * Catálogo de acciones. Están TODAS declaradas, incluidas aquellas cuyo flujo lo implementa otra
 * Feature: `emitir`, `corregir` y `anular` no tienen ruta todavía y aun así tienen su función sembrada.
 */
export const ACCIONES_SIIGO = [
  // Lectura: bandeja, línea de tiempo y estado de una factura.
  'consultar',
  // Operación: mueven una factura o su relación con la DIAN.
  'emitir',
  'reintentar',
  'reenviar_correo',
  'marcar_fallido',
  'reactivar',
  'corregir',
  'anular',
] as const;

export type AccionSiigo = (typeof ACCIONES_SIIGO)[number];

/** Única acción de lectura. El resto modifica algo (la 0230 no las sembró a `auditor`). */
export const ACCION_DE_LECTURA: AccionSiigo = 'consultar';

export function esAccionSiigo(valor: string): valor is AccionSiigo {
  return (ACCIONES_SIIGO as readonly string[]).includes(valor);
}

/** Acción que modifica algo. `consultar` no lo es; una acción desconocida tampoco (no existe). */
export function esAccionDeOperacion(accion: string): boolean {
  return esAccionSiigo(accion) && accion !== ACCION_DE_LECTURA;
}
