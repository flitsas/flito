// Bug #11720 (tema oscuro) · Bug #11767 (tema CLARO) — gate de contraste de la CommandPalette.
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
// ── RETRABAJO 1 (el gate se saltaba la superficie que decía vigilar) ──────────────────────
// La primera versión de este archivo salió VERDE sobre una pantalla que incumplía: recomponía
// bien los colores, pero se equivocaba de PADRE. Componía las teclas sobre el panel cuando en
// el DOM las cinco cuelgan de una barra `.flit-shell-sunken` o del ítem activo, y ponía debajo
// del overlay el fondo oscuro del `body` cuando lo que hay ahí es `.flit-app`, que no invierte
// y es CLARO. Cuatro capas translúcidas encadenadas: equivocarse en una arrastra a las demás.
//
// ── AMPLIACIÓN A TEMA CLARO (Bug #11767) ─────────────────────────────────────────────────
// El gate sólo miraba el tema oscuro, que es el minoritario: el claro es el de por defecto.
// Al medirlo aparecieron tres puntos por debajo de AA que llevaban ahí desde siempre, y los
// tres por el MISMO motivo de fondo — dar por supuesto el fondo en vez de componerlo:
//
//   · el `::placeholder`, que en claro no lo pintaba ninguna regla sino el preflight de Tailwind
//     (`color-mix(in oklab, currentcolor 50%, transparent)`, o sea la tinta del input al 50 %);
//   · la tinta `muted` sobre el PANEL, que no es blanco puro: `rgba(255,255,255,.98)` deja
//     pasar un 2 % del overlay ya oscurecido y compone #fdfdfd, donde #646e82 caía a 4,46
//     (sobre blanco puro da 5,13, y ése es el número con el que se eligió el token);
//   · la tecla ↵ del ítem activo, que se dio por buena en 4,49 «sobre el fondo claro que ese
//     kbd tenía» — pero ese fondo era el `bg-white` que el propio #11720 demostró MUERTO. Lo
//     que pinta la tecla es `.flit-shell-sunken` (#eaf2ff), donde --flit-blue daba 3,99.
//
// Por eso esta versión ya no pregunta «¿qué dice el selector que yo creo que gana?», sino que
// resuelve la CASCADA entre todos los candidatos que pintan cada elemento (ver `ganadora`):
// especificidad y, en empate, orden de aparición. Es lo mismo que hace el navegador, y es la
// única forma de que el gate no vuelva a medir CSS muerto ni a saltarse un override.
//
// De ahí las tres reglas de este archivo:
//   1. Cada caso nombra la superficie sobre la que el texto cae DE VERDAD, y ese emparejamiento
//      se contrasta con el DOM de `CommandPalette.tsx` cuando se toca cualquiera de los dos.
//   2. Cada color se pide con TODOS los selectores que compiten por él; el ganador lo decide
//      la cascada, no el orden en que se escribió la lista.
//   3. Este gate NO es la última palabra: quien manda es el píxel. La comprobación de verdad
//      vive en `apps/web/e2e/tests/command-palette-oscuro.spec.ts` y en
//      `apps/web/e2e/tests/command-palette-claro.spec.ts`, que abren la paleta y leen lo que
//      el compositor dejó en pantalla. Este script es el que puede correr en CI (no necesita
//      navegador) y por eso existe, pero si los dos discrepan, el que está mal es este.
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
/** Un color listo para medir: opaco, ya compuesto sobre la superficie que le toca. */
const opaco = ({ color, alfa }, fondo) => (alfa === 1 ? color : sobre(color, alfa, fondo));

