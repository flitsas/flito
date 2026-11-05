// Finanzas: liquidación legacy y FLITO, tarifas, servicios adicionales, pagos a organismos y conciliación. Se re-exporta desde `../schema.ts` (HU #13983).
import {
  pgTable, varchar, text, boolean, timestamp, integer, bigint, date, index, uniqueIndex, jsonb, numeric,
  bigserial, uuid, check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users, clients, workOrders } from '../schema.js';
import { flitoBolsasUnicasMovimientos } from './flito-bolsas-unicas.js';
import { flitoSoat, flitoSoportes } from './soat.js';
import { tramitesDigitales, organismosTransitoConfig, flitoTramites } from './tramites.js';

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

/**
 * Vigencias de tarifa por compañía (HU #12373). Sustituye a `flito_tarifas_compania` (0110): cada
 * (compañía × concepto × tipo) es una SECUENCIA de vigencias `[vigente_desde, vigente_hasta)`; la
 * abierta (`vigente_hasta IS NULL`) es la que se cobra. Cambiar un valor = cerrar la abierta y abrir
 * otra en la misma transacción; dejar de cobrar = cerrar sin abrir. NUNCA se borra ni se sobreescribe.
 *
 * Tipos cerrados: `tramite_digital` exige tipo ∈ TIPOS_TRAMITE_TARIFA ('MATRICULA'|'TRASPASO'|'OTROS',
 * shared-types/flito-tarifas.ts); `logistica` va SIEMPRE con tipo NULL (un valor por compañía).
 * Lo imponen los CHECK de abajo. Lo que Drizzle no declara y vive solo en la 0182: la EXCLUDE con
 * btree_gist (sin solapes entre vigencias de una misma llave).
 */
export const flitoTarifasVigencias = pgTable('flito_tarifas_vigencias', {
  id: uuid('id').primaryKey().defaultRandom(),
  // RESTRICT, como el resto de las tablas financieras de FLITO (bolsas, movimientos, boletas): el
  // historial de lo que se cobró no desaparece con la compañía. Hoy es inerte (el borrado de clientes
  // es lógico), pero un CASCADE heredado de la 0110 contradecía el «nunca se borra» de arriba.
  companiaId: integer('compania_id').notNull().references(() => clients.id, { onDelete: 'restrict' }),
  concepto: varchar('concepto', { length: 30 }).notNull(),
  tipoTramite: varchar('tipo_tramite', { length: 20 }),
  valor: numeric('valor', { precision: 14, scale: 2 }).notNull(),
  vigenteDesde: timestamp('vigente_desde', { withTimezone: true }).notNull().defaultNow(),
  vigenteHasta: timestamp('vigente_hasta', { withTimezone: true }),
  fijadoPorId: integer('fijado_por_id').references(() => users.id),
  fijadoEn: timestamp('fijado_en', { withTimezone: true }).notNull().defaultNow(),
  cerradoPorId: integer('cerrado_por_id').references(() => users.id),
  cerradoEn: timestamp('cerrado_en', { withTimezone: true }),
}, (t) => ({
  companiaConceptoIdx: index('idx_flito_tarifas_vigencias_compania_concepto').on(t.companiaId, t.concepto),
  // Una sola abierta por llave. El COALESCE es imprescindible: NULL no colisiona con NULL.
  abiertaUq: uniqueIndex('idx_flito_tarifas_vigencias_abierta')
    .on(t.companiaId, t.concepto, sql`COALESCE(${t.tipoTramite}, '')`).where(sql`${t.vigenteHasta} IS NULL`),
  conceptoChk: check('flito_tarifas_vigencias_concepto_chk', sql`${t.concepto} IN ('tramite_digital', 'logistica', 'logistica_cliente', 'logistica_flit')`),
  tipoChk: check('flito_tarifas_vigencias_tipo_chk', sql`(${t.concepto} = 'tramite_digital' AND ${t.tipoTramite} IS NOT NULL AND ${t.tipoTramite} IN ('MATRICULA', 'TRASPASO', 'OTROS')) OR (${t.concepto} IN ('logistica', 'logistica_cliente', 'logistica_flit') AND ${t.tipoTramite} IS NULL)`),
  valorChk: check('flito_tarifas_vigencias_valor_chk', sql`${t.valor} >= 0`),
  // >= y no >: una tarifa creada inactiva y nunca activada migra como rango vacío [t, t).
  rangoChk: check('flito_tarifas_vigencias_rango_chk', sql`${t.vigenteHasta} IS NULL OR ${t.vigenteHasta} >= ${t.vigenteDesde}`),
  cierreChk: check('flito_tarifas_vigencias_cierre_chk', sql`(${t.vigenteHasta} IS NULL) = (${t.cerradoEn} IS NULL)`),
}));

/**
 * Catálogo de tipos de servicio adicional (HU #12541, Feature #12540). Baja LÓGICA: un tipo se da de
 * baja (`activo=false` + `dadoDeBajaEn` + actor) y nunca se borra ni se reactiva; el índice único
 * parcial sobre el nombre PLEGADO (minúsculas, sin tilde, `translate()` y no `unaccent()`) solo cuenta
 * los activos, así que dar de baja libera el nombre. La misma expresión vive en `nombrePlegado()` del
 * servicio y en la 0191. FKs a users RESTRICT (ADR-0005: FK en pareja con marca de tiempo).
 */
