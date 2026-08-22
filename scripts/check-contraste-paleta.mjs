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
// ── RETRABAJO (el gate se saltaba la superficie que decía vigilar) ────────────────────────
// La primera versión de este archivo salió VERDE sobre una pantalla que incumplía: recomponía
// bien los colores, pero se equivocaba de PADRE. Componía las teclas sobre el panel cuando en
// el DOM las cinco cuelgan de una barra `.flit-shell-sunken` o del ítem activo, y ponía debajo
// del overlay el fondo oscuro del `body` cuando lo que hay ahí es `.flit-app`, que no invierte
// y es CLARO. Cuatro capas translúcidas encadenadas: equivocarse en una arrastra a las demás.
//
// De ahí las dos reglas de este archivo:
//   1. Cada caso nombra la superficie sobre la que el texto cae DE VERDAD, y ese emparejamiento
//      se contrasta con el DOM de `CommandPalette.tsx` cuando se toca cualquiera de los dos.
//   2. Este gate NO es la última palabra: quien manda es el píxel. La comprobación de verdad
//      vive en `apps/web/e2e/tests/command-palette-oscuro.spec.ts`, que abre la paleta en
//      oscuro y lee lo que el compositor dejó en pantalla. Este script es el que puede correr
//      en CI (no necesita navegador) y por eso existe, pero si los dos discrepan, el que está
//      mal es este.
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
//
// Se compara selector A SELECTOR en vez de buscar «el texto seguido de {» por dos motivos que
// costaron caro: una lista `A,\nB { … }` no la encontraba NINGUNA de las dos formas (y las
// listas aparecen en cuanto una regla necesita ganar la cascada), y el texto suelto también
// casaba dentro de un comentario, que es CSS que no pinta nada.
const sinComentarios = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

