// HU #14355 (F5 E2, migración 0314) — alta de proveedores en los fixtures con SQL crudo.
//
// Desde la 0314 los perfiles de SOAT y de Logística ya no tienen nombre, estado ni datos generales, y ningún trigger crea
// el padre al insertar el perfil: el alta crea primero `flito_proveedores` y después el perfil con el mismo UUID, como
// `crearProveedor`. El estado (`activo`) y la baja del proveedor viven en el padre.

import type postgres from 'postgres';

type Sql = postgres.Sql | postgres.TransactionSql;

export interface DatosPadre {
  nombre: string;
  activo?: boolean;
  nit?: string | null;
  contacto?: string | null;
  telefono?: string | null;
  /** Baja lógica del padre (y, en `proveedorSoat`/`proveedorLogistica`, también del perfil). */
  deletedAt?: Date | null;
}

/** Inserta el padre y devuelve su id. */
export async function crearPadreProveedor(sql: Sql, d: DatosPadre): Promise<string> {
  const [p] = await sql`INSERT INTO flito_proveedores (nombre, activo, nit, contacto, telefono, deleted_at)
    VALUES (${d.nombre}, ${d.activo ?? true}, ${d.nit ?? null}, ${d.contacto ?? null}, ${d.telefono ?? null}, ${d.deletedAt?.toISOString() ?? null})
    RETURNING id`;
  return p!.id as string;
}

/**
 * Baja lógica del proveedor entero, como `eliminarProveedor`: el padre y sus perfiles. Antes de la 0314, dar de baja el
 * último perfil daba de baja el padre por trigger; ya no.
 */
export async function darDeBajaProveedor(sql: Sql, id: string): Promise<void> {
  await sql`UPDATE flito_proveedores SET deleted_at = now() WHERE id = ${id} AND deleted_at IS NULL`;
  await sql`UPDATE flito_proveedores_soat SET deleted_at = now() WHERE id = ${id} AND deleted_at IS NULL`;
  await sql`UPDATE flito_proveedores_logistica SET deleted_at = now() WHERE id = ${id} AND deleted_at IS NULL`;
}

/** Padre + perfil de Logística con el mismo id. Con `id`, solo añade el perfil a un padre existente. */
export async function proveedorLogistica(sql: Sql, d: DatosPadre & { id?: string }): Promise<string> {
  const id = d.id ?? await crearPadreProveedor(sql, d);
  await sql`INSERT INTO flito_proveedores_logistica (id, deleted_at) VALUES (${id}, ${d.deletedAt?.toISOString() ?? null})`;
  return id;
}

/** Padre + perfil de SOAT con el mismo id. Con `id`, solo añade el perfil a un padre existente. */
export async function proveedorSoat(
  sql: Sql, d: DatosPadre & { id?: string; estrategia?: string },
): Promise<string> {
  const id = d.id ?? await crearPadreProveedor(sql, d);
  if (d.estrategia === undefined) {
    await sql`INSERT INTO flito_proveedores_soat (id, deleted_at) VALUES (${id}, ${d.deletedAt?.toISOString() ?? null})`;
  } else {
    await sql`INSERT INTO flito_proveedores_soat (id, estrategia, deleted_at) VALUES (${id}, ${d.estrategia}, ${d.deletedAt?.toISOString() ?? null})`;
  }
  return id;
}
