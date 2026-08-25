// HU #11775 — gate del worker de pdf.js: un único origen, el bundler, y nunca una ruta escrita a mano.
//
// ── Qué protege ───────────────────────────────────────────────────────────────────────────────
//
// pdf.js valida el handshake API↔worker en tiempo de ejecución: si el worker que se carga no es de
// la MISMA versión que el módulo `pdfjs-dist` importado, lanza («Setting up fake worker failed» /
// «The API version does not match the Worker version») y el visor queda en «No se pudo abrir el
// documento». Nada de eso lo ve el compilador.
//
// Hasta esta HU el `workerSrc` de los cinco visores era la cadena literal `'/pdf.worker.min.js'`,
// apuntando a una copia manual de 1.087.212 bytes versionada en `apps/web/public/`. Que esa copia
// correspondiera a la versión instalada era COINCIDENCIA: subir `pdfjs-dist` sin recopiar el fichero
// compilaba, pasaba lint, pasaba el typecheck y pasaba el CI entero — y rompía los cuatro visores en
// el navegador del usuario. Ese es exactamente el fallo que este gate hace imposible.
//
// La forma correcta —y la única que este gate acepta— es el módulo `apps/web/src/lib/pdfWorker.ts`,
// que importa el worker con el sufijo `?url`: Vite lo emite como asset con hash de contenido desde
// el mismo `node_modules` del que sale la API, y si el especificador deja de resolver el build sale
// en rojo (exit 1 de Rollup) en vez de emitir un string muerto.
//
// ── Por qué AST y no regex ────────────────────────────────────────────────────────────────────
//
// El formato no debe poder engañar al gate. `pdfjs.Global\
// WorkerOptions.workerSrc = x` en una línea o en tres, con `pdfjsLib`, `pdfjs` o `GlobalWorkerOptions`
// importado suelto, es el mismo hecho. Y al revés: un comentario que MENCIONE la cadena no puede
// contar como violación.
//
// Uso: node scripts/check-pdf-worker.mjs [dir1 dir2 ...]   (default: apps/web/src)
// Exit 1 nombrando archivo, línea y REGLA incumplida.

import ts from 'typescript';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const PROPIO = fileURLToPath(import.meta.url);
const ROOT = process.cwd();

const args = process.argv.slice(2);
const targets = args.length ? args : ['apps/web/src'];

// ── Constantes versionadas ────────────────────────────────────────────────────────────────────

// Recuento versionado de asignaciones a `GlobalWorkerOptions.workerSrc`. NO es cosmético: sin él,
// «0 asignaciones encontradas» contaría como éxito y el gate se saltaría a sí mismo — por ejemplo si
// mañana alguien pasa el worker por opciones de `getDocument` en vez de por la global, o si el
// escáner deja de ver una extensión nueva.
//
// Falla en LAS DOS direcciones a propósito:
//   · si BAJA  → o se borró un visor (baja el número aquí, en el mismo commit), o hay una forma de
//                fijar el worker que este escáner no reconoce, y entonces hay visores sin vigilar.
//   · si SUBE  → hay un visor nuevo; que un humano confirme que toma la URL de `lib/pdfWorker.ts`
//                y suba el número. Ése es el caso que convierte esto en función de forzado.
const ESPERADAS = 5;

/** Único módulo del front autorizado a nombrar el fichero del worker. */
const MODULO = 'apps/web/src/lib/pdfWorker.ts';
const MODULO_ABS = resolve(ROOT, MODULO);

// Especificadores aceptados para importar `PDF_WORKER_SRC` desde los visores. Hoy los cinco lo
// importan en RELATIVO, que es como importa el resto del front (0 de 288 archivos usan el alias
// `@/`); esas rutas las resuelve `apuntaAlModulo()`. El alias se acepta igualmente para no obligar a
// tocar este gate el día que alguien decida adoptarlo de verdad — pero adoptarlo sería una decisión
// propia y completa, no un efecto colateral de la HU del worker.
const ALIAS_MODULO = new Set(['@/lib/pdfWorker', '@/lib/pdfWorker.ts', '@/lib/pdfWorker.js']);

