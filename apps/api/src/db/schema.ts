import { pgTable, serial, varchar, text, boolean, timestamp, time, integer, bigint, date, pgEnum, index, uniqueIndex, jsonb, numeric, bigserial, smallserial, uuid, customType, smallint, doublePrecision, primaryKey, check } from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() { return 'bytea'; },
});
import { sql, desc } from 'drizzle-orm';
// FLITO (migración): tipos de extracción OCR persistidos en columnas jsonb.
import type { ExtraccionSoat, ExtraccionImpuesto, ExtraccionFacturaVenta, ExtraccionDerechoTramite } from '@operaciones/shared-types';
// Certificación de impuestos contra el RUNT (Feature #11159): detalle por campo en columna jsonb.
import type { ComparacionCampo } from '@operaciones/shared-types';
// Entrega de la factura por correo (HU #11334): destinatarios con su procedencia, en columna jsonb.
import type { SiigoDestinatario } from '@operaciones/shared-types';
// SOAT canal Cliente (HU #12093): de dónde salió cada dato del propietario, en columna jsonb.
import type { ProcedenciaCompradorPersistida } from '@operaciones/shared-types';

// El valor 'operaciones' sigue existiendo en el enum de Postgres (deprecado, sin usuarios) pero se
// omite del literal para que users.role no lo incluya a nivel de tipos: el operador FLITO ES admin.
// `cliente` lo añade la migración 0167 (Feature #11912): usuario de una compañía cliente, atado a
// ella por `users.compania_id` — obligatorio para ese rol y solo para ese rol (CHECK de la 0168).
export const roleEnum = pgEnum('user_role', ['admin', 'proveedor', 'transito', 'compliance', 'lider_pesv', 'supervisor_flota', 'conductor', 'auditor', 'gestor_impuestos', 'mensajero', 'financiera', 'cliente']);

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
  // proveedor SOAT — hace cumplir CA-09 en la consulta.
  //
  // El gestor de impuestos NO vive aquí: desde la HU #12053 su atadura (CA-10) es la tabla
  // `flito_gestor_organismos`, porque son VARIOS organismos y `transito_codigo` solo guardaba uno
  // —y además es del rol `transito`—. Para un `gestor_impuestos`, `transito_codigo` queda NULL
  // desde la migración 0173: fuente única, sin segundo inquilino.
  flitoProveedorSoatId: uuid('flito_proveedor_soat_id').references((): any => flitoProveedoresSoat.id),
  /**
   * FLITO — Cliente (Feature #11912): la compañía de la que es este usuario. Es la atadura de
   * visibilidad del rol `cliente`, igual que `flitoProveedorSoatId` lo es del gestor: `contextoSoat()`
   * la lee de AQUÍ y no del JWT, para que un cambio de compañía surta efecto sin re-emitir el token.
   *
   * NULLABLE en la base a propósito, como `transitoCodigo`: 11 de los 12 roles no tienen compañía y
   * un `NOT NULL` obligaría a inventarle una a cada admin. La obligatoriedad es CONDICIONAL al rol y
   * la sostiene el CHECK `users_cliente_compania_chk` de la migración 0168
   * (`role <> 'cliente' OR compania_id IS NOT NULL`), que Drizzle no declara aquí porque nombra un
   * valor del enum añadido en la 0167 y las dos cosas no caben en la misma transacción (55P04).
   *
   * `ON DELETE RESTRICT` explícito (ADR-0008 §3): `CASCADE` borraría usuarios al borrar una
   * compañía, y `SET NULL` crearía por la puerta de atrás justo el estado que el AC2 declara
   * imposible — un `cliente` sin compañía.
   */
  // El `(): any` es el mismo truco que `flitoProveedorSoatId` de arriba, y por el mismo motivo:
  // `clients` se declara DESPUÉS de `users`, así que sin la anotación TypeScript no puede inferir el
  // tipo de ninguna de las dos tablas (TS7022) y `db.select().from(users)` degrada a `any` en todo
  // el proyecto.
  companiaId: integer('compania_id').references((): any => clients.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  sessionInvalidatedAt: timestamp('session_invalidated_at', { withTimezone: true }),
}, (t) => ({
  // Sirve al listado de usuarios por compañía y, sobre todo, al `ON DELETE RESTRICT`: sin él, borrar
  // una compañía escanea `users` entera para comprobar que nadie la referencia.
  companiaIdx: index('idx_users_compania').on(t.companiaId),
}));

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
  /**
   * FLITO — Cliente (Feature #11912): la compañía puede pedirle a FLITO el SOAT de un vehículo que
   * NO tiene trámite digital abierto. Es lo que habilita el canal del rol `cliente`.
   *
   * INDEPENDIENTE de `soatAutogestionable` y lo contrario de una sub-opción suya: aquella dice que
   * la compañía se compra el SOAT por su cuenta y que FLITO no lo gestiona; esta dice que sus
   * usuarios pueden pedírselo a FLITO sin trámite de por medio. Las dos a la vez son una
   * combinación válida y esperada, y es justo la que obliga a que la frontera de autogestión de
   * `flito-soat.service.ts` deje pasar lo que nace con `origen = 'cliente'` (ADR-0008 §5).
   *
   * Nace APAGADO (AC3): una compañía nueva no estrena canal sin que alguien lo decida.
   */
  soatSinTramite: boolean('soat_sin_tramite').notNull().default(false),
  impuestosAutogestionable: boolean('impuestos_autogestionable').notNull().default(false),
  logisticaAutogestionable: boolean('logistica_autogestionable').notNull().default(false),
  // FLITO Logística: si acepta entregas parciales (CA-08/09). Si es false, el acta se retiene
  // hasta tener todos los documentos de la empresa (Solo completo).
  logisticaPermiteParcial: boolean('logistica_permite_parcial').notNull().default(false),
  // Carpeta lógica en S3 donde se replican facturas/soportes (reinterpreta la
  // "carpeta OneDrive por compañía" del diseño original; decisión D-3).
  flitoCarpetaStorage: varchar('flito_carpeta_storage', { length: 300 }),
  // Tolerancia (en pesos) entre valor liquidado y pagado antes de marcar para revisión.
  flitoToleranciaValorImpuesto: numeric('flito_tolerancia_valor_impuesto', { precision: 14, scale: 2 }).notNull().default('0'),
  // Siigo (Feature #11241, HU #11292): lo que exige para crear el tercero. Nada de esto es
  // obligatorio para crear un cliente en FLITO; su ausencia solo impide facturarlo.
  // `documentType` sigue siendo texto libre a propósito: cerrarlo rompería filas existentes.
  personType: varchar('person_type', { length: 10 }),
  idType: varchar('id_type', { length: 10 }),
  checkDigit: smallint('check_digit'),
  fiscalResponsibilities: text('fiscal_responsibilities').array().notNull().default(sql`'{}'::text[]`),
  countryCode: varchar('country_code', { length: 2 }),
  stateCode: varchar('state_code', { length: 5 }),
  cityCode: varchar('city_code', { length: 10 }),
  commercialName: varchar('commercial_name', { length: 200 }),
  // La clave real del tercero en Siigo es (identificación, sucursal), no la identificación sola.
  branchOffice: integer('branch_office').notNull().default(0),
  contactFirstName: varchar('contact_first_name', { length: 100 }),
  contactLastName: varchar('contact_last_name', { length: 100 }),
  contactEmail: varchar('contact_email', { length: 150 }),
  phoneIndicative: varchar('phone_indicative', { length: 10 }),
  phoneNumber: varchar('phone_number', { length: 10 }),
  // Para poder auditar la derivación masiva de la 0132 y no pisar lo que clasificó una persona.
  personTypeOrigen: varchar('person_type_origen', { length: 20 }).notNull().default('sin_derivar'),
  // Rastro de quién convirtió `city` —texto libre— en códigos de Siigo (HU #11294). El texto
  // original NO se toca: es la prueba de qué decía la ficha cuando alguien decidió la equivalencia.
  cityTextoOrigen: varchar('city_texto_origen', { length: 100 }),
  cityConfirmadaPor: integer('city_confirmada_por').references(() => users.id),
  cityConfirmadaEn: timestamp('city_confirmada_en', { withTimezone: true }),
  // Lo que la migración encontró y bloquea facturar. Vacío NO significa facturable: el veredicto
  // completo lo calcula el informe de la HU #11296, que mira además dirección, contacto y ciudad.
  facturacionBloqueos: text('facturacion_bloqueos').array().notNull().default(sql`'{}'::text[]`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  documentIdx: index('idx_clients_document').on(t.document),
  documentBranchIdx: index('idx_clients_document_branch').on(t.document, t.branchOffice),
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
  // Datos técnicos que FLIT trae en el reporte de trámites y que el sync persiste en CADA corrida
  // (HU #11906, migración 0166). Viven en `vehicles` y NO en `flito_soat` porque `resolverSoat()`
  // hace `return` sin actualizar campos cuando el SOAT ya existe: ahí, un SOAT sincronizado antes
  // de esta HU no se completaría jamás. `upsertVehiculo()` corre para todos los trámites siempre.
  // Los tres son TEXTO —no integer, no enum— a propósito; el porqué está en la 0166.
  cilindraje: varchar('cilindraje', { length: 10 }),
  carroceria: varchar('carroceria', { length: 60 }),
  tipoServicio: varchar('tipo_servicio', { length: 30 }),
  /**
   * Los DOS que solo trae el RUNT (HU #11966, migración 0172). Texto por lo mismo que los tres de
   * arriba: el origen es texto de un tercero y `"0"`, `"05"` y `""` son distinguibles.
   *
   * `puertas` **la escribe solo el canal Cliente**, y eso es una regla de SERVICIO y no de esquema:
   * `vehicles` no conoce el origen del SOAT, así que no hay CHECK que lo ate. Lo que la hace cierta
   * es el export, que la lee solo para filas `origen = 'cliente'`; la fila de trámite conserva la
   * constante `'4'` de la plantilla del cliente.
   *
   * Nullable las dos: un NOT NULL exigiría un DEFAULT para las filas que ya existen, y el único
   * candidato de `puertas` sería `'4'` — escribir en la base la constante de la plantilla como si
   * fuera un dato medido, que es la mentira que el AC6 de la #11966 viene a quitar del archivo.
   */
  pasajerosSentados: varchar('pasajeros_sentados', { length: 10 }),
  puertas: varchar('puertas', { length: 5 }),
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
   * `flitoBolsaTransitoCobertura`. La columna se conserva —mismo criterio que con
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
  // HU #10952: idempotencia de la sincronización con Drive. El scope de Drive es de solo lectura,
  // así que no se puede marcar el archivo en el origen: se lleva aquí. La fecha de modificación
  // acompaña al id porque un mismo archivo puede reemplazarse en Drive conservando su id.
  organismoCodigo: varchar('organismo_codigo', { length: 5 }),
  driveModifiedTime: timestamp('drive_modified_time', { withTimezone: true }),
  /**
   * Quién tocó el archivo en el Drive por última vez (HU del cron). Se persiste, no se consulta en
   * vivo: el registro tiene que sobrevivir al archivo, y si mañana lo borran de la carpeta esta es la
   * única forma de saber quién lo había subido.
   */
  modificadoPor: varchar('modificado_por', { length: 255 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Estados de un procesamiento. Texto libre en la columna, no enum, así que añadir uno no exige
 * ALTER TYPE.
 *
 * `omitido` lo escribe el arranque del cron sobre los consolidados que ya estaban en la carpeta el
 * día que se encendió: se dan por vistos sin gastar OCR en histórico que nadie pidió. Es distinto de
 * no tener registro, que significa «no se ha mirado nunca».
 */
export const ESTADO_PROCESAMIENTO = {
  PROCESANDO: 'procesando',
  COMPLETADO: 'completado',
  ERROR: 'error',
  OMITIDO: 'omitido',
} as const;
export type EstadoProcesamiento = (typeof ESTADO_PROCESAMIENTO)[keyof typeof ESTADO_PROCESAMIENTO];

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

// Declarado aquí y no junto a los demás enums RNDC (más abajo) porque `remesas` y
// `manifiestos` lo referencian y pgTable se evalúa al cargar el módulo: dejarlo después
// daría ReferenceError por TDZ.
export const rndcEstadoEnvioEnum = pgEnum('rndc_estado_envio', [
  'no_aplica', 'pendiente_envio', 'enviando', 'aceptado',
  'error_envio', 'fallido_temporal', 'fallido_definitivo', 'cancelado_pre_envio',
]);
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
  horaCargue: time('hora_cargue'),
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
  estadoEnvio: rndcEstadoEnvioEnum('estado_envio').notNull().default('no_aplica'),
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
  estadoEnvio: rndcEstadoEnvioEnum('estado_envio').notNull().default('no_aplica'),
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
// rndcEstadoEnvioEnum se declara arriba, junto a remesaEstadoEnum (lo usan remesas y manifiestos).
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
  id: smallserial('id').primaryKey(),
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

// Estados unificados de SOAT e impuestos: pendiente | solicitado | con_novedad | pagado (ver
// flito-estados.ts). Los valores viejos (en_adquisicion, en_gestion, sin_factura, retenido,
// rechazado, no_aplica) quedan deprecados en el enum de Postgres, pero se omiten del literal.
// `pendiente_revision` y `rechazada` (migración 0167, Feature #11912) son del canal Cliente: los
// escribe la HU #11914/#11915 y el SOAT que nace del sync no pasa por ellos. Se añaden al MISMO
// enum para que una fila tenga un solo estado y `POST /enviar` (que filtra `pendiente`) siga siendo
// correcto sin tocarlo.
export const flitoSoatEstadoEnum = pgEnum('flito_soat_estado', ['pendiente', 'solicitado', 'con_novedad', 'pagado', 'pendiente_revision', 'rechazada']);
export const flitoImpuestoEstadoEnum = pgEnum('flito_impuesto_estado', ['pendiente', 'solicitado', 'con_novedad', 'pagado']);
export const flitoTramiteEstadoEnum = pgEnum('flito_tramite_estado', ['asignado', 'entregado', 'aprobado', 'anulado', 'rechazado']);
// Modalidad del organismo: requiere_gestion | autogestionado (default). 'sin_clasificar' se deprecó.
export const flitoModalidadEnum = pgEnum('flito_modalidad_organismo', ['requiere_gestion', 'autogestionado']);

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

/**
 * CA-10 (HU #12053, Feature #12052) — los organismos de tránsito que ve un `gestor_impuestos`.
 *
 * Sustituye el préstamo de `users.transito_codigo`, que es del rol `transito`, solo guardaba UNO y
 * que el `superRefine` de `users.routes.ts` ya rechazaba para cualquier otro rol —es decir: la API
 * declaraba ilegal el estado que el seed producía—. Desde la migración 0173, para un gestor esa
 * columna queda NULL: **la fuente es esta tabla y solo esta tabla**.
 *
 * PK compuesta y sin `id` propio: la fila ES el par. Un uuid obligaría además a un índice único
 * sobre el par —dos objetos de base de datos para un solo hecho— y nadie referencia estas filas por
 * id.
 *
 * `ON DELETE` clasificado según ADR-0005: `userId` es *pertenencia* (la fila no existe sin su
 * usuario) → CASCADE; `organismoCodigo` es RESTRICT porque borrar un organismo no puede desatar
 * gestores en silencio, y SET NULL es imposible en una columna de la PK.
 */
export const flitoGestorOrganismos = pgTable('flito_gestor_organismos', {
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  organismoCodigo: varchar('organismo_codigo', { length: 5 }).notNull()
    .references(() => organismosTransitoConfig.codigo, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.organismoCodigo] }),
  // Por el RESTRICT, no por un reporte: sin él, borrar una fila de organismos_transito_config
  // escanea esta tabla entera. Mismo motivo, escrito, que `idx_users_compania`.
  organismoIdx: index('idx_flito_gestor_organismos_organismo').on(t.organismoCodigo),
}));

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
  /**
   * true = este SOAT existe por un desbloqueo excepcional, pese a que la compañía autogestiona el
   * suyo (HU #10980). La marca va aquí y no en el trámite porque la cola consulta
   * `flito_soat → clients` sin pasar por `flito_tramites`.
   */
  excepcionAutogestion: boolean('excepcion_autogestion').notNull().default(false),
  /**
   * De qué puerta salió esta fila (Feature #11912): `tramite` (el sync de FLIT, la única que existía
   * hasta hoy) o `cliente` (una compañía la pidió sin trámite digital).
   *
   * Es la ÚNICA columna del canal Cliente que vive en esta tabla, y está aquí porque es lo único que
   * las consultas viejas necesitan poder mirar sin un JOIN: la frontera de autogestión, la cola y el
   * tablero. Todo lo demás del canal —quién la radicó, quién la revisó, la causal del rechazo— vive
   * en `flitoSoatSolicitud`, y el propietario en `flitoCompradores`: `buscarConAcceso()` hace
   * `select` de esta fila ENTERA y la sirve a las rutas del gestor del proveedor, así que meter aquí
   * PII de propietario sería una fuga que ningún test detectaría (ADR-0008 §1.2).
   *
   * `varchar` + CHECK y no un enum de Postgres, al revés que `estado`: `origen` nace hoy y ampliarlo
   * es un DROP/ADD CONSTRAINT barato, mientras que un enum arrastraría a cada migración futura la
   * trampa del 55P04 que este Feature ya paga dos veces.
   */
  origen: varchar('origen', { length: 10 }).notNull().default('tramite'),
  vin: varchar('vin', { length: 17 }).notNull().unique(),
  vehiculoId: integer('vehiculo_id').notNull().unique().references(() => vehicles.id),
  estado: flitoSoatEstadoEnum('estado').notNull().default('pendiente'),
  // Denormalizados y congelados: el SOAT vive más que sus trámites.
  companiaId: integer('compania_id').notNull().references(() => clients.id),
  /**
   * Secretaría de tránsito. Nullable desde la HU #11935 (migración 0171) y **sigue siéndolo desde
   * la HU #11966 (ADR-0010)**, aunque el RUNT haya vuelto a ser compuerta del alta.
   *
   * El organismo NO es compuerta (AC5 de la #11966): el alta escribe el código si el nombre que
   * reporta el RUNT cruza el catálogo, y si no cruza **la fila se crea igual** con `NULL` y el
   * satélite anotando `organismo_no_catalogado`. El `422 organismo_no_catalogado` desapareció de
   * los dos endpoints del canal. Quien lo reintroduzca rompe ese AC.
   *
   * La FK queda — un código escrito tiene que existir en `organismos_transito_config`. El sync y el
   * trámite siguen mandando código. Cola/detalle/export hacen `leftJoin` para no ocultar la fila.
   */
  organismoCodigo: varchar('organismo_codigo', { length: 5 }).references(() => organismosTransitoConfig.codigo),
  proveedorSoatId: uuid('proveedor_soat_id').references(() => flitoProveedoresSoat.id),
  proveedorSobrescrito: boolean('proveedor_sobrescrito').notNull().default(false),
  /**
   * true = la gestión de este SOAT la asume Operaciones en vez de un proveedor (HU #11152,
   * Feature #11150). Es la contingencia: no hay proveedor que atienda el caso, o el que lo tenía
   * no puede.
   *
   * NO confundir con `excepcionAutogestion` ni con `clients.soatAutogestionable`: esos dicen que la
   * COMPAÑÍA se lo gestiona sola y el SOAT ni siquiera debería estar en la cola. Este dice quién
   * dentro de FLITO lo trabaja, y es lo único que decide si el proveedor lo sigue viendo — no el
   * valor de `proveedorSoatId`, que se conserva para poder devolvérselo.
   */
  gestionOperaciones: boolean('gestion_operaciones').notNull().default(false),
  gestionOperacionesMotivo: text('gestion_operaciones_motivo'),
  gestionOperacionesPorId: integer('gestion_operaciones_por_id').references(() => users.id),
  gestionOperacionesEn: timestamp('gestion_operaciones_en', { withTimezone: true }),
  enviadoPorId: integer('enviado_por_id').references(() => users.id),
  enviadoEn: timestamp('enviado_en', { withTimezone: true }),
  pagadoEn: timestamp('pagado_en', { withTimezone: true }),
  valorPagado: numeric('valor_pagado', { precision: 14, scale: 2 }),
  motivoRechazo: text('motivo_rechazo'),
  extraccion: jsonb('extraccion').$type<ExtraccionSoat>(),
  /**
   * Número de póliza NORMALIZADO (solo A-Z0-9, mayúsculas) — Feature #11623, migración 0157.
   *
   * Promovido desde `extraccion->'numeroPoliza'->>'valor'`, que es donde lo dejó el OCR y donde no
   * se puede indexar ni comparar. La copia NO sustituye a `extraccion`: aquella es la prueba de lo
   * que se leyó del documento, con su confianza; esta es la llave operativa con la que una boleta
   * de pago externo cruza contra el SOAT.
   *
   * Nullable: un SOAT `pendiente` todavía no tiene póliza, y el OCR puede no haberla leído. La
   * escriben el backfill de la 0157 (una vez) y `pagarEnTx` (en cada pago), los dos con
   * `polizaParaColumna` de shared-types para que digan exactamente lo mismo.
   *
   * Cuasi-PII: no viaja en path ni en query (AGENTS.md 14).
   */
  numeroPoliza: varchar('numero_poliza', { length: 60 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  estadoIdx: index('idx_flito_soat_estado').on(t.estado),
  proveedorIdx: index('idx_flito_soat_proveedor').on(t.proveedorSoatId),
  // Migración 0169 (HU #11914), por la auditoría de esquema. Desde la HU #11913 `compania_id` es el
  // PREDICADO OBLIGATORIO del aislamiento del rol `cliente` —lo aplican `condicionesCola()`, que
  // comparten la página, el conteo y las facetas, y `buscarConAcceso()`— y era la única
  // `compania_id` del esquema sin índice, mientras `flito_derechos`, `flito_logistica_actas` y
  // `flito_bolsa_movimientos` ya tenían el suyo. Sin él, cada pantalla del canal Cliente recorre
  // `flito_soat` entera y descarta lo ajeno DESPUÉS de haberlo leído.
  companiaIdx: index('idx_flito_soat_compania').on(t.companiaId),
  // NO único a propósito (ADR-0006 §8): lo crea la migración, y una póliza reexpedida o un `0` que
  // el OCR leyó como `O` haría fallar el `CREATE UNIQUE INDEX` en el despliegue, parando la cadena
  // entera por un dato viejo. El duplicado se resuelve en el cruce, delante de quien puede
  // arreglarlo (`poliza_duplicada`). Parcial: los SOAT pendientes no tienen póliza.
  polizaIdx: index('idx_flito_soat_numero_poliza').on(t.numeroPoliza)
    .where(sql`${t.numeroPoliza} IS NOT NULL`),
  // Declarado AQUÍ y no solo en la migración 0167 a propósito: la lección que dejó escrita la 0157
  // es que un CHECK que solo vive en la base convence a quien lee `schema.ts` de que añadir un valor
  // no necesita migración, y el primer INSERT con el valor nuevo muere con 23514.
  origenChk: check('flito_soat_origen_chk', sql`${t.origen} IN ('tramite', 'cliente')`),
}));

