import { pgTable, serial, varchar, text, boolean, timestamp, integer, bigint, date, pgEnum, index, uniqueIndex, jsonb, numeric, bigserial, uuid, customType, smallint, doublePrecision, primaryKey } from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() { return 'bytea'; },
});
import { sql } from 'drizzle-orm';
// FLITO (migración): tipos de extracción OCR persistidos en columnas jsonb.
import type { ExtraccionSoat, ExtraccionImpuesto, ExtraccionFacturaVenta } from '@operaciones/shared-types';

export const roleEnum = pgEnum('user_role', ['admin', 'proveedor', 'transito', 'compliance', 'lider_pesv', 'supervisor_flota', 'conductor', 'auditor', 'operaciones', 'gestor_impuestos']);

export const laftKindEnum = pgEnum('laft_kind', ['PN', 'PJ']);
export const laftRiskLevelEnum = pgEnum('laft_risk_level', ['bajo', 'medio', 'alto']);
export const laftStatusEnum = pgEnum('laft_status', ['pendiente', 'vinculada', 'bloqueada', 'archivada']);
export const laftUnusualDecisionEnum = pgEnum('laft_unusual_decision', ['pendiente', 'en_analisis', 'descartada', 'escalada', 'reportada']);

export const auditActionEnum = pgEnum('audit_action', [
  'login', 'login_failed', 'logout',
  'create', 'update', 'delete',
  'upload', 'export', 'purchase',
  'wo_open', 'wo_close', 'stock_adjust',
  'view',  // mig 0069 — para audit de visualización de evidencias PESV (Ley 1581 + ONAC)
]);

export const statusEnum = pgEnum('soat_status', [
  'pendiente', 'enviado', 'comprado', 'verificado', 'rechazado',
]);

export const stageEnum = pgEnum('vehicle_stage', [
  'ingreso', 'impuesto', 'soat_pendiente', 'soat_comprado', 'soat_verificado', 'listo',
]);

export const multasEstadoEnum = pgEnum('multas_estado', ['no_consultado', 'sin_multas', 'con_multas', 'acuerdo_pago']);

export const vehicleTypeEnum = pgEnum('vehicle_type', ['tractomula', 'camion', 'buseta', 'camioneta', 'automovil', 'motocicleta', 'otro']);
export const measurementTypeEnum = pgEnum('measurement_type', ['km', 'horas', 'ambos']);
export const workLoadEnum = pgEnum('work_load', ['bajo', 'normal', 'severo']);
export const fuelTypeEnum = pgEnum('fuel_type', ['acpm', 'gasolina', 'gas', 'electrico', 'hibrido']);
export const measurementSourceEnum = pgEnum('measurement_source', ['manual', 'app', 'gps', 'combustible', 'ot']);
export const docEstadoEnum = pgEnum('doc_estado', ['vigente', 'por_vencer', 'vencido', 'archivado']);

export const tramiteEstadoEnum = pgEnum('tramite_estado', [
  'borrador', 'radicado', 'en_validacion', 'documentos', 'identidad', 'aprobado', 'rechazado', 'enviado_transito',
  'recibido_transito', 'placa_preasignada', 'solicitud_soat',
  'soat_comprado', 'soat_verificado', 'completado',
  // TRAM-TRASPASO-F1 (mig 0092): estados STT del traspaso.
  'subsanacion', 'en_tramite', 'entregado', 'anulado',
]);

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  username: varchar('username', { length: 50 }).notNull().unique(),
  name: varchar('name', { length: 100 }).notNull(),
  email: varchar('email', { length: 150 }),
  passwordHash: text('password_hash').notNull(),
  role: roleEnum('role').notNull(),
  active: boolean('active').notNull().default(true),
  allowedPages: text('allowed_pages').array().notNull().default(sql`'{}'::text[]`),
  // TRAM-MT-01: organismo DIVIPOLA asignado a usuarios rol `transito` (bandeja aislada).
  transitoCodigo: varchar('transito_codigo', { length: 5 }),
  esMecanico: boolean('es_mecanico').notNull().default(false),
  especialidades: text('especialidades').array().notNull().default(sql`'{}'::text[]`),
  esConductor: boolean('es_conductor').notNull().default(false),
  // FLITO (migración): atadura de visibilidad del gestor SOAT (rol `proveedor`) a su
  // proveedor SOAT — hace cumplir CA-09 en la consulta. El gestor de impuestos
  // (rol `gestor_impuestos`) reutiliza `transito_codigo` como organismo (CA-10).
  flitoProveedorSoatId: uuid('flito_proveedor_soat_id').references((): any => flitoProveedoresSoat.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  sessionInvalidatedAt: timestamp('session_invalidated_at', { withTimezone: true }),
});

export const clients = pgTable('clients', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 200 }).notNull(),
  document: varchar('document', { length: 20 }),
  documentType: varchar('document_type', { length: 5 }).default('NIT'),
  phone: varchar('phone', { length: 20 }),
  email: varchar('email', { length: 150 }),
  address: varchar('address', { length: 300 }),
  city: varchar('city', { length: 100 }),
  notes: text('notes'),
  active: boolean('active').notNull().default(true),
  // FLITO (migración): parametrización por compañía. Si un módulo es autogestionable,
  // los trámites de esta compañía no entran a ese módulo FLITO (RN-02 SOAT / RN-03 Imp).
  soatAutogestionable: boolean('soat_autogestionable').notNull().default(false),
  impuestosAutogestionable: boolean('impuestos_autogestionable').notNull().default(false),
  logisticaAutogestionable: boolean('logistica_autogestionable').notNull().default(false),
  // Carpeta lógica en S3 donde se replican facturas/soportes (reinterpreta la
  // "carpeta OneDrive por compañía" del diseño original; decisión D-3).
  flitoCarpetaStorage: varchar('flito_carpeta_storage', { length: 300 }),
  // Tolerancia (en pesos) entre valor liquidado y pagado antes de marcar para revisión.
  flitoToleranciaValorImpuesto: numeric('flito_tolerancia_valor_impuesto', { precision: 14, scale: 2 }).notNull().default('0'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  documentIdx: index('idx_clients_document').on(t.document),
}));

