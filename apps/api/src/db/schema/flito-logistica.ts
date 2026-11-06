// FLITO Logística (Fase 1): proveedores, actas, documentos, idempotencia y eventos. Se re-exporta desde `../schema.ts` (HU #13984).
import {
  pgTable, varchar, text, boolean, timestamp, integer, pgEnum, index, uniqueIndex, jsonb, numeric, uuid,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { vehicles } from './flota.js';
import { users, clients } from './nucleo.js';
import { organismosTransitoConfig, flitoTramites } from './tramites.js';

// ── FLITO Logística (Fase 1) ────────────────────────────────────────────────
// Trazabilidad del documento físico (LT/placa) del organismo al cliente. La unidad es el
// DOCUMENTO individual (RN-01); actas y rutas son agrupaciones sobre él. Los literales de estos
// enums coinciden con packages/shared-types/src/flito-logistica.ts (fuente única del dominio).
export const flitoLogisticaDocEstadoEnum = pgEnum('flito_logistica_doc_estado', ['generado', 'recogido', 'clasificado', 'en_acta', 'despachado', 'entregado', 'novedad', 'devuelto', 'en_flit']); // 'en_flit': 0275 (HU #14109)
export const flitoLogisticaActaEstadoEnum = pgEnum('flito_logistica_acta_estado', ['generada', 'despachada', 'entregada', 'devuelta']);
export const flitoLogisticaTipoDocEnum = pgEnum('flito_logistica_tipo_doc', ['licencia_transito', 'placa', 'otro']);

// Proveedor logístico: mensajería propia (PWA FLITO) o integración con tercero (FEATURE §6).
export const flitoProveedoresLogistica = pgTable('flito_proveedores_logistica', {
  id: uuid('id').primaryKey().defaultRandom(),
  nombre: varchar('nombre', { length: 150 }).notNull(),
  estrategia: varchar('estrategia', { length: 40 }).notNull().default('pwa_propia'),
  activo: boolean('activo').notNull().default(true),
  // HU #14103 (0278): nit (único parcial `uq_flito_proveedores_logistica_nit` en la migración; NULL en filas previas), contacto y teléfono, en la misma línea: el techo congelado de schema.ts no admite crecer.
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), nit: varchar('nit', { length: 20 }), contacto: varchar('contacto', { length: 150 }), telefono: varchar('telefono', { length: 30 }), deletedAt: timestamp('deleted_at', { withTimezone: true }), deletedBy: integer('deleted_by').references(() => users.id, { onDelete: 'restrict' }), // HU #14329 (0290). Nombre único entre vigentes: 0291.
}, (t) => ({ nombreVivoUq: uniqueIndex('uq_flito_proveedores_logistica_nombre_vivo').on(t.nombre).where(sql`deleted_at IS NULL`) }));