// ── Extracción del CSS ───────────────────────────────────────────────────────────────────
// Si un selector se renombra, el gate FALLA en vez de aprobar por no encontrar nada: un
// `match` a null que se tratara como «sin problema» sería un gate que se apaga solo.
//
// Se compara selector A SELECTOR en vez de buscar «el texto seguido de {» por dos motivos que
// costaron caro: una lista `A,\nB { … }` no la encontraba NINGUNA de las dos formas (y las
// listas aparecen en cuanto una regla necesita ganar la cascada), y el texto suelto también
// casaba dentro de un comentario, que es CSS que no pinta nada.
const sinComentarios = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const cacheReglas = new Map();
/** Todas las reglas del archivo, con su posición: `[{ selectores, cuerpo, pos }]`. */
function reglas(css) {
  const cacheada = cacheReglas.get(css);
  if (cacheada) return cacheada;
  const lista = [];
  for (const m of sinComentarios(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectores = m[1].split(',').map((s) => s.replace(/\s+/g, ' ').trim());
    // Las at-rules (`@media …`) no son selectores: si alguna se colara como tal, el gate
    // mediría una regla cuyo scope no entiende. Ninguno de los objetivos vive dentro de una,
    // así que se descartan en vez de fingir que se soportan.
    if (selectores.some((s) => s.startsWith('@'))) continue;
    lista.push({ selectores, cuerpo: m[2], pos: m.index });
  }
  cacheReglas.set(css, lista);
  return lista;
}

/**
 * Especificidad (a,b,c) del selector, aplanada a un número comparable.
 * Cubre lo que este CSS usa: clases, atributos, pseudo-clases, tipos y pseudo-elementos.
 * No hay `#id` en el shell, pero se cuenta igual para que un futuro no lo invierta en silencio.
 */
function especificidad(sel) {
  const s = sel.replace(/\s+/g, ' ').trim();
  const cuenta = (re) => (s.match(re) ?? []).length;
  const ids = cuenta(/#[A-Za-z_-][\w-]*/g);
  const clases = cuenta(/\.[A-Za-z_-][\w-]*/g) + cuenta(/\[[^\]]+\]/g) + cuenta(/(?<!:):[a-z-]+/gi);
  const tipos = cuenta(/(?:^|[\s>+~])[a-z][\w-]*/gi) + cuenta(/::[a-z-]+/gi);
  return ids * 10000 + clases * 100 + tipos;
}

/**
 * Declaración GANADORA de `propiedad` entre todos los `selectores` que pintan el mismo
 * elemento: gana la mayor especificidad y, en empate, la que aparece más abajo en el archivo.
 *
 * Esto es lo que arregla el error de modelo que arrastraba el gate: el panel de la paleta lleva
 * a la vez `.flit-shell-palette` y `.flit-shell-sunken` —dos reglas de la MISMA especificidad,
 * decide el orden—, las teclas llevan `kbd.flit-shell-sunken` además de la clase suelta, y en
 * claro las tintas de la paleta se resuelven contra la clase base si nadie las sobreescribe.
 * Preguntar por un único selector es dar por buena una respuesta que la cascada puede cambiar.
 *
 * Devuelve `null` si NINGÚN selector existe y `obligatorio` es false (lo usa el `::placeholder`,
 * que a propósito puede no tener regla: entonces lo pinta el preflight). Con `obligatorio`
 * distingue además «no existe el selector» de «existe pero no declara eso», que son dos averías
 * distintas y se arreglan distinto.
 */
function ganadora(css, archivo, selectores, propiedad, { obligatorio = true } = {}) {
  const objetivos = selectores.map((s) => s.replace(/\s+/g, ' ').trim());
  let mejor = null;
  let algunSelector = false;
  for (const regla of reglas(css)) {
    for (const objetivo of objetivos) {
      if (!regla.selectores.includes(objetivo)) continue;
      algunSelector = true;
      const valor = regla.cuerpo.match(new RegExp(`(?:^|;)\\s*${propiedad}\\s*:\\s*([^;]+)`));
      // Se sigue buscando si esta regla no declara la propiedad: puede estar en otra del mismo
      // selector.
      if (!valor) continue;
      const peso = especificidad(objetivo);
      if (mejor === null || peso > mejor.peso || (peso === mejor.peso && regla.pos > mejor.pos)) {
        mejor = { valor: valor[1].trim(), peso, pos: regla.pos, selector: objetivo };
      }
    }
  }
  if (mejor) return mejor;
  if (!obligatorio) return null;
  if (!algunSelector) {
    throw new Error(`No se encontró ninguno de [${selectores.join(' | ')}] en ${archivo}.`);
  }
  throw new Error(
    `[${selectores.join(' | ')}] existe(n) en ${archivo} pero no declara(n) "${propiedad}".`,
  );
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

const leer = (css, archivo, selectores, propiedad, opciones) => {
  const decl = ganadora(css, archivo, selectores, propiedad, opciones);
  if (!decl) return null;
  return parsear(decl.valor, `${decl.selector} { ${propiedad} }`);
};

const PALETA = '.flit-shell-palette';
const DARK = "[data-theme='dark']";
const hex = (c) => '#' + c.map((x) => x.toString(16).padStart(2, '0')).join('');

// ── Modelo de la paleta, tema a tema ─────────────────────────────────────────────────────
function medirTema(tema) {
  const oscuro = tema === 'oscuro';
  /**
   * Todos los selectores que COMPITEN por pintar un elemento con la clase `base` dentro de la
   * paleta: la clase suelta, su versión acotada al panel y, en oscuro, las dos con el prefijo
   * de tema. El orden de esta lista no decide nada —lo decide `ganadora`—, sólo hace legible
   * el mensaje de error.
   */
  const variantes = (base, { enPaleta = true } = {}) => {
    const lista = [];
    if (oscuro && enPaleta) lista.push(`${DARK} ${PALETA} ${base}`);
    if (oscuro) lista.push(`${DARK} ${base}`);
    if (enPaleta) lista.push(`${PALETA} ${base}`);
    lista.push(base);
    return [...new Set(lista)];
  };
  const enIndex = (selectores, propiedad, opciones) =>
    leer(index, INDEX_CSS, selectores, propiedad, opciones);

  // ── Superficies ────────────────────────────────────────────────────────────────────────
  // Lo que hay DETRÁS del overlay no es el `body` sino el shell de la app, y el shell no invierte
  // en oscuro: `.flit-app` pinta --flit-bg-app (#EAF2FF) en los dos temas. Tomar el
  // `--color-surface` oscuro del body daba un panel 0,3 más oscuro del que se pinta —el body
  // queda tapado por un shell `min-h-screen`— y con él todos los ratios salían regalados.
  // Peor caso admitido: detrás del panel puede haber una tarjeta blanca en vez del fondo de la
  // app; son ~0,02 de ratio, dentro del margen con el que se eligieron las tintas.
  const pagina = leer(flitTokens, FLIT_TOKENS_CSS, ['.flit-app'], 'background');
  const overlay = enIndex(variantes('.flit-shell-overlay', { enPaleta: false }), 'background');
  // El panel lleva DOS clases con fondo propio —`flit-shell-palette` y `flit-shell-sunken`— y en
  // claro tienen la MISMA especificidad: decide el orden en index.css. Si alguien las reordena,
  // el panel pasa de blanco translúcido a #EAF2FF opaco y todos los ratios de debajo cambian.
  // Se pasan las dos y que resuelva la cascada, en vez de fiarse de la que uno recuerda.
  const panelBg = enIndex(
    [...(oscuro ? [`${DARK} ${PALETA}`, `${DARK} .flit-shell-sunken`] : []), PALETA, '.flit-shell-sunken'],
    'background',
  );
  const sunkenBg = enIndex(variantes('.flit-shell-sunken'), 'background');
  // Las teclas llevan `kbd` Y `flit-shell-sunken`: hay que darle a la cascada las dos formas,
  // porque `${PALETA} kbd` (0,2,1) pierde contra `${PALETA} .flit-shell-sunken` (0,3,0) en
  // oscuro y ganaría en claro si algún día existiera. Leer sólo una devuelve CSS muerto, que
  // miente igual que equivocarse de padre.
  const kbdBg = enIndex(
    [...variantes('kbd.flit-shell-sunken'), ...variantes('kbd'), ...variantes('.flit-shell-sunken')],
    'background',
  );
  const activoBg = enIndex(variantes('.flit-shell-active'), 'background');
  const hoverBg = enIndex(variantes('.flit-shell-hover:hover'), 'background');

  // ── Tintas ─────────────────────────────────────────────────────────────────────────────
  const muted = enIndex(variantes('.flit-shell-muted'), 'color');
  const secundario = enIndex(variantes('.flit-shell-secondary'), 'color');
  const primario = enIndex(variantes('.flit-shell-primary'), 'color');
  const acento = enIndex(variantes('.flit-shell-accent'), 'color');
  // El placeholder es su propio punto: no hereda de `.flit-shell-muted` ni lo pinta ninguna clase
  // del TSX (`placeholder:flit-shell-muted` NO es una utilidad de Tailwind y nunca generó regla).
  // Si no hay regla propia lo pinta el PREFLIGHT de Tailwind, que es `currentcolor` al 50 % — y
  // `currentcolor` aquí es la tinta del input, que lleva `flit-shell-primary`. Ese fallback no es
  // una suposición cómoda: es lo que dejaba el placeholder en 2,98 en claro (Bug #11767) y en
  // 4,41 en oscuro (Bug #11720). Modelarlo es lo que hace que el gate lo vea ROJO en vez de no
  // verlo: sin él, el punto que más incumple de toda la paleta no aparecería en la lista.
  const placeholderPropio = enIndex(variantes('::placeholder'), 'color', { obligatorio: false });
  const placeholder = placeholderPropio ?? { color: primario.color, alfa: 0.5 };

  // ── Composición real de superficies ────────────────────────────────────────────────────
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

  console.log(
    `── Tema ${tema.toUpperCase()} ${'─'.repeat(66 - tema.length)}\n`
    + `Fondos compuestos — panel ${hex(panel)} · barra ${hex(sunken)} · activo ${hex(activo)} · hover ${hex(hover)}\n`
    + `Teclas — sobre la barra ${hex(teclaEnBarra)} · sobre el panel ${hex(teclaEnPanel)} · sobre el ítem activo ${hex(teclaEnActivo)}\n`
    + (placeholderPropio
      ? ''
      : 'Placeholder — SIN regla propia: lo pinta el preflight (tinta del input al 50 %)\n'),
  );

  let fallos = 0;
  for (const [nombre, tinta, bg] of CASOS) {
    // La tinta se compone sobre SU fondo antes de medir: el placeholder del preflight es
    // semitransparente y medirlo como si fuera opaco regala más de un punto de ratio.
    const fg = opaco(tinta, bg);
    const r = ratio(fg, bg);
    const ok = r >= MINIMO;
    if (!ok) fallos++;
    console.log(`${ok ? '✓' : '✗'} ${nombre.padEnd(38)} ${hex(fg)} sobre ${hex(bg)} → ${r.toFixed(2)}`);
  }
  console.log('');
  return { fallos, total: CASOS.length };
}

const TEMAS = ['claro', 'oscuro'];
const resultados = TEMAS.map((tema) => ({ tema, ...medirTema(tema) }));
const fallos = resultados.reduce((n, r) => n + r.fallos, 0);

if (fallos > 0) {
  const detalle = resultados
    .filter((r) => r.fallos > 0)
    .map((r) => `${r.fallos} en tema ${r.tema}`)
    .join(' · ');
  console.error(
    `✗ ${fallos} punto(s) de la CommandPalette bajo ${MINIMO}:1 (${detalle}).` +
      '\n  Antes de tocar una tinta, mira QUÉ HAY DEBAJO: las capas translúcidas se acumulan y' +
      '\n  aclarar el texto de un punto puede hundir otro. El panel NO es blanco puro ni en claro:' +
      '\n  deja pasar un 2 % del overlay, y ahí es donde se cae la tinta `muted` (Bug #11767).' +
      '\n  Y si cambias el DOM de CommandPalette.tsx, revisa que cada caso de CASOS siga nombrando' +
      '\n  la superficie real: este gate no lee el DOM, así que un `kbd` que se mude de padre no se' +
      '\n  entera solo. La medición sobre el píxel está en e2e/tests/command-palette-claro.spec.ts' +
      '\n  y e2e/tests/command-palette-oscuro.spec.ts.',
  );
  process.exit(1);
}
console.log(
  `✓ Los ${resultados[0].total} puntos de la CommandPalette cumplen ${MINIMO}:1 en tema ${TEMAS.join(' y ')}.`,
);
