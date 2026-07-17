import { eq } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { laftEmployeesKyc } from '../../../db/schema.js';
import { loggerFor } from '../../../shared/logger.js';

const log = loggerFor('laft-auth-block');

// Cache en memoria con TTL 60s para no consultar BD en cada login.
// No usamos Redis aquí porque el dato es boolean por user y la latencia BD
// es similar a la de Redis (es una sola fila). Si en el futuro se requiere
// invalidación cross-instancia, switchear a Redis con el mismo contrato.

const TTL_MS = 60_000;

interface BlockEntry {
  blocked: boolean;
  reason?: string;
  expiresAt: number;
}

const cache = new Map<number, BlockEntry>();

export interface LaftBlockResult {
  blocked: boolean;
  reason?: string;
}

/**
 * Indica si el user tiene match en lista restrictiva (bloquea login).
 * Cache 60s; en el segundo llamado dentro de la ventana NO consulta BD.
 */
export async function isUserLaftBlocked(userId: number): Promise<LaftBlockResult> {
  // Igual que AUTH_SKIP_SESSION_INVAL_CHECK (auth.ts): en tests no consultamos BD
  // en el path de login. Evita dos fuentes de no-determinismo en la suite:
  //   (a) este lookup (await en auth.routes) consume un `selectMock` destinado al
  //       handler del test, y
  //   (b) el caché en memoria de abajo (TTL 60s sobre Date.now real) filtra estado
  //       `blocked` entre archivos de test que corren en el mismo worker fork.
  // El flag NUNCA se setea en producción → comportamiento productivo idéntico. El
  // test dedicado (laft.auth-block.test.ts) lo desactiva para ejercitar la lógica real.
  if (process.env.AUTH_SKIP_LAFT_BLOCK_CHECK === '1') return { blocked: false };

  const now = Date.now();
  const hit = cache.get(userId);
  if (hit && hit.expiresAt > now) {
    return hit.reason !== undefined
      ? { blocked: hit.blocked, reason: hit.reason }
      : { blocked: hit.blocked };
  }

  let result: LaftBlockResult = { blocked: false };
  try {
    const [row] = await db
      .select({
        matchBlocked: laftEmployeesKyc.matchBlocked,
        matchBlockedReason: laftEmployeesKyc.matchBlockedReason,
      })
      .from(laftEmployeesKyc)
      .where(eq(laftEmployeesKyc.userId, userId))
      .limit(1);

    if (row?.matchBlocked) {
      result = { blocked: true, reason: row.matchBlockedReason ?? undefined };
    }
  } catch (err) {
    // Fail-open: si BD falla NO bloqueamos al user (mismo principio que
    // session_invalidated_at: no convertir un outage de BD en cierre total).
    log.warn({ err: (err as Error)?.message, userId }, 'lookup falló — fail-open');
    return { blocked: false };
  }

  cache.set(userId, {
    blocked: result.blocked,
    reason: result.reason,
    expiresAt: now + TTL_MS,
  });
  return result;
}

/**
 * Invalida la entrada del caché para un user (llamar cuando se actualiza el KYC).
 */
export function invalidateLaftBlockCache(userId: number): void {
  cache.delete(userId);
}

/**
 * Limpia el caché completo (uso: tests o cuando hay un re-sync masivo).
 */
export function clearLaftBlockCache(): void {
  cache.clear();
}

// Sólo para tests: permite inspeccionar tamaño/expiración sin romper encapsulación.
export function _laftBlockCacheSnapshot(): Array<{ userId: number; blocked: boolean; expiresAt: number }> {
  return Array.from(cache.entries()).map(([userId, e]) => ({ userId, blocked: e.blocked, expiresAt: e.expiresAt }));
}
