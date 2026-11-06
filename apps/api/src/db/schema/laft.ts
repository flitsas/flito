// LAFT/SARLAFT: contrapartes, listas restrictivas, ROS, RTE/AROS, KYC, manual, oficial y auditorías. Se re-exporta desde `../schema.ts` (HU #13984).
import {
  pgTable, serial, varchar, text, boolean, timestamp, integer, bigint, date, pgEnum, index, jsonb, numeric,
  bigserial,
} from 'drizzle-orm/pg-core';
import { users } from './nucleo.js';

export const laftKindEnum = pgEnum('laft_kind', ['PN', 'PJ']);
export const laftRiskLevelEnum = pgEnum('laft_risk_level', ['bajo', 'medio', 'alto']);
export const laftStatusEnum = pgEnum('laft_status', ['pendiente', 'vinculada', 'bloqueada', 'archivada']);
export const laftUnusualDecisionEnum = pgEnum('laft_unusual_decision', ['pendiente', 'en_analisis', 'descartada', 'escalada', 'reportada']);

// === LAFT — Política de Prevención LA/FT/FPADM (FLIT SAS) =====================

export const laftCounterparties = pgTable('laft_counterparties', {
  id: serial('id').primaryKey(),
  kind: laftKindEnum('kind').notNull(),
  docType: varchar('doc_type', { length: 10 }).notNull(),
  docNumber: varchar('doc_number', { length: 20 }).notNull(),
  fullName: varchar('full_name', { length: 200 }).notNull(),
  email: varchar('email', { length: 150 }),
  phone: varchar('phone', { length: 20 }),
  address: varchar('address', { length: 300 }),
  city: varchar('city', { length: 100 }),
  country: varchar('country', { length: 80 }).notNull().default('Colombia'),
  economicActivity: varchar('economic_activity', { length: 200 }),
  ciiu: varchar('ciiu', { length: 10 }),
  fundOrigin: text('fund_origin').notNull(),
  isPep: boolean('is_pep').notNull().default(false),
  pepRole: varchar('pep_role', { length: 200 }),
  pepPeriodStart: date('pep_period_start'),
  pepPeriodEnd: date('pep_period_end'),
  pepKinship: varchar('pep_kinship', { length: 50 }),
  factorCounterparty: integer('factor_counterparty'),
  factorProduct: integer('factor_product'),
  factorChannel: integer('factor_channel'),
  factorJurisdiction: integer('factor_jurisdiction'),
  riskLevel: laftRiskLevelEnum('risk_level'),
  status: laftStatusEnum('status').notNull().default('pendiente'),
  blockReason: text('block_reason'),
  nextReviewAt: date('next_review_at'),
  version: integer('version').notNull().default(1),
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  // F2 LAFT — cifrado PII (mig 0063). Las columnas plain (docNumber/email/phone)
  // siguen existiendo hasta que el backfill termine y se apruebe la 0064 de drop.
  docNumberEnc: jsonb('doc_number_enc'),
  docNumberHash: varchar('doc_number_hash', { length: 64 }),
  emailEnc: jsonb('email_enc'),
  phoneEnc: jsonb('phone_enc'),
}, (t) => ({
  docIdx: index('idx_laft_cp_doc').on(t.docNumber),
  statusIdx: index('idx_laft_cp_status').on(t.status),
  reviewIdx: index('idx_laft_cp_review').on(t.nextReviewAt),
  riskIdx: index('idx_laft_cp_risk').on(t.riskLevel),
  docHashIdx: index('idx_laft_cp_doc_hash').on(t.docNumberHash),
}));

export const laftBeneficialOwners = pgTable('laft_beneficial_owners', {
  id: serial('id').primaryKey(),
  counterpartyId: integer('counterparty_id').notNull().references(() => laftCounterparties.id, { onDelete: 'cascade' }),
  docType: varchar('doc_type', { length: 10 }).notNull(),
  docNumber: varchar('doc_number', { length: 20 }).notNull(),
  fullName: varchar('full_name', { length: 200 }).notNull(),
  ownershipPct: numeric('ownership_pct', { precision: 5, scale: 2 }).notNull(),
  isPep: boolean('is_pep').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  cpIdx: index('idx_laft_bo_cp').on(t.counterpartyId),
  docIdx: index('idx_laft_bo_doc').on(t.docNumber),
}));

