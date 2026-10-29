// FLITO Logística — idempotencia de escrituras offline (HU #14108, ADR-0030 §11).

import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { flitoLogisticaIdempotencia } from '../../db/schema.js';

// ── Idempotencia de escrituras offline (RN-06/CA-06) ─────────────────────────

/** Respuesta ya emitida para una clave de idempotencia, o null si es la primera vez. */
export async function buscarIdempotencia(key: string): Promise<{ status: number; body: unknown } | null> {
  const [row] = await db.select({ status: flitoLogisticaIdempotencia.status, response: flitoLogisticaIdempotencia.response })
    .from(flitoLogisticaIdempotencia).where(eq(flitoLogisticaIdempotencia.idempotencyKey, key)).limit(1);
  return row ? { status: row.status, body: row.response } : null;
}

/** Guarda la respuesta de una escritura para deduplicar reenvíos. No pisa si ya existe. */
export async function guardarIdempotencia(key: string, status: number, body: unknown): Promise<void> {
  await db.insert(flitoLogisticaIdempotencia).values({ idempotencyKey: key, status, response: body }).onConflictDoNothing();
}
