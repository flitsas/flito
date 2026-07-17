// LAFT v2 F1 — orquestador de sync diario de listas restrictivas.
//
// Pattern: setInterval cada hora. Dispara los 3 fetchers (OFAC/UN/EU) cuando reloj UTC = 02:00.
// Por cada lista: advisory lock per-list-code (no bloquea las otras), fetch, calc hash, diff,
// retro-match. Cada lista se registra en laft_lists_sync_jobs como running → success/failed.
//
// Si un fetch falla (endpoint cambió, timeout, etc.), se registra el job como failed y se
// continúa con las siguientes listas — el cron no aborta.
//
// Idempotencia inter-instancia: withLock('laft-sync-OFAC', ...) garantiza que dos PM2 workers
// no pisen la misma lista simultáneamente. Si el lock no se adquiere (otra instancia activa),
// la corrida de esa lista se salta esa hora.

import os from 'os';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { laftRestrictiveLists, laftListsSyncJobs, laftAuditLog } from '../../../db/schema.js';
import { withLock } from '../../../shared/utils/lock.js';
import { loggerFor } from '../../../shared/logger.js';
import { fetchOfac } from './ofac.sync.js';
import { fetchUn } from './un.sync.js';
import { fetchEu } from './eu.sync.js';
import { applyDiff } from './diff.service.js';
import { runRetroMatch } from './retro-match.service.js';
import type { FetchResult, SyncJobOutcome } from './types.js';

const log = loggerFor('laft-sync-cron');
const HOST_ID = `${os.hostname()}-${process.pid}`;

const RUN_INTERVAL_MS = 60 * 60 * 1000; // 1h — chequea reloj y dispara solo a las 02:00 UTC
const TARGET_UTC_HOUR = 2;
const LOCK_TTL_MS = 60 * 60 * 1000; // 1h — ventana suficiente para un sync completo (UE puede tomar 2-3 min)

let timer: NodeJS.Timeout | null = null;

type ListCode = 'OFAC' | 'UN' | 'EU';
const FETCHERS: Record<ListCode, () => Promise<FetchResult | null>> = {
  OFAC: fetchOfac,
  UN: fetchUn,
  EU: fetchEu,
};

/** Inserta job 'running'. Devuelve id para cierre posterior. */
async function openJob(args: {
  listCode: ListCode;
  trigger: 'cron' | 'manual';
  triggeredBy?: number | null;
  sourceUrl?: string | null;
}): Promise<number> {
  const [row] = await db.insert(laftListsSyncJobs).values({
    listCode: args.listCode,
    trigger: args.trigger,
    triggeredBy: args.triggeredBy ?? null,
    status: 'running',
    sourceUrl: args.sourceUrl ?? null,
  }).returning({ id: laftListsSyncJobs.id });
  return row.id;
}

/** Cierra job (running → success/failed/skipped). El trigger BD permite UPDATE solo en running. */
async function closeJob(id: number, patch: {
  status: 'success' | 'failed' | 'skipped';
  sourceHash?: string | null;
  entriesTotal?: number | null;
  entriesAdded?: number | null;
  entriesRemoved?: number | null;
  entriesModified?: number | null;
  retroMatchesNew?: number | null;
  errorText?: string | null;
  durationMs: number;
}): Promise<void> {
  await db.update(laftListsSyncJobs).set({
    status: patch.status,
    finishedAt: new Date(),
    sourceHash: patch.sourceHash ?? null,
    entriesTotal: patch.entriesTotal ?? null,
    entriesAdded: patch.entriesAdded ?? null,
    entriesRemoved: patch.entriesRemoved ?? null,
    entriesModified: patch.entriesModified ?? null,
    retroMatchesNew: patch.retroMatchesNew ?? null,
    errorText: patch.errorText ?? null,
    durationMs: patch.durationMs,
  }).where(eq(laftListsSyncJobs.id, id));
}

async function audit(action: 'sync', listCode: string, before: unknown, after: unknown): Promise<void> {
  try {
    await db.insert(laftAuditLog).values({
      userId: null,
      userUsername: 'system-cron',
      action,
      resource: 'list_check',
      resourceId: listCode,
      beforeState: before as never,
      afterState: after as never,
      ipAddress: null,
      userAgent: HOST_ID.slice(0, 500),
    });
  } catch (e) {
    log.error({ err: (e as Error).message, listCode }, 'fallo audit insert');
  }
}

/**
 * Sincroniza una lista. Devuelve outcome con job id + estadísticas. NUNCA throws — los errores
 * se capturan, se registran en el job y se loggean. Esto permite que sync.cron continúe con
 * las otras listas aunque una falle.
 *
 * triggeredBy: null para cron, userId para endpoint manual.
 */
