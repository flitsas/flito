// Aplica migraciones SQL pendientes con tracking propio.
//
// IMPORTANTE: este sistema reemplaza a drizzle-kit migrate.
// La carpeta src/db/migrations/ contiene SQL plano (no formato drizzle).
// Solo las migraciones 0001-0004 fueron generadas por drizzle-kit; el resto
// son SQL escritos a mano. drizzle-kit migrate aplicaría solo 5 de 64 y dejaría
// la BD en estado inconsistente.
//
// Comandos:
//   npm run db:apply               → aplica las pendientes (idempotente)
//   npm run db:apply -- --dry      → muestra qué se aplicaría sin tocar BD
//   npm run db:apply -- --mark-all → marca TODAS las migrations como aplicadas
//                                     SIN ejecutarlas (uso en VPS donde el SQL
//                                     ya corrió manualmente con psql).
//
// ADR-DB-001 (2026-05-12): migraciones ≥ 0071 NO deben contener BEGIN/COMMIT/
// ROLLBACK ni START TRANSACTION. El runner gestiona la transacción con sql.begin().
// Si el archivo declara control de transacción propia, rompe el wrap externo
// (ver postmortem INC-OCR-2026-05-12 referencia y nota del falso dry-run del
// 2026-05-12). Migraciones 0050-0070 quedan grandfathered: ya están aplicadas
// y NO se re-aplican, así que el guard solo dispara sobre archivos pending.
// Ver docs/runbook/adr-db-001-migration-transaction-policy.md

import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/db/migrations');
const TRACKING_TABLE = '_kyverum_applied_migrations';

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry');
const MARK_ALL = args.has('--mark-all');

// Detecta si este archivo es el entrypoint (vs. importado por tests/otros módulos).
function isInvokedAsScript(): boolean {
  if (!process.argv[1]) return false;
  const invoked = path.resolve(process.argv[1]);
  return invoked === __filename
    || invoked.endsWith('/db-apply.ts')
    || invoked.endsWith('/db-apply.js');
}

// Lazy: el cliente postgres NO se abre al importar el módulo (para que los tests puedan
// reutilizar las utils sin conectar a BD). Solo se inicializa en main().
let sql: ReturnType<typeof postgres>;

async function ensureTrackingTable(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS ${sql(TRACKING_TABLE)} (
      filename TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
}

function listMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

async function listApplied(): Promise<Map<string, string>> {
  const rows = await sql<Array<{ filename: string; sha256: string }>>`
    SELECT filename, sha256 FROM ${sql(TRACKING_TABLE)}
  `;
  return new Map(rows.map((r) => [r.filename, r.sha256]));
}

function fileHash(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

// ADR-DB-001: detecta tx-control top-level. Ignora ocurrencias dentro de
// dollar-quoted bodies ($$ ... $$ o $tag$ ... $tag$) y comentarios.
const TX_CONTROL_RE = /^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|END\s+TRANSACTION)\b\s*;?/i;

export function scanForTxControl(filename: string, content: string): string[] {
  // Reemplazar dollar-quoted strings con espacios (preserva números de línea)
  const stripped = content
    .replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const lines = stripped.split('\n');
  const hits: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (TX_CONTROL_RE.test(lines[i])) {
      hits.push(`  ${filename}:${i + 1} → ${lines[i].trim().slice(0, 80)}`);
    }
  }
  return hits;
}

// Grandfathered: migs 0050-0070 declaraban BEGIN/COMMIT propio. Quedan en disco
// pero ya están en _kyverum_applied_migrations, así que pending=[] para ellas.
// El guard NO debe disparar en archivos cuyo número de prefijo es <= 0070.
export function isGrandfathered(filename: string): boolean {
  const m = filename.match(/^(\d{4})/);
  if (!m) return false;
  const n = Number.parseInt(m[1], 10);
  return n <= 70;
}

async function applyOne(filename: string): Promise<void> {
  const fullPath = path.join(MIGRATIONS_DIR, filename);
  const content = readFileSync(fullPath, 'utf8');
  const hash = createHash('sha256').update(content).digest('hex');

  // ADR-DB-001 guard: archivos nuevos (≥0071) NO deben tener control de tx propio.
  if (!isGrandfathered(filename)) {
    const hits = scanForTxControl(filename, content);
    if (hits.length > 0) {
      console.error(`✗ ${filename}: viola ADR-DB-001 (transaction control en migración).`);
      console.error('Statements top-level encontrados:');
      console.error(hits.join('\n'));
      console.error('');
      console.error('El runner ya envuelve cada archivo con sql.begin(). Quita BEGIN/COMMIT/');
      console.error('ROLLBACK del archivo. Si necesitas un savepoint explícito, hazlo dentro');
      console.error('de un DO $$ ... $$ block. Ver docs/runbook/adr-db-001-migration-transaction-policy.md');
      process.exit(2);
    }
  }

  if (DRY) {
    console.log(`[DRY] aplicaría: ${filename} (${hash.slice(0, 12)})`);
    return;
  }

  await sql.begin(async (tx) => {
    await tx.unsafe(content);
    await tx`
      INSERT INTO ${tx(TRACKING_TABLE)} (filename, sha256)
      VALUES (${filename}, ${hash})
      ON CONFLICT (filename) DO UPDATE SET sha256 = EXCLUDED.sha256, applied_at = now()
    `;
  });
  console.log(`✓ aplicada: ${filename}`);
}

async function markAllApplied(): Promise<void> {
  const files = listMigrationFiles();
  for (const f of files) {
    const fullPath = path.join(MIGRATIONS_DIR, f);
    const hash = fileHash(fullPath);
    await sql`
      INSERT INTO ${sql(TRACKING_TABLE)} (filename, sha256)
      VALUES (${f}, ${hash})
      ON CONFLICT (filename) DO UPDATE SET sha256 = EXCLUDED.sha256
    `;
  }
  console.log(`marcadas como aplicadas: ${files.length} migrations`);
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('DATABASE_URL es requerida');
    process.exit(1);
  }
  sql = postgres(dbUrl, { max: 1 });

  await ensureTrackingTable();

  if (MARK_ALL) {
    await markAllApplied();
    return;
  }

  const files = listMigrationFiles();
  const applied = await listApplied();
  const pending = files.filter((f) => !applied.has(f));

  if (pending.length === 0) {
    console.log(`sin migraciones pendientes (${files.length} aplicadas)`);
    return;
  }

  console.log(`pendientes: ${pending.length} de ${files.length}`);
  for (const f of pending) {
    await applyOne(f);
  }
}

if (isInvokedAsScript()) {
  main()
    .catch((e) => {
      console.error('error:', e?.message ?? e);
      process.exit(1);
    })
    .finally(async () => {
      if (sql) await sql.end({ timeout: 5 });
    });
}
