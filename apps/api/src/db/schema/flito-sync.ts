// HU #13061 (Feature #13057, Épica #12736) — acceso de FLITO a FLIT 2, migración 0214.
// Vive aparte de `schema.ts` por el techo de max-lines (3400), como `schema/flito-soat-incompletas.ts`.
// `schema.ts` la re-exporta.
//
// Import circular a propósito (mismo patrón que `schema/permisos.ts`): las FK de Drizzle son callbacks
// perezosos, así que el ciclo ESM resuelve sin problema.
import {
  pgTable, smallserial, varchar, uuid, smallint, boolean, timestamp, integer, uniqueIndex, check, customType, text,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from '../schema.js';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() { return 'bytea'; },
});

/**
 * Usuario de servicio con el que FLITO pide el pase a FLIT 2 (patrón del token SIMIT, ADR-0002).
 *
 * Una sola fila `activo = true` (índice único parcial). Reemplazar el acceso NO es un UPDATE del
 * cipher: se desactiva la vigente y se inserta otra; las inactivas son el rastro de quién y cuándo.
 * `client_id` no es secreto ni PII y se devuelve; la contraseña solo existe cifrada (AES-256-GCM,
 * `FLIT2_ENC_KEY`). Las marcas de rechazo/bloqueo las escribe el pase (HU #13063) en la fila vigente:
 * como reemplazar crea fila nueva, un acceso nuevo nace sin marcas.
 */
export const flitoSyncFlit2Acceso = pgTable('flito_sync_flit2_acceso', {
  id: smallserial('id').primaryKey(),
  clientId: varchar('client_id', { length: 120 }).notNull(),
  secretCipher: bytea('secret_cipher').notNull(),
  secretIv: bytea('secret_iv').notNull(),
  secretAuthTag: bytea('secret_auth_tag').notNull(),
  aadNonce: uuid('aad_nonce').notNull(),
  keyVersion: smallint('key_version').notNull().default(1),
  activo: boolean('activo').notNull().default(true),
  rechazadoEn: timestamp('rechazado_en', { withTimezone: true }),
  rechazoMotivo: varchar('rechazo_motivo', { length: 40 }),
  bloqueadoHasta: timestamp('bloqueado_hasta', { withTimezone: true }),
  bloqueoMotivo: varchar('bloqueo_motivo', { length: 40 }),
  descifradoFallidoEn: timestamp('descifrado_fallido_en', { withTimezone: true }),
  descifradoFallidoMotivo: varchar('descifrado_fallido_motivo', { length: 200 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: integer('created_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: integer('updated_by').references(() => users.id),
}, (t) => ({
  unActivo: uniqueIndex('uq_flito_sync_flit2_acceso_activo').on(t.activo).where(sql`${t.activo}`),
  rechazoMotivoValido: check('ck_flito_sync_flit2_acceso_rechazo_motivo',
    sql`${t.rechazoMotivo} IS NULL OR ${t.rechazoMotivo} IN ('invalid_client', 'secret_rotation_required')`),
  bloqueoMotivoValido: check('ck_flito_sync_flit2_acceso_bloqueo_motivo',
    sql`${t.bloqueoMotivo} IS NULL OR ${t.bloqueoMotivo} IN ('client_locked', 'rate_limited')`),
}));

/**
 * HU #13091 (0215) — posición de lectura del feed de FLIT 2. Una sola fila (`id = 1`, CHECK), sembrada
 * por la migración: el código solo hace `UPDATE … WHERE id = 1`. `since_arranque` se fija una vez
 * (`WHERE since_arranque IS NULL`) y el cursor avanza con guarda optimista (`IS NOT DISTINCT FROM`).
 * `atrasada` y `ultimo_error_codigo` los consume la HU #13092.
 */
export const flitoSyncFlit2Lectura = pgTable('flito_sync_flit2_lectura', {
  id: smallint('id').primaryKey().default(1),
  cursor: text('cursor'),
  sinceArranque: timestamp('since_arranque', { withTimezone: true }),
  ultimaExitosaEn: timestamp('ultima_exitosa_en', { withTimezone: true }),
  ultimoIntentoEn: timestamp('ultimo_intento_en', { withTimezone: true }),
  ultimoErrorCodigo: varchar('ultimo_error_codigo', { length: 40 }),
  atrasada: boolean('atrasada').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  unaFila: check('ck_flito_sync_flit2_lectura_una_fila', sql`${t.id} = 1`),
  cursorLen: check('ck_flito_sync_flit2_lectura_cursor_len',
    sql`${t.cursor} IS NULL OR length(${t.cursor}) BETWEEN 1 AND 2000`),
}));
