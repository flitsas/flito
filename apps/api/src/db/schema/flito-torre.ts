// Torre de Control Gerencial (Épica #14590) — umbrales configurables de las alertas (migración 0303).
// La semilla sale de `UMBRALES_TORRE` (shared-types), y los operativos del `ANS_OPERATIVO`. Solo `admin` escribe
// (función `torre.umbrales.editar`); cada cambio pasa por `audit()`.
import { sql } from 'drizzle-orm';
import { check, integer, numeric, pgTable, text, timestamp, varchar } from 'drizzle-orm/pg-core';
import { users } from './nucleo.js';

export const flitoTorreUmbrales = pgTable('flito_torre_umbrales', {
  clave: varchar('clave', { length: 60 }).primaryKey(),
  valor: numeric('valor', { precision: 14, scale: 2 }).notNull(),
  unidad: varchar('unidad', { length: 12 }).notNull(),
  descripcion: text('descripcion').notNull(),
  actualizadoPor: integer('actualizado_por').references(() => users.id, { onDelete: 'set null' }),
  actualizadoEn: timestamp('actualizado_en', { withTimezone: true }).defaultNow(),
}, (t) => ({
  unidadCk: check('flito_torre_umbrales_unidad_chk', sql`${t.unidad} IN ('dias','horas','porcentaje','cop','conteo')`),
  valorCk: check('flito_torre_umbrales_valor_chk', sql`${t.valor} >= 0 AND (${t.unidad} <> 'porcentaje' OR ${t.valor} <= 100)`),
}));
