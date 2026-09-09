// HU #12222 — gate del favicon: todo `<link rel="icon">` de `index.html` debe existir en `public/`
// y llegar intacto a `dist/`.
//
// ── Qué protege ───────────────────────────────────────────────────────────────────────────────
//
// `apps/web/index.html` declaraba `<link rel="icon" type="image/svg+xml" href="/favicon.svg" />`
// desde hacía meses. El archivo NO existía. Y el fallo era invisible de punta a punta: el navegador
// pedía `/favicon.svg`, el `try_files $uri $uri/ /index.html` de `nginx.conf.template` le devolvía el
// `index.html` del SPA con **estado 200**, y el navegador —que no puede pintar HTML como ícono— caía
// en silencio al genérico. Sin 404 no hay error observable: ni el build, ni el lint, ni el typecheck,
// ni los E2E vieron nunca nada. Es la misma clase de fallo que la copia manual del worker de pdf.js
// (HU #11775, `check-pdf-worker.mjs`): un archivo de `public/` que deja de corresponder, con el CI
// entero en verde.
//
// Un E2E no sirve como aserto de regresión aquí: correría contra el dev server de Vite, que sí sirve
// el MIME correcto, y daría verde con y sin el defecto. Por eso el aserto vive en este gate, que mira
// el disco.
//
// ── Reglas ────────────────────────────────────────────────────────────────────────────────────
//
//   1. Recuento versionado de links de ícono con href a la raíz (ESPERADOS).
//   2. Cada href declarado existe en `apps/web/public/`.
//   3. Cada href existe en `apps/web/dist/` y es BYTE-IDÉNTICO al de `public/` (solo si hay build).
//
// Uso: node scripts/check-favicon.mjs
// Exit 1 nombrando el archivo ausente y la LÍNEA de index.html que lo declara.

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROPIO = fileURLToPath(import.meta.url);
const ROOT = process.cwd();

const INDEX = 'apps/web/index.html';
const PUBLIC_DIR = 'apps/web/public';
const DIST_DIR = 'apps/web/dist';

// ── Constante versionada ──────────────────────────────────────────────────────────────────────
//
// Recuento de `<link rel="icon">` con href a la raíz. NO es cosmético: sin él, «0 links
// encontrados» contaría como éxito y el gate se saltaría a sí mismo — que es EXACTAMENTE el estado
// del que venimos, sólo que al revés (link sin archivo). Falla en las dos direcciones a propósito:
//   · si BAJA → se borró un link del <head>; que un humano confirme que fue intencional.
//   · si SUBE → hay un ícono nuevo; comprueba que su archivo está en public/ y sube el número en el
//               mismo commit.
// Hoy son 2: el SVG (que los navegadores modernos prefieren) y el .ico de respaldo 32×32+16×16.
const ESPERADOS = 2;

const rel = (p) => relative(ROOT, p) || p;

// ── Lectura y despiece del <head> ─────────────────────────────────────────────────────────────

const indexAbs = resolve(ROOT, INDEX);
if (!existsSync(indexAbs)) {
  console.error(`✗ No existe ${INDEX}: no hay <head> que auditar.`);
  process.exit(1);
}
const html = readFileSync(indexAbs, 'utf8');

/**
 * Neutraliza los comentarios HTML conservando el número de bytes y los saltos de línea. Un
 * `<link rel="icon">` comentado no declara nada y no puede hacer fallar el gate; preservar las
 * posiciones es lo que mantiene exactos los números de línea que reportamos.
 */
const sinComentarios = html.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));

/** Línea 1-based del offset `i`. */
const lineaDe = (i) => sinComentarios.slice(0, i).split('\n').length;

/** Extrae los atributos de una etiqueta, tolerante a comillas simples/dobles y orden. */
function atributos(tag) {
  const attrs = {};
  const re = /([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(tag)) !== null) attrs[m[1].toLowerCase()] = m[3] ?? m[4] ?? '';
  return attrs;
}

const links = [];
const reLink = /<link\b[^>]*>/gi;
let m;
while ((m = reLink.exec(sinComentarios)) !== null) {
  const attrs = atributos(m[0]);
  // `rel` admite lista separada por espacios (`shortcut icon`): se mira token a token, no la cadena
  // entera, para que `rel="shortcut icon"` cuente igual que `rel="icon"`.
  const rels = (attrs.rel ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!rels.includes('icon')) continue;
  links.push({ href: attrs.href ?? '', line: lineaDe(m.index), tag: m[0].trim() });
}

// Sólo se auditan los href servidos desde la raíz del sitio (`/algo`), que es lo que sale de
// `public/`. Un data: URI o una URL absoluta no tiene archivo que comparar; se listan como omitidos
// en vez de darse por buenos en silencio.
const raiz = links.filter((l) => /^\/[^/]/.test(l.href));
const omitidos = links.filter((l) => !/^\/[^/]/.test(l.href));

const hayDist = existsSync(resolve(ROOT, DIST_DIR));

