// HU #12996 (Feature #12841, ADR-0019 opción A) — tabla de espera del canal Cliente, migración 0210.
// Vive aparte de `schema.ts` por el techo de max-lines (3400), como `schema/flito-comprobantes.ts`.
// `schema.ts` la re-exporta.
//
// Import circular a propósito (mismo patrón que `schema/permisos.ts`): las FK de Drizzle son callbacks
// perezosos, así que el ciclo ESM resuelve sin problema.
import {
  pgTable, uuid, varchar, text, integer, smallint, timestamp, index, uniqueIndex, check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { clients, flitoSoat, users } from '../schema.js';

/**
 * Solicitudes del canal Cliente APARCADAS porque el RUNT no respondió (Feature #12841, HU #12996,
 * ADR-0019 opción A, migración 0210).
 *
 * **No es un SOAT.** Vive fuera de `flito_soat` a propósito: ningún lector de la cola, del Excel,
 * del ZIP, del envío al gestor ni del cron de vigencia la ve, y eso es estructural (CF-02). Solo se
 * convierte en SOAT cuando un reintento obtiene respuesta favorable del RUNT, y entonces el SOAT
 * nace con `id = soat_id_reservado` (la clave de la factura en S3 ya se nombró con él).
 *
 * La incompleta ABIERTA ocupa el VIN (índice único parcial); la descartada no (P-5 del UX).
 * El propietario vive en `flito_compradores.soat_incompleta_id`, con el mismo tratamiento que el de
 * un alta normal. Los CHECK se declaran también aquí por la lección de la 0157.
 */
export const flitoSoatIncompletas = pgTable('flito_soat_incompletas', {
  id: uuid('id').primaryKey().defaultRandom(),
  soatIdReservado: uuid('soat_id_reservado').notNull().unique(),
  soatId: uuid('soat_id').references(() => flitoSoat.id),
  companiaId: integer('compania_id').notNull().references(() => clients.id),
  vin: varchar('vin', { length: 17 }).notNull(),
  estado: varchar('estado', { length: 12 }).notNull().default('incompleta'),
  facturaStorageKey: text('factura_storage_key').notNull(),
  facturaHash: varchar('factura_hash', { length: 64 }).notNull(),
  facturaNombreArchivo: varchar('factura_nombre_archivo', { length: 255 }).notNull(),
  facturaContentType: varchar('factura_content_type', { length: 100 }).notNull(),
  facturaTamanoBytes: integer('factura_tamano_bytes').notNull(),
  solicitadoPorId: integer('solicitado_por_id').references(() => users.id),
  solicitadoPorNombre: varchar('solicitado_por_nombre', { length: 150 }).notNull(),
  solicitadoEn: timestamp('solicitado_en', { withTimezone: true }).notNull().defaultNow(),
  intentos: smallint('intentos').notNull().default(1),
  ultimoIntentoEn: timestamp('ultimo_intento_en', { withTimezone: true }).notNull().defaultNow(),
  ultimoIntentoPorId: integer('ultimo_intento_por_id').references(() => users.id),
  /** Vocabulario de `causaDeCaida` del RUNT: timeout | red | circuito | otro. */
  ultimaCausaCaida: varchar('ultima_causa_caida', { length: 10 }),
  resueltaPorId: integer('resuelta_por_id').references(() => users.id),
  resueltaPorNombre: varchar('resuelta_por_nombre', { length: 150 }),
  resueltaEn: timestamp('resuelta_en', { withTimezone: true }),
  motivoDescarte: varchar('motivo_descarte', { length: 40 }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  vinAbiertaUq: uniqueIndex('uq_flito_soat_incompletas_vin_abierta').on(t.vin)
    .where(sql`${t.estado} = 'incompleta'`),
  companiaEstadoIdx: index('idx_flito_soat_incompletas_compania_estado').on(t.companiaId, t.estado),
  estadoChk: check('flito_soat_incompletas_estado_chk',
    sql`${t.estado} IN ('incompleta', 'completada', 'descartada')`),
  motivoChk: check('flito_soat_incompletas_motivo_chk',
    sql`${t.motivoDescarte} IS NULL OR ${t.motivoDescarte} IN ('soat_vigente', 'runt_no_cuadra', 'runt_sin_registro', 'runt_sin_vin', 'solicitud_existente')`),
  causaChk: check('flito_soat_incompletas_causa_chk',
    sql`${t.ultimaCausaCaida} IS NULL OR ${t.ultimaCausaCaida} IN ('timeout', 'red', 'circuito', 'otro')`),
  intentosChk: check('flito_soat_incompletas_intentos_chk', sql`${t.intentos} >= 1`),
  descarteChk: check('flito_soat_incompletas_descarte_chk',
    sql`(${t.estado} = 'descartada') = (${t.motivoDescarte} IS NOT NULL AND ${t.resueltaEn} IS NOT NULL AND ${t.resueltaPorNombre} IS NOT NULL)`),
  completadaChk: check('flito_soat_incompletas_completada_chk',
    sql`(${t.estado} = 'completada') = (${t.soatId} IS NOT NULL AND ${t.soatId} = ${t.soatIdReservado} AND ${t.resueltaEn} IS NOT NULL)`),
}));
