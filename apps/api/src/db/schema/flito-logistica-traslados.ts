// HU #14109 (Feature #14091, Épica #13758, ADR-0030) — Traslados, actas por punto y firmas de Logística.
// Vive aparte de `schema.ts` por el techo de max-lines (3291, congelado); `schema.ts` lo re-exporta.
//
// Las columnas nuevas de `flito_logistica_actas`, `…_documentos` y `…_documento_eventos` están en
// `schema.ts` (son extensiones de tablas existentes). Aquí viven las 6 tablas nuevas (5 + el firmante del organismo, §17).
//
// Lo que Drizzle no declara bien (índices únicos parciales, UNIQUE sobre lower(nombre), FK compuesta
// de la línea de LT al traslado) está en la migración 0275 y se documenta junto a cada tabla.
// CHECKs declarados AQUÍ y en la 0275 (lección 0157: un CHECK que solo vive en la base sorprende al
// primer INSERT nuevo con 23514).
//
// PII (Ley 1581): la cédula del firmante NUNCA va en claro aquí: `documento_cifrado` (cifrado de campo)
// + `documento_ultimos` (4 últimos dígitos, para enmascarar sin descifrar). El acta de FLIT la firma
// Operaciones (usuario) y su firma no lleva cédula. El histórico (`receptor_documento` en claro en la
// acta vieja) lo cifra la HU #14112; esta HU solo define el modelo.
//
// Import circular a propósito (mismo patrón que `schema/flito-logistica-viajes.ts`).
import {
  pgTable, uuid, varchar, text, numeric, integer, boolean, timestamp, index, uniqueIndex, primaryKey,
  foreignKey, check, unique,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  clients, users, organismosTransitoConfig, flitoLogisticaActas, flitoLogisticaDocumentos, flitoTarifasVigencias,
} from '../schema.js';

/** Catálogo de motivos por los que una LT llega a FLIT. Único por `lower(nombre)` (índice SQL). */
export const flitoLogisticaMotivosLlegada = pgTable('flito_logistica_motivos_llegada', {
  id: uuid('id').primaryKey().defaultRandom(),
  nombre: varchar('nombre', { length: 120 }).notNull(),
  activo: boolean('activo').notNull().default(true),
  orden: integer('orden').notNull().default(0),
  creadoPorId: integer('creado_por_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // uq_flito_log_motivos_llegada_nombre: UNIQUE sobre lower(nombre), solo en SQL (0275).
  ordenIdx: index('idx_flito_log_motivos_llegada_orden').on(t.activo, t.orden),
}));

/** Un viaje (organismo→FLIT, organismo→cliente o FLIT→cliente) de LT de UNA compañía. */
export const flitoLogisticaTraslados = pgTable('flito_logistica_traslados', {
  id: uuid('id').primaryKey().defaultRandom(),
  companiaId: integer('compania_id').notNull().references(() => clients.id, { onDelete: 'restrict' }),
  destino: varchar('destino', { length: 10 }).notNull(),
  origen: varchar('origen', { length: 10 }).notNull(),
  estado: varchar('estado', { length: 12 }).notNull().default('registrado'),
  mensajeroId: integer('mensajero_id').references(() => users.id),
  registradoPorId: integer('registrado_por_id').references(() => users.id),
  registradoEn: timestamp('registrado_en', { withTimezone: true }).notNull().defaultNow(),
  /** true = backfill de actas previas a esta HU (sin precio retroactivo). */
  legado: boolean('legado').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  companiaIdx: index('idx_flito_log_traslados_compania').on(t.companiaId, t.estado),
  mensajeroIdx: index('idx_flito_log_traslados_mensajero').on(t.mensajeroId),
  // Soporta la FK compuesta de las líneas (traslado_id, destino).
  idDestinoUq: uniqueIndex('uq_flito_log_traslados_id_destino').on(t.id, t.destino),
  destinoCk: check('ck_flito_log_traslados_destino', sql`${t.destino} IN ('flit','cliente')`),
  origenCk: check('ck_flito_log_traslados_origen', sql`${t.origen} IN ('organismo','flit')`),
  estadoCk: check('ck_flito_log_traslados_estado', sql`${t.estado} IN ('registrado','en_ruta','entregado','devuelto','anulado')`),
  // destino='flit' => origen='organismo' (nada vuelve de FLIT a FLIT).
  rutaCk: check('ck_flito_log_traslados_ruta', sql`${t.destino} <> 'flit' OR ${t.origen} = 'organismo'`),
}));

