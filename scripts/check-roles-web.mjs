// HU #12872 (AC8) — gate «la web no decide acceso por el nombre del rol».
//
// Épica #13411: en FLITO el acceso lo gobiernan solo páginas + funciones configurables. Este
// escáner recorre `apps/web/src/**/*.{ts,tsx}` (sin `*.test.ts`) con el AST de `typescript` —ya
// instalado, sin dependencia nueva— y reporta `fichero:línea` de cada forma que compara un nombre
// de rol para decidir. Los comentarios no cuentan (es AST, no regex).
//
//   R1  `x.role === 'literal'` (también `!==`, `==`, `!=`, `rol`, `rolCodigo`, `rolNombre`, el
//       identificador `role`/`rol`) y `switch (x.role) { case 'literal': … }`
//   R2  `.includes(x.role)` / `.has(x.role)`
//   R3  `puede…/es…/tiene…/can…/is…/has…(…, x.role, …)`
//   R4  `roles: ['a', 'b']` dentro de un objeto literal
//   R5  `const ROLES_X = [...]` / `ROL_X` / `new Set([...])` (salvo `ROLE_TONE` / `ROLE_LABELS`)
//
// No cuenta: pintar el rol (`{user.role}`), estilizar (`ROLE_TONE[u.role]`), etiquetar
// (`etiquetaRol(u.role, …)`), comparar el rol elegido contra el actual sin literal, `role="…"` JSX.
//
// Excepciones: SOLO las de `EXCEPCIONES`, por fichero, con motivo y número exacto de hallazgos. Si
// el fichero gana uno, rojo; si deja de tenerlos, rojo hasta retirar la entrada (no hay ratchet
// silencioso).
//
// Uso: node scripts/check-roles-web.mjs        (exit 1 si hay hallazgos fuera de excepción)
// Test: node --test scripts/check-roles-web.test.mjs

import ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROPS_ROL = new Set(['role', 'rol', 'rolCodigo', 'rolNombre']);
const IDENT_ROL = new Set(['role', 'rol']);
const PREFIJO_PREDICADO = /^(puede|es|tiene|can|is|has)[A-Z_]/;
const CONST_ROLES = /^ROL(?:E|ES)?_[A-Z_]+$/;
const CONST_PERMITIDAS = new Set(['ROLE_TONE', 'ROLE_LABELS']);

/**
 * Única excepción declarada (decisión del Líder Técnico en la HU #12872): la matriz rol × estado
 * del traspaso vive en `packages/shared-types/src/traspaso-permisos.ts` y la consume el expediente
 * STT. Pasarla a funciones exige rediseñar esa matriz (servidor + shared-types): pendiente de la
 * Épica #13411. Las rutas son relativas a la raíz del repo, con `/`.
 */
export const EXCEPCIONES = {
  'apps/web/src/pages/TransitoTraspasoExpediente.tsx': {
    veces: 1,
    motivo: 'Matriz rol×estado de traspaso (shared-types/traspaso-permisos.ts): pendiente de la Épica #13411.',
  },
};

function sinEnvoltorio(n) {
  let x = n;
  while (x && (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isNonNullExpression(x)
    || ts.isTypeAssertionExpression?.(x) || ts.isSatisfiesExpression?.(x))) x = x.expression;
  return x;
}

/** ¿`n` es un acceso al rol (`x.role`, `x?.rol`, `role`)? */
export function esAccesoARol(n) {
  const x = sinEnvoltorio(n);
  if (!x) return false;
  if (ts.isPropertyAccessExpression(x)) return PROPS_ROL.has(x.name.text);
  if (ts.isElementAccessExpression(x) && ts.isStringLiteralLike(x.argumentExpression)) {
    return PROPS_ROL.has(x.argumentExpression.text);
  }
  if (ts.isIdentifier(x)) return IDENT_ROL.has(x.text);
  return false;
}

const esLiteralTexto = (n) => {
  const x = sinEnvoltorio(n);
  return !!x && (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x));
};

/** Literal que puede ser un nombre de rol: el vacío (`rol !== ''` = «sin filtro») nunca lo es. */
const esLiteralDeRol = (n) => esLiteralTexto(n) && sinEnvoltorio(n).text !== '';

const IGUALDAD = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
]);

