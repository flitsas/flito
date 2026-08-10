// Siigo — quién puede cada acción de facturación electrónica (HU #11342, movido en la #11337).
//
// **Vive en tipos compartidos, y no en el backend, porque tiene DOS consumidores.** El servidor lo
// usa para decidir el 403; la pantalla, para decidir si pinta el botón. Mientras estuvo solo en
// `apps/api`, la interfaz tenía que reimplementar la regla —`role === 'admin' || 'financiera'`— y
// eran dos definiciones de lo mismo que coincidían por costumbre. El día que una cambiara, la
// pantalla ofrecería un botón que el servidor rechaza, o escondería uno que sí se puede pulsar.
// Ninguno de los dos fallos se ve en los tests de la otra mitad.
//
// Lo que NO se mueve: la guarda HTTP, el registro del intento denegado y el texto del 403. Eso es
// del servidor y solo del servidor. Aquí está la TABLA, que es lo que ambos necesitan leer igual.
//
// Sigue siendo el único sitio donde se decide quién emite, reintenta, corrige o anula. Las rutas no
// deciden: piden `exigirAccionSiigo('<accion>')`. La pantalla tampoco: pregunta `puedeEjecutar`.

import type { UserRole } from './permissions.js';

/**
 * Catálogo de acciones. Están TODAS declaradas, incluidas aquellas cuyo flujo lo implementa otra
 * Feature: `emitir`, `corregir` y `anular` no tienen ruta todavía y aun así figuran aquí con su rol.
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

/**
 * Lectura para auditoría también. Ver la bandeja, la línea de tiempo o el estado de una factura es
 * justamente lo que hace un revisor fiscal; negárselo no protege nada y le obliga a pedir capturas.
 */
const LECTURA: readonly UserRole[] = ['admin', 'financiera', 'auditor'];

/**
 * Escritura sin auditoría. `auditor` mira y no toca: es la misma línea que ya trazan
 * `flito-liquidacion.routes.ts` y `finanzas.routes.ts`.
 */
const OPERACION: readonly UserRole[] = ['admin', 'financiera'];

/**
 * LA TABLA. Una fila por acción; cambiar quién puede algo es cambiar su fila.
 *
 * `Record<AccionSiigo, …>` y no un objeto suelto a propósito: si mañana se agrega una acción a
 * `ACCIONES_SIIGO` y se olvida asignarle roles, el compilador lo para.
 */
export const ROLES_POR_ACCION: Record<AccionSiigo, readonly UserRole[]> = {
  consultar: LECTURA,
  emitir: OPERACION,
  reintentar: OPERACION,
  reenviar_correo: OPERACION,
  marcar_fallido: OPERACION,
  reactivar: OPERACION,
  corregir: OPERACION,
  anular: OPERACION,
};

/** Única acción de lectura. El resto modifica algo y por eso se le niega a `auditor`. */
export const ACCION_DE_LECTURA: AccionSiigo = 'consultar';

export function esAccionSiigo(valor: string): valor is AccionSiigo {
  return (ACCIONES_SIIGO as readonly string[]).includes(valor);
}

/**
 * Roles que pueden una acción. Una acción NO declarada devuelve lista vacía, es decir, se niega a
 * todo el mundo. Negar por defecto y no permitir por defecto es lo que hace que declarar de más
 * (acciones sin ruta) sea seguro y declarar de menos (una ruta con un nombre mal escrito) sea un
 * 403 evidente en vez de una puerta abierta.
 */
export function rolesDe(accion: string): readonly UserRole[] {
  return esAccionSiigo(accion) ? ROLES_POR_ACCION[accion] : [];
}

/** ¿Este rol puede esta acción? Sin rol (petición sin autenticar) nunca puede nada. */
export function puedeEjecutar(role: string | null | undefined, accion: string): boolean {
  if (!role) return false;
  return (rolesDe(accion) as readonly string[]).includes(role);
}

/** Acción que modifica algo. `consultar` no lo es; una acción desconocida tampoco (no existe). */
export function esAccionDeOperacion(accion: string): boolean {
  return esAccionSiigo(accion) && accion !== ACCION_DE_LECTURA;
}
