import os from 'os';
import { and, eq, lte, sql } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { laftEmployeesKyc, notificationOutbox, users } from '../../../db/schema.js';
import { withLock } from '../../../shared/utils/lock.js';
import { loggerFor } from '../../../shared/logger.js';

const log = loggerFor('laft-employees-rekyc');

// Cron diario: notifica a compliance los KYC de empleados con next_review_at
// próximo a vencer (≤ +30 días). Resolución UIAF 122/2021 §10 — reKYC mínimo anual.
//
// Run en 03:00 UTC para evitar contención con el resto de jobs (06:00 sería
// medianoche en Colombia y todo el mundo está corriendo cierres). Se reusa
// `withLock` para garantizar exclusividad cross-instancia (Redis-backed) — si
// dos instancias arrancan a la vez, sólo una manda los emails.

const HOST_ID = `${os.hostname()}-${process.pid}`;
const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LOCK_TTL_MS = 5 * 60 * 1000;
const ALERT_WINDOW_DAYS = 30;

function targetDate(daysAhead: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  return d.toISOString().slice(0, 10);
}

function complianceRecipientsEnv(): string[] {
  const raw = process.env.LAFT_COMPLIANCE_RECIPIENTS ?? '';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

interface DueRow {
  id: number;
  userId: number;
  riskLevel: string;
  nextReviewAt: string;
  userName: string | null;
  userUsername: string | null;
}

async function findDueRows(): Promise<DueRow[]> {
  const cutoff = targetDate(ALERT_WINDOW_DAYS);
  return db
    .select({
      id: laftEmployeesKyc.id,
      userId: laftEmployeesKyc.userId,
      riskLevel: laftEmployeesKyc.riskLevel,
      nextReviewAt: laftEmployeesKyc.nextReviewAt,
      userName: users.name,
      userUsername: users.username,
    })
    .from(laftEmployeesKyc)
    .leftJoin(users, eq(users.id, laftEmployeesKyc.userId))
    .where(and(
      eq(laftEmployeesKyc.matchBlocked, false),
      lte(laftEmployeesKyc.nextReviewAt, cutoff),
    )) as unknown as Promise<DueRow[]>;
}

function buildEmail(rows: DueRow[]): { subject: string; html: string; text: string } {
  const subject = `LAFT — ReKYC empleados próximos a vencer (${rows.length})`;
  const list = rows
    .map((r) => `<li>${r.userName ?? '(sin nombre)'} (${r.userUsername ?? '?'}) · riesgo ${r.riskLevel} · vence ${r.nextReviewAt}</li>`)
    .join('');
  const html = `
    <p>Estos KYC de empleados deben renovarse en los próximos ${ALERT_WINDOW_DAYS} días:</p>
    <ul>${list}</ul>
    <p>Resolución UIAF 122/2021 §10 — reKYC mínimo anual.</p>
  `;
  const text = `ReKYC empleados próximos a vencer:\n` +
    rows.map((r) => `- ${r.userName ?? '?'} (${r.userUsername ?? '?'}) · ${r.riskLevel} · vence ${r.nextReviewAt}`).join('\n');
  return { subject, html, text };
}

async function enqueueOutbox(rows: DueRow[]): Promise<number> {
  const recipients = complianceRecipientsEnv();
  if (recipients.length === 0) {
    log.warn('LAFT_COMPLIANCE_RECIPIENTS no configurado — skip notificación');
    return 0;
  }
  if (rows.length === 0) return 0;

  const { subject, html, text } = buildEmail(rows);
  await db.insert(notificationOutbox).values({
    canal: 'email',
    destinatarios: JSON.stringify(recipients),
    asunto: subject,
    cuerpoHtml: html,
    cuerpoTexto: text,
    contextoTipo: 'laft_employees_rekyc',
    contextoId: null,
  });
  return rows.length;
}

async function runOnce(): Promise<{ found: number; queued: number }> {
  const result = await withLock('laft-employees-rekyc-cron', LOCK_TTL_MS, async () => {
    const due = await findDueRows();
    const queued = await enqueueOutbox(due);
    return { found: due.length, queued };
  });
  return result ?? { found: 0, queued: 0 };
}

let timer: NodeJS.Timeout | null = null;

// El primer disparo del setTimeout busca el próximo 03:00 UTC. Si la app arranca a
// las 02:55 UTC, el primer run será en 5 min; si arranca a las 04:00 UTC, será en
// 23h. Después se hace setInterval cada 24h sin recalcular (drift mínimo).
function msUntilNextUtcHour(hour: number): number {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

export function startEmployeesRekycCron(): void {
  if (timer) return;
  const firstDelay = msUntilNextUtcHour(3);
  log.info({ host: HOST_ID, firstRunInH: Math.round(firstDelay / 3_600_000) }, 'Activo (03:00 UTC diario)');

  setTimeout(async () => {
    try {
      const r = await runOnce();
      if (r.found > 0) log.info({ found: r.found, queued: r.queued }, 'reKYC alerts enqueued');
    } catch (e) { log.error({ err: e }, 'corrida falló'); }
    timer = setInterval(async () => {
      try {
        const r = await runOnce();
        if (r.found > 0) log.info({ found: r.found, queued: r.queued }, 'reKYC alerts enqueued');
      } catch (e) { log.error({ err: e }, 'corrida falló'); }
    }, RUN_INTERVAL_MS);
    timer.unref();
  }, firstDelay).unref();
}

export function stopEmployeesRekycCron(): void {
  if (timer) { clearInterval(timer); timer = null; log.info('Detenido'); }
}

// Para tests: corre el flujo una vez sin esperar al timer.
export const _runOnceForTests = runOnce;
