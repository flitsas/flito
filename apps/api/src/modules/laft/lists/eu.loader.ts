import crypto from 'crypto';
import { eq, sql, and, inArray } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { laftListEntries, laftRestrictiveLists } from '../../../db/schema.js';
import { normalizeName, normalizeDoc } from '../match.service.js';
import { downloadWithGuards } from './downloader.js';
import { extractXmlBlocks, getXmlText, getXmlAllTexts } from './parsers.js';
import type { SyncResult } from './ofac.loader.js';
import { loggerFor } from '../../../shared/logger.js';

const log = loggerFor('laft-eu-loader');

const EU_CONSOLIDATED_URL = 'https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content';

function isAllowedEuHost(host: string): boolean {
  return host === 'webgate.ec.europa.eu' || host.endsWith('.europa.eu');
}

interface EuEntry {
  source_id: string;
  full_name: string;
  aliases: string[];
  doc_number: string | null;
  country: string | null;
  birth_date: string | null;
  remarks: string | null;
}

/**
 * Parse del XML consolidado de la UE. Estructura simplificada (la real es muy verbosa):
 *   <export>
 *     <sanctionEntity logicalId="...">
 *       <subjectType code="P" classificationCode="P"/>  (P=person, E=entity)
 *       <nameAlias firstName="..." lastName="..." wholeName="..." regulationLanguage="..."/>
 *       <identification ... number="..." identificationTypeCode="passport"/>
 *       <birthdate ... birthdate="YYYY-MM-DD"/>
 *       <citizenship countryDescription="..."/>
 *     </sanctionEntity>
 *   </export>
 *
 * Como los campos vienen como ATTRIBUTES (no texto), parseamos diferente.
 */
function parseEuEntities(xml: string): EuEntry[] {
  const blocks = extractXmlBlocks(xml, 'sanctionEntity');
  const out: EuEntry[] = [];

  for (const b of blocks) {
    const head = b.slice(0, 1500);
    const logicalId = matchAttr(head, 'logicalId') || matchAttr(head, 'euReferenceNumber') || matchAttr(head, 'designationDate');
    if (!logicalId) continue;

    const nameAliases = extractElementAttrs(b, 'nameAlias');
    const wholeNames = nameAliases.map((a) => a.wholeName || `${a.firstName ?? ''} ${a.lastName ?? ''}`.trim()).filter(Boolean);
    if (wholeNames.length === 0) continue;
    const fullName = wholeNames[0];
    const aliases = wholeNames.slice(1, 30);

    const ids = extractElementAttrs(b, 'identification');
    const docNumber = ids.find((i) => i.number)?.number ?? null;

    const birthdates = extractElementAttrs(b, 'birthdate');
    const birth = birthdates.find((bd) => bd.birthdate)?.birthdate ?? null;

    const citizenships = extractElementAttrs(b, 'citizenship');
    const country = citizenships.find((c) => c.countryDescription)?.countryDescription ?? null;

    const remarks = getXmlAllTexts(b, 'remark').slice(0, 3).join(' | ').slice(0, 1000) || null;

    out.push({
      source_id: `EU-${logicalId}`,
      full_name: fullName,
      aliases,
      doc_number: docNumber,
      country,
      birth_date: birth,
      remarks,
    });
  }
  return out;
}

// Extrae atributos de elementos self-closing tipo <nameAlias attr="val" />.
function extractElementAttrs(block: string, tagName: string): Record<string, string>[] {
  const re = new RegExp(`<${tagName}\\b([^>]*?)/>`, 'gi');
  const out: Record<string, string>[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    out.push(parseAttrs(m[1]));
  }
  // También elementos con cierre explícito
  const re2 = new RegExp(`<${tagName}\\b([^>]*?)>([\\s\\S]*?)</${tagName}>`, 'gi');
  while ((m = re2.exec(block)) !== null) {
    out.push(parseAttrs(m[1]));
  }
  return out;
}

function decodeAttr(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w:-]+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out[m[1]] = decodeAttr(m[2]);
  return out;
}

function matchAttr(s: string, name: string): string | null {
  const m = s.match(new RegExp(`${name}="([^"]+)"`, 'i'));
  return m ? m[1] : null;
}

export async function syncEuSanctions(): Promise<SyncResult> {
  const start = Date.now();

  const [list] = await db.select().from(laftRestrictiveLists).where(eq(laftRestrictiveLists.code, 'EU'));
  if (!list) throw new Error('Lista EU no encontrada — aplicar migración 0012 primero');

  const xml = await downloadWithGuards(EU_CONSOLIDATED_URL, {
    allowedHostMatcher: isAllowedEuHost,
    maxBytes: 80 * 1024 * 1024,
    acceptHeader: 'application/xml,text/xml',
    timeoutMs: 90_000,
  });

  const rows = parseEuEntities(xml);

  let inserted = 0;
  let errors = 0;
  const BATCH = 500;

  // Transacción atómica: todo el sync o ninguno (compliance §11).
  try {
    await db.transaction(async (tx) => {
      for (let i = 0; i < rows.length; i += BATCH) {
        const slice = rows.slice(i, i + BATCH);
        const values = slice.map((r) => ({
          listId: list.id,
          fullName: r.full_name.slice(0, 500),
          fullNameNorm: normalizeName(r.full_name).slice(0, 500),
          aliases: r.aliases.length > 0 ? r.aliases : null,
          docType: null,
          docNumber: normalizeDoc(r.doc_number) || null,
          country: r.country?.slice(0, 80) ?? null,
          birthDate: r.birth_date?.slice(0, 20) ?? null,
          remarks: r.remarks?.slice(0, 1000) ?? null,
          sourceId: r.source_id,
          sourceHash: crypto.createHash('sha1').update(`${r.full_name}|${r.doc_number ?? ''}`).digest('hex').slice(0, 64),
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
    throw new Error(`EU sync rollback: ${e instanceof Error ? e.message : 'error desconocido'}`);
  }

  const [countRow] = await db.select({ total: sql<number>`count(*)::int` }).from(laftListEntries).where(eq(laftListEntries.listId, list.id));
  await db.update(laftRestrictiveLists).set({
    lastSyncedAt: new Date(),
    totalEntries: countRow?.total ?? rows.length,
  }).where(eq(laftRestrictiveLists.id, list.id));

  return {
    listCode: 'EU',
    fetched: rows.length,
    inserted,
    updated: 0,
    errors,
    durationMs: Date.now() - start,
  };
}
