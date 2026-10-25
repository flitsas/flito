// HU #13947 (Feature #13939, Épica #13671) — Rechazar SOAT, impuestos, liquidaciones y facturas de un cliente inactivo.
// Módulo LEGACY `clients`. Este archivo NO importa nada de otros módulos (solo `db` y el esquema): lo importan los
// módulos de altas (`flito-excepciones`, `flito-soat`, `flito-liquidacion`, `siigo`) y así no se abre ningún ciclo
// (`clients.service.ts` sí importa `flito-sync`, por eso el helper no vive allí).
//
//   · RN-CLI-5 — Un cliente inactivo no admite procesos NUEVOS: el alta lee la fila del cliente con `FOR SHARE`
//       DENTRO de su transacción y, si está inactivo, lanza `ClienteNoOperableError` (409). El ciclo de vida de lo que
//       ya existe (pagar, cerrar un SOAT en curso, …) NO pasa por aquí (AC7).
//   · RN-CLI-6 — Concurrencia (AC8): `FOR SHARE` choca con el `UPDATE clients SET active = …` de `cambiarEstadoCliente`
//       (que toma FOR UPDATE implícito sobre la fila). Si el alta llega primero, la desactivación espera a su commit y el
//       proceso cuenta como abierto; si la desactivación llega primero, el alta espera a su commit y lee `active = false`.
//       No hay una ventana en la que se cree un proceso de un cliente ya desactivado.
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { clients } from '../../db/schema.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** La transacción del alta (o la conexión, para lecturas fuera de una). */
export type EjecutorCliente = typeof db | Tx;

/** Lo que el alta intenta crear: completa el mensaje del AC («… no se pueden crear {proceso} para él.»). */
export type ProcesoCliente = 'SOAT' | 'impuestos' | 'liquidaciones' | 'facturas';

/** 409: el cliente está inactivo y no admite procesos nuevos (RN-CLI-5). `message` es el texto del AC. */
export class ClienteNoOperableError extends Error {
  readonly status = 409;
  constructor(readonly companiaId: number, message: string) {
    super(message);
    this.name = 'ClienteNoOperableError';
  }
}

export const mensajeClienteInactivo = (nombre: string, proceso: ProcesoCliente): string =>
  `El cliente ${nombre} está inactivo: no se pueden crear ${proceso} para él.`;

/**
 * Por qué el cliente no admite procesos nuevos, o `null` si sí los admite. Sin compañía o con una que no existe →
 * `null`: esta regla no decide sobre trámites que aún no cruzaron con un cliente.
 *
 * `bloquear = true` toma `FOR SHARE` sobre la fila (RN-CLI-6): solo tiene sentido dentro de la transacción del alta.
 */
export async function motivoClienteNoOperable(
  tx: EjecutorCliente, companiaId: number | null | undefined, proceso: ProcesoCliente, bloquear = true,
): Promise<string | null> {
  if (companiaId == null) return null;
  const consulta = tx.select({ name: clients.name, active: clients.active }).from(clients)
    .where(eq(clients.id, companiaId)).limit(1);
  const [cliente] = bloquear ? await consulta.for('share') : await consulta;
  if (!cliente) return null;
  // HU #13952: deleted_at → «El cliente fue eliminado: no admite nuevos procesos.» (único punto de extensión: leer
  // `deletedAt` en el select de arriba y devolver ese mensaje ANTES de mirar `active`).
  // `=== false` y no `!active`: la columna es NOT NULL, así que solo cambia algo frente a dobles de prueba que
  // devuelven una fila sin esa clave (no deben leerse como «inactivo»).
  if (cliente.active === false) return mensajeClienteInactivo(cliente.name, proceso);
  return null;
}

/** RN-CLI-5: lanza `ClienteNoOperableError` (409) si el cliente no admite procesos nuevos. Llamar DENTRO de la tx. */
export async function exigirClienteOperable(
  tx: EjecutorCliente, companiaId: number | null | undefined, proceso: ProcesoCliente,
): Promise<void> {
  const motivo = await motivoClienteNoOperable(tx, companiaId, proceso);
  if (motivo !== null) throw new ClienteNoOperableError(companiaId!, motivo);
}