function nombreLlamada(expr) {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

function esArrayDeTextos(n) {
  const x = sinEnvoltorio(n);
  return !!x && ts.isArrayLiteralExpression(x) && x.elements.length > 0 && x.elements.every(esLiteralTexto);
}

function esColeccionDeTextos(n) {
  const x = sinEnvoltorio(n);
  if (esArrayDeTextos(x)) return true;
  return !!x && ts.isNewExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === 'Set'
    && !!x.arguments?.length && esArrayDeTextos(x.arguments[0]);
}

/** Analiza un fuente y devuelve `{ linea, regla, texto }[]`. Puro: lo usa el test con fixtures. */
export function analizar(codigo, fichero = 'fixture.tsx') {
  const kind = fichero.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fichero, codigo, ts.ScriptTarget.Latest, true, kind);
  const hallazgos = [];
  const reportar = (nodo, regla) => {
    const { line } = sf.getLineAndCharacterOfPosition(nodo.getStart(sf));
    hallazgos.push({ linea: line + 1, regla, texto: nodo.getText(sf).replace(/\s+/g, ' ').slice(0, 120) });
  };

  const visitar = (n) => {
    if (ts.isBinaryExpression(n) && IGUALDAD.has(n.operatorToken.kind)) {
      if ((esAccesoARol(n.left) && esLiteralDeRol(n.right)) || (esAccesoARol(n.right) && esLiteralDeRol(n.left))) {
        reportar(n, 'R1');
      }
    } else if (ts.isSwitchStatement(n) && esAccesoARol(n.expression)) {
      if (n.caseBlock.clauses.some((c) => ts.isCaseClause(c) && esLiteralDeRol(c.expression))) reportar(n.expression, 'R1');
    } else if (ts.isCallExpression(n)) {
      const nombre = nombreLlamada(n.expression);
      if ((nombre === 'includes' || nombre === 'has') && ts.isPropertyAccessExpression(n.expression)
        && n.arguments.some(esAccesoARol)) {
        reportar(n, 'R2');
      } else if (nombre && PREFIJO_PREDICADO.test(nombre) && n.arguments.some(esAccesoARol)) {
        reportar(n, 'R3');
      }
    } else if (ts.isPropertyAssignment(n) && ts.isObjectLiteralExpression(n.parent)) {
      const clave = ts.isIdentifier(n.name) || ts.isStringLiteral(n.name) ? n.name.text : null;
      if (clave === 'roles' && esArrayDeTextos(n.initializer)) reportar(n, 'R4');
    } else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)
      && CONST_ROLES.test(n.name.text) && !CONST_PERMITIDAS.has(n.name.text)
      && n.initializer && esColeccionDeTextos(n.initializer)) {
      reportar(n, 'R5');
    }
    ts.forEachChild(n, visitar);
  };
  visitar(sf);
  return hallazgos;
}

function listar(dir, acc = []) {
  for (const nombre of readdirSync(dir)) {
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) { if (nombre !== 'node_modules') listar(ruta, acc); continue; }
    if (!/\.(ts|tsx)$/.test(nombre) || /\.test\.tsx?$/.test(nombre) || nombre.endsWith('.d.ts')) continue;
    acc.push(ruta);
  }
  return acc;
}

/**
 * Recorre el árbol y aplica las excepciones. Devuelve `{ errores: string[], exentos: string[] }`.
 * `excepciones` y `leer` son inyectables para el test (p. ej. quitar una excepción → M3).
 */
export function verificar({ raiz = process.cwd(), dir = 'apps/web/src', excepciones = EXCEPCIONES, ficheros } = {}) {
  const errores = [];
  const exentos = [];
  const entradas = ficheros ?? listar(join(raiz, dir)).map((ruta) => ({
    rel: relative(raiz, ruta).split(sep).join('/'),
    codigo: readFileSync(ruta, 'utf8'),
  }));
  const vistos = new Map();
  for (const { rel, codigo } of entradas) {
    const hs = analizar(codigo, rel);
    if (hs.length === 0) continue;
    const exc = excepciones[rel];
    if (exc) {
      vistos.set(rel, hs.length);
      if (hs.length === exc.veces) {
        exentos.push(...hs.map((h) => `${rel}:${h.linea} [${h.regla}] (excepción: ${exc.motivo})`));
        continue;
      }
      errores.push(`${rel}: la excepción declara ${exc.veces} hallazgo(s) y hay ${hs.length}.`);
    }
    errores.push(...hs.map((h) => `${rel}:${h.linea} [${h.regla}] ${h.texto}`));
  }
  if (!ficheros) {
    for (const rel of Object.keys(excepciones)) {
      if (!vistos.has(rel)) errores.push(`${rel}: excepción sin hallazgos — retírala de EXCEPCIONES.`);
    }
  }
  return { errores, exentos };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { errores, exentos } = verificar();
  for (const e of exentos) console.log(`  exento  ${e}`);
  if (errores.length) {
    console.error('check:roles-web — la web decide acceso por el nombre del rol (HU #12872, AC8):');
    for (const e of errores) console.error(`  ${e}`);
    console.error('Usa hasPage(…) / hasFuncion(…) con la función de la guarda del servidor.');
    process.exit(1);
  }
  console.log(`check:roles-web — OK: ningún nombre de rol decide acceso en apps/web/src (${exentos.length} exento(s) declarado(s)).`);
}
