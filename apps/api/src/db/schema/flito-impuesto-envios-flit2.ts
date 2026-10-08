// HU #13268 (Feature #13267, ADR-0020) — outbox del envío del comprobante de pago a FLIT 2, migración
// 0219. Vive aparte de `schema.ts` por el techo de max-lines (3400), como `schema/flito-soat-incompletas.ts`.
// `schema.ts` la re-exporta.
//
// Import circular a propósito (mismo patrón que `schema/permisos.ts`): las FK de Drizzle son callbacks
// perezosos, así que el ciclo ESM resuelve sin problema.
import {
  pgTable, uuid, varchar, boolean, timestamp, integer, bigint, smallint, index, uniqueIndex, check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { DestinoEnvioComprobante, EstadoEnvioFlit2 } from '@operaciones/shared-types';
import { flitoImpuestos } from '../schema.js';

/**
 * HU #13268 (migración 0219, ADR-0020): outbox del envío del comprobante de pago. Pese al nombre, desde la
 * 0221 (HU #13310, ADR-0021) sirve a FLIT 2 y a FLIT 1 según `destino`. Una fila por impuesto. La programa el pago dentro de su transacción; la vacía `flito-impuestos-envio-flit2.cron`.
 */
export const flitoImpuestoEnviosFlit2 = pgTable('flito_impuesto_envios_flit2', {
  id: uuid('id').primaryKey().defaultRandom(),
  impuestoId: uuid('impuesto_id').notNull().references(() => flitoImpuestos.id, { onDelete: 'cascade' }),
  estado: varchar('estado', { length: 20 }).$type<EstadoEnvioFlit2>().notNull(),
  /** Soporte elegido para enviar (AC2). null solo en `sin_comprobante`. Sin FK dura (se re-resuelve al enviar). */
  soporteId: uuid('soporte_id'),
  intentos: smallint('intentos').notNull().default(0),
  proximoIntentoEn: timestamp('proximo_intento_en', { withTimezone: true }),
  ultimoIntentoEn: timestamp('ultimo_intento_en', { withTimezone: true }),
  /** Código del último desenlace (`code` de FLIT 2 o propio: `red`, `sha256_distinto`, `espera_vencida`…). Sin PII. */
  ultimoResultado: varchar('ultimo_resultado', { length: 40 }),
  ultimoStatus: smallint('ultimo_status'),
  /** Estado del trámite en FLIT 2 informado en 409 not_allowed_in_state (terminal o no). */
  estadoFlit2: varchar('estado_flit2', { length: 30 }),
  /** `flito_tramites.sync_version` al estacionar (409 terminal:false). La toma despierta la fila cuando el feed la supera. */
  syncVersionEspera: bigint('sync_version_espera', { mode: 'number' }),
  /** Primera entrada a `en_espera` (no se mueve al re-estacionar). A los 30 días → `error`. */
  enEsperaDesde: timestamp('en_espera_desde', { withTimezone: true }),
  adjuntoId: uuid('adjunto_id'),
  sha256: varchar('sha256', { length: 64 }),
  /** Soporte que realmente salió (≠ soporteId tras un reemplazo aún sin enviar). */
  soporteEnviadoId: uuid('soporte_enviado_id'),
  reemplazoDe: uuid('reemplazo_de'),
  enMatriz: boolean('en_matriz'),
  /** Solo se guarda; FLITO no ramifica con él (D-5). */
  pagadoMarcado: boolean('pagado_marcado'),
  enviadoEn: timestamp('enviado_en', { withTimezone: true }),
  /** Generación: la #13269 la sube; el worker solo escribe si no cambió desde que tomó la fila. */
  version: integer('version').notNull().default(1),
  tomadoPor: varchar('tomado_por', { length: 100 }),
  tomadoEn: timestamp('tomado_en', { withTimezone: true }),
  /** HU #13310 (0221, ADR-0021): a quién va el envío. Se fija al crear la fila y no cambia. */
  /**
   * Sin `.default()` a propósito: TS obliga a pasar `destino` en todo insert nuevo. La BD conserva un DEFAULT
   * 'flit2' TRANSITORIO (0221) por compatibilidad en caliente con el binario anterior; se retira en una
   * migración posterior cuando el binario de la #13310 esté en todos los ambientes.
   */
  destino: varchar('destino', { length: 10 }).$type<DestinoEnvioComprobante>().notNull(),
  /** FLIT 1: id del archivo (paso 1), persistido SOLO tras subirlo bien (paso 2): el reintento hace solo el PUT. */
  archivoFlit1Id: varchar('archivo_flit1_id', { length: 100 }),
  /** FLIT 1: paso (1-3) del último desenlace; null en pre-validación local. */
  ultimoPaso: smallint('ultimo_paso'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  impuestoUq: uniqueIndex('uq_flito_impuesto_envios_flit2_impuesto').on(t.impuestoId),
  colaIdx: index('idx_flito_impuesto_envios_flit2_cola').on(t.estado, t.proximoIntentoEn)
    .where(sql`${t.estado} IN ('pendiente','en_espera')`),
  estadoCk: check('ck_flito_impuesto_envios_flit2_estado',
    sql`${t.estado} IN ('pendiente','en_espera','enviado','ya_cargado_gestor','error','sin_comprobante')`),
  soporteCk: check('ck_flito_impuesto_envios_flit2_soporte',
    sql`(${t.estado} = 'sin_comprobante') = (${t.soporteId} IS NULL)`),
  esperaCk: check('ck_flito_impuesto_envios_flit2_espera',
    sql`(${t.estado} = 'en_espera') = (${t.syncVersionEspera} IS NOT NULL AND ${t.enEsperaDesde} IS NOT NULL)`),
  intentosCk: check('ck_flito_impuesto_envios_flit2_intentos', sql`${t.intentos} BETWEEN 0 AND 10`),
  // 0221 (HU #13310): destino y semántica por destino.
  destinoCk: check('ck_flito_impuesto_envios_flit2_destino', sql`${t.destino} IN ('flit1','flit2')`),
  flit1EstadoCk: check('ck_flito_impuesto_envios_flit2_flit1_estado',
    sql`${t.destino} = 'flit2' OR (${t.estado} IN ('pendiente','enviado','error','sin_comprobante')
      AND ${t.syncVersionEspera} IS NULL AND ${t.enEsperaDesde} IS NULL AND ${t.estadoFlit2} IS NULL AND ${t.adjuntoId} IS NULL)`),
  flit1ColsCk: check('ck_flito_impuesto_envios_flit2_flit1_cols',
    sql`${t.destino} = 'flit1' OR (${t.archivoFlit1Id} IS NULL AND ${t.ultimoPaso} IS NULL)`),
  ultimoPasoCk: check('ck_flito_impuesto_envios_flit2_ultimo_paso', sql`${t.ultimoPaso} IS NULL OR ${t.ultimoPaso} BETWEEN 1 AND 3`),
}));
