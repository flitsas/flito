// Flota: vehículos, equipos, mediciones, documentos vehiculares, alertas e historial por VIN. Se re-exporta desde `../schema.ts` (HU #13984).
import {
  pgTable, serial, varchar, text, boolean, timestamp, integer, date, pgEnum, index, jsonb, numeric,
  bigserial,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { vehicleTypeEnum, fuelTypeEnum, docEstadoEnum } from './_comunes.js';
import { users, clients } from './nucleo.js';
import { tramitesDigitales } from './tramites.js';

export const stageEnum = pgEnum('vehicle_stage', [
  'ingreso', 'impuesto', 'soat_pendiente', 'soat_comprado', 'soat_verificado', 'listo',
]);

export const multasEstadoEnum = pgEnum('multas_estado', ['no_consultado', 'sin_multas', 'con_multas', 'acuerdo_pago']);
export const measurementTypeEnum = pgEnum('measurement_type', ['km', 'horas', 'ambos']);
export const workLoadEnum = pgEnum('work_load', ['bajo', 'normal', 'severo']);
export const measurementSourceEnum = pgEnum('measurement_source', ['manual', 'app', 'gps', 'combustible', 'ot']);

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
