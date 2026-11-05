// FLITO Impuestos: `flito_impuestos` y sus certificaciones contra el RUNT. Se re-exporta desde `../schema.ts` (HU #13984).
import {
  pgTable, varchar, text, boolean, timestamp, integer, pgEnum, index, jsonb, numeric, uuid, smallint,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
// FLITO (migración): tipos de extracción OCR persistidos en columnas jsonb.
// Certificación de impuestos contra el RUNT (Feature #11159): detalle por campo en columna jsonb.
import type {
  ExtraccionImpuesto, ExtraccionFacturaVentaImpuesto, ComparacionFacturaRunt, ComparacionCampo,
} from '@operaciones/shared-types';
import { flitoModalidadEnum } from './_comunes.js';
import { users, clients } from './nucleo.js';
import { organismosTransitoConfig, flitoTramites } from './tramites.js';

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
export const flitoImpuestoEstadoEnum = pgEnum('flito_impuesto_estado', ['pendiente', 'solicitado', 'con_novedad', 'pagado']);
/** HU #12825: ciclo del análisis post-envío. NULL en la columna = nunca encolado (histórico). */
export const flitoImpuestoAnalisisEstadoEnum = pgEnum('flito_impuesto_analisis_estado', ['en_curso', 'completado', 'error_analisis']);
/** HU #12827: semáforo factura vs RUNT. NULL en la columna = sin calcular. */
export const flitoImpuestoSemaforoEnum = pgEnum('flito_impuesto_semaforo', ['verde', 'naranja', 'rojo']);

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
  extraccionFacturaVenta: jsonb('extraccion_factura_venta').$type<ExtraccionFacturaVentaImpuesto>(),
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
  /**
   * HU #12590: fecha-hora en que se cargó la liquidación del impuesto (el documento de la hacienda
   * sin marca). Marca «liquidado» sobre `solicitado`; el estado NO cambia. No es
   * `flito_liquidaciones.liquidado_en` (esa es la Liquidación de FLITO, el total a cobrar).
   */
  liquidadoEn: timestamp('liquidado_en', { withTimezone: true }),
  motivoRechazo: text('motivo_rechazo'),
  extraccion: jsonb('extraccion').$type<ExtraccionImpuesto>(),
  /**
   * HU #12825 (migración 0206): análisis post-envío en segundo plano. `analizadoEn` solo se escribe
   * si corrió al menos un paso; con él poblado y posterior al encolado, el job no re-ejecuta (AC2).
   * `analisisReencolados` lo sube solo la recuperación de huérfanos (AC4: una vez).
   */
  analisisEstado: flitoImpuestoAnalisisEstadoEnum('analisis_estado'),
  analisisEncoladoEn: timestamp('analisis_encolado_en', { withTimezone: true }),
  analisisReencolados: smallint('analisis_reencolados').notNull().default(0),
  analizadoEn: timestamp('analizado_en', { withTimezone: true }),
  /** HU #12827 (migración 0207): semáforo factura de venta vs RUNT y su detalle (motivo en el jsonb). */
  semaforo: flitoImpuestoSemaforoEnum('semaforo'),
  comparacionFacturaRunt: jsonb('comparacion_factura_runt').$type<ComparacionFacturaRunt>(),
  /**
   * HU #12833 (migración 0208): dirección del comprador CONFIRMADA (de la factura o corregida a mano).
   * Vive aquí y no en `flito_compradores` porque el sync con FLIT borra y reinserta esa tabla.
   * `direccionFuente` es el discriminante: NULL = se lee la de FLIT; 'factura' | 'manual'.
   * La propuesta sin confirmar sigue en `extraccionFacturaVenta` (no se duplica).
   */
  direccionFactura: text('direccion_factura'),
  municipioFactura: text('municipio_factura'),
  departamentoFactura: text('departamento_factura'),
  direccionFuente: text('direccion_fuente').$type<'factura' | 'manual'>(),
  direccionPendienteRevision: boolean('direccion_pendiente_revision').notNull().default(false),
  direccionConfirmadaPorId: integer('direccion_confirmada_por_id').references(() => users.id, { onDelete: 'set null' }),
  direccionConfirmadaPorNombre: text('direccion_confirmada_por_nombre'),
  direccionConfirmadaEn: timestamp('direccion_confirmada_en', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  estadoIdx: index('idx_flito_impuestos_estado').on(t.estado),
  organismoIdx: index('idx_flito_impuestos_organismo').on(t.organismoCodigo),
  analisisEnCursoIdx: index('idx_flito_impuestos_analisis_en_curso').on(t.analisisEncoladoEn)
    .where(sql`${t.analisisEstado} = 'en_curso'`),
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