function extraer(css, archivo, selector, propiedad) {
  const objetivo = selector.replace(/\s+/g, ' ').trim();
  let encontrado = false;
  for (const [, selectores, cuerpo] of sinComentarios(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const lista = selectores.split(',').map((s) => s.replace(/\s+/g, ' ').trim());
    if (!lista.includes(objetivo)) continue;
    encontrado = true;
    const valor = cuerpo.match(new RegExp(`(?:^|;)\\s*${propiedad}\\s*:\\s*([^;]+)`));
    // Se sigue buscando si esta regla no declara la propiedad: puede estar en otra del mismo
    // selector. Sólo cuando no aparece en ninguna se distingue «no existe el selector» de
    // «existe pero no declara eso», que son dos averías distintas y se arreglan distinto.
    if (valor) return valor[1].trim();
  }
  if (!encontrado) throw new Error(`No se encontró el selector "${selector}" en ${archivo}.`);
  throw new Error(`"${selector}" existe en ${archivo} pero no declara "${propiedad}".`);
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
    const decl = sinComentarios(css).match(new RegExp(`${ref[1]}\\s*:\\s*([^;]+)`));
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

// Lo que hay DETRÁS del overlay no es el `body` sino el shell de la app, y el shell no invierte
// en oscuro: `.flit-app` pinta --flit-bg-app (#EAF2FF) en los dos temas. Tomar el
// `--color-surface` oscuro del body daba un panel 0,3 más oscuro del que se pinta —el body
// queda tapado por un shell `min-h-screen`— y con él todos los ratios salían regalados.
// Peor caso admitido: detrás del panel puede haber una tarjeta blanca en vez del fondo de la
// app; son ~0,02 de ratio, dentro del margen con el que se eligieron las tintas.
const pagina = leer(flitTokens, FLIT_TOKENS_CSS, '.flit-app', 'background');
const overlay = leer(index, INDEX_CSS, '.flit-shell-overlay', 'background');
const panelBg = leer(index, INDEX_CSS, PALETA, 'background');
const sunkenBg = leer(index, INDEX_CSS, `${PALETA} .flit-shell-sunken`, 'background');
// A propósito el selector CON la clase, que es el que gana la cascada (0,3,1): las cinco teclas
// llevan `flit-shell-sunken`, así que leer `${PALETA} kbd` a secas devolvería una regla que el
// navegador descarta. Un gate que mide CSS muerto miente igual que uno que se equivoca de padre.
const kbdBg = leer(index, INDEX_CSS, `${PALETA} kbd.flit-shell-sunken`, 'background');
const activoBg = leer(index, INDEX_CSS, '.flit-shell-active', 'background');
const hoverBg = leer(index, INDEX_CSS, "[data-theme='dark'] .flit-shell-hover:hover", 'background');

const muted = leer(index, INDEX_CSS, `${PALETA} .flit-shell-muted`, 'color').color;
// El placeholder es su propio punto: no hereda de `.flit-shell-muted` ni lo pinta ninguna clase
// del TSX, sino esta regla. Si desaparece, vuelve el currentColor al 50 % del preflight (4,41).
const placeholder = leer(index, INDEX_CSS, `${PALETA} ::placeholder`, 'color').color;
const secundario = leer(index, INDEX_CSS, `${PALETA} .flit-shell-secondary`, 'color').color;
const primario = leer(index, INDEX_CSS, `${PALETA} .flit-shell-primary`, 'color').color;
const acento = leer(index, INDEX_CSS, `${PALETA} .flit-shell-accent`, 'color').color;

// ── Composición real de superficies ──────────────────────────────────────────────────────
// shell de la app → overlay del modal → panel de la paleta → (barra hundida | ítem activo) →
// tecla. NINGUNA tecla cuelga del panel a pelo: las tres de la fila de búsqueda y del pie
// caen sobre una barra `.flit-shell-sunken`, la del ítem seleccionado sobre `.flit-shell-active`
// y sólo la del estado vacío cae sobre el panel. Ese detalle —qué hay debajo de cada tecla— es
// el que se saltó la primera versión del gate y el que dejó pasar la regresión.
const trasOverlay = sobre(overlay.color, overlay.alfa, pagina.color);
const panel = sobre(panelBg.color, panelBg.alfa, trasOverlay);
const sunken = sobre(sunkenBg.color, sunkenBg.alfa, panel);
const activo = sobre(activoBg.color, activoBg.alfa, panel);
const hover = sobre(hoverBg.color, hoverBg.alfa, panel);
/** Una tecla no tiene color propio: tiene el de su fondo compuesto sobre lo que la aloja. */
const tecla = (superficie) => sobre(kbdBg.color, kbdBg.alfa, superficie);
const teclaEnBarra = tecla(sunken);
const teclaEnPanel = tecla(panel);
const teclaEnActivo = tecla(activo);

// Cada punto de TEXTO de CommandPalette.tsx, con la superficie sobre la que cae de verdad.
const CASOS = [
  ['fila de búsqueda — texto tecleado', primario, sunken],
  ['fila de búsqueda — icono de lupa', muted, sunken],
  ['fila de búsqueda — placeholder', placeholder, sunken],
  ['fila de búsqueda — tecla «esc»', muted, teclaEnBarra],
  ['cabecera de sección', muted, panel],
  ['ítem no activo', secundario, panel],
  // `hover:flit-shell-primary` no es una utilidad de Tailwind y nunca generó regla: el ítem
  // apuntado conserva la tinta secundaria. Se comprueba lo que se pinta, no lo que se quiso.
  ['ítem no activo en hover', secundario, hover],
  ['ítem ACTIVO', primario, activo],
  ['ítem activo — tecla ↵', acento, teclaEnActivo],
  ['vacío — «Sin resultados»', secundario, panel],
  ['vacío — la consulta buscada', primario, panel],
  ['vacío — pista de cierre', muted, panel],
  ['vacío — tecla «Esc» de la pista', muted, teclaEnPanel],
  ['pie — texto y recuento', muted, sunken],
  ['pie — teclas ↑↓ y ↵', muted, teclaEnBarra],
];

const hex = (c) => '#' + c.map((x) => x.toString(16).padStart(2, '0')).join('');
console.log(
  `Fondos compuestos — panel ${hex(panel)} · barra ${hex(sunken)} · activo ${hex(activo)} · hover ${hex(hover)}\n`
  + `Teclas — sobre la barra ${hex(teclaEnBarra)} · sobre el panel ${hex(teclaEnPanel)} · sobre el ítem activo ${hex(teclaEnActivo)}\n`,
);

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
      '\n  Antes de tocar una tinta, mira QUÉ HAY DEBAJO: las capas translúcidas se acumulan y' +
      '\n  aclarar el texto de un punto puede hundir otro. Y si cambias el DOM de' +
      '\n  CommandPalette.tsx, revisa que cada caso de CASOS siga nombrando la superficie real:' +
      '\n  este gate no lee el DOM, así que un `kbd` que se mude de padre no se entera solo.' +
      '\n  La medición sobre el píxel está en e2e/tests/command-palette-oscuro.spec.ts.',
  );
  process.exit(1);
}
console.log(`\n✓ Los ${CASOS.length} puntos de la CommandPalette cumplen ${MINIMO}:1 en tema oscuro.`);
