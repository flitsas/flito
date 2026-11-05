// Identidad única de proveedor (Feature #14323, ADR-0039 §4.1): esta tabla es el padre y
// `flito_proveedores_soat` y `flito_proveedores_logistica` son sus perfiles, con el MISMO UUID (R21).
//
// Solo en SQL (0289), para no crear imports circulares con `schema.ts`:
//   · FK de los perfiles y de `deleted_by`/`actor_id` hacia `users`, todas RESTRICT.
//   · uq_flito_proveedores_nombre_vivo y uq_flito_proveedores_nit_vivo, índices únicos parciales sobre
//     expresiones: el nombre normalizado y el NIT sin dígito de verificación (R8).
//   · La vista flito_proveedor_servicios_v (proveedor_id, servicio): perfiles con deleted_at IS NULL.
//   · Los CHECK de lista blanca de la auditoría.
import { boolean, index, integer, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

export const flitoProveedores = pgTable('flito_proveedores', {
  id: uuid('id').primaryKey().defaultRandom(), // Conserva el UUID del perfil de origen (R21).
  nombre: varchar('nombre', { length: 150 }).notNull(),
  // NULLABLE en BD: a los existentes no se les exige (R9). La obligación es de la API, desde F2.
  nit: varchar('nit', { length: 20 }),
  telefono: varchar('telefono', { length: 30 }),
  correo: varchar('correo', { length: 150 }),
  direccion: varchar('direccion', { length: 300 }),
  ciudad: varchar('ciudad', { length: 100 }),
  contacto: varchar('contacto', { length: 150 }),
  activo: boolean('activo').notNull().default(true),
  version: integer('version').notNull().default(1), // Aviso de edición simultánea (F2).
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: integer('deleted_by'),
});

// Sin lectores ni escritores hasta F2.
export const flitoProveedoresAuditoria = pgTable('flito_proveedores_auditoria', {
  id: uuid('id').primaryKey().defaultRandom(),
  proveedorId: uuid('proveedor_id').notNull().references(() => flitoProveedores.id, { onDelete: 'restrict' }),
  accion: varchar('accion', { length: 20 }).notNull(),
  campo: varchar('campo', { length: 30 }),
  valorAntes: text('valor_antes'), // Ya enmascarado al escribir si el campo es de R23.
  valorDespues: text('valor_despues'),
  actorId: integer('actor_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ proveedorIdx: index('idx_flito_prov_aud_proveedor').on(t.proveedorId, t.createdAt) }));
