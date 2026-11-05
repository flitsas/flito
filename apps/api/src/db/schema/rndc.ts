// RNDC: catálogos, tenedores, remesas, manifiestos y envío a Mintransporte. Se re-exporta desde `../schema.ts` (HU #13984).
import {
  pgTable, serial, varchar, text, boolean, timestamp, time, integer, bigint, date, pgEnum, index, numeric,
  bigserial, smallserial, uuid, smallint,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { bytea } from './_comunes.js';
import { vehicles } from './flota.js';
import { users, clients } from './nucleo.js';

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
