// HU #14103 (Feature #14089, Épica #13758) — Alta y edición de proveedores de LOGÍSTICA.
// Módulo FLITO `flito-parametrizacion`, montado en `/api/flito/parametrizacion/proveedores-logistica`.
// Tabla `flito_proveedores_logistica`, SEPARADA de `flito_proveedores_soat` (los SOAT no se tocan ni ganan estos campos).
//
// Reglas:
//   · RN-PLOG-1 — nombre y NIT obligatorios (422 con el campo); contacto y teléfono opcionales.
//   · RN-PLOG-2 — el NIT se guarda normalizado (sin puntos ni espacios, dígito de verificación opcional tras «-») y es
//       ÚNICO (índice parcial 0277); duplicado → NitProveedorDuplicadoError (409), también ante la carrera (23505).
//   · RN-PLOG-3 — el nombre ya era único en la tabla: duplicado → NombreProveedorLogisticaDuplicadoError (409).
//   · HU #14104 (RN-PLOGC-3) — inactivar un proveedor asignado a compañías vigentes → ProveedorLogisticaAsignadoError (409).
import { and, asc, eq, ne } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { flitoProveedoresLogistica } from '../../db/schema.js';
import { ProveedorLogisticaAsignadoError, companiasConProveedorLogistica } from './flito-logistica-proveedor-compania.service.js';

export const INDICE_PROVEEDOR_LOGISTICA_NIT = 'uq_flito_proveedores_logistica_nit';

export class ProveedorLogisticaNoEncontradoError extends Error {
  constructor() { super('Proveedor de logística no encontrado'); this.name = 'ProveedorLogisticaNoEncontradoError'; }
}
export class NitProveedorDuplicadoError extends Error {
  constructor(nit: string) { super(`Ya existe un proveedor de logística con el NIT ${nit}.`); this.name = 'NitProveedorDuplicadoError'; }
}
export class NombreProveedorLogisticaDuplicadoError extends Error {
  constructor(nombre: string) { super(`Ya existe un proveedor de logística con el nombre ${nombre}.`); this.name = 'NombreProveedorLogisticaDuplicadoError'; }
}

/** «900.123.456 - 7» → «900123456-7». */
export function normalizarNit(nit: string): string {
  return nit.replace(/[.\s]/g, '').replace(/–|—/g, '-');
}
export const NIT_VALIDO = /^\d{5,15}(-\d)?$/;

export interface DatosProveedorLogistica {
  nombre: string; nit: string; contacto?: string | null; telefono?: string | null;
}
export type FilaProveedorLogistica = typeof flitoProveedoresLogistica.$inferSelect;

export function proveedorLogisticaDto(p: FilaProveedorLogistica) {
  return { id: p.id, nombre: p.nombre, nit: p.nit, contacto: p.contacto, telefono: p.telefono, activo: p.activo };
}

function esDuplicadoPg(e: unknown, constraint: string): boolean {
  for (let x: unknown = e, i = 0; x && typeof x === 'object' && i < 3; x = (x as { cause?: unknown }).cause, i++) {
    const pg = x as { code?: unknown; constraint_name?: unknown; constraint?: unknown };
    if (pg.code === '23505' && (pg.constraint_name ?? pg.constraint) === constraint) return true;
  }
  return false;
}

async function validarUnicos(nombre: string | undefined, nit: string | undefined, excluirId?: string): Promise<void> {
  const otro = excluirId !== undefined ? [ne(flitoProveedoresLogistica.id, excluirId)] : [];
  if (nit !== undefined) {
    const [f] = await db.select({ id: flitoProveedoresLogistica.id }).from(flitoProveedoresLogistica)
      .where(and(eq(flitoProveedoresLogistica.nit, nit), ...otro)).limit(1);
    if (f !== undefined) throw new NitProveedorDuplicadoError(nit);
  }
  if (nombre !== undefined) {
    const [f] = await db.select({ id: flitoProveedoresLogistica.id }).from(flitoProveedoresLogistica)
      .where(and(eq(flitoProveedoresLogistica.nombre, nombre), ...otro)).limit(1);
    if (f !== undefined) throw new NombreProveedorLogisticaDuplicadoError(nombre);
  }
}

async function escribir<T>(fn: () => Promise<T>, nombre?: string, nit?: string): Promise<T> {
  try { return await fn(); } catch (e) {
    if (nit !== undefined && esDuplicadoPg(e, INDICE_PROVEEDOR_LOGISTICA_NIT)) throw new NitProveedorDuplicadoError(nit);
    if (nombre !== undefined && esDuplicadoPg(e, 'flito_proveedores_logistica_nombre_unique')) throw new NombreProveedorLogisticaDuplicadoError(nombre);
    throw e;
  }
}

export async function listarProveedoresLogistica(): Promise<FilaProveedorLogistica[]> {
  return db.select().from(flitoProveedoresLogistica).orderBy(asc(flitoProveedoresLogistica.nombre));
}

export async function crearProveedorLogistica(d: DatosProveedorLogistica): Promise<FilaProveedorLogistica> {
  await validarUnicos(d.nombre, d.nit);
  const [creado] = await escribir(() => db.insert(flitoProveedoresLogistica).values({
    nombre: d.nombre, nit: d.nit, contacto: d.contacto ?? null, telefono: d.telefono ?? null,
  }).returning(), d.nombre, d.nit);
  return creado!;
}

export async function actualizarProveedorLogistica(
  id: string, d: Partial<DatosProveedorLogistica> & { activo?: boolean },
): Promise<FilaProveedorLogistica> {
  await validarUnicos(d.nombre, d.nit, id);
  if (d.activo === false) return inactivarSinCompanias(id, d);
  const [act] = await escribir(() => db.update(flitoProveedoresLogistica).set(d)
    .where(eq(flitoProveedoresLogistica.id, id)).returning(), d.nombre, d.nit);
  if (act === undefined) throw new ProveedorLogisticaNoEncontradoError();
  return act;
}

/**
 * RN-PLOGC-3. Inactivar en UNA transacción con `FOR UPDATE` sobre el proveedor: una asignación concurrente
 * (que toma `FOR SHARE`, RN-PLOGC-2) espera, y relee el estado ya confirmado.
 */
async function inactivarSinCompanias(id: string, d: Partial<DatosProveedorLogistica> & { activo?: boolean }): Promise<FilaProveedorLogistica> {
  return db.transaction(async (tx) => {
    const [actual] = await tx.select({ activo: flitoProveedoresLogistica.activo }).from(flitoProveedoresLogistica)
      .where(eq(flitoProveedoresLogistica.id, id)).for('update').limit(1);
    if (actual === undefined) throw new ProveedorLogisticaNoEncontradoError();
    // Ya inactivo: idempotente, no hay nada que bloquear.
    if (actual.activo) {
      const companias = await companiasConProveedorLogistica(tx, id);
      if (companias.length > 0) throw new ProveedorLogisticaAsignadoError(companias);
    }
    const [act] = await escribir(() => tx.update(flitoProveedoresLogistica).set(d)
      .where(eq(flitoProveedoresLogistica.id, id)).returning(), d.nombre, d.nit);
    return act!;
  });
}