// `pdf.worker.min.mjs` desde el salto a v6 (HU #11289); antes era `.js`. El sufijo `?url` es
// obligatorio: es lo que hace que Rollup falle en vez de dejar pasar un string sin resolver.
const RE_ESPECIFICADOR = /^pdfjs-dist\/build\/pdf\.worker[.\w-]*\?url$/;

/** Cualquier mención del worker en un literal de cadena fuera del módulo canónico. */
const RE_NOMBRE_WORKER = /pdf\.worker/;

/** Carpeta donde vivía la copia manual. Nada que se llame `pdf.worker*` puede volver ahí. */
const PUBLIC_DIR = 'apps/web/public';

// ── Utilidades de escaneo ─────────────────────────────────────────────────────────────────────

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

const rel = (p) => relative(ROOT, p) || p;
const linea = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

/** ¿Este especificador apunta al módulo canónico? Acepta el alias `@/` y rutas relativas. */
function apuntaAlModulo(fileAbs, spec) {
  if (ALIAS_MODULO.has(spec)) return true;
  if (!spec.startsWith('.')) return false;
  const sinExt = (p) => p.replace(/\.(ts|tsx|js|jsx|mjs)$/, '');
  return sinExt(resolve(dirname(fileAbs), spec)) === sinExt(MODULO_ABS);
}

/** ¿Es `<algo>.GlobalWorkerOptions.workerSrc = <expr>` (o `GlobalWorkerOptions.workerSrc = …`)? */
function asignacionWorkerSrc(node) {
  if (!ts.isBinaryExpression(node)) return null;
  if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return null;
  const izq = node.left;
  if (!ts.isPropertyAccessExpression(izq) || izq.name.text !== 'workerSrc') return null;
  const owner = izq.expression;
  const ownerName = ts.isPropertyAccessExpression(owner)
    ? owner.name.text
    : ts.isIdentifier(owner)
      ? owner.text
      : null;
  if (ownerName !== 'GlobalWorkerOptions') return null;
  return node.right;
}

/**
 * Clasifica el lado derecho de la asignación:
 *   'ok'        → identificador importado del módulo canónico
 *   'literal'   → cadena o template: la ruta va escrita a mano → es EL fallo que este gate impide
 *   'propiedad' → acceso a propiedad / llamada / otra expresión: no se puede probar el origen
 *   'ajeno'     → identificador que NO viene de `lib/pdfWorker.ts`
 */
function clasificarRhs(rhs, importados) {
  if (ts.isStringLiteral(rhs) || ts.isNoSubstitutionTemplateLiteral(rhs) || ts.isTemplateExpression(rhs)) {
    return 'literal';
  }
  if (ts.isIdentifier(rhs)) return importados.has(rhs.text) ? 'ok' : 'ajeno';
  return 'propiedad';
}

const HANDSHAKE =
  'pdf.js compara la versión de la API con la del worker al abrir el documento y lanza si no casan: ' +
  'una ruta escrita a mano deja de corresponder a `node_modules` en cuanto se sube `pdfjs-dist`, y ' +
  'eso NO lo detecta ni el typecheck ni el build — sólo el usuario, con «No se pudo abrir el documento».';

const MENSAJES = {
  literal:
    `[regla 2] \`GlobalWorkerOptions.workerSrc\` recibe una cadena literal. ${HANDSHAKE}\n` +
    `             Importa \`PDF_WORKER_SRC\` de ${MODULO} —en relativo, como el resto del front\n` +
    `             (p. ej. \`from '../lib/pdfWorker'\`)— y asígnalo tal cual.`,
  propiedad:
    `[regla 2] \`GlobalWorkerOptions.workerSrc\` recibe una expresión cuyo origen no se puede probar ` +
    `estáticamente. ${HANDSHAKE}\n` +
    `             Asigna directamente \`PDF_WORKER_SRC\`, importado de ${MODULO}.`,
  ajeno:
    `[regla 2] \`GlobalWorkerOptions.workerSrc\` recibe un identificador que NO viene de ` +
    `${MODULO}. ${HANDSHAKE}`,
};

// ── Recorrido ─────────────────────────────────────────────────────────────────────────────────

const violaciones = [];
const importsUrl = []; // ImportDeclaration con especificador `…pdf.worker…?url`
let asignaciones = 0;
let archivos = 0;

