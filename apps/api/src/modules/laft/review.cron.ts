import os from 'os';
import { lte, eq, and } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { laftCounterparties } from '../../db/schema.js';
import { withLock } from '../../shared/utils/lock.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('laft-review');

/**
 * Cron diario que detecta contrapartes con next_review_at vencido y las marca como
 * "pendiente" para que el Empleado de Cumplimiento las revise nuevamente.
 * Cumple sección 9.3 de la política (validación periódica mínimo anual).
 */

const HOST_ID = `${os.hostname()}-${process.pid}`;
const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

const LOCK_TTL_MS = 5 * 60 * 1000; // 5min: el job es rápido, evita carreras entre instancias.

async function runOnce(): Promise<{ marked: number }> {
  const today = new Date().toISOString().slice(0, 10);

  const result = await withLock('laft-review-cron', LOCK_TTL_MS, async () => {
    // Solo afectamos contrapartes vinculadas (no bloqueadas ni archivadas).
    return db.update(laftCounterparties).set({
      status: 'pendiente',
      updatedAt: new Date(),
    })
      .where(and(
        eq(laftCounterparties.status, 'vinculada'),
        lte(laftCounterparties.nextReviewAt, today),
      ))
      .returning({ id: laftCounterparties.id });
  });

  return { marked: result?.length ?? 0 };
}

let timer: NodeJS.Timeout | null = null;

export function startReviewCron(): void {
  if (timer) return;
  log.info({ host: HOST_ID, intervalH: 24 }, 'Activo');
  setTimeout(async () => {
    try {
      const r = await runOnce();
      if (r.marked > 0) log.info({ marked: r.marked }, 'contrapartes marcadas pendientes (revisión vencida)');
    } catch (e) { log.error({ err: e }, 'corrida falló'); }
  }, 60_000).unref();

  timer = setInterval(async () => {
    try {
      const r = await runOnce();
      if (r.marked > 0) log.info({ marked: r.marked }, 'contrapartes marcadas pendientes (revisión vencida)');
    } catch (e) { log.error({ err: e }, 'corrida falló'); }
  }, RUN_INTERVAL_MS);
  timer.unref();
}

export function stopReviewCron(): void {
  if (timer) { clearInterval(timer); timer = null; log.info('Detenido'); }
}
