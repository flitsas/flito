import os from 'os';
import { eq, and, sql, inArray, isNull, lte, or, desc } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { manifiestos, notificationOutbox } from '../../db/schema.js';
import { withLock } from '../../shared/utils/lock.js';
import { procesarManifiesto } from './envio.service.js';
import { sendEmail } from '../../services/email.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('rndc-retry');

// ============================================================================
// Cron de envío RNDC. Cada 5 min:
// 1. Rescate: filas en 'enviando' > 10 min → revertir a 'error_envio'.
// 2. Procesar batch (20) de pendiente_envio + error_envio + fallido_temporal
//    cuyo proximo_intento_at ya venció.
// 3. Procesar outbox de notificaciones (emails).
// ============================================================================

const HOST_ID = `${os.hostname()}-${process.pid}`;
const RUN_INTERVAL_MS = 5 * 60_000;
const LOCK_TTL_MS = 4 * 60_000;
const ZOMBIE_THRESHOLD_MIN = 10;
const BATCH_SIZE = 20;

async function rescatarZombies(): Promise<number> {
  const threshold = new Date(Date.now() - ZOMBIE_THRESHOLD_MIN * 60_000);
  const r = await db.update(manifiestos).set({
    estadoEnvio: 'error_envio',
    proximoIntentoAt: new Date(),
    ultimoError: 'Rescatado de estado enviando (timeout/crash)',
  })
    .where(and(
      eq(manifiestos.estadoEnvio, 'enviando'),
      lte(manifiestos.ultimoIntentoAt, threshold),
    ))
    .returning({ id: manifiestos.id });
  return r.length;
}

async function pickBatch(): Promise<number[]> {
  // SELECT FOR UPDATE SKIP LOCKED para distribuir entre instancias.
  const now = new Date();
  const rows = await db.execute<{ id: number }>(sql`
    SELECT id FROM manifiestos
    WHERE estado_envio IN ('pendiente_envio', 'error_envio', 'fallido_temporal')
      AND (proximo_intento_at IS NULL OR proximo_intento_at <= ${now.toISOString()})
      AND deleted_at IS NULL
    ORDER BY ultimo_intento_at NULLS FIRST, id
    LIMIT ${BATCH_SIZE}
    FOR UPDATE SKIP LOCKED
  `);
  return (rows as any).map((r: any) => Number(r.id));
}

async function procesarBatch(): Promise<{ ok: number; err: number }> {
  const ids = await pickBatch();
  if (ids.length === 0) return { ok: 0, err: 0 };
  let ok = 0, err = 0;
  for (const id of ids) {
    try {
      const r = await procesarManifiesto(id);
      if (r.estadoFinal === 'aceptado') ok++; else err++;
    } catch (e: any) {
      err++;
      log.error({ manifiestoId: id, err: e?.message }, 'procesarManifiesto excepción');
    }
  }
  return { ok, err };
}

// Concurrencia para envío SMTP. SMTP serial con 20 emails y timeout 30s puede tardar 10 min,
// pasando el lock TTL del cron (4 min) y permitiendo doble-procesamiento. Paralelizar a 3
// reduce a ~3-4 min en peor caso, dentro del TTL.
const OUTBOX_PARALLEL = 3;

type OutboxRow = typeof notificationOutbox.$inferSelect;

async function procesarOutboxRow(row: OutboxRow): Promise<boolean> {
  let destinatarios: string[];
  try {
    destinatarios = JSON.parse(row.destinatarios);
  } catch {
    await db.update(notificationOutbox).set({
      estado: 'fallido_definitivo',
      ultimoError: 'destinatarios JSON inválido',
    }).where(eq(notificationOutbox.id, row.id));
    return false;
  }
  const result = await sendEmail({
    to: destinatarios,
    subject: row.asunto,
    html: row.cuerpoHtml,
    text: row.cuerpoTexto ?? undefined,
  });
  const intentos = row.intentos + 1;
  if (result.ok) {
    await db.update(notificationOutbox).set({
      estado: 'enviado',
      enviadoAt: new Date(),
      intentos,
      messageId: result.messageId,
    }).where(eq(notificationOutbox.id, row.id));
    return true;
  }
  if (intentos >= 5) {
    await db.update(notificationOutbox).set({
      estado: 'fallido_definitivo',
      intentos,
      ultimoError: result.error,
      ultimoIntentoAt: new Date(),
    }).where(eq(notificationOutbox.id, row.id));
  } else {
    const next = new Date(Date.now() + Math.min(60_000 * 2 ** intentos, 30 * 60_000));
    await db.update(notificationOutbox).set({
      estado: 'error',
      intentos,
      ultimoError: result.error,
      ultimoIntentoAt: new Date(),
      proximoIntentoAt: next,
    }).where(eq(notificationOutbox.id, row.id));
  }
  return false;
}

async function procesarOutbox(): Promise<number> {
  const now = new Date();
  const pending = await db.select().from(notificationOutbox)
    .where(and(
      inArray(notificationOutbox.estado, ['pendiente', 'error']),
      or(isNull(notificationOutbox.proximoIntentoAt), lte(notificationOutbox.proximoIntentoAt, now)),
    ))
    .orderBy(notificationOutbox.id)
    .limit(20);

  let sent = 0;
  for (let i = 0; i < pending.length; i += OUTBOX_PARALLEL) {
    const slice = pending.slice(i, i + OUTBOX_PARALLEL);
    const results = await Promise.allSettled(slice.map((row) => procesarOutboxRow(row)));
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) sent++;
      if (r.status === 'rejected') log.error({ reason: String(r.reason) }, 'outbox row rejected');
    }
  }
  return sent;
}

async function runOnce(): Promise<void> {
  const result = await withLock('rndc-retry-cron', LOCK_TTL_MS, async () => {
    const z = await rescatarZombies();
    const b = await procesarBatch();
    const o = await procesarOutbox();
    return { z, b, o };
  });
  if (result) {
    const { z, b, o } = result;
    if (z > 0 || b.ok > 0 || b.err > 0 || o > 0) {
      log.info({ zombies: z, ok: b.ok, err: b.err, emailSent: o }, 'ciclo completado');
    }
  }
}

let timer: NodeJS.Timeout | null = null;

export function startRndcRetryCron(): void {
  if (timer) return;
  log.info({ host: HOST_ID, intervalMin: 5, lockTtlMin: 4, batch: BATCH_SIZE }, 'cron activo');
  setTimeout(() => { runOnce().catch((e) => log.error({ err: e?.message }, 'runOnce error')); }, 60_000).unref();
  timer = setInterval(() => { runOnce().catch((e) => log.error({ err: e?.message }, 'runOnce error')); }, RUN_INTERVAL_MS);
  timer.unref();
}

export function stopRndcRetryCron(): void {
  if (timer) { clearInterval(timer); timer = null; log.info('cron detenido'); }
}