for (const t of targets) {
  if (!existsSync(t)) {
    console.error(`✗ Ruta a escanear inexistente: ${t}`);
    process.exit(1);
  }

  for (const file of fuentes(t)) {
    archivos++;
    const abs = resolve(ROOT, file);
    const esModulo = abs === MODULO_ABS;
    const src = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, scriptKind(file));

    // Paso 1 — bindings locales que vienen del módulo canónico (para la regla 2).
    const importados = new Set();
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
      const spec = st.moduleSpecifier.text;

      if (RE_ESPECIFICADOR.test(spec)) importsUrl.push({ file, line: linea(sf, st), spec });

      if (!apuntaAlModulo(abs, spec)) continue;
      const clause = st.importClause;
      if (!clause) continue;
      if (clause.name) importados.add(clause.name.text);
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) importados.add(el.name.text);
      }
    }

    // Paso 2 — asignaciones (reglas 1 y 2) y literales sueltos (regla 5).
    const recorrer = (node) => {
      const rhs = asignacionWorkerSrc(node);
      if (rhs) {
        asignaciones++;
        const veredicto = clasificarRhs(rhs, importados);
        if (veredicto !== 'ok') {
          violaciones.push({ file, line: linea(sf, node), msg: MENSAJES[veredicto] });
        }
      }

      // Regla 5: ninguna cadena puede nombrar el worker fuera del módulo canónico. El import con
      // `?url` de ese módulo queda cubierto por la excepción; los comentarios no son literales y por
      // tanto no cuentan (un gate no debe castigar la documentación).
      if (
        !esModulo &&
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
        RE_NOMBRE_WORKER.test(node.text)
      ) {
        violaciones.push({
          file,
          line: linea(sf, node),
          msg:
            `[regla 5] literal de cadena que nombra el worker de pdf.js (${JSON.stringify(node.text)}) ` +
            `fuera de ${MODULO}.\n` +
            `             ${MODULO} es el ÚNICO sitio autorizado a nombrarlo; el resto del front lo ` +
            `recibe como \`PDF_WORKER_SRC\`.`,
        });
      }

      node.forEachChild(recorrer);
    };
    recorrer(sf);
  }
}

console.log(
  `check:pdf-worker · ${archivos} archivo(s) en ${targets.join(', ')} — ` +
    `${asignaciones} asignación(es) de GlobalWorkerOptions.workerSrc (esperadas: ${ESPERADAS}), ` +
    `${importsUrl.length} import(s) con \`?url\` del worker`,
);

let fallo = false;
const error = (msg) => {
  fallo = true;
  console.error(msg);
};

// ── Regla 1 — recuento versionado ─────────────────────────────────────────────────────────────
if (asignaciones !== ESPERADAS) {
  error(
    `\n✗ [regla 1] Asignaciones de \`GlobalWorkerOptions.workerSrc\`: ${asignaciones}, esperadas ` +
      `${ESPERADAS} (ESPERADAS en ${rel(PROPIO)}).\n` +
      (asignaciones < ESPERADAS
        ? '  O se eliminó un visor de PDF —y entonces basta con bajar ESPERADAS en el mismo commit—,\n' +
          '  o el worker se está fijando de una forma que este escáner no reconoce, y entonces hay\n' +
          '  visores cuyo handshake API↔worker no vigila nadie.'
        : '  Hay un visor de PDF nuevo. Comprueba que toma la URL de `PDF_WORKER_SRC` y sube ESPERADAS\n' +
          `  a ${asignaciones} en el mismo commit que lo añade.`),
  );
}

// ── Regla 2 y regla 5 — violaciones por archivo:línea ─────────────────────────────────────────
if (violaciones.length > 0) {
  fallo = true;
  console.error('\n✗ Referencias al worker de pdf.js fuera de contrato:');
  for (const v of violaciones) console.error(`  ✗ ${rel(v.file)}:${v.line}  ${v.msg}`);
}

