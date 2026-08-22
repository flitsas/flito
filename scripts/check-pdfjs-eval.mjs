// HU #11289 — gate de mitigación de CVE-2024-4367 (GHSA-wgrm-67xf-hhpq, CVSS 8.8).
//
// pdfjs-dist 3.11.174 compila los glifos con `new Function(...)` a partir de la matriz de fuente del
// documento: un PDF malicioso ejecuta JavaScript arbitrario al abrirse. El fix upstream es el major
// 3→6, hoy bloqueado por producto (sube el suelo a Chrome 125 / Safari 18). Mientras tanto rige el
// workaround oficial del advisory: `isEvalSupported: false` en CADA `getDocument`.
//
// Ese workaround es una línea fácil de olvidar al añadir un visor nuevo, y nada en el build lo
// delata: sin él, todo compila y todo renderiza igual — sólo vuelve a estar abierto el eval. Por eso
// existe este gate. Se retira junto con la exención de scripts/dependency-audit.mjs cuando se suba
// pdfjs-dist a v6.
//
// El chequeo es sobre el AST (typescript ya está instalado) y no por regex: así no lo engaña el
// formato —llamadas en una línea o repartidas en varias, `pdfjs.getDocument` o `getDocument` suelto—
// ni pasa por bueno un `isEvalSupported: true`.
//
// Uso: node scripts/check-pdfjs-eval.mjs [dir1 dir2 ...]   (default: apps/web/src)
// Exit 1 si alguna llamada no lleva la opción, nombrando archivo y línea.

import ts from 'typescript';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROPIO = fileURLToPath(import.meta.url);

const ROOT = process.cwd();
const args = process.argv.slice(2);
const targets = args.length ? args : ['apps/web/src'];

// Recuento versionado de llamadas a getDocument(). NO es cosmético: sin él, «0 llamadas
// encontradas» contaría como éxito y el gate se saltaría solo. El reconocimiento es sintáctico —
// busca el NOMBRE `getDocument`— así que cualquier forma de escribir la llamada que no mencione ese
// identificador deja el escáner a cero y el CI en verde sobre visores sin mitigar. Cuatro maneras de
// caer en eso sin mala intención:
//
//   1. `import { getDocument as gd } from 'pdfjs-dist'` … `gd({ data })`
//   2. `pdfjsLib['getDocument']({ data })`                        (acceso por string)
//   3. `const { getDocument: cargar } = await import('pdfjs-dist')`  ← la más probable:
//      el código YA usa `await import('pdfjs-dist')`, así que desestructurar con alias es el
//      siguiente paso natural para alguien que sólo quiere acortar una línea.
//   4. un visor nuevo en .js/.jsx/.mjs cuando el escáner sólo miraba .ts/.tsx (ya corregido arriba,
//      pero el recuento lo cubre igual si mañana aparece otra extensión).
//
// El recuento falla en LAS DOS direcciones a propósito:
//   · si BAJA  → alguien escondió una llamada tras un alias, o borró un visor.
//   · si SUBE  → hay un visor nuevo; que un humano confirme que lleva la mitigación y suba el número.
// Ese segundo caso es el que convierte esto en función de forzado y no en un contador.
//
// Actualizar este número es parte legítima del trabajo de añadir o quitar un visor PDF.
const ESPERADAS = 5;