console.log(
  `check:favicon · ${INDEX} — ${links.length} <link rel="icon">, ${raiz.length} con href a la raíz ` +
    `(esperados: ${ESPERADOS}); dist/: ${hayDist ? 'presente' : 'AUSENTE (comparación omitida)'}`,
);
for (const o of omitidos) {
  console.log(`  · omitido (href no sirve desde public/): ${INDEX}:${o.line}  href="${o.href}"`);
}

let fallo = false;
const error = (msg) => {
  fallo = true;
  console.error(msg);
};

// ── Regla 1 — recuento versionado ─────────────────────────────────────────────────────────────
if (raiz.length !== ESPERADOS) {
  error(
    `\n✗ [regla 1] Links de ícono con href a la raíz: ${raiz.length}, esperados ${ESPERADOS} ` +
      `(ESPERADOS en ${rel(PROPIO)}).\n` +
      (raiz.length < ESPERADOS
        ? '  Se quitó un `<link rel="icon">` del <head>. Si fue intencional, baja ESPERADOS en el\n' +
          '  mismo commit; si no, el navegador se quedó sin esa variante del ícono.'
        : '  Hay un `<link rel="icon">` nuevo. Comprueba que su archivo está versionado en\n' +
          `  ${PUBLIC_DIR}/ y sube ESPERADOS a ${raiz.length} en el mismo commit que lo añade.`),
  );
}

// ── Reglas 2 y 3 — el archivo existe y llega intacto al build ─────────────────────────────────
for (const l of raiz) {
  const nombre = l.href.replace(/^\//, '').split(/[?#]/)[0];
  const enPublic = resolve(ROOT, PUBLIC_DIR, nombre);
  const enDist = resolve(ROOT, DIST_DIR, nombre);

  // Contención: el filtro de arriba acepta `/../x` (tras la barra inicial, `.` satisface `[^/]`) y
  // `resolve()` colapsa los `..`, así que la ruta se saldría de public/. Un href de ícono nombra un
  // archivo DENTRO de public/, nunca una ruta hacia fuera.
  if (!enPublic.startsWith(resolve(ROOT, PUBLIC_DIR) + sep)) {
    error(
      `\n✗ [regla 2] ${INDEX}:${l.line} declara href="${l.href}", que escapa de ${PUBLIC_DIR}/.\n` +
        `  Resuelve a ${enPublic}. Un href de ícono nombra un archivo dentro de ${PUBLIC_DIR}/.`,
    );
    continue;
  }

  if (!existsSync(enPublic) || !statSync(enPublic).isFile()) {
    error(
      `\n✗ [regla 2] ${INDEX}:${l.line} declara href="${l.href}" y NO existe ${join(PUBLIC_DIR, nombre)}.\n` +
        `  Declaración: ${l.tag}\n` +
        '  Un href sin archivo NO da 404: el `try_files $uri $uri/ /index.html` de nginx devuelve el\n' +
        '  index.html del SPA con estado 200, el navegador no puede pintarlo como ícono y cae al\n' +
        '  genérico sin un solo error en consola. Versiona el archivo o quita el link.',
    );
    continue;
  }

  if (!hayDist) continue; // regla 3 sólo tiene sentido tras `npm run build:web`.

  if (!existsSync(enDist) || !statSync(enDist).isFile()) {
    error(
      `\n✗ [regla 3] ${INDEX}:${l.line} declara href="${l.href}", que existe en ${PUBLIC_DIR}/ pero NO\n` +
        `  en ${DIST_DIR}/. El artefacto desplegado no lo tendría: en producción el navegador pediría\n` +
        `  ${l.href} y recibiría el index.html del SPA con estado 200.`,
    );
    continue;
  }

  const bytesPublic = readFileSync(enPublic);
  const bytesDist = readFileSync(enDist);
  if (!bytesPublic.equals(bytesDist)) {
    error(
      `\n✗ [regla 3] ${INDEX}:${l.line} — ${nombre} DIFIERE entre fuente y build:\n` +
        `    · ${join(PUBLIC_DIR, nombre)}  ${bytesPublic.length} B\n` +
        `    · ${join(DIST_DIR, nombre)}  ${bytesDist.length} B\n` +
        '  Lo que se despliega no es lo que entregó diseño. La fuente de verdad es public/.',
    );
    continue;
  }

  console.log(
    `  ✓ ${l.href} — ${join(PUBLIC_DIR, nombre)} (${bytesPublic.length} B)` +
      ` ≡ ${join(DIST_DIR, nombre)}  [${INDEX}:${l.line}]`,
  );
}

if (fallo) {
  console.error(`\nGate check:favicon en ROJO. Contrato completo en la cabecera de ${rel(PROPIO)}.`);
  process.exit(1);
}

// El símbolo distingue el verde pleno del degradado: en el resumen de GitHub Actions nadie abre el
// log de un paso en verde, así que un `✓` sin comparación contra dist/ sería indistinguible de una
// comprobación completa — exactamente el fallo silencioso que este gate existe para impedir.
console.log(
  (hayDist ? '✓' : '⚠') +
    ` Los ${raiz.length} íconos declarados en ${INDEX} existen en ${PUBLIC_DIR}/` +
    (hayDist ? ` y llegan byte a byte a ${DIST_DIR}/.` : ' — SIN comparar contra dist/: falta `npm run build:web`.'),
);
