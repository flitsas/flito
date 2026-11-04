// HU #13989 (Feature #13980, ADR-0033) — agregados diarios del uso de rutas legacy, migración 0287.
// Vive aparte de `schema.ts` por el techo de max-lines; `schema.ts` la re-exporta (`export *`).
// Temporal: se retira con la instrumentación (ver la política de retención en la cabecera de la 0287).
import { pgTable, varchar, bigint, date, primaryKey, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const usoLegacyDiario = pgTable('uso_legacy_diario', {
  dia: date('dia').notNull(),
  modulo: varchar('modulo', { length: 20 }).notNull(),
  ruta: varchar('ruta', { length: 240 }).notNull(), // prefijo + patrón; nunca la URL real
  metodo: varchar('metodo', { length: 10 }).notNull(),
  consumidor: varchar('consumidor', { length: 40 }).notNull(), // permisos_roles.codigo o 'publico'
  total: bigint('total', { mode: 'number' }).notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.dia, t.modulo, t.ruta, t.metodo, t.consumidor] }),
  moduloCheck: check('uso_legacy_diario_modulo_check', sql`${t.modulo} IN ('soat','tramites','liquidacion')`),
  totalCheck: check('uso_legacy_diario_total_check', sql`${t.total} > 0`),
}));
