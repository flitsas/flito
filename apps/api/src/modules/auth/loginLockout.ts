import { getRedis } from '../../shared/redis.js';

// VUL-09: Account lockout distribuido (cluster-safe). Usa Redis si está disponible,
// fallback in-memory para dev. En cluster PM2, fallback in-memory permite bypass —
// REDIS DEBE ESTAR ACTIVO en producción.

const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_SEC = 15 * 60;   // 15 min: ventana de acumulación de fallos
// 3 min de bloqueo tras 5 fallos (Bug #12953: antes 30 min, excesivo; se fijó en 3 min por pedido
// del negocio, igual que la espera del `authLimiter`, para que ambos mensajes digan lo mismo). La
// ventana de acumulación se queda en 15 min a propósito: el contador se borra al bloquear, así
// que una ventana larga solo significa que los fallos espaciados también cuentan.
const LOCK_DURATION_SEC = 3 * 60;
const KEY_PREFIX = 'login';

const memFails = new Map<string, { count: number; expiresAt: number }>();
const memLocks = new Map<string, number>();

function failKey(u: string): string { return `${KEY_PREFIX}:fail:${u.toLowerCase()}`; }
function lockKey(u: string): string { return `${KEY_PREFIX}:lock:${u.toLowerCase()}`; }

function memCleanup(): void {
  const now = Date.now();
  for (const [k, v] of memFails) if (v.expiresAt < now) memFails.delete(k);
  for (const [k, until] of memLocks) if (until < now) memLocks.delete(k);
}

export interface LockoutStatus {
  locked: boolean;
  remainingMins?: number;
}

export async function checkLockout(username: string): Promise<LockoutStatus> {
  const r = getRedis();
  if (r) {
    try {
      const ttl = await r.ttl(lockKey(username));
      if (ttl > 0) return { locked: true, remainingMins: Math.ceil(ttl / 60) };
      return { locked: false };
    } catch {
      // si redis falla, cae a fallback in-memory.
    }
  }
  memCleanup();
  const until = memLocks.get(username.toLowerCase());
  if (until && until > Date.now()) {
    return { locked: true, remainingMins: Math.ceil((until - Date.now()) / 60_000) };
  }
  return { locked: false };
}

export async function registerFailed(username: string): Promise<void> {
  const u = username.toLowerCase();
  const r = getRedis();
  if (r) {
    try {
      const count = await r.incr(failKey(u));
      if (count === 1) await r.expire(failKey(u), ATTEMPT_WINDOW_SEC);
      if (count >= MAX_ATTEMPTS) {
        await r.set(lockKey(u), '1', 'EX', LOCK_DURATION_SEC);
        await r.del(failKey(u));
      }
      return;
    } catch {
      // fallback
    }
  }
  memCleanup();
  const now = Date.now();
  const cur = memFails.get(u);
  const next = cur && cur.expiresAt > now
    ? { count: cur.count + 1, expiresAt: cur.expiresAt }
    : { count: 1, expiresAt: now + ATTEMPT_WINDOW_SEC * 1000 };
  if (next.count >= MAX_ATTEMPTS) {
    memLocks.set(u, now + LOCK_DURATION_SEC * 1000);
    memFails.delete(u);
  } else {
    memFails.set(u, next);
  }
}

export async function clearLockout(username: string): Promise<void> {
  const u = username.toLowerCase();
  const r = getRedis();
  if (r) {
    try {
      await r.del(failKey(u), lockKey(u));
      return;
    } catch {
      // fallback
    }
  }
  memFails.delete(u);
  memLocks.delete(u);
}
