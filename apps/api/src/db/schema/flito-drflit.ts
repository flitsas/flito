// HU #13803 (Feature #13695) — Dr. Flit: autorizaciones de tratamiento de datos (Ley 1581). Migración 0245.
// HU #13804 — intentos de radicación en FLIT - SOPORTE. Migración 0246.
// Vive aparte de `schema.ts` por el techo de max-lines (3400), como `schema/flito-comprobantes.ts`. A
// diferencia de esa, `schema.ts` NO la re-exporta (está justo en el techo): se importa de aquí directo. Diseño: docs/diseno/feature-13695-dr-flit-soporte.md (modelo de datos).
//
// SOLO INSERCIÓN: la migración 0245 instala triggers que impiden UPDATE, DELETE y TRUNCATE (mismo
// mecanismo que `pii_access_log`, 0059). CHECKs declarados aquí y en la migración (lección 0157).
// `ON DELETE RESTRICT` hacia `users`: las cuentas se desactivan, nunca se borran.
import {
  pgTable, serial, integer, varchar, char, timestamp, uniqueIndex, index, check, uuid, smallint,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from '../schema.js';

export const flitoDrflitAutorizaciones = pgTable('flito_drflit_autorizaciones', {
  id: serial('id').primaryKey(),
  usuarioId: integer('usuario_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  finalidad: varchar('finalidad', { length: 20 }).notNull(),
  version: varchar('version', { length: 40 }).notNull(),
  /** SHA-256 (hex) del texto exacto aceptado: prueba de qué se autorizó. */
  textoSha256: char('texto_sha256', { length: 64 }).notNull(),
  aceptadaEn: timestamp('aceptada_en', { withTimezone: true }).notNull().defaultNow(),
  ip: varchar('ip', { length: 45 }),
  userAgent: varchar('user_agent', { length: 300 }),
}, (t) => ({
  uqUsuarioFinalidadVersion: uniqueIndex('uq_flito_drflit_aut_usuario_finalidad_version')
    .on(t.usuarioId, t.finalidad, t.version),
  ckFinalidad: check('ck_flito_drflit_aut_finalidad', sql`${t.finalidad} IN ('soporte','ia')`),
  ckSha: check('ck_flito_drflit_aut_sha', sql`${t.textoSha256} ~ '^[0-9a-f]{64}$'`),
}));

// HU #13804 — 0246. Metadatos del intento de radicación en FLIT - SOPORTE. SIN texto del caso (D6).
// Purga a 12 meses (`dr-flit.cron.ts`, RN-DRF1). CHECKs declarados aquí y en la migración.
export const ESTADOS_INTENTO_DRFLIT = ['pendiente', 'creado', 'fallido'] as const;
export type EstadoIntentoDrFlit = (typeof ESTADOS_INTENTO_DRFLIT)[number];

export const flitoDrflitCasosSoporte = pgTable('flito_drflit_casos_soporte', {
  /** `resourceId` de `logPiiAccess` y `Ref. FLITO: DRF-<id>` del ReproSteps (estable entre reintentos). */
  id: serial('id').primaryKey(),
  usuarioId: integer('usuario_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  autorizacionId: integer('autorizacion_id').notNull()
    .references(() => flitoDrflitAutorizaciones.id, { onDelete: 'restrict' }),
  claveIdempotencia: uuid('clave_idempotencia').notNull(),
  estado: varchar('estado', { length: 12 }).$type<EstadoIntentoDrFlit>().notNull().default('pendiente'),
  numeroAdo: integer('numero_ado'),
  ambiente: varchar('ambiente', { length: 3 }).notNull(),
  adjuntosCantidad: smallint('adjuntos_cantidad').notNull().default(0),
  reintentos: smallint('reintentos').notNull().default(0),
  /** Clasificación, nunca un mensaje: timeout|red|ado-4xx|ado-5xx|ado-429|ado-auth|tag-rechazado|interno. */
  errorCodigo: varchar('error_codigo', { length: 40 }),
  creadoEn: timestamp('creado_en', { withTimezone: true }).notNull().defaultNow(),
  actualizadoEn: timestamp('actualizado_en', { withTimezone: true }).notNull().defaultNow(),
  radicadoEn: timestamp('radicado_en', { withTimezone: true }),
}, (t) => ({
  uqUsuarioClave: uniqueIndex('uq_flito_drflit_casos_usuario_clave').on(t.usuarioId, t.claveIdempotencia),
  ixCreadoEn: index('ix_flito_drflit_casos_creado_en').on(t.creadoEn),
  ixAutorizacion: index('ix_flito_drflit_casos_autorizacion').on(t.autorizacionId),
  ckEstado: check('ck_flito_drflit_casos_estado', sql`${t.estado} IN ('pendiente','creado','fallido')`),
  ckNumero: check('ck_flito_drflit_casos_numero', sql`${t.estado} <> 'creado' OR ${t.numeroAdo} IS NOT NULL`),
  ckAmbiente: check('ck_flito_drflit_casos_ambiente', sql`${t.ambiente} IN ('DEV','QA','PDN')`),
  ckAdjuntos: check('ck_flito_drflit_casos_adjuntos', sql`${t.adjuntosCantidad} BETWEEN 0 AND 10`),
}));