/**
 * Causales de rechazo de una solicitud del canal Cliente (Feature #11912). Catálogo GENERAL, no por
 * compañía: calcado de `flitoComparendosCausales`, que es el precedente del repo para esto mismo.
 *
 * Lo puebla y lo consume la HU #11915 (revisión); aquí solo nace la tabla, porque la 0167 es la
 * única migración de la cadena y partirla en cuatro no ayudaría a nadie.
 */
export const flitoSoatCausalesRechazo = pgTable('flito_soat_causales_rechazo', {
  id: uuid('id').primaryKey().defaultRandom(),
  nombre: varchar('nombre', { length: 120 }).notNull(),
  activo: boolean('activo').notNull().default(true),
  orden: smallint('orden').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  nombreUq: uniqueIndex('uq_flito_soat_causales_nombre').on(t.nombre),
}));

/**
 * Satélite 1:1 de `flitoSoat` con TODO lo que solo existe cuando el SOAT nació del canal Cliente:
 * quién lo radicó, quién lo revisó, la causal y la observación del rechazo, y cuántas veces se
 * reenvió tras subsanar.
 *
 * **Por qué una tabla aparte y no doce columnas en `flitoSoat`** (ADR-0008 §1.2, y es la decisión
 * cara de este modelo): `buscarConAcceso()` hace `db.select({ soat: flitoSoat, … })` —la fila
 * ENTERA— y su resultado alimenta el detalle, el rechazo, la reversa, el traspaso y la carga de
 * factura, que son las rutas por las que entra el GESTOR DEL PROVEEDOR. Hoy esa fila es inocua;
 * con la observación del rechazo y los datos de contacto dentro dejaría de serlo, y la regresión
 * sería invisible porque ningún test compara la forma de una fila.
 *
 * `soatId` es la PK: eso da el 1:1 gratis, sin un índice único aparte que alguien pueda olvidar.
 *
 * El PROPIETARIO del vehículo NO está aquí: va a `flitoCompradores`, que es donde la búsqueda de la
 * cola ya lo interroga (§1.3).
 *
 * La escriben las HU #11914 (alta) y #11915 (revisión). La #11913 la crea.
 */
