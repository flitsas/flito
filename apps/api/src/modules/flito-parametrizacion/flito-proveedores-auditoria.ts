// HU #14335 (Feature #14324, ADR-0039 §4.2) — Auditoría de proveedores en `flito_proveedores_auditoria`.
//
// Reglas:
//   · RN-PAUD-1 — Se escribe dentro de la transacción del cambio y lanza si falla (ADR-0014): sin auditoría no hay cambio.
//   · RN-PAUD-2 — La máscara se aplica AL ESCRIBIR (R23): teléfono, correo, dirección y contacto nunca llegan en claro a
//       la fila. El NIT también se enmascara (decisión del humano, ADR-0039 §16.8b). Nombre y ciudad van en claro: el
//       proveedor es una empresa.
//   · RN-PAUD-3 — `campo` y `accion` son listas blancas: los CHECK de la 0292 rechazan cualquier otro valor.
import { desc, eq } from 'drizzle-orm';
import type { AccionAuditoriaProveedor, ProveedorHistorialItemDto } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoProveedoresAuditoria, users } from '../../db/schema.js';
import { maskAddress, maskDocument, maskEmail, maskName, maskPhone } from '../../shared/utils/pii.js';

export type CampoAuditadoProveedor =
  | 'nombre' | 'nit' | 'telefono' | 'correo' | 'direccion' | 'ciudad' | 'contacto' | 'activo' | 'servicio'
  | 'estrategia' | 'umbral_ocr' | 'sla_horas';

const MASCARAS: Partial<Record<CampoAuditadoProveedor, (valor: string) => string>> = {
  nit: maskDocument,
  telefono: maskPhone,
  correo: maskEmail,
  direccion: maskAddress,
  contacto: maskName,
};

/** Máximo de filas del historial: un proveedor cambia poco y la consulta no necesita paginar. */
const TOPE_HISTORIAL = 500;

export interface EntradaAuditoriaProveedor {
  accion: AccionAuditoriaProveedor;
  campo?: CampoAuditadoProveedor;
  antes?: string | null;
  despues?: string | null;
}

/** RN-PAUD-2. `null` sigue siendo `null`: que el campo estuviera vacío no es un dato personal. */
export function valorAuditable(campo: CampoAuditadoProveedor | undefined, valor: string | null | undefined): string | null {
  if (valor == null) return null;
  const mascara = campo === undefined ? undefined : MASCARAS[campo];
  return mascara ? mascara(valor) : valor;
}

/** La parte de la transacción que este registro necesita. */
export type EjecutorAuditoria = Pick<typeof db, 'insert'>;

/** RN-PAUD-1. Se llama con la transacción del cambio; un fallo aquí la revierte. */
export async function registrarAuditoriaProveedor(
  tx: EjecutorAuditoria, proveedorId: string, actorId: number | null, entradas: readonly EntradaAuditoriaProveedor[],
): Promise<void> {
  if (entradas.length === 0) return;
  await tx.insert(flitoProveedoresAuditoria).values(entradas.map((e) => ({
    proveedorId,
    accion: e.accion,
    campo: e.campo ?? null,
    valorAntes: valorAuditable(e.campo, e.antes),
    valorDespues: valorAuditable(e.campo, e.despues),
    actorId,
  })));
}

/** Una entrada por cada campo que cambió. Compara los valores en claro: dos valores distintos pueden tener igual máscara. */
export function entradasDeCambios<C extends CampoAuditadoProveedor>(
  accion: AccionAuditoriaProveedor,
  antes: Partial<Record<C, string | null>>,
  despues: Partial<Record<C, string | null>>,
): EntradaAuditoriaProveedor[] {
  return (Object.keys(despues) as C[])
    .filter((campo) => (antes[campo] ?? null) !== (despues[campo] ?? null))
    .map((campo) => ({ accion, campo, antes: antes[campo] ?? null, despues: despues[campo] ?? null }));
}

/** Lo auditado, del cambio más reciente al más antiguo. Un proveedor eliminado conserva su historial. */
export async function historialProveedor(proveedorId: string): Promise<ProveedorHistorialItemDto[]> {
  const filas = await db.select({
    id: flitoProveedoresAuditoria.id,
    accion: flitoProveedoresAuditoria.accion,
    campo: flitoProveedoresAuditoria.campo,
    valorAntes: flitoProveedoresAuditoria.valorAntes,
    valorDespues: flitoProveedoresAuditoria.valorDespues,
    actorId: flitoProveedoresAuditoria.actorId,
    actorNombre: users.name,
    createdAt: flitoProveedoresAuditoria.createdAt,
  }).from(flitoProveedoresAuditoria)
    .leftJoin(users, eq(users.id, flitoProveedoresAuditoria.actorId))
    .where(eq(flitoProveedoresAuditoria.proveedorId, proveedorId))
    .orderBy(desc(flitoProveedoresAuditoria.createdAt))
    .limit(TOPE_HISTORIAL);
  return filas.map(({ createdAt, accion, ...f }) => ({
    ...f, accion: accion as AccionAuditoriaProveedor, fecha: createdAt.toISOString(),
  }));
}
