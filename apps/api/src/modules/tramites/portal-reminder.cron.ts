// TRAM-COMMS-02 (Epic Fase 6) — Recordatorios automáticos a participantes del
// portal (comprador/vendedor/mandatario) que no completaron sus pasos.
//
// Diario a las 09:00 UTC: busca participantes pendientes de trámites ACTIVOS cuyo
// token expira pronto (<12h) o llevan >24h sin completar, respetando un cooldown de
// 24h (last_reminder_at). Por cada candidato rota el token (nuevo magic link) y lo
// reenvía por email o WhatsApp. Sin canal → evento degradado (el gestor copia el
// link desde el wizard). Ley 1581: el cuerpo NO lleva PII de terceros, solo rol +
// placa/VIN parcial + enlace al portal.
//
// Idempotencia: cooldown 24h en `last_reminder_at`. Concurrencia: withLock diario.
// Gating: noop salvo TRAM_PORTAL_REMINDER_CRON_ENABLED=1 (default off en dev).

import os from 'os';
import { and, eq, or, isNull, lt, notInArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { tramiteParticipantes, tramitesDigitales } from '../../db/schema.js';
import { withLock } from '../../shared/utils/lock.js';
import { sendEmail, isSmtpConfigured } from '../../services/email.js';
import { whatsappEnabled, anyChannelEnabled, sendWhatsAppVia } from './notificaciones.js';
import { rotarTokenParticipante } from './portal.js';
import { emitEvento } from './eventos.js';
import { env } from '../../config/env.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('tramite.portal-reminder');
const HOST_ID = `${os.hostname()}-${process.pid}`;

export const REMINDER_HOUR_UTC = 9;
const RUN_INTERVAL_MS = 60 * 60_000; // chequeo horario; el envío sólo corre a la hora objetivo
const LOCK_TTL_MS = 50 * 60_000;
const BATCH_SIZE = 100;
const ACTIVE_EXCLUDE: ('completado' | 'rechazado')[] = ['completado', 'rechazado']; // trámite activo = NO en estos estados

let timer: NodeJS.Timeout | null = null;

interface Candidate {
  id: number; rol: string; email: string | null; telefono: string | null;
  whatsappOptIn: boolean; tramiteId: number; placa: string | null; vin: string | null;
}

/** Placa, o VIN parcial (últimos 6) — nunca PII de terceros (Ley 1581). */
function placaParcial(c: Candidate): string {
  return c.placa || (c.vin ? `VIN…${c.vin.slice(-6)}` : 'tu vehículo');
}

/** Candidatos: pendientes, trámite activo, token por expirar (<12h) o >24h sin completar, fuera de cooldown. */
async function selectCandidates(): Promise<Candidate[]> {
  return (await db.select({
    id: tramiteParticipantes.id, rol: tramiteParticipantes.rol,
    email: tramiteParticipantes.email, telefono: tramiteParticipantes.telefono,
    whatsappOptIn: tramiteParticipantes.whatsappOptIn,
    tramiteId: tramiteParticipantes.tramiteId,
    placa: tramitesDigitales.placa, vin: tramitesDigitales.vin,
  }).from(tramiteParticipantes)
    .innerJoin(tramitesDigitales, eq(tramiteParticipantes.tramiteId, tramitesDigitales.id))
    .where(and(
      isNull(tramiteParticipantes.completedAt),
      notInArray(tramitesDigitales.estado, ACTIVE_EXCLUDE),
      or(
        lt(tramiteParticipantes.expiresAt, sql`now() + interval '12 hours'`),
        lt(tramiteParticipantes.createdAt, sql`now() - interval '24 hours'`),
      ),
      or(
        isNull(tramiteParticipantes.lastReminderAt),
        lt(tramiteParticipantes.lastReminderAt, sql`now() - interval '24 hours'`),
      ),
    ))
    .limit(BATCH_SIZE)) as Candidate[];
}

/** Cuerpo del recordatorio. PURO. Sin PII de terceros (solo rol + placa parcial + link). */
export function reminderBody(rol: string, placa: string, url: string) {
  return {
    subject: `FLIT · Completa tu parte del trámite (${rol})`,
    text: `Hola. Como ${rol} del trámite del vehículo ${placa}, aún falta completar tus pasos en el portal seguro. Ingresa (vence en 24h): ${url}`,
    html: `<p>Hola.</p><p>Como <strong>${rol}</strong> del trámite del vehículo <strong>${placa}</strong>, aún falta completar tus pasos en el portal seguro.</p><p><a href="${url}">Continuar en el portal</a> (el enlace vence en 24 horas).</p>`,
  };
}

async function deliver(c: Candidate, url: string): Promise<'whatsapp' | 'email' | null> {
  const { subject, text, html } = reminderBody(c.rol, placaParcial(c), url);
  if (whatsappEnabled() && c.whatsappOptIn && c.telefono) {
    if (await sendWhatsAppVia(env.WHATSAPP_TOKEN!, env.WHATSAPP_PHONE_ID!, c.telefono, text)) return 'whatsapp';
  }
  if (isSmtpConfigured() && c.email) {
    const r = await sendEmail({ to: c.email, subject, html });
    if (r.ok) return 'email';
  }
  return null;
}

export interface SweepResult { candidatos: number; enviados: number; omitidos: number; skipped?: boolean }

/** Núcleo testeable (sin reloj ni lock): procesa los candidatos pendientes una vez. */
export async function runReminderSweep(): Promise<SweepResult> {
  // Regla: si NINGÚN proveedor está configurado, no rotar ni enviar — log + skip.
  if (!anyChannelEnabled()) {
    log.info({ host: HOST_ID }, 'recordatorios omitidos — SMTP y WhatsApp ambos off');
    return { candidatos: 0, enviados: 0, omitidos: 0, skipped: true };
  }

  const candidates = await selectCandidates();
  let enviados = 0, omitidos = 0;
  for (const c of candidates) {
    const hasChannel = (isSmtpConfigured() && !!c.email) || (whatsappEnabled() && c.whatsappOptIn && !!c.telefono);
    if (!hasChannel) {
      // Degradado: el gestor copia el link manual desde el wizard. Marca cooldown
      // para no re-emitir a diario.
      await db.update(tramiteParticipantes).set({ lastReminderAt: new Date() }).where(eq(tramiteParticipantes.id, c.id));
      await emitEvento({ tramiteId: c.tramiteId, tipo: 'recordatorio_portal_omitido', actorRole: c.rol, payload: { rol: c.rol, motivo: 'sin_canal' } });
      omitidos++;
      continue;
    }
    const rotated = await rotarTokenParticipante(c.id);
    if (!rotated) continue; // completó entre la consulta y ahora
    const canal = await deliver(c, rotated.url);
    await db.update(tramiteParticipantes).set({ lastReminderAt: new Date() }).where(eq(tramiteParticipantes.id, c.id));
    if (canal) {
      await emitEvento({ tramiteId: c.tramiteId, tipo: 'recordatorio_portal_enviado', actorRole: c.rol, payload: { rol: c.rol, canal } });
      enviados++;
    } else {
      await emitEvento({ tramiteId: c.tramiteId, tipo: 'recordatorio_portal_omitido', actorRole: c.rol, payload: { rol: c.rol, motivo: 'envio_fallido' } });
      omitidos++;
    }
  }
  log.info({ host: HOST_ID, candidatos: candidates.length, enviados, omitidos }, 'sweep recordatorios portal completado');
  return { candidatos: candidates.length, enviados, omitidos };
}

async function runScheduled(): Promise<void> {
  const now = new Date();
  if (now.getUTCHours() !== REMINDER_HOUR_UTC) return;
  await withLock(`tram-portal-reminder-${now.toISOString().slice(0, 10)}`, LOCK_TTL_MS, async () => { await runReminderSweep(); });
}

export function startPortalReminderCron(): void {
  if (timer) return;
  if (process.env.TRAM_PORTAL_REMINDER_CRON_ENABLED !== '1') {
    log.info({ host: HOST_ID }, 'cron recordatorios portal DESHABILITADO (TRAM_PORTAL_REMINDER_CRON_ENABLED!=1)');
    return;
  }
  log.info({ host: HOST_ID, horaUtc: REMINDER_HOUR_UTC }, 'cron recordatorios portal activo');
  setTimeout(() => { runScheduled().catch((e) => log.error({ err: e?.message }, 'first runScheduled throw')); }, 5 * 60_000);
  timer = setInterval(() => { runScheduled().catch((e) => log.error({ err: e?.message }, 'runScheduled throw')); }, RUN_INTERVAL_MS);
}

export function stopPortalReminderCron(): void {
  if (timer) { clearInterval(timer); timer = null; }
  log.info('cron recordatorios portal detenido');
}