export const flitoSoatSolicitud = pgTable('flito_soat_solicitud', {
  soatId: uuid('soat_id').primaryKey().references(() => flitoSoat.id, { onDelete: 'cascade' }),
  // Quién la radicó. El NOMBRE es el rastro durable —mismo patrón que
  // `flitoSoportes.subidoPorNombre`— y por eso es `NOT NULL`: sobrevive a lo que le pase a la fila
  // de `users`.
  //
  // La FK NO lleva `ON DELETE`, así que PostgreSQL aplica NO ACTION: borrar en duro un usuario que
  // radicó una solicitud FALLA con 23503, no deja este id en NULL. La versión anterior de este
  // comentario —y la prosa gemela de la migración 0167, que no se reescribe porque ya está aplicada
  // y su sha256 registrado en `_kyverum_applied_migrations`— decía lo contrario. Que la columna
  // admita NULL no es consecuencia de ningún borrado; quien la escribe es la HU #11914, y siempre
  // con el usuario que radica.
  solicitadoPorId: integer('solicitado_por_id').references(() => users.id),
  solicitadoPorNombre: varchar('solicitado_por_nombre', { length: 150 }).notNull(),
  solicitadoEn: timestamp('solicitado_en', { withTimezone: true }).notNull().defaultNow(),
  revisadoPorId: integer('revisado_por_id').references(() => users.id),
  revisadoPorNombre: varchar('revisado_por_nombre', { length: 150 }),
  revisadoEn: timestamp('revisado_en', { withTimezone: true }),
  // Causal + observación del rechazo del ADMIN (estado `rechazada`). NO se reutiliza
  // `flitoSoat.motivoRechazo`, que es el del GESTOR (`con_novedad`): otro actor, otro estado
  // destino y otra audiencia. Mezclarlos haría ilegible el historial de una fila que pase por los
  // dos.
  causalRechazoId: uuid('causal_rechazo_id').references(() => flitoSoatCausalesRechazo.id),
  observacionRechazo: text('observacion_rechazo'),
  // Cuántas veces el cliente subsanó y volvió a enviar. Sirve para detectar la solicitud que va y
  // viene sin resolverse, que es la que hay que llamar por teléfono.
  reenvios: smallint('reenvios').notNull().default(0),
  /**
   * Desenlace de la verificación RUNT (migración 0171, HU #11935; el significado cambia con la
   * #11966 / ADR-0010). Cuatro columnas derivadas: NUNCA el payload crudo.
   *
   * ── Qué significa cada valor DESDE la HU #11966 ─────────────────────────────────────────────────
   *
   * El RUNT volvió a ser compuerta del alta, así que una fila del canal **nace en `ok`**: si el RUNT
   * no hubiera contestado, o hubiera contestado que no, la fila no existiría (el alta responde
   * 503/422/409 y no inserta). `soat_vigente` nace en `false` por lo mismo — es una lectura
   * concluyente, no un hueco.
   *
   * **`pendiente`, `caido`, `sin_registro` y `no_cuadra` son RESIDUO HISTÓRICO**: solo los llevan las
   * solicitudes radicadas entre la #11935 y la #11966, cuando el alta no esperaba a Kyverum y un job
   * post-commit anotaba el desenlace. Esas filas **no se reescriben ni se reconsultan** (AC6), así
   * que los cuatro valores siguen en el CHECK y en la constante de shared-types. El job que los
   * producía se borró con la #11966: sin función no hay reconsulta posible por descuido.
   *
   * El `default('pendiente')` se conserva por las filas que ya lo tienen y porque el INSERT del alta
   * escribe el valor explícitamente; no describe ya el estado inicial de una fila nueva.
   */
  verificacionEstado: varchar('verificacion_estado', { length: 20 }).notNull().default('pendiente'),
  /** `true`/`false` solo con lectura concluyente (`ok`); `NULL` en los cuatro estados históricos. */
  soatVigente: boolean('soat_vigente'),
  /** Solo si `soat_vigente=true` y el RUNT trajo fecha. Desde la #11966 el alta nace en `false`. */
  soatVigenteHasta: date('soat_vigente_hasta'),
  /**
   * Código máquina del desenlace (mismo vocabulario que `CodigoErrorSolicitudSoat`).
   * Desde la #11966 el único que puede escribir una fila NUEVA es `organismo_no_catalogado`, que no
   * aborta el alta (AC5); `runt_no_disponible`/`runt_sin_registro`/`runt_no_cuadra` son históricos —
   * hoy salen como error HTTP y no hay fila que anotar.
   */
  verificacionCodigo: varchar('verificacion_codigo', { length: 40 }),
  /**
   * Cuándo RESPONDIÓ el RUNT durante el alta (HU #12093, migración 0174).
   *
   * No es `solicitado_en`: aquella dice cuándo se guardó la solicitud y esta cuándo se midió el
   * vehículo. Hoy distan milisegundos —desde ADR-0010 la consulta es compuerta y ocurre dentro de la
   * misma petición— y por eso conviene tenerlas separadas antes de que dejen de coincidir: la ficha
   * enseña «datos del RUNT del …», que es una afirmación sobre el registro nacional y no sobre FLITO.
   *
   * Nullable y SIN backfill: las solicitudes radicadas bajo la #11935 consultaban después del COMMIT
   * (o no consultaban), así que de ellas no consta. `NULL` significa exactamente eso.
   *
   * **La diferencia con `solicitado_en` NO es una duración, y no debe pintarse como tal en ninguna
   * pantalla ni reporte.** Las dos marcas salen de RELOJES DISTINTOS: `solicitado_en` es
   * `defaultNow()`, o sea el reloj del servidor de base de datos, y esta la fija el proceso de la
   * API con `new Date()` justo al volver del RUNT (`flito-soat-cliente.service.ts`,
   * `verificarRuntCompuerta`) — que es lo semánticamente correcto y lo que el AC4 pide. Con API y
   * Postgres en hosts distintos, una deriva de reloj de unos pocos segundos basta para invertir el
   * orden aparente y enseñar «el RUNT respondió después de radicarse», o una duración negativa.
   * No hay CHECK de ordenación entre las dos a propósito: rechazaría altas perfectamente válidas
   * por un problema de relojes ajeno al dato. Cada columna se lee sola, y para «cuánto tardó el
   * RUNT» hace falta medir los dos extremos con el mismo reloj, que hoy nadie hace.
   */
  runtConsultadoEn: timestamp('runt_consultado_en', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  causalIdx: index('idx_flito_soat_solicitud_causal').on(t.causalRechazoId),
  verificacionEstadoChk: check(
    'flito_soat_solicitud_verificacion_estado_chk',
    sql`${t.verificacionEstado} IN ('pendiente', 'caido', 'sin_registro', 'no_cuadra', 'ok')`,
  ),
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

// Impuesto, uno por trámite (tramite_id UNIQUE).
export const flitoImpuestos = pgTable('flito_impuestos', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** true = creado por un desbloqueo excepcional pese a que la compañía autogestiona (HU #10980). */
  excepcionAutogestion: boolean('excepcion_autogestion').notNull().default(false),
  tramiteId: uuid('tramite_id').notNull().unique().references(() => flitoTramites.id),
  estado: flitoImpuestoEstadoEnum('estado').notNull().default('pendiente'),
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
  /**
   * Gemelo del de `flito_soat` (HU #11152 trae la columna; #11155 la usa). Aquí pesa más: el
   * destinatario del impuesto no es un proveedor sino el gestor de `organismo_codigo`, así que esta
   * bandera es lo ÚNICO que puede sacarlo de su cola y evitar que se pague dos veces.
   */
  gestionOperaciones: boolean('gestion_operaciones').notNull().default(false),
  gestionOperacionesMotivo: text('gestion_operaciones_motivo'),
  gestionOperacionesPorId: integer('gestion_operaciones_por_id').references(() => users.id),
  gestionOperacionesEn: timestamp('gestion_operaciones_en', { withTimezone: true }),
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

/**
 * Certificación de un impuesto contra el RUNT (Feature #11159, HU #11164).
 *
 * Una fila por INTENTO exitoso de certificación, no una por impuesto: recertificar (RN-10) apaga la
 * anterior con `vigente = false` y escribe otra. El historial completo importa porque el certificado
 * es evidencia frente a una auditoría, y «cuándo se verificó y contra qué respondió el RUNT» es
 * justo lo que se le pregunta a una evidencia.
 *
 * `snapshot_runt` guarda la respuesta cruda para poder regenerar el certificado sin volver a
 * consultar (RN-11: el PDF se genera en caliente, pero desde este snapshot, no desde el RUNT). Es la
 * razón por la que la certificación se persiste aunque el PDF no.
 *
 * Los intentos FALLIDOS no se persisten: una discrepancia o un error de servicio no dejan fila
 * (RN-06, RN-07). El registro conserva su certificación anterior, si la tenía.
 */
export const flitoImpuestoCertificaciones = pgTable('flito_impuesto_certificaciones', {
  id: uuid('id').primaryKey().defaultRandom(),
  impuestoId: uuid('impuesto_id').notNull().references(() => flitoImpuestos.id, { onDelete: 'cascade' }),
  /** Solo una certificación vigente por impuesto — lo garantiza un índice único parcial en la migración. */
  vigente: boolean('vigente').notNull().default(true),
  /**
   * Con qué se identificó el vehículo ante el RUNT. El documento NO es un dato decorativo: es la
   * prueba de propiedad (RN-02) —que el RUNT respondiera OK a la pareja placa+documento es lo que
   * certifica que ese documento es el del propietario registrado—, y por eso viaja al certificado.
   *
   * Cuando FLITO no conoce el documento del titular, la consulta va por VIN y `documentoConsultado`
   * queda nulo (migración 0123). Un CHECK exige que al menos uno de los dos esté presente: sin eso
   * el certificado no diría con qué se le preguntó al RUNT y dejaría de ser auditable.
   */
  placaConsultada: varchar('placa_consultada', { length: 10 }).notNull(),
  documentoConsultado: varchar('documento_consultado', { length: 30 }),
  vinConsultado: varchar('vin_consultado', { length: 17 }),
  /** Código RUNT del tipo de documento que resolvió la consulta ('C', 'E', …). Lo devuelve el RUNT. */
  tipoDocPropietario: varchar('tipo_doc_propietario', { length: 5 }),
  /**
   * Nombre del propietario SEGÚN FLITO, congelado al certificar (HU #11167).
   *
   * No se compara con nada —el RUNT no devuelve al propietario—, pero sí se imprime en el
   * certificado, y lo que el certificado imprime no puede cambiar después de emitido. Nullable: las
   * certificaciones anteriores a la migración 0122 no lo tienen.
   */
  propietarioNombre: varchar('propietario_nombre', { length: 200 }),
  /** Resultado por campo (`ComparacionCampo[]`): qué se comparó, con qué valores y si bloqueaba. */
  campos: jsonb('campos').$type<ComparacionCampo[]>().notNull(),
  /** Respuesta cruda del RUNT. Contiene PII → sujeto a la política de retención de privacidad. */
  snapshotRunt: jsonb('snapshot_runt'),
  certificadoPorId: integer('certificado_por_id').references(() => users.id, { onDelete: 'set null' }),
  // Se copia el nombre además del id: si el usuario se borra, el certificado debe seguir diciendo
  // quién lo emitió. Mismo criterio que `flito_soportes.subido_por_nombre`.
  certificadoPorNombre: varchar('certificado_por_nombre', { length: 150 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  impuestoIdx: index('idx_flito_imp_cert_impuesto').on(t.impuestoId, t.createdAt),
}));

/**
 * Comprador(es) del vehículo. Múltiple propietario → varias filas (orden 0 = principal).
 *
 * Desde el Feature #11912 la tabla cuelga de DOS padres, uno y solo uno por fila: el trámite (vía
 * `tramiteId`, como siempre) o el SOAT del canal Cliente (vía `soatId`). El nombre de la tabla ya no
 * cuenta toda la verdad, y es un coste aceptado: la alternativa era tener el concepto «propietario
 * del vehículo» en dos tablas distintas según de dónde viniera el SOAT, con el efecto de que el
 * término de búsqueda de la cola —que interroga ESTA tabla— dejaría de encontrar por propietario
 * justo las solicitudes que el admin tiene que revisar. Un filtro que devuelve menos filas de las
 * que hay, y en verde, es el peor modo de fallo de una pantalla de revisión (ADR-0008 §1.3).
 */
export const flitoCompradores = pgTable('flito_compradores', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Nullable desde la 0167 (antes NOT NULL): una fila del canal Cliente no tiene trámite.
  tramiteId: uuid('tramite_id').references(() => flitoTramites.id, { onDelete: 'cascade' }),
  // El otro padre. `CASCADE` como el de arriba: el propietario no sobrevive a la solicitud.
  soatId: uuid('soat_id').references(() => flitoSoat.id, { onDelete: 'cascade' }),
  /**
   * El nombre en UNA cadena. Lo escribe el sync fundiendo lo que FLIT manda separado
   * (`flit-http.adapter.ts:74`), y desde la HU #11966 el canal Cliente lo escribe **derivado** de
   * las columnas partidas de abajo (`razon_social ?? "nombres apellidos"`).
   *
   * Sigue siendo NOT NULL y sigue siendo lo que interroga la búsqueda de la cola
   * (`condicionesCola`), pero **ya no es la fuente de verdad del nombre para el canal**: el Excel de
   * una fila `origen='cliente'` lee `nombres`/`apellidos`/`razon_social`. Quien escriba una de las
   * dos vías tiene que escribir la otra en la misma edición, o la cola y el archivo dirán cosas
   * distintas (es lo que obligó a meter `subsanarSolicitud` en el alcance de la #11966).
   */
  nombreCompleto: varchar('nombre_completo', { length: 200 }).notNull(),
  numeroDocumento: varchar('numero_documento', { length: 30 }).notNull(),
  // Catálogo RUNT (CC, CE, TI, PAS, PPT, NIT, RC, PT). Sin CHECK y nullable: las filas que ya
  // existen vinieron del sync sin tipo, y un valor inesperado del RUNT no debe tumbar un alta.
  tipoDocumento: varchar('tipo_documento', { length: 5 }),
  /**
   * El titular PARTIDO (HU #11966, migración 0172): `nombres`/`apellidos` XOR `razon_social`.
   *
   * Las escribe SOLO el canal Cliente. Nullable las tres —y las dos de domicilio— porque las ~7 052
   * filas que ya existen las escribió el sync con el nombre fundido: un NOT NULL obligaría a un
   * backfill que partiera la cadena por el espacio, la heurística que el export rechaza por escrito
   * (falla en cada nombre compuesto y en cada razón social). Las filas de trámite siguen leyendo
   * `flit_raw` y no necesitan estas columnas jamás.
   */
  nombres: varchar('nombres', { length: 200 }),
  apellidos: varchar('apellidos', { length: 200 }),
  razonSocial: varchar('razon_social', { length: 200 }),
  correo: varchar('correo', { length: 150 }),
  celular: varchar('celular', { length: 30 }),
  direccion: varchar('direccion', { length: 300 }),
  /**
   * Municipio y departamento del DOMICILIO del titular (HU #11966). No son la ciudad del trámite ni
   * la jurisdicción del organismo: para una fila `origen='cliente'` la columna `Departamento` del
   * Excel pasa a ser este dato personal, y por eso los dos entran en `CAMPOS_PII_COLA_EXPORT`.
   *
   * Texto libre, sin catálogo DIVIPOLA: el AC solo pide que sean obligatorios en la app. Es lo mismo
   * que ya pasa con `flito_tramites.ciudad`.
   */
  municipio: varchar('municipio', { length: 100 }),
  departamento: varchar('departamento', { length: 100 }),
  /**
   * De dónde salió cada dato del propietario (HU #12093, migración 0174): mapa campo →
   * `'factura' | 'runt' | 'manual'` sobre los nueve campos de `CAMPOS_COMPRADOR_FACTURA`.
   *
   * `NOT NULL DEFAULT '{}'` y sin backfill. El tipo es el PERSISTIDO —un `Partial`— y no el mapa
   * completo, a propósito: las ~7 052 filas del sync de trámites y las radicadas antes de esta HU
   * llevan `{}`, y un `Record` completo aquí le prometería a quien lea la columna una clave que en
   * la mitad de las filas no existe. El alta escribe siempre el mapa COMPLETO (`procedenciaCompleta`,
   * AC3: el defecto es `manual`), que es asignable a esto.
   *
   * La escriben las DOS rutas del canal Cliente que escriben el comprador: el alta con lo que
   * declaró el formulario, y la subsanación con los nueve en `manual` —sus valores acaban de
   * llegar tecleados por una persona—. No es opcional que las dos la escriban: la subsanación
   * reescribe los nueve campos del titular vengan cambiados o no, así que un mapa que se quedara
   * del alta describiría, entero, valores que ya no están en la fila. Ver el docblock del `set` de
   * `subsanarSolicitud`.
   */
  procedencia: jsonb('procedencia').$type<ProcedenciaCompradorPersistida>().notNull().default({}),
  orden: integer('orden').notNull().default(0),
  porcentajeParticipacion: numeric('porcentaje_participacion', { precision: 5, scale: 2 }),
}, (t) => ({
  tramiteIdx: index('idx_flito_compradores_tramite').on(t.tramiteId),
  soatIdx: index('idx_flito_compradores_soat').on(t.soatId),
  // «Uno y solo uno», el patrón literal que `flitoSoportes` ya usa con sus FK. Sin él, una fila
  // podría colgar de los dos padres —y desaparecer con el CASCADE del que no la creó— o de ninguno,
  // que es un propietario huérfano que nadie vuelve a encontrar.
  padreChk: check('flito_compradores_padre_chk',
    sql`(${t.tramiteId} IS NOT NULL) <> (${t.soatId} IS NOT NULL)`),
  // «Nunca las dos cosas a la vez» (HU #11966, migración 0172). Las filas legacy lo cumplen: los
  // tres campos NULL. NO se añade el recíproco (`tipo_documento='NIT' ⇒ razon_social IS NOT NULL`):
  // bloquearía a un futuro escritor del sync que rellene `tipo_documento` sin razón social, y la
  // mitad positiva ya la exige Zod en la única ruta que escribe estas columnas.
  //
  // Declarado AQUÍ y no solo en la migración, por la lección de la 0157: un CHECK que solo vive en
  // la base convence a quien lee `schema.ts` de que no hace falta migración, y el primer INSERT
  // nuevo muere con 23514.
  titularChk: check('flito_compradores_titular_chk',
    sql`${t.razonSocial} IS NULL OR (${t.nombres} IS NULL AND ${t.apellidos} IS NULL)`),
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
  // HU #10950: soporte del derecho de tránsito. Nullable como los otros dos: un soporte cuelga de
  // exactamente uno de los tres flujos (o de ninguno, mientras espera en la cola de revisión).
  derechoId: uuid('derecho_id').references(() => flitoDerechosTramite.id, { onDelete: 'cascade' }),
  // HU #11335: el PDF y el XML de la factura electrónica. CUARTA clave foránea nullable del mismo
  // patrón, y no un `tramiteId`: esta tabla nunca ha tenido esa columna, y el trámite se alcanza
  // desde `siigo_factura_tramites`, que además sabe qué facturas siguen vivas. Es una FK HACIA
  // `siigo_facturas`, no una columna sobre ella (AC7).
  siigoFacturaId: uuid('siigo_factura_id').references(() => siigoFacturas.id, { onDelete: 'cascade' }),
  // Feature #11623: QUINTA clave foránea nullable del mismo patrón — el comprobante PSE de la boleta
  // que se conciló (CF-06). La referencia es un thunk, así que da igual que la tabla se declare más
  // abajo en este archivo: mismo caso que `siigoFacturaId`.
  conciliacionBoletaId: uuid('conciliacion_boleta_id')
    .references(() => flitoConciliacionBoletas.id, { onDelete: 'cascade' }),
  subidoPorId: integer('subido_por_id').references(() => users.id),
  subidoPorNombre: varchar('subido_por_nombre', { length: 150 }).notNull(),
  subidoEn: timestamp('subido_en', { withTimezone: true }).notNull().defaultNow(),
  // Descartado en la cola de revisión OCR: libera su hash para permitir recargar el mismo archivo
  // (un documento rechazado no debe contar como duplicado). Se excluye del dedup y de los listados.
  descartado: boolean('descartado').notNull().default(false),
}, (t) => ({
  hashIdx: index('idx_flito_soportes_hash').on(t.hash),
  // AC3 — un solo documento de cada tipo por factura. La garantía es de la base y no del servicio:
  // entre el «¿ya está?» y el INSERT de un barrido periódico cabe otro ciclo.
  facturaTipoUq: uniqueIndex('idx_flito_soportes_factura_tipo').on(t.siigoFacturaId, t.tipo)
    .where(sql`${t.siigoFacturaId} IS NOT NULL AND ${t.descartado} = false`),
  // Calcado del anterior, por el mismo motivo: un solo comprobante VIVO de cada tipo por boleta.
  boletaTipoUq: uniqueIndex('idx_flito_soportes_boleta_tipo').on(t.conciliacionBoletaId, t.tipo)
    .where(sql`${t.conciliacionBoletaId} IS NOT NULL AND ${t.descartado} = false`),
  // Y el tercero de la familia (Feature #11912): UNA sola factura de venta viva por SOAT. La
  // subsanación del canal Cliente vuelve a subir el archivo, y sin este índice se acumularían dos
  // facturas vivas y la pantalla mostraría la que ordenara primero. `descartado = false` es lo que
  // permite que la nueva entre: sin esa condición, la factura descartada bloquearía la subsanación.
  // Acotado a `factura_venta`: los demás tipos de soporte de un SOAT sí pueden repetirse.
  soatFacturaVentaUq: uniqueIndex('idx_flito_soportes_soat_factura_venta').on(t.soatId)
    .where(sql`${t.soatId} IS NOT NULL AND ${t.tipo} = 'factura_venta' AND ${t.descartado} = false`),
  // «Uno y solo uno» para las DOS FK nuevas del patrón. Lo escribió la 0139 para `siigo_factura_id`
  // y lo ensancha la 0157 con `conciliacion_boleta_id`: sin ensancharlo, un soporte podía colgar de
  // una factura Y de una boleta a la vez, contar como comprobante vivo en los dos índices parciales
  // de arriba y —las dos FK son CASCADE— desaparecer con la factura llevándose el comprobante PSE
  // de una boleta ya conciliada.
  //
  // Las tres FK viejas (soat/impuesto/derecho) siguen SIN excluirse entre sí, igual que las dejó la
  // 0139: es una regla vigente desde mucho antes y cambiarla no es alcance de este Feature.
  excluyenteChk: check('flito_soportes_factura_excluyente_chk',
    sql`(${t.siigoFacturaId} IS NULL
          OR (${t.soatId} IS NULL AND ${t.impuestoId} IS NULL AND ${t.derechoId} IS NULL
              AND ${t.conciliacionBoletaId} IS NULL))
     AND (${t.conciliacionBoletaId} IS NULL
          OR (${t.soatId} IS NULL AND ${t.impuestoId} IS NULL AND ${t.derechoId} IS NULL))`),
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

// ── FLITO Derechos de tránsito (HU #10950) ───────────────────────────────────
// Lo que el organismo cobra por radicar el trámite. A diferencia del SOAT (anclado al VIN, RN-01),
// el derecho se paga POR TRÁMITE: cada radicación tiene el suyo, así que `tramite_id` es UNIQUE.
// No hay máquina de estados: el recibo llega ya pagado, el registro es la prueba de cuánto se pagó.
export const flitoDerechosTramite = pgTable('flito_derechos_tramite', {
  id: uuid('id').primaryKey().defaultRandom(),
  tramiteId: uuid('tramite_id').notNull().unique().references(() => flitoTramites.id, { onDelete: 'cascade' }),
  organismoCodigo: varchar('organismo_codigo', { length: 5 }).references(() => organismosTransitoConfig.codigo),
  companiaId: integer('compania_id').references(() => clients.id),
  valor: numeric('valor', { precision: 14, scale: 2 }),
  fechaPago: date('fecha_pago'),
  numeroRadicado: varchar('numero_radicado', { length: 40 }),
  // Concepto leído del recibo ("MATRICULA INICIAL", "PRENDA"…). Se guarda como texto crudo: cada
  // organismo lo rotula distinto y normalizarlo perdería la evidencia de qué decía el documento.
  tipoTramiteRecibo: varchar('tipo_tramite_recibo', { length: 60 }),
  origen: varchar('origen', { length: 20 }).notNull(),
  // `origen` dice el CANAL ('manual' | 'drive'); estas tres dicen el DOCUMENTO. Con los consolidados
  // del Drive —un PDF de trece páginas por día— saber que vino «del Drive» no permite volver al
  // papel: hacen falta el archivo y la página.
  archivoOrigen: varchar('archivo_origen', { length: 255 }),
  // El barrido que lo produjo, que ya guarda nombre, fileId, quién lo subió y cuándo, y que
  // sobrevive al borrado del archivo en el Drive. Null en carga manual, que no tiene barrido.
  procesamientoId: integer('procesamiento_id').references(() => procesamientoCuentas.id, { onDelete: 'set null' }),
  paginas: jsonb('paginas').$type<number[]>(),
  // Sin FK dura hacia flito_soportes: evita el ciclo (soportes ya referencia esta tabla), igual que
  // flito_impuestos.factura_venta_soporte_id.
  soporteId: uuid('soporte_id'),
  extraccion: jsonb('extraccion').$type<ExtraccionDerechoTramite>(),
  // Discrepancias que no bloquean pero deben quedar trazadas (p.ej. el tipo del recibo no coincide
  // con el del trámite). Lista de strings.
  advertencias: jsonb('advertencias').$type<string[]>(),
  registradoPorId: integer('registrado_por_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  organismoIdx: index('idx_flito_derechos_organismo').on(t.organismoCodigo),
  companiaIdx: index('idx_flito_derechos_compania').on(t.companiaId),
  procesamientoIdx: index('idx_flito_derechos_procesamiento').on(t.procesamientoId),
}));

/**
 * Cambios de estado de SOAT e impuestos — el equivalente de `flito_tramite_historial` para los dos
 * conceptos, que hasta ahora no tenían ninguno y cuyo rastro vivía disperso en `audit_logs`, en
 * texto libre y sin campos de estado.
 *
 * Una sola tabla para ambos, discriminados por `concepto`: comparten los mismos cuatro estados y las
 * mismas transiciones, así que dos tablas gemelas serían dos veces el mismo código.
 *
 * Sin FK hacia `flito_soat`/`flito_impuestos`: una FK apunta a UNA tabla y este historial sirve a
 * dos. La integridad la da `concepto` más el filtro de los lectores.
 */
export const flitoEstadoHistorial = pgTable('flito_estado_historial', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  /** 'soat' | 'impuesto'. */
  concepto: varchar('concepto', { length: 20 }).notNull(),
  registroId: uuid('registro_id').notNull(),
  /** Null en el alta: antes de existir no había estado del que venir. */
  estadoAnterior: varchar('estado_anterior', { length: 30 }),
  estadoNuevo: varchar('estado_nuevo', { length: 30 }).notNull(),
  motivo: text('motivo'),
  usuarioId: integer('usuario_id').references(() => users.id, { onDelete: 'set null' }),
  // Se copia el correo además del id: si el usuario se borra, el historial debe seguir diciendo
  // quién lo hizo. Mismo criterio que `flito_soportes.subido_por_nombre`.
  usuarioEmail: varchar('usuario_email', { length: 150 }),
  /** 'usuario' | 'sistema' | 'auditoria'. El último marca lo reconstruido desde `audit_logs`. */
  origen: varchar('origen', { length: 20 }).notNull().default('usuario'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  registroIdx: index('idx_flito_estado_historial_registro').on(t.concepto, t.registroId, t.createdAt),
}));

// SIN LECTOR. Fue el buffer de recibos cuya placa aún no correspondía a ningún trámite, que un
// reintento cruzaba solo cuando el trámite llegaba desde FLIT. Se retiró por decisión de negocio: la
// bandeja acumulaba comprobantes que en la práctica no llegaban a cruzar, y mantener archivos
// huérfanos en el almacenamiento costaba más que lo que aportaba. Ahora lo que no cruza se descarta
// con un aviso que dice qué recibo y con qué placa.
//
// La definición se queda deliberadamente, igual que se hizo con `flito_reglas_proveedor_soat`: borrar
// datos de una tabla viva en el mismo cambio que quita su único lector es innecesariamente
// irreversible. El DROP va en una migración posterior, cuando esté mergeado y verificado.
export const flitoDerechosPendientes = pgTable('flito_derechos_pendientes', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** 'derecho' | 'soat' | 'impuesto'. La bandeja sirve a los tres conceptos (HU #10982). */
  concepto: varchar('concepto', { length: 20 }).notNull().default('derecho'),
  /** Null cuando el recibo no permitió leerla: el archivo se guarda igual, lo resuelve una persona. */
  placa: varchar('placa', { length: 10 }),
  soporteId: uuid('soporte_id').notNull().references(() => flitoSoportes.id, { onDelete: 'cascade' }),
  organismoCodigo: varchar('organismo_codigo', { length: 5 }),
  valor: numeric('valor', { precision: 14, scale: 2 }),
  fechaPago: date('fecha_pago'),
  numeroRadicado: varchar('numero_radicado', { length: 40 }),
  tipoTramiteRecibo: varchar('tipo_tramite_recibo', { length: 60 }),
  extraccion: jsonb('extraccion').$type<ExtraccionDerechoTramite>(),
  origen: varchar('origen', { length: 20 }).notNull(),
  intentos: integer('intentos').notNull().default(1),
  ultimoIntentoEn: timestamp('ultimo_intento_en', { withTimezone: true }).notNull().defaultNow(),
  resuelto: boolean('resuelto').notNull().default(false),
  resueltoTramiteId: uuid('resuelto_tramite_id').references(() => flitoTramites.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // El reintento barre solo los no resueltos; el índice por placa es el que usa ese barrido.
  pendientePlacaIdx: index('idx_flito_derechos_pendientes_placa').on(t.placa, t.resuelto),
  pendienteConceptoIdx: index('idx_flito_pendientes_concepto').on(t.concepto, t.resuelto),
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

// ── FLITO Logística (Fase 1) ────────────────────────────────────────────────
// Trazabilidad del documento físico (LT/placa) del organismo al cliente. La unidad es el
// DOCUMENTO individual (RN-01); actas y rutas son agrupaciones sobre él. Los literales de estos
// enums coinciden con packages/shared-types/src/flito-logistica.ts (fuente única del dominio).
export const flitoLogisticaDocEstadoEnum = pgEnum('flito_logistica_doc_estado', ['generado', 'recogido', 'clasificado', 'en_acta', 'despachado', 'entregado', 'novedad', 'devuelto']);
export const flitoLogisticaActaEstadoEnum = pgEnum('flito_logistica_acta_estado', ['generada', 'despachada', 'entregada', 'devuelta']);
export const flitoLogisticaTipoDocEnum = pgEnum('flito_logistica_tipo_doc', ['licencia_transito', 'placa', 'otro']);

/**
 * Tarifa negociada con una compañía gestora (HU #10963). Sustituye a las constantes quemadas
 * `COSTOS_FIJOS.tramiteDigital` y `COSTOS_FIJOS.logistica`, que eran iguales para todos los clientes.
 *
 * `tipoTramite` NULL = tarifa genérica del concepto, la que se usa cuando no hay una específica.
 * Se guarda normalizado (mayúsculas, sin espacios) porque en `flito_tramites.tipoTramite` es texto
 * libre de FLIT. La unicidad real la impone `idx_flito_tarifas_unica`, con COALESCE sobre el tipo:
 * en un índice único normal NULL no colisiona con NULL y habría varias tarifas genéricas.
 */
export const flitoTarifasCompania = pgTable('flito_tarifas_compania', {
  id: uuid('id').primaryKey().defaultRandom(),
  companiaId: integer('compania_id').notNull().references(() => clients.id, { onDelete: 'cascade' }),
  concepto: varchar('concepto', { length: 30 }).notNull(),
  tipoTramite: varchar('tipo_tramite', { length: 60 }),
  valor: numeric('valor', { precision: 14, scale: 2 }).notNull(),
  activo: boolean('activo').notNull().default(true),
  actualizadoPorId: integer('actualizado_por_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  companiaConceptoIdx: index('idx_flito_tarifas_compania_concepto').on(t.companiaId, t.concepto),
}));

/**
 * Liquidación SELLADA de un trámite (HU #10965). Sellar es congelar: si mañana cambia la tarifa de
 * la compañía o la tasa del GMF, un trámite ya liquidado sigue mostrando lo que se cobró.
 *
 * Los valores son nullable a propósito: NULL = «no aplica» (p. ej. logística de una compañía que la
 * autogestiona), y NO cero. Es la misma distinción que la compuerta mantiene deliberadamente para
 * poder calcular la base del 4x1000.
 *
 * `tramiteId` es UNIQUE: hay una liquidación vigente o ninguna. El reverso borra la fila y deja el
 * snapshot en `flitoLiquidacionEventos`, así que el historial no se pierde.
 */
export const flitoLiquidaciones = pgTable('flito_liquidaciones', {
  id: uuid('id').primaryKey().defaultRandom(),
  tramiteId: uuid('tramite_id').notNull().unique().references(() => flitoTramites.id, { onDelete: 'cascade' }),
  estado: varchar('estado', { length: 20 }).notNull(),
  valorSoat: numeric('valor_soat', { precision: 14, scale: 2 }),
  valorImpuesto: numeric('valor_impuesto', { precision: 14, scale: 2 }),
  valorDerecho: numeric('valor_derecho', { precision: 14, scale: 2 }),
  valorTramiteDigital: numeric('valor_tramite_digital', { precision: 14, scale: 2 }),
  valorLogistica: numeric('valor_logistica', { precision: 14, scale: 2 }),
  baseGmf: numeric('base_gmf', { precision: 14, scale: 2 }).notNull(),
  tasaGmf: numeric('tasa_gmf', { precision: 6, scale: 5 }).notNull().default('0.004'),
  valorGmf: numeric('valor_gmf', { precision: 14, scale: 2 }).notNull(),
  total: numeric('total', { precision: 14, scale: 2 }).notNull(),
  detalle: jsonb('detalle'),
  liquidadoPorId: integer('liquidado_por_id').references(() => users.id),
  liquidadoEn: timestamp('liquidado_en', { withTimezone: true }).notNull().defaultNow(),
  facturadoPorId: integer('facturado_por_id').references(() => users.id),
  facturadoEn: timestamp('facturado_en', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  estadoIdx: index('idx_flito_liquidaciones_estado').on(t.estado),
}));

/** Bitácora append-only de la liquidación: liquidar, reversar y facturar. */
export const flitoLiquidacionEventos = pgTable('flito_liquidacion_eventos', {
  id: uuid('id').primaryKey().defaultRandom(),
  tramiteId: uuid('tramite_id').notNull().references(() => flitoTramites.id, { onDelete: 'cascade' }),
  accion: varchar('accion', { length: 20 }).notNull(),
  motivo: text('motivo'),
  usuarioId: integer('usuario_id').references(() => users.id),
  snapshot: jsonb('snapshot'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tramiteIdx: index('idx_flito_liquidacion_eventos_tramite').on(t.tramiteId, t.createdAt),
}));

// Proveedor logístico: mensajería propia (PWA FLITO) o integración con tercero (FEATURE §6).
export const flitoProveedoresLogistica = pgTable('flito_proveedores_logistica', {
  id: uuid('id').primaryKey().defaultRandom(),
  nombre: varchar('nombre', { length: 150 }).notNull().unique(),
  estrategia: varchar('estrategia', { length: 40 }).notNull().default('pwa_propia'),
  activo: boolean('activo').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Acta: agrupación por empresa para despacho/entrega (CA-04, una por empresa por lote). El acta
// firmada + evidencia (columnas de entrega) se pueblan en la Fase 2 (PWA); aquí quedan definidas.
export const flitoLogisticaActas = pgTable('flito_logistica_actas', {
  id: uuid('id').primaryKey().defaultRandom(),
  companiaId: integer('compania_id').notNull().references(() => clients.id),
  estado: flitoLogisticaActaEstadoEnum('estado').notNull().default('generada'),
  mensajeroId: integer('mensajero_id').references(() => users.id),
  proveedorLogisticaId: uuid('proveedor_logistica_id').references(() => flitoProveedoresLogistica.id),
  // Snapshot de configuración de la compañía al cerrar el lote.
  permiteParcial: boolean('permite_parcial').notNull().default(false),
  direccionEntrega: varchar('direccion_entrega', { length: 300 }),
  contactoNombre: varchar('contacto_nombre', { length: 150 }),
  contactoDocumento: varchar('contacto_documento', { length: 30 }),
  // Artefacto y evidencia de la entrega (Fase 2: firma digital + evidencia estructurada, RN-03/9.5).
  pdfStorageKey: varchar('pdf_storage_key', { length: 400 }),
  // Firma de quien ENTREGA (Operaciones), capturada en la consola al despachar el acta.
  firmaEntregaStorageKey: varchar('firma_entrega_storage_key', { length: 400 }),
  entregaNombre: varchar('entrega_nombre', { length: 150 }),
  // Firma de quien RECIBE (receptor en la empresa), capturada en campo por el mensajero.
  firmaStorageKey: varchar('firma_storage_key', { length: 400 }),
  fotoStorageKey: varchar('foto_storage_key', { length: 400 }),
  receptorNombre: varchar('receptor_nombre', { length: 150 }),
  receptorDocumento: varchar('receptor_documento', { length: 30 }),
  entregadoLat: numeric('entregado_lat', { precision: 10, scale: 7 }),
  entregadoLng: numeric('entregado_lng', { precision: 10, scale: 7 }),
  entregadoEn: timestamp('entregado_en', { withTimezone: true }),
  motivoDevolucion: text('motivo_devolucion'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  companiaIdx: index('idx_flito_log_actas_compania').on(t.companiaId),
  estadoIdx: index('idx_flito_log_actas_estado').on(t.estado),
  mensajeroIdx: index('idx_flito_log_actas_mensajero').on(t.mensajeroId),
}));

// Documento físico individual (RN-01). Congela organismo (dónde se generó) y compañía (destino),
// para que sobreviva a cambios del trámite. Un mismo documento físico no se duplica: (tramite, tipo) único.
export const flitoLogisticaDocumentos = pgTable('flito_logistica_documentos', {
  id: uuid('id').primaryKey().defaultRandom(),
  tramiteId: uuid('tramite_id').notNull().references(() => flitoTramites.id, { onDelete: 'cascade' }),
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
  actaId: uuid('acta_id').references(() => flitoLogisticaActas.id),
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
  actaIdx: index('idx_flito_log_doc_acta').on(t.actaId),
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
  lat: numeric('lat', { precision: 10, scale: 7 }),
  lng: numeric('lng', { precision: 10, scale: 7 }),
  motivo: text('motivo'),
  origen: varchar('origen', { length: 10 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  documentoIdx: index('idx_flito_log_eventos_documento').on(t.documentoId, t.createdAt),
}));

/**
 * Auditoría de los desbloqueos excepcionales de autogestión (HU #10980), y única sede del caso de
 * LOGÍSTICA — que no tiene registro propio que marcar y resuelve su frontera por EXISTS sobre aquí.
 *
 * Un trámite no puede tener dos excepciones vivas del mismo concepto (índice parcial), pero sí
 * acumular varias revocadas: el histórico de por qué se desbloqueó y por qué se deshizo.
 */
export const flitoExcepcionesAutogestion = pgTable('flito_excepciones_autogestion', {
  id: uuid('id').primaryKey().defaultRandom(),
  tramiteId: uuid('tramite_id').notNull().references(() => flitoTramites.id, { onDelete: 'cascade' }),
  /** 'soat' | 'impuesto' | 'logistica'. */
  concepto: varchar('concepto', { length: 20 }).notNull(),
  motivo: text('motivo').notNull(),
  creadoPorId: integer('creado_por_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revocadoEn: timestamp('revocado_en', { withTimezone: true }),
  revocadoPorId: integer('revocado_por_id').references(() => users.id),
  revocadoMotivo: text('revocado_motivo'),
}, (t) => ({
  excepcionTramiteIdx: index('idx_flito_excepciones_tramite').on(t.tramiteId),
}));

// ── FLITO Bolsas (HU #11121) ─────────────────────────────────────────────────

/**
 * Bolsa prepago del cliente: UNA por compañía (Feature #11120 §3). El consumo se reparte entre
 * organismos por movimiento, no abriendo una bolsa por OT.
 *
 * `saldo` está denormalizado a propósito. Sumar el libro entero en cada lectura se vuelve caro con
 * el histórico de un año; la consistencia la da el lock de esta fila (`FOR UPDATE`) mientras se
 * escribe el movimiento.
 *
 * Puede quedar NEGATIVO: si el organismo aprobó, el gasto ya ocurrió y bloquear el descuento
 * desalinearía el sistema de la realidad. Lo que hace el saldo negativo es disparar la alerta.
 */
export const flitoBolsas = pgTable('flito_bolsas', {
  id: uuid('id').primaryKey().defaultRandom(),
  // RESTRICT y no CASCADE: es un libro contable, no configuración. Borrar un cliente no puede
  // llevarse por delante su saldo ni su histórico. Mismo criterio que flito_liquidaciones.
  companiaId: integer('compania_id').notNull().unique().references(() => clients.id, { onDelete: 'restrict' }),
  saldo: numeric('saldo', { precision: 14, scale: 2 }).notNull().default('0'),
  // Base del nivel de riesgo (HU #11125). NULL mientras no haya recargas: ahí no hay porcentaje que
  // calcular, y es lo que distingue «sin recargas» de «agotada».
  ultimaRecargaValor: numeric('ultima_recarga_valor', { precision: 14, scale: 2 }),
  ultimaRecargaEn: timestamp('ultima_recarga_en', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Libro append-only de la bolsa. Nada se edita ni se borra: una corrección es otro movimiento
 * (HU #11123), igual que `flito_liquidacion_eventos`.
 *
 * `valor` es siempre positivo y la dirección la da `tipo`: guardar las salidas en negativo obligaría
 * a recordar el signo en cada suma del extracto.
 */
export const flitoBolsaMovimientos = pgTable('flito_bolsa_movimientos', {
  id: uuid('id').primaryKey().defaultRandom(),
  bolsaId: uuid('bolsa_id').notNull().references(() => flitoBolsas.id, { onDelete: 'restrict' }),
  companiaId: integer('compania_id').notNull().references(() => clients.id, { onDelete: 'restrict' }),
  /** 'entrada' | 'salida'. */
  tipo: varchar('tipo', { length: 10 }).notNull(),
  /** 'recarga' | 'automatico' | 'manual'. */
  origen: varchar('origen', { length: 20 }).notNull(),
  // Las cuatro siguientes son NULL en una recarga: el dinero entra sin pasar por un organismo ni por
  // un trámite. Las llenan las salidas automáticas de la HU #11122.
  concepto: varchar('concepto', { length: 30 }),
  organismoCodigo: varchar('organismo_codigo', { length: 5 }).references(() => organismosTransitoConfig.codigo),
  tramiteId: uuid('tramite_id').references(() => flitoTramites.id, { onDelete: 'set null' }),
  valor: numeric('valor', { precision: 14, scale: 2 }).notNull(),
  saldoResultante: numeric('saldo_resultante', { precision: 14, scale: 2 }).notNull(),
  /** Periodo contable 'YYYY-MM' al que se imputa; lo usa el cierre mensual (HU #11126). */
  periodo: varchar('periodo', { length: 7 }).notNull(),
  fecha: date('fecha').notNull(),
  observacion: text('observacion'),
  // RESTRICT: una entrada de dinero no puede quedarse sin su comprobante.
  soporteId: uuid('soporte_id').references(() => flitoSoportes.id, { onDelete: 'restrict' }),
  registradoPorId: integer('registrado_por_id').references(() => users.id, { onDelete: 'set null' }),
  registradoPorNombre: varchar('registrado_por_nombre', { length: 150 }).notNull(),
  // Anti doble cobro de las salidas automáticas (HU #11122). NULL en lo que registra una persona:
  // dos recargas iguales el mismo día son dos recargas, no un duplicado.
  llaveIdempotencia: varchar('llave_idempotencia', { length: 200 }),
  // Movimiento que este ajuste corrige (HU #11123). Corregir no es un UPDATE del valor —el libro es
  // append-only—, sino un movimiento nuevo que apunta al original.
  corrigeMovimientoId: uuid('corrige_movimiento_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  companiaIdx: index('idx_flito_bolsa_mov_compania').on(t.companiaId, t.createdAt),
  periodoIdx: index('idx_flito_bolsa_mov_periodo').on(t.companiaId, t.periodo),
  // Extracto por organismo (bolsa simbólica, HU #11124). Parcial: las recargas no tienen organismo.
  organismoIdx: index('idx_flito_bolsa_mov_organismo')
    .on(t.organismoCodigo, t.concepto)
    .where(sql`${t.organismoCodigo} IS NOT NULL`),
  // Se declara aquí y no solo en el SQL: es la ÚNICA protección anti doble cobro de las salidas
  // automáticas (HU #11122), y si el esquema no la conoce, el próximo `db:generate` emitiría un
  // DROP INDEX que la borraría antes de que la HU que la usa llegue a producción.
  llaveIdx: uniqueIndex('idx_flito_bolsa_mov_llave')
    .on(t.llaveIdempotencia)
    .where(sql`${t.llaveIdempotencia} IS NOT NULL`),
  // «¿Qué correcciones tiene este movimiento?» sin barrer el libro entero (HU #11123). Parcial: la
  // inmensa mayoría de los movimientos no corrigen nada.
  corrigeIdx: index('idx_flito_bolsa_mov_corrige')
    .on(t.corrigeMovimientoId)
    .where(sql`${t.corrigeMovimientoId} IS NOT NULL`),
}));

/**
 * Cierre mensual de la bolsa de un cliente (HU #11126, Feature #11120 §8).
 *
 * Cerrar es congelar: los movimientos del periodo dejan de admitir altas y correcciones, y el saldo
 * final pasa a ser el saldo inicial del mes siguiente. El disparo es MANUAL —Financiera cierra
 * cuando ha conciliado, no el día 30 a medianoche—, así que no hay cron.
 *
 * Los totales se copian en vez de recalcularse al leer, igual que `flito_liquidaciones` sella sus
 * valores: un reporte de cierre de hace un año debe seguir diciendo lo que dijo, aunque después
 * entren movimientos rezagados imputados a otro periodo.
 */
export const flitoBolsaCierres = pgTable('flito_bolsa_cierres', {
  id: uuid('id').primaryKey().defaultRandom(),
  bolsaId: uuid('bolsa_id').notNull().references(() => flitoBolsas.id, { onDelete: 'restrict' }),
  companiaId: integer('compania_id').notNull().references(() => clients.id, { onDelete: 'restrict' }),
  /** Periodo contable 'YYYY-MM' que se cierra. */
  periodo: varchar('periodo', { length: 7 }).notNull(),
  /** Saldo final del cierre anterior; cero en el primero. */
  saldoInicial: numeric('saldo_inicial', { precision: 14, scale: 2 }).notNull(),
  totalEntradas: numeric('total_entradas', { precision: 14, scale: 2 }).notNull(),
  totalSalidas: numeric('total_salidas', { precision: 14, scale: 2 }).notNull(),
  saldoFinal: numeric('saldo_final', { precision: 14, scale: 2 }).notNull(),
  movimientos: integer('movimientos').notNull(),
  observaciones: text('observaciones'),
  cerradoPorId: integer('cerrado_por_id').references(() => users.id, { onDelete: 'set null' }),
  cerradoPorNombre: varchar('cerrado_por_nombre', { length: 150 }).notNull(),
  cerradoEn: timestamp('cerrado_en', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // Un cliente no puede cerrar dos veces el mismo periodo (AC4), y sobre todo dos cierres
  // simultáneos no pueden producir dos reportes distintos del mismo mes.
  periodoUnico: uniqueIndex('uq_flito_bolsa_cierre_periodo').on(t.companiaId, t.periodo),
  companiaIdx: index('idx_flito_bolsa_cierres_compania').on(t.companiaId, t.periodo),
}));

/**
 * Pago de FLIT a un Organismo de Tránsito (HU #11124, Feature #11120 §4.1).
 *
 * La «bolsa simbólica» del organismo no tiene saldo propio: es una vista agregada sobre
 * `flito_bolsa_movimientos` que dice cuánto se le cobró al cliente por cuenta de ese organismo. Esta
 * tabla es el otro lado de la conciliación —cuánto se le ha pagado— y lo único que se persiste del
 * estado de cuenta.
 *
 * Estos pagos NO tocan la bolsa del cliente: es dinero que sale de FLIT hacia el organismo, no del
 * saldo prepago. Mezclarlos descuadraría el saldo del cliente contra sus propios movimientos.
 */
export const flitoOrganismoPagos = pgTable('flito_organismo_pagos', {
  id: uuid('id').primaryKey().defaultRandom(),
  organismoCodigo: varchar('organismo_codigo', { length: 5 }).notNull()
    .references(() => organismosTransitoConfig.codigo, { onDelete: 'restrict' }),
  valor: numeric('valor', { precision: 14, scale: 2 }).notNull(),
  fecha: date('fecha').notNull(),
  observacion: text('observacion'),
  soporteId: uuid('soporte_id').references(() => flitoSoportes.id, { onDelete: 'restrict' }),
  registradoPorId: integer('registrado_por_id').references(() => users.id, { onDelete: 'set null' }),
  registradoPorNombre: varchar('registrado_por_nombre', { length: 150 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  organismoIdx: index('idx_flito_organismo_pagos_organismo').on(t.organismoCodigo, t.fecha),
}));

// ── FLITO Bolsa de Tránsito (HU #11161; remodelada en el ajuste 0124) ────────

/**
 * Bolsa que FLIT precarga para que se paguen trámites ante las secretarías. Es la inversa de la del
 * cliente: aquí FLIT pone el dinero y otro lo gasta.
 *
 * NO está atada a una secretaría ni a un concepto. Una bolsa cubre las parejas (secretaría,
 * concepto) que diga `flitoBolsaTransitoCobertura` —«Bolsa de mi sector» puede cubrir Medellín,
 * Envigado y Sabaneta solo para impuestos—, y se identifica por su nombre.
 *
 * `saldo` puede ser NEGATIVO y eso no es un estado inválido: es el PRÉSTAMO. Si se siguió pagando
 * después de agotar el saldo, el gasto ya ocurrió; la siguiente carga lo neta sumando, sin que la
 * deuda necesite tabla ni columna propia.
 *
 * Denormalizado por la misma razón que `flito_bolsas.saldo`, y con la misma garantía: el lock de
 * esta fila (`FOR UPDATE`) mientras se escribe el movimiento.
 */
export const flitoBolsasTransito = pgTable('flito_bolsas_transito', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Cómo la llama quien la creó. Único: es el identificador humano de la bolsa. */
  nombre: varchar('nombre', { length: 120 }).notNull().unique(),
  saldo: numeric('saldo', { precision: 14, scale: 2 }).notNull().default('0'),
  // Base del nivel de alerta. NULL mientras no haya cargas: distingue «sin cargas» de «agotada».
  ultimaCargaValor: numeric('ultima_carga_valor', { precision: 14, scale: 2 }),
  ultimaCargaEn: timestamp('ultima_carga_en', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Qué paga cada bolsa: el producto de sus secretarías por sus conceptos.
 *
 * El índice único sobre (organismo, concepto) es la pieza central del modelo, no una validación
 * defensiva: garantiza que al sellar una liquidación exista UNA sola bolsa candidata para cada
 * concepto, y por eso el descuento no tiene que preguntarle a nadie a dónde va el dinero. Una
 * secretaría puede repetirse entre bolsas mientras no repita concepto.
 */
export const flitoBolsaTransitoCobertura = pgTable('flito_bolsa_transito_cobertura', {
  bolsaId: uuid('bolsa_id').notNull().references(() => flitoBolsasTransito.id, { onDelete: 'cascade' }),
  organismoCodigo: varchar('organismo_codigo', { length: 5 }).notNull()
    .references(() => organismosTransitoConfig.codigo, { onDelete: 'restrict' }),
  /** 'derecho' | 'soat' | 'impuesto' (`ConceptoBolsaTransito`). */
  concepto: varchar('concepto', { length: 20 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.bolsaId, t.organismoCodigo, t.concepto] }),
  // Se declara aquí y no solo en el SQL: si el esquema no la conoce, el próximo `db:generate`
  // emitiría un DROP INDEX y el modelo quedaría sin su única garantía de enrutamiento.
  parUnicoIdx: uniqueIndex('uq_bolsa_transito_cobertura').on(t.organismoCodigo, t.concepto),
  bolsaIdx: index('idx_bolsa_transito_cobertura_bolsa').on(t.bolsaId),
}));

/**
 * Libro append-only de la bolsa de tránsito. Mismo criterio que `flito_bolsa_movimientos`: nada se
 * edita ni se borra, el valor va siempre positivo y la dirección la da `tipo`.
 *
 * `organismoCodigo` y `concepto` son el DESGLOSE de la salida, no la identidad de la bolsa: dicen
 * qué se pagó y ante quién. Una carga no lleva ninguno de los dos —el dinero entra a la bolsa
 * entera— y por eso ambos son nullables.
 */
export const flitoBolsaTransitoMovimientos = pgTable('flito_bolsa_transito_movimientos', {
  id: uuid('id').primaryKey().defaultRandom(),
  bolsaId: uuid('bolsa_id').notNull().references(() => flitoBolsasTransito.id, { onDelete: 'restrict' }),
  organismoCodigo: varchar('organismo_codigo', { length: 5 })
    .references(() => organismosTransitoConfig.codigo, { onDelete: 'restrict' }),
  /** Concepto que produjo la salida. NULL en las cargas. */
  concepto: varchar('concepto', { length: 20 }),
  /** 'entrada' | 'salida'. */
  tipo: varchar('tipo', { length: 10 }).notNull(),
  /** 'carga' | 'automatico'. */
  origen: varchar('origen', { length: 20 }).notNull(),
  tramiteId: uuid('tramite_id').references(() => flitoTramites.id, { onDelete: 'set null' }),
  valor: numeric('valor', { precision: 14, scale: 2 }).notNull(),
  saldoResultante: numeric('saldo_resultante', { precision: 14, scale: 2 }).notNull(),
  periodo: varchar('periodo', { length: 7 }).notNull(),
  fecha: date('fecha').notNull(),
  observacion: text('observacion'),
  soporteId: uuid('soporte_id').references(() => flitoSoportes.id, { onDelete: 'restrict' }),
  registradoPorId: integer('registrado_por_id').references(() => users.id, { onDelete: 'set null' }),
  registradoPorNombre: varchar('registrado_por_nombre', { length: 150 }).notNull(),
  llaveIdempotencia: varchar('llave_idempotencia', { length: 200 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  organismoIdx: index('idx_flito_org_mov_organismo').on(t.organismoCodigo, t.createdAt),
  bolsaIdx: index('idx_flito_bolsa_transito_mov_bolsa').on(t.bolsaId, t.createdAt),
  // Se declara aquí y no solo en el SQL: es la ÚNICA protección anti doble consumo del sellado, y si
  // el esquema no la conoce, el próximo `db:generate` emitiría un DROP INDEX que la borraría.
  llaveIdx: uniqueIndex('idx_flito_org_mov_llave')
    .on(t.llaveIdempotencia)
    .where(sql`${t.llaveIdempotencia} IS NOT NULL`),
  // «¿Qué consumió este trámite?» sin barrer el libro entero; lo usa el reverso de la liquidación.
  tramiteIdx: index('idx_flito_org_mov_tramite')
    .on(t.tramiteId)
    .where(sql`${t.tramiteId} IS NOT NULL`),
}));

// ============================================================================
// FLITO Conciliación de boletas (Feature #11623) — migración 0157
// ============================================================================
//
// RN-01: una boleta agrupa varios pagos de UN solo cliente y de UN solo concepto. El MVP solo
// admite 'soat'; el módulo se llama Conciliación (genérico) porque impuestos vendrá después.
// RN-02: una boleta solo mueve dinero si TODAS sus líneas cuadran (CF-02). No hay conciliación
// parcial: media boleta conciliada obligaría a llevar dos verdades sobre el mismo pago externo.
// RN-03: el valor que se descuenta sale SIEMPRE de `flito_soat.valor_pagado`, nunca del Excel. El
// Excel solo VALIDA — si el valor del portal no coincide, la línea no cuadra y la boleta se para.
//
// Diseño y tradeoffs: docs/adr/ADR-0006-flito-conciliacion-boletas-soat.md

/** Boleta: un pago hecho en el portal externo, con su Excel y su comprobante. */
export const flitoConciliacionBoletas = pgTable('flito_conciliacion_boletas', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Referencia legible ('BOL-000123'). Existe para dos cosas concretas: la trazabilidad del reporte
  // de costos (CF-05) y la observación del movimiento de bolsa, que necesita decir de qué boleta
  // salió el dinero SIN escribir la placa ni la póliza en texto libre.
  referencia: varchar('referencia', { length: 20 }).notNull().unique()
    .default(sql`('BOL-' || lpad(nextval('flito_conciliacion_boleta_seq')::text, 6, '0'))`),
  // RESTRICT y no CASCADE: es un documento contable. Mismo criterio que `flito_bolsas.compania_id`.
  companiaId: integer('compania_id').notNull().references(() => clients.id, { onDelete: 'restrict' }),
  /** 'soat' (`ConceptoBoleta`). Acotado por CHECK en la base: ensancharlo es un ALTER de una línea. */
  concepto: varchar('concepto', { length: 20 }).notNull().default('soat'),
  /** 'cargada' | 'conciliada' | 'descartada' (`EstadoBoleta`). */
  estado: varchar('estado', { length: 20 }).notNull().default('cargada'),
  archivoNombre: varchar('archivo_nombre', { length: 300 }).notNull(),
  /** SHA-256 del .xlsx. Es la idempotencia de la CARGA, no la del dinero. */
  archivoHash: varchar('archivo_hash', { length: 64 }).notNull(),
  filas: integer('filas').notNull(),
  /** Suma de la columna «Total a Pagar» del portal: lo que el portal dice que se pagó. */
  totalDeclarado: numeric('total_declarado', { precision: 14, scale: 2 }).notNull(),
  /** Suma de `flito_soat.valor_pagado` de las líneas que cruzaron: lo que FLITO cree que se pagó. */
  totalCruzado: numeric('total_cruzado', { precision: 14, scale: 2 }),
  /**
   * Fecha del pago en el portal (PSE), no la de la carga. Es la que se imputa al periodo contable:
   * un pago del 30 que se carga el 2 pertenece al mes del pago.
   */
  fechaPago: date('fecha_pago').notNull(),
  // RESTRICT explícito (ADR-0005): quién cargó y quién concilió son la prueba de un acto que movió
  // dinero. Un `set null` dejaría filas que dicen «esta boleta la concilió nadie».
  cargadaPorId: integer('cargada_por_id').references(() => users.id, { onDelete: 'restrict' }),
  cargadaPorNombre: varchar('cargada_por_nombre', { length: 150 }).notNull(),
  conciliadaEn: timestamp('conciliada_en', { withTimezone: true }),
  conciliadaPorId: integer('conciliada_por_id').references(() => users.id, { onDelete: 'restrict' }),
  conciliadaPorNombre: varchar('conciliada_por_nombre', { length: 150 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  companiaIdx: index('idx_flito_concil_boleta_compania').on(t.companiaId, t.createdAt),
  estadoIdx: index('idx_flito_concil_boleta_estado').on(t.estado),
  // El mismo archivo no se carga dos veces. Parcial sobre `descartada` para que rehacer una boleta
  // mal cargada no exija renombrar el .xlsx.
  hashUq: uniqueIndex('idx_flito_concil_boleta_hash').on(t.archivoHash)
    .where(sql`${t.estado} <> 'descartada'`),
  // Los CHECK van AQUÍ y no solo en el `.sql`, siguiendo el precedente de
  // `flito_comparendos_gestion_auditoria_chk` (0156, más arriba en este archivo). No es simetría
  // estética: en la 0157 estos CHECK son INLINE dentro de un `CREATE TABLE IF NOT EXISTS`, así que
  // NO se auto-reparan — si la tabla naciera por cualquier otra vía sin ellos, la migración se
  // saltaría el CREATE y la tabla se quedaría permanentemente sin restricciones y en silencio.
  // El test de paridad de la 0157 compara estas expresiones con las del archivo, una a una.
  conceptoChk: check('flito_concil_boleta_concepto_chk', sql`${t.concepto} IN ('soat')`),
  estadoChk: check('flito_concil_boleta_estado_chk',
    sql`${t.estado} IN ('cargada','conciliada','descartada')`),
  filasChk: check('flito_concil_boleta_filas_chk', sql`${t.filas} > 0`),
  totalChk: check('flito_concil_boleta_total_chk', sql`${t.totalDeclarado} > 0`),
  // El sello de la conciliación es una sola cosa: o están los tres campos o no está ninguno.
  selloChk: check('flito_concil_boleta_sello_chk',
    sql`(${t.conciliadaEn} IS NULL) = (${t.conciliadaPorId} IS NULL)
       AND (${t.conciliadaEn} IS NULL) = (${t.conciliadaPorNombre} IS NULL)`),
  // Y el estado no puede mentir sobre el sello.
  estadoSelloChk: check('flito_concil_boleta_estado_sello_chk',
    sql`${t.estado} <> 'conciliada' OR ${t.conciliadaEn} IS NOT NULL`),
}));

/** Una fila del Excel del portal, con el SOAT que le encontró el cruce (o el motivo de que no). */
export const flitoConciliacionLineas = pgTable('flito_conciliacion_lineas', {
  id: uuid('id').primaryKey().defaultRandom(),
  // CASCADE: una línea es PERTENENCIA de su boleta, no tiene existencia propia. El borrado de una
  // boleta solo se admite en estado 'cargada'; una conciliada no se borra.
  boletaId: uuid('boleta_id').notNull()
    .references(() => flitoConciliacionBoletas.id, { onDelete: 'cascade' }),
  /** Fila del Excel (1 = primera fila de datos). Es lo que el usuario ve en pantalla. */
  filaNumero: integer('fila_numero').notNull(),
  /** Póliza YA NORMALIZADA (`normalizarPoliza`). Cuasi-PII: no viaja nunca en path ni en query. */
  numeroPolizaNorm: varchar('numero_poliza_norm', { length: 60 }).notNull(),
  valorDeclarado: numeric('valor_declarado', { precision: 14, scale: 2 }).notNull(),
  /**
   * SOAT con el que cruzó la fila. NULL cuando no cruzó.
   *
   * `set null` y no `restrict` (ADR-0006 §1.1 proponía `restrict`): una línea CONCILIADA ya está
   * protegida por `flito_concil_linea_sello_chk`, que exige `soat_id IS NOT NULL` en cuanto hay
   * sello — así que borrar un SOAT conciliado falla igual, y lo que `set null` permite es solo lo
   * que debe permitirse: deshacerse de un SOAT que aparece en una línea que nunca movió dinero.
   */
  soatId: uuid('soat_id').references(() => flitoSoat.id, { onDelete: 'set null' }),
  /** `ResultadoCruce`. Solo 'ok' deja conciliar; cualquier otro para la boleta entera (CF-02). */
  resultado: varchar('resultado', { length: 24 }).notNull(),
  /** Motivo legible. SIN placa ni póliza en claro: el dato ya está en sus propias columnas. */
  detalle: text('detalle'),
  movimientoBolsaId: uuid('movimiento_bolsa_id')
    .references(() => flitoBolsaMovimientos.id, { onDelete: 'restrict' }),
  movimientoTransitoId: uuid('movimiento_transito_id')
    .references(() => flitoBolsaTransitoMovimientos.id, { onDelete: 'restrict' }),
  /** Se sella al conciliar. Es lo que hace única la conciliación de un SOAT (índice de abajo). */
  conciliadaEn: timestamp('conciliada_en', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // Único y no simple: además de ordenar el detalle, impide que un reprocesamiento duplique filas.
  filaUq: uniqueIndex('idx_flito_concil_linea_fila').on(t.boletaId, t.filaNumero),
  // Una póliza no se repite DENTRO de una boleta: dos filas con la misma póliza son el mismo pago
  // contado dos veces. Se afirma en la base y no solo al leer el Excel porque de aquí salen dos
  // salidas de bolsa por el mismo SOAT.
  polizaUq: uniqueIndex('idx_flito_concil_linea_poliza').on(t.boletaId, t.numeroPolizaNorm),
  soatIdx: index('idx_flito_concil_linea_soat').on(t.soatId).where(sql`${t.soatId} IS NOT NULL`),
  // LA restricción que protege el dinero: un SOAT se concilia como MUCHO una vez, en toda la base.
  // Va sobre un uuid, así que —a diferencia de un UNIQUE sobre la póliza— no puede fallar por datos
  // heredados: al crearse, la tabla está vacía.
  soatUnicaIdx: uniqueIndex('idx_flito_concil_linea_soat_unica').on(t.soatId)
    .where(sql`${t.soatId} IS NOT NULL AND ${t.conciliadaEn} IS NOT NULL`),
  // Mismos CHECK que el `.sql`, por el motivo de arriba: son inline en un `CREATE TABLE IF NOT
  // EXISTS` que no los repara si la tabla ya existe.
  resultadoChk: check('flito_concil_linea_resultado_chk',
    sql`${t.resultado} IN ('ok','no_encontrada','no_pagado','valor_distinto','poliza_duplicada','otra_compania','ya_conciliada','cobrado_otro_cliente')`),
  // La póliza se guarda YA normalizada: escribir el valor crudo es un 23514 inmediato en vez de una
  // fila que no cruzará nunca con nada.
  polizaNormChk: check('flito_concil_linea_poliza_norm_chk',
    sql`${t.numeroPolizaNorm} ~ '^[A-Z0-9]{1,60}$'`),
  // Solo una línea que cruzó puede quedar conciliada.
  selloChk: check('flito_concil_linea_sello_chk',
    sql`${t.conciliadaEn} IS NULL OR (${t.soatId} IS NOT NULL AND ${t.resultado} = 'ok')`),
  // Y solo una conciliada puede tener movimiento — LOS DOS movimientos, no solo el del libro del
  // cliente. Con el de tránsito fuera del CHECK, una línea con su salida de tránsito asentada y
  // `conciliada_en` en NULL sería un estado legal; des-sellarla así la saca del índice parcial
  // `idx_flito_concil_linea_soat_unica` y libera el SOAT para conciliarse otra vez en otra boleta,
  // con el dinero de tránsito ya descontado y sin contramovimiento (doble descuento, CF-04).
  movChk: check('flito_concil_linea_mov_chk',
    sql`(${t.movimientoBolsaId} IS NULL AND ${t.movimientoTransitoId} IS NULL)
           OR ${t.conciliadaEn} IS NOT NULL`),
}));

// ============================================================================
// Siigo API — facturación electrónica de trámites (Feature #11239)
// ============================================================================

/**
 * Credenciales de Siigo API cifradas con AES-256-GCM (HU #11247).
 *
 * Mismo esquema probado en `rndcCredenciales`: el cipher viaja con su IV, su authTag y un
 * `aadNonce` propio que entra en los datos asociados. Eso ata el ciphertext a ESTA fila: copiar
 * el cipher a otra fila, o alterar el nonce, hace fallar la verificación de integridad en vez de
 * devolver un texto plano equivocado.
 *
 * El `username` va en claro a propósito: no es el secreto y hace falta para poder listar y
 * distinguir credenciales sin descifrar nada. El secreto es `access_key`.
 *
 * Solo puede haber UNA credencial activa por ambiente. Se garantiza con un índice único parcial
 * —no solo por convención de código— porque dos activas harían que la credencial usada dependiera
 * del orden de las filas.
 */
export const siigoCredenciales = pgTable('siigo_credenciales', {
  id: smallserial('id').primaryKey(),
  ambiente: varchar('ambiente', { length: 12 }).notNull(),
  username: varchar('username', { length: 150 }).notNull(),
  accessKeyCipher: bytea('access_key_cipher').notNull(),
  accessKeyIv: bytea('access_key_iv').notNull(),
  accessKeyAuthTag: bytea('access_key_auth_tag').notNull(),
  aadNonce: uuid('aad_nonce').notNull(),
  keyVersion: smallint('key_version').notNull().default(1),
  activo: boolean('activo').notNull().default(true),
  notas: text('notas'),
  // Rastro durable del descifrado fallido. Un log se rota y se pierde; esta columna sobrevive y
  // explica en la propia pantalla por qué la credencial dejó de estar activa.
  descifradoFallidoEn: timestamp('descifrado_fallido_en', { withTimezone: true }),
  descifradoFallidoMotivo: varchar('descifrado_fallido_motivo', { length: 200 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: integer('created_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: integer('updated_by').references(() => users.id),
}, (t) => ({
  // Una sola credencial activa por ambiente. Parcial: las desactivadas son historial y pueden
  // repetirse cuantas veces se reconfigure.
  ambienteActivoIdx: uniqueIndex('idx_siigo_credenciales_ambiente_activo')
    .on(t.ambiente)
    .where(sql`${t.activo}`),
}));

/**
 * Bitácora WORM de las llamadas a Siigo API (HU #11251).
 *
 * Append-only de verdad: disparadores en la base prohíben UPDATE y DELETE, y el rol de la
 * aplicación solo tiene SELECT e INSERT. Una factura electrónica respalda una venta ante la DIAN;
 * si el registro de lo que se envió se pudiera editar, no probaría nada.
 *
 * `operacion` es texto y no un enum porque el catálogo crecerá con las Features 11 a 15, y un enum
 * obligaría a una migración por cada operación nueva.
 */
export const siigoOperaciones = pgTable('siigo_operaciones', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  operacion: varchar('operacion', { length: 40 }).notNull(),
  metodo: varchar('metodo', { length: 10 }),
  ruta: varchar('ruta', { length: 300 }),
  entidadTipo: varchar('entidad_tipo', { length: 20 }),
  entidadId: varchar('entidad_id', { length: 60 }),
  intento: smallint('intento').notNull().default(1),
  ambiente: varchar('ambiente', { length: 12 }).notNull(),
  /** 'real' o 'mock': distingue una prueba de una operación productiva. */
  modo: varchar('modo', { length: 10 }).notNull().default('real'),
  /** Ya saneado: nunca contiene el access_key ni la cabecera de autorización. */
  requestBody: jsonb('request_body'),
  responseBody: jsonb('response_body'),
  statusHttp: smallint('status_http'),
  resultado: varchar('resultado', { length: 20 }).notNull(),
  codigo: varchar('codigo', { length: 60 }),
  mensaje: text('mensaje'),
  duracionMs: integer('duracion_ms'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: integer('created_by').references(() => users.id),
}, (t) => ({
  entidadIdx: index('idx_siigo_op_entidad').on(t.entidadTipo, t.entidadId, t.createdAt),
  createdAtIdx: index('idx_siigo_op_created_at').on(t.createdAt),
  resultadoIdx: index('idx_siigo_op_resultado').on(t.resultado, t.createdAt),
}));

/**
 * Mapeo de cada concepto facturable al producto que lo representa en Siigo (HU #11282).
 *
 * Es la tabla que hace que el AC3 sea cierto: el armado de la factura lee de aquí la clasificación
 * tributaria, los impuestos y la unidad de medida, así que cambiarlos es editar configuración y no
 * desplegar. En el servicio de armado no puede aparecer ninguna condición sobre un concepto
 * concreto — si la ves, es un bug de diseño, no un atajo.
 *
 * `ambiente` forma parte de la identidad de la fila. El `codigoProducto` y los ids de `impuestos`
 * pertenecen a UNA empresa de Siigo, y pruebas y producción son empresas distintas con ids
 * distintos (docs/integraciones/siigo-api.md §Notas, punto 6). Sin ambiente en la llave, configurar
 * contra pruebas dejaría escrito un código que en producción es otro producto — y eso ya es una
 * factura mal emitida ante la DIAN. Además la HU #11285 exige que al cambiar de ambiente NO se
 * hereden confirmaciones del otro, cosa imposible con una sola fila por concepto.
 *
 * `tipoTramite` NULL = configuración genérica; con tipo de trámite, precedencia sobre la genérica.
 * Misma convención ya probada en `flitoTarifasCompania`.
 *
 * NO modela retenciones (AC7): no está confirmado si ReteICA, ReteIVA o autorretención aplican a
 * las facturas de FLIT. Incorporarlas sería añadir columnas aquí, no rehacer el modelo.
 */
export const siigoMapeoConceptos = pgTable('siigo_mapeo_conceptos', {
  id: uuid('id').primaryKey().defaultRandom(),
  ambiente: varchar('ambiente', { length: 12 }).notNull(),
  concepto: varchar('concepto', { length: 30 }).notNull(),
  /** NULL = configuración genérica del concepto. Normalizado en mayúsculas. */
  tipoTramite: varchar('tipo_tramite', { length: 60 }),
  /** `code` de POST /v1/products: alfanumérico, sin espacios, ≤30. NULL = sin mapear todavía. */
  codigoProducto: varchar('codigo_producto', { length: 30 }),
  nombreProducto: varchar('nombre_producto', { length: 200 }),
  /** gravado | exento | excluido. NULL = SIN DECLARAR, que no es lo mismo que excluido. */
  clasificacionTributaria: varchar('clasificacion_tributaria', { length: 12 }),
  /** `[{ id, nombre?, porcentaje? }]` con ids de GET /v1/taxes de ESTA empresa de Siigo. */
  impuestos: jsonb('impuestos').notNull().default(sql`'[]'::jsonb`),
  unidadMedida: varchar('unidad_medida', { length: 20 }),
  /** Dinero que FLIT recauda y traslada (SOAT, impuesto, derecho), no ingreso propio. */
  ingresoParaTerceros: boolean('ingreso_para_terceros').notNull().default(false),
  /**
   * AC6 — GMF. `false` con `lineaPropiaPendiente = true` significa «sin decidir», NO «se absorbe».
   * Quien arme la factura debe mirar el pendiente antes de actuar.
   */
  facturaLineaPropia: boolean('factura_linea_propia').notNull().default(false),
  lineaPropiaPendiente: boolean('linea_propia_pendiente').notNull().default(false),
  confirmadoContabilidad: boolean('confirmado_contabilidad').notNull().default(false),
  /** Quién y cuándo confirmó. NO se limpian al revertir: el AC4 pide que el rastro sobreviva. */
  confirmadoPorId: integer('confirmado_por_id').references(() => users.id),
  confirmadoEn: timestamp('confirmado_en', { withTimezone: true }),
  confirmacionRevertidaEn: timestamp('confirmacion_revertida_en', { withTimezone: true }),
  /** Nombres de los campos que tumbaron la confirmación. Nunca valores. */
  confirmacionRevertidaPor: varchar('confirmacion_revertida_por', { length: 300 }),
  activo: boolean('activo').notNull().default(true),
  notas: text('notas'),
  /**
   * Última comprobación del código de producto contra Siigo (HU #11283).
   *
   * Es un dato CON FECHA, no una propiedad permanente: alguien puede inactivar el producto en Siigo
   * Nube sin tocar FLITO, y entonces una fila «válida» deja de serlo sin que nadie se entere hasta
   * la primera factura rechazada. `no_verificable` NO es lo mismo que `no_existe`: significa que
   * Siigo no respondió y el dato puede estar perfecto.
   *
   * Deliberadamente separado de `confirmadoContabilidad`: son dos afirmaciones de dos responsables
   * distintos. Contabilidad firma el tratamiento tributario; la validación comprueba que el
   * producto existe. Colapsarlas haría que revalidar tumbara firmas contables.
   */
  validacionEstado: varchar('validacion_estado', { length: 20 }).notNull().default('sin_validar'),
  /** Texto accionable. Nunca el mensaje crudo de Siigo, ni SQL, ni la clave del cortacircuitos. */
  validacionMensaje: varchar('validacion_mensaje', { length: 300 }),
  /** Fecha del último INTENTO. Con `no_verificable` hubo intento y no hubo respuesta. */
  validadoEn: timestamp('validado_en', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: integer('created_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: integer('updated_by').references(() => users.id),
}, (t) => ({
  // Una sola fila viva por ambiente + concepto + tipo. El COALESCE evita varias genéricas del mismo
  // concepto (NULL no colisiona con NULL). Parcial: las desactivadas son historial.
  unicoActivoIdx: uniqueIndex('idx_siigo_mapeo_unico_activo')
    .on(t.ambiente, t.concepto, sql`COALESCE(${t.tipoTramite}, '')`)
    .where(sql`${t.activo}`),
  ambienteConceptoIdx: index('idx_siigo_mapeo_ambiente_concepto').on(t.ambiente, t.concepto),
  // Lo que busca la pantalla tras una revalidación son las EXCEPCIONES, no el total.
  validacionNovedadIdx: index('idx_siigo_mapeo_validacion_novedad')
    .on(t.ambiente, t.validacionEstado)
    .where(sql`${t.validacionEstado} IN ('no_existe', 'inactivo', 'no_verificable')`),
}));

/**
 * Copia local de los catálogos de Siigo (HU #11281).
 *
 * Siigo permite 100 peticiones por minuto por empresa. Resolver el nombre de un vendedor o de una
 * forma de pago cada vez que se pinta una pantalla de parametrización agotaría esa cuota con
 * consultas que devuelven siempre lo mismo. Por eso se cachean aquí y se leen de local.
 *
 * Única por (`ambiente`, `tipo`, `codigo`). Dos razones distintas: el identificador de Siigo solo es
 * único DENTRO de su catálogo —el id 1253 puede ser un grupo de inventario y también una forma de
 * pago— y `pruebas` y `produccion` son EMPRESAS DISTINTAS en Siigo, cada una con sus propios
 * identificadores. Sin `ambiente` en la llave, sincronizar producción pisaría los códigos que
 * coincidieran con los de pruebas e inactivaría el resto del catálogo del otro ambiente por no
 * haber venido en la respuesta.
 *
 * NO hay borrado. Un elemento que deja de venir de Siigo se marca `activo = false` y conserva su
 * fila: una factura emitida el año pasado referencia un centro de costo que quizá ya no existe, y
 * sin la fila no habría forma de explicar esa parametrización.
 *
 * Datos personales: del catálogo de vendedores (`/v1/users`) se guarda SOLO el nombre. Siigo
 * devuelve además `identification` y `email`, que son datos personales bajo la Ley 1581 y no hacen
 * falta para elegir un vendedor, así que no se persisten (ver `siigo.catalogos.service.ts`).
 */
export const siigoCatalogos = pgTable('siigo_catalogos', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  /** 'pruebas' | 'produccion'. Empresas distintas en Siigo: sus catálogos no se mezclan. */
  ambiente: varchar('ambiente', { length: 12 }).notNull(),
  /** 'document_type' | 'user' | 'payment_type' | 'tax' | 'account_group' | 'cost_center'. */
  tipo: varchar('tipo', { length: 30 }).notNull(),
  /** Identificador de Siigo como texto: hay catálogos con código alfanumérico. */
  codigo: varchar('codigo', { length: 60 }).notNull(),
  nombre: varchar('nombre', { length: 200 }).notNull(),
  descripcion: varchar('descripcion', { length: 300 }),
  activo: boolean('activo').notNull().default(true),
  /** Atributos propios del catálogo (porcentaje del impuesto, si maneja vencimiento…). Sin PII. */
  atributos: jsonb('atributos'),
  sincronizadoEn: timestamp('sincronizado_en', { withTimezone: true }).notNull().defaultNow(),
  /** Momento en que dejó de venir de Siigo. Null mientras siga activo. */
  inactivadoEn: timestamp('inactivado_en', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // Es también el índice contra el que resuelve el ON CONFLICT del upsert: si estas columnas y el
  // `target` del upsert dejan de coincidir, la sincronización falla entera en Postgres.
  ambienteTipoCodigoUq: uniqueIndex('idx_siigo_catalogos_ambiente_tipo_codigo')
    .on(t.ambiente, t.tipo, t.codigo),
  // La lectura real de la parametrización: «los elementos activos de este catálogo en este
  // ambiente, por nombre».
  ambienteTipoActivoIdx: index('idx_siigo_catalogos_ambiente_tipo_activo')
    .on(t.ambiente, t.tipo, t.activo, t.nombre),
}));

/**
 * Catálogo oficial de países, departamentos y ciudades de Siigo (HU #11293).
 *
 * Vive aparte de `siigoCatalogos` por una diferencia de fondo: los seis catálogos de aquella tabla
 * se sincronizan llamando a la API, y este **no existe como servicio** — Siigo lo publica como un
 * .xlsx. Meterlo allí obligaría a decir «sincronizado» cuando nadie llamó a Siigo, y a compartir
 * columnas que aquí no significan nada: el listado no depende de la cuenta, así que no tiene
 * ambiente. Se carga desde `src/db/data/siigo-ciudades.json`.
 */
export const siigoCiudades = pgTable('siigo_ciudades', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  /** Ojo: el listado oficial trae `Co`, no `CO`. Se guarda tal cual lo publica Siigo. */
  countryCode: varchar('country_code', { length: 2 }).notNull(),
  countryName: varchar('country_name', { length: 80 }).notNull(),
  stateCode: varchar('state_code', { length: 5 }).notNull(),
  stateName: varchar('state_name', { length: 80 }).notNull(),
  cityCode: varchar('city_code', { length: 10 }).notNull(),
  cityName: varchar('city_name', { length: 80 }).notNull(),
  /** `cityName` sin tildes y en minúsculas: un LIKE sobre una función no usa índice. */
  cityBusqueda: varchar('city_busqueda', { length: 80 }).notNull(),
  /** false = dejó de venir en el listado. No se borra: un cliente antiguo puede referenciarla. */
  activo: boolean('activo').notNull().default(true),
  version: varchar('version', { length: 20 }),
  cargadoEn: timestamp('cargado_en', { withTimezone: true }).notNull().defaultNow(),
  actualizadoEn: timestamp('actualizado_en', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // La clave es la TERNA, no el código de ciudad: el listado trae `05001` dos veces —Medellín en
  // Colombia y Chachapollas en Perú—. Un único sobre `cityCode` habría perdido una de las dos.
  // Es también el target del ON CONFLICT del upsert: si dejan de coincidir, la carga falla entera.
  ternaUq: uniqueIndex('idx_siigo_ciudades_terna').on(t.countryCode, t.stateCode, t.cityCode),
  cascadaIdx: index('idx_siigo_ciudades_cascada').on(t.countryCode, t.stateCode),
  busquedaIdx: index('idx_siigo_ciudades_busqueda').on(t.cityBusqueda),
}));

/**
 * Parámetros operativos del ambiente (migración 0148; antes «configuración global de emisión»).
 *
 * **Ya no dice con qué nacen las facturas.** Hasta el 2026-08-13 guardaba el tipo de comprobante, el
 * vendedor, la forma de pago y el centro de costo con los que se emitía TODO un ambiente. Se retiró:
 * los cuatro se eligen en cada envío, por empresa, y quedan como snapshot inmutable en
 * `siigoLotesFacturacion`. Una configuración global significaba que cambiar el vendedor de una
 * empresa lo cambiaba para todas.
 *
 * Con ella se fueron las cuatro columnas que sostenían preguntas de negocio abiertas —retenciones,
 * moneda, numeración y plazo de vencimiento—, porque esas preguntas se respondieron y una respuesta
 * no necesita una palanca. Están en la 0148 con su respuesta.
 *
 * Quedan dos valores, y siguen en tabla y no en una variable `SIIGO_*` a propósito: son por
 * ambiente, quedan historiados y admiten `CHECK`. No hay pantalla ni endpoint que los escriba —se
 * cambian con una migración—, así que el historial se conserva pero ya nadie inserta filas nuevas.
 */
export const siigoConfigEmision = pgTable('siigo_config_emision', {
  id: uuid('id').primaryKey().defaultRandom(),
  ambiente: varchar('ambiente', { length: 12 }).notNull(),
  /** Desde cuándo se factura. No hay histórico: lo anterior no se emite (pregunta 13, respondida). */
  historicoDesde: date('historico_desde').notNull().defaultNow(),
  /** Minutos tras los cuales una factura `en_proceso` se considera huérfana y se reconcilia. */
  arrendamientoEnProcesoMin: integer('arrendamiento_en_proceso_min').notNull().default(15),
  /** false = fila histórica. */
  vigente: boolean('vigente').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: integer('created_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: integer('updated_by').references(() => users.id),
}, (t) => ({
  // AC1 — una sola vigente por ambiente. Parcial: las apagadas son historial y se repiten.
  vigenteUq: uniqueIndex('idx_siigo_config_emision_vigente')
    .on(t.ambiente)
    .where(sql`${t.vigente}`),
  // DESC igual que en la migración 0130: la consulta real es «lo más reciente primero», y una
  // deriva de dirección entre `schema.ts` y la base es de las que no se notan hasta que alguien
  // regenera algo a partir del esquema.
  historialIdx: index('idx_siigo_config_emision_historial').on(t.ambiente, desc(t.createdAt)),
}));

/**
 * Lote de facturación: el conjunto de trámites que se factura junto (HU #11323, Feature #11242).
 *
 * **Su identidad es determinista y sale de lo que contiene.** Con un id aleatorio, dos encolados
 * del mismo trámite producirían dos lotes, dos claves de idempotencia distintas y **dos facturas
 * DIAN reales** — la misma carrera que el `UNIQUE` sobre `idempotencyKey` evita un nivel más abajo,
 * pero fuera de su alcance. Reencolar el mismo conjunto devuelve el lote que ya existía.
 */
export const siigoLotesFacturacion = pgTable('siigo_lotes_facturacion', {
  id: uuid('id').primaryKey().defaultRandom(),
  ambiente: varchar('ambiente', { length: 12 }).notNull(),
  /** Solo 'por_tramite' (D-1 diferida). Consolidar exige migración, es decir, una decisión. */
  estrategia: varchar('estrategia', { length: 30 }).notNull().default('por_tramite'),
  /**
   * sha256 hex de los ids de trámite Y los conceptos, ambos ORDENADOS: ni el orden de selección en
   * la pantalla ni el de los conceptos cambian la identidad del lote (A1, migración 0146).
   */
  huella: varchar('huella', { length: 64 }).notNull(),
  /** Conceptos elegidos al enviar, ordenados. Vacío = lote anterior a A1 (todos los aplicables). */
  conceptos: text('conceptos').array().notNull().default(sql`'{}'::text[]`),
  /**
   * Snapshot INMUTABLE de la emisión elegida al enviar (A2). Entra en la huella: cambiar el vendedor
   * cambia la factura, así que cambia la identidad del lote.
   *
   * **`null` = lote encolado antes del 2026-08-13, al que le falta con qué emitir.** Hasta la 0148
   * significaba «usar la configuración global vigente»; esa configuración se retiró y ya no hay nada
   * detrás, así que `prepararEmision` rechaza el lote y pide reenviar los trámites. No se puso
   * `NOT NULL` para no tener que inventarle un vendedor a esos lotes en una migración — se prefiere
   * una fila que falla ruidosamente al emitir sobre una que emite con datos que nadie eligió.
   *
   * `centroCostoCodigo` es la excepción: ahí `null` sigue siendo legítimo, porque solo es obligatorio
   * cuando el comprobante lo exige (`cost_center_mandatory` de `/v1/document-types`).
   */
  documentoTipoCodigo: varchar('documento_tipo_codigo', { length: 60 }),
  vendedorCodigo: varchar('vendedor_codigo', { length: 60 }),
  formaPagoCodigo: varchar('forma_pago_codigo', { length: 60 }),
  centroCostoCodigo: varchar('centro_costo_codigo', { length: 60 }),
  /**
   * Si al enviar se pidió que la factura saliera por correo (HU #11708, migración 0161).
   *
   * **No entra en la huella**, y esa es la diferencia con los cuatro campos de arriba. El vendedor
   * cambia el DOCUMENTO que ve la DIAN; el correo solo dice qué hacer con él después. Meterlo en la
   * identidad del lote le daría dos claves de idempotencia al mismo documento fiscal —y con ellas la
   * posibilidad de dos facturas ante la DIAN— para expresar una diferencia que la DIAN no ve. Un
   * segundo envío con la casilla cambiada recibe `ya_estaba`, y el correo se pide con el reenvío.
   */
  correoSolicitado: boolean('correo_solicitado').notNull().default(false),
  /**
   * Direcciones elegidas al enviar. **Vacío = las de la ficha del cliente, no «a nadie»**: quien no
   * quiere que salga no marca `correoSolicitado`.
   *
   * DATO PERSONAL en una tabla que no tenía ninguno. Se guarda porque la emisión ocurre después y en
   * otro proceso, y para entonces la ficha pudo cambiar. La contrapartida no es opcional: el flujo
   * de supresión de `privacy.routes.ts` la vacía con `purgarDestinatariosDeLotes`, igual que redacta
   * las actas. Toda dirección que este programa guarda tiene que estar al alcance de la purga.
   */
  correoDestinatarios: jsonb('correo_destinatarios').$type<SiigoDestinatario[]>().notNull().default([]),
  creadoPor: integer('creado_por').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // Es también la garantía del AC1: entre un SELECT y un INSERT cabe otra petición, así que la
  // idempotencia del encolado no puede vivir en el servicio.
  naturalUq: uniqueIndex('idx_siigo_lotes_natural').on(t.ambiente, t.estrategia, t.huella),
}));

/**
 * La factura electrónica (HU #11323).
 *
 * Una factura aceptada por la DIAN **no se puede deshacer**, así que toda la unicidad de este
 * módulo la impone la base de datos y nunca el código.
 *
 * El `UNIQUE` de la clave de idempotencia es **por ambiente**, no global. Global parece más seguro
 * y es lo contrario: `pruebas` y `produccion` son empresas distintas de Siigo, así que un lote
 * ensayado en pruebas dejaría su clave ocupada y la emisión real del mismo lote fallaría para
 * siempre.
 */
export const siigoFacturas = pgTable('siigo_facturas', {
  id: uuid('id').primaryKey().defaultRandom(),
  loteId: uuid('lote_id').notNull().references(() => siigoLotesFacturacion.id),
  ambiente: varchar('ambiente', { length: 12 }).notNull(),
  /** Pregunta 9 abierta (¿una sola empresa emisora?). Registrarlo ahora es gratis; después, imposible. */
  empresaEmisoraNit: varchar('empresa_emisora_nit', { length: 20 }),
  /** Derivada del lote, estable, NUNCA aleatoria. El contrato exige alfanumérico ≤30. */
  idempotencyKey: varchar('idempotency_key', { length: 30 }).notNull(),

  siigoInvoiceId: varchar('siigo_invoice_id', { length: 60 }),
  numero: varchar('numero', { length: 60 }),
  comprobanteNombre: varchar('comprobante_nombre', { length: 120 }),
  cufe: varchar('cufe', { length: 200 }),
  publicUrl: text('public_url'),
  /** `numeric` llega como CADENA por drizzle. No compararlo con un número sin convertir. */
  totalSiigo: numeric('total_siigo', { precision: 14, scale: 2 }),

  estado: varchar('estado', { length: 20 }).notNull().default('en_proceso'),
  /** Reloj del arrendamiento: sin esto, un worker caído bloquea la clave para siempre. */
  enProcesoDesde: timestamp('en_proceso_desde', { withTimezone: true }),
  intentos: integer('intentos').notNull().default(0),
  errorCode: varchar('error_code', { length: 80 }),
  errorDetalle: text('error_detalle'),
  enviadaEn: timestamp('enviada_en', { withTimezone: true }),

  /**
   * Marca APARTE del estado. Una factura emitida cuyo total no cuadra con la liquidación sigue
   * estando emitida —el documento existe ante la DIAN— y además necesita que alguien la mire.
   * Como estado se habría perdido la primera mitad.
   */
  requiereRevision: boolean('requiere_revision').notNull().default(false),
  revisionMotivo: text('revision_motivo'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idemUq: uniqueIndex('idx_siigo_facturas_idem').on(t.ambiente, t.idempotencyKey),
  enProcesoIdx: index('idx_siigo_facturas_en_proceso').on(t.enProcesoDesde),
  estadoIdx: index('idx_siigo_facturas_estado').on(t.ambiente, t.estado, desc(t.createdAt)),
  // Migración 0149. **No es para el JOIN de la reconciliación**, que entra por `id` —la primaria— y
  // desde esa única fila alcanza el lote por la primaria del lote: ese camino no lo toca. Está
  // porque `lote_id` era una clave foránea SIN índice, y sin él cualquier comprobación de integridad
  // sobre `siigo_lotes_facturacion` recorre esta tabla entera, que solo crece.
  loteIdx: index('idx_siigo_facturas_lote').on(t.loteId),
}));

/**
 * Qué trámites cubre cada factura (HU #11323).
 *
 * **N:1 desde el primer día** aunque hoy siempre tenga una sola fila: es lo que permitirá habilitar
 * la facturación consolidada sin migrar `siigoFacturas`.
 *
 * `activo` es un espejo de «su factura no está fallida», mantenido por un disparador. Existe porque
 * el predicado de un índice parcial no admite subconsultas, y comprobarlo en el servicio no sirve:
 * entre el SELECT y el INSERT caben dos peticiones, y el resultado de esa carrera son dos facturas
 * DIAN sobre el mismo trámite.
 */
export const siigoFacturaTramites = pgTable('siigo_factura_tramites', {
  id: uuid('id').primaryKey().defaultRandom(),
  facturaId: uuid('factura_id').notNull().references(() => siigoFacturas.id, { onDelete: 'cascade' }),
  tramiteId: uuid('tramite_id').notNull().references(() => flitoTramites.id),
  /** Se guarda para poder explicar una factura vieja aunque la liquidación cambie después. */
  liquidacionId: uuid('liquidacion_id').references(() => flitoLiquidaciones.id, { onDelete: 'set null' }),
  /** Qué concepto cubre. `null` = factura anterior a A1, que cubría todos los aplicables. */
  concepto: varchar('concepto', { length: 30 }),
  activo: boolean('activo').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  facturaIdx: index('idx_siigo_factura_tramites_factura').on(t.facturaId),
  // Parcial a propósito: una factura `fallida` NO ocupa el trámite, porque el reintento legítimo
  // tiene que poder volver a facturarlo.
  //
  // Por (trámite, concepto) desde A1 (D-5): lo que impide es emitir DOS VECES el mismo concepto del
  // mismo trámite —dos documentos ante la DIAN, irreversibles—, no facturar mañana otro concepto.
  // El COALESCE cubre las filas históricas con `concepto` NULL, que en un índice único serían todas
  // distintas entre sí y dejarían sin protección justo a los datos que ya existen.
  vivoUq: uniqueIndex('idx_siigo_factura_tramites_vivo')
    .on(t.tramiteId, sql`COALESCE(${t.concepto}, '*')`).where(sql`${t.activo}`),
}));

/**
 * Qué trámites contiene un lote (HU #11327, migración 0144).
 *
 * La huella del lote lo IDENTIFICA —sha256 del conjunto ordenado— pero no se puede invertir: sirve
 * para reconocer «esto ya se encoló», no para saber qué hay dentro. Mientras el único que emitía era
 * quien acababa de elegir los trámites daba igual; el trabajador de la cola toma una fila con un
 * `loteId` y nada más, así que sin esta tabla no puede saber qué facturar.
 *
 * La pertenencia se guarda en el LOTE y no en la cola a propósito: la cola dice cuándo toca
 * trabajar, el lote dice sobre qué. Duplicarla en la cola daría dos definiciones del mismo conjunto.
 */
export const siigoLoteTramites = pgTable('siigo_lote_tramites', {
  id: uuid('id').primaryKey().defaultRandom(),
  loteId: uuid('lote_id').notNull()
    .references(() => siigoLotesFacturacion.id, { onDelete: 'cascade' }),
  // RESTRICT explícito: un trámite que se encoló para facturar no se borra dejando el lote
  // apuntando al vacío. El SQL ya lo dice; declararlo aquí evita que `schema.ts` y la migración
  // discrepen, que es una deriva que este repo ya pagó una vez.
  tramiteId: uuid('tramite_id').notNull()
    .references(() => flitoTramites.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // Idempotencia del alta: `asegurarLote` se repite en cada emisión y en cada encolado del mismo
  // conjunto, y tiene que poder repetirse sin duplicar la pertenencia.
  parUq: uniqueIndex('idx_siigo_lote_tramites_par').on(t.loteId, t.tramiteId),
  tramiteIdx: index('idx_siigo_lote_tramites_tramite').on(t.tramiteId),
}));

/**
 * La cola de emisión: qué queda por facturar y cuándo le toca (HU #11327, migración 0144).
 *
 * **Eje APARTE de `siigoFacturas`**, que responde «¿qué le pasó al documento?» y por eso no tiene ni
 * puede tener un estado `pendiente`: su fila nace cuando se reserva la clave de idempotencia, y
 * reservar la clave ya es estar en proceso. Lo que está pendiente es el trámite.
 *
 * **Lo que esta tabla NO garantiza.** No impide la doble factura —eso son la reserva de la clave, el
 * índice de trámites vivos y el `Idempotency-Key`—: impide el TRABAJO duplicado, que dos instancias
 * gasten cuota intentando lo mismo. Y lo impide con el arrendamiento, que no es un quinto estado
 * sino una propiedad de la fila: al vencer vuelve a ser elegible sola, sin que nadie limpie nada
 * detrás de un proceso caído.
 */
export const siigoColaFacturacion = pgTable('siigo_cola_facturacion', {
  id: uuid('id').primaryKey().defaultRandom(),
  // RESTRICT: la fila de cola es el rastro de que alguien pidió facturar esto.
  loteId: uuid('lote_id').notNull()
    .references(() => siigoLotesFacturacion.id, { onDelete: 'restrict' }),
  /** Denormalizado del lote: la sentencia que selecciona Y BLOQUEA no debe alcanzar a otra tabla. */
  ambiente: varchar('ambiente', { length: 12 }).notNull(),
  estado: varchar('estado', { length: 24 }).notNull().default('pendiente'),
  /** Desenlaces de red: Siigo contestó y rechazó. Son los que gastan el techo. */
  intentos: integer('intentos').notNull().default(0),
  maxIntentos: integer('max_intentos').notNull().default(5),
  /** Ciclos SIN desenlace. Techo propio: un Siigo lento no puede dar una factura por perdida. */
  esperas: integer('esperas').notNull().default(0),
  maxEsperas: integer('max_esperas').notNull().default(20),
  /** NOT NULL: una fila sin cita deja de facturarse en silencio, sin que nadie reciba un error. */
  proximoIntentoAt: timestamp('proximo_intento_at', { withTimezone: true }).notNull().defaultNow(),
  ultimoIntentoAt: timestamp('ultimo_intento_at', { withTimezone: true }),
  /** Arrendamiento, no estado. Las dos columnas van juntas o no van (lo afirma un CHECK). */
  tomadoPor: varchar('tomado_por', { length: 120 }),
  tomadoEn: timestamp('tomado_en', { withTimezone: true }),
  /** La factura que produjo el trabajo. La cola la LEE del resultado; nunca escribe en facturas. */
  facturaId: uuid('factura_id').references(() => siigoFacturas.id, { onDelete: 'restrict' }),
  desenlace: varchar('desenlace', { length: 20 }),
  errorCode: varchar('error_code', { length: 80 }),
  errorDetalle: text('error_detalle'),
  encoladoPor: integer('encolado_por').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // Reencolar el mismo conjunto NO crea una segunda fila, y lo garantiza el índice: entre un SELECT
  // y un INSERT cabe otra petición.
  loteUq: uniqueIndex('idx_siigo_cola_lote').on(t.loteId),
  // La consulta del trabajador, exactamente. Parcial: lo terminado es la mayor parte de la tabla con
  // el tiempo y no se vuelve a mirar nunca.
  listaIdx: index('idx_siigo_cola_lista').on(t.ambiente, t.proximoIntentoAt, t.createdAt)
    .where(sql`${t.estado} IN ('pendiente', 'error')`),
  estadoIdx: index('idx_siigo_cola_estado').on(t.ambiente, t.estado, desc(t.createdAt)),
  facturaIdx: index('idx_siigo_cola_factura').on(t.facturaId)
    .where(sql`${t.facturaId} IS NOT NULL`),
}));

/**
 * Historial del estado ante la DIAN (HU #11330, Feature #11243).
 *
 * **Eje distinto del `estado` de `siigoFacturas`.** Aquel responde «¿consiguió FLITO emitirla?»;
 * este, «¿qué dice la autoridad tributaria del documento que ya existe?». Metidos en el mismo
 * campo, una factura `anulada` dejaría de constar como `emitida`, cuando el documento existe ante
 * la DIAN y existirá siempre. Por eso esta HU **no añade una sola columna a `siigoFacturas`**.
 *
 * **Append-only.** El estado vigente es la última fila, no un campo que se sobrescribe: «¿cuándo
 * pasó a rechazada y por qué?» es la pregunta que se hace cuando algo va mal, y un campo
 * sobrescrito no la puede responder. Los disparadores de la migración `0137` prohíben el `DELETE` y
 * limitan el `UPDATE` a que `verificadoEn` avance.
 *
 * Se escribe por una sola puerta —`aplicarEstadoDian()`— y nunca directamente.
 */
export const siigoFacturaEstadosDian = pgTable('siigo_factura_estados_dian', {
  id: uuid('id').primaryKey().defaultRandom(),
  facturaId: uuid('factura_id').notNull()
    .references(() => siigoFacturas.id, { onDelete: 'cascade' }),
  /**
   * Orden total. No sobra teniendo `createdAt`: el `now()` de PostgreSQL es la hora de INICIO DE LA
   * TRANSACCIÓN, así que dos filas de la misma transacción comparten instante y el desempate por
   * un uuid aleatorio sería aleatorio también. «La última fila» se decide por aquí, nunca por fecha.
   */
  secuencia: bigserial('secuencia', { mode: 'number' }).notNull(),
  estado: varchar('estado', { length: 20 }).notNull(),
  /** El CUFE observado. Se repite en cada fila: prueba que se habla del mismo documento. */
  cufe: varchar('cufe', { length: 200 }),
  /** Da sentido a `rechazada`. Sin él, el historial dice que algo falló y no dice qué. */
  motivo: text('motivo'),
  /** `emision | sondeo | webhook | manual`. Ver `siigo-estado-dian.ts`. */
  fuente: varchar('fuente', { length: 12 }).notNull(),
  /** Respuesta cruda YA SANEADA. Nunca contiene la clave con la que se factura. */
  payload: jsonb('payload'),
  registradoPor: integer('registrado_por').references(() => users.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /**
   * Cuándo se confirmó por última vez que el estado seguía siendo este. **Única columna mutable**,
   * y solo hacia adelante: confirmar que una factura sigue aceptada no es un hecho nuevo del
   * documento, es una observación nuestra. Si cada sondeo escribiera una fila, un mes de consultas
   * cada quince minutos dejaría ~2900 filas idénticas y el historial dejaría de ser legible.
   */
  verificadoEn: timestamp('verificado_en', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // UNIQUE y no un índice normal: un `bigserial` se puede sobrescribir o reiniciar, y dos filas de
  // la misma factura con el mismo número volverían ambigua «la última».
  secuenciaUq: uniqueIndex('idx_siigo_estado_dian_secuencia').on(t.facturaId, desc(t.secuencia)),
  facturaFechaIdx: index('idx_siigo_estado_dian_factura_fecha').on(t.facturaId, desc(t.createdAt)),
  // Parcial: las aceptadas y anuladas son la mayoría de la tabla y no hay nada que volver a preguntar.
  pendientesIdx: index('idx_siigo_estado_dian_pendientes').on(t.verificadoEn)
    .where(sql`${t.estado} = 'en_validacion'`),
}));

/**
 * La corrección de una factura ya emitida, hecha por fuera y registrada aquí (HU #11343).
 *
 * **Tabla nueva con clave foránea, sin una sola columna sobre `siigoFacturas`.** No es estética: la
 * Feature #11242 tiene que poder seguir evolucionando su fila sin arrastrar a nadie, y una factura
 * corregida **sigue existiendo ante la DIAN** — el documento no desaparece de la historia porque
 * alguien lo haya anulado después.
 *
 * **Append-only por disparador**, como `siigoOperaciones`. Lo que afirma que una factura se corrigió
 * no puede reescribirse; si se pudiera, no probaría nada. Este módulo no expone actualización ni
 * borrado, y no por olvido: la base los prohíbe.
 *
 * `tipo` **no incluye `nota_credito`**, y esa ausencia es la decisión: no se sabe si corregir una
 * factura emitida es una nota crédito (pregunta 8, abierta). Ver la migración `0140`.
 */
export const siigoFacturaCorrecciones = pgTable('siigo_factura_correcciones', {
  id: uuid('id').primaryKey().defaultRandom(),
  facturaId: uuid('factura_id').notNull().references(() => siigoFacturas.id),
  tipo: varchar('tipo', { length: 20 }).notNull(),
  /** Solo 'manual'. El ejecutor que actúa contra Siigo es la HU #11344, bloqueada. */
  ejecutor: varchar('ejecutor', { length: 20 }).notNull().default('manual'),
  /** Sin identificador no se puede verificar en Siigo, y una corrección no verificable es un rumor. */
  documentoSiigo: varchar('documento_siigo', { length: 100 }).notNull(),
  motivo: text('motivo').notNull(),
  /** Cuándo se hizo EN SIIGO. `createdAt` es cuándo se anotó en FLITO. */
  fechaCorreccion: date('fecha_correccion').notNull(),
  registradoPor: integer('registrado_por').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  facturaIdx: index('idx_siigo_correcciones_factura').on(t.facturaId, desc(t.createdAt)),
}));

/**
 * Acta de entrega por correo de cada factura (HU #11334, migración 0141).
 *
 * El correo lo envía **Siigo**, no FLITO: esto no es una cola de salida y no toca
 * `notification_outbox`. Lo que se guarda es qué le pedimos a Siigo y qué contestó.
 *
 * Append-only con una única puerta: se pueden vaciar los `destinatarios` por un derecho de
 * supresión (Ley 1581) conservando el hecho del envío. Cualquier otro UPDATE y todo DELETE mueren
 * en el disparador — ver el encabezado de la migración.
 */
export const siigoFacturaEnvios = pgTable('siigo_factura_envios', {
  id: uuid('id').primaryKey().defaultRandom(),
  facturaId: uuid('factura_id').notNull().references(() => siigoFacturas.id, { onDelete: 'cascade' }),
  /** 'emision' = el correo que Siigo mandó solo al crear; 'reenvio' = lo pidió una persona. */
  origen: varchar('origen', { length: 12 }).notNull(),
  resultado: varchar('resultado', { length: 16 }).notNull(),
  /** [{ correo, origen }]. La procedencia es lo que hace auditable la resolución de destinatarios. */
  destinatarios: jsonb('destinatarios').$type<SiigoDestinatario[]>().notNull().default([]),
  destinatariosPurgadosEn: timestamp('destinatarios_purgados_en', { withTimezone: true }),
  codigo: varchar('codigo', { length: 60 }),
  motivo: text('motivo'),
  /** NULL cuando lo originó la emisión: ahí no hay una persona que lo pidiera. */
  solicitadoPor: integer('solicitado_por').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  facturaIdx: index('idx_siigo_envios_factura').on(t.facturaId, desc(t.createdAt)),
}));

/**
 * Vínculo entre un cliente de FLITO y su tercero en Siigo (HU #11297, migración 0143).
 *
 * La clave del tercero EN SIIGO es la pareja (identificación, sucursal): una identificación puede
 * repetirse allá si la sucursal es distinta. El índice único va sobre las dos.
 */
/**
 * Lo último que se usó al facturarle a un cliente (A2, migración 0147).
 *
 * **Recuerda, no parametriza.** Se escribe sola al enviar y solo sirve para precargar el diálogo
 * del envío siguiente. Con qué configuración salió cada factura vive en el lote, que es inmutable.
 */
export const siigoEmisionCliente = pgTable('siigo_emision_cliente', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: integer('client_id').notNull().references(() => clients.id, { onDelete: 'cascade' }),
  ambiente: varchar('ambiente', { length: 12 }).notNull(),
  documentoTipoCodigo: varchar('documento_tipo_codigo', { length: 60 }),
  vendedorCodigo: varchar('vendedor_codigo', { length: 60 }),
  formaPagoCodigo: varchar('forma_pago_codigo', { length: 60 }),
  centroCostoCodigo: varchar('centro_costo_codigo', { length: 60 }),
  actualizadoPor: integer('actualizado_por').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // `pruebas` y `produccion` son empresas distintas de Siigo: un vendedor de una no significa nada
  // en la otra, y precargar el diálogo de producción con un código de pruebas sería un rechazo que
  // nadie entendería.
  clienteAmbienteUq: uniqueIndex('idx_siigo_emision_cliente').on(t.clientId, t.ambiente),
}));

export const siigoTerceros = pgTable('siigo_terceros', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: integer('client_id').notNull().references(() => clients.id, { onDelete: 'cascade' }),
  /** Lo único que no podemos reconstruir por nuestra cuenta si se pierde. */
  siigoCustomerId: varchar('siigo_customer_id', { length: 60 }).notNull(),
  /** Copia de la pareja en el momento del vínculo: permite detectar una discrepancia posterior. */
  identificacion: varchar('identificacion', { length: 50 }).notNull(),
  sucursal: integer('sucursal').notNull().default(0),
  /** Hash del objeto EXACTO enviado. Responde «¿cambió?» sin guardar una copia de los datos. */
  huella: varchar('huella', { length: 64 }).notNull(),
  sincronizadoEn: timestamp('sincronizado_en', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  parejaUq: uniqueIndex('idx_siigo_terceros_identificacion_sucursal').on(t.identificacion, t.sucursal),
  clienteUq: uniqueIndex('idx_siigo_terceros_cliente').on(t.clientId),
  /** Y un tercero tiene UN cliente: sin esto, dos clientes pueden acabar facturando contra el mismo. */
  customerUq: uniqueIndex('idx_siigo_terceros_customer').on(t.siigoCustomerId),
}));

// ═══════════════════════════════════════════════════════════════════════════
// FLITO — Monitoreo de comparendos (Feature #11492, 17a). Migración 0150.
//
// Módulo `flito-comparendos`: inventario multi-NIT de comparendos traídos de SIMIT (Verifik) y de
// los municipales (UTS), que se compara entre corridas de sync para detectar altas y bajas.
//
// NO es el gate SIMIT del traspaso, ni el pre-vuelo, ni el incidente PESV `comparendo`: aquellos
// responden «¿este vehículo puede traspasarse hoy?» con una consulta que caduca; este lleva un
// histórico. Ver docs/dominio.md y ADR-0001..0003.
// ═══════════════════════════════════════════════════════════════════════════

export const flitoComparendosEstadoEnum = pgEnum('flito_comparendos_estado', ['activo', 'inactivo']);
export const flitoComparendosSyncEstadoEnum = pgEnum('flito_comparendos_sync_estado', [
  'running', 'completed', 'partial', 'failed',
]);
// El cuarto valor, `gestion`, lo añade la migración 0154 (HU #11556) y va AL FINAL: el orden de
// `pg_enum` es el orden de comparación del tipo, y un `ADD VALUE ... BEFORE/AFTER` reordenaría algo
// que nadie pidió reordenar. Los tres primeros los escribe el sync; `gestion` lo escribe una
// persona desde el endpoint de gestión (HU #11557), y es el único que no viene de una corrida.
export const flitoComparendosEventoTipoEnum = pgEnum('flito_comparendos_evento_tipo', [
  'primera_llegada', 'inactivacion', 'reaparicion', 'gestion',
]);
export const flitoComparendosOrigenMergeEnum = pgEnum('flito_comparendos_origen_merge', [
  'simit', 'municipal', 'ambos',
]);
// Comparendo o multa (HU #11712, migración 0160). Los dos endpoints devuelven las dos cosas en la
// misma lista y lo que las distingue es la resolución: sin resolución sigue siendo comparendo, con
// resolución ya es multa. Es un enum y no un booleano porque un booleano no sabe decir «no se
// sabe», que es exactamente lo que hay que decir del histórico anterior a la 0160 —y no es un
// `varchar` con CHECK porque cuesta lo mismo y pierde la unión tipada en TypeScript.
export const flitoComparendosTipoRegistroEnum = pgEnum('flito_comparendos_tipo_registro', [
  'comparendo', 'multa',
]);

/**
 * NITs a monitorear (CF-01). Catálogo propio y no una vista de `clients`: se monitorean empresas
 * que pueden no ser clientes nuestros, y un cliente puede no monitorearse.
 */
export const flitoComparendosNits = pgTable('flito_comparendos_nits', {
  id: uuid('id').primaryKey().defaultRandom(),
  nit: varchar('nit', { length: 20 }).notNull(),
  alias: varchar('alias', { length: 120 }),
  activo: boolean('activo').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: integer('created_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: integer('updated_by').references(() => users.id),
}, (t) => ({
  nitUq: uniqueIndex('uq_flito_comparendos_nits_nit').on(t.nit),
}));

/**
 * Municipios fuente (CF-02). `codigoFuente` es el valor literal que viaja en `?fuente=` a UTS;
 * `nombre` es para la pantalla de 17b. Separados porque el proveedor espera 'ITAGUI' y a un humano
 * se le muestra 'Itagüí': con una sola columna, corregir la ortografía rompería la integración.
 */
export const flitoComparendosMunicipios = pgTable('flito_comparendos_municipios', {
  id: uuid('id').primaryKey().defaultRandom(),
  codigoFuente: varchar('codigo_fuente', { length: 40 }).notNull(),
  nombre: varchar('nombre', { length: 80 }).notNull(),
  activo: boolean('activo').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  fuenteUq: uniqueIndex('uq_flito_comparendos_municipios_fuente').on(t.codigoFuente),
}));

/** Causales de gestión (CF-04). Catálogo de 17a; quien las asigna a un comparendo es 17b. */
export const flitoComparendosCausales = pgTable('flito_comparendos_causales', {
  id: uuid('id').primaryKey().defaultRandom(),
  nombre: varchar('nombre', { length: 120 }).notNull(),
  activo: boolean('activo').notNull().default(true),
  orden: smallint('orden').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  nombreUq: uniqueIndex('uq_flito_comparendos_causales_nombre').on(t.nombre),
}));

/**
 * Token Verifik SIMIT cifrado en reposo (CF-03, ADR-0002). Mismo esquema que `siigoCredenciales`.
 *
 * Singleton lógico: una sola fila activa, garantizada por índice único PARCIAL y no por convención
 * —con dos activas, el token usado dependería del orden de las filas—. Las inactivas son el
 * historial de rotación, de donde sale el «quién/cuándo» que pide el CF-03.
 */
export const flitoComparendosTokenSimit = pgTable('flito_comparendos_token_simit', {
  id: smallserial('id').primaryKey(),
  tokenCipher: bytea('token_cipher').notNull(),
  tokenIv: bytea('token_iv').notNull(),
  tokenAuthTag: bytea('token_auth_tag').notNull(),
  aadNonce: uuid('aad_nonce').notNull(),
  keyVersion: smallint('key_version').notNull().default(1),
  activo: boolean('activo').notNull().default(true),
  // Rastro durable del descifrado fallido (patrón de `siigoCredenciales`): un log se rota y se
  // pierde; estas columnas sobreviven y explican por qué el token dejó de servir.
  descifradoFallidoEn: timestamp('descifrado_fallido_en', { withTimezone: true }),
  descifradoFallidoMotivo: varchar('descifrado_fallido_motivo', { length: 200 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: integer('created_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: integer('updated_by').references(() => users.id),
}, (t) => ({
  unActivo: uniqueIndex('uq_flito_comparendos_token_activo').on(t.activo).where(sql`${t.activo}`),
}));

/**
 * Mapa versionable fuente → canónico (ADR-0003). Es tabla y no if/else en el servicio para que
 * renombrar un campo del proveedor sea una fila con su fecha y su nota, no un despliegue.
 *
 * El merge lee la versión MÁXIMA. La v1 que siembra la 0150 nace `provisional=true` porque se
 * dedujo sin payloads reales; la HU #11501 la verifica y siembra la v2.
 *
 * `prioridad` (menor gana) ordena los candidatos de un mismo `targetField` dentro de un origen: el
 * diseño los lista en orden de preferencia y sin esta columna ese orden se perdía al insertar.
 */
export const flitoComparendosFieldMap = pgTable('flito_comparendos_field_map', {
  id: uuid('id').primaryKey().defaultRandom(),
  version: integer('version').notNull(),
  origen: varchar('origen', { length: 20 }).notNull(), // 'simit' | 'municipal'
  sourcePath: varchar('source_path', { length: 120 }).notNull(),
  targetField: varchar('target_field', { length: 60 }).notNull(),
  prioridad: smallint('prioridad').notNull().default(0),
  provisional: boolean('provisional').notNull().default(true),
  notas: text('notas'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  verOrigPath: uniqueIndex('uq_flito_comparendos_field_map').on(t.version, t.origen, t.sourcePath),
}));

/**
 * Registro consolidado: canónico tipado (lo que 17b filtra y exporta) + payload crudo de cada
 * fuente (la red para re-mergear si la homologación v1 resultó equivocada, sin volver a llamar al
 * proveedor).
 *
 * Unicidad por `numeroComparendo` y no por (nit, numero): el número lo asigna el Estado y es único
 * en el país (CF-07). La placa no es llave — un vehículo acumula comparendos.
 */
export const flitoComparendosRegistros = pgTable('flito_comparendos_registros', {
  id: uuid('id').primaryKey().defaultRandom(),
  numeroComparendo: varchar('numero_comparendo', { length: 60 }).notNull(),
  nitMonitoreado: varchar('nit_monitoreado', { length: 20 }).notNull(),
  // Campos de FUENTE: los escribe el sync y nadie más. No hay endpoint que los edite (CF-09).
  placa: varchar('placa', { length: 10 }),
  codigoInfraccion: varchar('codigo_infraccion', { length: 20 }),
  descripcionInfraccion: text('descripcion_infraccion'),
  fechaComparendo: date('fecha_comparendo'),
  // Cuándo se NOTIFICÓ el comparendo (HU #11794, migración 0164). Columna propia y no un dato
  // derivable: las dos fuentes la publican —en tres grafías distintas— y de ella cuelga el conteo de
  // términos del proceso. Un dato que no es columna no se puede filtrar ni ordenar, y el payload
  // crudo viene podado a la lista blanca del `field_map` (RN-25).
  //
  // `null` significa «no notificado o no se sabe», y las dos cosas caben en el mismo nulo a
  // propósito: ninguna de las dos fuentes distingue «todavía no se notificó» de «no publico la
  // fecha». Lo que NO cabe es `1900-01-01`: ese valor es el CENTINELA con el que el proveedor dice
  // «no notificado» (premisa documentada en la 0158), y persistirlo guardaría una fecha del siglo
  // XIX como si fuera un hecho. Lo descarta `fechaCanonica`, para esta columna Y para
  // `fecha_comparendo` — el mismo centinela con el mismo criterio.
  //
  // Dato de FUENTE (CF-09): lo escribe el sync y ningún endpoint de gestión lo edita.
  fechaNotificacion: date('fecha_notificacion'),
  organismo: varchar('organismo', { length: 120 }),
  // A qué municipio se le PREGUNTÓ. No cambia de significado con la HU #11878: sigue siendo la
  // trazabilidad de la corrida —qué fuente devolvió esta fila— y es `null` en todo comparendo que
  // solo vio el SIMIT, porque a nadie se le preguntó por él.
  municipioFuente: varchar('municipio_fuente', { length: 40 }),
  // De qué municipio ES el comparendo (HU #11878, migración 0165). Es OTRA pregunta que la de
  // arriba, y confundirlas es el defecto que esta columna cierra: filtrar por Medellín contra
  // `municipio_fuente` escondía los comparendos de Medellín que solo había reportado el SIMIT, cuyo
  // `organismo` («STRIA DE TTOyTTE MEDELLIN») sí decía de dónde eran.
  //
  // Lo DERIVA `municipioDelComparendo` (`flito-comparendos-merge.ts`) en dos escalones: el municipio
  // consultado si lo hay, y si no el `codigo_fuente` del catálogo que aparezca —con límite de
  // palabra y siendo el ÚNICO que aparece— dentro del organismo ya resuelto. `null` significa «no se
  // sabe de dónde es», nunca cadena vacía, y ahí caen tanto lo irreconocible como lo AMBIGUO: dos
  // municipios dentro del mismo texto no se desempatan, se declaran desconocidos.
  //
  // SIN FK contra `flito_comparendos_municipios`, igual que `municipio_fuente` y por el mismo
  // motivo: renombrar un `codigo_fuente` en la parametrización se convertiría en un error de
  // escritura sobre el histórico. Se re-deriva entera en cada sync (como `tipo_registro`), así que
  // el catálogo que crece corrige solo lo que antes no supo reconocer.
  municipioComparendo: varchar('municipio_comparendo', { length: 40 }),
  monto: numeric('monto', { precision: 14, scale: 2 }),
  estadoFuente: varchar('estado_fuente', { length: 80 }),
  // Comparendo o multa, y la resolución que lo convirtió (HU #11712, migración 0160). Las tres son
  // nullable y SIN default, y eso es la afirmación principal de la HU: `null` significa «no se
  // sabe», que es todo lo que sabemos del histórico anterior a la 0160 —sus payloads ya fueron
  // podados y ninguna versión del mapa nombraba la resolución, así que el dato no está en ninguna
  // parte—. Un `default 'comparendo'` no sería optimismo transitorio: las filas `inactivo` ya no
  // las visita ningún sync (CF-10), así que nadie volvería a corregirlo nunca.
  //
  // `tipoRegistro` lo DERIVA `resolverCampos` de las otras dos, y NO es un campo del `field_map`:
  // si lo fuera, una fila de una tabla de texto elegiría el valor de una columna `enum` y el INSERT
  // reventaría con un `22P02` a mitad de corrida, matando el NIT entero.
  //
  // `idResolucion` es columna propia y no un candidato más de `numeroResolucion` porque es un
  // identificador de SISTEMA del proveedor (`115697134`) y no un número legible: como respaldo del
  // número acabaría pintado en la columna «N.º resolución». Se guarda porque viene nulo mientras es
  // comparendo y con valor cuando ya es multa, así que es la otra mitad de la señal del tipo. No se
  // publica en el API.
  tipoRegistro: flitoComparendosTipoRegistroEnum('tipo_registro'),
  numeroResolucion: varchar('numero_resolucion', { length: 60 }),
  idResolucion: varchar('id_resolucion', { length: 60 }),
  origenMerge: flitoComparendosOrigenMergeEnum('origen_merge').notNull(),
  vistoEnSimit: boolean('visto_en_simit').notNull().default(false),
  vistoEnMunicipal: boolean('visto_en_municipal').notNull().default(false),
  payloadSimit: jsonb('payload_simit'),
  payloadMunicipal: jsonb('payload_municipal'),
  // Estado de monitoreo: lo mantiene el sync comparando corridas.
  estado: flitoComparendosEstadoEnum('estado').notNull().default('activo'),
  primeraVistoEn: timestamp('primera_visto_en', { withTimezone: true }).notNull().defaultNow(),
  ultimoVistoEn: timestamp('ultimo_visto_en', { withTimezone: true }).notNull().defaultNow(),
  inactivadoEn: timestamp('inactivado_en', { withTimezone: true }),
  ultimoSyncRunId: uuid('ultimo_sync_run_id'),
  // Gestión operativa: columnas de 17a, escritura de 17b.
  causalId: uuid('causal_id').references(() => flitoComparendosCausales.id),
  observacion: text('observacion'),
  // Auditoría de la gestión (HU #11556, migración 0154). `updated_at` NO sirve para esto: lo
  // reescribe el sync en cada corrida, así que no distingue una fila gestionada ayer por una
  // persona de una que el sync tocó hace diez minutos. Las dos son nullable y sin default: `null`
  // significa «nadie la ha gestionado», que es lo que vale para todo el histórico anterior.
  //
  // `integer` y no `uuid` porque `users.id` es `serial`: una FK hereda el tipo de a quien apunta.
  // Y `onDelete: 'restrict'` porque esto es auditoría — un `set null` dejaría la fila diciendo que
  // se gestionó en una fecha y por nadie. Un usuario que gestionó comparendos no se borra, se
  // desactiva. La cláusula está afirmada contra la 0154 en un test de paridad, porque degradarla
  // deja un esquema válido y una auditoría falseada.
  gestionActualizadaEn: timestamp('gestion_actualizada_en', { withTimezone: true }),
  gestionActualizadaPor: integer('gestion_actualizada_por')
    .references(() => users.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  numeroUq: uniqueIndex('uq_flito_comparendos_numero').on(t.numeroComparendo),
  nitIdx: index('idx_flito_comparendos_nit').on(t.nitMonitoreado),
  placaIdx: index('idx_flito_comparendos_placa').on(t.placa),
  estadoIdx: index('idx_flito_comparendos_estado').on(t.estado),
  // Purga por retención (HU #11511, migración 0152). Ninguno de los de arriba cubre el filtro de la
  // purga —`WHERE ultimo_visto_en < corte ORDER BY ultimo_visto_en LIMIT n`, hasta 20 veces por
  // pasada, más el `count(*)` del dryRun y del freno—, que sin índice es un recorrido secuencial de
  // la tabla que más crece del módulo.
  ultimoVistoIdx: index('idx_flito_comparendos_ultimo_visto').on(t.ultimoVistoEn),
  // Filtros del listado (HU #11555, migración 0153). Los dos primeros llevan detrás las MISMAS
  // columnas del cursor y en el MISMO orden (`created_at DESC, id DESC`, RN-32): con la IGUALDAD
  // delante, el índice entrega la página ya ordenada y el plan pierde el nodo de `Sort`. Sin esa
  // cola, filtrar por municipio sería recorrer la tabla entera y ordenarla para quedarse con 50
  // filas. `origen_merge` no tiene índice a propósito: son tres valores sobre toda la tabla y el
  // planner no lo usaría.
  // Desde la HU #11878 el índice del filtro va sobre `municipio_comparendo` y SUSTITUYE al de
  // `municipio_fuente` (que la 0165 borra), no convive con él: el filtro del listado se mudó de
  // columna y la vieja ya no aparece en ningún `WHERE` guiado por igualdad —solo en
  // `condicionAusente`, donde quien guía es `ultimo_sync_run_id IS DISTINCT FROM` y el municipio
  // entra como `IS NULL OR IN (...)`—. Dos índices con la misma cola sobre la tabla que más crece
  // del módulo serían escrituras pagadas para un plan que nadie pide.
  municipioComparendoCreadoIdx: index('idx_flito_comparendos_municipio_comparendo_creado')
    .on(t.municipioComparendo, desc(t.createdAt), desc(t.id)),
  causalCreadoIdx: index('idx_flito_comparendos_causal_creado')
    .on(t.causalId, desc(t.createdAt), desc(t.id)),
  // `sinCausal=true` necesita un índice PARCIAL propio, y no es una duplicación del anterior: para
  // que un índice entregue el orden ya hecho, su primera columna tiene que estar fijada por una
  // IGUALDAD, y `causal_id IS NULL` no lo es. Medido sobre 200.000 filas (AC5 de la #11555), el
  // índice de arriba no evita el `Sort` ni forzando el plan a mano —`Index Only Scan` + `Sort`,
  // 25,7 ms—, y sin forzar nada el planner elige `Seq Scan` + `top-N heapsort`: 43 ms y 6.343
  // buffers. Con este parcial la misma consulta baja a 0,14 ms y 7 buffers.
  //
  // Sacar `causal_id` del cuerpo al `WHERE` es lo que lo hace posible: dentro del índice ya no hay
  // más que filas sin causal, así que `(created_at DESC, id DESC)` manda desde la primera columna.
  // Y sale más barato de mantener que el índice completo de la causal (6,8 MB contra 12 MB) porque
  // solo indexa la parte de la tabla que le toca.
  sinCausalCreadoIdx: index('idx_flito_comparendos_sin_causal_creado')
    .on(desc(t.createdAt), desc(t.id))
    .where(sql`${t.causalId} is null`),
  // El sello de la gestión es una sola cosa (HU #11557, migración 0156): o están la fecha y el
  // autor, o no está ninguno de los dos. Una fecha sin autor diría que la fila se gestionó y no fue
  // nadie —el mismo daño que el `ON DELETE RESTRICT` de arriba impide por el otro lado (ADR-0005)—
  // y un autor sin fecha sería la mitad de una auditoría. La escritura las pone siempre juntas,
  // también al vaciar la causal y la observación; esto es lo que lo sostiene desde la base.
  gestionAuditoriaChk: check(
    'flito_comparendos_gestion_auditoria_chk',
    sql`(${t.gestionActualizadaEn} is null) = (${t.gestionActualizadaPor} is null)`,
  ),
  // El tipo y la resolución no pueden contradecirse (HU #11712, migración 0160): o la fila no dice
  // nada de las tres (el histórico), o dice el tipo y ese tipo es `multa` exactamente cuando hay
  // alguna de las dos resoluciones. El merge lo cumple por construcción —deriva el tipo del valor
  // que acaba de resolver—, y esto es lo que lo sostiene desde la base para el día que haya un
  // segundo camino de escritura.
  //
  // Las dos piezas que parecen adorno hacen trabajos DISTINTOS, y confundirlas es fácil (verificado
  // contra PostgreSQL 16): la PRIMERA rama está para **admitir el histórico**, no para cerrar un
  // hueco —sin ella, `tipo_registro IS NOT NULL` da FALSE y el CHECK rechaza toda fila sin tipo, que
  // al aplicar la 0160 son TODAS: el `ADD CONSTRAINT` moriría al validar—. Lo que cierra el hueco de
  // la evaluación a NULL es la guarda `is not null` de la SEGUNDA rama: la comparación desnuda
  // `(NULL = 'multa') = (…)` evalúa a NULL y un CHECK que evalúa a NULL PASA, así que sin ella se
  // colaría la fila peor —sin tipo y con número de resolución—; con ella, `FALSE AND NULL` es FALSE.
  tipoResolucionChk: check(
    'flito_comparendos_tipo_resolucion_chk',
    sql`(${t.tipoRegistro} is null and ${t.numeroResolucion} is null and ${t.idResolucion} is null) or (${t.tipoRegistro} is not null and (${t.tipoRegistro} = 'multa') = (${t.numeroResolucion} is not null or ${t.idResolucion} is not null))`,
  ),
}));

/**
 * Timeline (CF-11): llegada, desaparición, reaparición. Responde «¿desde cuándo arrastramos esto?»,
 * que el estado actual no puede contar.
 *
 * El único (registro, tipo, run) es el anti-spam como candado de base: la regla «sin eventos
 * redundantes» aplicada solo en el servicio se rompe con el primer reintento de una corrida.
 */
export const flitoComparendosEventos = pgTable('flito_comparendos_eventos', {
  id: uuid('id').primaryKey().defaultRandom(),
  registroId: uuid('registro_id').notNull()
    .references(() => flitoComparendosRegistros.id, { onDelete: 'cascade' }),
  tipo: flitoComparendosEventoTipoEnum('tipo').notNull(),
  syncRunId: uuid('sync_run_id'),
  detalle: jsonb('detalle'), // sin token; NIT/placa redactados según pii-audit
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  regIdx: index('idx_flito_comparendos_eventos_reg').on(t.registroId, t.createdAt),
  regTipoRunUq: uniqueIndex('uq_flito_comparendos_evento_reg_tipo_run')
    .on(t.registroId, t.tipo, t.syncRunId),
}));

/** Una corrida por disparo de sync (CF-05). */
export const flitoComparendosSyncRuns = pgTable('flito_comparendos_sync_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  estado: flitoComparendosSyncEstadoEnum('estado').notNull().default('running'),
  scopeNits: jsonb('scope_nits').notNull().$type<string[]>(),
  resumen: jsonb('resumen'),
  iniciadoPor: integer('iniciado_por').references(() => users.id),
  iniciadoEn: timestamp('iniciado_en', { withTimezone: true }).notNull().defaultNow(),
  finalizadoEn: timestamp('finalizado_en', { withTimezone: true }),
}, (t) => ({
  // Purga por retención (HU #11511, migración 0152): candidatos por antigüedad, heartbeat de la
  // última corrida ok y listado de corridas recientes. La tabla no tenía más índice que su PK.
  iniciadoIdx: index('idx_flito_comparendos_sync_runs_iniciado').on(t.iniciadoEn),
}));

/**
 * Un paso por par (NIT, fuente). No es telemetría: es la condición del CF-10. Solo se inactiva por
 * ausencia a los NIT con SIMIT ok y TODOS sus municipios activos ok en la corrida — sin el detalle
 * por paso, un timeout se leería como «el comparendo ya no existe».
 */
export const flitoComparendosSyncSteps = pgTable('flito_comparendos_sync_steps', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').notNull()
    .references(() => flitoComparendosSyncRuns.id, { onDelete: 'cascade' }),
  nit: varchar('nit', { length: 20 }).notNull(),
  fuente: varchar('fuente', { length: 40 }).notNull(), // 'simit' | codigoFuente del municipio
  ok: boolean('ok').notNull(),
  httpStatus: smallint('http_status'),
  errorCode: varchar('error_code', { length: 60 }),
  mensaje: text('mensaje'), // sin PII ni token
  itemsLeidos: integer('items_leidos'),
  duracionMs: integer('duracion_ms'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  runIdx: index('idx_flito_comparendos_sync_steps_run').on(t.runId),
}));
