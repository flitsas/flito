import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { laftListEntries, laftRestrictiveLists } from '../../db/schema.js';

// Normaliza nombre/documento para match: sin tildes, mayúsculas, sin caracteres no alfanuméricos.
// Para nombres compactamos espacios; para documentos eliminamos guiones y puntos.
export function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeDoc(s: string | null | undefined): string {
  if (!s) return '';
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export type MatchKind = 'doc_exact' | 'name_strong' | 'name_partial' | 'no_match';

export interface MatchResult {
  listId: number;
  listCode: string;
  listName: string;
  binding: boolean;
  score: number;
  kind: MatchKind;
  entryId: number | null;
  entryName: string | null;
  entryDoc: string | null;
}

/**
 * Para cada lista activa, busca el mejor match de la contraparte.
 * - Match exacto por documento → score 100, kind 'doc_exact'
 * - Match fuzzy por nombre con pg_trgm similarity → score = round(similarity * 100)
 * - kind 'name_strong' si score >= 85; 'name_partial' si 60-84; 'no_match' si < 60
 *
 * Retorna un resultado por lista (siempre), ordenado por score desc.
 */
export async function checkAllLists(args: {
  docNumber: string;
  fullName: string;
}): Promise<MatchResult[]> {
  const docNorm = normalizeDoc(args.docNumber);
  const nameNorm = normalizeName(args.fullName);

  if (!nameNorm || nameNorm.length < 2) return [];

  // Una sola query: por cada lista activa, calcula el mejor score (max de doc-exact y name-similarity)
  // y trae los datos del entry ganador. Usamos LATERAL para "best match per list".
  const rows = await db.execute<{
    list_id: number;
    list_code: string;
    list_name: string;
    binding: boolean;
    entry_id: number | null;
    entry_full_name: string | null;
    entry_doc_number: string | null;
    score: number;
    kind: MatchKind;
  }>(sql`
    SELECT
      l.id AS list_id,
      l.code AS list_code,
      l.name AS list_name,
      l.binding,
      best.entry_id,
      best.entry_full_name,
      best.entry_doc_number,
      COALESCE(best.score, 0)::int AS score,
      COALESCE(best.kind, 'no_match') AS kind
    FROM laft_restrictive_lists l
    LEFT JOIN LATERAL (
      SELECT
        e.id AS entry_id,
        e.full_name AS entry_full_name,
        e.doc_number AS entry_doc_number,
        CASE
          WHEN ${docNorm} <> '' AND e.doc_number = ${docNorm} THEN 100
          ELSE round(similarity(e.full_name_norm, ${nameNorm}) * 100)::int
        END AS score,
        CASE
          WHEN ${docNorm} <> '' AND e.doc_number = ${docNorm} THEN 'doc_exact'::text
          WHEN similarity(e.full_name_norm, ${nameNorm}) >= 0.85 THEN 'name_strong'::text
          WHEN similarity(e.full_name_norm, ${nameNorm}) >= 0.60 THEN 'name_partial'::text
          ELSE 'no_match'::text
        END AS kind
      FROM laft_list_entries e
      WHERE e.list_id = l.id
        AND (
          (${docNorm} <> '' AND e.doc_number = ${docNorm})
          OR e.full_name_norm % ${nameNorm}
        )
      ORDER BY score DESC NULLS LAST
      LIMIT 1
    ) best ON TRUE
    WHERE l.active = TRUE
    ORDER BY l.binding DESC, score DESC
  `);

  return (rows as { rows?: unknown[] } & Iterable<unknown>).rows
    ? // node-postgres-driver result wrapper
      ((rows as unknown as { rows: Array<Record<string, unknown>> }).rows.map(mapRow))
    : Array.from(rows as Iterable<Record<string, unknown>>).map(mapRow);
}

function mapRow(r: Record<string, unknown>): MatchResult {
  return {
    listId: Number(r.list_id),
    listCode: String(r.list_code),
    listName: String(r.list_name),
    binding: Boolean(r.binding),
    score: Number(r.score) || 0,
    kind: (r.kind as MatchKind) || 'no_match',
    entryId: r.entry_id != null ? Number(r.entry_id) : null,
    entryName: r.entry_full_name != null ? String(r.entry_full_name) : null,
    entryDoc: r.entry_doc_number != null ? String(r.entry_doc_number) : null,
  };
}

/**
 * Decisión de bloqueo automático según política:
 * - Match doc_exact en lista vinculante → bloquear automáticamente
 * - Match name_strong (≥85) en lista vinculante → marcar para revisión humana (status pendiente, alerta)
 * - Match en lista de referencia → DD intensificada, no bloqueo
 */
export interface BlockingDecision {
  shouldBlock: boolean;
  reason: string | null;
  needsReview: boolean;
  bindingMatches: MatchResult[];
}

export function decideFromMatches(matches: MatchResult[]): BlockingDecision {
  const bindingHits = matches.filter((m) => m.binding && m.score >= 85);

  const docExactBinding = bindingHits.find((m) => m.kind === 'doc_exact');
  if (docExactBinding) {
    return {
      shouldBlock: true,
      reason: `Coincidencia exacta de documento en ${docExactBinding.listName}`,
      needsReview: false,
      bindingMatches: bindingHits,
    };
  }
  if (bindingHits.length > 0) {
    return {
      shouldBlock: false,
      reason: `Posible coincidencia en lista vinculante (${bindingHits.map((m) => m.listCode).join(', ')}) — requiere revisión humana`,
      needsReview: true,
      bindingMatches: bindingHits,
    };
  }
  return { shouldBlock: false, reason: null, needsReview: false, bindingMatches: [] };
}

/** Helper: conteo de entries por lista (para mostrar en UI). */
export async function getListsWithCounts(): Promise<Array<{ id: number; code: string; name: string; binding: boolean; totalEntries: number; lastSyncedAt: Date | null; active: boolean }>> {
  const rows = await db.select({
    id: laftRestrictiveLists.id,
    code: laftRestrictiveLists.code,
    name: laftRestrictiveLists.name,
    binding: laftRestrictiveLists.binding,
    totalEntries: laftRestrictiveLists.totalEntries,
    lastSyncedAt: laftRestrictiveLists.lastSyncedAt,
    active: laftRestrictiveLists.active,
  }).from(laftRestrictiveLists).orderBy(laftRestrictiveLists.binding, laftRestrictiveLists.code);
  return rows.map((r) => ({ ...r, lastSyncedAt: r.lastSyncedAt as Date | null }));
}

