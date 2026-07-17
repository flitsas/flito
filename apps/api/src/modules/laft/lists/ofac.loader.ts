import crypto from 'crypto';
import { sql, eq, and, inArray } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { laftListEntries, laftRestrictiveLists } from '../../../db/schema.js';
import { normalizeName, normalizeDoc } from '../match.service.js';
import { downloadWithGuards } from './downloader.js';
import { parseCsvLine as basicParseCsvLine } from './parsers.js';
import { loggerFor } from '../../../shared/logger.js';

const log = loggerFor('laft-ofac-loader');

const OFAC_SDN_URL = 'https://www.treasury.gov/ofac/downloads/sdn.csv';

// Treasury.gov redirige al bucket público de OFAC en AWS GovCloud (us-gov-west-1).
function isAllowedOfacHost(host: string): boolean {
  if (host === 'www.treasury.gov' || host === 'treasury.gov') return true;
  if (host.endsWith('.treas.gov')) return true;
  if (host === 's3.us-gov-west-1.amazonaws.com') return true;
  if (host.endsWith('.s3.us-gov-west-1.amazonaws.com')) return true;
  return false;
}

interface SdnRow {
  source_id: string;
  full_name: string;
  type: string;
  doc_number: string | null;
  country: string | null;
  remarks: string | null;
}

// CSV de OFAC SDN: comma-quoted con un valor especial '-0-' para nulls. Adaptamos el parser
// genérico convirtiendo '-0-' a string vacío.
function parseCsvLine(line: string): string[] {
  return basicParseCsvLine(line).map((s) => s.replace(/^-0-$/, ''));
}

function parseSdnCsv(csv: string): SdnRow[] {
  const rows: SdnRow[] = [];
  const lines = csv.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = parseCsvLine(line);
    if (cols.length < 4) continue;
    const [entNum, sdnName, sdnType, , , , , , , , , remarks] = cols;
    if (!entNum || !sdnName) continue;
    rows.push({
      source_id: entNum,
      full_name: sdnName,
      type: sdnType || 'unknown',
      doc_number: null,
      country: null,
      remarks: remarks || null,
    });
  }
  return rows;
}

export interface SyncResult {
  listCode: string;
  fetched: number;
  inserted: number;
  updated: number;
  errors: number;
  durationMs: number;
}

export async function syncOfacSdn(): Promise<SyncResult> {
  const start = Date.now();

  const [list] = await db.select().from(laftRestrictiveLists).where(eq(laftRestrictiveLists.code, 'OFAC'));
  if (!list) throw new Error('Lista OFAC no encontrada — aplicar migración 0012 primero');

  const csv = await downloadWithGuards(OFAC_SDN_URL, {
    allowedHostMatcher: isAllowedOfacHost,
    maxBytes: 30 * 1024 * 1024, // 30MB; OFAC SDN actual ~10MB
  });
  const rows = parseSdnCsv(csv);

  let inserted = 0;
  const updated = 0;
  let errors = 0;

  // Procesamos en batches de 500 dentro de UNA transacción.
  // Si CUALQUIER batch falla, hacemos rollback total para no dejar la lista en estado parcial
  // (compliance §11: la lista debe estar completa o no estar — punto medio es peor que no actualizar).
  const BATCH = 500;
  try {
    await db.transaction(async (tx) => {
      for (let i = 0; i < rows.length; i += BATCH) {
        const slice = rows.slice(i, i + BATCH);
        const values = slice.map((r) => {
          const docNorm = normalizeDoc(r.doc_number);
          return {
            listId: list.id,
            fullName: r.full_name.slice(0, 500),
            fullNameNorm: normalizeName(r.full_name).slice(0, 500),
            aliases: null,
            docType: null,
            docNumber: docNorm || null,
            country: r.country,
            birthDate: null,
            remarks: r.remarks?.slice(0, 1000) ?? null,
            sourceId: r.source_id,
            sourceHash: crypto.createHash('sha1').update(`${r.full_name}|${r.doc_number ?? ''}`).digest('hex').slice(0, 64),
          };
        });

        const sourceIds = slice.map((r) => r.source_id);
        await tx.delete(laftListEntries).where(and(eq(laftListEntries.listId, list.id), inArray(laftListEntries.sourceId, sourceIds)));
        const result = await tx.insert(laftListEntries).values(values).returning({ id: laftListEntries.id });
        inserted += result.length;
      }
    });
  } catch (e) {
    errors = 1;
    log.error({ err: e }, 'transacción abortada');
    throw new Error(`OFAC sync rollback: ${e instanceof Error ? e.message : 'error desconocido'}`);
  }

  // Total de entries en la BD ahora
  const [countRow] = await db.select({ total: sql<number>`count(*)::int` }).from(laftListEntries).where(eq(laftListEntries.listId, list.id));
  await db.update(laftRestrictiveLists).set({
    lastSyncedAt: new Date(),
    totalEntries: countRow?.total ?? rows.length,
  }).where(eq(laftRestrictiveLists.id, list.id));

  return {
    listCode: 'OFAC',
    fetched: rows.length,
    inserted,
    updated,
    errors,
    durationMs: Date.now() - start,
  };
}
