// HU #13410 (Feature #13408, Épica #13201) — borrados pendientes del almacenamiento, migración 0225.
// Vive aparte de `schema.ts` por el techo de max-lines, como `schema/flito-soat-incompletas.ts`;
// `schema.ts` la re-exporta. Los CHECK se declaran también aquí por la lección de la 0157.
import { pgTable, uuid, varchar, text, integer, timestamp, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** Motivos con los que se cierra un pendiente. */
export const MOTIVOS_CIERRE_BORRADO = ['borrado', 'inexistente', 'referenciada'] as const;
export type MotivoCierreBorrado = typeof MOTIVOS_CIERRE_BORRADO[number];

/**
 * Objetos del almacenamiento cuya fila ya se borró y que falta borrar (HU #13410). Abierto =
 * `resuelto_en` NULL. `storage_key` es PII y solo existe mientras el pendiente está abierto: el
 * UPDATE de cierre la pone a NULL (CHECK `ck_..._clave`). `clave_hash` queda para correlacionar.
 */
export const flitoStorageBorradosPendientes = pgTable('flito_storage_borrados_pendientes', {
  id: uuid('id').primaryKey().defaultRandom(),
  storageKey: text('storage_key'),
  claveHash: varchar('clave_hash', { length: 16 }).notNull(),
  origen: varchar('origen', { length: 50 }).notNull(),
  intentos: integer('intentos').notNull().default(0),
  ultimoIntentoEn: timestamp('ultimo_intento_en', { withTimezone: true }),
  ultimoError: varchar('ultimo_error', { length: 100 }),
  creadoEn: timestamp('creado_en', { withTimezone: true }).notNull().defaultNow(),
  resueltoEn: timestamp('resuelto_en', { withTimezone: true }),
  motivoCierre: varchar('motivo_cierre', { length: 20 }),
  ultimaAlertaEn: timestamp('ultima_alerta_en', { withTimezone: true }),
}, (t) => ({
  abiertosIdx: index('idx_flito_storage_borrados_pendientes_abiertos').on(t.creadoEn)
    .where(sql`${t.resueltoEn} IS NULL`),
  intentosChk: check('ck_flito_storage_borrados_pendientes_intentos', sql`${t.intentos} >= 0`),
  motivoChk: check('ck_flito_storage_borrados_pendientes_motivo',
    sql`${t.motivoCierre} IS NULL OR ${t.motivoCierre} IN ('borrado', 'inexistente', 'referenciada')`),
  cierreChk: check('ck_flito_storage_borrados_pendientes_cierre',
    sql`(${t.resueltoEn} IS NULL) = (${t.motivoCierre} IS NULL)`),
  claveChk: check('ck_flito_storage_borrados_pendientes_clave',
    sql`(${t.resueltoEn} IS NULL) = (${t.storageKey} IS NOT NULL)`),
}));
