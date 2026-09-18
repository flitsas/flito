// HU #12619 (Feature #12617, Épica #12244) — Viajes adicionales de logística por trámite. Vive aparte
// de `schema.ts` por el techo de max-lines (3400), como `schema/flito-comprobantes.ts`; `schema.ts`
// la re-exporta.
//
// Una fila por viaje ADICIONAL (el 1 va incluido en la tarifa de logística, así que `numero >= 2`).
// `valor` es lo que se cobra; `tarifa_vigente` es la tarifa de logística de la compañía en el instante
// de registrar (snapshot: cambiar la tarifa después no toca la fila). En `inicial` valor = tarifa.
//
// CHECKs declarados AQUÍ y en la 0199 (lección 0157): un CHECK que solo vive en la base convence a
// quien lee el esquema de que no hace falta migración, y el primer INSERT nuevo muere con 23514.
//
// Import circular a propósito (mismo patrón que `schema/permisos.ts`): las FK de Drizzle son callbacks
// perezosos, así que el ciclo ESM resuelve sin problema.
import { pgTable, uuid, varchar, text, numeric, integer, timestamp, unique, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { flitoTramites, users } from '../schema.js';

export const flitoTramiteViajesLogistica = pgTable('flito_tramite_viajes_logistica', {
  id: uuid('id').primaryKey().defaultRandom(),
  tramiteId: uuid('tramite_id').notNull().references(() => flitoTramites.id, { onDelete: 'cascade' }),
  /** Ordinal en el trámite: MAX+1 bajo el FOR UPDATE del trámite; no se renumera al quitar. */
  numero: integer('numero').notNull(),
  /** 'inicial' (copia la tarifa vigente) | 'manual' (precio a mano). */
  modo: varchar('modo', { length: 10 }).notNull(),
  valor: numeric('valor', { precision: 14, scale: 2 }).notNull(),
  /** Tarifa de logística vigente al registrar. NULL solo en `manual` sin tarifa configurada. */
  tarifaVigente: numeric('tarifa_vigente', { precision: 14, scale: 2 }),
  /** 'devolucion' | 'segunda_entrega' | 'documento_faltante' | 'otro'. */
  motivo: varchar('motivo', { length: 30 }).notNull(),
  /** Obligatorio (no blanco) cuando `motivo = 'otro'`. */
  motivoDetalle: text('motivo_detalle'),
  /** Actor del registro; FK RESTRICT (ADR-0005). Acompaña a registrado_en. */
  registradoPorId: integer('registrado_por_id').references(() => users.id, { onDelete: 'restrict' }),
  registradoEn: timestamp('registrado_en', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  /** Un ordinal por trámite; también es el índice de lectura por trámite (va primero en la llave). */
  tramiteNumeroUq: unique('flito_tramite_viajes_log_tramite_numero_uq').on(t.tramiteId, t.numero),
  numeroChk: check('flito_tramite_viajes_log_numero_chk', sql`${t.numero} >= 2`),
  valorChk: check('flito_tramite_viajes_log_valor_chk', sql`${t.valor} >= 0`),
  modoChk: check('flito_tramite_viajes_log_modo_chk', sql`${t.modo} IN ('inicial', 'manual')`),
  motivoChk: check('flito_tramite_viajes_log_motivo_chk',
    sql`${t.motivo} IN ('devolucion', 'segunda_entrega', 'documento_faltante', 'otro')`),
  motivoDetalleChk: check('flito_tramite_viajes_log_motivo_detalle_chk',
    sql`${t.motivo} <> 'otro' OR (${t.motivoDetalle} IS NOT NULL AND btrim(${t.motivoDetalle}) <> '')`),
  /** `inicial` copia la tarifa: sin tarifa no hay `inicial` (422 en la ruta). */
  tarifaInicialChk: check('flito_tramite_viajes_log_tarifa_inicial_chk',
    sql`${t.modo} = 'manual' OR ${t.tarifaVigente} IS NOT NULL`),
  valorInicialChk: check('flito_tramite_viajes_log_valor_inicial_chk',
    sql`${t.modo} <> 'inicial' OR ${t.valor} = ${t.tarifaVigente}`),
}));