/** ¿Es una llamada a `getDocument(...)` o `algo.getDocument(...)`? */
function nombreLlamada(node) {
  if (!ts.isCallExpression(node)) return null;
  const e = node.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

/**
 * Clasifica el primer argumento de `getDocument`:
 *   'ok'          → objeto literal con `isEvalSupported: false`
 *   'falta'       → objeto literal sin la propiedad
 *   'no-false'    → la propiedad está pero no es el literal `false`
 *   'no-literal'  → el argumento no es un objeto literal → no se puede probar la mitigación
 */
function clasificar(call) {
  const arg = call.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return 'no-literal';

  for (const prop of arg.properties) {
    // Un spread puede traer la opción desde otro sitio; no se puede verificar estáticamente.
    if (ts.isSpreadAssignment(prop)) return 'no-literal';
    if (!ts.isPropertyAssignment(prop)) continue;
    const nombre = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
    if (nombre !== 'isEvalSupported') continue;
    return prop.initializer.kind === ts.SyntaxKind.FalseKeyword ? 'ok' : 'no-false';
  }
  return 'falta';
}

const MENSAJES = {
  falta: 'llamada a getDocument() sin `isEvalSupported: false` — CVE-2024-4367 queda explotable',
  'no-false': '`isEvalSupported` presente pero distinto de `false` — no mitiga CVE-2024-4367',
  'no-literal':
    'el primer argumento de getDocument() no es un objeto literal: la mitigación de CVE-2024-4367 no se puede verificar (pásale `{ ..., isEvalSupported: false }` en la propia llamada)',
};

const violaciones = [];
let llamadas = 0;

function recorrer(node, sf) {
  if (nombreLlamada(node) === 'getDocument') {
    llamadas++;
    const veredicto = clasificar(node);
    if (veredicto !== 'ok') {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      violaciones.push({ file: sf.fileName, line: line + 1, msg: MENSAJES[veredicto] });
    }
  }
  node.forEachChild((c) => recorrer(c, sf));
}

// Se escanean también .js/.jsx/.mjs/.cjs: hoy no hay ninguno bajo apps/web/src, pero un gate no
// debe depender de que eso siga siendo cierto — un visor nuevo en .jsx sería invisible.
const ESCANEABLE = /\.(tsx?|jsx?|mjs|cjs)$/;

function* fuentes(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* fuentes(full);
    else if (ESCANEABLE.test(entry) && !/\.d\.ts$/.test(entry)) yield full;
  }
}

/** El parser de TS necesita saber si el archivo admite JSX; si no, `<T>` se lee mal. */
function scriptKind(file) {
  if (/\.tsx$/.test(file)) return ts.ScriptKind.TSX;
  if (/\.ts$/.test(file)) return ts.ScriptKind.TS;
  if (/\.jsx$/.test(file)) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

let archivos = 0;
for (const t of targets) {
  if (!existsSync(t)) {
    console.error(`✗ Ruta a escanear inexistente: ${t}`);
    process.exit(1);
  }
  for (const file of fuentes(t)) {
    archivos++;
    const src = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, scriptKind(file));
    recorrer(sf, sf);
  }
}

console.log(
  `check:pdfjs-eval · ${archivos} archivo(s) en ${targets.join(', ')} — ${llamadas} llamada(s) a getDocument() (esperadas: ${ESPERADAS})`,
);

let fallo = false;

if (violaciones.length > 0) {
  fallo = true;
  console.error('\n✗ CVE-2024-4367 (GHSA-wgrm-67xf-hhpq) sin mitigar:');
  for (const v of violaciones) console.error(`  ✗ ${relative(ROOT, v.file)}:${v.line}  ${v.msg}`);
  console.error(
    `\n${violaciones.length} llamada(s) sin mitigar. Añade \`isEvalSupported: false\` al objeto de opciones de getDocument().`,
  );
}

if (llamadas !== ESPERADAS) {
  fallo = true;
  const bajaron = llamadas < ESPERADAS;
  console.error(
    `\n✗ Recuento de llamadas a getDocument(): ${llamadas}, esperadas ${ESPERADAS} (ESPERADAS en ${relative(ROOT, PROPIO)}).`,
  );
  if (bajaron) {
    console.error(
      '  El escáner reconoce la llamada por el NOMBRE `getDocument`. Que falte alguna suele significar\n' +
        '  una de dos cosas:\n' +
        '   · se renombró al importarla —`{ getDocument as gd }`, `{ getDocument: cargar }`, `obj[\'getDocument\']`—\n' +
        '     y entonces HAY visores sin verificar aunque este gate no los vea: deshaz el alias o amplía el escáner;\n' +
        '   · o se eliminó un visor de verdad, y entonces basta con bajar ESPERADAS.',
    );
  } else {
    console.error(
      '  Hay llamadas nuevas a getDocument(). Comprueba que TODAS llevan `isEvalSupported: false`\n' +
        '  y sube ESPERADAS a ' + llamadas + ' en el mismo commit que añade el visor.',
    );
  }
}

if (fallo) process.exit(1);

console.log(
  `✓ Las ${llamadas} llamadas a getDocument() llevan \`isEvalSupported: false\` (CVE-2024-4367 mitigado).`,
);
