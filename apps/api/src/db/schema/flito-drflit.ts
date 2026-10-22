// HU #13803 (Feature #13695) — Dr. Flit: autorizaciones de tratamiento de datos (Ley 1581). Migración 0245.
// Vive aparte de `schema.ts` por el techo de max-lines (3400), como `schema/flito-comprobantes.ts`. A
// diferencia de esa, `schema.ts` NO la re-exporta (está justo en el techo): se importa de aquí directo. Diseño: docs/diseno/feature-13695-dr-flit-soporte.md (modelo de datos).
//
// SOLO INSERCIÓN: la migración 0245 instala triggers que impiden UPDATE, DELETE y TRUNCATE (mismo
// mecanismo que `pii_access_log`, 0059). CHECKs declarados aquí y en la migración (lección 0157).
// `ON DELETE RESTRICT` hacia `users`: las cuentas se desactivan, nunca se borran.
import { pgTable, serial, integer, varchar, char, timestamp, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from '../schema.js';

export const flitoDrflitAutorizaciones = pgTable('flito_drflit_autorizaciones', {
  id: serial('id').primaryKey(),
  usuarioId: integer('usuario_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  finalidad: varchar('finalidad', { length: 20 }).notNull(),
  version: varchar('version', { length: 40 }).notNull(),
  /** SHA-256 (hex) del texto exacto aceptado: prueba de qué se autorizó. */
  textoSha256: char('texto_sha256', { length: 64 }).notNull(),
  aceptadaEn: timestamp('aceptada_en', { withTimezone: true }).notNull().defaultNow(),
  ip: varchar('ip', { length: 45 }),
  userAgent: varchar('user_agent', { length: 300 }),
}, (t) => ({
  uqUsuarioFinalidadVersion: uniqueIndex('uq_flito_drflit_aut_usuario_finalidad_version')
    .on(t.usuarioId, t.finalidad, t.version),
  ckFinalidad: check('ck_flito_drflit_aut_finalidad', sql`${t.finalidad} IN ('soporte','ia')`),
  ckSha: check('ck_flito_drflit_aut_sha', sql`${t.textoSha256} ~ '^[0-9a-f]{64}$'`),
}));
