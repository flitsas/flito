// Feature #13886 / HU #13899 (ADR-0029) — modelo ÚNICO de bolsa: alcance COMPAÑÍA (1:1) o TRÁNSITO
// (N secretarías). Vive aparte de `schema.ts` por el techo de max-lines (3400), como `schema/permisos.ts`;
// `schema.ts` lo re-exporta con un `export *`.
//
// Sucede a `flito_bolsas` / `flito_bolsa_movimientos` / `flito_bolsa_cierres` (cliente, migrado en la
// 0250 con los UUID PRESERVADOS) y, en la HU-F, a los tres libros de tránsito. Los libros viejos quedan
// intactos y sin lectores hasta la migración de retiro (HU-I): es el rollback sin migración inversa.
//
// CHECKs e índices declarados AQUÍ y en la 0249 (lección 0157): un CHECK que solo vive en la base
// convence a quien lee el esquema de que no hace falta migración, y el primer INSERT muere con 23514.
//
// Import circular a propósito (mismo patrón que `schema/flito-comprobantes.ts`): las FK de Drizzle son
// callbacks perezosos, así que el ciclo ESM resuelve sin problema.
import {
  pgTable, uuid, varchar, text, boolean, numeric, date, jsonb, integer, timestamp, index, uniqueIndex, check, primaryKey, smallint,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { clients, flitoSoportes, flitoTramites, organismosTransitoConfig, users } from '../schema.js';
import { flitoComprobantes } from './flito-comprobantes.js';

/**
 * Bolsa prepago. `saldo` denormalizado y consistente por el `FOR UPDATE` de esta fila mientras se
 * escribe el movimiento (igual que la bolsa vieja). Puede quedar NEGATIVO: lo que hace es alertar.
 * Nunca se borra (D4): se inactiva y se reactiva. Inactiva no recibe dinero nuevo (Q7).
 */
export const flitoBolsasUnicas = pgTable('flito_bolsas_unicas', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** 'compania' | 'transito'. Inmutable. */
  alcance: varchar('alcance', { length: 12 }).notNull(),
  /** Tránsito: obligatorio. Compañía: NULL (se muestra el nombre del cliente). */
  nombre: varchar('nombre', { length: 120 }),
  // RESTRICT: es un libro contable; borrar un cliente no puede llevarse su saldo ni su histórico.
  companiaId: integer('compania_id').references(() => clients.id, { onDelete: 'restrict' }),
  activa: boolean('activa').notNull().default(true),
  saldo: numeric('saldo', { precision: 14, scale: 2 }).notNull().default('0'),
  /** Base del nivel de riesgo: la última recarga (cliente) o carga (tránsito). NULL = sin recargas. */
  ultimaEntradaValor: numeric('ultima_entrada_valor', { precision: 14, scale: 2 }),
  ultimaEntradaEn: timestamp('ultima_entrada_en', { withTimezone: true }),
  inactivadaEn: timestamp('inactivada_en', { withTimezone: true }),
  inactivadaPorId: integer('inactivada_por_id').references(() => users.id, { onDelete: 'set null' }),
  inactivadaPorNombre: varchar('inactivada_por_nombre', { length: 150 }),
  motivoInactivacion: text('motivo_inactivacion'),
  creadaPorId: integer('creada_por_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  alcanceChk: check('flito_bolsas_unicas_alcance_chk', sql`${t.alcance} IN ('compania','transito')`),
  formaChk: check('flito_bolsas_unicas_forma_chk', sql`
    (${t.alcance} = 'compania' AND ${t.companiaId} IS NOT NULL)
    OR (${t.alcance} = 'transito' AND ${t.companiaId} IS NULL AND ${t.nombre} IS NOT NULL)`),
  inactivaChk: check('flito_bolsas_unicas_inactiva_chk', sql`${t.activa} OR ${t.inactivadaEn} IS NOT NULL`),
  // Hereda flito_bolsas_ultima_recarga_coherente (0116): valor y fecha de la última entrada van juntos.
  ultimaEntradaChk: check('flito_bolsas_unicas_ultima_entrada_chk',
    sql`(${t.ultimaEntradaValor} IS NULL) = (${t.ultimaEntradaEn} IS NULL)`),
  // D1/D3: 1:1 compañía-bolsa, INCLUIDA la inactiva (se reactiva, no se crea otra). Parcial: la tabla
  // NO tiene unique(compania_id) — #13407 no debe asumirlo (contrato (d)).
  companiaUq: uniqueIndex('uq_flito_bolsas_unicas_compania').on(t.companiaId).where(sql`${t.alcance} = 'compania'`),
  nombreUq: uniqueIndex('uq_flito_bolsas_unicas_nombre_transito').on(t.nombre).where(sql`${t.alcance} = 'transito'`),
}));

