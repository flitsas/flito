// HU #14131 (Feature #14013, ADR-0032) — cola de la carga masiva de SOAT sin trámite, migración 0270.
// Vive aparte de `schema.ts` por el techo de max-lines; `schema.ts` la re-exporta (`export *`).
//
// Import circular a propósito (mismo patrón que `schema/flito-soat-incompletas.ts`): las FK de Drizzle
// son callbacks perezosos, así que el ciclo ESM resuelve sin problema.
import {
  pgTable, uuid, varchar, integer, smallint, timestamp, index, uniqueIndex, check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { clients, users } from '../schema.js';

/**
 * Lote de una carga masiva (A1: solo el alta; el worker, los contadores congelados y la purga llegan con
 * las migraciones 0271 y 0272). Un lote ACTIVO (`en_cola` | `procesando`) por compañía, garantizado por
 * el índice único parcial: la inserción concurrente pierde con `23505`. No guarda el Excel, su nombre ni
 * ninguna PII: solo el sha256 del archivo para trazabilidad. Los CHECK se declaran también aquí (0157).
 */
export const flitoSoatMasivoLotes = pgTable('flito_soat_masivo_lotes', {
  id: uuid('id').primaryKey().defaultRandom(),
  companiaId: integer('compania_id').notNull().references(() => clients.id),
  creadoPorId: integer('creado_por_id').references(() => users.id),
  creadoPorNombre: varchar('creado_por_nombre', { length: 150 }).notNull(),
  /** Plantilla usada: 'renovacion' | 'inicial'. */
  tipoSoat: varchar('tipo_soat', { length: 10 }).notNull(),
  /** 'en_cola' | 'procesando' | 'terminado'. */
  estado: varchar('estado', { length: 12 }).notNull().default('en_cola'),
  /** Filas de datos tras ignorar las vacías (1..200). */
  totalFilas: smallint('total_filas').notNull(),
  archivoHash: varchar('archivo_hash', { length: 64 }).notNull(),
  creadoEn: timestamp('creado_en', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uqActivo: uniqueIndex('uq_flito_soat_masivo_lote_activo').on(t.companiaId).where(sql`estado IN ('en_cola','procesando')`),
  idxCompaniaCreado: index('idx_flito_soat_masivo_lotes_compania_creado').on(t.companiaId, sql`creado_en DESC`),
  tipoChk: check('flito_soat_masivo_lotes_tipo_chk', sql`tipo_soat IN ('renovacion','inicial')`),
  estadoChk: check('flito_soat_masivo_lotes_estado_chk', sql`estado IN ('en_cola','procesando','terminado')`),
  totalChk: check('flito_soat_masivo_lotes_total_chk', sql`total_filas BETWEEN 1 AND 200`),
}));

/**
 * Una fila del lote. Las columnas de PII (placa, documento, nombre, correo, celular, vin) son EFÍMERAS
 * (ADR-0032): se anonimizan al terminar el lote (A2) y se purgan (A3). Nunca van a logs.
 */
export const flitoSoatMasivoFilas = pgTable('flito_soat_masivo_filas', {
  id: uuid('id').primaryKey().defaultRandom(),
  loteId: uuid('lote_id').notNull().references(() => flitoSoatMasivoLotes.id, { onDelete: 'cascade' }),
  /** Número de fila del Excel (2..201). */
  nFila: smallint('n_fila').notNull(),
  /** 'pendiente' (en cola) | 'consultando' | 'aceptada' | 'por_validar' | 'rechazada'. */
  estado: varchar('estado', { length: 12 }).notNull(),
  motivoRechazo: varchar('motivo_rechazo', { length: 30 }),
  placa: varchar('placa', { length: 10 }),
  documento: varchar('documento', { length: 30 }),
  nombre: varchar('nombre', { length: 150 }),
  correo: varchar('correo', { length: 150 }),
  celular: varchar('celular', { length: 20 }),
  vin: varchar('vin', { length: 17 }),
}, (t) => ({
  uqFila: uniqueIndex('uq_flito_soat_masivo_filas_lote_fila').on(t.loteId, t.nFila),
  idxLote: index('idx_flito_soat_masivo_filas_lote').on(t.loteId, t.estado),
  estadoChk: check('flito_soat_masivo_filas_estado_chk',
    sql`estado IN ('pendiente','consultando','aceptada','por_validar','rechazada')`),
  motivoChk: check('flito_soat_masivo_filas_motivo_chk',
    sql`motivo_rechazo IS NULL OR motivo_rechazo IN ('placa_invalida','documento_invalido','nombre_invalido','correo_invalido','celular_invalido','vin_invalido','fila_duplicada')`),
  rechazoChk: check('flito_soat_masivo_filas_rechazo_chk', sql`(estado = 'rechazada') = (motivo_rechazo IS NOT NULL)`),
  piiChk: check('flito_soat_masivo_filas_pii_chk',
    sql`estado NOT IN ('pendiente','consultando') OR (placa IS NOT NULL AND documento IS NOT NULL) OR vin IS NOT NULL`),
}));
