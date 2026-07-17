// LAFT v2 F1 — fetch EU Consolidated Sanctions List.
// Endpoint XML público de la Comisión Europea — desde 2024 EXIGE el "guest token"
// público "token-2017" (base64: dG9rZW4tMjAxNw). Sin token retorna 403 Forbidden.
// Token documentado oficialmente en data.europa.eu como mecanismo de acceso público:
//   https://data.europa.eu/data/datasets/consolidated-list-of-persons-groups-and-entities-subject-to-eu-financial-sanctions
//
// URL: https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw
//
// La estructura de la UE usa atributos en lugar de texto interno: <nameAlias firstName="..."
// lastName="..." wholeName="..."/>. Por eso el parser es distinto al UN.

import crypto from 'crypto';
import { downloadWithGuards } from '../lists/downloader.js';
import { extractXmlBlocks, getXmlAllTexts } from '../lists/parsers.js';
import { loggerFor } from '../../../shared/logger.js';
import type { FetchResult, NormalizedEntry } from './types.js';

const log = loggerFor('laft-sync-eu');

// Token público "token-2017" (oficial, documentado en data.europa.eu).
const EU_PUBLIC_TOKEN = 'dG9rZW4tMjAxNw';
const EU_CONSOLIDATED_URL = `https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=${EU_PUBLIC_TOKEN}`;
const EU_BROWSER_UA = 'Mozilla/5.0 (compatible; Kyverum-Operaciones/1.0; +https://kyverum.com)';

function isAllowedEuHost(host: string): boolean {
  return host === 'webgate.ec.europa.eu' || host.endsWith('.europa.eu');
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

function extractElementAttrs(block: string, tagName: string): Record<string, string>[] {
  const re = new RegExp(`<${tagName}\\b([^>]*?)/>`, 'gi');
  const out: Record<string, string>[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) out.push(parseAttrs(m[1]));
  const re2 = new RegExp(`<${tagName}\\b([^>]*?)>([\\s\\S]*?)</${tagName}>`, 'gi');
  while ((m = re2.exec(block)) !== null) out.push(parseAttrs(m[1]));
  return out;
}

function matchAttr(s: string, name: string): string | null {
  const m = s.match(new RegExp(`${name}="([^"]+)"`, 'i'));
  return m ? m[1] : null;
}

function parseSanctionEntities(xml: string): NormalizedEntry[] {
  const blocks = extractXmlBlocks(xml, 'sanctionEntity');
  const out: NormalizedEntry[] = [];

  for (const b of blocks) {
    const head = b.slice(0, 1500);
    const logicalId = matchAttr(head, 'logicalId') || matchAttr(head, 'euReferenceNumber') || matchAttr(head, 'designationDate');
    if (!logicalId) continue;

    const nameAliases = extractElementAttrs(b, 'nameAlias');
    const wholeNames = nameAliases
      .map((a) => a.wholeName || `${a.firstName ?? ''} ${a.lastName ?? ''}`.trim())
      .filter(Boolean);
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
      sourceId: `EU-${logicalId}`,
      fullName,
      aliases: aliases.length ? aliases : null,
      docType: null,
      docNumber,
      country,
      birthDate: birth,
      remarks,
    });
  }
  return out;
}

export async function fetchEu(): Promise<FetchResult | null> {
  try {
    const xml = await downloadWithGuards(EU_CONSOLIDATED_URL, {
      allowedHostMatcher: isAllowedEuHost,
      maxBytes: 80 * 1024 * 1024,
      acceptHeader: 'application/xml,text/xml',
      timeoutMs: 120_000,
      userAgent: EU_BROWSER_UA,
    });
    const sourceHash = crypto.createHash('sha256').update(xml).digest('hex');
    const entries = parseSanctionEntities(xml);
    if (entries.length === 0) {
      log.warn({ url: EU_CONSOLIDATED_URL, xmlLength: xml.length }, 'EU fetch retornó 0 entries — endpoint posiblemente cambió formato');
      return null;
    }
    return { listCode: 'EU', sourceUrl: EU_CONSOLIDATED_URL, sourceHash, entries };
  } catch (e) {
    log.error({ err: (e as Error).message, url: EU_CONSOLIDATED_URL }, 'EU fetch falló');
    return null;
  }
}

export const _internal = { parseSanctionEntities, isAllowedEuHost, EU_CONSOLIDATED_URL, EU_PUBLIC_TOKEN, EU_BROWSER_UA };