export const laftDocuments = pgTable('laft_documents', {
  id: serial('id').primaryKey(),
  counterpartyId: integer('counterparty_id').notNull().references(() => laftCounterparties.id, { onDelete: 'cascade' }),
  kind: varchar('kind', { length: 50 }).notNull(),
  filename: varchar('filename', { length: 255 }).notNull(),
  storageKey: varchar('storage_key', { length: 500 }).notNull(),
  sizeBytes: integer('size_bytes'),
  mimeType: varchar('mime_type', { length: 100 }),
  uploadedBy: integer('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  cpIdx: index('idx_laft_docs_cp').on(t.counterpartyId),
}));

export const laftRestrictiveLists = pgTable('laft_restrictive_lists', {
  id: serial('id').primaryKey(),
  code: varchar('code', { length: 20 }).notNull().unique(),
  name: varchar('name', { length: 120 }).notNull(),
  binding: boolean('binding').notNull().default(false),
  sourceUrl: varchar('source_url', { length: 500 }),
  description: text('description'),
  active: boolean('active').notNull().default(true),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  totalEntries: integer('total_entries').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const laftListEntries = pgTable('laft_list_entries', {
  id: serial('id').primaryKey(),
  listId: integer('list_id').notNull().references(() => laftRestrictiveLists.id, { onDelete: 'cascade' }),
  fullName: varchar('full_name', { length: 500 }).notNull(),
  fullNameNorm: varchar('full_name_norm', { length: 500 }).notNull(),
  aliases: jsonb('aliases'),
  docType: varchar('doc_type', { length: 20 }),
  docNumber: varchar('doc_number', { length: 50 }),
  country: varchar('country', { length: 80 }),
  birthDate: varchar('birth_date', { length: 20 }),
  remarks: text('remarks'),
  sourceId: varchar('source_id', { length: 100 }),
  sourceHash: varchar('source_hash', { length: 64 }),
  validFrom: date('valid_from'),
  importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  listIdx: index('idx_laft_le_list').on(t.listId),
  docIdx: index('idx_laft_le_doc').on(t.docNumber),
  sourceIdx: index('idx_laft_le_source').on(t.listId, t.sourceId),
}));

export const laftListChecks = pgTable('laft_list_checks', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  counterpartyId: integer('counterparty_id').notNull().references(() => laftCounterparties.id, { onDelete: 'cascade' }),
  listId: integer('list_id').notNull().references(() => laftRestrictiveLists.id, { onDelete: 'restrict' }),
  queryDoc: varchar('query_doc', { length: 50 }),
  queryNameNorm: varchar('query_name_norm', { length: 500 }),
  matchEntryId: integer('match_entry_id').references(() => laftListEntries.id, { onDelete: 'set null' }),
  matchScore: integer('match_score').notNull().default(0),
  matchKind: varchar('match_kind', { length: 20 }),
  evidence: jsonb('evidence'),
  checkedBy: integer('checked_by').references(() => users.id, { onDelete: 'set null' }),
  checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  cpIdx: index('idx_laft_checks_cp').on(t.counterpartyId, t.checkedAt),
}));

export const laftAuditLog = pgTable('laft_audit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
  userUsername: varchar('user_username', { length: 50 }),
  action: varchar('action', { length: 50 }).notNull(),
  resource: varchar('resource', { length: 50 }).notNull(),
  resourceId: varchar('resource_id', { length: 50 }),
  beforeState: jsonb('before_state'),
  afterState: jsonb('after_state'),
  ipAddress: varchar('ip_address', { length: 45 }),
  userAgent: varchar('user_agent', { length: 500 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  createdIdx: index('idx_laft_audit_created').on(t.createdAt),
  resourceIdx: index('idx_laft_audit_resource').on(t.resource, t.resourceId),
  userIdx: index('idx_laft_audit_user').on(t.userId),
}));

export const laftUnusualOperations = pgTable('laft_unusual_operations', {
  id: serial('id').primaryKey(),
  counterpartyId: integer('counterparty_id').references(() => laftCounterparties.id, { onDelete: 'set null' }),
  detectedBy: integer('detected_by').references(() => users.id, { onDelete: 'set null' }),
  detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
  source: varchar('source', { length: 50 }).notNull(),
  signals: jsonb('signals').notNull(),
  amount: numeric('amount', { precision: 20, scale: 2 }),
  currency: varchar('currency', { length: 10 }).default('COP'),
  description: text('description').notNull(),
  analysisText: text('analysis_text'),
  decision: laftUnusualDecisionEnum('decision').notNull().default('pendiente'),
  decidedBy: integer('decided_by').references(() => users.id, { onDelete: 'set null' }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decisionReason: text('decision_reason'),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  decisionIdx: index('idx_laft_uo_decision').on(t.decision),
  cpIdx: index('idx_laft_uo_cp').on(t.counterpartyId),
  detectedIdx: index('idx_laft_uo_detected').on(t.detectedAt),
}));

