// Trámites: `tramites_*` legacy y `flito_tramites` más su organismo y vigencias. Se re-exporta desde `../schema.ts` (HU #13982).
import {
  pgTable, serial, varchar, text, boolean, timestamp, integer, bigint, pgEnum, index, uniqueIndex, jsonb,
  numeric, bigserial, uuid, primaryKey, check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
// Fuente del trámite (HU #13070): los valores del CHECK de la 0213.
import type { FuenteTramite } from '@operaciones/shared-types';
import { users, clients, vehicles } from '../schema.js';
import { flitoModalidadEnum } from './_comunes.js';
import { flitoSoat } from './soat.js';

export const tramiteEstadoEnum = pgEnum('tramite_estado', [
  'borrador', 'radicado', 'en_validacion', 'documentos', 'identidad', 'aprobado', 'rechazado', 'enviado_transito',
  'recibido_transito', 'placa_preasignada', 'solicitud_soat',
  'soat_comprado', 'soat_verificado', 'completado',
  // TRAM-TRASPASO-F1 (mig 0092): estados STT del traspaso.
  'subsanacion', 'en_tramite', 'entregado', 'anulado',
]);

export const tramitesDigitales = pgTable('tramites_digitales', {
  id: serial('id').primaryKey(),
  tipo: varchar('tipo', { length: 10 }).notNull().default('B01'),
  estado: tramiteEstadoEnum('estado').notNull().default('borrador'),
  paso: integer('paso').notNull().default(1),
  // TRAM-TRASPASO-F1 (mig 0092): modalidad de entrada (matricula_inicial | traspaso),
  // radicado STT TD-YYYY-NNNNN y bitácora workflow (append-only de transiciones STT).
  modalidadEntrada: varchar('modalidad_entrada', { length: 20 }).notNull().default('matricula_inicial'),
  numeroRadicado: varchar('numero_radicado', { length: 20 }),
  workflow: jsonb('workflow').notNull().default(sql`'[]'::jsonb`),
  // TRAM-INNOV A5: tipología del trámite (traspaso_standard | sucesion | remate |
  // flota_corporativa). Nullable — los trámites previos / matrícula inicial siguen
  // sin tipología y NO activan el gate de checklist (retrocompat). Catálogo en
  // `@operaciones/shared-types` (TRAMITE_TIPOLOGIAS).
  tipologiaCodigo: varchar('tipologia_codigo', { length: 40 }),
  // Overrides manuales del checklist: { [itemId]: true }. Los ítems con `docTipo`
  // se auto-marcan al subir el documento (no se persisten aquí).
  checklistEstado: jsonb('checklist_estado'),
  // TRAM-INNOV A2: token de verificación pública (QR), opaco + TTL, revocable.
  verifyToken: varchar('verify_token', { length: 64 }),
  verifyTokenExpires: timestamp('verify_token_expires', { withTimezone: true }),
  vin: varchar('vin', { length: 17 }),
  placa: varchar('placa', { length: 10 }),
  vehiculo: jsonb('vehiculo'),
  comprador: jsonb('comprador'),
  documentos: jsonb('documentos'),
  validacionIdentidad: jsonb('validacion_identidad'),
  furGenerado: boolean('fur_generado').notNull().default(false),
  furError: text('fur_error'),                                        // TRAM-10: último error de generación FUR (CEA)
  furErrorAt: timestamp('fur_error_at', { withTimezone: true }),
  notas: text('notas'),
  // TRAM-OPS-02: último motivo de rechazo OT (denormalizado; evento es source of truth).
  motivoRechazoCodigo: varchar('motivo_rechazo_codigo', { length: 40 }),
  // TRAM-MT-01: organismo destino al enviar a tránsito (scope de bandeja).
  organismoCodigo: varchar('organismo_codigo', { length: 5 }),
  creadoPor: integer('creado_por').notNull().references(() => users.id),
  recibidoPor: integer('recibido_por').references(() => users.id),
  recibidoAt: timestamp('recibido_at', { withTimezone: true }),
  placaAsignadaAt: timestamp('placa_asignada_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  estadoIdx: index('idx_tramites_estado').on(t.estado),
  estadoOrganismoIdx: index('idx_tramites_estado_organismo').on(t.estado, t.organismoCodigo),
  vinIdx: index('idx_tramites_vin').on(t.vin),
  creadoPorIdx: index('idx_tramites_creado_por').on(t.creadoPor),
  // Índice parcial único real: migration 0085 (idx_tramites_vin_matricula_activa).
}));

// TRAM-MT-02: branding/config FLIT por código DIVIPOLA (catálogo en shared-types).
export const organismosTransitoConfig = pgTable('organismos_transito_config', {
  codigo: varchar('codigo', { length: 5 }).primaryKey(),
  alias: varchar('alias', { length: 120 }),
  logoUrl: text('logo_url'),
  // TRAM-MT-02 Fase 2b (mig 0089): logo subido a MinIO (prioridad sobre logo_url).
  logoStorageKey: varchar('logo_storage_key', { length: 500 }),
  activo: boolean('activo').notNull().default(true),
  // FLITO (migración): umbral OCR y SLA sobrescribibles por organismo (§6.2 Impuestos).
  // La MODALIDAD de gestión NO vive aquí: vive en flitoOrganismoVigencias (CA-04, sin
  // sobrescritura destructiva). La ausencia de vigencia = SIN_CLASIFICAR (RN-01 Imp).
  flitoUmbralOcr: numeric('flito_umbral_ocr', { precision: 4, scale: 3 }),
  flitoSlaHoras: integer('flito_sla_horas'),
  // FLITO Fase 7 (D-5 / CA-09): activa la marca de diferencia de valor de impuestos en la
  // conciliación de recibos para este organismo. Apagada por defecto (fuente de valorLiquidado
  // no fiable en general); se enciende donde la consulta oficial sí lo es. No bloquea el pago.
  flitoDiferenciaValorActiva: boolean('flito_diferencia_valor_activa').notNull().default(false),
  // HU #10950: pista opcional que se concatena al prompt genérico de derechos de tránsito. Existe
  // porque cada organismo emite el recibo en un formato distinto: en vez de un extractor por
  // organismo, una línea de configuración desambigua las etiquetas raras ("VALOR NETO A PAGAR").
  flitoOcrPromptHint: text('flito_ocr_prompt_hint'),
  // HU #10952: carpeta de Drive donde el organismo publica sus recibos de derecho de trámite.
  // Es por organismo y no una sola global porque cada secretaría publica en su propio Drive.
  flitoDriveFolderId: varchar('flito_drive_folder_id', { length: 120 }),
  flitoDriveActivo: boolean('flito_drive_activo').notNull().default(false),
  /**
   * OBSOLETA desde el ajuste 0124: SIN LECTORES ni escritores.
   *
   * Marcaba si el organismo operaba con saldo prepago de FLIT, cuando una bolsa era una secretaría.
   * Ahora cualquier secretaría puede entrar en una bolsa y quien lo decide es
   * `flitoBolsasUnicasCobertura`. La columna se conserva —mismo criterio que con
   * `flito_reglas_proveedor_soat`: borrar datos en el cambio que retira su último lector es
   * innecesariamente irreversible— y su DROP irá en una migración posterior.
   */
  flitoLlevaBolsa: boolean('flito_lleva_bolsa').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// TRAM-MT-02 F2: checklist efectivo organismo × tipología.
export const organismoChecklistOverrides = pgTable('organismo_checklist_overrides', {
  organismoCodigo: varchar('organismo_codigo', { length: 5 }).notNull(),
  tipologiaCodigo: varchar('tipologia_codigo', { length: 40 }).notNull(),
  itemsJson: jsonb('items_json').notNull().default({ hide: [], require: [], add: [] }),
  version: integer('version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.organismoCodigo, t.tipologiaCodigo] }),
}));

export const tramitesDocumentos = pgTable('tramites_documentos', {
  id: serial('id').primaryKey(),
  tramiteId: integer('tramite_id').notNull().references(() => tramitesDigitales.id, { onDelete: 'cascade' }),
  tipo: varchar('tipo', { length: 30 }).notNull(),
  filename: varchar('filename', { length: 300 }).notNull(),
  originalName: varchar('original_name', { length: 300 }),
  mimetype: varchar('mimetype', { length: 100 }),
  size: integer('size'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tramiteIdIdx: index('idx_tramite_docs_tramite_id').on(t.tramiteId),
}));

export const tramitesValidaciones = pgTable('tramites_validaciones', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tramiteId: integer('tramite_id').notNull().references(() => tramitesDigitales.id, { onDelete: 'cascade' }),
  token: varchar('token', { length: 64 }).notNull().unique(),
  nombre: varchar('nombre', { length: 200 }),
  tipoDoc: varchar('tipo_doc', { length: 10 }),
  documento: varchar('documento', { length: 20 }),
  email: varchar('email', { length: 150 }),
  placa: varchar('placa', { length: 10 }),
  vehiculoInfo: varchar('vehiculo_info', { length: 200 }),
  estado: varchar('estado', { length: 20 }).notNull().default('enviado'),
  // TRAM-F3: parte del traspaso (vendedor|comprador) + sello de firma al aprobar.
  parte: varchar('parte', { length: 20 }),
  firmaSerie: varchar('firma_serie', { length: 60 }),
  firmaHash: varchar('firma_hash', { length: 64 }),
  firmaTimestamp: timestamp('firma_timestamp', { withTimezone: true }),
  score: integer('score'),
  detalle: jsonb('detalle'),
  intentos: integer('intentos').notNull().default(0),
  ipAddress: varchar('ip_address', { length: 45 }),
  fotoRostro: text('foto_rostro'),
  fotoCedulaFrontal: text('foto_cedula_frontal'),
  fotoCedulaReverso: text('foto_cedula_reverso'),
  ciudadGeo: varchar('ciudad_geo', { length: 200 }),
  lat: varchar('lat', { length: 15 }),
  lng: varchar('lng', { length: 15 }),
  userAgent: varchar('user_agent', { length: 500 }),
  enviadoAt: timestamp('enviado_at', { withTimezone: true }),
  procesandoDesde: timestamp('procesando_desde', { withTimezone: true }),
  validadoAt: timestamp('validado_at', { withTimezone: true }),
  expiraAt: timestamp('expira_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tokenIdx: index('idx_tramites_val_token').on(t.token),
  tramiteIdIdx: index('idx_tramites_val_tramite_id').on(t.tramiteId),
}));

// TRAM-INNOV A3 — participantes externos del trámite (portal magic link).
export const tramiteParticipantes = pgTable('tramite_participantes', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tramiteId: integer('tramite_id').notNull().references(() => tramitesDigitales.id, { onDelete: 'cascade' }),
  rol: varchar('rol', { length: 20 }).notNull(),
  nombre: varchar('nombre', { length: 200 }),
  email: varchar('email', { length: 150 }),
  telefono: varchar('telefono', { length: 30 }),
  tokenHash: varchar('token_hash', { length: 64 }).notNull(),
  whatsappOptIn: boolean('whatsapp_opt_in').notNull().default(false),
  consent1581At: timestamp('consent_1581_at', { withTimezone: true }),
  consentVersion: varchar('consent_version', { length: 20 }),
  consentIp: varchar('consent_ip', { length: 45 }),
  consentUserAgent: varchar('consent_user_agent', { length: 300 }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  // TRAM-COMMS-02 (mig 0084): cooldown de recordatorios (máx 1 cada 24h).
  lastReminderAt: timestamp('last_reminder_at', { withTimezone: true }),
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tokenIdx: uniqueIndex('idx_tramite_part_token').on(t.tokenHash),
  tramiteIdx: index('idx_tramite_part_tramite').on(t.tramiteId),
}));

// TRAM-INNOV-B3 (mig 0090) — firma electrónica del contrato de compraventa.
export const tramiteFirmas = pgTable('tramite_firmas', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tramiteId: integer('tramite_id').notNull().references(() => tramitesDigitales.id, { onDelete: 'cascade' }),
  participanteId: bigint('participante_id', { mode: 'number' }).references(() => tramiteParticipantes.id, { onDelete: 'set null' }),
  rol: varchar('rol', { length: 20 }).notNull(),
  docTipo: varchar('doc_tipo', { length: 40 }).notNull().default('compraventa'),
  proveedor: varchar('proveedor', { length: 30 }).notNull(),
  envelopeId: varchar('envelope_id', { length: 120 }),
  estado: varchar('estado', { length: 20 }).notNull().default('pendiente_envio'),
  pdfPath: varchar('pdf_path', { length: 500 }),
  sha256: varchar('sha256', { length: 64 }),
  metadata: jsonb('metadata'),
  solicitadoAt: timestamp('solicitado_at', { withTimezone: true }).notNull().defaultNow(),
  firmadoAt: timestamp('firmado_at', { withTimezone: true }),
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
}, (t) => ({
  tramiteIdx: index('idx_tramite_firmas_tramite').on(t.tramiteId),
}));

