import crypto from 'crypto';
import { eq, sql, and, inArray } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { laftListEntries, laftRestrictiveLists } from '../../../db/schema.js';
import { normalizeName, normalizeDoc } from '../match.service.js';
import { downloadWithGuards } from './downloader.js';
import { extractXmlBlocks, getXmlText, getXmlAllTexts } from './parsers.js';
import type { SyncResult } from './ofac.loader.js';
import { loggerFor } from '../../../shared/logger.js';

const log = loggerFor('laft-un-loader');

const UN_CONSOLIDATED_URL = 'https://scsanctions.un.org/resources/xml/en/consolidated.xml';

function isAllowedUnHost(host: string): boolean {
  return host === 'scsanctions.un.org' || host.endsWith('.un.org');
}

interface UnEntry {
  source_id: string;
  full_name: string;
  aliases: string[];
  doc_number: string | null;
  country: string | null;
  birth_date: string | null;
  remarks: string | null;
}

/**
 * Parse de consolidated.xml UN. Estructura:
 *   <CONSOLIDATED_LIST>
 *     <INDIVIDUALS>
 *       <INDIVIDUAL>
 *         <DATAID>...</DATAID>
 *         <FIRST_NAME>...</FIRST_NAME>
 *         <SECOND_NAME>...</SECOND_NAME>
 *         <THIRD_NAME>...</THIRD_NAME>
 *         <NATIONALITY><VALUE>...</VALUE></NATIONALITY>
 *         <INDIVIDUAL_ALIAS><ALIAS_NAME>...</ALIAS_NAME></INDIVIDUAL_ALIAS>
 *         <INDIVIDUAL_DOCUMENT>
 *            <TYPE_OF_DOCUMENT>...</TYPE_OF_DOCUMENT>
 *            <NUMBER>...</NUMBER>
 *         </INDIVIDUAL_DOCUMENT>
 *         <INDIVIDUAL_DATE_OF_BIRTH><DATE>...</DATE></INDIVIDUAL_DATE_OF_BIRTH>
 *       </INDIVIDUAL>
 *     </INDIVIDUALS>
 *     <ENTITIES><ENTITY>...</ENTITY></ENTITIES>
 *   </CONSOLIDATED_LIST>
 */
function parseUnIndividuals(xml: string): UnEntry[] {
  const blocks = extractXmlBlocks(xml, 'INDIVIDUAL');
  const out: UnEntry[] = [];
  for (const b of blocks) {
    const dataId = getXmlText(b, 'DATAID');
    if (!dataId) continue;
    const first = getXmlText(b, 'FIRST_NAME') ?? '';
    const second = getXmlText(b, 'SECOND_NAME') ?? '';
    const third = getXmlText(b, 'THIRD_NAME') ?? '';
    const fourth = getXmlText(b, 'FOURTH_NAME') ?? '';
    const fullName = [first, second, third, fourth].filter(Boolean).join(' ').trim();
    if (!fullName) continue;

    const aliasBlocks = extractXmlBlocks(b, 'INDIVIDUAL_ALIAS');
    const aliases = aliasBlocks
      .map((ab) => getXmlText(ab, 'ALIAS_NAME'))
      .filter((s): s is string => Boolean(s && s.length > 0));

    const docBlocks = extractXmlBlocks(b, 'INDIVIDUAL_DOCUMENT');
    const docNumber = docBlocks.length > 0 ? getXmlText(docBlocks[0], 'NUMBER') : null;

    const dobBlocks = extractXmlBlocks(b, 'INDIVIDUAL_DATE_OF_BIRTH');
    const birth = dobBlocks.length > 0 ? getXmlText(dobBlocks[0], 'DATE') : null;

    const natBlocks = extractXmlBlocks(b, 'NATIONALITY');
    const country = natBlocks.length > 0 ? getXmlAllTexts(natBlocks[0], 'VALUE').join(', ') || null : null;

    out.push({
      source_id: `IND-${dataId}`,
      full_name: fullName,
      aliases,
      doc_number: docNumber,
      country,
      birth_date: birth,
      remarks: getXmlText(b, 'COMMENTS1') ?? null,
    });
  }
  return out;
}

