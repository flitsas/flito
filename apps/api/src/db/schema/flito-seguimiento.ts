// FLITO, transversal a sus dominios: cola de revisión OCR e historial de estados. Se re-exporta desde `../schema.ts` (HU #13984).
import {
  pgTable, varchar, text, boolean, timestamp, integer, index, jsonb, bigserial, uuid,
} from 'drizzle-orm/pg-core';
import { users } from './nucleo.js';
import { flitoSoportes } from './soat.js';

// Cola de revisión OCR (CA-06/CA-07). Los gestores no la resuelven (RN-04/RN-05).
export const flitoRevisiones = pgTable('flito_revisiones', {
  id: uuid('id').primaryKey().defaultRandom(),
  modulo: varchar('modulo', { length: 20 }).notNull(),
  motivo: varchar('motivo', { length: 40 }).notNull(),
  detalle: text('detalle').notNull(),
  registroId: uuid('registro_id'),
  soporteId: uuid('soporte_id').notNull().references(() => flitoSoportes.id, { onDelete: 'cascade' }),
  placaSugerida: varchar('placa_sugerida', { length: 10 }),
  extraccion: jsonb('extraccion').notNull(),
  resuelto: boolean('resuelto').notNull().default(false),
  resueltoPorId: integer('resuelto_por_id').references(() => users.id),
  resueltoEn: timestamp('resuelto_en', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  resueltoIdx: index('idx_flito_revisiones_resuelto').on(t.resuelto),
}));

/**
 * Cambios de estado de SOAT e impuestos — el equivalente de `flito_tramite_historial` para los dos
 * conceptos, que hasta ahora no tenían ninguno y cuyo rastro vivía disperso en `audit_logs`, en
 * texto libre y sin campos de estado.
 *
 * Una sola tabla para ambos, discriminados por `concepto`: comparten los mismos cuatro estados y las
 * mismas transiciones, así que dos tablas gemelas serían dos veces el mismo código.
 *
 * Sin FK hacia `flito_soat`/`flito_impuestos`: una FK apunta a UNA tabla y este historial sirve a
 * dos. La integridad la da `concepto` más el filtro de los lectores.
 */
export const flitoEstadoHistorial = pgTable('flito_estado_historial', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  /** 'soat' | 'impuesto'. */
  concepto: varchar('concepto', { length: 20 }).notNull(),
  registroId: uuid('registro_id').notNull(),
  /** Null en el alta: antes de existir no había estado del que venir. */
  estadoAnterior: varchar('estado_anterior', { length: 30 }),
  estadoNuevo: varchar('estado_nuevo', { length: 30 }).notNull(),
  motivo: text('motivo'),
  usuarioId: integer('usuario_id').references(() => users.id, { onDelete: 'set null' }),
  // Se copia el correo además del id: si el usuario se borra, el historial debe seguir diciendo
  // quién lo hizo. Mismo criterio que `flito_soportes.subido_por_nombre`.
  usuarioEmail: varchar('usuario_email', { length: 150 }),
  /** 'usuario' | 'sistema' | 'auditoria'. El último marca lo reconstruido desde `audit_logs`. */
  origen: varchar('origen', { length: 20 }).notNull().default('usuario'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  registroIdx: index('idx_flito_estado_historial_registro').on(t.concepto, t.registroId, t.createdAt),
}));
