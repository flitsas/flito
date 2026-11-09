// HU #14347 (Feature #14326, ADR-0039 §6.2, R14) — quién puede llevar un despacho. Una sola regla para listar y para
// exigir, en servidor: `POST /traslados`, `/traslados/:id/despachar`, `/actas/:id/despachar` y `mensajerosAsignables`.
//
// Mensajero = usuario activo que tiene `logistica.actas.entregar` y no tiene `operar_ajenas`, leído de sus funciones
// efectivas. Es de FLITO si su rol tiene enlace `ninguno`; es del proveedor P si tiene enlace `proveedor` y su
// `flito_proveedor_id` es P.
//   · Alcance de proveedor: solo los suyos.
//   · Operaciones: los de FLITO y los del proveedor dueño del acta (R13).
//   · Otro enlace, o sin resolver: ninguno. Falla cerrado. D7 (David Chica, 2026-11-06): `/actas/:id/despachar` rechaza a la compañía.
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { MensajeroDeActa } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoProveedores, permisosRoles, users } from '../../db/schema.js';
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
  if (alcance.enlace !== 'ninguno') return false;
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

/**
 * A quién se puede despachar un acta (R1, HU #14351, AC8 y AC9). Al proveedor, solo `id` y `nombre`. A Operaciones, los de
 * FLITO y los del proveedor dueño de ESA acta, con `grupo` y, en los del proveedor, `proveedorNombre`.
 */
export async function mensajerosParaActa(alcance: AlcanceResuelto, proveedorDelActa: string | null): Promise<MensajeroDeActa[]> {
  const lista = await mensajerosAsignables(alcance, proveedorDelActa);
  if (alcance.enlace !== 'ninguno') return lista.map(({ id, nombre }) => ({ id, nombre }));
  const conNombre = proveedorDelActa !== null && lista.some((m) => m.proveedorId !== null);
  const [p] = conNombre
    ? await db.select({ nombre: flitoProveedores.nombre }).from(flitoProveedores).where(eq(flitoProveedores.id, proveedorDelActa)).limit(1)
    : [];
  return lista.map(({ id, nombre, proveedorId }) => (proveedorId === null
    ? { id, nombre, grupo: 'flito' as const }
    : { id, nombre, grupo: 'proveedor' as const, ...(p ? { proveedorNombre: p.nombre } : {}) }));
}

/** Lanza `MENSAJERO_NO_ASIGNABLE` (422), con la misma respuesta para un mensajero inexistente, inactivo o ajeno. */
export async function exigirMensajeroAsignable(exec: DbOrTx, mensajeroId: number, alcance: AlcanceResuelto, proveedorDelActa: string | null): Promise<void> {
  const [m] = await candidatos(exec, mensajeroId);
  if (!m || !esAsignable(m, alcance, proveedorDelActa)) throw new MensajeroNoAsignableError();
}