export const vehicles = pgTable('vehicles', {
  id: serial('id').primaryKey(),
  vin: varchar('vin', { length: 17 }).unique(),
  plate: varchar('plate', { length: 10 }),
  ownerName: varchar('owner_name', { length: 200 }),
  ownerDocument: varchar('owner_document', { length: 20 }),
  brand: varchar('brand', { length: 50 }),
  model: varchar('model', { length: 50 }),
  year: integer('year'),
  vehicleClass: varchar('vehicle_class', { length: 50 }),
  clientId: integer('client_id').references(() => clients.id),
  stage: stageEnum('stage').notNull().default('ingreso'),
  taxPaid: boolean('tax_paid').notNull().default(false),
  taxAmount: integer('tax_amount'),
  taxDate: date('tax_date'),
  avaluoComercial: integer('avaluo_comercial'),
  impuestoTotalPagar: integer('impuesto_total_pagar'),
  formularioNo: varchar('formulario_no', { length: 30 }),
  taxSource: varchar('tax_source', { length: 20 }),
  multasEstado: multasEstadoEnum('multas_estado').notNull().default('no_consultado'),
  multasTotal: numeric('multas_total', { precision: 15, scale: 2 }),
  multasCount: integer('multas_count'),
  multasConsultadoAt: timestamp('multas_consultado_at', { withTimezone: true }),
  multasNotas: text('multas_notas'),
  notes: text('notes'),
  // Flota propia (Sprint 1 — núcleo CloudFleet-style). Cuando es_flota_propia=false el vehículo
  // pertenece al pipeline de tránsito y los campos de flota se ignoran.
  esFlotaPropia: boolean('es_flota_propia').notNull().default(false),
  alias: varchar('alias', { length: 80 }),
  tipoVehiculo: vehicleTypeEnum('tipo_vehiculo'),
  tipoMedicion: measurementTypeEnum('tipo_medicion'),
  medicionPrincipal: varchar('medicion_principal', { length: 10 }),
  tipoTrabajo: workLoadEnum('tipo_trabajo').default('normal'),
  combustiblePrincipal: fuelTypeEnum('combustible_principal'),
  combustibleSecundario: fuelTypeEnum('combustible_secundario'),
  numMotor: varchar('num_motor', { length: 50 }),
  numSerie: varchar('num_serie', { length: 50 }),
  fechaCompra: date('fecha_compra'),
  precioCompra: numeric('precio_compra', { precision: 15, scale: 2 }),
  distMax24h: integer('dist_max_24h'),
  distPromedioDia: integer('dist_promedio_dia'),
  horasOpMes: integer('horas_op_mes'),
  rendimientoIdeal: numeric('rendimiento_ideal', { precision: 8, scale: 2 }),
  color: varchar('color', { length: 30 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  plateIdx: index('idx_vehicles_plate').on(t.plate),
}));

// Vinculación cabezote ↔ trailer (E2). Solo un trailer puede estar es_actual=true por cada vinculado.
export const vehicleEquipmentLinks = pgTable('vehicle_equipment_links', {
  id: serial('id').primaryKey(),
  vehiculoPrincipalId: integer('vehiculo_principal_id').notNull().references(() => vehicles.id, { onDelete: 'restrict' }),
  vehiculoVinculadoId: integer('vehiculo_vinculado_id').notNull().references(() => vehicles.id, { onDelete: 'restrict' }),
  desde: timestamp('desde', { withTimezone: true }).notNull().defaultNow(),
  hasta: timestamp('hasta', { withTimezone: true }),
  esActual: boolean('es_actual').notNull().default(true),
  creadoPor: integer('creado_por').references(() => users.id),
  notas: text('notas'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Mediciones de odómetro/horómetro (E3).
export const vehicleMeasurements = pgTable('vehicle_measurements', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  vehicleId: integer('vehicle_id').notNull().references(() => vehicles.id, { onDelete: 'cascade' }),
  fecha: date('fecha').notNull().defaultNow(),
  odometro: integer('odometro'),
  horometro: integer('horometro'),
  fuente: measurementSourceEnum('fuente').notNull().default('manual'),
  usuarioId: integer('usuario_id').references(() => users.id),
  nota: text('nota'),
  excedioPromedio: boolean('excedio_promedio').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Catálogo de tipos de documento (E4).
export const documentTypes = pgTable('document_types', {
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

// Documentos concretos por vehículo (E4).
export const vehicleDocuments = pgTable('vehicle_documents', {
  id: serial('id').primaryKey(),
  vehicleId: integer('vehicle_id').notNull().references(() => vehicles.id, { onDelete: 'cascade' }),
  tipoId: integer('tipo_id').notNull().references(() => documentTypes.id, { onDelete: 'restrict' }),
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

// Idempotencia de alertas (E4): UNIQUE(documento_id, dias_anticipacion) garantiza que el cron
// no vuelva a enviar la misma alerta así corra dos veces el mismo día por reinicio de PM2.
export const alertsSent = pgTable('alerts_sent', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  documentoId: integer('documento_id').notNull().references(() => vehicleDocuments.id, { onDelete: 'cascade' }),
  diasAnticipacion: integer('dias_anticipacion').notNull(),
  enviadoAt: timestamp('enviado_at', { withTimezone: true }).notNull().defaultNow(),
  destinatarios: text('destinatarios').array().notNull(),
  emailMessageId: varchar('email_message_id', { length: 200 }),
  resultado: varchar('resultado', { length: 20 }).notNull(),
  errorMsg: text('error_msg'),
});

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

export const soatRequests = pgTable('soat_requests', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  vehicleId: integer('vehicle_id').notNull().references(() => vehicles.id, { onDelete: 'restrict' }),
  tramiteId: integer('tramite_id').references(() => tramitesDigitales.id, { onDelete: 'set null' }),
  status: statusEnum('status').notNull().default('pendiente'),
  requestedBy: integer('requested_by').notNull().references(() => users.id),
  assignedTo: integer('assigned_to').references(() => users.id),
  policyNumber: varchar('policy_number', { length: 50 }),
  insurer: varchar('insurer', { length: 100 }),
  purchaseDate: date('purchase_date'),
  expiryDate: date('expiry_date'),
  runtVerified: boolean('runt_verified').notNull().default(false),
  runtVerifiedAt: timestamp('runt_verified_at', { withTimezone: true }),
  soatHolder: varchar('soat_holder', { length: 200 }),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  vehicleIdIdx: index('idx_soat_requests_vehicle_id').on(t.vehicleId),
  statusIdx: index('idx_soat_requests_status').on(t.status),
}));

export const systemLocks = pgTable('system_locks', {
  lockName: varchar('lock_name', { length: 50 }).primaryKey(),
  acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull().defaultNow(),
  acquiredBy: varchar('acquired_by', { length: 100 }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

// FLOTA-01 (mig 0083) — KV genérico de estado operativo (no secretos).
export const systemKv = pgTable('system_kv', {
  k: varchar('k', { length: 120 }).primaryKey(),
  v: jsonb('v').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const soatRefreshAttempts = pgTable('soat_refresh_attempts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  soatRequestId: bigint('soat_request_id', { mode: 'number' }).notNull().references(() => soatRequests.id, { onDelete: 'restrict' }),
  triggeredBy: varchar('triggered_by', { length: 20 }).notNull().default('manual'),
  triggeredByUser: integer('triggered_by_user').references(() => users.id),
  result: varchar('result', { length: 30 }).notNull(),
  message: text('message'),
  durationMs: integer('duration_ms'),
  runtMessage: text('runt_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  soatIdIdx: index('idx_soat_refresh_attempts_soat_id').on(t.soatRequestId),
  createdAtIdx: index('idx_soat_refresh_attempts_created_at').on(t.createdAt),
  resultIdx: index('idx_soat_refresh_attempts_result').on(t.result),
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

// TRAM-INNOV B1 — pasaporte vehicular: historial cronológico encadenado por VIN.
export const vehiculoHistorial = pgTable('vehiculo_historial', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  vin: varchar('vin', { length: 17 }).notNull(),
  eventoTipo: varchar('evento_tipo', { length: 40 }).notNull(),
  referenciaTramiteId: integer('referencia_tramite_id').references(() => tramitesDigitales.id, { onDelete: 'set null' }),
  payload: jsonb('payload'),
  hashPrev: varchar('hash_prev', { length: 64 }).notNull(),
  hashSelf: varchar('hash_self', { length: 64 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  vinIdx: index('idx_vehiculo_historial_vin').on(t.vin, t.createdAt, t.id),
  vinIdIdx: index('idx_vehiculo_historial_vin_id').on(t.vin, t.id),
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

export const auditLogs = pgTable('audit_logs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
  userEmail: varchar('user_email', { length: 150 }),
  action: auditActionEnum('action').notNull(),
  resource: varchar('resource', { length: 50 }).notNull(),
  resourceId: varchar('resource_id', { length: 50 }),
  detail: text('detail'),
  ipAddress: varchar('ip_address', { length: 45 }),
  userAgent: varchar('user_agent', { length: 500 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  createdAtIdx: index('idx_audit_logs_created_at').on(t.createdAt),
  userIdIdx: index('idx_audit_logs_user_id').on(t.userId),
}));

export const procesamientoCuentas = pgTable('procesamiento_cuentas', {
  id: serial('id').primaryKey(),
  usuarioId: integer('usuario_id').references(() => users.id, { onDelete: 'set null' }),
  driveFileId: varchar('drive_file_id', { length: 100 }),
  nombreArchivo: varchar('nombre_archivo', { length: 255 }),
  totalPaginas: integer('total_paginas'),
  cuentasDetectadas: integer('cuentas_detectadas'),
  placasUnicas: integer('placas_unicas'),
  valorTotal: numeric('valor_total', { precision: 20, scale: 2 }),
  directorioSalida: varchar('directorio_salida', { length: 255 }),
  estado: varchar('estado', { length: 20 }).notNull().default('procesando'),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

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
// Sprint 2A — Mantenimiento (E1, E2, E3)
// ============================================================================

export const criterioPeriodicidadEnum = pgEnum('criterio_periodicidad', ['vehicle', 'tipo_vehiculo', 'combustible']);
export const scheduleTipoEnum = pgEnum('schedule_tipo', ['manual', 'automatica']);
export const scheduleEstadoEnum = pgEnum('schedule_estado', ['pendiente', 'ejecutada', 'vencida', 'cancelada']);
export const movementTypeEnum = pgEnum('movement_type', ['entrada', 'salida', 'traslado', 'ajuste', 'reverso_ot']);

export const maintenanceSystems = pgTable('maintenance_systems', {
  id: serial('id').primaryKey(),
  codigo: varchar('codigo', { length: 20 }).notNull().unique(),
  nombre: varchar('nombre', { length: 80 }).notNull(),
  orden: integer('orden').notNull().default(100),
  activo: boolean('activo').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const maintenanceSubsystems = pgTable('maintenance_subsystems', {
  id: serial('id').primaryKey(),
  systemId: integer('system_id').notNull().references(() => maintenanceSystems.id, { onDelete: 'restrict' }),
  codigo: varchar('codigo', { length: 20 }).notNull(),
  nombre: varchar('nombre', { length: 80 }).notNull(),
  activo: boolean('activo').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const maintenanceJobs = pgTable('maintenance_jobs', {
  id: serial('id').primaryKey(),
  codigo: varchar('codigo', { length: 30 }).notNull().unique(),
  nombre: varchar('nombre', { length: 150 }).notNull(),
  systemId: integer('system_id').references(() => maintenanceSystems.id, { onDelete: 'restrict' }),
  subsystemId: integer('subsystem_id').references(() => maintenanceSubsystems.id, { onDelete: 'restrict' }),
  tiempoEstimadoHoras: numeric('tiempo_estimado_horas', { precision: 6, scale: 2 }),
  descripcion: text('descripcion'),
  activo: boolean('activo').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const partsLocations = pgTable('parts_locations', {
  id: serial('id').primaryKey(),
  codigo: varchar('codigo', { length: 20 }).notNull().unique(),
  nombre: varchar('nombre', { length: 80 }).notNull(),
  bodega: varchar('bodega', { length: 80 }),
  activo: boolean('activo').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const parts = pgTable('parts', {
  id: serial('id').primaryKey(),
  codigo: varchar('codigo', { length: 30 }).notNull().unique(),
  nombre: varchar('nombre', { length: 150 }).notNull(),
  unidadMedida: varchar('unidad_medida', { length: 10 }).notNull().default('und'),
  inventariable: boolean('inventariable').notNull().default(true),
  existenciaMin: numeric('existencia_min', { precision: 12, scale: 2 }).notNull().default('0'),
  existenciaMax: numeric('existencia_max', { precision: 12, scale: 2 }),
  systemId: integer('system_id').references(() => maintenanceSystems.id, { onDelete: 'set null' }),
  valorPromedio: numeric('valor_promedio', { precision: 15, scale: 4 }).notNull().default('0'),
  activo: boolean('activo').notNull().default(true),
  observaciones: text('observaciones'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const partsStock = pgTable('parts_stock', {
  id: serial('id').primaryKey(),
  partId: integer('part_id').notNull().references(() => parts.id, { onDelete: 'cascade' }),
  locationId: integer('location_id').notNull().references(() => partsLocations.id, { onDelete: 'restrict' }),
  cantidad: numeric('cantidad', { precision: 14, scale: 3 }).notNull().default('0'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const partsMovements = pgTable('parts_movements', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  fecha: date('fecha').notNull().defaultNow(),
  tipo: movementTypeEnum('tipo').notNull(),
  partId: integer('part_id').notNull().references(() => parts.id, { onDelete: 'restrict' }),
  cantidad: numeric('cantidad', { precision: 14, scale: 3 }).notNull(),
  valorUnit: numeric('valor_unit', { precision: 15, scale: 4 }),
  ubicacionOrigenId: integer('ubicacion_origen_id').references(() => partsLocations.id, { onDelete: 'restrict' }),
  ubicacionDestinoId: integer('ubicacion_destino_id').references(() => partsLocations.id, { onDelete: 'restrict' }),
  factura: varchar('factura', { length: 50 }),
  remision: varchar('remision', { length: 50 }),
  woId: bigint('wo_id', { mode: 'number' }).references((): any => workOrders.id, { onDelete: 'restrict' }),
  observaciones: text('observaciones'),
  usuarioId: integer('usuario_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const maintenanceRoutines = pgTable('maintenance_routines', {
  id: serial('id').primaryKey(),
  codigo: varchar('codigo', { length: 30 }).notNull().unique(),
  nombre: varchar('nombre', { length: 150 }).notNull(),
  descripcion: text('descripcion'),
  activo: boolean('activo').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const routineJobs = pgTable('routine_jobs', {
  routineId: integer('routine_id').notNull().references(() => maintenanceRoutines.id, { onDelete: 'cascade' }),
  jobId: integer('job_id').notNull().references(() => maintenanceJobs.id, { onDelete: 'restrict' }),
  orden: integer('orden').notNull().default(1),
});

export const routineParts = pgTable('routine_parts', {
  routineId: integer('routine_id').notNull().references(() => maintenanceRoutines.id, { onDelete: 'cascade' }),
  partId: integer('part_id').notNull().references(() => parts.id, { onDelete: 'restrict' }),
  cantidad: numeric('cantidad', { precision: 12, scale: 3 }).notNull().default('1'),
});

export const routinePeriodicity = pgTable('routine_periodicity', {
  id: serial('id').primaryKey(),
  routineId: integer('routine_id').notNull().references(() => maintenanceRoutines.id, { onDelete: 'cascade' }),
  criterio: criterioPeriodicidadEnum('criterio').notNull(),
  refId: integer('ref_id'),
  tipoVehiculo: vehicleTypeEnum('tipo_vehiculo'),
  combustible: fuelTypeEnum('combustible'),
  kmPeriodo: integer('km_periodo'),
  horasPeriodo: integer('horas_periodo'),
  diasPeriodo: integer('dias_periodo'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const maintenanceSchedule = pgTable('maintenance_schedule', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  vehicleId: integer('vehicle_id').notNull().references(() => vehicles.id, { onDelete: 'cascade' }),
  routineId: integer('routine_id').references(() => maintenanceRoutines.id, { onDelete: 'cascade' }),
  jobId: integer('job_id').references(() => maintenanceJobs.id, { onDelete: 'cascade' }),
  fechaProgramada: date('fecha_programada').notNull(),
  medicionProgramada: integer('medicion_programada'),
  tipo: scheduleTipoEnum('tipo').notNull().default('automatica'),
  secuencial: boolean('secuencial').notNull().default(false),
  estado: scheduleEstadoEnum('estado').notNull().default('pendiente'),
  woId: bigint('wo_id', { mode: 'number' }).references((): any => workOrders.id, { onDelete: 'set null' }),
  creadoPor: integer('creado_por').references(() => users.id),
  notas: text('notas'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================================
// Sprint 2B — Preorden + Orden de Trabajo (E4)
// ============================================================================

export const preOrderEstadoEnum = pgEnum('pre_order_estado', ['borrador', 'aprobada', 'generada_ot', 'rechazada']);
export const woTipoEnum = pgEnum('wo_tipo', ['preventivo', 'correctivo', 'predictivo']);
export const woEstadoEnum = pgEnum('wo_estado', ['abierta', 'cerrada_tecnica', 'cerrada_final', 'anulada']);

export const preOrders = pgTable('pre_orders', {
  id: serial('id').primaryKey(),
  numero: varchar('numero', { length: 20 }).notNull().unique(),
  vehicleId: integer('vehicle_id').notNull().references(() => vehicles.id, { onDelete: 'restrict' }),
  fecha: date('fecha').notNull().defaultNow(),
  estado: preOrderEstadoEnum('estado').notNull().default('borrador'),
  observaciones: text('observaciones'),
  creadoPor: integer('creado_por').references(() => users.id),
  aprobadoPor: integer('aprobado_por').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const preOrderJobs = pgTable('pre_order_jobs', {
  preOrderId: integer('pre_order_id').notNull().references(() => preOrders.id, { onDelete: 'cascade' }),
  jobId: integer('job_id').notNull().references(() => maintenanceJobs.id, { onDelete: 'restrict' }),
  costoEstimado: numeric('costo_estimado', { precision: 15, scale: 2 }).notNull().default('0'),
});

export const preOrderParts = pgTable('pre_order_parts', {
  preOrderId: integer('pre_order_id').notNull().references(() => preOrders.id, { onDelete: 'cascade' }),
  partId: integer('part_id').notNull().references(() => parts.id, { onDelete: 'restrict' }),
  cantidad: numeric('cantidad', { precision: 12, scale: 3 }).notNull().default('1'),
  costoEstimado: numeric('costo_estimado', { precision: 15, scale: 2 }).notNull().default('0'),
});

export const workOrders = pgTable('work_orders', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  numero: varchar('numero', { length: 20 }).notNull().unique(),
  vehicleId: integer('vehicle_id').notNull().references(() => vehicles.id, { onDelete: 'restrict' }),
  preOrderId: integer('pre_order_id').references(() => preOrders.id, { onDelete: 'set null' }),
  routineId: integer('routine_id').references(() => maintenanceRoutines.id, { onDelete: 'set null' }),
  fechaIngresoTaller: timestamp('fecha_ingreso_taller', { withTimezone: true }).notNull().defaultNow(),
  fechaOrden: date('fecha_orden').notNull().defaultNow(),
  posibleCierre: date('posible_cierre'),
  medicionIngreso: integer('medicion_ingreso'),
  proveedorId: integer('proveedor_id').references(() => users.id),
  tipoTrabajo: woTipoEnum('tipo_trabajo').notNull().default('preventivo'),
  falla: text('falla'),
  conductorId: integer('conductor_id').references(() => users.id),
  observaciones: text('observaciones'),
  estado: woEstadoEnum('estado').notNull().default('abierta'),
  fechaCierreTecnica: timestamp('fecha_cierre_tecnica', { withTimezone: true }),
  fechaCierreFinal: timestamp('fecha_cierre_final', { withTimezone: true }),
  garantia: boolean('garantia').notNull().default(false),
  metodoPago: varchar('metodo_pago', { length: 20 }),
  costoTotalCalculado: numeric('costo_total_calculado', { precision: 15, scale: 2 }),
  creadoPor: integer('creado_por').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const woJobs = pgTable('wo_jobs', {
  id: serial('id').primaryKey(),
  woId: bigint('wo_id', { mode: 'number' }).notNull().references(() => workOrders.id, { onDelete: 'cascade' }),
  jobId: integer('job_id').notNull().references(() => maintenanceJobs.id, { onDelete: 'restrict' }),
  mechanicId: integer('mechanic_id').references(() => users.id),
  tiempoRealHoras: numeric('tiempo_real_horas', { precision: 6, scale: 2 }),
  costoManoObra: numeric('costo_mano_obra', { precision: 15, scale: 2 }).notNull().default('0'),
  notas: text('notas'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const woParts = pgTable('wo_parts', {
  id: serial('id').primaryKey(),
  woId: bigint('wo_id', { mode: 'number' }).notNull().references(() => workOrders.id, { onDelete: 'cascade' }),
  partId: integer('part_id').notNull().references(() => parts.id, { onDelete: 'restrict' }),
  cantidad: numeric('cantidad', { precision: 12, scale: 3 }).notNull(),
  valorUnit: numeric('valor_unit', { precision: 15, scale: 4 }),
  descuento: numeric('descuento', { precision: 15, scale: 2 }).notNull().default('0'),
  ubicacionId: integer('ubicacion_id').references(() => partsLocations.id, { onDelete: 'restrict' }),
  aplicadoStock: boolean('aplicado_stock').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const woSeguimientos = pgTable('wo_seguimientos', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  woId: bigint('wo_id', { mode: 'number' }).notNull().references(() => workOrders.id, { onDelete: 'cascade' }),
  texto: text('texto'),
  archivos: jsonb('archivos').notNull().default(sql`'[]'::jsonb`),
  autorId: integer('autor_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const woOtrosGastos = pgTable('wo_otros_gastos', {
  id: serial('id').primaryKey(),
  woId: bigint('wo_id', { mode: 'number' }).notNull().references(() => workOrders.id, { onDelete: 'cascade' }),
  concepto: varchar('concepto', { length: 150 }).notNull(),
  monto: numeric('monto', { precision: 15, scale: 2 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// TRAM-INNOV-B5-MVP (mig 0091) — liquidación + pago MANUAL (sin pasarela).
export const liquidaciones = pgTable('liquidaciones', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  woId: bigint('wo_id', { mode: 'number' }).references(() => workOrders.id, { onDelete: 'set null' }),
  tramiteId: integer('tramite_id').references(() => tramitesDigitales.id, { onDelete: 'set null' }),
  estado: varchar('estado', { length: 20 }).notNull().default('borrador'),
  total: numeric('total', { precision: 15, scale: 2 }).notNull().default('0'),
  nota: text('nota'),
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  confirmadaAt: timestamp('confirmada_at', { withTimezone: true }),
}, (t) => ({
  woIdx: index('idx_liquidaciones_wo').on(t.woId),
  tramiteIdx: index('idx_liquidaciones_tramite').on(t.tramiteId),
}));

export const liquidacionItems = pgTable('liquidacion_items', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  liquidacionId: bigint('liquidacion_id', { mode: 'number' }).notNull().references(() => liquidaciones.id, { onDelete: 'cascade' }),
  descripcion: varchar('descripcion', { length: 200 }).notNull(),
  cantidad: numeric('cantidad', { precision: 12, scale: 2 }).notNull().default('1'),
  valorUnitario: numeric('valor_unitario', { precision: 15, scale: 2 }).notNull().default('0'),
  subtotal: numeric('subtotal', { precision: 15, scale: 2 }).notNull().default('0'),
}, (t) => ({
  liqIdx: index('idx_liquidacion_items_liq').on(t.liquidacionId),
}));

export const pagos = pgTable('pagos', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  liquidacionId: bigint('liquidacion_id', { mode: 'number' }).notNull().references(() => liquidaciones.id, { onDelete: 'cascade' }),
  metodo: varchar('metodo', { length: 20 }).notNull().default('manual'),
  estado: varchar('estado', { length: 20 }).notNull().default('manual_confirmado'),
  monto: numeric('monto', { precision: 15, scale: 2 }).notNull(),
  referencia: varchar('referencia', { length: 120 }),
  nota: text('nota'),
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  liqIdx: index('idx_pagos_liquidacion').on(t.liquidacionId),
}));

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
  hora: varchar('hora', { length: 8 }),
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
  gradoAlcohol: integer('grado_alcohol').notNull().default(0),
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
  prioridad: integer('prioridad').notNull().default(100),
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

// ============================================================
// Sprint 4 Fase 4.1 — RNDC (Registro Nacional de Despachos de Carga, Mintransporte)
// ============================================================
export const naturalezaCargaEnum = pgEnum('naturaleza_carga', [
  'carga_normal', 'carga_peligrosa', 'carga_refrigerada',
  'carga_extradimensionada', 'carga_extrapesada',
]);
export const monedaRndcEnum = pgEnum('moneda_rndc', ['COP', 'USD']);
export const tenedorTipoEnum = pgEnum('tenedor_tipo', ['propietario', 'poseedor', 'tenedor']);
export const tipoDocRndcEnum = pgEnum('tipo_doc_rndc', ['CC', 'CE', 'NIT', 'PAS', 'TI', 'RC']);
export const remesaEstadoEnum = pgEnum('remesa_estado', ['borrador', 'activa', 'cumplida', 'anulada']);
export const manifiestoEstadoEnum = pgEnum('manifiesto_estado', [
  'borrador', 'listo', 'radicado_rndc', 'aceptado', 'rechazado', 'cumplido', 'anulado',
]);
export const titularPagoTipoEnum = pgEnum('titular_pago_tipo', ['propietario', 'conductor', 'empresa', 'tercero']);

export const rndcMunicipios = pgTable('rndc_municipios', {
  codigoDane: varchar('codigo_dane', { length: 5 }).primaryKey(),
  nombre: varchar('nombre', { length: 120 }).notNull(),
  departamentoCodigo: varchar('departamento_codigo', { length: 2 }).notNull(),
  departamentoNombre: varchar('departamento_nombre', { length: 80 }).notNull(),
  vigente: boolean('vigente').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const rndcProductosTransportar = pgTable('rndc_productos_transportar', {
  codigo: varchar('codigo', { length: 10 }).primaryKey(),
  nombre: varchar('nombre', { length: 200 }).notNull(),
  naturaleza: naturalezaCargaEnum('naturaleza').notNull().default('carga_normal'),
  unidadMedidaDefault: varchar('unidad_medida_default', { length: 10 }),
  vigente: boolean('vigente').notNull().default(true),
});

export const rndcEmpaques = pgTable('rndc_empaques', {
  codigo: varchar('codigo', { length: 10 }).primaryKey(),
  nombre: varchar('nombre', { length: 80 }).notNull(),
  vigente: boolean('vigente').notNull().default(true),
});

export const rndcUnidadesMedida = pgTable('rndc_unidades_medida', {
  codigo: varchar('codigo', { length: 10 }).primaryKey(),
  nombre: varchar('nombre', { length: 80 }).notNull(),
  factorConversionKg: numeric('factor_conversion_kg', { precision: 14, scale: 6 }),
  vigente: boolean('vigente').notNull().default(true),
});

export const rndcModosPago = pgTable('rndc_modos_pago', {
  codigo: varchar('codigo', { length: 10 }).primaryKey(),
  nombre: varchar('nombre', { length: 80 }).notNull(),
  vigente: boolean('vigente').notNull().default(true),
});

export const tenedores = pgTable('tenedores', {
  id: serial('id').primaryKey(),
  tipo: tenedorTipoEnum('tipo').notNull().default('tenedor'),
  tipoDoc: tipoDocRndcEnum('tipo_doc').notNull(),
  documento: varchar('documento', { length: 20 }).notNull(),
  nombre: varchar('nombre', { length: 200 }).notNull(),
  direccion: varchar('direccion', { length: 300 }),
  ciudadDane: varchar('ciudad_dane', { length: 5 }).references(() => rndcMunicipios.codigoDane),
  telefono: varchar('telefono', { length: 40 }),
  email: varchar('email', { length: 150 }),
  vinculadoUserId: integer('vinculado_user_id').references(() => users.id),
  activo: boolean('activo').notNull().default(true),
  notas: text('notas'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: integer('created_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const propietariosCarga = pgTable('propietarios_carga', {
  id: serial('id').primaryKey(),
  tipoDoc: tipoDocRndcEnum('tipo_doc').notNull(),
  documento: varchar('documento', { length: 20 }).notNull(),
  nombre: varchar('nombre', { length: 200 }).notNull(),
  direccion: varchar('direccion', { length: 300 }),
  ciudadDane: varchar('ciudad_dane', { length: 5 }).references(() => rndcMunicipios.codigoDane),
  telefono: varchar('telefono', { length: 40 }),
  email: varchar('email', { length: 150 }),
  clientId: integer('client_id').references(() => clients.id),
  activo: boolean('activo').notNull().default(true),
  notas: text('notas'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: integer('created_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const destinatariosCarga = pgTable('destinatarios_carga', {
  id: serial('id').primaryKey(),
  tipoDoc: tipoDocRndcEnum('tipo_doc').notNull(),
  documento: varchar('documento', { length: 20 }).notNull(),
  nombre: varchar('nombre', { length: 200 }).notNull(),
  direccion: varchar('direccion', { length: 300 }),
  ciudadDane: varchar('ciudad_dane', { length: 5 }).references(() => rndcMunicipios.codigoDane),
  telefono: varchar('telefono', { length: 40 }),
  email: varchar('email', { length: 150 }),
  activo: boolean('activo').notNull().default(true),
  notas: text('notas'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: integer('created_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const remesas = pgTable('remesas', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  numero: varchar('numero', { length: 30 }).notNull().unique(),
  consecutivoRndc: varchar('consecutivo_rndc', { length: 30 }),
  clientId: integer('cliente_id').references(() => clients.id),
  propietarioCargaId: integer('propietario_carga_id').references(() => propietariosCarga.id),
  destinatarioCargaId: integer('destinatario_carga_id').references(() => destinatariosCarga.id),
  municipioOrigenDane: varchar('municipio_origen_dane', { length: 5 }).notNull().references(() => rndcMunicipios.codigoDane),
  municipioDestinoDane: varchar('municipio_destino_dane', { length: 5 }).notNull().references(() => rndcMunicipios.codigoDane),
  direccionCargue: varchar('direccion_cargue', { length: 300 }),
  direccionDescargue: varchar('direccion_descargue', { length: 300 }),
  productoCodigo: varchar('producto_codigo', { length: 10 }).references(() => rndcProductosTransportar.codigo),
  naturaleza: naturalezaCargaEnum('naturaleza').notNull().default('carga_normal'),
  empaqueCodigo: varchar('empaque_codigo', { length: 10 }).references(() => rndcEmpaques.codigo),
  unidadMedidaCodigo: varchar('unidad_medida_codigo', { length: 10 }).references(() => rndcUnidadesMedida.codigo),
  cantidadCargada: numeric('cantidad_cargada', { precision: 14, scale: 3 }).notNull(),
  cantidadEntregada: numeric('cantidad_entregada', { precision: 14, scale: 3 }),
  pesoKg: numeric('peso_kg', { precision: 14, scale: 3 }),
  fechaCargue: date('fecha_cargue').notNull(),
  horaCargue: varchar('hora_cargue', { length: 8 }),
  fechaDescargePactada: date('fecha_descargue_pactada'),
  valorFlete: numeric('valor_flete', { precision: 15, scale: 2 }).notNull().default('0'),
  valorAnticipo: numeric('valor_anticipo', { precision: 15, scale: 2 }).notNull().default('0'),
  moneda: monedaRndcEnum('moneda').notNull().default('COP'),
  modoPagoCodigo: varchar('modo_pago_codigo', { length: 10 }).references(() => rndcModosPago.codigo),
  estado: remesaEstadoEnum('estado').notNull().default('borrador'),
  manifiestoId: bigint('manifiesto_id', { mode: 'number' }),
  cumplidoAt: timestamp('cumplido_at', { withTimezone: true }),
  cumplidoObservaciones: text('cumplido_observaciones'),
  cumplidoEvidenciaKeys: text('cumplido_evidencia_keys').array().notNull().default(sql`'{}'::text[]`),
  observaciones: text('observaciones'),
  // Estado envío RNDC (Fase 4.2)
  estadoEnvio: varchar('estado_envio', { length: 30 }).notNull().default('no_aplica'),
  intentosEnvio: smallint('intentos_envio').notNull().default(0),
  ultimoIntentoAt: timestamp('ultimo_intento_at', { withTimezone: true }),
  proximoIntentoAt: timestamp('proximo_intento_at', { withTimezone: true }),
  ultimoError: text('ultimo_error'),
  rowVersion: integer('row_version').notNull().default(1),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: integer('deleted_by').references(() => users.id),
  createdBy: integer('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const manifiestos = pgTable('manifiestos', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  numero: varchar('numero', { length: 30 }).notNull().unique(),
  consecutivoRndc: varchar('consecutivo_rndc', { length: 30 }),
  vehiculoPrincipalId: integer('vehiculo_principal_id').notNull().references(() => vehicles.id),
  vehiculoRemolqueId: integer('vehiculo_remolque_id').references(() => vehicles.id),
  conductorId: integer('conductor_id').notNull().references(() => users.id),
  tenedorId: integer('tenedor_id').references(() => tenedores.id),
  municipioOrigenDane: varchar('municipio_origen_dane', { length: 5 }).notNull().references(() => rndcMunicipios.codigoDane),
  municipioDestinoDane: varchar('municipio_destino_dane', { length: 5 }).notNull().references(() => rndcMunicipios.codigoDane),
  fechaExpedicion: date('fecha_expedicion').notNull(),
  fechaPactadaPago: date('fecha_pactada_pago'),
  valorFleteTotal: numeric('valor_flete_total', { precision: 15, scale: 2 }).notNull().default('0'),
  valorAnticipo: numeric('valor_anticipo', { precision: 15, scale: 2 }).notNull().default('0'),
  retencionFuente: numeric('retencion_fuente', { precision: 15, scale: 2 }).notNull().default('0'),
  retencionIca: numeric('retencion_ica', { precision: 15, scale: 2 }).notNull().default('0'),
  titularPagoTipo: titularPagoTipoEnum('titular_pago_tipo').notNull().default('conductor'),
  titularPagoDoc: varchar('titular_pago_doc', { length: 20 }),
  titularPagoNombre: varchar('titular_pago_nombre', { length: 200 }),
  // PII cifrado AES-256-GCM (Ola C-1 2026-05-05). Columna *_legacy_plain dropeada en 0052 (Lote 11 2026-05-06).
  titularPagoCuentaCipher: bytea('titular_pago_cuenta_cipher'),
  titularPagoCuentaIv: bytea('titular_pago_cuenta_iv'),
  titularPagoCuentaAuthTag: bytea('titular_pago_cuenta_auth_tag'),
  titularPagoCuentaAadNonce: uuid('titular_pago_cuenta_aad_nonce'),
  titularPagoCuentaKeyVersion: smallint('titular_pago_cuenta_key_version'),
  observaciones: text('observaciones'),
  qrToken: varchar('qr_token', { length: 64 }).unique(),
  estado: manifiestoEstadoEnum('estado').notNull().default('borrador'),
  rechazoMotivo: text('rechazo_motivo'),
  anuladoMotivo: text('anulado_motivo'),
  anuladoPor: integer('anulado_por').references(() => users.id),
  anuladoAt: timestamp('anulado_at', { withTimezone: true }),
  radicadoAt: timestamp('radicado_at', { withTimezone: true }),
  aceptadoAt: timestamp('aceptado_at', { withTimezone: true }),
  cumplidoAt: timestamp('cumplido_at', { withTimezone: true }),
  // Estado envío RNDC (Fase 4.2)
  estadoEnvio: varchar('estado_envio', { length: 30 }).notNull().default('no_aplica'),
  intentosEnvio: smallint('intentos_envio').notNull().default(0),
  ultimoIntentoAt: timestamp('ultimo_intento_at', { withTimezone: true }),
  proximoIntentoAt: timestamp('proximo_intento_at', { withTimezone: true }),
  ultimoError: text('ultimo_error'),
  rowVersion: integer('row_version').notNull().default(1),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: integer('deleted_by').references(() => users.id),
  createdBy: integer('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const manifiestoRemesas = pgTable('manifiesto_remesas', {
  manifiestoId: bigint('manifiesto_id', { mode: 'number' }).notNull().references(() => manifiestos.id, { onDelete: 'cascade' }),
  remesaId: bigint('remesa_id', { mode: 'number' }).notNull().references(() => remesas.id),
  orden: integer('orden').notNull().default(1),
});

// ============================================================================
// Sprint 4 Fase 4.2 — RNDC envío, WORM operaciones, credenciales cifradas
// ============================================================================

export const rndcOpTipoEnum = pgEnum('rndc_op_tipo', [
  'ingresarRemesa', 'ingresarManifiesto', 'anularManifiesto',
  'anularRemesa', 'consultarEstadoIngreso', 'cumplirManifiesto',
]);
export const rndcOpResultadoEnum = pgEnum('rndc_op_resultado', [
  'ok', 'error_negocio', 'error_tecnico', 'timeout',
]);
export const rndcEstadoEnvioEnum = pgEnum('rndc_estado_envio', [
  'no_aplica', 'pendiente_envio', 'enviando', 'aceptado',
  'error_envio', 'fallido_temporal', 'fallido_definitivo', 'cancelado_pre_envio',
]);
export const outboxEstadoEnum = pgEnum('outbox_estado', [
  'pendiente', 'enviado', 'error', 'fallido_definitivo',
]);

// WORM: append-only. Triggers en BD prohíben UPDATE/DELETE.
// El repo solo expone insert() y query() — capa de aplicación refuerza.
export const rndcOperaciones = pgTable('rndc_operaciones', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tipoOp: rndcOpTipoEnum('tipo_op').notNull(),
  entidadTipo: varchar('entidad_tipo', { length: 20 }).notNull(),
  entidadId: integer('entidad_id').notNull(),
  intento: smallint('intento').notNull().default(1),
  modo: varchar('modo', { length: 10 }).notNull(),
  requestXml: text('request_xml'),
  responseXml: text('response_xml'),
  resultado: rndcOpResultadoEnum('resultado').notNull(),
  codigoResultado: varchar('codigo_resultado', { length: 10 }),
  consecutivoRndc: varchar('consecutivo_rndc', { length: 30 }),
  mensaje: text('mensaje'),
  duracionMs: integer('duracion_ms'),
  ipOrigen: varchar('ip_origen', { length: 45 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: integer('created_by').references(() => users.id),
}, (t) => ({
  byEntidad: index('idx_rndc_op_entidad').on(t.entidadTipo, t.entidadId, t.createdAt),
  byTipoResultado: index('idx_rndc_op_tipo_resultado').on(t.tipoOp, t.resultado),
}));

// Credenciales cifradas AES-256-GCM. AAD vincula cipher a esta fila vía aad_nonce UUID.
export const rndcCredenciales = pgTable('rndc_credenciales', {
  id: serial('id').primaryKey(),
  empresaNit: varchar('empresa_nit', { length: 20 }).notNull(),
  habilitadorNit: varchar('habilitador_nit', { length: 20 }).notNull(),
  numNit: varchar('num_nit', { length: 20 }).notNull(),
  claveQrCipher: bytea('clave_qr_cipher').notNull(),
  claveQrIv: bytea('clave_qr_iv').notNull(),
  claveQrAuthTag: bytea('clave_qr_auth_tag').notNull(),
  aadNonce: uuid('aad_nonce').notNull(),
  keyVersion: smallint('key_version').notNull().default(1),
  ambiente: varchar('ambiente', { length: 10 }).notNull().default('sandbox'),
  activo: boolean('activo').notNull().default(true),
  notas: text('notas'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: integer('created_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: integer('updated_by').references(() => users.id),
});

// Idempotencia persistida. Reemplaza al Map en memoria del mock (que no sobrevive restart).
export const rndcIdempotencyKeys = pgTable('rndc_idempotency_keys', {
  consecutivoLocal: varchar('consecutivo_local', { length: 40 }).primaryKey(),
  entidadTipo: varchar('entidad_tipo', { length: 20 }).notNull(),
  entidadId: integer('entidad_id').notNull(),
  requestHash: varchar('request_hash', { length: 64 }).notNull(),
  consecutivoRndc: varchar('consecutivo_rndc', { length: 30 }),
  resultado: varchar('resultado', { length: 20 }),
  modo: varchar('modo', { length: 10 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Outbox transaccional para emails (anti pérdida silenciosa de notificaciones).
export const notificationOutbox = pgTable('notification_outbox', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  canal: varchar('canal', { length: 20 }).notNull().default('email'),
  destinatarios: text('destinatarios').notNull(), // JSON array de emails
  asunto: text('asunto').notNull(),
  cuerpoHtml: text('cuerpo_html').notNull(),
  cuerpoTexto: text('cuerpo_texto'),
  estado: outboxEstadoEnum('estado').notNull().default('pendiente'),
  intentos: smallint('intentos').notNull().default(0),
  ultimoIntentoAt: timestamp('ultimo_intento_at', { withTimezone: true }),
  proximoIntentoAt: timestamp('proximo_intento_at', { withTimezone: true }),
  ultimoError: text('ultimo_error'),
  messageId: text('message_id'),
  enviadoAt: timestamp('enviado_at', { withTimezone: true }),
  contextoTipo: varchar('contexto_tipo', { length: 40 }),
  contextoId: integer('contexto_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: integer('created_by').references(() => users.id),
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

export const piiAccessLog = pgTable('pii_access_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: integer('user_id').references(() => users.id),
  userRole: varchar('user_role', { length: 40 }),
  resourceTipo: varchar('resource_tipo', { length: 50 }).notNull(),
  resourceId: integer('resource_id'),
  accion: varchar('accion', { length: 20 }).notNull(),
  camposAccedidos: text('campos_accedidos').array().notNull().default(sql`ARRAY[]::text[]`),
  motivo: varchar('motivo', { length: 200 }),
  ipOrigen: varchar('ip_origen', { length: 45 }),
  userAgent: text('user_agent'),
  requestId: uuid('request_id'),
  accessedAt: timestamp('accessed_at', { withTimezone: true }).notNull().defaultNow(),
});

// RUM — Web Vitals de campo (FIONA PR2). Append-only; endpoint público /api/rum.
export const rumWebVitals = pgTable('rum_web_vitals', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  metric: varchar('metric', { length: 8 }).notNull(),
  value: doublePrecision('value').notNull(),
  rating: varchar('rating', { length: 20 }),
  route: varchar('route', { length: 200 }),
  navType: varchar('nav_type', { length: 24 }),
  device: varchar('device', { length: 12 }),
  conn: varchar('conn', { length: 12 }),
  sessionId: varchar('session_id', { length: 40 }),
  ipOrigen: varchar('ip_origen', { length: 45 }),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

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

// ════════════════════════════════════════════════════════════════════════════
// FLITO — SOAT e Impuestos (migración packages/ → Operaciones)
// Ver docs/MIGRACION_FLITO_A_OPERACIONES.md §5. Dominio anclado al VIN (SOAT) y al
// trámite (Impuestos). Los estados y campos OCR viven en @operaciones/shared-types.
// FK a entidades del grande son `integer` (clients/vehicles/users) o `varchar(5)`
// (organismos_transito_config.codigo); las entidades internas FLITO usan `uuid`.
// ════════════════════════════════════════════════════════════════════════════

export const flitoSoatEstadoEnum = pgEnum('flito_soat_estado', ['pendiente', 'en_adquisicion', 'pagado', 'rechazado']);
export const flitoImpuestoEstadoEnum = pgEnum('flito_impuesto_estado', ['sin_factura', 'retenido', 'pendiente', 'en_gestion', 'pagado', 'rechazado', 'no_aplica']);
export const flitoTramiteEstadoEnum = pgEnum('flito_tramite_estado', ['asignado', 'entregado', 'aprobado', 'anulado', 'rechazado']);
export const flitoModalidadEnum = pgEnum('flito_modalidad_organismo', ['sin_clasificar', 'requiere_gestion', 'autogestionado']);

// Proveedor que adquiere el SOAT (RN-05: determina la estrategia de flujo).
export const flitoProveedoresSoat = pgTable('flito_proveedores_soat', {
  id: uuid('id').primaryKey().defaultRandom(),
  nombre: varchar('nombre', { length: 150 }).notNull().unique(),
  estrategia: varchar('estrategia', { length: 40 }).notNull().default('portal'),
  umbralOcr: numeric('umbral_ocr', { precision: 4, scale: 3 }),
  slaHoras: integer('sla_horas'),
  activo: boolean('activo').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

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

// SOAT anclado al VIN (RN-01: un SOAT por VIN — `vin` UNIQUE lo hace por construcción).
export const flitoSoat = pgTable('flito_soat', {
  id: uuid('id').primaryKey().defaultRandom(),
  vin: varchar('vin', { length: 17 }).notNull().unique(),
  vehiculoId: integer('vehiculo_id').notNull().unique().references(() => vehicles.id),
  estado: flitoSoatEstadoEnum('estado').notNull().default('pendiente'),
  // Denormalizados y congelados: el SOAT vive más que sus trámites.
  companiaId: integer('compania_id').notNull().references(() => clients.id),
  organismoCodigo: varchar('organismo_codigo', { length: 5 }).notNull().references(() => organismosTransitoConfig.codigo),
  proveedorSoatId: uuid('proveedor_soat_id').references(() => flitoProveedoresSoat.id),
  proveedorSobrescrito: boolean('proveedor_sobrescrito').notNull().default(false),
  enviadoPorId: integer('enviado_por_id').references(() => users.id),
  enviadoEn: timestamp('enviado_en', { withTimezone: true }),
  pagadoEn: timestamp('pagado_en', { withTimezone: true }),
  valorPagado: numeric('valor_pagado', { precision: 14, scale: 2 }),
  motivoRechazo: text('motivo_rechazo'),
  extraccion: jsonb('extraccion').$type<ExtraccionSoat>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  estadoIdx: index('idx_flito_soat_estado').on(t.estado),
  proveedorIdx: index('idx_flito_soat_proveedor').on(t.proveedorSoatId),
}));

// Trámite sincronizado desde FLIT. Llave real: id_flit. Coexiste con tramites_digitales.
export const flitoTramites = pgTable('flito_tramites', {
  id: uuid('id').primaryKey().defaultRandom(),
  idFlit: varchar('id_flit', { length: 60 }).notNull().unique(),
  estado: flitoTramiteEstadoEnum('estado').notNull(),
  tipoPropiedad: varchar('tipo_propiedad', { length: 30 }).notNull(),
  companiaId: integer('compania_id').notNull().references(() => clients.id),
  organismoCodigo: varchar('organismo_codigo', { length: 5 }).notNull().references(() => organismosTransitoConfig.codigo),
  vehiculoId: integer('vehiculo_id').notNull().references(() => vehicles.id),
  // Muchos trámites → un SOAT (por VIN). Sostiene CA-03 (anular+recrear no re-adquiere).
  soatId: uuid('soat_id').references(() => flitoSoat.id),
  valorImpuestoLiquidado: numeric('valor_impuesto_liquidado', { precision: 14, scale: 2 }),
  processStatus: integer('process_status').notNull(),
  plateComplete: varchar('plate_complete', { length: 20 }),
  sincronizadoEn: timestamp('sincronizado_en', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  estadoIdx: index('idx_flito_tramites_estado').on(t.estado),
}));

// Impuesto, uno por trámite (tramite_id UNIQUE).
export const flitoImpuestos = pgTable('flito_impuestos', {
  id: uuid('id').primaryKey().defaultRandom(),
  tramiteId: uuid('tramite_id').notNull().unique().references(() => flitoTramites.id),
  estado: flitoImpuestoEstadoEnum('estado').notNull().default('sin_factura'),
  organismoCodigo: varchar('organismo_codigo', { length: 5 }).notNull().references(() => organismosTransitoConfig.codigo),
  companiaId: integer('compania_id').notNull().references(() => clients.id),
  // Snapshot de la modalidad al crear el registro (CA-04).
  modalidadAplicada: flitoModalidadEnum('modalidad_aplicada').notNull(),
  valorLiquidado: numeric('valor_liquidado', { precision: 14, scale: 2 }),
  valorPagado: numeric('valor_pagado', { precision: 14, scale: 2 }),
  marcadoPorDiferencia: boolean('marcado_por_diferencia').notNull().default(false),
  // Factura de venta = precondición del envío. Referencia por id (sin FK dura: evita
  // ciclo con flito_soportes, igual que en el modelo original).
  facturaVentaSoporteId: uuid('factura_venta_soporte_id'),
  extraccionFacturaVenta: jsonb('extraccion_factura_venta').$type<ExtraccionFacturaVenta>(),
  enviadoPorId: integer('enviado_por_id').references(() => users.id),
  enviadoEn: timestamp('enviado_en', { withTimezone: true }),
  pagadoEn: timestamp('pagado_en', { withTimezone: true }),
  motivoRechazo: text('motivo_rechazo'),
  extraccion: jsonb('extraccion').$type<ExtraccionImpuesto>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  estadoIdx: index('idx_flito_impuestos_estado').on(t.estado),
  organismoIdx: index('idx_flito_impuestos_organismo').on(t.organismoCodigo),
}));

// Comprador(es) del vehículo. Múltiple propietario → varias filas (orden 0 = principal).
export const flitoCompradores = pgTable('flito_compradores', {
  id: uuid('id').primaryKey().defaultRandom(),
  tramiteId: uuid('tramite_id').notNull().references(() => flitoTramites.id, { onDelete: 'cascade' }),
  nombreCompleto: varchar('nombre_completo', { length: 200 }).notNull(),
  numeroDocumento: varchar('numero_documento', { length: 30 }).notNull(),
  correo: varchar('correo', { length: 150 }),
  celular: varchar('celular', { length: 30 }),
  direccion: varchar('direccion', { length: 300 }),
  orden: integer('orden').notNull().default(0),
  porcentajeParticipacion: numeric('porcentaje_participacion', { precision: 5, scale: 2 }),
}, (t) => ({
  tramiteIdx: index('idx_flito_compradores_tramite').on(t.tramiteId),
}));

// Soporte (archivo) en S3: storage_key sustituye a driveItemId+ruta (decisión D-3).
export const flitoSoportes = pgTable('flito_soportes', {
  id: uuid('id').primaryKey().defaultRandom(),
  tipo: varchar('tipo', { length: 40 }).notNull(),
  nombreArchivo: varchar('nombre_archivo', { length: 300 }).notNull(),
  contentType: varchar('content_type', { length: 100 }).notNull(),
  storageKey: varchar('storage_key', { length: 500 }).notNull(),
  hash: varchar('hash', { length: 64 }).notNull(),
  tamanoBytes: bigint('tamano_bytes', { mode: 'number' }).notNull(),
  soatId: uuid('soat_id').references(() => flitoSoat.id, { onDelete: 'cascade' }),
  impuestoId: uuid('impuesto_id').references(() => flitoImpuestos.id, { onDelete: 'cascade' }),
  subidoPorId: integer('subido_por_id').references(() => users.id),
  subidoPorNombre: varchar('subido_por_nombre', { length: 150 }).notNull(),
  subidoEn: timestamp('subido_en', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  hashIdx: index('idx_flito_soportes_hash').on(t.hash),
}));

// Cola de revisión OCR (CA-06/CA-07). Los gestores no la resuelven (RN-04/RN-05).
export const flitoRevisiones = pgTable('flito_revisiones', {
  id: uuid('id').primaryKey().defaultRandom(),
  modulo: varchar('modulo', { length: 20 }).notNull(),
  motivo: varchar('motivo', { length: 40 }).notNull(),
  detalle: text('detalle').notNull(),
  registroId: uuid('registro_id'),
  soporteId: uuid('soporte_id').notNull().references(() => flitoSoportes.id, { onDelete: 'cascade' }),
  placaSugerida: varchar('placa_sugerida', { length: 10 }),
  extraccion: jsonb('extraccion').notNull(),
  resuelto: boolean('resuelto').notNull().default(false),
  resueltoPorId: integer('resuelto_por_id').references(() => users.id),
  resueltoEn: timestamp('resuelto_en', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  resueltoIdx: index('idx_flito_revisiones_resuelto').on(t.resuelto),
}));

// Regla de enrutamiento a proveedor SOAT por ámbito (compañía 10 / organismo 20 / global 30).
export const flitoReglasProveedorSoat = pgTable('flito_reglas_proveedor_soat', {
  id: uuid('id').primaryKey().defaultRandom(),
  ambito: varchar('ambito', { length: 20 }).notNull(),
  companiaId: integer('compania_id').references(() => clients.id, { onDelete: 'cascade' }),
  organismoCodigo: varchar('organismo_codigo', { length: 5 }).references(() => organismosTransitoConfig.codigo, { onDelete: 'cascade' }),
  proveedorSoatId: uuid('proveedor_soat_id').notNull().references(() => flitoProveedoresSoat.id, { onDelete: 'cascade' }),
  prioridad: integer('prioridad').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Andamiaje del FLIT simulado (NO es dominio FLITO). Referencia compañía/organismo por
// llaves EXTERNAS (nit, código), sin FK. Se retira cuando exista el adaptador FLIT real.
export const flitoMockTramite = pgTable('flito_mock_tramite', {
  id: uuid('id').primaryKey().defaultRandom(),
  idFlit: varchar('id_flit', { length: 60 }).notNull().unique(),
  processStatus: integer('process_status').notNull(),
  plateComplete: varchar('plate_complete', { length: 20 }),
  vin: varchar('vin', { length: 17 }).notNull(),
  placa: varchar('placa', { length: 10 }).notNull(),
  marca: varchar('marca', { length: 60 }).notNull(),
  linea: varchar('linea', { length: 80 }).notNull(),
  cilindraje: integer('cilindraje').notNull(),
  capacidad: integer('capacidad').notNull(),
  tipoVehiculo: varchar('tipo_vehiculo', { length: 40 }).notNull(),
  companiaNit: varchar('compania_nit', { length: 20 }).notNull(),
  organismoCodigo: varchar('organismo_codigo', { length: 10 }).notNull(),
  tipoPropiedad: varchar('tipo_propiedad', { length: 30 }).notNull(),
  compradores: jsonb('compradores').notNull(),
  valorImpuestoLiquidado: numeric('valor_impuesto_liquidado', { precision: 14, scale: 2 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
