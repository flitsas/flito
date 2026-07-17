import crypto from 'crypto';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { laftListEntries, laftRestrictiveLists } from '../../../db/schema.js';
import { normalizeName, normalizeDoc } from '../match.service.js';
import { parseCsv } from './parsers.js';
import type { SyncResult } from './ofac.loader.js';

const ALLOWED_LIST_CODES = ['PROCURADURIA', 'CONTRALORIA', 'POLICIA', 'INTERPOL', 'CLINTON'] as const;
type ManualListCode = (typeof ALLOWED_LIST_CODES)[number];

export function isManualListCode(code: string): code is ManualListCode {
  return (ALLOWED_LIST_CODES as readonly string[]).includes(code);
}

/**
 * Carga manual de CSV. El usuario admin sube un CSV con columnas mínimas:
 *   - documento (obligatoria, número del documento)
 *   - nombre (obligatoria, nombre completo o razón social)
 *   - alias (opcional, separado por |)
 *   - pais (opcional)
 *   - fecha_nacimiento (opcional, YYYY-MM-DD)
 *   - observacion (opcional)
 *
 * Detecta los headers de forma flexible (mayúsculas/tildes/sinónimos).
 */
function pickColumn(headers: string[], candidates: string[]): number {
  const norm = headers.map((h) => h.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''));
  for (const cand of candidates) {
    const idx = norm.indexOf(cand);
    if (idx >= 0) return idx;
  }
  return -1;
}

export async function syncManualCsv(args: {
  code: string;
  csvContent: string;
}): Promise<SyncResult> {
  const start = Date.now();

  if (!isManualListCode(args.code)) {
    throw new Error(`Código no soportado para carga manual: ${args.code}`);
  }

  const [list] = await db.select().from(laftRestrictiveLists).where(eq(laftRestrictiveLists.code, args.code));
  if (!list) throw new Error(`Lista ${args.code} no encontrada en BD`);

  const { headers, rows } = parseCsv(args.csvContent, { headerRow: true });

  if (headers.length === 0 || rows.length === 0) {
    throw new Error('CSV vacío o sin headers');
  }

  const idxDoc = pickColumn(headers, ['documento', 'cedula', 'cédula', 'doc', 'identificacion', 'identificación', 'id']);
  const idxName = pickColumn(headers, ['nombre', 'nombre completo', 'razon social', 'razón social', 'name', 'full_name']);
  const idxAlias = pickColumn(headers, ['alias', 'aliases', 'apodos']);
  const idxCountry = pickColumn(headers, ['pais', 'país', 'country']);
  const idxBirth = pickColumn(headers, ['fecha_nacimiento', 'fecha nacimiento', 'birthdate', 'fec_nac']);
  const idxRemarks = pickColumn(headers, ['observacion', 'observación', 'remarks', 'detalle', 'cargo', 'sancion', 'sanción']);

  if (idxDoc === -1 || idxName === -1) {
    throw new Error('CSV debe tener columnas "documento" y "nombre" (o equivalentes). Headers detectados: ' + headers.join(', '));
  }

  let inserted = 0;
  let skipped = 0;
  const BATCH = 500;

  // Operación transaccional: borra y re-inserta. Si algo falla, el rollback deja la lista
  // como estaba antes del upload (no parcialmente vacía).
  await db.transaction(async (tx) => {
    await tx.delete(laftListEntries).where(eq(laftListEntries.listId, list.id));

    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH);
      const values = slice.flatMap((cols, idx) => {
        const docRaw = (cols[idxDoc] ?? '').trim();
        const name = (cols[idxName] ?? '').trim();
        if (!docRaw && !name) { skipped++; return []; }
        if (!name) { skipped++; return []; }

        const aliasesRaw = idxAlias >= 0 ? (cols[idxAlias] ?? '').trim() : '';
        const aliases = aliasesRaw ? aliasesRaw.split(/[|;]/).map((s) => s.trim()).filter(Boolean).slice(0, 30) : null;

        return [{
          listId: list.id,
          fullName: name.slice(0, 500),
          fullNameNorm: normalizeName(name).slice(0, 500),
          aliases,
          docType: null,
          docNumber: normalizeDoc(docRaw) || null,
          country: idxCountry >= 0 ? (cols[idxCountry] ?? '').trim().slice(0, 80) || null : null,
          birthDate: idxBirth >= 0 ? (cols[idxBirth] ?? '').trim().slice(0, 20) || null : null,
          remarks: idxRemarks >= 0 ? (cols[idxRemarks] ?? '').trim().slice(0, 1000) || null : null,
          sourceId: `${args.code}-${i + idx}`,
          sourceHash: crypto.createHash('sha1').update(`${name}|${docRaw}`).digest('hex').slice(0, 64),
        }];
      });

      if (values.length > 0) {
        const result = await tx.insert(laftListEntries).values(values).returning({ id: laftListEntries.id });
        inserted += result.length;
      }
    }
  });

  const [countRow] = await db.select({ total: sql<number>`count(*)::int` }).from(laftListEntries).where(eq(laftListEntries.listId, list.id));
  await db.update(laftRestrictiveLists).set({
    lastSyncedAt: new Date(),
    totalEntries: countRow?.total ?? inserted,
  }).where(eq(laftRestrictiveLists.id, list.id));

  return {
    listCode: args.code,
    fetched: rows.length,
    inserted,
    updated: 0,
    errors: skipped,
    durationMs: Date.now() - start,
  };
}

