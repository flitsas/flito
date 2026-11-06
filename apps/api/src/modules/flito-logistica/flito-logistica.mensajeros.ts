// HU #14347 (Feature #14326, ADR-0039 §6.2, R14) — quién puede llevar un despacho. Una sola regla para listar y para
// exigir, en servidor: `POST /traslados`, `/traslados/:id/despachar`, `/actas/:id/despachar` y `mensajerosAsignables`.
//
// Mensajero = usuario activo que tiene `logistica.actas.entregar` y no tiene `operar_ajenas`, leído de sus funciones
// efectivas. Es de FLITO si su rol tiene enlace `ninguno`; es del proveedor P si tiene enlace `proveedor` y su
// `flito_proveedor_id` es P.
//   · Alcance de proveedor: solo los suyos.
//   · Operaciones: los de FLITO y los del proveedor dueño del acta (R13).
//   · Compañía: `/actas/:id/despachar` sigue abierta a su enlace, y la regla es la de Operaciones. `facetas` no le lista ninguno.
//   · Otro enlace, o sin resolver: ninguno. Falla cerrado.
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { permisosRoles, users } from '../../db/schema.js';
import type { AlcanceResuelto } from '../../shared/middleware/frontera-enlace.js';
import { usuariosConFuncion } from '../../shared/permisos-efectivos.js';
import { LogisticaError, type DbOrTx } from './flito-logistica.base.js';

const FUNCION_ENTREGAR = 'logistica.actas.entregar';
export const FUNCION_OPERAR_AJENAS = 'logistica.actas.operar_ajenas';

export class MensajeroNoAsignableError extends LogisticaError {
  constructor() { super('El mensajero seleccionado no se puede asignar a este despacho', 422, undefined, 'MENSAJERO_NO_ASIGNABLE'); }
}

interface FilaMensajero { id: number; nombre: string; tipoEnlace: string; proveedorId: string | null }

/**
 * La regla. `proveedorDelActa`: `undefined` = sin acta a la vista (el listado de facetas, que trae a los de todos los
 * proveedores con su `proveedorId` para que la pantalla filtre por el dueño de cada acta); `null` = acta sin dueño.
 */
function esAsignable(m: FilaMensajero, alcance: AlcanceResuelto, proveedorDelActa: string | null | undefined): boolean {
  const delProveedor = m.tipoEnlace === 'proveedor' && m.proveedorId !== null;
  if (alcance.enlace === 'proveedor') return alcance.proveedorId !== null && delProveedor && m.proveedorId === alcance.proveedorId;
  if (alcance.enlace !== 'ninguno' && alcance.enlace !== 'compania') return false;
  if (m.tipoEnlace === 'ninguno') return true;
  return delProveedor && (proveedorDelActa === undefined || m.proveedorId === proveedorDelActa);
}

async function candidatos(exec: DbOrTx, soloId?: number): Promise<FilaMensajero[]> {
  const ids = await usuariosConFuncion(FUNCION_ENTREGAR, { sin: FUNCION_OPERAR_AJENAS });
  const elegidos = soloId === undefined ? ids : ids.filter((id) => id === soloId);
  if (elegidos.length === 0) return [];
  return exec.select({ id: users.id, nombre: users.name, tipoEnlace: permisosRoles.tipoEnlace, proveedorId: users.flitoProveedorId })
    .from(users).innerJoin(permisosRoles, eq(permisosRoles.codigo, users.role))
    .where(and(inArray(users.id, elegidos), eq(users.active, true), isNull(users.deletedAt)));
}

export interface MensajeroAsignable { id: number; nombre: string; proveedorId: string | null }

/** Los mensajeros que este alcance puede elegir. Con `proveedorDelActa`, los de esa acta; sin él, ver `esAsignable`. */
export async function mensajerosAsignables(alcance: AlcanceResuelto, proveedorDelActa?: string | null): Promise<MensajeroAsignable[]> {
  return (await candidatos(db)).filter((m) => esAsignable(m, alcance, proveedorDelActa))
    .map(({ id, nombre, proveedorId }) => ({ id, nombre, proveedorId: proveedorId ?? null }));
}

/** Lanza `MENSAJERO_NO_ASIGNABLE` (422), con la misma respuesta para un mensajero inexistente, inactivo o ajeno. */
export async function exigirMensajeroAsignable(exec: DbOrTx, mensajeroId: number, alcance: AlcanceResuelto, proveedorDelActa: string | null): Promise<void> {
  const [m] = await candidatos(exec, mensajeroId);
  if (!m || !esAsignable(m, alcance, proveedorDelActa)) throw new MensajeroNoAsignableError();
}