export const laftRosDrafts = pgTable('laft_ros_drafts', {
  id: serial('id').primaryKey(),
  operationId: integer('operation_id').notNull().references(() => laftUnusualOperations.id, { onDelete: 'restrict' }),
  sirelPayload: jsonb('sirel_payload').notNull(),
  pdfStorageKey: varchar('pdf_storage_key', { length: 500 }),
  generatedBy: integer('generated_by').references(() => users.id, { onDelete: 'set null' }),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
  sentToUiafAt: timestamp('sent_to_uiaf_at', { withTimezone: true }),
  sirelRadicado: varchar('sirel_radicado', { length: 60 }),
  evidenceFiles: jsonb('evidence_files'),
  notes: text('notes'),
  // F4 SARLAFT v2 (migration 0065): timer SLA 24h + export para SIREL data-entry humano.
  clasificadoAt: timestamp('clasificado_at', { withTimezone: true }),
  slaDueAt: timestamp('sla_due_at', { withTimezone: true }),
  slaBreached: boolean('sla_breached').notNull().default(false),
  exportPdfStorageKey: text('export_pdf_storage_key'),
  exportCsvStorageKey: text('export_csv_storage_key'),
  exportSha256: varchar('export_sha256', { length: 64 }),
  sirelAcuseAt: timestamp('sirel_acuse_at', { withTimezone: true }),
}, (t) => ({
  opIdx: index('idx_laft_ros_op').on(t.operationId),
  sentIdx: index('idx_laft_ros_sent').on(t.sentToUiafAt),
}));

export const laftRosSlaAlarmas = pgTable('laft_ros_sla_alarmas', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  rosDraftId: integer('ros_draft_id').notNull().references(() => laftRosDrafts.id, { onDelete: 'cascade' }),
  tipo: varchar('tipo', { length: 20 }).notNull(), // warn_12h | warn_4h | breach
  alarmadaAt: timestamp('alarmada_at', { withTimezone: true }).notNull().defaultNow(),
  destinatarios: text('destinatarios'),
  acuseAt: timestamp('acuse_at', { withTimezone: true }),
  acusePor: integer('acuse_por').references(() => users.id),
});

export const laftTrainings = pgTable('laft_trainings', {
  id: serial('id').primaryKey(),
  title: varchar('title', { length: 200 }).notNull(),
  description: text('description'),
  trainerName: varchar('trainer_name', { length: 120 }),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
  durationHours: numeric('duration_hours', { precision: 4, scale: 1 }),
  contentUrl: varchar('content_url', { length: 500 }),
  evaluationUrl: varchar('evaluation_url', { length: 500 }),
  passingScore: integer('passing_score').default(70),
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  scheduledIdx: index('idx_laft_tr_scheduled').on(t.scheduledAt),
}));

export const laftTrainingAttendees = pgTable('laft_training_attendees', {
  id: serial('id').primaryKey(),
  trainingId: integer('training_id').notNull().references(() => laftTrainings.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  attended: boolean('attended').notNull().default(false),
  score: integer('score'),
  attendedAt: timestamp('attended_at', { withTimezone: true }),
  certificateStorageKey: varchar('certificate_storage_key', { length: 500 }),
}, (t) => ({
  trainingIdx: index('idx_laft_ta_training').on(t.trainingId),
  userIdx: index('idx_laft_ta_user').on(t.userId),
}));

// LAFT/SARLAFT v2 — F1: jobs de sincronización de listas restrictivas (auditoría WORM).
// El cron diario inserta una fila por lista (running) → la cierra (success/failed).
// Trigger BD bloquea cualquier UPDATE/DELETE posterior sobre filas no-running (ver mig 0062).
export const laftListsSyncJobs = pgTable('laft_lists_sync_jobs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  listCode: varchar('list_code', { length: 20 }).notNull(),
  trigger: varchar('trigger', { length: 20 }).notNull().default('cron'),
  triggeredBy: integer('triggered_by').references(() => users.id, { onDelete: 'set null' }),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  status: varchar('status', { length: 20 }).notNull().default('running'),
  sourceUrl: text('source_url'),
  sourceHash: varchar('source_hash', { length: 64 }),
  entriesTotal: integer('entries_total'),
  entriesAdded: integer('entries_added'),
  entriesRemoved: integer('entries_removed'),
  entriesModified: integer('entries_modified'),
  retroMatchesNew: integer('retro_matches_new'),
  errorText: text('error_text'),
  durationMs: integer('duration_ms'),
}, (t) => ({
  listStartedIdx: index('idx_laft_sync_jobs_list_code_started').on(t.listCode, t.startedAt),
  statusIdx: index('idx_laft_sync_jobs_status').on(t.status, t.startedAt),
}));