function parseUnEntities(xml: string): UnEntry[] {
  const blocks = extractXmlBlocks(xml, 'ENTITY');
  const out: UnEntry[] = [];
  for (const b of blocks) {
    const dataId = getXmlText(b, 'DATAID');
    if (!dataId) continue;
    const fullName = getXmlText(b, 'FIRST_NAME') ?? '';
    if (!fullName) continue;

    const aliasBlocks = extractXmlBlocks(b, 'ENTITY_ALIAS');
    const aliases = aliasBlocks
      .map((ab) => getXmlText(ab, 'ALIAS_NAME'))
      .filter((s): s is string => Boolean(s && s.length > 0));

    const addrBlocks = extractXmlBlocks(b, 'ENTITY_ADDRESS');
    const country = addrBlocks.length > 0 ? getXmlText(addrBlocks[0], 'COUNTRY') : null;

    out.push({
      source_id: `ENT-${dataId}`,
      full_name: fullName,
      aliases,
      doc_number: null,
      country,
      birth_date: null,
      remarks: getXmlText(b, 'COMMENTS1') ?? null,
    });
  }
  return out;
}

export async function syncUnConsolidated(): Promise<SyncResult> {
  const start = Date.now();

  const [list] = await db.select().from(laftRestrictiveLists).where(eq(laftRestrictiveLists.code, 'UN'));
  if (!list) throw new Error('Lista UN no encontrada — aplicar migración 0012 primero');

  const xml = await downloadWithGuards(UN_CONSOLIDATED_URL, {
    allowedHostMatcher: isAllowedUnHost,
    maxBytes: 50 * 1024 * 1024,
    acceptHeader: 'application/xml,text/xml',
  });

  const rows: UnEntry[] = [...parseUnIndividuals(xml), ...parseUnEntities(xml)];

  let inserted = 0;
  let errors = 0;
  const BATCH = 500;

  // Transacción atómica — si algún batch falla, rollback total (lista vacía o intacta, nunca a medias).
  try {
    await db.transaction(async (tx) => {
      for (let i = 0; i < rows.length; i += BATCH) {
        const slice = rows.slice(i, i + BATCH);
        const values = slice.map((r) => ({
          listId: list.id,
          fullName: r.full_name.slice(0, 500),
          fullNameNorm: normalizeName(r.full_name).slice(0, 500),
          aliases: r.aliases.length > 0 ? r.aliases.slice(0, 30) : null,
          docType: null,
          docNumber: normalizeDoc(r.doc_number) || null,
          country: r.country?.slice(0, 80) ?? null,
          birthDate: r.birth_date?.slice(0, 20) ?? null,
          remarks: r.remarks?.slice(0, 1000) ?? null,
          sourceId: r.source_id,
          sourceHash: crypto.createHash('sha1').update(`${r.full_name}|${r.doc_number ?? ''}|${r.aliases.join(',')}`).digest('hex').slice(0, 64),
        }));

        const sourceIds = slice.map((r) => r.source_id);
        await tx.delete(laftListEntries).where(and(eq(laftListEntries.listId, list.id), inArray(laftListEntries.sourceId, sourceIds)));
        const result = await tx.insert(laftListEntries).values(values).returning({ id: laftListEntries.id });
        inserted += result.length;
      }
    });
  } catch (e) {
    errors = 1;
    log.error({ err: e }, 'transacción abortada');
    throw new Error(`UN sync rollback: ${e instanceof Error ? e.message : 'error desconocido'}`);
  }

  const [countRow] = await db.select({ total: sql<number>`count(*)::int` }).from(laftListEntries).where(eq(laftListEntries.listId, list.id));
  await db.update(laftRestrictiveLists).set({
    lastSyncedAt: new Date(),
    totalEntries: countRow?.total ?? rows.length,
  }).where(eq(laftRestrictiveLists.id, list.id));

  return {
    listCode: 'UN',
    fetched: rows.length,
    inserted,
    updated: 0,
    errors,
    durationMs: Date.now() - start,
  };
}