/** Línea por LT dentro de un traslado, con el precio CONGELADO al registrar. */
export const flitoLogisticaTrasladoLts = pgTable('flito_logistica_traslado_lts', {
  id: uuid('id').primaryKey().defaultRandom(),
  trasladoId: uuid('traslado_id').notNull(),
  /** Denormalizado del traslado: lo exige la FK compuesta (traslado_id, destino). */
  destino: varchar('destino', { length: 10 }).notNull(),
  documentoId: uuid('documento_id').notNull().references(() => flitoLogisticaDocumentos.id, { onDelete: 'restrict' }),
  estado: varchar('estado', { length: 12 }).notNull().default('registrado'),
  /** 'logistica_cliente' | 'logistica_flit' | 'legado'. */
  conceptoPrecio: varchar('concepto_precio', { length: 20 }),
  /** NULL solo si `concepto_precio = 'legado'`. Nunca se borra: es el historial de lo cobrado. */
  precio: numeric('precio', { precision: 14, scale: 2 }),
  tarifaVigenciaId: uuid('tarifa_vigencia_id').references(() => flitoTarifasVigencias.id, { onDelete: 'restrict' }),
  /** Obligatorio si destino='flit' (CHECK). */
  motivoLlegadaId: uuid('motivo_llegada_id').references(() => flitoLogisticaMotivosLlegada.id, { onDelete: 'restrict' }),
  motivoNota: varchar('motivo_nota', { length: 300 }),
  motivoPorId: integer('motivo_por_id').references(() => users.id),
  motivoEn: timestamp('motivo_en', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  trasladoFk: foreignKey({
    columns: [t.trasladoId, t.destino],
    foreignColumns: [flitoLogisticaTraslados.id, flitoLogisticaTraslados.destino],
    name: 'fk_flito_log_traslado_lts_traslado_destino',
  }),
  // Una LT, un viaje VIVO por destino (red de la BD ante carreras). Excluye devuelto/anulado.
  vivoUq: uniqueIndex('uq_flito_log_traslado_lt_vivo').on(t.documentoId, t.destino)
    .where(sql`${t.estado} NOT IN ('devuelto','anulado')`),
  trasladoIdx: index('idx_flito_log_traslado_lts_traslado').on(t.trasladoId),
  motivoIdx: index('idx_flito_log_traslado_lts_motivo').on(t.motivoLlegadaId),
  destinoCk: check('ck_flito_log_traslado_lts_destino', sql`${t.destino} IN ('flit','cliente')`),
  estadoCk: check('ck_flito_log_traslado_lts_estado', sql`${t.estado} IN ('registrado','en_ruta','entregado','devuelto','anulado')`),
  precioCk: check('ck_flito_log_traslado_lts_precio', sql`${t.precio} IS NULL OR ${t.precio} >= 0`),
  precioLegadoCk: check('ck_flito_log_traslado_lts_precio_legado', sql`${t.precio} IS NOT NULL OR ${t.conceptoPrecio} = 'legado'`),
  motivoCk: check('ck_flito_log_traslado_lts_motivo', sql`${t.destino} <> 'flit' OR ${t.motivoLlegadaId} IS NOT NULL`),
}));

/** LT incluida en un acta, por punto. Una acta es de UNA compañía (§17); `compania_id` de la línea = el de la acta. */
export const flitoLogisticaActaLineas = pgTable('flito_logistica_acta_lineas', {
  actaId: uuid('acta_id').notNull().references(() => flitoLogisticaActas.id, { onDelete: 'cascade' }),
  documentoId: uuid('documento_id').notNull().references(() => flitoLogisticaDocumentos.id, { onDelete: 'restrict' }),
  /** 'organismo' | 'flit' | 'cliente' (denormalizado de actas.punto). */
  punto: varchar('punto', { length: 10 }).notNull(),
  trasladoLtId: uuid('traslado_lt_id').references(() => flitoLogisticaTrasladoLts.id),
  companiaId: integer('compania_id').references(() => clients.id),
}, (t) => ({
  pk: primaryKey({ columns: [t.actaId, t.documentoId] }),
  // Una LT, una acta de organismo; una línea de traslado, una acta.
  organismoUq: uniqueIndex('uq_flito_log_acta_linea_organismo').on(t.documentoId).where(sql`${t.punto} = 'organismo'`),
  trasladoLtUq: uniqueIndex('uq_flito_log_acta_linea_traslado_lt').on(t.trasladoLtId).where(sql`${t.trasladoLtId} IS NOT NULL`),
  documentoIdx: index('idx_flito_log_acta_lineas_documento').on(t.documentoId),
  puntoCk: check('ck_flito_log_acta_lineas_punto', sql`${t.punto} IN ('organismo','flit','cliente')`),
}));