export const flitoServiciosAdicionalesTipos = pgTable('flito_servicios_adicionales_tipos', {
  id: uuid('id').primaryKey().defaultRandom(),
  nombre: varchar('nombre', { length: 120 }).notNull(),
  descripcion: text('descripcion'),
  valor: numeric('valor', { precision: 14, scale: 2 }).notNull(),
  activo: boolean('activo').notNull().default(true),
  dadoDeBajaEn: timestamp('dado_de_baja_en', { withTimezone: true }),
  dadoDeBajaPorId: integer('dado_de_baja_por_id').references(() => users.id, { onDelete: 'restrict' }),
  creadoPorId: integer('creado_por_id').references(() => users.id, { onDelete: 'restrict' }),
  creadoEn: timestamp('creado_en', { withTimezone: true }).notNull().defaultNow(),
  actualizadoPorId: integer('actualizado_por_id').references(() => users.id, { onDelete: 'restrict' }),
  actualizadoEn: timestamp('actualizado_en', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  nombreActivoUq: uniqueIndex('idx_flito_serv_adic_tipos_nombre_activo')
    .on(sql`lower(translate(${t.nombre}, 'áéíóúÁÉÍÓÚñÑüÜ', 'aeiouAEIOUnNuU'))`).where(sql`${t.activo}`),
  valorChk: check('flito_serv_adic_tipos_valor_chk', sql`${t.valor} >= 0`),
  nombreChk: check('flito_serv_adic_tipos_nombre_chk', sql`btrim(${t.nombre}) <> ''`),
  bajaChk: check('flito_serv_adic_tipos_baja_chk', sql`${t.activo} = (${t.dadoDeBajaEn} IS NULL)`),
}));

/**
 * Servicios adicionales ASIGNADOS a un trámite (HU #12545, Feature #12544). Fila VIVA: se crea al
 * asignar y se borra físicamente al quitar (CF-04); mientras el trámite no está liquidado nadie la
 * referencia, y al sellar la liquidación copia nombre/valor a su propio `detalle`. `nombre`,
 * `descripcion` y `valor` son el SNAPSHOT del tipo en el instante de asignar: editar o dar de baja el
 * tipo después no los cambia (CF-03). FK al tipo RESTRICT (el catálogo no borra: baja lógica) y a
 * users RESTRICT por ADR-0005 (`asignado_por_id` va en pareja con `asignado_en`). El UNIQUE
 * (tramite_id, tipo_id) es una CONSTRAINT en la 0193 (`flito_tramite_serv_adic_tramite_tipo_uq`):
 * su 23505 es lo que el servicio traduce a 409 SERVICIO_YA_ASIGNADO.
 */
export const flitoTramiteServiciosAdicionales = pgTable('flito_tramite_servicios_adicionales', {
  id: uuid('id').primaryKey().defaultRandom(),
  tramiteId: uuid('tramite_id').notNull().references(() => flitoTramites.id, { onDelete: 'cascade' }),
  tipoId: uuid('tipo_id').notNull().references(() => flitoServiciosAdicionalesTipos.id, { onDelete: 'restrict' }),
  nombre: varchar('nombre', { length: 120 }).notNull(),
  descripcion: text('descripcion'),
  valor: numeric('valor', { precision: 14, scale: 2 }).notNull(),
  asignadoPorId: integer('asignado_por_id').references(() => users.id, { onDelete: 'restrict' }),
  asignadoEn: timestamp('asignado_en', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tramiteTipoUq: uniqueIndex('flito_tramite_serv_adic_tramite_tipo_uq').on(t.tramiteId, t.tipoId),
  tramiteIdx: index('idx_flito_tramite_serv_adic_tramite').on(t.tramiteId),
  valorChk: check('flito_tramite_serv_adic_valor_chk', sql`${t.valor} >= 0`),
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
  /**
   * Suma de los servicios adicionales sellados (HU #12546, 0194). NULL = «no aplica»: el trámite se
   * selló sin servicios, o se selló ANTES de esta HU. Nunca cero implícito. El desglose por tipo va
   * en `detalle.serviciosAdicionales.items`.
   */
  valorServiciosAdicionales: numeric('valor_servicios_adicionales', { precision: 14, scale: 2 }),
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

// ── FLITO Pagos a organismos (HU #11124) ─────────────────────────────────────
// HU #13911: los libros viejos de bolsas (flito_bolsas*, flito_bolsa_*) salieron a `archivo_bolsas`
// (migración 0266); el modelo único vive en `./schema/flito-bolsas-unicas.ts`.

/**
 * Pago de FLIT a un Organismo de Tránsito (HU #11124, Feature #11120 §4.1).
 *
 * La «bolsa simbólica» del organismo no tiene saldo propio: es una vista agregada sobre
 * el libro único (`flito_bolsas_unicas_movimientos`) que dice cuánto se le cobró al cliente por cuenta de ese organismo. Esta
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
  movimientoBolsaId: uuid('movimiento_bolsa_id').references(() => flitoBolsasUnicasMovimientos.id, { onDelete: 'restrict' }), // HU #13899
  movimientoTransitoId: uuid('movimiento_transito_id').references(() => flitoBolsasUnicasMovimientos.id, { onDelete: 'restrict' }), // HU #13906
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
