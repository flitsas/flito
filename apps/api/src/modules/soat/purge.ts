import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { soatRefreshAttempts } from '../../db/schema.js';
import { withLock } from '../../shared/utils/lock.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('soat-purge');

// Purge de auditoría vieja. Retención: 90 días rollover.
// Si regulatoriamente se necesita más (ej: 2 años Ley 1581), migrar a archive table.
const RETENTION_DAYS = 90;
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000; // diario
const PURGE_LOCK_TTL_MS = 10 * 60 * 1000; // 10 min

let purgeTimer: ReturnType<typeof setInterval> | null = null;
let startupTimer: ReturnType<typeof setTimeout> | null = null;

async function runPurge() {
  const result = await withLock('soat-purge', PURGE_LOCK_TTL_MS, async () => {
    const t0 = Date.now();
    const res = await db.delete(soatRefreshAttempts).where(
      sql`${soatRefreshAttempts.createdAt} < now() - interval '${sql.raw(String(RETENTION_DAYS))} days'`
    );
    const count = (res as any)?.rowCount ?? 0;
    log.info({ deleted: count, retentionDays: RETENTION_DAYS, durationMs: Date.now() - t0 }, 'soat_refresh_attempts purged');
    return count;
  });
  if (result === null) log.info('saltado — otra instancia está purgando');
}

export function startPurger() {
  startupTimer = setTimeout(() => { runPurge().catch((e) => log.error({ err: e }, 'unhandled')); }, 30 * 60 * 1000);
  purgeTimer = setInterval(() => { runPurge().catch((e) => log.error({ err: e }, 'unhandled')); }, PURGE_INTERVAL_MS);
  log.info({ retentionDays: RETENTION_DAYS, intervalH: 24 }, 'Activo');
}

export function stopPurger() {
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
  if (purgeTimer) { clearInterval(purgeTimer); purgeTimer = null; }
  log.info('Detenido');
}
