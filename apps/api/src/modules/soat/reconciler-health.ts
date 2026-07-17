// FLOTA-01 — Visibilidad ops del reconciler SOAT sin SSH.
//
// El reconciler (reconciler.ts) persiste su última corrida en `system_kv` bajo la
// clave `soat_reconciler:last_run`. Este módulo expone:
//   - `persistReconcilerRun`: lo invoca el reconciler al final de cada corrida.
//   - `getReconcilerHealth`: lo consume GET /api/health/soat-reconciler.
//
// NO cambia la lógica de reconciliación; solo registra/lee estado.

import { and, eq, or, isNull, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { systemKv, soatRequests } from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('soat-reconciler-health');

export const RECONCILER_KV_KEY = 'soat_reconciler:last_run';
/** Sin corrida en >4h con trabajo pendiente ⇒ stale. */
export const STALE_THRESHOLD_MS = 4 * 60 * 60 * 1000;

export interface ReconcilerRunStats {
  ok: number;
  pendientes: number;
  errores: number;
}

export interface ReconcilerRunRecord {
  finishedAt: string; // ISO
  durationMs: number;
  processed: number;
  stats: ReconcilerRunStats;
}

export interface ReconcilerHealth {
  status: 'ok' | 'stale' | 'unknown';
  lastRunAt: string | null;
  lastDurationMs: number | null;
  lastStats: ReconcilerRunStats | null;
  pendingCandidates: number;
  staleThresholdHours: number;
  timestamp: string;
}

/** Upsert de la última corrida. Best-effort: nunca rompe la reconciliación. */
export async function persistReconcilerRun(record: ReconcilerRunRecord): Promise<void> {
  try {
    await db.insert(systemKv)
      .values({ k: RECONCILER_KV_KEY, v: record, updatedAt: new Date() })
      .onConflictDoUpdate({ target: systemKv.k, set: { v: record, updatedAt: new Date() } });
  } catch (e: any) {
    log.warn({ err: e?.message }, 'no se pudo persistir estado del reconciler');
  }
}

/** Condición de candidato pendiente: comprado + placeholder de póliza. */
const PENDING_WHERE = and(
  eq(soatRequests.status, 'comprado'),
  or(
    isNull(soatRequests.policyNumber),
    eq(soatRequests.policyNumber, 'Pendiente'),
    eq(soatRequests.policyNumber, 'Pendiente verificación RUNT'),
    eq(soatRequests.policyNumber, 'Pendiente verificacion RUNT'),
  ),
);

/** Backlog actual: SOAT comprados aún con placeholder (lo que el reconciler retoma). */
export async function countPendingCandidates(): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(soatRequests).where(PENDING_WHERE);
  return row?.n ?? 0;
}

/** Lee el último registro persistido (o null si nunca corrió). */
async function readLastRun(): Promise<ReconcilerRunRecord | null> {
  const [row] = await db.select({ v: systemKv.v }).from(systemKv).where(eq(systemKv.k, RECONCILER_KV_KEY)).limit(1);
  return (row?.v as ReconcilerRunRecord | undefined) ?? null;
}

/**
 * Estado de salud del reconciler:
 *   - unknown: nunca registró una corrida (p.ej. deploy reciente).
 *   - stale:   >4h sin corrida Y hay candidatos pendientes.
 *   - ok:      corrida reciente, o sin candidatos pendientes.
 */
export async function getReconcilerHealth(): Promise<ReconcilerHealth> {
  const [last, pendingCandidates] = await Promise.all([readLastRun(), countPendingCandidates()]);
  const now = Date.now();

  let status: ReconcilerHealth['status'];
  if (!last) {
    status = 'unknown';
  } else {
    const ageMs = now - new Date(last.finishedAt).getTime();
    status = ageMs > STALE_THRESHOLD_MS && pendingCandidates > 0 ? 'stale' : 'ok';
  }

  return {
    status,
    lastRunAt: last?.finishedAt ?? null,
    lastDurationMs: last?.durationMs ?? null,
    lastStats: last?.stats ?? null,
    pendingCandidates,
    staleThresholdHours: STALE_THRESHOLD_MS / (60 * 60 * 1000),
    timestamp: new Date().toISOString(),
  };
}
