// HU #14103 (Feature #14089, Épica #13758) — Lectura de proveedores de LOGÍSTICA y la normalización de su NIT.
// Módulo FLITO `flito-parametrizacion`. Un perfil de baja (`deleted_at`) no se lista.
// HU #14334: las escrituras se retiraron. Alta y edición viven en `flito-proveedores.service.ts`, sobre el padre.
import { asc, isNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { flitoProveedoresLogistica } from '../../db/schema.js';

export class ProveedorLogisticaNoEncontradoError extends Error {
  constructor() { super('Proveedor de logística no encontrado'); this.name = 'ProveedorLogisticaNoEncontradoError'; }
}

/** «900.123.456 - 7» → «900123456-7». */
export function normalizarNit(nit: string): string {
  return nit.replace(/[.\s]/g, '').replace(/–|—/g, '-');
}
export const NIT_VALIDO = /^\d{5,15}(-\d)?$/;

export type FilaProveedorLogistica = typeof flitoProveedoresLogistica.$inferSelect;

export function proveedorLogisticaDto(p: FilaProveedorLogistica) {
  return { id: p.id, nombre: p.nombre, nit: p.nit, contacto: p.contacto, telefono: p.telefono, activo: p.activo };
}

export async function listarProveedoresLogistica(): Promise<FilaProveedorLogistica[]> {
  return db.select().from(flitoProveedoresLogistica).where(isNull(flitoProveedoresLogistica.deletedAt)).orderBy(asc(flitoProveedoresLogistica.nombre));
}