// ── Regla 3 — exactamente un import `?url`, y en el módulo canónico ───────────────────────────
if (importsUrl.length !== 1) {
  error(
    `\n✗ [regla 3] Se esperaba EXACTAMENTE 1 import que case ${RE_ESPECIFICADOR} en ` +
      `${targets.join(', ')}; hay ${importsUrl.length}.\n` +
      (importsUrl.length === 0
        ? `  Sin ese import no hay worker emitido por el bundler: ${MODULO} debe hacer\n` +
          "  `import workerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url'`. El sufijo `?url` no es\n" +
          '  decorativo: es lo que hace que `vite build` salga en ROJO si el especificador deja de\n' +
          '  resolver, en vez de emitir un string muerto que sólo falla en el navegador.'
        : '  Más de un import del worker significa más de una fuente de verdad: consolídalos en\n' +
          `  ${MODULO}, que exporta \`PDF_WORKER_SRC\`.\n` +
          importsUrl.map((i) => `    · ${rel(i.file)}:${i.line}  ${i.spec}`).join('\n')),
  );
} else if (resolve(ROOT, importsUrl[0].file) !== MODULO_ABS) {
  error(
    `\n✗ [regla 3] El import del worker con \`?url\` está en ${rel(importsUrl[0].file)}:${importsUrl[0].line},\n` +
      `  y debe estar en ${MODULO} — el único módulo autorizado a nombrar el fichero del worker.`,
  );
}

// ── Regla 4 — el especificador resuelve en disco, bajo node_modules/pdfjs-dist ────────────────
if (importsUrl.length === 1) {
  const bare = importsUrl[0].spec.replace(/\?.*$/, '');
  let destino = null;
  try {
    destino = createRequire(MODULO_ABS).resolve(bare);
  } catch {
    const candidato = resolve(ROOT, 'node_modules', bare);
    if (existsSync(candidato)) destino = candidato;
  }

  if (!destino) {
    error(
      `\n✗ [regla 4] El especificador \`${bare}\` NO resuelve en disco.\n` +
        '  El worker que se emitiría no existe: los visores caerían con «Setting up fake worker failed».\n' +
        '  Suele pasar al subir `pdfjs-dist` si el paquete renombró el fichero (p. ej. `.js` → `.mjs`).',
    );
  } else if (!destino.replace(/\\/g, '/').includes('/node_modules/pdfjs-dist/')) {
    error(
      `\n✗ [regla 4] \`${bare}\` resuelve a ${rel(destino)}, que NO está bajo node_modules/pdfjs-dist/.\n` +
        '  El worker DEBE salir del mismo paquete instalado del que sale la API: es lo único que\n' +
        '  garantiza que las dos versiones coinciden.',
    );
  } else {
    console.log(`  · \`${bare}\` → ${rel(destino)}`);
  }
}

// ── Regla 6 — nada que se llame `pdf.worker*` puede volver a `public/` ────────────────────────
// Se mira la carpeta entera, no sólo `pdf.worker.min.js`: tras el salto a pdfjs v6 (HU #11289) la
// copia manual reincidente se llamaría `.mjs`, y sería el mismo error con otro nombre.
if (existsSync(PUBLIC_DIR)) {
  const reincidentes = [];
  const barrer = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) barrer(full);
      else if (RE_NOMBRE_WORKER.test(entry)) reincidentes.push(full);
    }
  };
  barrer(PUBLIC_DIR);

  if (reincidentes.length > 0) {
    error(
      `\n✗ [regla 6] Copia manual del worker de pdf.js en ${PUBLIC_DIR}:\n` +
        reincidentes.map((f) => `    · ${rel(f)}`).join('\n') +
        '\n  Un fichero en `public/` se sirve tal cual, sin hash y sin relación con la versión\n' +
        '  instalada: es justo la desincronización API↔worker que la HU #11775 eliminó. Bórralo — el\n' +
        `  worker lo emite el bundler desde ${MODULO}.`,
    );
  }
}

if (fallo) {
  console.error(`\nGate check:pdf-worker en ROJO. Contrato completo en la cabecera de ${rel(PROPIO)}.`);
  process.exit(1);
}

console.log(
  `✓ Las ${asignaciones} asignaciones de workerSrc toman \`PDF_WORKER_SRC\` de ${MODULO}, ` +
    'que emite el worker desde node_modules con hash de contenido (handshake API↔worker garantizado).',
);
