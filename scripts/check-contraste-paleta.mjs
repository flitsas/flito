// Bug #11720 — gate de contraste de la CommandPalette en tema oscuro.
//
// La paleta (⌘K) es una de las dos únicas superficies del shell que INVIERTEN su fondo en
// oscuro. Su texto no invierte: usa los tokens FLIT, que son invariantes a propósito. El
// resultado fue tinta oscura sobre fondo oscuro — el ítem activo daba ratio 1,00, el mismo
// color exacto, y la opción seleccionada era invisible.
//
// Este gate existe porque ese fallo NO lo atrapa nadie más: `axe` no es dependencia del repo
// y el CI no ejecuta E2E, así que los specs de accesibilidad no corren en el pipeline. Sin
// esto, la corrección se puede deshacer en un `git blame` sin que salte ninguna alarma.
//
// Lee los valores del CSS REAL y recompone la cadena de superficies, en vez de comparar
// contra una lista de ratios copiada a mano: si alguien cambia un hex o el alfa de un fondo,
// el gate remide y responde con el número nuevo. Un gate que compara contra su propia foto
// no protege nada.
//
// Uso local: `npm run check:contraste`.

import { readFileSync } from 'node:fs';

const INDEX_CSS = 'apps/web/src/index.css';
const TOKENS_CSS = 'apps/web/src/styles/tokens.css';
const FLIT_TOKENS_CSS = 'apps/web/src/styles/flit-tokens.css';

// Mínimo WCAG 2.x AA para texto normal (SC 1.4.3). El kit ya se rige por él (Bug #11604).
const MINIMO = 4.5;

const index = readFileSync(INDEX_CSS, 'utf8');
const tokens = readFileSync(TOKENS_CSS, 'utf8');

