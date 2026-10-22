// Épica #12245 — Comprobantes universales (ADR-0018). Vive aparte de `schema.ts` por el techo de
// max-lines (3400), como `schema/permisos.ts`. `schema.ts` la re-exporta.
//
// Un renglón por DOCUMENTO leído (no por archivo): un PDF consolidado produce N filas que comparten
// `soporte_id` y se distinguen por `paginas` (D9). El hecho documental vive aquí; el archivo, en
// `flito_soportes`, que NO gana ni FK nueva ni `tramite_id`.
//
// CHECKs declarados AQUÍ y en la 0198 (lección 0157): un CHECK que solo vive en la base convence a
// quien lee el esquema de que no hace falta migración, y el primer INSERT nuevo muere con 23514.
//
// Import circular a propósito (mismo patrón que `schema/permisos.ts`): las FK de Drizzle son callbacks
// perezosos, así que el ciclo ESM resuelve sin problema.
import {
  pgTable, uuid, varchar, text, boolean, numeric, date, jsonb, integer, timestamp, index, uniqueIndex, check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { ExtraccionComprobante } from '@operaciones/shared-types';
import { flitoServiciosAdicionalesTipos, flitoSoportes, flitoTramites, users } from '../schema.js';

export const flitoComprobantes = pgTable('flito_comprobantes', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Lo genera el navegador y viaja en cada tanda de 5: el resumen del lote es una consulta. */
  loteId: uuid('lote_id').notNull(),
  /** El archivo tal como entró (evidencia). CASCADE: sin archivo no hay hecho documental. */
  soporteId: uuid('soporte_id').notNull().references(() => flitoSoportes.id, { onDelete: 'cascade' }),
  /**
   * El soporte que ve el destino (SOAT/impuesto/derecho): el mismo `soporte_id` cuando el archivo
   * era un solo documento (reescrito en sitio), o un HIJO recortado cuando venía de un consolidado.
   * NULL mientras está pendiente o cuando el concepto es un honorario (no hay destino con soportes).
   */
  soporteAplicadoId: uuid('soporte_aplicado_id').references(() => flitoSoportes.id, { onDelete: 'set null' }),
  /** Páginas (base 1) del consolidado que forman este documento. NULL = el archivo entero. */
  paginas: jsonb('paginas').$type<number[]>(),
  /** 'pendiente' | 'aplicado' | 'descartado'. */
  estado: varchar('estado', { length: 20 }).notNull().default('pendiente'),
  /** `MotivoPendienteComprobante`. NULL si no está pendiente. */
  motivoPendiente: varchar('motivo_pendiente', { length: 40 }),
  detallePendiente: text('detalle_pendiente'),
  /** `TipoDocumentoComprobante` o NULL si el OCR no lo identificó. */
  tipoDocumento: varchar('tipo_documento', { length: 40 }),
  /** D3. NULL mientras nadie (OCR confiable o persona) lo haya dicho. */
  esPago: boolean('es_pago'),
  /** `ConceptoCosto`. NULL mientras no se conozca. */
  concepto: varchar('concepto', { length: 30 }),
  tramiteId: uuid('tramite_id').references(() => flitoTramites.id, { onDelete: 'cascade' }),
  /**
   * Bug #12913 (0209): el TIPO de servicio adicional que paga este comprobante. Solo en pagos de
   * servicios adicionales (CHECK); obligatorio al aplicarlos (Zod). Con él el valor entra a la puente
   * `flito_tramite_servicios_adicionales` por (trámite, tipo) y el índice único va por tipo.
   */
  servicioTipoId: uuid('servicio_tipo_id').references(() => flitoServiciosAdicionalesTipos.id, { onDelete: 'restrict' }),
  /** 'id_flit' | 'vin' | 'placa' | 'manual'. Cómo se llegó al trámite. */
  cruce: varchar('cruce', { length: 10 }),
  placaLeida: varchar('placa_leida', { length: 10 }),
  vinLeido: varchar('vin_leido', { length: 30 }),
  idFlitLeido: varchar('id_flit_leido', { length: 60 }),
  /** La lectura universal (campos + confianza). `{}` si el OCR no estuvo disponible. NUNCA en listados. */
  extraccion: jsonb('extraccion').$type<ExtraccionComprobante>().notNull(),
  /** La lectura del extractor especializado (forma `ExtraccionSoat`/`ExtraccionImpuesto`/`ExtraccionDerechoTramite`), si la hubo. */
  extraccionDestino: jsonb('extraccion_destino'),
  /** Valor leído/confirmado. COPIA para soat/impuesto/derecho; VERDAD para los tres honorarios. */
  valor: numeric('valor', { precision: 14, scale: 2 }),
  fechaDocumento: date('fecha_documento'),
  numeroDocumento: varchar('numero_documento', { length: 60 }),
  emisor: varchar('emisor', { length: 150 }),
  /** D2: la tarifa (o Σ servicios) vigente al aplicar, congelada para explicar la diferencia. */
  tarifaReferencia: numeric('tarifa_referencia', { precision: 14, scale: 2 }),
  diferenciaTarifa: numeric('diferencia_tarifa', { precision: 14, scale: 2 }),
  marcadoPorDiferencia: boolean('marcado_por_diferencia').notNull().default(false),
  diferenciaAceptadaPorId: integer('diferencia_aceptada_por_id').references(() => users.id, { onDelete: 'restrict' }),
  diferenciaAceptadaEn: timestamp('diferencia_aceptada_en', { withTimezone: true }),
  diferenciaAceptadaMotivo: text('diferencia_aceptada_motivo'),
  aplicadoAutomaticamente: boolean('aplicado_automaticamente').notNull().default(false),
  aplicadoPorId: integer('aplicado_por_id').references(() => users.id, { onDelete: 'restrict' }),
  aplicadoEn: timestamp('aplicado_en', { withTimezone: true }),
  aplicadoMotivo: text('aplicado_motivo'),
  descartadoPorId: integer('descartado_por_id').references(() => users.id, { onDelete: 'restrict' }),
  descartadoEn: timestamp('descartado_en', { withTimezone: true }),
  descartadoMotivo: text('descartado_motivo'),
  subidoPorId: integer('subido_por_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  subidoPorNombre: varchar('subido_por_nombre', { length: 150 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  loteIdx: index('idx_flito_comprobantes_lote').on(t.loteId),
  /** La cola: pendientes por antigüedad. */
  pendientesIdx: index('idx_flito_comprobantes_pendientes').on(t.createdAt)
    .where(sql`${t.estado} = 'pendiente'`),
  tramiteIdx: index('idx_flito_comprobantes_tramite').on(t.tramiteId, t.concepto)
    .where(sql`${t.tramiteId} IS NOT NULL`),
  soporteIdx: index('idx_flito_comprobantes_soporte').on(t.soporteId),
  /**
   * D2: UNA verdad documental viva por (trámite, concepto) en trámite digital y logística. SOAT/
   * impuesto/derecho no entran: su verdad es la columna del destino (puede haber complementos).
   * Bug #12913 (0209): servicios adicionales sale de este índice y va por (trámite, TIPO): un trámite
   * puede tener varios servicios pagados, pero no dos comprobantes aplicados del mismo tipo.
   */
  valorDocumentalUq: uniqueIndex('idx_flito_comprobantes_valor_documental_td_lg').on(t.tramiteId, t.concepto)
    .where(sql`${t.estado} = 'aplicado' AND ${t.esPago} = true
      AND ${t.concepto} IN ('tramite_digital', 'logistica')`),
  valorDocumentalSaUq: uniqueIndex('idx_flito_comprobantes_valor_documental_sa').on(t.tramiteId, t.servicioTipoId)
    .where(sql`${t.estado} = 'aplicado' AND ${t.esPago} = true
      AND ${t.concepto} = 'servicios_adicionales' AND ${t.servicioTipoId} IS NOT NULL`),
  /** Bug #12913: el tipo de servicio solo en un PAGO de servicios adicionales. */
  servicioTipoChk: check('flito_comprobantes_servicio_tipo_chk',
    sql`${t.servicioTipoId} IS NULL OR (${t.concepto} = 'servicios_adicionales' AND ${t.esPago} = true)`),
  estadoChk: check('flito_comprobantes_estado_chk',
    sql`${t.estado} IN ('pendiente', 'aplicado', 'descartado')`),
  conceptoChk: check('flito_comprobantes_concepto_chk',
    sql`${t.concepto} IS NULL OR ${t.concepto} IN ('soat', 'impuesto', 'derecho', 'tramite_digital', 'logistica', 'servicios_adicionales')`),
  cruceChk: check('flito_comprobantes_cruce_chk',
    sql`${t.cruce} IS NULL OR ${t.cruce} IN ('id_flit', 'vin', 'placa', 'manual')`),
  /** Aplicado ⇒ se sabe a qué trámite, de qué concepto, si es pago, y quién/cuándo. */
  aplicadoChk: check('flito_comprobantes_aplicado_chk',
    sql`${t.estado} <> 'aplicado' OR (${t.tramiteId} IS NOT NULL AND ${t.concepto} IS NOT NULL
      AND ${t.esPago} IS NOT NULL AND ${t.aplicadoEn} IS NOT NULL
      AND (${t.aplicadoAutomaticamente} OR ${t.aplicadoPorId} IS NOT NULL))`),
  /** Pago aplicado ⇒ hay valor. Documentación (es_pago = false) no lo exige. */
  valorPagoChk: check('flito_comprobantes_valor_pago_chk',
    sql`NOT (${t.estado} = 'aplicado' AND ${t.esPago} = true) OR ${t.valor} IS NOT NULL`),
  descartadoChk: check('flito_comprobantes_descartado_chk',
    sql`${t.estado} <> 'descartado' OR (${t.descartadoPorId} IS NOT NULL AND ${t.descartadoEn} IS NOT NULL AND ${t.descartadoMotivo} IS NOT NULL)`),
  pendienteChk: check('flito_comprobantes_pendiente_chk',
    sql`${t.estado} <> 'pendiente' OR ${t.motivoPendiente} IS NOT NULL`),
  /** Las tres columnas de la aceptación van juntas (ADR-0005: pareja quién + cuándo). */
  diferenciaChk: check('flito_comprobantes_diferencia_chk',
    sql`(${t.diferenciaAceptadaPorId} IS NULL) = (${t.diferenciaAceptadaEn} IS NULL)
      AND (${t.diferenciaAceptadaPorId} IS NULL) = (${t.diferenciaAceptadaMotivo} IS NULL)`),
  paginasChk: check('flito_comprobantes_paginas_chk',
    sql`${t.paginas} IS NULL OR jsonb_typeof(${t.paginas}) = 'array'`),
}));
