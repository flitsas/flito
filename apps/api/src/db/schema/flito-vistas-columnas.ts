// Vistas de columnas persistidas (ADR-0043, Opción 2): tabla de vistas y tabla de punteros.
//
// Lo que NO vive aquí, y es deliberado:
//   · La «vista del sistema» no es una fila: es el catálogo de columnas por defecto en código
//     (`modules/flito-vistas-columnas/flito-vistas-columnas.catalogo.ts`).
//   · Los CHECK de alcance/propiedad y las reglas de propiedad del puntero están en la migración 0305
//     y en el servicio (la base no puede expresar la propiedad entre tablas).
//   · Los índices únicos parciales SÍ se declaran aquí, con el mismo predicado que la migración.
import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, serial, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core';
import { users } from './nucleo.js';

export const flitoVistasColumnas = pgTable('flito_vistas_columnas', {
  id: serial('id').primaryKey(),
  tablaId: varchar('tabla_id', { length: 80 }).notNull(),
  alcance: varchar('alcance', { length: 16 }).notNull(), // 'personal' | 'compartida'
  ownerUserId: integer('owner_user_id').references(() => users.id, { onDelete: 'cascade' }), // obligatorio si personal; NULL si compartida
  nombre: varchar('nombre', { length: 60 }).notNull(),
  columnas: jsonb('columnas').$type<string[]>().notNull(), // claves de columna, en orden. Nunca valores.
  creadoPorUserId: integer('creado_por_user_id').references(() => users.id, { onDelete: 'set null' }),
  version: integer('version').notNull().default(1), // concurrencia optimista
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('uq_vista_personal_nombre').on(t.tablaId, t.ownerUserId, t.nombre).where(sql`alcance = 'personal'`),
  uniqueIndex('uq_vista_compartida_nombre').on(t.tablaId, t.nombre).where(sql`alcance = 'compartida'`),
  index('ix_vista_tabla_alcance').on(t.tablaId, t.alcance),
  index('ix_vista_owner').on(t.ownerUserId),
]);

export const flitoVistasColumnasPreferencias = pgTable('flito_vistas_columnas_preferencias', {
  id: serial('id').primaryKey(),
  tablaId: varchar('tabla_id', { length: 80 }).notNull(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }), // NULL = puntero general
  vistaId: integer('vista_id').references(() => flitoVistasColumnas.id, { onDelete: 'cascade' }), // NULL = sistema explícito
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('uq_pref_usuario_tabla').on(t.tablaId, t.userId).where(sql`user_id IS NOT NULL`),
  uniqueIndex('uq_pref_general_tabla').on(t.tablaId).where(sql`user_id IS NULL`),
  index('ix_pref_vista').on(t.vistaId),
]);