// TRAM-INNOV A2 — bitácora append-only del expediente (timeline + QR público).
export const tramiteEventos = pgTable('tramite_eventos', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tramiteId: integer('tramite_id').notNull().references(() => tramitesDigitales.id, { onDelete: 'cascade' }),
  actorUserId: integer('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  actorRole: varchar('actor_role', { length: 30 }),
  tipo: varchar('tipo', { length: 40 }).notNull(),
  payload: jsonb('payload'),
  docHash: varchar('doc_hash', { length: 64 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tramiteIdx: index('idx_tramite_eventos_tramite').on(t.tramiteId, t.createdAt),
}));

// TRAM-INNOV A1 — snapshots de pre-vuelo (semáforo SOAT/RTM/SIMIT/RUNT/impuesto).
export const tramitePreflight = pgTable('tramite_preflight', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tramiteId: integer('tramite_id').references(() => tramitesDigitales.id, { onDelete: 'cascade' }),
  vin: varchar('vin', { length: 17 }),
  placa: varchar('placa', { length: 10 }),
  compradorDoc: varchar('comprador_doc', { length: 30 }),
  vendedorDoc: varchar('vendedor_doc', { length: 30 }),
  checks: jsonb('checks').notNull(),
  overallStatus: varchar('overall_status', { length: 10 }).notNull(),
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tramiteIdx: index('idx_tramite_preflight_tramite').on(t.tramiteId, t.createdAt),
  vinIdx: index('idx_tramite_preflight_vin').on(t.vin, t.createdAt),
}));