// Acta: agrupación por empresa para despacho/entrega (CA-04, una por empresa por lote). El acta
// firmada + evidencia (columnas de entrega) se pueblan en la Fase 2 (PWA); aquí quedan definidas.
// HU #14109 (ADR-0030 §17): UNA acta por compañía en los tres puntos (`compania_id` NOT NULL); `punto` y `firmante_id` (FK a
// `flito_logistica_recogida_firmantes`, solo SQL por el import circular; CHECK/único en la 0276). Las columnas viejas (`receptor_*`, `firma_*`) NO se borran hasta la HU de cifrado del histórico.
export const flitoLogisticaActas = pgTable('flito_logistica_actas', {
  id: uuid('id').primaryKey().defaultRandom(),
  companiaId: integer('compania_id').notNull().references(() => clients.id),
  firmanteId: uuid('firmante_id'), punto: varchar('punto', { length: 10 }).notNull().default('cliente'), organismoCodigo: varchar('organismo_codigo', { length: 5 }).references(() => organismosTransitoConfig.codigo), trasladoId: uuid('traslado_id'),
  estado: flitoLogisticaActaEstadoEnum('estado').notNull().default('generada'),
  mensajeroId: integer('mensajero_id').references(() => users.id),
  proveedorLogisticaId: uuid('proveedor_logistica_id').references(() => flitoProveedoresLogistica.id),
  // Snapshot de configuración de la compañía al cerrar el lote.
  permiteParcial: boolean('permite_parcial').notNull().default(false),
  direccionEntrega: varchar('direccion_entrega', { length: 300 }),
  contactoNombre: varchar('contacto_nombre', { length: 150 }), contactoDocumento: varchar('contacto_documento', { length: 30 }),
  // Artefacto y evidencia de la entrega (Fase 2: firma digital + evidencia estructurada, RN-03/9.5).
  pdfStorageKey: varchar('pdf_storage_key', { length: 400 }),
  // Firma de quien ENTREGA (Operaciones), capturada en la consola al despachar el acta.
  firmaEntregaStorageKey: varchar('firma_entrega_storage_key', { length: 400 }),
  entregaNombre: varchar('entrega_nombre', { length: 150 }),
  // Firma de quien RECIBE (receptor en la empresa), capturada en campo por el mensajero.
  firmaStorageKey: varchar('firma_storage_key', { length: 400 }),
  fotoStorageKey: varchar('foto_storage_key', { length: 400 }),
  receptorNombre: varchar('receptor_nombre', { length: 150 }), receptorDocumento: varchar('receptor_documento', { length: 30 }),
  entregadoLat: numeric('entregado_lat', { precision: 10, scale: 7 }), entregadoLng: numeric('entregado_lng', { precision: 10, scale: 7 }),
  entregadoEn: timestamp('entregado_en', { withTimezone: true }),
  motivoDevolucion: text('motivo_devolucion'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  companiaIdx: index('idx_flito_log_actas_compania').on(t.companiaId),
  estadoIdx: index('idx_flito_log_actas_estado').on(t.estado),
  mensajeroIdx: index('idx_flito_log_actas_mensajero').on(t.mensajeroId), trasladoIdx: index('idx_flito_log_actas_traslado').on(t.trasladoId), firmanteCompaniaUq: uniqueIndex('uq_flito_log_actas_firmante_compania').on(t.firmanteId, t.companiaId).where(sql`${t.punto} = 'organismo'`), firmanteCk: check('ck_flito_log_actas_firmante_punto', sql`${t.punto} <> 'organismo' OR ${t.firmanteId} IS NOT NULL`),
}));