// ============================================================================
// LAFT v2 F3 (mig 0064) — RTE / AROS / parámetros / cash txns / idempotencia
// ============================================================================

// Parámetros LAFT configurables (umbrales RTE, dia corte AROS, SLA ROS).
// El Empleado de Cumplimiento ajusta estos valores vía UI sin redeploy.
export const laftParametros = pgTable('laft_parametros', {
  clave: varchar('clave', { length: 60 }).primaryKey(),
  valor: text('valor').notNull(),
  descripcion: text('descripcion'),
  actualizadoPor: integer('actualizado_por').references(() => users.id, { onDelete: 'set null' }),
  actualizadoAt: timestamp('actualizado_at', { withTimezone: true }).notNull().defaultNow(),
});

// Transacciones en efectivo. WORM-light: REVOKE DELETE en BD; UPDATE solo desde
// app para asociar unusual_operation_id / ros_draft_id post-creación.
export const laftCashTxns = pgTable('laft_cash_txns', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  counterpartyId: integer('counterparty_id').notNull().references(() => laftCounterparties.id, { onDelete: 'restrict' }),
  amount: numeric('amount', { precision: 18, scale: 2 }).notNull(),
  currency: varchar('currency', { length: 3 }).notNull().default('COP'),
  kind: varchar('kind', { length: 20 }).notNull(),
  fecha: date('fecha').notNull(),
  descripcion: text('descripcion'),
  numeroRecibo: varchar('numero_recibo', { length: 60 }),
  thresholdIndividualBreached: boolean('threshold_individual_breached').notNull().default(false),
  thresholdAcumuladoBreached: boolean('threshold_acumulado_breached').notNull().default(false),
  unusualOperationId: integer('unusual_operation_id').references(() => laftUnusualOperations.id, { onDelete: 'set null' }),
  rosDraftId: integer('ros_draft_id').references(() => laftRosDrafts.id, { onDelete: 'set null' }),
  registradoPor: integer('registrado_por').notNull().references(() => users.id, { onDelete: 'restrict' }),
  registradoAt: timestamp('registrado_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  cpFechaIdx: index('idx_laft_cash_cp_fecha').on(t.counterpartyId, t.fecha),
  kindIdx: index('idx_laft_cash_kind').on(t.kind),
}));

// Reportes generados a la UIAF (RTE/AROS/ROS). WORM-strict: trigger BD bloquea
// cambios distintos a enviado_a_uiaf_at + acuse_uiaf.
export const laftReportesUiaf = pgTable('laft_reportes_uiaf', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tipo: varchar('tipo', { length: 10 }).notNull(),
  periodoAnio: integer('periodo_anio'),
  periodoMes: integer('periodo_mes'),
  periodoTrimestre: integer('periodo_trimestre'),
  generadoPor: integer('generado_por').notNull().references(() => users.id, { onDelete: 'restrict' }),
  generadoAt: timestamp('generado_at', { withTimezone: true }).notNull().defaultNow(),
  totalOperaciones: integer('total_operaciones').notNull().default(0),
  totalMontoCop: numeric('total_monto_cop', { precision: 18, scale: 2 }),
  formato: varchar('formato', { length: 10 }).notNull(),
  storageKey: text('storage_key'),
  sha256: varchar('sha256', { length: 64 }).notNull(),
  enviadoAUiafAt: timestamp('enviado_a_uiaf_at', { withTimezone: true }),
  acuseUiaf: text('acuse_uiaf'),
}, (t) => ({
  periodoIdx: index('idx_laft_reportes_periodo').on(t.periodoAnio, t.tipo),
}));

