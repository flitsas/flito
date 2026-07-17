import { Redis } from 'ioredis';
import { loggerFor } from './logger.js';

const log = loggerFor('redis');

// Cliente Redis compartido para blacklist de JWT, rate limiting distribuido y otros usos.
// Si Redis no está disponible al boot, cliente queda en estado lazy y los consumidores deben
// fallar hacia un fallback in-memory (para entornos dev sin Redis).

let client: Redis | null = null;
let connectAttempted = false;

export function getRedis(): Redis | null {
  if (!connectAttempted) {
    connectAttempted = true;
    try {
      const url = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
      const c: Redis = new Redis(url, {
        lazyConnect: false,
        maxRetriesPerRequest: 2,
        connectTimeout: 5_000,
        retryStrategy: (times: number) => (times > 5 ? null : Math.min(times * 200, 2000)),
      });
      c.on('error', (err: Error) => {
        log.warn({ err: err.message }, 'connection error');
      });
      c.on('connect', () => log.info('conectado'));
      client = c;
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'no disponible, usando fallbacks in-memory');
      client = null;
    }
  }
  return client;
}

/** Cierra el cliente Redis (para shutdown limpio). */
export async function closeRedis(): Promise<void> {
  if (client) {
    try { await client.quit(); } catch { /* ignore */ }
    client = null;
    connectAttempted = false;
  }
}

/** Health check: true si Redis responde a PING. */
export async function redisHealthy(): Promise<boolean> {
  const r = getRedis();
  if (!r) return false;
  try {
    const pong = await r.ping();
    return pong === 'PONG';
  } catch {
    return false;
  }
}
