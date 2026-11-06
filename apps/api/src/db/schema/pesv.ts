// PESV: conductores, capacitación, incidentes, operación, comité/plan/diagnóstico, auditoría, jornadas y rutas. Se re-exporta desde `../schema.ts` (HU #13984).
import {
  pgTable, serial, varchar, text, boolean, timestamp, time, integer, bigint, date, pgEnum, jsonb, numeric,
  bigserial, uuid, customType, smallint,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { vehicleTypeEnum, docEstadoEnum, bytea } from './_comunes.js';
import { vehicles } from './flota.js';
import { users } from './nucleo.js';
import { remesas, manifiestos } from './rndc.js';

// ============================================================================
// Sprint 3A — PESV Conductores (Resolución 40595/2022)
// ============================================================================

export const contratoTipoEnum = pgEnum('contrato_tipo', ['directo', 'contratista', 'temporal']);
export const trainingModalidadEnum = pgEnum('training_modalidad', ['presencial', 'virtual', 'mixta']);
export const incidentTipoEnum = pgEnum('incident_tipo', ['accidente', 'casi_accidente', 'comparendo']);
export const incidentGravedadEnum = pgEnum('incident_gravedad', ['sin', 'leve', 'grave', 'fatal']);
export const incidentEstadoEnum = pgEnum('incident_estado', ['abierto', 'investigacion', 'cerrado']);
// Declarado aquí (NO en bloque PESV-S6 abajo) porque roadIncidents lo usa.
export const pesvCausaRaizMetodoEnum = pgEnum('pesv_causa_raiz_metodo', ['5_porques', 'ishikawa', 'arbol_causas', 'otro']);
export const actionEstadoEnum = pgEnum('action_estado', ['pendiente', 'en_proceso', 'cumplida', 'vencida']);

export const driverProfile = pgTable('driver_profile', {
  userId: integer('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  // PII cifrado AES-256-GCM (Ola C-1 2026-05-05). Columnas *_legacy_plain dropeadas en 0052 (Lote 11 2026-05-06).
  cedulaCipher: bytea('cedula_cipher'),
  cedulaIv: bytea('cedula_iv'),
  cedulaAuthTag: bytea('cedula_auth_tag'),
  cedulaAadNonce: uuid('cedula_aad_nonce'),
  cedulaKeyVersion: smallint('cedula_key_version'),
  cedulaHash: bytea('cedula_hash'),
  fechaNacimiento: date('fecha_nacimiento'),
  licenciaNumeroCipher: bytea('licencia_numero_cipher'),
  licenciaNumeroIv: bytea('licencia_numero_iv'),
  licenciaNumeroAuthTag: bytea('licencia_numero_auth_tag'),
  licenciaNumeroAadNonce: uuid('licencia_numero_aad_nonce'),
  licenciaNumeroKeyVersion: smallint('licencia_numero_key_version'),
  categorias: text('categorias').array().notNull().default(sql`'{}'::text[]`),
  licenciaVigencia: date('licencia_vigencia'),
  examenPsicoFecha: date('examen_psico_fecha'),
  examenPsicoVigencia: date('examen_psico_vigencia'),
  restriccionesMedicas: text('restricciones_medicas').array().notNull().default(sql`'{}'::text[]`),
  arl: varchar('arl', { length: 80 }),
  eps: varchar('eps', { length: 80 }),
  fondoPensiones: varchar('fondo_pensiones', { length: 80 }),
  contratoTipo: contratoTipoEnum('contrato_tipo'),
  experienciaAnios: numeric('experiencia_anios', { precision: 4, scale: 1 }).notNull().default('0'),
  sancionesCount: integer('sanciones_count').notNull().default(0),
  fotoStorageKey: varchar('foto_storage_key', { length: 500 }),
  runtConsultadoAt: timestamp('runt_consultado_at', { withTimezone: true }),
  runtPayloadCipher: bytea('runt_payload_cipher'),
  runtPayloadIv: bytea('runt_payload_iv'),
  runtPayloadAuthTag: bytea('runt_payload_auth_tag'),
  runtPayloadAadNonce: uuid('runt_payload_aad_nonce'),
  runtPayloadKeyVersion: smallint('runt_payload_key_version'),
  // Sprint 3B — extensiones operación PESV.
  suspendidoPorAlcohol: boolean('suspendido_por_alcohol').notNull().default(false),
  fechaSuspension: timestamp('fecha_suspension', { withTimezone: true }),
  motivoSuspension: text('motivo_suspension'),
  suspensionLevantadaPor: integer('suspension_levantada_por').references(() => users.id),
  suspensionLevantadaAt: timestamp('suspension_levantada_at', { withTimezone: true }),
  checklistPinHash: varchar('checklist_pin_hash', { length: 120 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const driverDocumentTypes = pgTable('driver_document_types', {
  id: serial('id').primaryKey(),
  codigo: varchar('codigo', { length: 40 }).notNull().unique(),
  nombre: varchar('nombre', { length: 120 }).notNull(),
  requiereVigencia: boolean('requiere_vigencia').notNull().default(true),
  diasAlerta: integer('dias_alerta').array().notNull().default(sql`'{30,15,7,0}'::int[]`),
  destinatariosDefault: text('destinatarios_default').array().notNull().default(sql`'{}'::text[]`),
  activo: boolean('activo').notNull().default(true),
  orden: integer('orden').notNull().default(100),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const driverDocuments = pgTable('driver_documents', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tipoId: integer('tipo_id').notNull().references(() => driverDocumentTypes.id, { onDelete: 'restrict' }),
  numero: varchar('numero', { length: 80 }),
  vigenciaDesde: date('vigencia_desde'),
  vigenciaHasta: date('vigencia_hasta'),
  archivoStorageKey: varchar('archivo_storage_key', { length: 500 }),
  archivoFilename: varchar('archivo_filename', { length: 300 }),
  archivoSize: integer('archivo_size'),
  archivoMime: varchar('archivo_mime', { length: 100 }),
  estado: docEstadoEnum('estado').notNull().default('vigente'),
  destinatariosExtra: text('destinatarios_extra').array().notNull().default(sql`'{}'::text[]`),
  notas: text('notas'),
  subidoPor: integer('subido_por').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const driverAlertsSent = pgTable('driver_alerts_sent', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  documentoId: integer('documento_id').notNull().references(() => driverDocuments.id, { onDelete: 'cascade' }),
  diasAnticipacion: integer('dias_anticipacion').notNull(),
  enviadoAt: timestamp('enviado_at', { withTimezone: true }).notNull().defaultNow(),
  destinatarios: text('destinatarios').array().notNull(),
  emailMessageId: varchar('email_message_id', { length: 200 }),
  resultado: varchar('resultado', { length: 20 }).notNull(),
  errorMsg: text('error_msg'),
});

export const safetyTrainings = pgTable('safety_trainings', {
  id: serial('id').primaryKey(),
  titulo: varchar('titulo', { length: 150 }).notNull(),
  descripcion: text('descripcion'),
  horas: numeric('horas', { precision: 4, scale: 1 }).notNull(),
  fecha: date('fecha').notNull(),
  instructor: varchar('instructor', { length: 120 }),
  modalidad: trainingModalidadEnum('modalidad').notNull().default('presencial'),
  linkMaterial: text('link_material'),
  vigenciaMeses: integer('vigencia_meses'),
  creadaPor: integer('creada_por').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const trainingAttendees = pgTable('training_attendees', {
  trainingId: integer('training_id').notNull().references(() => safetyTrainings.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  asistio: boolean('asistio').notNull().default(false),
  calificacion: numeric('calificacion', { precision: 4, scale: 2 }),
  certificadoStorageKey: varchar('certificado_storage_key', { length: 500 }),
  registradoAt: timestamp('registrado_at', { withTimezone: true }).notNull().defaultNow(),
});

export const roadIncidents = pgTable('road_incidents', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tipo: incidentTipoEnum('tipo').notNull(),
  vehicleId: integer('vehicle_id').references(() => vehicles.id, { onDelete: 'set null' }),
  conductorId: integer('conductor_id').references(() => users.id, { onDelete: 'set null' }),
  fecha: date('fecha').notNull(),
  hora: time('hora'),
  lugarTexto: varchar('lugar_texto', { length: 300 }),
  lat: numeric('lat', { precision: 9, scale: 6 }),
  lng: numeric('lng', { precision: 9, scale: 6 }),
  gravedad: incidentGravedadEnum('gravedad').notNull().default('sin'),
  descripcion: text('descripcion'),
  costos: numeric('costos', { precision: 12, scale: 2 }).notNull().default('0'),
  victimasCount: integer('victimas_count').notNull().default(0),
  diasPerdidos: integer('dias_perdidos').notNull().default(0),
  comparendoNumero: varchar('comparendo_numero', { length: 40 }),
  valorMulta: numeric('valor_multa', { precision: 12, scale: 2 }),
  fotosKeys: text('fotos_keys').array().notNull().default(sql`'{}'::text[]`),
  reportadoPor: integer('reportado_por').references(() => users.id),
  estado: incidentEstadoEnum('estado').notNull().default('abierto'),
  // PESV-S6 Paso 13 — investigación causa raíz estructurada
  causaRaizMetodo: pesvCausaRaizMetodoEnum('causa_raiz_metodo'),
  causaRaizJsonb: jsonb('causa_raiz_jsonb'),
  investigacionResponsableId: integer('investigacion_responsable_id').references(() => users.id),
  investigacionCerradaAt: timestamp('investigacion_cerrada_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
});

export const incidentActions = pgTable('incident_actions', {
  id: serial('id').primaryKey(),
  incidentId: bigint('incident_id', { mode: 'number' }).notNull().references(() => roadIncidents.id, { onDelete: 'cascade' }),
  descripcion: text('descripcion').notNull(),
  responsableId: integer('responsable_id').references(() => users.id),
  fechaLimite: date('fecha_limite'),
  fechaCumplimiento: date('fecha_cumplimiento'),
  evidenciaStorageKey: varchar('evidencia_storage_key', { length: 500 }),
  estado: actionEstadoEnum('estado').notNull().default('pendiente'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================================
// Sprint 3B — Operación PESV (checklists, alcoholimetría, emergencias)
// ============================================================================

export const checklistFreqEnum = pgEnum('checklist_freq', ['diaria', 'semanal', 'mensual']);
export const checklistDecisionEnum = pgEnum('checklist_decision', ['apto', 'no_apto', 'condicional']);
export const itemCriterioEnum = pgEnum('item_criterio', ['booleano', 'tres_estados', 'numerico']);
export const itemEstadoEnum = pgEnum('item_estado', ['bueno', 'regular', 'malo']);
export const alcoholTestTipoEnum = pgEnum('alcohol_test_tipo', ['preoperacional', 'aleatoria', 'post_incidente', 'periodica']);
export const alcoholResultadoEnum = pgEnum('alcohol_resultado', ['negativo', 'positivo', 'inconcluso']);
export const emergencyContactTipoEnum = pgEnum('emergency_contact_tipo', ['arl', 'ambulancia', 'bombero', 'policia', 'taller_grua', 'aseguradora', 'interno']);
export const emergencyCategoriaEnum = pgEnum('emergency_categoria', ['accidente', 'averia', 'medico', 'seguridad']);

export const checklistTemplates = pgTable('checklist_templates', {
  id: serial('id').primaryKey(),
  titulo: varchar('titulo', { length: 150 }).notNull(),
  vehiculoTipo: vehicleTypeEnum('vehiculo_tipo'),
  frecuencia: checklistFreqEnum('frecuencia').notNull().default('diaria'),
  vigente: boolean('vigente').notNull().default(true),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: integer('created_by').references(() => users.id),
});

export const checklistTemplateItems = pgTable('checklist_template_items', {
  id: serial('id').primaryKey(),
  templateId: integer('template_id').notNull().references(() => checklistTemplates.id, { onDelete: 'cascade' }),
  orden: integer('orden').notNull(),
  categoria: varchar('categoria', { length: 40 }),
  label: varchar('label', { length: 200 }).notNull(),
  criterio: itemCriterioEnum('criterio').notNull().default('tres_estados'),
  obligatorio: boolean('obligatorio').notNull().default(true),
  critico: boolean('critico').notNull().default(false),
  unidad: varchar('unidad', { length: 20 }),
  minValor: numeric('min_valor'),
  maxValor: numeric('max_valor'),
});

export const checklists = pgTable('checklists', {
  id: serial('id').primaryKey(),
  vehicleId: integer('vehicle_id').notNull().references(() => vehicles.id, { onDelete: 'restrict' }),
  conductorId: integer('conductor_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  templateId: integer('template_id').notNull().references(() => checklistTemplates.id, { onDelete: 'restrict' }),
  templateVersion: integer('template_version').notNull(),
  fechaHora: timestamp('fecha_hora', { withTimezone: true }).notNull().defaultNow(),
  medicionActual: integer('medicion_actual'),
  lat: numeric('lat', { precision: 9, scale: 6 }),
  lng: numeric('lng', { precision: 9, scale: 6 }),
  decision: checklistDecisionEnum('decision').notNull(),
  firmaPinVerificado: boolean('firma_pin_verificado').notNull().default(false),
  qrToken: varchar('qr_token', { length: 64 }).notNull().unique(),
  observacionesGenerales: text('observaciones_generales'),
  anuladoAt: timestamp('anulado_at', { withTimezone: true }),
  anuladoPor: integer('anulado_por').references(() => users.id),
  anuladoMotivo: text('anulado_motivo'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const checklistResponses = pgTable('checklist_responses', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  checklistId: integer('checklist_id').notNull().references(() => checklists.id, { onDelete: 'cascade' }),
  itemId: integer('item_id').notNull().references(() => checklistTemplateItems.id, { onDelete: 'restrict' }),
  valorBool: boolean('valor_bool'),
  valorEstado: itemEstadoEnum('valor_estado'),
  valorNum: numeric('valor_num', { precision: 12, scale: 2 }),
  observacion: text('observacion'),
  fotoStorageKeys: text('foto_storage_keys').array().notNull().default(sql`'{}'::text[]`),
});

export const alcoholTests = pgTable('alcohol_tests', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  conductorId: integer('conductor_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  fechaHora: timestamp('fecha_hora', { withTimezone: true }).notNull().defaultNow(),
  tipo: alcoholTestTipoEnum('tipo').notNull(),
  valorMg: numeric('valor_mg', { precision: 4, scale: 2 }).notNull(),
  gradoAlcohol: smallint('grado_alcohol').notNull().default(0),
  resultado: alcoholResultadoEnum('resultado').notNull(),
  equipoSerial: varchar('equipo_serial', { length: 60 }),
  equipoCalibracionFecha: date('equipo_calibracion_fecha'),
  operadorId: integer('operador_id').notNull().references(() => users.id),
  incidentId: bigint('incident_id', { mode: 'number' }).references(() => roadIncidents.id, { onDelete: 'set null' }),
  fotoEvidenciaKeys: text('foto_evidencia_keys').array().notNull().default(sql`'{}'::text[]`),
  accionTomada: text('accion_tomada'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const emergencyContacts = pgTable('emergency_contacts', {
  id: serial('id').primaryKey(),
  tipo: emergencyContactTipoEnum('tipo').notNull(),
  zona: varchar('zona', { length: 100 }).notNull(),
  nombre: varchar('nombre', { length: 150 }).notNull(),
  telefono: varchar('telefono', { length: 40 }).notNull(),
  telefonoAlternativo: varchar('telefono_alternativo', { length: 40 }),
  email: varchar('email', { length: 150 }),
  direccion: varchar('direccion', { length: 300 }),
  observaciones: text('observaciones'),
  prioridad: smallint('prioridad').notNull().default(100),
  activo: boolean('activo').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const emergencyProtocols = pgTable('emergency_protocols', {
  id: serial('id').primaryKey(),
  titulo: varchar('titulo', { length: 200 }).notNull(),
  categoria: emergencyCategoriaEnum('categoria').notNull(),
  descripcionMd: text('descripcion_md').notNull(),
  zonas: text('zonas').array().notNull().default(sql`'{}'::text[]`),
  version: integer('version').notNull().default(1),
  vigente: boolean('vigente').notNull().default(true),
  archivoPdfStorageKey: varchar('archivo_pdf_storage_key', { length: 500 }),
  createdBy: integer('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const emergencyDrills = pgTable('emergency_drills', {
  id: serial('id').primaryKey(),
  fecha: date('fecha').notNull(),
  escenario: varchar('escenario', { length: 200 }).notNull(),
  protocoloId: integer('protocolo_id').references(() => emergencyProtocols.id, { onDelete: 'set null' }),
  participantes: integer('participantes').array().notNull().default(sql`'{}'::int[]`),
  evidenciaStorageKeys: text('evidencia_storage_keys').array().notNull().default(sql`'{}'::text[]`),
  observaciones: text('observaciones'),
  planMejora: text('plan_mejora'),
  responsableId: integer('responsable_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================================
// PESV Sprint Compliance · Fase 1 Paso 1 (Res. 40595/2022 + Res. 45295)
// ============================================================================
export const pesvPolicyEstadoEnum = pgEnum('pesv_policy_estado', ['borrador', 'vigente', 'reemplazada']);
export const pesvComitePeriodicidadEnum = pgEnum('pesv_comite_periodicidad', ['mensual', 'bimestral', 'trimestral', 'semestral']);
export const pesvComiteRolEnum = pgEnum('pesv_comite_rol', ['presidente', 'secretario', 'lider_pesv', 'vocal', 'representante_conductores', 'hse', 'mantenimiento']);
export const pesvActaEstadoEnum = pgEnum('pesv_acta_estado', ['borrador', 'cerrada']);
export const pesvPlanEstadoEnum = pgEnum('pesv_plan_estado', ['borrador', 'aprobado', 'cerrado']);
export const pesvAccionEstadoEnum = pgEnum('pesv_accion_estado', ['pendiente', 'en_proceso', 'cumplida', 'vencida']);
export const pesvDiagEstadoEnum = pgEnum('pesv_diag_estado', ['borrador', 'cerrado']);
export const pesvFasePhvaEnum = pgEnum('pesv_fase_phva', ['planear', 'hacer', 'verificar', 'actuar']);
// Niveles formales del diagnóstico PHVA (mig 0068, Res. 40595/2022 anexo técnico).
export const pesvNivelEmpresaEnum = pgEnum('pesv_nivel_empresa', ['basico', 'estandar', 'avanzado']);
export const pesvNivelRubricaEnum = pgEnum('pesv_nivel_rubrica', ['no_implementado', 'en_desarrollo', 'implementado', 'sostenido']);

export const pesvPolicy = pgTable('pesv_policy', {
  id: serial('id').primaryKey(),
  version: integer('version').notNull(),
  titulo: varchar('titulo', { length: 200 }).notNull(),
  contenidoMd: text('contenido_md').notNull(),
  pdfStorageKey: varchar('pdf_storage_key', { length: 500 }),
  pdfFirmadoStorageKey: varchar('pdf_firmado_storage_key', { length: 500 }),
  pkcs7Signature: customType<{ data: Buffer; driverData: Buffer }>({ dataType() { return 'bytea'; } })('pkcs7_signature'),
  signerCertPem: text('signer_cert_pem'),
  signatureAlgo: varchar('signature_algo', { length: 40 }),
  vigenciaDesde: date('vigencia_desde').notNull(),
  vigenciaHasta: date('vigencia_hasta'),
  firmadaPor: integer('firmada_por').references(() => users.id),
  firmadaAt: timestamp('firmada_at', { withTimezone: true }),
  hashSha256: customType<{ data: Buffer; driverData: Buffer }>({ dataType() { return 'bytea'; } })('hash_sha256'),
  estado: pesvPolicyEstadoEnum('estado').notNull().default('borrador'),
  optimisticV: integer('optimistic_v').notNull().default(1),
  createdBy: integer('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pesvComite = pgTable('pesv_comite', {
  id: serial('id').primaryKey(),
  nombre: varchar('nombre', { length: 150 }).notNull(),
  periodicidad: pesvComitePeriodicidadEnum('periodicidad').notNull().default('trimestral'),
  activo: boolean('activo').notNull().default(true),
  createdBy: integer('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pesvComiteMiembros = pgTable('pesv_comite_miembros', {
  comiteId: integer('comite_id').notNull().references(() => pesvComite.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id),
  rol: pesvComiteRolEnum('rol').notNull(),
  desde: date('desde').notNull(),
  hasta: date('hasta'),
});

export const pesvComiteActas = pgTable('pesv_comite_actas', {
  id: serial('id').primaryKey(),
  comiteId: integer('comite_id').notNull().references(() => pesvComite.id),
  numero: integer('numero').notNull(),
  fecha: date('fecha').notNull(),
  lugar: varchar('lugar', { length: 200 }),
  agendaMd: text('agenda_md'),
  decisionesMd: text('decisiones_md'),
  asistentesIds: integer('asistentes_ids').array().notNull().default(sql`ARRAY[]::integer[]`),
  ausentesIds: integer('ausentes_ids').array().notNull().default(sql`ARRAY[]::integer[]`),
  pdfStorageKey: varchar('pdf_storage_key', { length: 500 }),
  pdfFirmadoStorageKey: varchar('pdf_firmado_storage_key', { length: 500 }),
  pkcs7Signature: customType<{ data: Buffer; driverData: Buffer }>({ dataType() { return 'bytea'; } })('pkcs7_signature'),
  signerCertPem: text('signer_cert_pem'),
  signatureAlgo: varchar('signature_algo', { length: 40 }),
  hashSha256: customType<{ data: Buffer; driverData: Buffer }>({ dataType() { return 'bytea'; } })('hash_sha256'),
  estado: pesvActaEstadoEnum('estado').notNull().default('borrador'),
  createdBy: integer('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pesvPlanAnual = pgTable('pesv_plan_anual', {
  id: serial('id').primaryKey(),
  anio: smallint('anio').notNull().unique(),
  objetivoGeneral: text('objetivo_general').notNull(),
  presupuestoCop: numeric('presupuesto_cop', { precision: 14, scale: 2 }).notNull().default('0'),
  aprobadoPor: integer('aprobado_por').references(() => users.id),
  aprobadoAt: timestamp('aprobado_at', { withTimezone: true }),
  estado: pesvPlanEstadoEnum('estado').notNull().default('borrador'),
  optimisticV: integer('optimistic_v').notNull().default(1),
  createdBy: integer('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pesvPlanObjetivos = pgTable('pesv_plan_objetivos', {
  id: serial('id').primaryKey(),
  planId: integer('plan_id').notNull().references(() => pesvPlanAnual.id, { onDelete: 'cascade' }),
  codigo: varchar('codigo', { length: 20 }).notNull(),
  descripcion: text('descripcion').notNull(),
  metaPct: numeric('meta_pct', { precision: 5, scale: 2 }).notNull(),
  unidad: varchar('unidad', { length: 50 }),
  responsableId: integer('responsable_id').references(() => users.id),
  fechaLimite: date('fecha_limite'),
});

export const pesvPlanAcciones = pgTable('pesv_plan_acciones', {
  id: serial('id').primaryKey(),
  objetivoId: integer('objetivo_id').notNull().references(() => pesvPlanObjetivos.id, { onDelete: 'cascade' }),
  descripcion: text('descripcion').notNull(),
  responsableId: integer('responsable_id').references(() => users.id),
  fechaInicio: date('fecha_inicio'),
  fechaFin: date('fecha_fin'),
  presupuestoCop: numeric('presupuesto_cop', { precision: 14, scale: 2 }).notNull().default('0'),
  avancePct: numeric('avance_pct', { precision: 5, scale: 2 }).notNull().default('0'),
  estado: pesvAccionEstadoEnum('estado').notNull().default('pendiente'),
  evidenciaKeys: text('evidencia_keys').array().notNull().default(sql`ARRAY[]::text[]`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pesvEstandaresCatalogo = pgTable('pesv_estandares_catalogo', {
  id: serial('id').primaryKey(),
  codigo: varchar('codigo', { length: 20 }).notNull().unique(),
  paso: smallint('paso').notNull(),  // 1..24 (Res. 40595/2022)
  fase: pesvFasePhvaEnum('fase').notNull(),  // planear/hacer/verificar/actuar
  nombre: varchar('nombre', { length: 200 }).notNull(),
  descripcion: text('descripcion'),
  peso: numeric('peso', { precision: 5, scale: 2 }).notNull().default('1.0'),
  vigente: boolean('vigente').notNull().default(true),
  orden: smallint('orden').notNull(),
  // Nivel mínimo de empresa al que aplica el estándar (mig 0068). Default 'avanzado'
  // porque los 24 estándares actuales son nivel avanzado. El seed 0069 ajustará
  // básico/estándar tras concepto MOLANO (gate de fuente literal anexo Res. 40595/2022).
  nivelMinimo: pesvNivelEmpresaEnum('nivel_minimo').notNull().default('avanzado'),
});

export const pesvDiagnosticos = pgTable('pesv_diagnosticos', {
  id: serial('id').primaryKey(),
  anio: smallint('anio').notNull().unique(),
  fecha: date('fecha').notNull(),
  responsableId: integer('responsable_id').notNull().references(() => users.id),
  scoreGlobal: numeric('score_global', { precision: 5, scale: 2 }).notNull().default('0'),
  estado: pesvDiagEstadoEnum('estado').notNull().default('borrador'),
  optimisticV: integer('optimistic_v').notNull().default(1),
  observaciones: text('observaciones'),
  cerradoAt: timestamp('cerrado_at', { withTimezone: true }),
  // Autoclasificación de nivel + justificación opcional Ley 1581 (mig 0068).
  nivelEmpresa: pesvNivelEmpresaEnum('nivel_empresa').notNull().default('avanzado'),
  nivelCriterioJustificacion: text('nivel_criterio_justificacion'),
  createdBy: integer('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pesvDiagnosticoItems = pgTable('pesv_diagnostico_items', {
  diagnosticoId: integer('diagnostico_id').notNull().references(() => pesvDiagnosticos.id, { onDelete: 'cascade' }),
  estandarId: integer('estandar_id').notNull().references(() => pesvEstandaresCatalogo.id),
  scorePct: numeric('score_pct', { precision: 5, scale: 2 }).notNull().default('0'),
  // Rúbrica de 4 niveles (mig 0068). Mapeo canónico:
  // no_implementado=0% · en_desarrollo=50% · implementado=75% · sostenido=100%.
  // El trigger SQL trg_pesv_diag_items_worm valida que scorePct ∈ {0,50,75,100}.
  nivelRubrica: pesvNivelRubricaEnum('nivel_rubrica').notNull().default('no_implementado'),
  evidenciaKeys: text('evidencia_keys').array().notNull().default(sql`ARRAY[]::text[]`),
  comentarios: text('comentarios'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================================
// PESV-S6 · Estándares huérfanos + Log Ley 1581
// ============================================================================
export const pesvAuditoriaTipoEnum = pgEnum('pesv_auditoria_tipo', ['interna', 'externa', 'supert', 'onac']);
export const pesvAuditoriaEstadoEnum = pgEnum('pesv_auditoria_estado', ['planificada', 'en_curso', 'cerrada']);
export const pesvHallazgoSeveridadEnum = pgEnum('pesv_hallazgo_severidad', ['observacion', 'no_conformidad_menor', 'no_conformidad_mayor', 'critico']);
export const pesvHallazgoEstadoEnum = pgEnum('pesv_hallazgo_estado', ['abierto', 'en_remediacion', 'cerrado', 'aceptado']);
export const pesvComunicacionTipoEnum = pgEnum('pesv_comunicacion_tipo', ['politica', 'lecciones_aprendidas', 'capacitacion', 'recordatorio', 'otro']);
export const pesvContratistaEstadoEnum = pgEnum('pesv_contratista_estado', ['vinculado', 'suspendido', 'desvinculado']);
export const pesvContratistaEvalEnum = pgEnum('pesv_contratista_evaluacion', ['apto', 'apto_condicional', 'no_apto']);
// pesvCausaRaizMetodoEnum se declara más arriba junto a incidentEstadoEnum porque roadIncidents lo usa.

export const pesvAuditorias = pgTable('pesv_auditorias', {
  id: serial('id').primaryKey(),
  anio: smallint('anio').notNull(),
  tipo: pesvAuditoriaTipoEnum('tipo').notNull(),
  alcance: text('alcance').notNull(),
  fechaPlanificada: date('fecha_planificada').notNull(),
  fechaInicio: date('fecha_inicio'),
  fechaCierre: date('fecha_cierre'),
  auditorExterno: varchar('auditor_externo', { length: 200 }),
  auditorLiderId: integer('auditor_lider_id').references(() => users.id),
  estado: pesvAuditoriaEstadoEnum('estado').notNull().default('planificada'),
  resumen: text('resumen'),
  evidenciaKeys: text('evidencia_keys').array().notNull().default(sql`ARRAY[]::text[]`),
  optimisticV: integer('optimistic_v').notNull().default(1),
  createdBy: integer('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pesvAuditoriaHallazgos = pgTable('pesv_auditoria_hallazgos', {
  id: serial('id').primaryKey(),
  auditoriaId: integer('auditoria_id').notNull().references(() => pesvAuditorias.id, { onDelete: 'cascade' }),
  pasoPesv: smallint('paso_pesv'),
  severidad: pesvHallazgoSeveridadEnum('severidad').notNull(),
  descripcion: text('descripcion').notNull(),
  evidenciaKeys: text('evidencia_keys').array().notNull().default(sql`ARRAY[]::text[]`),
  responsableId: integer('responsable_id').references(() => users.id),
  fechaLimite: date('fecha_limite'),
  estado: pesvHallazgoEstadoEnum('estado').notNull().default('abierto'),
  accionesMd: text('acciones_md'),
  cierreObservaciones: text('cierre_observaciones'),
  cerradoAt: timestamp('cerrado_at', { withTimezone: true }),
  cerradoPor: integer('cerrado_por').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pesvComunicaciones = pgTable('pesv_comunicaciones', {
  id: serial('id').primaryKey(),
  tipo: pesvComunicacionTipoEnum('tipo').notNull(),
  asunto: varchar('asunto', { length: 200 }).notNull(),
  cuerpoMd: text('cuerpo_md').notNull(),
  pdfStorageKey: varchar('pdf_storage_key', { length: 500 }),
  destinatariosRoles: text('destinatarios_roles').array().notNull().default(sql`ARRAY[]::text[]`),
  publicadoAt: timestamp('publicado_at', { withTimezone: true }),
  publicadoPor: integer('publicado_por').references(() => users.id),
  vencimientoAcuse: date('vencimiento_acuse'),
  acusesCount: integer('acuses_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pesvComunicacionAcuses = pgTable('pesv_comunicacion_acuses', {
  comunicacionId: integer('comunicacion_id').notNull().references(() => pesvComunicaciones.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  acuseAt: timestamp('acuse_at', { withTimezone: true }).notNull().defaultNow(),
  ipOrigen: varchar('ip_origen', { length: 45 }),
});

export const pesvContratistas = pgTable('pesv_contratistas', {
  id: serial('id').primaryKey(),
  razonSocial: varchar('razon_social', { length: 200 }).notNull(),
  nit: varchar('nit', { length: 20 }).notNull().unique(),
  contactoNombre: varchar('contacto_nombre', { length: 150 }),
  contactoEmail: varchar('contacto_email', { length: 150 }),
  contactoTelefono: varchar('contacto_telefono', { length: 40 }),
  pesvNivel: varchar('pesv_nivel', { length: 20 }),
  pesvCertificadoStorageKey: varchar('pesv_certificado_storage_key', { length: 500 }),
  pesvVencimiento: date('pesv_vencimiento'),
  evaluacion: pesvContratistaEvalEnum('evaluacion').notNull().default('apto_condicional'),
  proximaEvaluacion: date('proxima_evaluacion'),
  estado: pesvContratistaEstadoEnum('estado').notNull().default('vinculado'),
  observaciones: text('observaciones'),
  createdBy: integer('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================================
// PESV Sprint Compliance · Fase 3 Control de Jornada (Decreto 1079/2015)
// ============================================================================
export const jornadaPausaMotivoEnum = pgEnum('jornada_pausa_motivo', ['descanso', 'comida', 'combustible', 'cargue_descargue', 'otro']);
export const jornadaAlarmaTipoEnum = pgEnum('jornada_alarma_tipo', ['mas_4h_continuas', 'mas_10h_jornada', 'menos_8h_descanso', 'mas_60h_semanal', 'sin_pausa_obligatoria']);
export const jornadaIdemScopeEnum = pgEnum('jornada_idem_scope', ['open', 'close', 'pausa_open', 'pausa_close']);

export const jornadasConductor = pgTable('jornadas_conductor', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  conductorId: integer('conductor_id').notNull().references(() => users.id),
  vehicleId: integer('vehicle_id').references(() => vehicles.id),
  checklistId: integer('checklist_id'),
  inicioAt: timestamp('inicio_at', { withTimezone: true }).notNull(),
  finAt: timestamp('fin_at', { withTimezone: true }),
  horasConduccion: numeric('horas_conduccion', { precision: 6, scale: 2 }),
  horasDescansoPre: numeric('horas_descanso_pre', { precision: 6, scale: 2 }),
  cerrada: boolean('cerrada').notNull().default(false),
  cerradaAutomatica: boolean('cerrada_automatica').notNull().default(false),
  cerradaPor: integer('cerrada_por').references(() => users.id),
  observaciones: text('observaciones'),
  optimisticV: integer('optimistic_v').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const jornadasPausas = pgTable('jornadas_pausas', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  jornadaId: bigint('jornada_id', { mode: 'number' }).notNull().references(() => jornadasConductor.id, { onDelete: 'cascade' }),
  inicioAt: timestamp('inicio_at', { withTimezone: true }).notNull(),
  finAt: timestamp('fin_at', { withTimezone: true }),
  motivo: jornadaPausaMotivoEnum('motivo').notNull().default('descanso'),
  duracionMin: integer('duracion_min'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const jornadasAlarmas = pgTable('jornadas_alarmas', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  jornadaId: bigint('jornada_id', { mode: 'number' }).notNull().references(() => jornadasConductor.id, { onDelete: 'cascade' }),
  tipo: jornadaAlarmaTipoEnum('tipo').notNull(),
  generadaAt: timestamp('generada_at', { withTimezone: true }).notNull().defaultNow(),
  valorObservado: numeric('valor_observado', { precision: 8, scale: 2 }).notNull(),
  valorLimite: numeric('valor_limite', { precision: 8, scale: 2 }).notNull(),
  unidad: varchar('unidad', { length: 20 }).notNull().default('horas'),
  ackBy: integer('ack_by').references(() => users.id),
  ackAt: timestamp('ack_at', { withTimezone: true }),
  ackObservaciones: text('ack_observaciones'),
});

export const jornadasReportesMensuales = pgTable('jornadas_reportes_mensuales', {
  id: serial('id').primaryKey(),
  conductorId: integer('conductor_id').notNull().references(() => users.id),
  anio: smallint('anio').notNull(),
  mes: smallint('mes').notNull(),
  jornadasCount: integer('jornadas_count').notNull().default(0),
  horasTotales: numeric('horas_totales', { precision: 7, scale: 2 }).notNull().default('0'),
  alarmasCount: integer('alarmas_count').notNull().default(0),
  cumpleNorma: boolean('cumple_norma').notNull().default(true),
  detalleJsonb: jsonb('detalle_jsonb'),
  generadoAt: timestamp('generado_at', { withTimezone: true }).notNull().defaultNow(),
  generadoPor: integer('generado_por').references(() => users.id),
});

export const jornadasIdempotencyKeys = pgTable('jornadas_idempotency_keys', {
  key: varchar('key', { length: 80 }).notNull(),
  scope: jornadaIdemScopeEnum('scope').notNull(),
  jornadaId: bigint('jornada_id', { mode: 'number' }).references(() => jornadasConductor.id, { onDelete: 'cascade' }),
  pausaId: bigint('pausa_id', { mode: 'number' }).references(() => jornadasPausas.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id),
  usedAt: timestamp('used_at', { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================================
// PESV Sprint Compliance · Fase 2 Paso 4 — Infraestructura segura
// ============================================================================
export const routeCriticidadEnum = pgEnum('route_criticidad', ['baja', 'media', 'alta', 'critica']);
export const routeWaypointTipoEnum = pgEnum('route_waypoint_tipo', ['origen', 'destino', 'parada_segura', 'area_descanso', 'punto_riesgo', 'zona_peligrosa', 'peaje', 'pernocta', 'cargue', 'descargue']);
export const routeRiskEstadoEnum = pgEnum('route_risk_estado', ['borrador', 'aprobado']);

export const routes = pgTable('routes', {
  id: serial('id').primaryKey(),
  codigo: varchar('codigo', { length: 30 }).notNull().unique(),
  nombre: varchar('nombre', { length: 200 }).notNull(),
  origen: varchar('origen', { length: 200 }).notNull(),
  destino: varchar('destino', { length: 200 }).notNull(),
  distanciaKm: numeric('distancia_km', { precision: 8, scale: 2 }),
  duracionEstimadaMin: integer('duracion_estimada_min'),
  criticidad: routeCriticidadEnum('criticidad').notNull().default('media'),
  modoOperacion: varchar('modo_operacion', { length: 50 }),
  vehiculoTipo: varchar('vehiculo_tipo', { length: 50 }),
  notas: text('notas'),
  activo: boolean('activo').notNull().default(true),
  optimisticV: integer('optimistic_v').notNull().default(1),
  createdBy: integer('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const routeWaypoints = pgTable('route_waypoints', {
  id: serial('id').primaryKey(),
  routeId: integer('route_id').notNull().references(() => routes.id, { onDelete: 'cascade' }),
  orden: smallint('orden').notNull(),
  tipo: routeWaypointTipoEnum('tipo').notNull(),
  nombre: varchar('nombre', { length: 200 }).notNull(),
  descripcion: text('descripcion'),
  lat: numeric('lat', { precision: 9, scale: 6 }),
  lng: numeric('lng', { precision: 9, scale: 6 }),
  telefonoContacto: varchar('telefono_contacto', { length: 40 }),
  observaciones: text('observaciones'),
});

export const routeRiskAnalyses = pgTable('route_risk_analyses', {
  id: serial('id').primaryKey(),
  routeId: integer('route_id').notNull().references(() => routes.id, { onDelete: 'cascade' }),
  trimestre: varchar('trimestre', { length: 7 }).notNull(),
  fecha: date('fecha').notNull(),
  evaluadorId: integer('evaluador_id').notNull().references(() => users.id),
  resumen: text('resumen'),
  estado: routeRiskEstadoEnum('estado').notNull().default('borrador'),
  optimisticV: integer('optimistic_v').notNull().default(1),
  aprobadoAt: timestamp('aprobado_at', { withTimezone: true }),
  aprobadoPor: integer('aprobado_por').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const routeRiskItems = pgTable('route_risk_items', {
  id: serial('id').primaryKey(),
  analisisId: integer('analisis_id').notNull().references(() => routeRiskAnalyses.id, { onDelete: 'cascade' }),
  peligro: varchar('peligro', { length: 300 }).notNull(),
  probabilidad: smallint('probabilidad').notNull(),
  impacto: smallint('impacto').notNull(),
  score: smallint('score'),
  controlesActuales: text('controles_actuales'),
  residualProb: smallint('residual_prob'),
  residualImp: smallint('residual_imp'),
  residualScore: smallint('residual_score'),
  planAccion: text('plan_accion'),
  responsableId: integer('responsable_id').references(() => users.id),
  fechaLimite: date('fecha_limite'),
});

export const routePernoctaZones = pgTable('route_pernocta_zones', {
  id: serial('id').primaryKey(),
  nombre: varchar('nombre', { length: 200 }).notNull(),
  routeId: integer('route_id').references(() => routes.id, { onDelete: 'set null' }),
  lat: numeric('lat', { precision: 9, scale: 6 }),
  lng: numeric('lng', { precision: 9, scale: 6 }),
  capacidad: integer('capacidad'),
  contacto: varchar('contacto', { length: 150 }),
  telefono: varchar('telefono', { length: 40 }),
  protocoloMd: text('protocolo_md'),
  servicios: text('servicios').array().notNull().default(sql`ARRAY[]::text[]`),
  vigente: boolean('vigente').notNull().default(true),
  createdBy: integer('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const routeAssignments = pgTable('route_assignments', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  routeId: integer('route_id').notNull().references(() => routes.id, { onDelete: 'cascade' }),
  remesaId: bigint('remesa_id', { mode: 'number' }).references(() => remesas.id, { onDelete: 'cascade' }),
  manifiestoId: bigint('manifiesto_id', { mode: 'number' }).references(() => manifiestos.id, { onDelete: 'cascade' }),
  asignadoPor: integer('asignado_por').notNull().references(() => users.id),
  asignadoAt: timestamp('asignado_at', { withTimezone: true }).notNull().defaultNow(),
  notas: text('notas'),
});

// ============================================================================
// PESV Sprint Compliance · Fase 9 (S9) — Pasos menores 1.5 / 1.7 / 19
// ============================================================================
export const pesvRaciTipoEnum = pgEnum('pesv_raci_tipo', ['R', 'A', 'C', 'I']);
export const pesvNormativaTipoEnum = pgEnum('pesv_normativa_tipo', ['ley', 'decreto', 'resolucion', 'concepto', 'circular', 'norma_tecnica']);
export const pesvRetencionAccionEnum = pgEnum('pesv_retencion_accion', ['purgar', 'archivar_offline', 'anonimizar']);

export const pesvRaci = pgTable('pesv_raci', {
  id: serial('id').primaryKey(),
  procesoCodigo: varchar('proceso_codigo', { length: 20 }).notNull(),
  procesoNombre: varchar('proceso_nombre', { length: 200 }).notNull(),
  rol: varchar('rol', { length: 40 }).notNull(),
  tipo: pesvRaciTipoEnum('tipo').notNull(),
  descripcion: text('descripcion'),
  optimisticV: integer('optimistic_v').notNull().default(1),
  createdBy: integer('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pesvNormativa = pgTable('pesv_normativa', {
  id: serial('id').primaryKey(),
  codigo: varchar('codigo', { length: 80 }).notNull().unique(),
  tipo: pesvNormativaTipoEnum('tipo').notNull(),
  titulo: text('titulo').notNull(),
  emisor: varchar('emisor', { length: 120 }).notNull(),
  fechaPublicacion: date('fecha_publicacion').notNull(),
  vigente: boolean('vigente').notNull().default(true),
  aplicaA: text('aplica_a').array().notNull().default(sql`ARRAY[]::text[]`),
  urlOficial: varchar('url_oficial', { length: 500 }),
  resumenMd: text('resumen_md'),
  ultimaRevisionAt: timestamp('ultima_revision_at', { withTimezone: true }),
  ultimaRevisionPor: integer('ultima_revision_por').references(() => users.id),
  proximaRevisionAt: timestamp('proxima_revision_at', { withTimezone: true }).notNull(),
  notasMd: text('notas_md'),
  optimisticV: integer('optimistic_v').notNull().default(1),
  createdBy: integer('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pesvNormativaRevisiones = pgTable('pesv_normativa_revisiones', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  normativaId: integer('normativa_id').notNull().references(() => pesvNormativa.id, { onDelete: 'cascade' }),
  revisadaAt: timestamp('revisada_at', { withTimezone: true }).notNull().defaultNow(),
  revisadaPor: integer('revisada_por').notNull().references(() => users.id),
  cambiosObservados: text('cambios_observados'),
  proximaRevisionAt: timestamp('proxima_revision_at', { withTimezone: true }).notNull(),
});

export const pesvRetencionPoliticas = pgTable('pesv_retencion_politicas', {
  id: serial('id').primaryKey(),
  tipoDocumento: varchar('tipo_documento', { length: 60 }).notNull().unique(),
  retencionAnios: smallint('retencion_anios').notNull(),
  baseLegal: varchar('base_legal', { length: 200 }).notNull(),
  accion: pesvRetencionAccionEnum('accion').notNull().default('archivar_offline'),
  habilitado: boolean('habilitado').notNull().default(true),
  notasMd: text('notas_md'),
  optimisticV: integer('optimistic_v').notNull().default(1),
  createdBy: integer('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pesvRetencionLog = pgTable('pesv_retencion_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  politicaId: integer('politica_id').references(() => pesvRetencionPoliticas.id, { onDelete: 'set null' }),
  tipoDocumento: varchar('tipo_documento', { length: 60 }).notNull(),
  cantidadAfectada: integer('cantidad_afectada').notNull().default(0),
  cutoffDate: date('cutoff_date').notNull(),
  accion: pesvRetencionAccionEnum('accion').notNull(),
  ejecutadoAt: timestamp('ejecutado_at', { withTimezone: true }).notNull().defaultNow(),
  ejecutadoPorCron: boolean('ejecutado_por_cron').notNull().default(true),
  ejecutadoPorUser: integer('ejecutado_por_user').references(() => users.id),
  detalleMd: text('detalle_md'),
});
