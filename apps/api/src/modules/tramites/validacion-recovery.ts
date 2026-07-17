// Recovery de locks `en_proceso` huérfanos (PM2 restart, timeout, caída mid-request).
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { tramitesValidaciones } from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('tramites.validacion-recovery');

/** Minutos sin completar antes de considerar el lock stale (deploy, crash, red). */
export const STALE_LOCK_MINUTES = 10;

/** Condición SQL: en_proceso sin fotos persistidas y lock vencido o legacy sin timestamp. */
export const staleLockSql = sql`(
  estado = 'en_proceso'
  AND foto_rostro IS NULL
  AND (
    procesando_desde IS NULL
    OR procesando_desde < NOW() - INTERVAL '10 minutes'
  )
)`;

const revertSet = {
  estado: 'enviado' as const,
  procesandoDesde: null,
  intentos: sql`GREATEST(intentos - 1, 0)`,
};

/** Libera lock stale de un token (antes de POST /completar). */
export async function recoverStaleByToken(token: string): Promise<number> {
  const recovered = await db.update(tramitesValidaciones).set(revertSet).where(and(
    eq(tramitesValidaciones.token, token),
    staleLockSql,
  )).returning({ id: tramitesValidaciones.id });
  if (recovered.length > 0) {
    log.warn({ validacionId: recovered[0].id, token: token.slice(0, 8) }, 'validación en_proceso recuperada (stale lock)');
  }
  return recovered.length;
}

/** Sweep global — invocado por cron cada 5 min en producción. */
export async function recoverAllStaleLocks(): Promise<number> {
  const recovered = await db.update(tramitesValidaciones).set(revertSet).where(staleLockSql).returning({ id: tramitesValidaciones.id });
  if (recovered.length > 0) {
    log.warn({ count: recovered.length, ids: recovered.map((r) => r.id) }, 'cron: locks en_proceso recuperados');
  }
  return recovered.length;
}

/** Cuenta locks activos (pre-deploy check). */
export async function countEnProceso(): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` })
    .from(tramitesValidaciones)
    .where(eq(tramitesValidaciones.estado, 'en_proceso'));
  return row?.n ?? 0;
}