export async function syncOneList(args: {
  listCode: ListCode;
  trigger: 'cron' | 'manual';
  triggeredBy?: number | null;
}): Promise<SyncJobOutcome> {
  const start = Date.now();
  const lockName = `laft-sync-${args.listCode}`;

  const result = await withLock(lockName, LOCK_TTL_MS, async (): Promise<SyncJobOutcome> => {
    const [list] = await db.select().from(laftRestrictiveLists).where(eq(laftRestrictiveLists.code, args.listCode));
    if (!list) {
      const jobId = await openJob({ listCode: args.listCode, trigger: args.trigger, triggeredBy: args.triggeredBy });
      const durationMs = Date.now() - start;
      await closeJob(jobId, {
        status: 'failed',
        errorText: `Lista ${args.listCode} no existe en laft_restrictive_lists — aplicar mig 0012`,
        durationMs,
      });
      return { jobId, listCode: args.listCode, status: 'failed', added: 0, removed: 0, modified: 0, total: 0, retroMatches: 0, durationMs, errorText: 'lista no registrada' };
    }

    const fetcher = FETCHERS[args.listCode];
    const jobId = await openJob({ listCode: args.listCode, trigger: args.trigger, triggeredBy: args.triggeredBy, sourceUrl: list.sourceUrl });

    try {
      const fetched = await fetcher();
      if (!fetched) {
        const durationMs = Date.now() - start;
        await closeJob(jobId, { status: 'failed', errorText: 'fetch retornó null (endpoint changed/timeout/empty)', durationMs });
        await audit('sync', args.listCode, { jobId }, { status: 'failed', reason: 'fetch_null' });
        return { jobId, listCode: args.listCode, status: 'failed', added: 0, removed: 0, modified: 0, total: 0, retroMatches: 0, durationMs, errorText: 'fetch retornó null' };
      }

      // Skip si el hash es idéntico al último sync exitoso (lista no cambió desde ayer).
      // No-op syncs son normales — UN actualiza ~1x/semana.
      const [last] = await db.select({
        hash: laftListsSyncJobs.sourceHash,
      }).from(laftListsSyncJobs)
        .where(sql`list_code = ${args.listCode} AND status = 'success'`)
        .orderBy(sql`started_at DESC`).limit(1);

      if (last?.hash === fetched.sourceHash) {
        const durationMs = Date.now() - start;
        await closeJob(jobId, {
          status: 'skipped',
          sourceHash: fetched.sourceHash,
          entriesTotal: fetched.entries.length,
          entriesAdded: 0, entriesRemoved: 0, entriesModified: 0, retroMatchesNew: 0,
          durationMs,
        });
        return { jobId, listCode: args.listCode, status: 'skipped', added: 0, removed: 0, modified: 0, total: fetched.entries.length, retroMatches: 0, durationMs };
      }

      const diff = await applyDiff({ listId: list.id, listCode: args.listCode, entries: fetched.entries });

      const retro = await runRetroMatch({
        listId: list.id,
        listCode: args.listCode,
        listName: list.name,
        binding: list.binding,
        addedSourceIds: diff.addedSourceIds,
      });

      const durationMs = Date.now() - start;
      await closeJob(jobId, {
        status: 'success',
        sourceHash: fetched.sourceHash,
        entriesTotal: diff.total,
        entriesAdded: diff.added,
        entriesRemoved: diff.removed,
        entriesModified: diff.modified,
        retroMatchesNew: retro.newMatches,
        durationMs,
      });
      await audit('sync', args.listCode, null, {
        jobId, status: 'success',
        added: diff.added, removed: diff.removed, modified: diff.modified,
        total: diff.total, retroMatches: retro.newMatches, durationMs,
      });

      return {
        jobId, listCode: args.listCode, status: 'success',
        added: diff.added, removed: diff.removed, modified: diff.modified,
        total: diff.total, retroMatches: retro.newMatches, durationMs,
      };
    } catch (e) {
      const errorText = (e as Error).message?.slice(0, 1000) ?? 'unknown error';
      const durationMs = Date.now() - start;
      log.error({ err: errorText, listCode: args.listCode }, 'syncOneList exception');
      await closeJob(jobId, { status: 'failed', errorText, durationMs });
      await audit('sync', args.listCode, { jobId }, { status: 'failed', errorText });
      return { jobId, listCode: args.listCode, status: 'failed', added: 0, removed: 0, modified: 0, total: 0, retroMatches: 0, durationMs, errorText };
    }
  });

  if (!result) {
    // Lock no obtenido — otra instancia está corriendo el sync. No es error: registramos skipped.
    const durationMs = Date.now() - start;
    log.info({ listCode: args.listCode }, 'lock no obtenido — sync saltado (otra instancia activo)');
    return { jobId: 0, listCode: args.listCode, status: 'skipped', added: 0, removed: 0, modified: 0, total: 0, retroMatches: 0, durationMs };
  }
  return result;
}

async function runOnce(): Promise<void> {
  const now = new Date();
  if (now.getUTCHours() !== TARGET_UTC_HOUR) return;

  const codes: ListCode[] = ['OFAC', 'UN', 'EU'];
  for (const code of codes) {
    try {
      const r = await syncOneList({ listCode: code, trigger: 'cron', triggeredBy: null });
      log.info({ listCode: code, status: r.status, added: r.added, removed: r.removed, retro: r.retroMatches, durationMs: r.durationMs }, 'sync corrida cron');
    } catch (e) {
      log.error({ err: (e as Error).message, listCode: code }, 'syncOneList lanzó excepción inesperada');
    }
  }
}

export function startLaftSyncCron(): void {
  if (timer) return;
  log.info({ host: HOST_ID, intervalH: 1, targetUtc: TARGET_UTC_HOUR }, 'cron LAFT sync activo');
  // Primer chequeo en 5 min (ventana de gracia post-boot). Si no es 02:00, no hace nada.
  setTimeout(() => { runOnce().catch((e) => log.error({ err: (e as Error).message }, 'first runOnce throw')); }, 5 * 60_000).unref();
  timer = setInterval(() => {
    runOnce().catch((e) => log.error({ err: (e as Error).message }, 'runOnce throw'));
  }, RUN_INTERVAL_MS);
  timer.unref();
}

export function stopLaftSyncCron(): void {
  if (timer) { clearInterval(timer); timer = null; log.info('cron LAFT sync detenido'); }
}

export const _internal = { runOnce, openJob, closeJob, audit, FETCHERS, TARGET_UTC_HOUR };
