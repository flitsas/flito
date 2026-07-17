// LAFT v2 F1 — diff entre entries normalizados y los actuales en BD para una lista.
// Calcula added/removed/modified usando sourceId como key + sourceHash sha1 (legado consistente
// con loaders existentes) para detectar cambios materiales (nombre, doc, aliases).
//
// La aplicación es transaccional: o se aplican TODOS los cambios o ninguno (consistencia
// con compliance §11 — listas a medias son peor que no actualizar).

import crypto from 'crypto';
import { sql, eq, and, inArray, notInArray } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { laftListEntries, laftRestrictiveLists } from '../../../db/schema.js';
import { normalizeName, normalizeDoc } from '../match.service.js';
import type { NormalizedEntry, DiffStats } from './types.js';

function entryHash(e: NormalizedEntry): string {
  // SHA-1 corto (consistencia con ofac.loader/un.loader/eu.loader existentes), 64 chars max.
  return crypto.createHash('sha1')
    .update(`${e.fullName}|${e.docNumber ?? ''}|${(e.aliases ?? []).join(',')}`)
    .digest('hex')
    .slice(0, 64);
}

/**
 * Compara entries normalizados contra el estado actual de la lista y aplica el diff
 * en transacción. Retorna estadísticas sin tocar otras listas.
 *
 * Estrategia: leer todos los sourceId+sourceHash actuales (es liviano: solo 2 columnas, índice
 * existente idx_laft_le_source). Comparar en memoria. UPSERT por chunks. DELETE de removidos.
 */
export async function applyDiff(args: {
  listId: number;
  listCode: string;
  entries: NormalizedEntry[];
}): Promise<DiffStats> {
  const { listId, entries } = args;

  const existing = await db.select({
    id: laftListEntries.id,
    sourceId: laftListEntries.sourceId,
    sourceHash: laftListEntries.sourceHash,
  }).from(laftListEntries).where(eq(laftListEntries.listId, listId));

  const existingMap = new Map<string, { id: number; hash: string | null }>();
  for (const r of existing) {
    if (r.sourceId) existingMap.set(r.sourceId, { id: r.id, hash: r.sourceHash });
  }

  const incomingMap = new Map<string, NormalizedEntry>();
  for (const e of entries) incomingMap.set(e.sourceId, e);

  const added: NormalizedEntry[] = [];
  const modified: NormalizedEntry[] = [];
  const addedSourceIds: string[] = [];
  const modifiedSourceIds: string[] = [];

  for (const e of entries) {
    const hash = entryHash(e);
    const prev = existingMap.get(e.sourceId);
    if (!prev) {
      added.push(e);
      addedSourceIds.push(e.sourceId);
    } else if (prev.hash !== hash) {
      modified.push(e);
      modifiedSourceIds.push(e.sourceId);
    }
  }

  const removedSourceIds: string[] = [];
  for (const [sid] of existingMap) {
    if (!incomingMap.has(sid)) removedSourceIds.push(sid);
  }

  // BATCH 500 < 1664 (límite Postgres ROW expressions; postgres-js expande arrays JS
  // como (`$1, $2, ..., $N`) inline cuando se interpolan en sql tag).
  const BATCH = 500;

  await db.transaction(async (tx) => {
    // 1) DELETE removidos
    for (let i = 0; i < removedSourceIds.length; i += BATCH) {
      const slice = removedSourceIds.slice(i, i + BATCH);
      await tx.delete(laftListEntries).where(and(
        eq(laftListEntries.listId, listId),
        inArray(laftListEntries.sourceId, slice),
      ));
    }

    // 2) UPSERT (delete + insert) added + modified — mismo patrón que loaders existentes,
    // garantiza que columnas no-null queden bien y limpia hashes stale.
    const toUpsert = [...added, ...modified];
    for (let i = 0; i < toUpsert.length; i += BATCH) {
      const slice = toUpsert.slice(i, i + BATCH);
      const sourceIds = slice.map((s) => s.sourceId);
      await tx.delete(laftListEntries).where(and(
        eq(laftListEntries.listId, listId),
        inArray(laftListEntries.sourceId, sourceIds),
      ));
      const values = slice.map((e) => ({
        listId,
        fullName: e.fullName.slice(0, 500),
        fullNameNorm: normalizeName(e.fullName).slice(0, 500),
        aliases: e.aliases && e.aliases.length > 0 ? e.aliases.slice(0, 30) : null,
        // Schema limits: docType varchar(20), docNumber varchar(50), sourceId varchar(100).
        // UN puede meter descripciones largas (ej: "Central African Republic armed forces ...
        // Military identification number 911-...") en NUMBER del DOCUMENT que excede 50 chars.
        // En vez de truncar agresivo y perder info, normalizamos primero y luego truncamos.
        docType: e.docType?.slice(0, 20) ?? null,
        docNumber: (normalizeDoc(e.docNumber) || null)?.slice(0, 50) ?? null,
        country: e.country?.slice(0, 80) ?? null,
        birthDate: e.birthDate?.slice(0, 20) ?? null,
        remarks: e.remarks?.slice(0, 1000) ?? null,
        sourceId: e.sourceId.slice(0, 100),
        sourceHash: entryHash(e),
      }));
      await tx.insert(laftListEntries).values(values);
    }

    // 3) Update last_synced_at + total
    const [countRow] = await tx.select({ total: sql<number>`count(*)::int` })
      .from(laftListEntries).where(eq(laftListEntries.listId, listId));
    await tx.update(laftRestrictiveLists).set({
      lastSyncedAt: new Date(),
      totalEntries: countRow?.total ?? 0,
    }).where(eq(laftRestrictiveLists.id, listId));
  });

  return {
    added: added.length,
    removed: removedSourceIds.length,
    modified: modified.length,
    total: entries.length,
    addedSourceIds,
    modifiedSourceIds,
  };
}

// Pure helper exportado para tests unitarios (no usa BD).
export function _computeDiff(args: {
  existing: Array<{ sourceId: string | null; sourceHash: string | null }>;
  entries: NormalizedEntry[];
}): { added: string[]; removed: string[]; modified: string[] } {
  const existingMap = new Map<string, string | null>();
  for (const r of args.existing) {
    if (r.sourceId) existingMap.set(r.sourceId, r.sourceHash);
  }
  const incomingMap = new Map<string, NormalizedEntry>();
  for (const e of args.entries) incomingMap.set(e.sourceId, e);

  const added: string[] = [];
  const modified: string[] = [];
  for (const e of args.entries) {
    const prev = existingMap.get(e.sourceId);
    if (prev === undefined) added.push(e.sourceId);
    else if (prev !== entryHash(e)) modified.push(e.sourceId);
  }
  const removed: string[] = [];
  for (const [sid] of existingMap) if (!incomingMap.has(sid)) removed.push(sid);
  return { added, removed, modified };
}

export const _internal = { entryHash };