// Documento físico individual (RN-01). Congela organismo (dónde se generó) y compañía (destino),
// para que sobreviva a cambios del trámite. Un mismo documento físico no se duplica: (tramite, tipo) único.
export const flitoLogisticaDocumentos = pgTable('flito_logistica_documentos', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** NULL = LT pendiente de trámite (ADR-0030 §17.2): CHECK `tramite_id IS NOT NULL OR compania_id IS NULL`; único parcial (vehiculo_id, tipo) en la 0276. */
  tramiteId: uuid('tramite_id').references(() => flitoTramites.id, { onDelete: 'cascade' }),
  tipo: flitoLogisticaTipoDocEnum('tipo').notNull(),
  estado: flitoLogisticaDocEstadoEnum('estado').notNull().default('generado'),
  // Congelados desde el trámite al generar el documento.
  organismoCodigo: varchar('organismo_codigo', { length: 5 }).notNull().references(() => organismosTransitoConfig.codigo),
  companiaId: integer('compania_id').references(() => clients.id),
  companiaNit: varchar('compania_nit', { length: 30 }),
  vehiculoId: integer('vehiculo_id').notNull().references(() => vehicles.id),
  // Código escaneable / serial del documento (barras/QR). Null hasta la Fase 2 (escaneo).
  identificador: varchar('identificador', { length: 120 }),
  // Datos leídos del PDF417 de la LT al escanear (fuente: código de barras del reverso).
  numeroLicencia: varchar('numero_licencia', { length: 40 }),
  // N.º de la LT: NO viaja en el código (impreso debajo); se captura manual ahora, OCR después.
  numeroLt: varchar('numero_lt', { length: 40 }),
  propietarioNombre: varchar('propietario_nombre', { length: 200 }),
  propietarioDocumento: varchar('propietario_documento', { length: 30 }),
  combustible: varchar('combustible', { length: 30 }),
  // Foto del propietario embebida en el código (JPEG), subida a storage.
  fotoStorageKey: varchar('foto_storage_key', { length: 400 }),
  actaId: uuid('acta_id').references(() => flitoLogisticaActas.id), recogidaFirmanteId: uuid('recogida_firmante_id'), proveedorLogisticaId: uuid('proveedor_logistica_id').references(() => flitoProveedoresLogistica.id, { onDelete: 'restrict' }), // ADR-0039 §6.3: dueño de la LT; NULL = solo Operaciones.
  /** INDICADOR (no bloqueo): true = falta el acta de organismo de la LT. Backfill 0276: false solo en las ya entregadas. */
  actaOrganismoPendiente: boolean('acta_organismo_pendiente').notNull().default(true),
  // Motivo de la última novedad/devolución (obligatorio en esos estados, RN-04).
  motivo: text('motivo'),
  flitRaw: jsonb('flit_raw'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // Un documento físico por (trámite, tipo): la sincronización repetida no duplica registros (RN-06).
  tramiteTipoUnico: uniqueIndex('uq_flito_log_doc_tramite_tipo').on(t.tramiteId, t.tipo),
  estadoIdx: index('idx_flito_log_doc_estado').on(t.estado),
  companiaIdx: index('idx_flito_log_doc_compania').on(t.companiaId),
  actaIdx: index('idx_flito_log_doc_acta').on(t.actaId), proveedorIdx: index('idx_flito_log_doc_proveedor').on(t.proveedorLogisticaId), numeroLicenciaIdx: index('idx_flito_log_doc_numero_licencia').on(t.numeroLicencia), tramiteCompaniaCk: check('ck_flito_log_doc_tramite_compania', sql`${t.tramiteId} IS NOT NULL OR ${t.companiaId} IS NULL`), pendienteUq: uniqueIndex('uq_flito_log_doc_vehiculo_pendiente').on(t.vehiculoId, t.tipo).where(sql`${t.tramiteId} IS NULL`),
}));

// Idempotencia de las escrituras de campo (RN-06/CA-06): la PWA del mensajero encola escrituras
// offline con una clave propia; un reenvío con la misma clave devuelve la respuesta ya guardada en
// vez de re-ejecutar, así una sincronización repetida no duplica recogidas/entregas.
export const flitoLogisticaIdempotencia = pgTable('flito_logistica_idempotencia', {
  idempotencyKey: text('idempotency_key').primaryKey(),
  status: integer('status').notNull(),
  response: jsonb('response').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Bitácora de transición por documento: sostiene CA-07 (actor, hora, ubicación de cada transición),
// RN-04 (motivo) y RN-07 (lat/lng solo en recogida/entrega). Más natural que un diff campo-a-campo.
export const flitoLogisticaEventos = pgTable('flito_logistica_documento_eventos', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentoId: uuid('documento_id').notNull().references(() => flitoLogisticaDocumentos.id, { onDelete: 'cascade' }),
  estadoAnterior: varchar('estado_anterior', { length: 20 }),
  estadoNuevo: varchar('estado_nuevo', { length: 20 }).notNull(),
  actorId: integer('actor_id').references(() => users.id),
  lat: numeric('lat', { precision: 10, scale: 7 }), lng: numeric('lng', { precision: 10, scale: 7 }),
  motivo: text('motivo'),
  origen: varchar('origen', { length: 10 }).notNull(),
  // HU #14109: eventos de traslado/acta (payload solo ids/códigos, NUNCA PII). Nullable: los viejos no los tienen.
  tipo: varchar('tipo', { length: 30 }), trasladoId: uuid('traslado_id'), actaId: uuid('acta_id'), destino: varchar('destino', { length: 10 }), payload: jsonb('payload'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  documentoIdx: index('idx_flito_log_eventos_documento').on(t.documentoId, t.createdAt),
}));
