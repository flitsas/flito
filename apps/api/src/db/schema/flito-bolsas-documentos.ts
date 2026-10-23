// HU #13889 (Feature #13888, Épica #13407) — expediente documental de la COMPAÑÍA, migración 0248.
// ADR-0028 §7. Archivo propio (frontera con flito-df, Épica #13412): `schema.ts` solo lo re-exporta y
// el bloque de bolsas de `schema.ts` no se toca. Los CHECK se declaran aquí también (lección de la 0157).
//
// Una fila por VERSIÓN (D1). La vigente la marca `vigente = true`, con un índice único parcial
// `(compania_id, tipo) WHERE vigente`. La tabla nace completa —incluidas las columnas de OCR (#13890) y
// de purga (#13891)— para no tener que editar después una migración ya aplicada (D11).
//
// Import circular a propósito, igual que `schema/permisos.ts`: las FK de Drizzle son callbacks
// perezosos, así que el ciclo ESM con `../schema.js` resuelve sin problema.
import {
  pgTable, uuid, integer, smallint, varchar, text, boolean, date, timestamp, customType,
  index, uniqueIndex, check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { clients, users } from '../schema.js';

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

export const flitoBolsasDocumentos = pgTable('flito_bolsas_documentos', {
  /** Generado ANTES del INSERT: forma parte de la AAD del cifrado (D5). */
  id: uuid('id').primaryKey(),
  companiaId: integer('compania_id').notNull().references(() => clients.id, { onDelete: 'restrict' }),
  /** camara_comercio | rut | cedula_representante | certificado_bancario | adicional */
  tipo: varchar('tipo', { length: 30 }).notNull(),
  /** Correlativa por (compania_id, tipo), desde 1. */
  version: smallint('version').notNull(),
  vigente: boolean('vigente').notNull(),
  // Archivo cifrado con AES-256-GCM (D5). `storage_key` NULL ⇔ purgado (#13891).
  storageKey: text('storage_key'),
  mime: varchar('mime', { length: 30 }).notNull(),
  tamanoBytes: integer('tamano_bytes').notNull(),
  cifradoIv: bytea('cifrado_iv').notNull(),
  cifradoTag: bytea('cifrado_tag').notNull(),
  cifradoKeyVersion: smallint('cifrado_key_version').notNull(),
  aadNonce: uuid('aad_nonce').notNull(),
  // Vigencia (D2): se guarda la fecha y su origen, nunca el estado (se calcula al leer).
  fechaExpedicion: date('fecha_expedicion'),
  /** 'ocr' | 'manual' */
  fechaOrigen: varchar('fecha_origen', { length: 10 }),
  fechaManualPor: integer('fecha_manual_por').references(() => users.id, { onDelete: 'set null' }),
  fechaManualEn: timestamp('fecha_manual_en', { withTimezone: true }),
  /** no_aplica | validando | leido | sin_fecha | fallido */
  ocrEstado: varchar('ocr_estado', { length: 12 }).notNull(),
  ocrIntentos: smallint('ocr_intentos').notNull().default(0),
  ocrActualizadoEn: timestamp('ocr_actualizado_en', { withTimezone: true }).notNull().defaultNow(),
  // Trazabilidad
  cargadoPor: integer('cargado_por').references(() => users.id, { onDelete: 'set null' }),
  cargadoEn: timestamp('cargado_en', { withTimezone: true }).notNull().defaultNow(),
  reemplazadoEn: timestamp('reemplazado_en', { withTimezone: true }),
  purgadoEn: timestamp('purgado_en', { withTimezone: true }),
}, (t) => ({
  vigenteUq: uniqueIndex('uq_flito_bolsas_documentos_vigente').on(t.companiaId, t.tipo).where(sql`${t.vigente}`),
  versionUq: uniqueIndex('uq_flito_bolsas_documentos_version').on(t.companiaId, t.tipo, t.version),
  purgaIdx: index('idx_flito_bolsas_documentos_purga').on(t.reemplazadoEn)
    .where(sql`NOT ${t.vigente} AND ${t.purgadoEn} IS NULL`),
  ocrIdx: index('idx_flito_bolsas_documentos_ocr').on(t.ocrActualizadoEn).where(sql`${t.ocrEstado} = 'validando'`),
  tipoChk: check('ck_flito_bolsas_documentos_tipo',
    sql`${t.tipo} IN ('camara_comercio','rut','cedula_representante','certificado_bancario','adicional')`),
  mimeChk: check('ck_flito_bolsas_documentos_mime', sql`${t.mime} IN ('application/pdf','image/jpeg','image/png')`),
  tamanoChk: check('ck_flito_bolsas_documentos_tamano', sql`${t.tamanoBytes} > 0 AND ${t.tamanoBytes} <= 15728640`),
  versionChk: check('ck_flito_bolsas_documentos_version', sql`${t.version} >= 1`),
  origenChk: check('ck_flito_bolsas_documentos_origen',
    sql`(${t.fechaOrigen} IS NULL) = (${t.fechaExpedicion} IS NULL) AND (${t.fechaOrigen} IS NULL OR ${t.fechaOrigen} IN ('ocr','manual'))`),
  manualChk: check('ck_flito_bolsas_documentos_manual', sql`(${t.fechaOrigen} = 'manual') = (${t.fechaManualEn} IS NOT NULL)`),
  ocrChk: check('ck_flito_bolsas_documentos_ocr',
    sql`${t.ocrEstado} IN ('no_aplica','validando','leido','sin_fecha','fallido')`),
  ocrTipoChk: check('ck_flito_bolsas_documentos_ocr_tipo',
    sql`(${t.tipo} IN ('cedula_representante','adicional')) = (${t.ocrEstado} = 'no_aplica')`),
  vigenciaChk: check('ck_flito_bolsas_documentos_vigencia', sql`${t.vigente} = (${t.reemplazadoEn} IS NULL)`),
  purgaChk: check('ck_flito_bolsas_documentos_purga',
    sql`(${t.purgadoEn} IS NULL) = (${t.storageKey} IS NOT NULL) AND (${t.purgadoEn} IS NULL OR NOT ${t.vigente})`),
}));