/** Firma de un acta: una `entrega` y una `recibe` como máximo. */
export const flitoLogisticaActaFirmas = pgTable('flito_logistica_acta_firmas', {
  id: uuid('id').primaryKey().defaultRandom(),
  actaId: uuid('acta_id').notNull().references(() => flitoLogisticaActas.id, { onDelete: 'cascade' }),
  /** 'entrega' | 'recibe'. */
  rol: varchar('rol', { length: 10 }).notNull(),
  nombre: varchar('nombre', { length: 150 }).notNull(),
  /** PII: cifrada en reposo. NULL en acta FLIT (sin cédula), en el histórico aún sin cifrar y tras la purga a 10 años. */
  documentoCifrado: text('documento_cifrado'),
  /** Últimos 4 dígitos, para enmascarar sin descifrar. */
  documentoUltimos: varchar('documento_ultimos', { length: 4 }),
  firmaStorageKey: varchar('firma_storage_key', { length: 400 }).notNull(),
  /** NULL = persona sin sesión (organismo, cliente). El acta de FLIT la firma Operaciones: usuario_id NOT NULL. */
  usuarioId: integer('usuario_id').references(() => users.id),
  firmadoEn: timestamp('firmado_en', { withTimezone: true }).notNull().defaultNow(),
  lat: numeric('lat', { precision: 10, scale: 7 }),
  lng: numeric('lng', { precision: 10, scale: 7 }),
}, (t) => ({
  actaRolUq: unique('uq_flito_log_acta_firmas_acta_rol').on(t.actaId, t.rol),
  rolCk: check('ck_flito_log_acta_firmas_rol', sql`${t.rol} IN ('entrega','recibe')`),
  ultimosCk: check('ck_flito_log_acta_firmas_ultimos', sql`${t.documentoUltimos} IS NULL OR char_length(${t.documentoUltimos}) <= 4`),
}));

/**
 * Firmante del organismo (ADR-0030 §17.1): UNA firma por recogida, referenciada por las actas de organismo de
 * cada compañía (`actas.firmante_id`) y por las LT firmadas (`documentos.recogida_firmante_id`, también las
 * pendientes de trámite). `id` lo genera la app (sin default): es la AAD del cifrado de la cédula
 * (`protegerDocumento`, ver C1.3), así que se necesita ANTES del INSERT. Una sola copia de PII para purga/reveal.
 */
export const flitoLogisticaRecogidaFirmantes = pgTable('flito_logistica_recogida_firmantes', {
  id: uuid('id').primaryKey(),
  organismoCodigo: varchar('organismo_codigo', { length: 5 }).notNull().references(() => organismosTransitoConfig.codigo),
  nombre: varchar('nombre', { length: 150 }).notNull(),
  /** PII cifrada en reposo. NULL tras la purga a 10 años (solo la cédula; nombre y firma se conservan). */
  documentoCifrado: text('documento_cifrado'),
  documentoUltimos: varchar('documento_ultimos', { length: 4 }),
  firmaStorageKey: varchar('firma_storage_key', { length: 400 }).notNull(),
  /** Mensajero/operador que capturó la firma. */
  registradoPorId: integer('registrado_por_id').notNull().references(() => users.id),
  firmadoEn: timestamp('firmado_en', { withTimezone: true }).notNull().defaultNow(),
  lat: numeric('lat', { precision: 10, scale: 7 }),
  lng: numeric('lng', { precision: 10, scale: 7 }),
}, (t) => ({
  registradoIdx: index('idx_flito_log_recogida_firmantes_registrado').on(t.registradoPorId, t.firmadoEn),
  organismoIdx: index('idx_flito_log_recogida_firmantes_organismo').on(t.organismoCodigo),
  ultimosCk: check('ck_flito_log_recogida_firmantes_ultimos', sql`${t.documentoUltimos} IS NULL OR char_length(${t.documentoUltimos}) <= 4`),
}));
