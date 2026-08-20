// FIONA F3 — gate de presupuesto de bundle (regresión de ruta crítica).
//
// Mide el tamaño gzip del chunk de entrada del build de apps/web y falla (exit 1)
// si supera su budget. Pensado para correr en CI DESPUÉS de `build:web`.
//
// Métrica protegida: el chunk `index` (entry) es lo que descarga /login (la
// entrada no autenticada). Mantenerlo pequeño preserva el TBT/LCP de login.
//
// Uso local: `npm run check:bundle` (tras `npm run build:web`).

import { readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const DIST = 'apps/web/dist';
const ASSETS = join(DIST, 'assets');
const INDEX_HTML = join(DIST, 'index.html');

// Budget en KB gzip, con ~20% de holgura sobre el tamaño real para atrapar
// regresiones (p. ej. un import estático pesado) sin ser flaky.
//
// **Línea base remedida el 2026-08-20 (Bug #11647): entry = 26,6 KB gzip.**
// La anterior decía «≈ 79 KB» y fijaba 95, un budget de ~3,5x el tamaño real:
// el entry podía triplicarse sin que el gate dijera nada, que es exactamente la
// regresión que este script existe para impedir. Si se recalibra otra vez, dejar
// escrita la medición y la fecha — un budget sin su medición no se puede juzgar.
const BUDGET_ENTRY_KB = 32;

if (!existsSync(ASSETS) || !existsSync(INDEX_HTML)) {
  console.error(`✗ Falta ${DIST} (assets/ e index.html). Corre "npm run build:web" antes del budget.`);
  process.exit(1);
}

/**
 * El entry se **lee** de `dist/index.html`; no se adivina por el nombre (Bug #11647).
 *
 * El build emite DOS ficheros que casan con `index-*.js`, y hasta este cambio el gate
 * cogía el primero que devolvía `readdirSync` — es decir, el primero por orden
 * alfabético, y el nombre lleva el hash de contenido. Cuál de los dos se medía
 * dependía del hash, y el hash cambia en cada build: el gate no estaba roto de forma
 * visible, estaba **indeterminado**. En el PR #155 le tocó el equivocado e imprimió
 * 6,2 KB donde el entry real eran 26,3.
 *
 * `index.html` es la única fuente que sabe cuál de los dos descarga el navegador, que
 * es justo la pregunta que el budget quiere responder.
 */
function entryDelBuild() {
  const html = readFileSync(INDEX_HTML, 'utf8');
  const referenciados = [...html.matchAll(/<script\b[^>]*\bsrc="\/assets\/([^"]+\.js)"/g)]
    .map((m) => m[1]);
  const unicos = [...new Set(referenciados)];

  if (unicos.length === 0) {
    console.error(`✗ ${INDEX_HTML} no referencia ningún script de /assets. ¿Cambió el naming o el formato del build?`);
    process.exit(1);
  }
  // Más de uno no se resuelve tomando el primero — que es el error que este Bug corrige.
  // Si el build pasa a emitir varias entradas, hay que DECIDIR cuál se protege.
  if (unicos.length > 1) {
    console.error(`✗ ${INDEX_HTML} referencia ${unicos.length} scripts de entrada (${unicos.join(', ')}).`);
    console.error('  El budget asume uno solo. Decide cuál se protege antes de seguir.');
    process.exit(1);
  }
  return unicos[0];
}

const entry = entryDelBuild();
const ruta = join(ASSETS, entry);

if (!existsSync(ruta)) {
  console.error(`✗ ${INDEX_HTML} apunta a ${entry}, que no está en ${ASSETS}.`);
  process.exit(1);
}

const gzKB = gzipSync(readFileSync(ruta)).length / 1024;
const ok = gzKB <= BUDGET_ENTRY_KB;

console.log(`${ok ? '✓' : '✗'} index (entry /login): ${gzKB.toFixed(1)} KB gzip (budget ${BUDGET_ENTRY_KB} KB) — ${entry}`);

if (!ok) {
  console.error('\n✗ Presupuesto de bundle excedido. Revisa imports estáticos pesados o falta de code-splitting (lazy()).');
  process.exit(1);
}
console.log('\n✓ Presupuesto de bundle OK.');
