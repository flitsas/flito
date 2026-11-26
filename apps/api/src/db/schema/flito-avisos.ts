// Avisos por usuario (Épica #14707, ADR-0049 §7): bandeja mínima con SOLO referencias. Hoy un único tipo,
// `solicitud_retirada`: se descartó una solicitud de SOAT o impuesto que el usuario había enviado, porque su
// trámite murió en FLIT. La placa y el radicado se resuelven con JOIN al leer: el aviso no guarda ningún dato
// del titular (Ley 1581). `varchar` + CHECK y no `pgEnum`, como `flito_soat.origen` (sin la trampa 55P04).
// Lo crea la migración 0318; la API de lectura y la purga (90/180 días) llegan en el Bloque 2.
import { pgTable, varchar, timestamp, integer, uuid, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './nucleo.js';
import { flitoTramites } from './tramites.js';

export const flitoAvisosUsuario = pgTable('flito_avisos_usuario', {
  id: uuid('id').primaryKey().defaultRandom(),
  usuarioId: integer('usuario_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tipo: varchar('tipo', { length: 30 }).notNull(),
  concepto: varchar('concepto', { length: 10 }).notNull().$type<'soat' | 'impuesto'>(),
  /** Id del SOAT o del impuesto descartado (sin FK: el concepto decide la tabla). */
  registroId: uuid('registro_id').notNull(),
  tramiteId: uuid('tramite_id').references(() => flitoTramites.id),
  motivo: varchar('motivo', { length: 10 }).notNull().$type<'anulado' | 'abortado' | 'revocado'>(),
  creadoEn: timestamp('creado_en', { withTimezone: true }).notNull().defaultNow(),
  vistoEn: timestamp('visto_en', { withTimezone: true }),
}, (t) => ({
  unico: uniqueIndex('uq_flito_avisos_usuario_registro').on(t.usuarioId, t.tipo, t.concepto, t.registroId),
  noVistos: index('idx_flito_avisos_usuario_no_vistos').on(t.usuarioId, t.creadoEn).where(sql`${t.vistoEn} IS NULL`),
  tipoChk: check('flito_avisos_usuario_tipo_chk', sql`${t.tipo} IN ('solicitud_retirada')`),
  conceptoChk: check('flito_avisos_usuario_concepto_chk', sql`${t.concepto} IN ('soat','impuesto')`),
  motivoChk: check('flito_avisos_usuario_motivo_chk', sql`${t.motivo} IN ('anulado','abortado','revocado')`),
}));
