// FIONA F3 — gate de presupuesto de bundle (regresión de ruta crítica).
//
// Mide el tamaño gzip de chunks clave del build de apps/web y falla (exit 1) si
// superan su budget. Pensado para correr en CI DESPUÉS de `build:web`.
//
// Métrica protegida: el chunk `index` (entry) es lo que descarga /login (la
// entrada no autenticada). Mantenerlo pequeño preserva el TBT/LCP de login.
//
// Uso local: `npm run check:bundle` (tras `npm run build:web`).

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const ASSETS = 'apps/web/dist/assets';

// Budgets en KB gzip. Fijados con ~20% de holgura sobre el tamaño actual para
// atrapar regresiones (p. ej. un import estático pesado) sin ser flaky.
// Baseline al crear el gate (perf/login-lazy-routes): index ≈ 79 KB gzip.
const BUDGETS = [
  { match: /^index-.*\.js$/, label: 'index (entry /login)', maxGzipKB: 95 },
];

if (!existsSync(ASSETS)) {
  console.error(`✗ No existe ${ASSETS}. Corre "npm run build:web" antes del budget.`);
  process.exit(1);
}

const files = readdirSync(ASSETS);
let failed = false;

for (const budget of BUDGETS) {
  const file = files.find((f) => budget.match.test(f));
  if (!file) {
    console.error(`✗ Sin chunk para ${budget.label} (${budget.match}). ¿Cambió el naming del build?`);
    failed = true;
    continue;
  }
  const gzKB = gzipSync(readFileSync(join(ASSETS, file))).length / 1024;
  const ok = gzKB <= budget.maxGzipKB;
  console.log(`${ok ? '✓' : '✗'} ${budget.label}: ${gzKB.toFixed(1)} KB gzip (budget ${budget.maxGzipKB} KB) — ${file}`);
  if (!ok) failed = true;
}

if (failed) {
  console.error('\n✗ Presupuesto de bundle excedido. Revisa imports estáticos pesados o falta de code-splitting (lazy()).');
  process.exit(1);
}
console.log('\n✓ Presupuesto de bundle OK.');
