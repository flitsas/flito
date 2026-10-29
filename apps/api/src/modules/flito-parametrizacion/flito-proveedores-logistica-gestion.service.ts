// HU #14148 (Feature #14089, Épica #13758) — Lo que la pantalla «Clientes y proveedores» necesita del servidor para los
// proveedores: listado UNIFICADO (SOAT + logística), IMPACTO de una baja y ELIMINAR un proveedor de logística.
// Módulo FLITO `flito-parametrizacion`. Sin funciones de permiso nuevas: reutiliza `parametrizacion.proveedores.*`.
//
// Reglas:
//   · RN-PROVU-1 — el listado unifica `flito_proveedores_soat` (no eliminados) y `flito_proveedores_logistica`. `tipo` =
//       'soat' | 'logistica'. `companiasAsignadas` cuenta compañías VIGENTES: SOAT por `flito_proveedor_soat_sin_tramite_id`,
//       logística por `flito_proveedor_logistica_id` SIN mirar `logistica_autogestionable` (la que conserva el proveedor con
//       la logística apagada también cuenta: el proveedor sigue asignado y no se puede dar de baja). NIT/contacto/teléfono
//       solo existen en logística; en SOAT van `null`.
//   · RN-PROVU-2 — impacto de logística: `{ companias, nombres }` con los nombres de las compañías vigentes asignadas,
//       en orden alfabético y MÁXIMO 3 (`companias` es el total real).
//   · RN-PROVU-3 — eliminar = DELETE físico (la tabla no tiene baja lógica). Solo si NO tiene compañías vigentes asignadas
//       (409 `ProveedorLogisticaAsignadoError`); si otra fila lo referencia aún (compañía eliminada lógicamente, acta) la FK
//       RESTRICT lo impide → 409 `ProveedorLogisticaEnUsoError`. Una sola transacción con `FOR UPDATE` sobre el proveedor.
import { and, asc, count, eq, isNotNull, isNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { clients, flitoProveedoresLogistica, flitoProveedoresSoat } from '../../db/schema.js';
import { clienteVigente } from '../clients/cliente-operable.js';
import { ProveedorLogisticaAsignadoError, companiasConProveedorLogistica } from './flito-logistica-proveedor-compania.service.js';
import { ProveedorLogisticaNoEncontradoError } from './flito-proveedores-logistica.service.js';

export const TOPE_NOMBRES_IMPACTO = 3;

export type TipoProveedor = 'soat' | 'logistica';
export interface ProveedorUnificadoDto {
  tipo: TipoProveedor; id: string; nombre: string;
  nit: string | null; contacto: string | null; telefono: string | null;
  activo: boolean; companiasAsignadas: number;
}

/** 409: otra fila (compañía eliminada lógicamente, acta) todavía referencia al proveedor. */
export class ProveedorLogisticaEnUsoError extends Error {
  constructor() { super('No se puede eliminar: el proveedor tiene registros asociados. Inactívalo en su lugar.'); this.name = 'ProveedorLogisticaEnUsoError'; }
}

async function conteoPorProveedor(columna: typeof clients.flitoProveedorSoatSinTramiteId | typeof clients.flitoProveedorLogisticaId) {
  const filas = await db.select({ id: columna, total: count() }).from(clients)
    .where(and(isNotNull(columna), clienteVigente())).groupBy(columna);
  return new Map(filas.map((f) => [f.id as string, Number(f.total)]));
}

/** RN-PROVU-1. Orden: nombre (sin distinguir mayúsculas), luego tipo. */
export async function listarProveedoresUnificados(): Promise<ProveedorUnificadoDto[]> {
  const [soat, logistica, cuentaSoat, cuentaLog] = await Promise.all([
    db.select().from(flitoProveedoresSoat).where(isNull(flitoProveedoresSoat.deletedAt)).orderBy(asc(flitoProveedoresSoat.nombre)),
    db.select().from(flitoProveedoresLogistica).orderBy(asc(flitoProveedoresLogistica.nombre)),
    conteoPorProveedor(clients.flitoProveedorSoatSinTramiteId),
    conteoPorProveedor(clients.flitoProveedorLogisticaId),
  ]);
  const filas: ProveedorUnificadoDto[] = [
    ...soat.map((p) => ({
      tipo: 'soat' as const, id: p.id, nombre: p.nombre, nit: null, contacto: null, telefono: null,
      activo: p.activo, companiasAsignadas: cuentaSoat.get(p.id) ?? 0,
    })),
    ...logistica.map((p) => ({
      tipo: 'logistica' as const, id: p.id, nombre: p.nombre, nit: p.nit, contacto: p.contacto, telefono: p.telefono,
      activo: p.activo, companiasAsignadas: cuentaLog.get(p.id) ?? 0,
    })),
  ];
  return filas.sort((a, b) => a.nombre.toLowerCase().localeCompare(b.nombre.toLowerCase()) || a.tipo.localeCompare(b.tipo));
}

/** RN-PROVU-2. Lanza `ProveedorLogisticaNoEncontradoError` si el proveedor no existe. */
export async function impactoProveedorLogistica(id: string): Promise<{ companias: number; nombres: string[] }> {
  const [p] = await db.select({ id: flitoProveedoresLogistica.id }).from(flitoProveedoresLogistica)
    .where(eq(flitoProveedoresLogistica.id, id)).limit(1);
  if (p === undefined) throw new ProveedorLogisticaNoEncontradoError();
  const nombres = await companiasConProveedorLogistica(db, id);
  return { companias: nombres.length, nombres: nombres.slice(0, TOPE_NOMBRES_IMPACTO) };
}

function esViolacionFk(e: unknown): boolean {
  for (let x: unknown = e, i = 0; x && typeof x === 'object' && i < 3; x = (x as { cause?: unknown }).cause, i++) {
    if ((x as { code?: unknown }).code === '23503') return true;
  }
  return false;
}

/** RN-PROVU-3. Devuelve id y nombre del eliminado (para la auditoría). */
export async function eliminarProveedorLogistica(id: string): Promise<{ id: string; nombre: string }> {
  try {
    return await db.transaction(async (tx) => {
      const [p] = await tx.select({ nombre: flitoProveedoresLogistica.nombre }).from(flitoProveedoresLogistica)
        .where(eq(flitoProveedoresLogistica.id, id)).for('update').limit(1);
      if (p === undefined) throw new ProveedorLogisticaNoEncontradoError();
      const companias = await companiasConProveedorLogistica(tx, id);
      if (companias.length > 0) throw new ProveedorLogisticaAsignadoError(companias, 'eliminar');
      await tx.delete(flitoProveedoresLogistica).where(eq(flitoProveedoresLogistica.id, id));
      return { id, nombre: p.nombre };
    });
  } catch (e) {
    if (esViolacionFk(e)) throw new ProveedorLogisticaEnUsoError();
    throw e;
  }
}
