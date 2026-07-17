import { and, eq, lt, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { systemLocks } from '../../db/schema.js';
import os from 'os';
import { loggerFor } from '../logger.js';

const log = loggerFor('lock');

// Lock distribuido sobre la tabla system_locks.
// Atomicidad: un único statement INSERT ... ON CONFLICT DO UPDATE WHERE expired
// → garantiza que solo UN proceso adquiere el lock cuando hay carrera.
// TTL obligatorio: si el dueño cae sin liberar, otro proceso lo toma cuando expira.

const hostId = `${os.hostname()}-${process.pid}`;

export async function acquireLock(name: string, ttlMs: number): Promise<boolean> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);

  // UPSERT atómico:
  // - Si no existe el lock → INSERT exitoso, returning row.
  // - Si existe pero expiró → UPDATE solo si WHERE expires_at < NOW(), returning row.
  // - Si existe vigente → ON CONFLICT no aplica WHERE → returning vacío.
  // Postgres garantiza atomicidad del statement: dos procesos concurrentes NO pueden ganar.
  const result = await db.insert(systemLocks).values({
    lockName: name,
    acquiredAt: now,
    acquiredBy: hostId,
    expiresAt,
  }).onConflictDoUpdate({
    target: systemLocks.lockName,
    set: { acquiredAt: now, acquiredBy: hostId, expiresAt },
    where: lt(systemLocks.expiresAt, sql`NOW()`),
  }).returning({ acquiredBy: systemLocks.acquiredBy });

  // result.length > 0 significa que ganamos (insert exitoso o update aplicó por expiración).
  return result.length > 0;
}

export async function releaseLock(name: string): Promise<void> {
  try {
    await db.delete(systemLocks).where(and(
      eq(systemLocks.lockName, name),
      eq(systemLocks.acquiredBy, hostId),
    ));
  } catch (e: any) {
    log.error({ name, err: e?.message }, 'release falló');
  }
}

export async function withLock<T>(name: string, ttlMs: number, fn: () => Promise<T>): Promise<T | null> {
  const got = await acquireLock(name, ttlMs);
  if (!got) return null;
  try {
    return await fn();
  } finally {
    await releaseLock(name);
  }
}
