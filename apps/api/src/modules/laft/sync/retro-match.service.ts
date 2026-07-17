// LAFT v2 F1 — retro-matching tras aplicar sync.
// Cuando una lista incorpora entries nuevos, recorremos las contrapartes vinculadas y, para
// cada match relevante (>=85 score) contra los entries añadidos, registramos:
//   1. INSERT en laft_list_checks (registro auditable §11)
//   2. INSERT en laft_unusual_operations con signal 'retro_match_<list_code>'
//   3. notification_outbox dirigido a admins/compliance (best-effort)
//
// IMPORTANTE: solo procesamos entries 'added' (no 'modified') para evitar inundación.
// Modified normalmente significa correcciones cosméticas (typos, fechas) y los entries
// previamente alineados ya generaron sus alertas históricas. Si más adelante se requiere
// re-evaluar modified, agregar un toggle env LAFT_RETRO_INCLUDE_MODIFIED=1.

import { eq, sql, and, inArray } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import {
  laftCounterparties, laftListEntries, laftListChecks,
  laftUnusualOperations, laftRestrictiveLists, notificationOutbox, users,
} from '../../../db/schema.js';
import { getAdminEmails } from '../../jornadas/notify.js';
import { loggerFor } from '../../../shared/logger.js';

const log = loggerFor('laft-retro-match');

interface RetroMatchInput {
  listId: number;
  listCode: string;
  listName: string;
  binding: boolean;
  /** sourceIds añadidos en este sync. Si vacío, retorna 0 inmediatamente. */
  addedSourceIds: string[];
}

/** Score mínimo para considerar match en retro-pass. Threshold productivo del módulo. */
const RETRO_MATCH_MIN_SCORE = 85;

/**
 * Postgres limita expresiones ROW a 1664 entries. Además, postgres-js cuando recibe
 * un JS array como parámetro lo serializa como `record` (tuple), no como `text[]`,
 * lo que rompe el cast `::text[]` con "cannot cast type record to text[]".
 *
 * Workaround: formatear el array como literal Postgres `{a,b,c}` y enviar como
 * texto. El cast server-side `::text[]` parsea el texto a array correctamente.
 * Aún así batchamos para mantener el JSON-string acotado.
 */
const RETRO_MATCH_BATCH = 1000;

/**
 * Convierte un array de strings a literal de array Postgres `{val1,val2,...}`.
 * Escapa comillas dobles y backslashes según la spec de array literals de PG.
 */
function toPgArrayLiteral(values: string[]): string {
  const escaped = values.map((v) => {
    const safe = String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${safe}"`;
  });
  return `{${escaped.join(',')}}`;
}

interface RetroCandidate {
  cp_id: number;
  cp_full_name: string;
  cp_doc_number: string;
  entry_id: number;
  entry_full_name: string;
  entry_doc_number: string | null;
  score: number;
  kind: string;
}

async function fetchCandidatesForBatch(listId: number, sourceIdsBatch: string[]): Promise<RetroCandidate[]> {
  const literal = toPgArrayLiteral(sourceIdsBatch);
  const rows = await db.execute<Record<string, unknown>>(sql`
    WITH new_entries AS (
      SELECT id, full_name, full_name_norm, doc_number
        FROM laft_list_entries
       WHERE list_id = ${listId}
         AND source_id = ANY(${literal}::text[])
    )
    SELECT
      cp.id AS cp_id,
      cp.full_name AS cp_full_name,
      cp.doc_number AS cp_doc_number,
      ne.id AS entry_id,
      ne.full_name AS entry_full_name,
      ne.doc_number AS entry_doc_number,
      CASE
        WHEN ne.doc_number IS NOT NULL AND ne.doc_number <> ''
             AND regexp_replace(upper(cp.doc_number), '[^A-Z0-9]', '', 'g') = ne.doc_number
          THEN 100
        ELSE round(similarity(
          ne.full_name_norm,
          regexp_replace(upper(unaccent(cp.full_name)), '[^A-Z0-9 ]', ' ', 'g')
        ) * 100)::int
      END AS score,
      CASE
        WHEN ne.doc_number IS NOT NULL AND ne.doc_number <> ''
             AND regexp_replace(upper(cp.doc_number), '[^A-Z0-9]', '', 'g') = ne.doc_number
          THEN 'doc_exact'
        WHEN similarity(
          ne.full_name_norm,
          regexp_replace(upper(unaccent(cp.full_name)), '[^A-Z0-9 ]', ' ', 'g')
        ) >= 0.85 THEN 'name_strong'
        ELSE 'no_match'
      END AS kind
    FROM laft_counterparties cp
    CROSS JOIN new_entries ne
    WHERE cp.status = 'vinculada'
      AND (
        (ne.doc_number IS NOT NULL AND ne.doc_number <> ''
         AND regexp_replace(upper(cp.doc_number), '[^A-Z0-9]', '', 'g') = ne.doc_number)
        OR ne.full_name_norm % regexp_replace(upper(unaccent(cp.full_name)), '[^A-Z0-9 ]', ' ', 'g')
      )
  `);

  return ((rows as { rows?: unknown[] } & Iterable<unknown>).rows
    ? (rows as unknown as { rows: Array<Record<string, unknown>> }).rows
    : Array.from(rows as Iterable<Record<string, unknown>>)
  ).map((r): RetroCandidate => ({
    cp_id: Number(r.cp_id),
    cp_full_name: String(r.cp_full_name),
    cp_doc_number: String(r.cp_doc_number),
    entry_id: Number(r.entry_id),
    entry_full_name: String(r.entry_full_name),
    entry_doc_number: r.entry_doc_number != null ? String(r.entry_doc_number) : null,
    score: Number(r.score) || 0,
    kind: String(r.kind),
  }));
}

