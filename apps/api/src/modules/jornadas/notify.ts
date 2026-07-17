// Helper para encolar emails de notificación PESV vía notification_outbox.
// El cron rndc/retry.cron.ts envía outbox con retry exponencial; aquí solo INSERT.
//
// Si pesvAlertRecipients env no está, fallback: emails de admins activos.
// Diseño: nunca lanzamos throw aquí — la notificación es best-effort. Una falla en outbox
// no debe abortar el cierre de jornada / reporte mensual / etc.

import { db } from '../../db/client.js';
import { notificationOutbox, users } from '../../db/schema.js';
import { eq, and, isNotNull } from 'drizzle-orm';
import { pesvAlertRecipients } from '../../config/env.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('jornadas-notify');

const ALARMA_LABELS: Record<string, string> = {
  mas_4h_continuas: 'Más de 4 horas de conducción continua sin pausa registrada',
  mas_10h_jornada: 'Jornada total superior a 10 horas (Decreto 1079/2015)',
  menos_8h_descanso: 'Descanso entre jornadas inferior a 8 horas (CST art. 161)',
  mas_60h_semanal: 'Acumulado semanal supera 60 horas (Decreto 1079/2015)',
  sin_pausa_obligatoria: 'No se registró la pausa obligatoria de 30 min cada 4 horas (Res. 12379/2012)',
};

export async function getAdminEmails(): Promise<string[]> {
  // Recipientes configurables vía env; si vacío, fallback admins activos.
  if (pesvAlertRecipients.length) return pesvAlertRecipients;
  const rows = await db.select({ email: users.email })
    .from(users)
    .where(and(eq(users.role, 'admin'), eq(users.active, true), isNotNull(users.email)));
  return rows.map((r) => r.email!).filter(Boolean);
}

export async function notifyJornadaAlarmas(opts: {
  conductorId: number;
  conductorNombre?: string | null;
  jornadaId: number;
  alarmas: Array<{ tipo: string; valorObservado: number; valorLimite: number; unidad: string }>;
}): Promise<void> {
  if (!opts.alarmas.length) return;
  try {
    const dest = await getAdminEmails();
    if (!dest.length) {
      log.warn('Sin destinatarios admin para alarma jornada — outbox no se encola');
      return;
    }
    const items = opts.alarmas.map((a) => `<li><strong>${ALARMA_LABELS[a.tipo] ?? a.tipo}</strong> — observado ${a.valorObservado} ${a.unidad}, límite ${a.valorLimite} ${a.unidad}</li>`).join('');
    const titulo = `Alarma PESV — Conductor ${opts.conductorNombre ?? '#' + opts.conductorId} (${opts.alarmas.length})`;
    await db.insert(notificationOutbox).values({
      canal: 'email',
      destinatarios: JSON.stringify(dest),
      asunto: titulo,
      cuerpoHtml: `<h3>${titulo}</h3><p>Jornada #${opts.jornadaId} cerrada con alarmas de cumplimiento normativo:</p><ul>${items}</ul><p>Acción recomendada: revisar el detalle en el módulo PESV → Control de jornada y registrar el ack con observación.</p>`,
      cuerpoTexto: `${titulo}\n\nJornada #${opts.jornadaId} cerrada con ${opts.alarmas.length} alarma(s).\n\n` + opts.alarmas.map((a) => `- ${ALARMA_LABELS[a.tipo] ?? a.tipo}: observado ${a.valorObservado} ${a.unidad}, límite ${a.valorLimite} ${a.unidad}`).join('\n'),
      contextoTipo: 'jornada_alarma',
      contextoId: opts.jornadaId,
    });
  } catch (e: any) {
    log.error({ err: e?.message, jornadaId: opts.jornadaId }, 'fallo encolar notificación alarma jornada');
  }
}

export async function notifyPesvAdmin(opts: {
  contextoTipo: string;
  contextoId?: number | null;
  asunto: string;
  cuerpoHtml: string;
  cuerpoTexto?: string;
}): Promise<void> {
  try {
    const dest = await getAdminEmails();
    if (!dest.length) return;
    await db.insert(notificationOutbox).values({
      canal: 'email',
      destinatarios: JSON.stringify(dest),
      asunto: opts.asunto,
      cuerpoHtml: opts.cuerpoHtml,
      cuerpoTexto: opts.cuerpoTexto ?? opts.asunto,
      contextoTipo: opts.contextoTipo,
      contextoId: opts.contextoId ?? null,
    });
  } catch (e: any) {
    log.error({ err: e?.message, ctx: opts.contextoTipo }, 'fallo encolar notificación PESV');
  }
}