/** Conceptos que descuenta una bolsa de COMPAÑÍA. (Tránsito los expresa en la cobertura.) */
export const flitoBolsasUnicasConceptos = pgTable('flito_bolsas_unicas_conceptos', {
  bolsaId: uuid('bolsa_id').notNull().references(() => flitoBolsasUnicas.id, { onDelete: 'restrict' }),
  concepto: varchar('concepto', { length: 30 }).notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.bolsaId, t.concepto] }),
  conceptoChk: check('flito_bolsas_unicas_conceptos_chk', sql`${t.concepto} IN
    ('soat','impuesto','derecho','tramite_digital','logistica','servicios_adicionales')`),
}));

/** Pares (secretaría, concepto) de una bolsa de TRÁNSITO. `activa` es copia de la bolsa: el índice la necesita. */
export const flitoBolsasUnicasCobertura = pgTable('flito_bolsas_unicas_cobertura', {
  bolsaId: uuid('bolsa_id').notNull().references(() => flitoBolsasUnicas.id, { onDelete: 'restrict' }),
  organismoCodigo: varchar('organismo_codigo', { length: 5 }).notNull()
    .references(() => organismosTransitoConfig.codigo, { onDelete: 'restrict' }),
  concepto: varchar('concepto', { length: 20 }).notNull(),
  activa: boolean('activa').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.bolsaId, t.organismoCodigo, t.concepto] }),
  conceptoChk: check('flito_bolsas_unicas_cobertura_concepto_chk', sql`${t.concepto} IN ('derecho','soat','impuesto')`),
  // D3: sucesor de uq_bolsa_transito_cobertura, ahora SOLO entre activas.
  parActivoUq: uniqueIndex('uq_flito_bolsas_unicas_cobertura_activa').on(t.organismoCodigo, t.concepto).where(sql`${t.activa}`),
  bolsaIdx: index('idx_flito_bolsas_unicas_cobertura_bolsa').on(t.bolsaId),
}));

/**
 * Libro único, append-only. Valor siempre positivo; la dirección la da `tipo`. Sin `compania_id`: la
 * compañía la da la bolsa. Se reescriben DOS columnas, ninguna de dinero: la llave (prefijo `rev:` al
 * reversar una liquidación) y el `origen` (`automatico` → `conciliacion` cuando `adoptar()` de la
 * conciliación adopta una salida del sellado, ADR-0006 §2.4-ii).
 */
