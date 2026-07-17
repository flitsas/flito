import os from 'os';
import { lt, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { rumWebVitals } from '../../db/schema.js';
import { withLock } from '../../shared/utils/lock.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('rum-purge');
const HOST_ID = `${os.hostname()}-${process.pid}`;
const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LOCK_TTL_MS = 10 * 60 * 1000;
const RETENTION_DAYS = 90;

export async function runRumPurgeOnce(opts: { dryRun?: boolean } = {}): Promise<{ deleted: number; dryRun: boolean }> {
  const dryRun = opts.dryRun ?? false;
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const result = await withLock('rum-web-vitals-purge', LOCK_TTL_MS, async () => {
    if (dryRun) {
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(rumWebVitals)
        .where(lt(rumWebVitals.createdAt, cutoff));
      log.info({ candidates: count, cutoff: cutoff.toISOString() }, 'dry-run rum purge');
      return { deleted: count, dryRun: true };
    }

    const deleted = await db
      .delete(rumWebVitals)
      .where(lt(rumWebVitals.createdAt, cutoff))
      .returning({ id: rumWebVitals.id });

    if (deleted.length > 0) {
      log.info({ deleted: deleted.length, retentionDays: RETENTION_DAYS }, 'rum_web_vitals purged');
    }
    return { deleted: deleted.length, dryRun: false };
  });

  return result ?? { deleted: 0, dryRun };
}

let timer: NodeJS.Timeout | null = null;

export function startRumPurgeCron(): void {
  if (timer) return;
  log.info({ host: HOST_ID, retentionDays: RETENTION_DAYS }, 'rum purge cron activo');

  setTimeout(async () => {
    try { await runRumPurgeOnce(); }
    catch (e) { log.error({ err: e }, 'rum purge primera corrida'); }
  }, 8 * 60 * 1000).unref();

  timer = setInterval(async () => {
    try { await runRumPurgeOnce(); }
    catch (e) { log.error({ err: e }, 'rum purge corrida'); }
  }, RUN_INTERVAL_MS);
  timer.unref();
}

export function stopRumPurgeCron(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
