// Feature #13978 (ADR-0034 D2, D6) — registro de llaves PII, migración 0288. Vive aparte de `schema.ts`
// por el techo de max-lines; `schema.ts` la re-exporta.
import { pgTable, smallint, text, timestamp } from 'drizzle-orm/pg-core';

/** Un canario por versión de llave: una constante cifrada que ancla cada versión a su pasada. */
export const piiKeyRegistry = pgTable('pii_key_registry', {
  version: smallint('version').primaryKey(),
  canario: text('canario').notNull(),
  creadaEn: timestamp('creada_en', { withTimezone: true }).notNull().defaultNow(),
});
