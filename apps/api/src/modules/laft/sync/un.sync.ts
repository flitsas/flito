// LAFT v2 F1 — fetch UN Security Council Consolidated List.
// Endpoint XML público, no requiere auth. Estructura: INDIVIDUALS + ENTITIES.
// Reusamos extractXmlBlocks/getXmlText/getXmlAllTexts de lists/parsers.ts.
//
// URL oficial: https://scsanctions.un.org/resources/xml/en/consolidated.xml
// El endpoint REDIRIGE a un Azure blob SAS-signed URL en *.blob.core.windows.net
// (verificado 2026-05-09). El allowlist permite ambos hosts. Además el endpoint
// devuelve 404 a User-Agents no-browser, así que forzamos UA tipo Mozilla.

import crypto from 'crypto';
import { downloadWithGuards } from '../lists/downloader.js';
import { extractXmlBlocks, getXmlText, getXmlAllTexts } from '../lists/parsers.js';
import { loggerFor } from '../../../shared/logger.js';
import type { FetchResult, NormalizedEntry } from './types.js';

const log = loggerFor('laft-sync-un');

const UN_CONSOLIDATED_URL = 'https://scsanctions.un.org/resources/xml/en/consolidated.xml';
const UN_BROWSER_UA = 'Mozilla/5.0 (compatible; Kyverum-Operaciones/1.0; +https://kyverum.com)';

function isAllowedUnHost(host: string): boolean {
  if (host === 'scsanctions.un.org' || host.endsWith('.un.org')) return true;
  // El XML se sirve desde Azure blob storage de la ONU vía SAS URL temporal.
  if (host.endsWith('.blob.core.windows.net')) return true;
  return false;
}

function parseIndividuals(xml: string): NormalizedEntry[] {
  const blocks = extractXmlBlocks(xml, 'INDIVIDUAL');
  const out: NormalizedEntry[] = [];
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
      sourceId: `IND-${dataId}`,
      fullName,
      aliases: aliases.length ? aliases : null,
      docType: null,
      docNumber,
      country,
      birthDate: birth,
      remarks: getXmlText(b, 'COMMENTS1') ?? null,
    });
  }
  return out;
}

function parseEntities(xml: string): NormalizedEntry[] {
  const blocks = extractXmlBlocks(xml, 'ENTITY');
  const out: NormalizedEntry[] = [];
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
      sourceId: `ENT-${dataId}`,
      fullName,
      aliases: aliases.length ? aliases : null,
      docType: null,
      docNumber: null,
      country,
      birthDate: null,
      remarks: getXmlText(b, 'COMMENTS1') ?? null,
    });
  }
  return out;
}

export async function fetchUn(): Promise<FetchResult | null> {
  try {
    const xml = await downloadWithGuards(UN_CONSOLIDATED_URL, {
      allowedHostMatcher: isAllowedUnHost,
      maxBytes: 50 * 1024 * 1024,
      acceptHeader: 'application/xml,text/xml',
      timeoutMs: 90_000,
      userAgent: UN_BROWSER_UA,
    });
    const sourceHash = crypto.createHash('sha256').update(xml).digest('hex');
    const entries = [...parseIndividuals(xml), ...parseEntities(xml)];
    if (entries.length === 0) {
      log.warn({ url: UN_CONSOLIDATED_URL, xmlLength: xml.length }, 'UN fetch retornó 0 entries — endpoint posiblemente cambió formato');
      return null;
    }
    return { listCode: 'UN', sourceUrl: UN_CONSOLIDATED_URL, sourceHash, entries };
  } catch (e) {
    log.error({ err: (e as Error).message, url: UN_CONSOLIDATED_URL }, 'UN fetch falló');
    return null;
  }
}

export const _internal = { parseIndividuals, parseEntities, isAllowedUnHost, UN_CONSOLIDATED_URL, UN_BROWSER_UA };