export async function runRetroMatch(input: RetroMatchInput): Promise<{ newMatches: number }> {
  if (input.addedSourceIds.length === 0) return { newMatches: 0 };

  // Cruza counterparties vinculadas × new_entries con similarity pg_trgm + match exacto doc.
  // Batched para evitar el limit de 1664 en row constructors.
  const candidates: RetroCandidate[] = [];
  for (let i = 0; i < input.addedSourceIds.length; i += RETRO_MATCH_BATCH) {
    const batch = input.addedSourceIds.slice(i, i + RETRO_MATCH_BATCH);
    const part = await fetchCandidatesForBatch(input.listId, batch);
    candidates.push(...part);
  }

  const filtered = candidates.filter((c) => c.score >= RETRO_MATCH_MIN_SCORE && c.kind !== 'no_match');

  if (filtered.length === 0) {
    log.info({ listCode: input.listCode, addedCount: input.addedSourceIds.length }, 'retro-match: 0 nuevos hits');
    return { newMatches: 0 };
  }

  // Una unusual_operation por contraparte (consolidamos hits múltiples del mismo sync para
  // no spamear). El check va por hit individual.
  const byCp = new Map<number, typeof filtered>();
  for (const c of filtered) {
    const arr = byCp.get(c.cp_id) ?? [];
    arr.push(c);
    byCp.set(c.cp_id, arr);
  }

  let newMatches = 0;
  await db.transaction(async (tx) => {
    for (const c of filtered) {
      await tx.insert(laftListChecks).values({
        counterpartyId: c.cp_id,
        listId: input.listId,
        queryDoc: c.cp_doc_number,
        queryNameNorm: c.cp_full_name.slice(0, 500),
        matchEntryId: c.entry_id,
        matchScore: c.score,
        matchKind: c.kind,
        evidence: {
          source: 'retro_match',
          listCode: input.listCode,
          listName: input.listName,
          binding: input.binding,
          entryName: c.entry_full_name,
          entryDoc: c.entry_doc_number,
        },
        checkedBy: null,
      });
    }

    for (const [cpId, hits] of byCp) {
      const top = hits.reduce((a, b) => (a.score >= b.score ? a : b));
      const description =
        `Retro-matching automático tras sync de lista ${input.listCode}. ` +
        `Coincidencia ${top.kind} con score ${top.score} contra "${top.entry_full_name}". ` +
        `Total hits en este sync para esta contraparte: ${hits.length}.`;
      await tx.insert(laftUnusualOperations).values({
        counterpartyId: cpId,
        detectedBy: null,
        source: 'retro_match_sync',
        signals: [`retro_match_${input.listCode}`, `score_${top.score}`, `kind_${top.kind}`],
        amount: null,
        currency: 'COP',
        description,
      });
      newMatches++;
    }
  });

  // Notificación outbox best-effort. Si falla, NO rollback el retro-match (hits ya quedan en BD).
  try {
    const dest = await getAdminEmails();
    if (dest.length > 0) {
      const items = [...byCp.entries()].slice(0, 50).map(([cpId, hits]) => {
        const top = hits.reduce((a, b) => (a.score >= b.score ? a : b));
        return `<li>Contraparte #${cpId} — ${top.kind} score ${top.score} con <strong>${top.entry_full_name}</strong></li>`;
      }).join('');
      await db.insert(notificationOutbox).values({
        canal: 'email',
        destinatarios: JSON.stringify(dest),
        asunto: `LAFT — ${newMatches} contraparte(s) con retro-match en sync ${input.listCode}`,
        cuerpoHtml: `<h3>Retro-matching tras sincronización ${input.listName}</h3>` +
          `<p>Se incorporaron ${input.addedSourceIds.length} entradas nuevas. ${newMatches} contraparte(s) vinculada(s) generaron coincidencia (score ≥ ${RETRO_MATCH_MIN_SCORE}).</p>` +
          `<ul>${items}</ul>` +
          `<p>Acción: revisar módulo LAFT → Operaciones inusuales para análisis y decisión.</p>`,
        cuerpoTexto: `LAFT retro-match ${input.listCode}: ${newMatches} contraparte(s) afectada(s).`,
        contextoTipo: 'laft_retro_match_sync',
      });
    }
  } catch (e) {
    log.error({ err: (e as Error).message, listCode: input.listCode }, 'fallo encolar notificación retro-match');
  }

  return { newMatches };
}

export const _internal = { RETRO_MATCH_MIN_SCORE, RETRO_MATCH_BATCH, toPgArrayLiteral };
