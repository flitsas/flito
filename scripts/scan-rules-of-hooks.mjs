// OPS-13 — escáner enfocado de «Rules of Hooks» para detectar la clase de bug de
// #147 (pantalla en blanco: «Rendered more/fewer hooks than previous render»).
//
// NO sustituye a eslint-plugin-react-hooks (recomendado para CI por tom). Es un
// gate sin dependencias (usa el `typescript` ya instalado) centrado en las DOS
// violaciones que producen pantallas blancas en runtime:
//   A) hook llamado DESPUÉS de un early return/throw de nivel superior  ← bug de #147
//   B) hook llamado dentro de un bloque condicional/bucle (if/for/while/switch)
//
// Heurística de bajo falso-positivo: analiza toda función que CONTENGA ≥1 hook
// (por convención, eso la hace componente o custom hook → las reglas aplican).
// Property-access sólo cuenta como hook si es `React.useX`.
//
// Uso: node scripts/scan-rules-of-hooks.mjs [dir1 dir2 ...]
//   default dir: apps/web/src/pages  (las páginas lazy del router)
// Exit 1 si encuentra violaciones.

import ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const HOOK_RE = /^use[A-Z0-9]/;
const ROOT = process.cwd();
const dirs = process.argv.slice(2);
const targets = dirs.length ? dirs : ['apps/web/src/pages', 'apps/web/src/components'];

function isHookCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const e = node.expression;
  if (ts.isIdentifier(e)) return HOOK_RE.test(e.text);
  // Sólo React.useX (evita falsos positivos tipo `obj.useFoo()`).
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'React') {
    return HOOK_RE.test(e.name.text);
  }
  return false;
}

const isFn = (n) =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n);
const isControlFlow = (n) =>
  ts.isIfStatement(n) || ts.isForStatement(n) || ts.isForInStatement(n) ||
  ts.isForOfStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n) ||
  ts.isSwitchStatement(n) || ts.isConditionalExpression(n) ||
  (ts.isBinaryExpression(n) &&
    (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
     n.operatorToken.kind === ts.SyntaxKind.BarBarToken));

// ¿La sentencia (return/throw o if con return) es un early-exit de nivel superior?
function isEarlyExitStatement(stmt) {
  if (ts.isReturnStatement(stmt) || ts.isThrowStatement(stmt)) return true;
  if (ts.isIfStatement(stmt)) return branchHasExit(stmt.thenStatement) || branchHasExit(stmt.elseStatement);
  return false;
}
function branchHasExit(node) {
  if (!node) return false;
  if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) return true;
  if (ts.isBlock(node)) return node.statements.some((s) => ts.isReturnStatement(s) || ts.isThrowStatement(s));
  return false;
}

// Recolecta hooks dentro de `node` SIN descender a funciones anidadas (otro scope).
// Marca cada hook con: `conditional` (dentro de if/for/&&/?:) e `inReturn` (dentro
// del argumento de un return / JSX renderizado). Un hook incondicional dentro del
// JSX devuelto se evalúa en cada render → es legal; sólo importa para la regla B.
function collectHooks(node, conditional, inReturn, out) {
  node.forEachChild((child) => {
    if (isFn(child)) return; // scope separado
    const nextConditional = conditional || isControlFlow(child);
    const nextInReturn = inReturn || ts.isReturnStatement(child);
    if (isHookCall(child)) out.push({ node: child, conditional, inReturn });
    collectHooks(child, nextConditional, nextInReturn, out);
  });
}

const violations = [];

function analyzeFunction(fnNode, sf) {
  const body = fnNode.body;
  if (!body || !ts.isBlock(body)) return;

  // ¿Esta función contiene algún hook? (si no, no es componente/hook → skip)
  const allHooks = [];
  collectHooks(fnNode, false, false, allHooks);
  if (allHooks.length === 0) return;

  // B) hooks condicionales.
  for (const h of allHooks) {
    if (h.conditional) {
      const { line } = sf.getLineAndCharacterOfPosition(h.node.getStart(sf));
      violations.push({ file: sf.fileName, line: line + 1, kind: 'conditional-hook',
        msg: 'Hook llamado dentro de condicional/bucle (debe ser incondicional)' });
    }
  }

  // A) hook de nivel superior tras un early-exit de nivel superior.
  let firstExitPos = Infinity;
  for (const stmt of body.statements) {
    if (isEarlyExitStatement(stmt)) { firstExitPos = Math.min(firstExitPos, stmt.getStart(sf)); }
  }
  if (firstExitPos !== Infinity) {
    for (const h of allHooks) {
      if (h.conditional) continue; // ya reportado en B
      if (h.inReturn) continue;    // hook dentro del JSX devuelto → render-level, legal si incondicional
      const pos = h.node.getStart(sf);
      if (pos > firstExitPos) {
        const { line } = sf.getLineAndCharacterOfPosition(pos);
        violations.push({ file: sf.fileName, line: line + 1, kind: 'hook-after-return',
          msg: 'Hook llamado DESPUÉS de un early return/throw (clase de bug #147)' });
      }
    }
  }
}

function walkForFunctions(node, sf) {
  if (isFn(node)) analyzeFunction(node, sf);
  node.forEachChild((c) => walkForFunctions(c, sf));
}

function* tsxFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* tsxFiles(full);
    else if (entry.endsWith('.tsx')) yield full;
  }
}

let scanned = 0;
for (const t of targets) {
  for (const file of tsxFiles(t)) {
    scanned++;
    const src = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    walkForFunctions(sf, sf);
  }
}

console.log(`OPS-13 · escaneados ${scanned} archivos .tsx en: ${targets.join(', ')}`);
if (violations.length === 0) {
  console.log('✓ Sin violaciones de Rules of Hooks (clase #147).');
  process.exit(0);
}
// dedupe por file:line:kind
const seen = new Set();
for (const v of violations) {
  const key = `${v.file}:${v.line}:${v.kind}`;
  if (seen.has(key)) continue;
  seen.add(key);
  console.error(`✗ ${relative(ROOT, v.file)}:${v.line}  [${v.kind}] ${v.msg}`);
}
console.error(`\n${seen.size} violación(es). Mueve los hooks ANTES de cualquier return condicional y fuera de if/for.`);
process.exit(1);
