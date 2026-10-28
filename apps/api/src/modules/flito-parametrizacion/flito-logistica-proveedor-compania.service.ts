// HU #14104 (Feature #14089, Épica #13758) — Proveedor de logística POR COMPAÑÍA (`clients.flito_proveedor_logistica_id`, 0274).
// Contrato en ADR-0030 §6. Módulo FLITO `flito-parametrizacion` (lo usa el PATCH de compañías y la baja de proveedores).
//
// Reglas:
//   · RN-PLOGC-1 — logística ENCENDIDA (`logistica_autogestionable = false`) EXIGE proveedor → 422
//       (`ProveedorLogisticaRequeridoError`). APAGADA (autogestionable): se guarda y la compañía NUNCA tiene viajes;
//       el proveedor que tuviera se conserva (no se borra en silencio).
//   · RN-PLOGC-2 — el proveedor elegido debe existir y estar ACTIVO (`FOR SHARE` dentro de la transacción del UPDATE,
//       gemelo de `exigirProveedorSoatUsable`) → 422 (`ProveedorLogisticaNoUsableError`).
//   · RN-PLOGC-3 — no se inactiva un proveedor asignado a compañías VIGENTES → 409 (`ProveedorLogisticaAsignadoError`),
//       con los nombres de las compañías (nombre empresarial, sin datos de contacto).
//   · RN-PLOGC-4 — `proveedorDeCompania` es el resolvedor único que consumirá el Feature de viajes a cliente.
//   · Las compañías con la logística encendida al migrar quedan SIN proveedor (no hay proveedor por defecto).
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { clients, flitoProveedoresLogistica } from '../../db/schema.js';
import { clienteVigente } from '../clients/cliente-operable.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** La conexión o una transacción abierta. */
export type EjecutorLogistica = typeof db | Tx;

export const MENSAJE_PROVEEDOR_LOGISTICA_REQUERIDO = 'Una compañía con la logística encendida necesita un proveedor de logística.';

export class ProveedorLogisticaRequeridoError extends Error {
  constructor() { super(MENSAJE_PROVEEDOR_LOGISTICA_REQUERIDO); this.name = 'ProveedorLogisticaRequeridoError'; }
}
/** El proveedor elegido no existe o está inactivo. */
export class ProveedorLogisticaNoUsableError extends Error {
  constructor(message: string, readonly motivo: 'inactivo' | 'no_existe') { super(message); this.name = 'ProveedorLogisticaNoUsableError'; }
}
/** 409: el proveedor está asignado a compañías y no se puede inactivar. */
export class ProveedorLogisticaAsignadoError extends Error {
  constructor(readonly companias: string[]) {
    super(`No se puede inactivar: está asignado a ${companias.length} ${companias.length === 1 ? 'compañía' : 'compañías'} (${companias.join(', ')}). Asigna otro proveedor primero.`);
    this.name = 'ProveedorLogisticaAsignadoError';
  }
}

/**
 * RESOLVEDOR ÚNICO (ADR-0030 §6): el id del proveedor de logística de la compañía, o `null` si no tiene.
 * Solo lee `clients.flito_proveedor_logistica_id`; NO mira `logistica_autogestionable` (quien registre viajes ya
 * descarta las autogestionables antes de llamarlo) ni `estrategia` (siempre mensajería propia).
 */
export async function proveedorDeCompania(exec: EjecutorLogistica, companiaId: number): Promise<string | null> {
  const [fila] = await exec.select({ proveedorId: clients.flitoProveedorLogisticaId }).from(clients)
    .where(eq(clients.id, companiaId)).limit(1);
  return fila?.proveedorId ?? null;
}

/** RN-PLOGC-1: el estado RESULTANTE (previo + cambios) no puede quedar encendido sin proveedor. */
export function exigirProveedorSiEncendida(logisticaAutogestionable: boolean, proveedorId: string | null): void {
  if (!logisticaAutogestionable && proveedorId == null) throw new ProveedorLogisticaRequeridoError();
}

/** RN-PLOGC-2. Con la transacción que escribe: el `FOR SHARE` dura hasta su commit. */
export async function exigirProveedorLogisticaUsable(tx: Tx, id: string): Promise<void> {
  const [p] = await tx.select({ nombre: flitoProveedoresLogistica.nombre, activo: flitoProveedoresLogistica.activo })
    .from(flitoProveedoresLogistica).where(eq(flitoProveedoresLogistica.id, id)).for('share').limit(1);
  if (!p) throw new ProveedorLogisticaNoUsableError('El proveedor de logística seleccionado no existe.', 'no_existe');
  if (!p.activo) throw new ProveedorLogisticaNoUsableError(`El proveedor de logística ${p.nombre} está inactivo: elige otro.`, 'inactivo');
}

/** RN-PLOGC-3. Nombres de las compañías VIGENTES que tienen a este proveedor asignado (vacío = se puede inactivar). */
export async function companiasConProveedorLogistica(exec: EjecutorLogistica, proveedorId: string): Promise<string[]> {
  const filas = await exec.select({ name: clients.name }).from(clients)
    .where(and(eq(clients.flitoProveedorLogisticaId, proveedorId), clienteVigente())).orderBy(asc(clients.name));
  return filas.map((f) => f.name);
}