// ── Color ────────────────────────────────────────────────────────────────────────────────
const canal = (c) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const rgb = (hex) => {
  const h = hex.replace('#', '');
  const l = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
  return [0, 2, 4].map((i) => parseInt(l.slice(i, i + 2), 16));
};
const luminancia = ([r, g, b]) => 0.2126 * canal(r) + 0.7152 * canal(g) + 0.0722 * canal(b);
const ratio = (a, b) => {
  const [x, y] = [luminancia(a), luminancia(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
/** Compone `fg` con alfa sobre `bg` (ambos ya en triplete). */
const sobre = (fg, alfa, bg) => fg.map((c, i) => Math.round(c * alfa + bg[i] * (1 - alfa)));

// ── Extracción del CSS ───────────────────────────────────────────────────────────────────
// Si un selector se renombra, el gate FALLA en vez de aprobar por no encontrar nada: un
// `match` a null que se tratara como «sin problema» sería un gate que se apaga solo.
function extraer(css, archivo, selector, propiedad) {
  const bloque = css.match(
    new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`),
  );
  if (!bloque) throw new Error(`No se encontró el selector "${selector}" en ${archivo}.`);
  const valor = bloque[1].match(new RegExp(`(?:^|;)\\s*${propiedad}\\s*:\\s*([^;]+)`));
  if (!valor) throw new Error(`"${selector}" existe en ${archivo} pero no declara "${propiedad}".`);
  return valor[1].trim();
}

// Los tokens `--flit-*` son colores planos declarados una sola vez. Se resuelven porque la
// regresión más probable de este gate no es un hex raro: es que alguien devuelva una de estas
// reglas a `var(--flit-bg-app)` o `var(--flit-text-primary)` — que es exactamente el estado
// que causó el bug. Sin resolverlos, el gate moriría con un error de parseo en vez de decir
// «esto da 1,00», y un fallo ilegible se acaba silenciando.
const flitTokens = readFileSync(FLIT_TOKENS_CSS, 'utf8');
function resolverVar(valor) {
  const ref = valor.match(/var\(\s*(--[\w-]+)\s*\)/);
  if (!ref) return valor;
  for (const css of [flitTokens, tokens, index]) {
    const decl = css.match(new RegExp(`${ref[1]}\\s*:\\s*([^;]+)`));
    if (decl) return decl[1].trim();
  }
  throw new Error(`No se pudo resolver ${ref[1]}: no está declarado en los CSS de tokens.`);
}

/** Acepta `#rrggbb`, `rgba(r, g, b, a)` o un `var(--token)` que resuelva a uno de los dos. */
function parsear(valorCrudo, etiqueta) {
  const valor = resolverVar(valorCrudo);
  const hex = valor.match(/#[0-9a-f]{3,6}/i);
  if (hex) return { color: rgb(hex[0]), alfa: 1 };
  const fn = valor.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\s*\)/i);
  if (!fn) throw new Error(`No se pudo interpretar el color de ${etiqueta}: "${valor}".`);
  return { color: [+fn[1], +fn[2], +fn[3]], alfa: fn[4] === undefined ? 1 : +fn[4] };
}

const leer = (css, archivo, selector, propiedad) =>
  parsear(extraer(css, archivo, selector, propiedad), `${selector} { ${propiedad} }`);

const PALETA = "[data-theme='dark'] .flit-shell-palette";

const pagina = leer(tokens, TOKENS_CSS, ":root[data-theme='dark']", '--color-surface');
const overlay = leer(index, INDEX_CSS, '.flit-shell-overlay', 'background');
const panelBg = leer(index, INDEX_CSS, PALETA, 'background');
const sunkenBg = leer(index, INDEX_CSS, `${PALETA} .flit-shell-sunken`, 'background');
const kbdBg = leer(index, INDEX_CSS, `${PALETA} kbd`, 'background');
const activoBg = leer(index, INDEX_CSS, '.flit-shell-active', 'background');
const hoverBg = leer(index, INDEX_CSS, "[data-theme='dark'] .flit-shell-hover:hover", 'background');

const muted = leer(index, INDEX_CSS, `${PALETA} .flit-shell-muted`, 'color').color;
const secundario = leer(index, INDEX_CSS, `${PALETA} .flit-shell-secondary`, 'color').color;
const primario = leer(index, INDEX_CSS, `${PALETA} .flit-shell-primary`, 'color').color;
const acento = leer(index, INDEX_CSS, `${PALETA} .flit-shell-accent`, 'color').color;

// ── Composición real de superficies ──────────────────────────────────────────────────────
// página → overlay del modal → panel de la paleta → (barra hundida | kbd | ítem activo).
const trasOverlay = sobre(overlay.color, overlay.alfa, pagina.color);
const panel = sobre(panelBg.color, panelBg.alfa, trasOverlay);
const sunken = sobre(sunkenBg.color, sunkenBg.alfa, panel);
const kbd = sobre(kbdBg.color, kbdBg.alfa, panel);
const activo = sobre(activoBg.color, activoBg.alfa, panel);
const hover = sobre(hoverBg.color, hoverBg.alfa, panel);

// Cada punto de TEXTO de CommandPalette.tsx, con la superficie sobre la que cae de verdad.
const CASOS = [
  ['fila de búsqueda — texto tecleado', primario, sunken],
  ['fila de búsqueda — icono y placeholder', muted, sunken],
  ['fila de búsqueda — tecla «esc»', muted, sunken],
  ['cabecera de sección', muted, panel],
  ['ítem no activo', secundario, panel],
  ['ítem no activo en hover', primario, hover],
  ['ítem ACTIVO', primario, activo],
  ['ítem activo — tecla ↵', acento, kbd],
  ['vacío — «Sin resultados»', secundario, panel],
  ['vacío — la consulta buscada', primario, panel],
  ['vacío — pista de cierre', muted, panel],
  ['pie — texto', muted, sunken],
  ['pie — teclas ↑↓ y ↵', muted, kbd],
];

const hex = (c) => '#' + c.map((x) => x.toString(16).padStart(2, '0')).join('');
console.log(`Fondos compuestos — panel ${hex(panel)} · barra ${hex(sunken)} · kbd ${hex(kbd)} · activo ${hex(activo)}\n`);

let fallos = 0;
for (const [nombre, fg, bg] of CASOS) {
  const r = ratio(fg, bg);
  const ok = r >= MINIMO;
  if (!ok) fallos++;
  console.log(`${ok ? '✓' : '✗'} ${nombre.padEnd(38)} ${hex(fg)} sobre ${hex(bg)} → ${r.toFixed(2)}`);
}

if (fallos > 0) {
  console.error(
    `\n✗ ${fallos} punto(s) de la CommandPalette bajo ${MINIMO}:1 en tema oscuro (Bug #11720).` +
      '\n  Ojo al orden: si aclaras la tinta, oscurece ANTES las superficies internas' +
      ' (.flit-shell-sunken y kbd), o hundirás el buscador y las teclas del pie.',
  );
  process.exit(1);
}
console.log(`\n✓ Los ${CASOS.length} puntos de la CommandPalette cumplen ${MINIMO}:1 en tema oscuro.`);