// TRAM-INNOV B4 — trámites en lote (CSV de flota).
export const tramiteLotes = pgTable('tramite_lotes', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  nombre: varchar('nombre', { length: 120 }),
  creadoPor: integer('creado_por').references(() => users.id, { onDelete: 'set null' }),
  totalFilas: integer('total_filas').notNull().default(0),
  ok: integer('ok').notNull().default(0),
  errores: integer('errores').notNull().default(0),
  // LOTE-PLUS-01: procesando | listo | error
  estado: varchar('estado', { length: 20 }).notNull().default('listo'),
  // LOTE-PLUS-05: idempotencia CSV por usuario
  csvSha256: varchar('csv_sha256', { length: 64 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  createdIdx: index('idx_tramite_lotes_created').on(t.createdAt),
  userCsvShaIdx: uniqueIndex('idx_tramite_lotes_user_csv_sha').on(t.creadoPor, t.csvSha256),
}));

export const tramiteLoteFilas = pgTable('tramite_lote_filas', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  loteId: bigint('lote_id', { mode: 'number' }).notNull().references(() => tramiteLotes.id, { onDelete: 'cascade' }),
  fila: integer('fila').notNull(),
  vin: varchar('vin', { length: 17 }),
  placa: varchar('placa', { length: 10 }),
  tipologiaCodigo: varchar('tipologia_codigo', { length: 40 }),
  estado: varchar('estado', { length: 12 }).notNull(),
  tramiteId: integer('tramite_id').references(() => tramitesDigitales.id, { onDelete: 'set null' }),
  preflight: jsonb('preflight'),
  errorMsg: varchar('error_msg', { length: 300 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  loteIdx: index('idx_tramite_lote_filas_lote').on(t.loteId, t.fila),
}));