export const flitoBolsasUnicasMovimientos = pgTable('flito_bolsas_unicas_movimientos', {
  id: uuid('id').primaryKey().defaultRandom(),
  bolsaId: uuid('bolsa_id').notNull().references(() => flitoBolsasUnicas.id, { onDelete: 'restrict' }),
  /** 'entrada' | 'salida'. */
  tipo: varchar('tipo', { length: 10 }).notNull(),
  /** 'recarga' | 'automatico' | 'manual' | 'conciliacion' | 'comprobante'. */
  origen: varchar('origen', { length: 20 }).notNull(),
  concepto: varchar('concepto', { length: 30 }),
  organismoCodigo: varchar('organismo_codigo', { length: 5 }).references(() => organismosTransitoConfig.codigo, { onDelete: 'restrict' }),
  tramiteId: uuid('tramite_id').references(() => flitoTramites.id, { onDelete: 'set null' }),
  comprobanteId: uuid('comprobante_id').references(() => flitoComprobantes.id, { onDelete: 'restrict' }),
  valor: numeric('valor', { precision: 14, scale: 2 }).notNull(),
  saldoResultante: numeric('saldo_resultante', { precision: 14, scale: 2 }).notNull(),
  /** Periodo contable 'YYYY-MM' al que se IMPUTA (puede correrse si el natural está cerrado). */
  periodo: varchar('periodo', { length: 7 }).notNull(),
  fecha: date('fecha').notNull(),
  observacion: text('observacion'),
  soporteId: uuid('soporte_id').references(() => flitoSoportes.id, { onDelete: 'restrict' }),
  registradoPorId: integer('registrado_por_id').references(() => users.id, { onDelete: 'set null' }),
  registradoPorNombre: varchar('registrado_por_nombre', { length: 150 }).notNull(),
  /** Anti doble cobro (ADR-0006: `salida:soat:<soatId>` compartida por sellado, conciliación y comprobante). */
  llaveIdempotencia: varchar('llave_idempotencia', { length: 200 }),
  // FK auto-referenciales (corrige/revierte → id) declaradas en la 0249: Drizzle no las tipa bien.
  corrigeMovimientoId: uuid('corrige_movimiento_id'),
  revierteMovimientoId: uuid('revierte_movimiento_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tipoChk: check('flito_bolsas_unicas_mov_tipo_chk', sql`${t.tipo} IN ('entrada','salida')`),
  valorChk: check('flito_bolsas_unicas_mov_valor_chk', sql`${t.valor} > 0`),
  // Heredados de 0116/0118: el bloqueo de mes cerrado compara el periodo como cadena, así que uno mal
  // formado se lo saltaría; y un movimiento no puede corregirse ni revertirse a sí mismo.
  periodoChk: check('flito_bolsas_unicas_mov_periodo_chk', sql`${t.periodo} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
  origenChk: check('flito_bolsas_unicas_mov_origen_chk',
    sql`${t.origen} IN ('recarga','automatico','manual','conciliacion','comprobante')`),
  corrigeChk: check('flito_bolsas_unicas_mov_corrige_chk',
    sql`${t.corrigeMovimientoId} IS NULL OR ${t.corrigeMovimientoId} <> ${t.id}`),
  revierteChk: check('flito_bolsas_unicas_mov_revierte_chk',
    sql`${t.revierteMovimientoId} IS NULL OR ${t.revierteMovimientoId} <> ${t.id}`),
  bolsaIdx: index('idx_flito_bolsas_unicas_mov_bolsa').on(t.bolsaId, t.createdAt),
  periodoIdx: index('idx_flito_bolsas_unicas_mov_periodo').on(t.bolsaId, t.periodo),
  organismoIdx: index('idx_flito_bolsas_unicas_mov_organismo').on(t.organismoCodigo, t.concepto).where(sql`${t.organismoCodigo} IS NOT NULL`),
  tramiteIdx: index('idx_flito_bolsas_unicas_mov_tramite').on(t.tramiteId).where(sql`${t.tramiteId} IS NOT NULL`),
  comprobanteIdx: index('idx_flito_bolsas_unicas_mov_comprobante').on(t.comprobanteId).where(sql`${t.comprobanteId} IS NOT NULL`),
  // Única protección anti doble cobro: se declara aquí para que ningún generador la borre.
  llaveUq: uniqueIndex('uq_flito_bolsas_unicas_mov_llave').on(t.llaveIdempotencia).where(sql`${t.llaveIdempotencia} IS NOT NULL`),
  corrigeIdx: index('idx_flito_bolsas_unicas_mov_corrige').on(t.corrigeMovimientoId).where(sql`${t.corrigeMovimientoId} IS NOT NULL`),
  // D13: una sola reversión por movimiento original, en la base y no en un if.
  revierteUq: uniqueIndex('uq_flito_bolsas_unicas_mov_revierte').on(t.revierteMovimientoId).where(sql`${t.revierteMovimientoId} IS NOT NULL`),
}));

/** Cierre mensual POR BOLSA (cualquier alcance). Sucesor de flito_bolsa_cierres. Totales copiados, no recalculados. */
export const flitoBolsasUnicasCierres = pgTable('flito_bolsas_unicas_cierres', {
  id: uuid('id').primaryKey().defaultRandom(),
  bolsaId: uuid('bolsa_id').notNull().references(() => flitoBolsasUnicas.id, { onDelete: 'restrict' }),
  periodo: varchar('periodo', { length: 7 }).notNull(),
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
  // Dos cierres simultáneos no pueden producir dos reportes distintos del mismo mes.
  periodoUq: uniqueIndex('uq_flito_bolsas_unicas_cierre_periodo').on(t.bolsaId, t.periodo),
  // Heredados de 0117.
  periodoChk: check('flito_bolsas_unicas_cierre_periodo_chk', sql`${t.periodo} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
  totalesChk: check('flito_bolsas_unicas_cierre_totales_chk', sql`${t.totalEntradas} >= 0 AND ${t.totalSalidas} >= 0`),
  movimientosChk: check('flito_bolsas_unicas_cierre_movimientos_chk', sql`${t.movimientos} >= 0`),
}));

/** Bitácora append-only de la configuración: crear, editar, inactivar, reactivar, migrar (quién, cuándo, qué). */
export const flitoBolsasUnicasEventos = pgTable('flito_bolsas_unicas_eventos', {
  id: uuid('id').primaryKey().defaultRandom(),
  bolsaId: uuid('bolsa_id').notNull().references(() => flitoBolsasUnicas.id, { onDelete: 'restrict' }),
  /** crear | editar | inactivar | reactivar | migrar */
  accion: varchar('accion', { length: 20 }).notNull(),
  motivo: text('motivo'),
  /** conceptos/cobertura/nombre; SIN PII de personas. */
  snapshot: jsonb('snapshot').notNull(),
  usuarioId: integer('usuario_id').references(() => users.id, { onDelete: 'set null' }),
  usuarioNombre: varchar('usuario_nombre', { length: 150 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ bolsaIdx: index('idx_flito_bolsas_unicas_eventos_bolsa').on(t.bolsaId, t.createdAt) }));

/**
 * HU #13965 (reemplaza ADR-0029 D12): el corte del descuento por comprobante, migración 0260. Una sola fila
 * (`id = 1`) con el INSTANTE en que se aplicó la migración. No se edita; sin fila, nada descuenta.
 */
export const flitoBolsasCorte = pgTable('flito_bolsas_corte', {
  id: smallint('id').primaryKey().default(1),
  corteEn: timestamp('corte_en', { withTimezone: true }).notNull(),
  registradoEn: timestamp('registrado_en', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  filaUnica: check('ck_flito_bolsas_corte_fila_unica', sql`${t.id} = 1`),
}));
