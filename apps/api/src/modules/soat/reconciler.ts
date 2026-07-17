import { and, eq, or, isNull, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { soatRequests, vehicles, tramitesDigitales } from '../../db/schema.js';
import { refreshSoatFromRunt } from './refresh.service.js';
import { withLock } from '../../shared/utils/lock.js';
import { persistReconcilerRun } from './reconciler-health.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('soat-reconciler');

// Reconciliador automático: cada RECONCILER_INTERVAL_MS reintenta los SOAT en estado
// 'comprado' que aún tienen placeholder. Al indexarse en RUNT los transiciona a
// 'verificado'. El SOAT reported al RUNT puede tardar 24-72h hábiles en aparecer.

const RECONCILER_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3 horas
const RECONCILER_LOCK_TTL_MS = 30 * 60 * 1000; // 30 min — suficiente para batch 20 con RUNT lento
const BATCH_SIZE = 20;
const INTER_REQUEST_DELAY_MS = 1500; // no saturar el proxy CEA
const MAX_AGE_DAYS_TO_TRY = 10; // después de 10 días, dejar de reintentar automáticamente

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let startupTimer: ReturnType<typeof setTimeout> | null = null;
let intervalTimer: ReturnType<typeof setInterval> | null = null;

export function startReconciler() {
  startupTimer = setTimeout(() => { runReconciler().catch((e) => log.error({ err: e }, 'unhandled')); }, 5 * 60 * 1000);
  intervalTimer = setInterval(() => { runReconciler().catch((e) => log.error({ err: e }, 'unhandled')); }, RECONCILER_INTERVAL_MS);
  log.info({ intervalMin: RECONCILER_INTERVAL_MS / 60000, batch: BATCH_SIZE }, 'Activo');
}

export function stopReconciler() {
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
  if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null; }
  log.info('Detenido');
}

async function runReconciler() {
  const result = await withLock('soat-reconciler', RECONCILER_LOCK_TTL_MS, async () => {
    await runReconcilerInner();
    return true;
  });
  if (result === null) {
    log.info('Otro proceso ya está ejecutando la reconciliación — saltado');
  }
}

async function runReconcilerInner() {
  const t0 = Date.now();

  // Candidatos: status=comprado + policyNumber es placeholder + purchase/created no tan antiguo
  const candidates = await db.select({
    id: soatRequests.id,
    policyNumber: soatRequests.policyNumber,
    createdAt: soatRequests.createdAt,
    purchaseDate: soatRequests.purchaseDate,
    vehicleId: soatRequests.vehicleId,
    tramiteId: soatRequests.tramiteId,
    expiryDate: soatRequests.expiryDate,
  })
    .from(soatRequests)
    .where(and(
      eq(soatRequests.status, 'comprado'),
      or(
        isNull(soatRequests.policyNumber),
        eq(soatRequests.policyNumber, 'Pendiente'),
        eq(soatRequests.policyNumber, 'Pendiente verificación RUNT'),
        eq(soatRequests.policyNumber, 'Pendiente verificacion RUNT'),
      ),
      sql`${soatRequests.createdAt} > now() - interval '${sql.raw(String(MAX_AGE_DAYS_TO_TRY))} days'`,
    ))
    .orderBy(soatRequests.createdAt)
    .limit(BATCH_SIZE);

  let indexedCount = 0, notIndexedCount = 0, errorCount = 0;

  if (candidates.length > 0) {
  log.info({ count: candidates.length }, 'procesando SOAT pendientes');

  for (const c of candidates) {
    try {
      const r = await refreshSoatFromRunt(c.id, { triggeredBy: 'cron' });

      if (r.result === 'ok') {
        const hoy = new Date().toISOString().split('T')[0];
        if (r.expiryDate && r.expiryDate >= hoy) {
          try {
            await db.transaction(async (tx) => {
              const [u] = await tx.update(soatRequests).set({
                status: 'verificado', runtVerified: true, runtVerifiedAt: new Date(), updatedAt: new Date(),
              }).where(and(eq(soatRequests.id, c.id), eq(soatRequests.status, 'comprado'))).returning();
              if (!u) {
                // Race: estado cambió fuera de la transacción — no es error, registrar para forensics.
                log.warn({ soatId: c.id }, 'status changed externally — skipping auto-verify');
                return;
              }
              await tx.update(vehicles).set({ stage: 'soat_verificado', updatedAt: new Date() }).where(eq(vehicles.id, c.vehicleId));
              if (c.tramiteId) {
                await tx.update(tramitesDigitales).set({ estado: 'soat_verificado', updatedAt: new Date() }).where(eq(tramitesDigitales.id, c.tramiteId));
              }
            });
            indexedCount++;
            log.info({ soatId: c.id, policyNumber: r.policyNumber }, 'indexed + verified');
          } catch (txErr: any) {
            log.error({ soatId: c.id, err: txErr.message }, 'verify tx failed');
          }
        } else {
          log.info({ soatId: c.id, expiryDate: r.expiryDate }, 'indexed pero vencido — no se auto-verifica');
          indexedCount++;
        }
      } else if (r.result === 'not_indexed_yet' || r.result === 'owner_sync_pending') {
        notIndexedCount++;
      } else {
        errorCount++;
      }
    } catch (e: any) {
      errorCount++;
      log.error({ soatId: c.id, err: e.message }, 'soat refresh falló');
    }

    await sleep(INTER_REQUEST_DELAY_MS);
  }

  log.info({ durationMs: Date.now() - t0, ok: indexedCount, pendientes: notIndexedCount, errores: errorCount }, 'completado');
  }

  // FLOTA-01: persistir la corrida (incl. corridas sin candidatos) para el health
  // endpoint. Best-effort — no altera la lógica de reconciliación.
  await persistReconcilerRun({
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    processed: candidates.length,
    stats: { ok: indexedCount, pendientes: notIndexedCount, errores: errorCount },
  });
}