export const tramitesHistorial = pgTable('tramites_historial', {
  id: serial('id').primaryKey(),
  tramiteId: integer('tramite_id').notNull().references(() => tramitesDigitales.id, { onDelete: 'cascade' }),
  estadoAnterior: varchar('estado_anterior', { length: 30 }).notNull(),
  estadoNuevo: varchar('estado_nuevo', { length: 30 }).notNull(),
  usuarioId: integer('usuario_id').references(() => users.id, { onDelete: 'set null' }),
  detalle: text('detalle'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tramiteIdIdx: index('idx_tramites_hist_tramite_id').on(t.tramiteId),
  createdAtIdx: index('idx_tramites_hist_created_at').on(t.createdAt),
}));
export const flitoTramiteEstadoEnum = pgEnum('flito_tramite_estado', ['asignado', 'entregado', 'aprobado', 'anulado', 'rechazado']);

// Modalidad de gestión del organismo con vigencia temporal (CA-04: nunca se
// sobrescribe; la vigente es la única con hasta=NULL — índice parcial único abajo).
export const flitoOrganismoVigencias = pgTable('flito_organismo_vigencias', {
  id: uuid('id').primaryKey().defaultRandom(),
  organismoCodigo: varchar('organismo_codigo', { length: 5 }).notNull().references(() => organismosTransitoConfig.codigo),
  modalidad: flitoModalidadEnum('modalidad').notNull(),
  desde: timestamp('desde', { withTimezone: true }).notNull(),
  hasta: timestamp('hasta', { withTimezone: true }),
  motivo: text('motivo').notNull(),
  actorId: integer('actor_id').references(() => users.id),
  actorNombre: varchar('actor_nombre', { length: 150 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  organismoIdx: index('idx_flito_vig_organismo').on(t.organismoCodigo),
  // CA-04: a lo sumo una vigencia vigente (hasta IS NULL) por organismo.
  vigenteUnica: uniqueIndex('uq_flito_vig_vigente').on(t.organismoCodigo).where(sql`hasta IS NULL`),
}));

// Trámite sincronizado desde FLIT. Llave real: id_flit. Coexiste con tramites_digitales.
export const flitoTramites = pgTable('flito_tramites', {
  id: uuid('id').primaryKey().defaultRandom(),
  idFlit: varchar('id_flit', { length: 60 }).notNull().unique(),
  // Estado FLITO-interno (ciclo de entrega). La VERDAD del estado FLIT vive en flitEstado (texto).
  estado: flitoTramiteEstadoEnum('estado'),
  // Estado crudo tal como lo reporta FLIT (Borrador, Asignado, Aprobado, …). Fuente de verdad para
  // gating (solo 'Asignado' habilita SOAT/impuestos) y visualización. Integración FLIT (Fase 8).
  flitEstado: varchar('flit_estado', { length: 60 }),
  tipoTramite: varchar('tipo_tramite', { length: 60 }),
  ciudad: varchar('ciudad', { length: 120 }),
  tipoPropiedad: varchar('tipo_propiedad', { length: 30 }),
  companiaId: integer('compania_id').references(() => clients.id),
  // NIT crudo de la compañía gestora (CompaniaGestora). Si companiaId es null, la empresa aún no existe.
  companiaNit: varchar('compania_nit', { length: 30 }),
  organismoCodigo: varchar('organismo_codigo', { length: 5 }).references(() => organismosTransitoConfig.codigo),
  // Nombre crudo de la secretaría en FLIT. Si organismoCodigo es null, no cruzó por nombre.
  transitoNombreFlit: varchar('transito_nombre_flit', { length: 200 }),
  vehiculoId: integer('vehiculo_id').notNull().references(() => vehicles.id),
  // Muchos trámites → un SOAT (por VIN). Sostiene CA-03 (anular+recrear no re-adquiere).
  soatId: uuid('soat_id').references(() => flitoSoat.id),
  valorImpuestoLiquidado: numeric('valor_impuesto_liquidado', { precision: 14, scale: 2 }),
  // Id S3 de la factura de venta en FLIT (campo `factura`). Vacío = aún sin factura → no se solicita impuesto.
  facturaVentaFlitId: varchar('factura_venta_flit_id', { length: 120 }),
  fechaAprobacion: timestamp('fecha_aprobacion', { withTimezone: true }),
  // Fecha en que el trámite nació EN FLIT (HU #10959). `createdAt` de abajo es cuándo lo ingirió el
  // sync: en la primera corrida masiva todos los históricos comparten esa fecha, así que no sirve
  // para medir antigüedad. Nullable porque el reporte solo empezó a traerla en 2026-07.
  fechaCreacionFlit: timestamp('fecha_creacion_flit', { withTimezone: true }),
  // Payload completo de FLIT para trazabilidad/depuración.
  flitRaw: jsonb('flit_raw'),
  processStatus: integer('process_status'),
  plateComplete: varchar('plate_complete', { length: 20 }),
  // Sistema del que llegó el trámite (HU #13070): 'flit' (sync de FLIT 1) o 'flit2'. CHECK en la
  // migración 0213 (flito_tramites_fuente_chk). El sync de FLIT no la escribe: nace con el default.
  fuente: varchar('fuente', { length: 10 }).$type<FuenteTramite>().notNull().default('flit'),
  // HU #13091 (0215): identidad y versión del trámite en FLIT 2. Null en los de FLIT 1.
  idFlit2: uuid('id_flit2'), syncVersion: bigint('sync_version', { mode: 'number' }),
  // HU #13094 (0216): leído de FLIT 2 sin el scope de datos personales; espera la relectura.
  // HU #13946 (0256) `retenido`: llegó de FLIT con su compañía inactiva. No sale en la bandeja ni arranca SOAT/impuesto
  // hasta que el cliente se active (`liberarTramitesRetenidos`, en la misma transacción). Misma línea: techo de max-lines.
  flit2PiiEnmascarada: boolean('flit2_pii_enmascarada').notNull().default(false), retenido: boolean('retenido').notNull().default(false),
  sincronizadoEn: timestamp('sincronizado_en', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  estadoIdx: index('idx_flito_tramites_estado').on(t.estado),
  flitEstadoIdx: index('idx_flito_tramites_flit_estado').on(t.flitEstado),
  companiaNitIdx: index('idx_flito_tramites_compania_nit').on(t.companiaNit),
  // Orden cronológico y filtros de antigüedad (HU #10959): antes se ordenaba por created_at sin índice.
  fechaCreacionFlitIdx: index('idx_flito_tramites_fecha_creacion_flit').on(t.fechaCreacionFlit),
  createdAtIdx: index('idx_flito_tramites_created_at').on(t.createdAt),
  // ADR-0041 §13.8 (0301): primer trámite por SOAT compartido (costo de proveedor, C3).
  soatOrdenIdx: index('idx_flito_tramites_soat_orden').on(t.soatId, t.createdAt, t.id).where(sql`${t.soatId} IS NOT NULL`),
  idFlit2Uq: uniqueIndex('uq_flito_tramites_id_flit2').on(t.idFlit2).where(sql`${t.idFlit2} IS NOT NULL`),
  fuenteIdFlit2Ck: check('ck_flito_tramites_fuente_id_flit2', sql`(${t.fuente} = 'flit2') = (${t.idFlit2} IS NOT NULL)`),
  syncVersionCk: check('ck_flito_tramites_flit2_sync_version', sql`${t.idFlit2} IS NULL OR ${t.syncVersion} IS NOT NULL`),
  // HU #13946 (0256): índice parcial de los retenidos por compañía (misma línea: techo de max-lines del archivo).
  flit2PiiIdx: index('idx_flito_tramites_flit2_pii_enmascarada').on(t.id).where(sql`${t.flit2PiiEnmascarada}`), retenidoIdx: index('idx_flito_tramites_retenido_compania').on(t.companiaId).where(sql`${t.retenido}`),
}));

// Historial de cambios del trámite (auditoría campo por campo, Fase 8 / integración FLIT). Cada
// diferencia detectada al sincronizar (origen 'api') o por acción del usuario deja una fila.
export const flitoTramiteHistorial = pgTable('flito_tramite_historial', {
  id: uuid('id').primaryKey().defaultRandom(),
  tramiteId: uuid('tramite_id').notNull().references(() => flitoTramites.id, { onDelete: 'cascade' }),
  campo: varchar('campo', { length: 60 }).notNull(),
  valorAnterior: text('valor_anterior'),
  valorNuevo: text('valor_nuevo'),
  origen: varchar('origen', { length: 10 }).notNull(),
  usuarioId: integer('usuario_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tramiteIdx: index('idx_flito_tramite_historial_tramite').on(t.tramiteId, t.createdAt),
  // Reconstruir cuándo un trámite entró a un estado (HU #10959) exige filtrar por campo, no solo
  // por trámite: sin esto, «lleva N días en Borrador» recorre todo el historial de la fila.
  campoIdx: index('idx_flito_tramite_historial_campo').on(t.tramiteId, t.campo, t.createdAt),
}));
