// Mantenimiento: sistemas, repuestos, rutinas, programación, preórdenes y órdenes de trabajo. Se re-exporta desde `../schema.ts` (HU #13984).
import {
  pgTable, serial, varchar, text, boolean, timestamp, integer, bigint, date, pgEnum, jsonb, numeric,
  bigserial,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { vehicleTypeEnum, fuelTypeEnum } from './_comunes.js';
import { vehicles } from './flota.js';
import { users } from './nucleo.js';

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