// Idempotencia persistente para POSTs LAFT (cash txn / generar reportes).
// Misma forma que jornadas_idempotency_keys / rndc_idempotency_keys.
export const laftCashIdempotencyKeys = pgTable('laft_cash_idempotency_keys', {
  key: varchar('key', { length: 80 }).notNull(),
  scope: varchar('scope', { length: 20 }).notNull(),
  cashTxnId: bigint('cash_txn_id', { mode: 'number' }).references(() => laftCashTxns.id, { onDelete: 'set null' }),
  reporteId: bigint('reporte_id', { mode: 'number' }).references(() => laftReportesUiaf.id, { onDelete: 'set null' }),
  userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================================
// LAFT F2 — KYC empleados (Resolución UIAF 122/2021 + Circular SuperT 4607/2026)
// ============================================================================
export const laftEmployeesKyc = pgTable('laft_employees_kyc', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }).unique(),
  factorPersona: jsonb('factor_persona'),
  factorCanal: jsonb('factor_canal'),
  factorZona: jsonb('factor_zona'),
  antecedentesCheckAt: timestamp('antecedentes_check_at', { withTimezone: true }),
  antecedentesResultado: jsonb('antecedentes_resultado'),
  antecedentesDocumentoPath: text('antecedentes_documento_path'),
  pep: boolean('pep').notNull().default(false),
  pepDetalle: text('pep_detalle'),
  riskLevel: varchar('risk_level', { length: 10 }).notNull().default('bajo'),
  matchBlocked: boolean('match_blocked').notNull().default(false),
  matchBlockedReason: text('match_blocked_reason'),
  nextReviewAt: date('next_review_at').notNull(),
  observaciones: text('observaciones'),
  version: integer('version').notNull().default(1),
  createdBy: integer('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: integer('updated_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  nextReviewIdx: index('idx_laft_emp_kyc_next_review').on(t.nextReviewAt),
  blockedIdx: index('idx_laft_emp_kyc_blocked').on(t.userId),
  riskIdx: index('idx_laft_emp_kyc_risk').on(t.riskLevel),
}));

// ============================================================================
// LAFT/SARLAFT v2 — F5: Manual versionado, oficial cumplimiento, auditorías
// (mig 0066 + 0067). Resolución 4607/2026 SuperTransporte.
// ============================================================================
export const laftManualVersions = pgTable('laft_manual_versions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  version: integer('version').notNull().unique(),
  titulo: varchar('titulo', { length: 200 }).notNull().default('Manual SARLAFT'),
  contenidoMd: text('contenido_md').notNull(),
  sha256: varchar('sha256', { length: 64 }).notNull(),
  pdfStorageKey: text('pdf_storage_key'),
  firmadoPorRepresentante: integer('firmado_por_representante').references(() => users.id),
  firmadoPorOficial: integer('firmado_por_oficial').references(() => users.id),
  firmadoAt: timestamp('firmado_at', { withTimezone: true }),
  publicado: boolean('publicado').notNull().default(false),
  publicadoAt: timestamp('publicado_at', { withTimezone: true }),
  motivoCambio: text('motivo_cambio'),
  createdBy: integer('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  publicadoIdx: index('idx_laft_manual_publicado').on(t.version),
}));

export const laftComplianceOfficers = pgTable('laft_compliance_officers', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id),
  rol: varchar('rol', { length: 20 }).notNull(),
  certificacionIso17024: boolean('certificacion_iso17024').notNull().default(false),
  certificacionDocStorageKey: text('certificacion_doc_storage_key'),
  designadoPor: integer('designado_por').notNull().references(() => users.id),
  actaJuntaStorageKey: text('acta_junta_storage_key'),
  validFrom: date('valid_from').notNull(),
  validTo: date('valid_to'),
  revocadoAt: timestamp('revocado_at', { withTimezone: true }),
  revocadoMotivo: text('revocado_motivo'),
  revocadoPor: integer('revocado_por').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  vigentesIdx: index('idx_laft_officer_vigentes').on(t.rol),
  userIdx: index('idx_laft_officer_user').on(t.userId),
}));

export const laftAuditPlans = pgTable('laft_audit_plans', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  anio: integer('anio').notNull(),
  tipo: varchar('tipo', { length: 20 }).notNull(),
  alcance: text('alcance'),
  responsableUserId: integer('responsable_user_id').references(() => users.id),
  responsableExternoNombre: varchar('responsable_externo_nombre', { length: 150 }),
  responsableExternoNit: varchar('responsable_externo_nit', { length: 20 }),
  fechaPlanificada: date('fecha_planificada').notNull(),
  fechaEjecutada: date('fecha_ejecutada'),
  hallazgosMd: text('hallazgos_md'),
  conclusionesMd: text('conclusiones_md'),
  evidenciaStorageKey: text('evidencia_storage_key'),
  estado: varchar('estado', { length: 20 }).notNull().default('planeada'),
  createdBy: integer('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  anioIdx: index('idx_laft_audit_plan_anio').on(t.anio, t.tipo),
  estadoIdx: index('idx_laft_audit_plan_estado').on(t.estado),
}));
