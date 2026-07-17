// LAFT v2 F1 — fetch OFAC SDN.
// Reutilizamos downloadWithGuards + parseCsvLine existentes en lists/. La diferencia con
// lists/ofac.loader.ts es que aquí NO tocamos BD: solo descargamos, parseamos y devolvemos
// NormalizedEntry[] + sourceHash. La aplicación del diff y retro-match las hace sync.cron.ts.
//
// URL: https://www.treasury.gov/ofac/downloads/sdn.csv
// Si OFAC migra a otro endpoint (S3 govcloud, etc.) la guarda permite redirects al bucket
// oficial de Treasury (.treas.gov, s3.us-gov-west-1.amazonaws.com).
//
// Si el endpoint cambia y devuelve algo no parseable, retornamos null + log error — el cron
// continúa con las otras listas.

import crypto from 'crypto';
import { downloadWithGuards } from '../lists/downloader.js';
import { parseCsvLine as basicParseCsvLine } from '../lists/parsers.js';
import { loggerFor } from '../../../shared/logger.js';
import type { FetchResult, NormalizedEntry } from './types.js';

const log = loggerFor('laft-sync-ofac');

const OFAC_SDN_URL = 'https://www.treasury.gov/ofac/downloads/sdn.csv';

function isAllowedOfacHost(host: string): boolean {
  if (host === 'www.treasury.gov' || host === 'treasury.gov') return true;
  if (host.endsWith('.treas.gov')) return true;
  if (host === 's3.us-gov-west-1.amazonaws.com') return true;
  if (host.endsWith('.s3.us-gov-west-1.amazonaws.com')) return true;
  return false;
}

// CSV de OFAC SDN: comma-quoted con valor especial '-0-' para nulls.
function parseCsvLine(line: string): string[] {
  return basicParseCsvLine(line).map((s) => s.replace(/^-0-$/, ''));
}

function parseSdnCsv(csv: string): NormalizedEntry[] {
  const out: NormalizedEntry[] = [];
  const lines = csv.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = parseCsvLine(line);
    if (cols.length < 4) continue;
    // SDN columns: ent_num, sdn_name, sdn_type, program, title, call_sign, vess_type,
    // tonnage, GRT, vess_flag, vess_owner, remarks
    const [entNum, sdnName, , , , , , , , , , remarks] = cols;
    if (!entNum || !sdnName) continue;
    out.push({
      sourceId: entNum,
      fullName: sdnName,
      aliases: null,
      docType: null,
      docNumber: null,
      country: null,
      birthDate: null,
      remarks: remarks || null,
    });
  }
  return out;
}

/**
 * Descarga + parse OFAC SDN. Retorna null si:
 * - El endpoint cambia/responde con error (HTTP != 200, redirect a host no whitelisted, etc).
 * - El payload no es parseable a >0 entries.
 *
 * El cron (sync.cron.ts) registra el fallo en laft_lists_sync_jobs.status='failed' y continúa
 * con las otras listas.
 */
export async function fetchOfac(): Promise<FetchResult | null> {
  try {
    const csv = await downloadWithGuards(OFAC_SDN_URL, {
      allowedHostMatcher: isAllowedOfacHost,
      maxBytes: 30 * 1024 * 1024,
      timeoutMs: 90_000,
    });
    const sourceHash = crypto.createHash('sha256').update(csv).digest('hex');
    const entries = parseSdnCsv(csv);
    if (entries.length === 0) {
      log.warn({ url: OFAC_SDN_URL, csvLength: csv.length }, 'OFAC fetch retornó 0 entries — endpoint posiblemente cambió formato');
      return null;
    }
    return { listCode: 'OFAC', sourceUrl: OFAC_SDN_URL, sourceHash, entries };
  } catch (e) {
    log.error({ err: (e as Error).message, url: OFAC_SDN_URL }, 'OFAC fetch falló');
    return null;
  }
}

export const _internal = { parseSdnCsv, isAllowedOfacHost, OFAC_SDN_URL };
