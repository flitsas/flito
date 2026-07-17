/**
 * Backfill PII de laft_counterparties tras la migración 0063.
 *
 * Cifra `doc_number`, `email`, `phone` (claro) en sus respectivas columnas
 * `*_enc` (JSONB CipherBundle). Calcula `doc_number_hash` (HMAC hex 64) para
 * búsqueda exacta sin descifrar.
 *
 * IDEMPOTENTE: sólo procesa filas con `doc_number_enc IS NULL`. Si el script
 * corre dos veces, la segunda no toca filas ya cifradas.
 *
 * Uso:
 *   cd apps/api
 *   npm run laft:backfill-pii            # ejecuta el cifrado
 *   npm run laft:backfill-pii -- --dry   # sólo cuenta sin escribir
 *
 * Tras 7d sin issues, correr migration 0064 para DROP COLUMN doc_number, email,
 * phone (claro). NO dropear antes — el código sigue leyendo las columnas claro
 * como fallback durante la transición.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  encryptCounterpartyField,
  counterpartyDocHash,
  type CounterpartyEncColumn,
  type EncBundleJsonb,
} from '../modules/laft/employees/counterparty-pii.js';

const DRY = process.argv.includes('--dry') || process.argv.includes('--dry-run');
const BATCH = 200;

interface Row {
  id: number;
  doc_number: string | null;
  email: string | null;
  phone: string | null;
  [k: string]: unknown;
}

interface RowUpdate {
  id: number;
  docEnc: EncBundleJsonb | null;
  emailEnc: EncBundleJsonb | null;
  phoneEnc: EncBundleJsonb | null;
  docHash: string | null;
}

/**
 * Selecciona el siguiente batch de filas SIN cifrar. Filtramos por
 * `doc_number_enc IS NULL` (no `*_enc IS NULL` para todos) porque es la columna
 * que siempre debe cifrarse — email y phone pueden ser null en claro.
 */
async function fetchBatch(): Promise<Row[]> {
  const r = await db.execute<Row>(sql`
    SELECT id, doc_number, email, phone
    FROM laft_counterparties
    WHERE doc_number_enc IS NULL
    ORDER BY id ASC
    LIMIT ${BATCH}
  `);
  // postgres-js retorna array directo; node-postgres retorna { rows }.
  // Wrapper común — preserva compatibilidad con el cliente Drizzle del proyecto.
  if (Array.isArray(r)) return r;
  const wrapped = r as unknown as { rows?: Row[] };
  return wrapped.rows ?? [];
}

function buildUpdate(row: Row): RowUpdate {
  const docEnc = encryptCounterpartyField(row.doc_number, 'doc_number', row.id);
  const emailEnc = encryptCounterpartyField(row.email, 'email', row.id);
  const phoneEnc = encryptCounterpartyField(row.phone, 'phone', row.id);
  const docHash = counterpartyDocHash(row.doc_number);
  return { id: row.id, docEnc, emailEnc, phoneEnc, docHash };
}

async function applyBatch(updates: RowUpdate[]): Promise<void> {
  await db.transaction(async (tx) => {
    for (const u of updates) {
      await tx.execute(sql`
        UPDATE laft_counterparties
           SET doc_number_enc = ${u.docEnc as unknown as string}::jsonb,
               doc_number_hash = ${u.docHash},
               email_enc = ${u.emailEnc as unknown as string}::jsonb,
               phone_enc = ${u.phoneEnc as unknown as string}::jsonb,
               updated_at = now()
         WHERE id = ${u.id}
           AND doc_number_enc IS NULL
      `);
    }
  });
}

interface Stats {
  total: number;
  cifradas: number;
  saltadas: number;
}

async function run(): Promise<Stats> {
  const stats: Stats = { total: 0, cifradas: 0, saltadas: 0 };

  // Loop hasta que no haya más filas sin cifrar. El WHERE `doc_number_enc IS NULL`
  // garantiza que cada batch sea distinto sin necesidad de paginación por offset.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await fetchBatch();
    if (batch.length === 0) break;

    const updates: RowUpdate[] = [];
    for (const row of batch) {
      stats.total++;
      if (!row.doc_number) {
        // Sin doc → no podemos calcular hash. Lo registramos y seguimos.
        stats.saltadas++;
        // eslint-disable-next-line no-console
        console.warn(`[skip] id=${row.id} sin doc_number`);
        continue;
      }
      updates.push(buildUpdate(row));
    }

    if (DRY) {
      stats.cifradas += updates.length;
    } else if (updates.length > 0) {
      await applyBatch(updates);
      stats.cifradas += updates.length;
    }

    if (stats.total % 100 === 0 || stats.total === batch.length) {
      // eslint-disable-next-line no-console
      console.log(`[progress] vistas=${stats.total} cifradas=${stats.cifradas} saltadas=${stats.saltadas}${DRY ? ' (DRY)' : ''}`);
    }
  }

  return stats;
}

// Ejecutar sólo cuando el script se invoca directamente (no en tests).
// Cuando vitest importa este módulo, NODE_ENV=test (vía vitest config). No usamos
// `import.meta.url` porque siempre apunta al archivo y no nos dice si fue invocado
// directo. Filtramos por:
//   - process.env.VITEST !== 'true' (vitest setea esto automáticamente)
//   - process.argv[1] termina en este nombre de archivo
const argv1 = process.argv[1] ?? '';
const isDirectRun = (
  process.env.VITEST !== 'true' &&
  process.env.NODE_ENV !== 'test' &&
  (argv1.endsWith('laft-encrypt-pii-backfill.ts') || argv1.endsWith('laft-encrypt-pii-backfill.js'))
);

if (isDirectRun) {
  // eslint-disable-next-line no-console
  console.log(`[start] backfill PII laft_counterparties ${DRY ? '(DRY-RUN)' : '(LIVE)'}`);
  run().then((s) => {
    // eslint-disable-next-line no-console
    console.log(`[done] total=${s.total} cifradas=${s.cifradas} saltadas=${s.saltadas}`);
    process.exit(0);
  }).catch((e) => {
    // eslint-disable-next-line no-console
    console.error('[error]', e);
    process.exit(1);
  });
}

// Exportar para tests.
export { run, fetchBatch, buildUpdate, applyBatch };
export type { Row, RowUpdate, Stats };
