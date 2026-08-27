// Gate de contraste sin navegador. Cubre dos invariantes que se rompieron por separado:
//
//   · Bug #11720 (tema oscuro) · Bug #11767 (tema CLARO) — la CommandPalette, en los dos temas
//     (bloque CASOS + `medirTema`, más abajo).
//   · Bug #11766 — todo punto de todo `--flit-gradient-*` admite texto blanco (bloque GRADIENTES,
//     al final) y el anillo `.flit-focus-light`, que está acoplado a ese gradiente.
//
// Comparten este archivo porque comparten la maquinaria —leer el hex del CSS real y medir— y
// porque comparten el motivo por el que existen: `axe` no es dependencia del repo y el CI no
// ejecuta E2E. En el caso de los gradientes hay una razón de más, y es peor: `axe` tampoco
// habría servido corriendo, porque un fondo con `background-image` no lo puede medir y lo reporta
// como `incomplete` — y `e2e/helpers/axe.ts` devuelve sólo `r.violations`, así que ningún spec
// puede ver un `incomplete` aunque quiera. Sobre estos fondos, este script es la única vía.
//
// ── Bugs #11720 y #11767, la CommandPalette ───────────────────────────────────────────────
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
// Al medirlo aparecieron DOS puntos por debajo de AA que llevaban ahí desde siempre, y los
// dos por el MISMO motivo de fondo — dar por supuesto el fondo en vez de componerlo:
//
//   · el `::placeholder`, que en claro no lo pintaba ninguna regla sino el preflight de Tailwind
//     (`color-mix(in oklab, currentcolor 50%, transparent)`, o sea la tinta del input al 50 %):
//     #808da2 sobre la barra #eaf2ff → 2,98;
//   · la tecla ↵ del ítem activo, que se dio por buena en 4,49 «sobre el fondo claro que ese
//     kbd tenía» — pero ese fondo era el `bg-white` que el propio #11720 demostró MUERTO. Lo
//     que pinta la tecla es `.flit-shell-sunken` (#eaf2ff), donde --flit-blue daba 3,99.
//
// Una tercera sospecha se midió y NO era defecto, y se deja escrita porque el gate de QA la
// cazó como afirmación falsa en esta misma cabecera: la tinta `muted` sobre el PANEL, que no
// es blanco puro (`rgba(255,255,255,.98)` deja pasar un 2 % del overlay y compone #fdfdfd).
// Ahí #646e82 da 5,04 — pasa. La ficha del Bug reportaba «4,41», que es el ratio del hex
// ANTERIOR al #11604 (#667085 → 4,42): un número correcto para un token que ya no existe.
// Cuidado con repetirlo: el propósito de este archivo es que se crea al número y no a la frase.
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

// ── Tokens `--flit-*`, resueltos POR TEMA ────────────────────────────────────────────────
// Hasta la HU #11899 esto era una línea: los `--flit-*` se declaraban UNA vez, así que bastaba
// buscar la primera aparición del nombre en el archivo y devolverla. Esa comodidad se convirtió
// en una trampa en cuanto el kit tuvo par oscuro, y conviene entender por qué antes de tocar nada:
//
//   `resolverVar` hacía `match()` sobre el archivo entero → siempre encontraba la declaración de
//   `:root`, la CLARA. Con `medirTema('oscuro')` eso significa componer los 15 puntos de la
//   paleta sobre `#EAF2FF`, un sustrato que ya no se pinta en ninguna pantalla. El gate saldría
//   VERDE midiendo una quimera — el mismo error de MODELO que la cabecera de este archivo llama
//   «equivocarse de PADRE» y que ya dejó pasar una regresión una vez.
//
// Por eso ahora se resuelve por tema: `:root` para claro, `:root[data-theme='dark']` para oscuro,
// con encadenado de `var()` (un token puede referenciar a otro). La prueba de que funciona es
// observable en la salida: la línea «Fondos compuestos» del tema OSCURO tiene que dar hexes
// distintos a los del tema claro. Si salen iguales, el resolvedor volvió a anclarse al `:root`.
const flitTokens = readFileSync(FLIT_TOKENS_CSS, 'utf8');

const TEMAS = ['claro', 'oscuro'];
const SELECTOR_DE_TEMA = { claro: ':root', oscuro: ":root[data-theme='dark']" };

/** Cuerpo (todas las declaraciones) del bloque de tokens de un tema. Vacío si el bloque no está. */
function cuerpoDelTema(tema) {
  return reglas(flitTokens)
    .filter((r) => r.selectores.includes(SELECTOR_DE_TEMA[tema]))
    .map((r) => r.cuerpo)
    .join(';');
}
const CUERPO = Object.fromEntries(TEMAS.map((t) => [t, cuerpoDelTema(t)]));

function declaracionEn(cuerpo, nombre) {
  const m = cuerpo.match(new RegExp(`(?:^|;)\\s*${nombre}\\s*:\\s*([^;]+)`));
  return m ? m[1].trim() : null;
}

// Los tokens que la HU #11899 obliga a redefinir bajo `[data-theme='dark']`.
//
// Esta lista es el corazón del AC8, y el motivo es de diseño de gate, no de gusto: si un token de
// esta lista NO aparece en el bloque oscuro, el gate NO puede caer al valor de `:root` y seguir
// midiendo. Caería en el absurdo de medir tinta clara sobre fondo claro —12:1, verde— sobre una
// pantalla que en oscuro pintaría el fondo oscuro de Aura debajo. Aprobar por omisión es
// exactamente la avería que este archivo existe para no tener.
//
// `umbral` dice CÓMO se mide cada familia; `null` = sólo se comprueba que el par exista (sombras y
// velos: no son texto ni indicador, no tienen ratio que exigir, pero sin par oscuro una sombra
// navy translúcida sobre fondo navy simplemente no existe).
const PARES_OBLIGATORIOS = [
  '--flit-bg-app',
  '--flit-bg-modal',
  '--flit-bg-card',
  '--flit-bg-table-header',
  '--flit-bg-topbar',
  '--flit-bg-hover',
  '--flit-text-primary',
  '--flit-text-secondary',
  '--flit-text-muted',
  '--flit-text-brand-title',
  '--flit-blue-text',
  '--flit-muted',
  '--flit-draft',
  '--flit-border-soft',
  '--flit-border-input',
  '--flit-border-focus',
  '--flit-shadow-card',
  '--flit-shadow-modal',
  '--flit-shadow-button',
  // `--flit-shadow-desborde` (HU #11900) NO está en esta lista, y no por olvido: se mide con
  // UMBRAL más abajo, en AVISO_DESBORDE. Esta lista es la de presencia —«tiene par oscuro»— y un
  // token que sólo declara eso no está medido. La medida con umbral además la subsume: sin par
  // oscuro, `tokenFlit` cae al valor CLARO y ese navy sobre las superficies oscuras da 1,07 sobre
  // tarjeta y 1,00 sobre cabecera —medido borrando el par—, o sea que el gate se pone rojo igual,
  // pero diciendo el número en vez de una ausencia. A 1,00 la franja literalmente desaparece.
];
const OBLIGATORIOS = new Set(PARES_OBLIGATORIOS);

/** Señal de «este token debía tener par oscuro y no lo tiene». No es un crash: se reporta y se mide. */
class ParOscuroAusente extends Error {
  constructor(token) {
    super(`Falta el par oscuro de ${token}.`);
    this.token = token;
  }
}

function tokenFlit(nombre, tema) {
  const propio = declaracionEn(CUERPO[tema], nombre);
  if (propio !== null) return propio;
  if (tema === 'oscuro' && OBLIGATORIOS.has(nombre)) throw new ParOscuroAusente(nombre);
  // Radios, tipografía, motion, marca y tokens `-ink`: un solo valor para los dos temas, a
  // propósito (#11766 no se reabre). Caer a `:root` aquí es correcto, no una omisión.
  return declaracionEn(CUERPO.claro, nombre);
}

/**
 * Sustituye los `var()` de un valor, encadenando: un token puede referenciar a otro (las paradas
 * de `--flit-gradient-*` son `var(--flit-*-ink)`), y la sustitución se repite hasta que no queda
 * ninguno. El tope de vueltas es contra un ciclo `A: var(--B); B: var(--A)`, que colgaría el CI.
 */
function resolverVar(valor, tema = 'claro') {
  let actual = valor;
  for (let vuelta = 0; vuelta < 8; vuelta++) {
    const ref = actual.match(/var\(\s*(--[\w-]+)\s*\)/);
    if (!ref) return actual;
    let decl = null;
    if (ref[1].startsWith('--flit-')) {
      decl = tokenFlit(ref[1], tema);
    } else {
      // Tokens Aura. No se resuelven por tema aquí: nada de lo que este gate mide cuelga de
      // `--color-*`, y fingir que se soportan sería peor que no tocarlos.
      for (const css of [tokens, index]) {
        const d = sinComentarios(css).match(new RegExp(`${ref[1]}\\s*:\\s*([^;]+)`));
        if (d) {
          decl = d[1].trim();
          break;
        }
      }
    }
    if (decl === null) {
      throw new Error(`No se pudo resolver ${ref[1]}: no está declarado en los CSS de tokens.`);
    }
    actual = actual.replace(ref[0], decl);
  }
  throw new Error(`var() encadenado más de 8 niveles en "${valor}": ¿hay un ciclo entre tokens?`);
}

/** Acepta `#rrggbb`, `rgba(r, g, b, a)` o un `var(--token)` que resuelva a uno de los dos. */
function parsear(valorCrudo, etiqueta, tema = 'claro') {
  const valor = resolverVar(valorCrudo, tema);
  const hex = valor.match(/#[0-9a-f]{3,6}/i);
  if (hex) return { color: rgb(hex[0]), alfa: 1 };
  const fn = valor.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\s*\)/i);
  if (!fn) throw new Error(`No se pudo interpretar el color de ${etiqueta}: "${valor}".`);
  return { color: [+fn[1], +fn[2], +fn[3]], alfa: fn[4] === undefined ? 1 : +fn[4] };
}

const leer = (css, archivo, selectores, propiedad, opciones, tema = 'claro') => {
  const decl = ganadora(css, archivo, selectores, propiedad, opciones);
  if (!decl) return null;
  return parsear(decl.valor, `${decl.selector} { ${propiedad} }`, tema);
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
    leer(index, INDEX_CSS, selectores, propiedad, opciones, tema);

  // ── Superficies ────────────────────────────────────────────────────────────────────────
  // Lo que hay DETRÁS del overlay no es el `body` sino el shell de la app: `.flit-app`. Tomar el
  // `--color-surface` del body daba un panel más oscuro del que se pinta —el body queda tapado por
  // un shell `min-h-screen`— y con él todos los ratios salían regalados.
  //
  // El `tema` del final de esta llamada no es adorno. Hasta la HU #11899 aquí había escrito «el
  // shell NO invierte en oscuro: `.flit-app` pinta #EAF2FF en los dos temas», y era verdad. Desde
  // que `--flit-bg-app` tiene par oscuro deja de serlo, y resolverlo sin tema dejaría este gate
  // componiendo la paleta oscura sobre un celeste que ya no existe: verde sobre una quimera.
  // Peor caso admitido: detrás del panel puede haber una tarjeta en vez del fondo de la app; son
  // ~0,02 de ratio, dentro del margen con el que se eligieron las tintas.
  const pagina = leer(flitTokens, FLIT_TOKENS_CSS, ['.flit-app'], 'background', undefined, tema);
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

// ── Pares `--flit-*` del kit, tema a tema (HU #11899 · AC7/AC8) ──────────────────────────
// Tercera invariante del archivo, y la que faltaba. Las dos anteriores miran el shell
// (CommandPalette) y los gradientes; NINGUNA miraba las superficies del PRODUCTO —el fondo de
// página, la tarjeta, el modal, la cabecera de tabla— ni las tintas que caen encima.
//
// Eso tuvo una consecuencia incómoda que conviene dejar escrita: `npm run check:contraste` estaba
// VERDE el día antes de esta HU, con el kit entero congelado en tema claro y un modal celeste con
// tinta Aura casi blanca encima. El gate no mentía, es que no miraba ahí. Un par que no está en
// esta lista no está medido, y un par no medido no existe (spec, § Notas para QA, punto 4).
//
// Qué hace este bloque, en orden:
//   1. comprueba que CADA token obligatorio tenga declaración propia en `:root[data-theme='dark']`.
//      Sin ella no se mide con el valor claro «por si acaso»: se reporta ✗ nombrando el token. Es
//      el mutante del AC8 —revertir el bloque oscuro— y tiene que salir rojo POR MEDICIÓN, no por
//      una excepción de lookup;
//   2. compone las seis superficies de cada tema (cuatro opacas + topbar y hover, que son velos);
//   3. mide texto × superficie a 4,5:1 y foco × superficie a 3:1, en LOS DOS temas.
//
// Lo que NO se hace, y es la diferencia entre un gate de contraste y un gate de diferencia:
// no se compara el hex oscuro contra el claro para ver «si cambió». Comparar sólo detecta el
// mutante que borra el bloque; no detecta un par oscuro coherente y a la vez ilegible —pongamos
// `--flit-bg-app: #0B1220` con `--flit-text-primary: #101827`, los dos bien oscuros, 1,2:1—.
// Aquí se mide el ratio, así que ese segundo mutante también sale rojo.
// Mínimo WCAG 2.x AA para elementos gráficos e indicadores de foco (SC 1.4.11). Lo comparten el
// anillo `.flit-focus-light` sobre el gradiente del drawer y `--flit-border-focus` sobre las
// superficies del kit: es el mismo criterio, así que es la misma constante.
const MINIMO_NO_TEXTO = 3;

let fallosPares = 0;
const sinPar = PARES_OBLIGATORIOS.filter((t) => declaracionEn(CUERPO.oscuro, t) === null);

console.log(`\n── Pares --flit-* del kit ${'─'.repeat(48)}`);
if (CUERPO.oscuro.trim() === '') {
  console.log(`✗ No hay bloque ${SELECTOR_DE_TEMA.oscuro} en ${FLIT_TOKENS_CSS}.`);
}
for (const token of sinPar) {
  fallosPares++;
  console.log(`✗ ${token.padEnd(26)} SIN par oscuro — se quedaría en el valor de :root (claro)`);
}
if (sinPar.length === 0) {
  console.log(`✓ Los ${PARES_OBLIGATORIOS.length} tokens del kit declaran par oscuro en ${SELECTOR_DE_TEMA.oscuro}.`);
} else {
  console.error(
    `\n✗ ${sinPar.length} token(s) del kit sin par oscuro: ${sinPar.join(', ')}.`
      + '\n  Con el kit siguiendo el tema, un token sin par se queda en su valor CLARO mientras la'
      + '\n  página de debajo ya invirtió: es el modal celeste con tinta clara que esta HU cerró.'
      + '\n  El gate no cae a :root a propósito — aprobar por omisión es peor que no medir.'
      + `\n  Se declaran en ${FLIT_TOKENS_CSS}, bloque ${SELECTOR_DE_TEMA.oscuro}.`,
  );
  process.exit(1);
}

/** Superficies reales de cada tema, ya compuestas: cuatro opacas y dos velos. */
function superficiesDe(tema) {
  const plano = (token) => parsear(`var(${token})`, token, tema).color;
  const app = plano('--flit-bg-app');
  const card = plano('--flit-bg-card');
  // El topbar es un velo con `backdrop-filter` sobre el fondo de página; el hover del shell, un
  // velo sobre la tarjeta. Se componen porque lo que lee el ojo es el resultado, no el token.
  const topbarTok = parsear('var(--flit-bg-topbar)', '--flit-bg-topbar', tema);
  const hoverTok = parsear('var(--flit-bg-hover)', '--flit-bg-hover', tema);
  return [
    ['app', app],
    ['modal', plano('--flit-bg-modal')],
    ['tarjeta', card],
    ['cabecera', plano('--flit-bg-table-header')],
    ['topbar', opaco(topbarTok, app)],
    ['hover', opaco(hoverTok, card)],
  ];
}

// Texto: 4,5:1 (SC 1.4.3). `--flit-text-brand-title` se mide SÓLO sobre tarjeta y no por descuido:
// su valor claro (#526FB8) da 4,31 sobre --flit-bg-app y 4,43 sobre --flit-bg-modal, o sea que ya
// incumplía antes de esta HU en cuanto salía de una tarjeta. Ese es justo el hallazgo que llevó al
// Bug #11604 a crear `--flit-blue-text` (4,64 sobre el fondo de página) para el texto azul que NO
// vive dentro de una tarjeta. Hoy el token de título de marca tiene CERO consumidores en
// apps/web/src; medirlo sobre las seis superficies pondría el gate rojo por una deuda del tema
// claro que esta HU no está autorizada a mover, y bajarle el umbral sería mentir. Se mide donde
// se usaría.
const TINTAS = [
  ['--flit-text-primary', null],
  ['--flit-text-secondary', null],
  ['--flit-text-muted', null],
  ['--flit-blue-text', null],
  ['--flit-muted', null],
  ['--flit-draft', null],
  ['--flit-text-brand-title', ['tarjeta']],
];

// Indicador de foco: 3:1 (SC 1.4.11). Éste sí es un elemento gráfico con umbral propio, y es el
// que pinta `.flit-focus` / `.flit-focus-inset` sobre cualquiera de las cuatro superficies opacas.
const FOCO = ['--flit-border-focus'];

// Aviso de DESBORDE horizontal de `FlitTable` (HU #11900): 3:1, el mismo umbral y el mismo motivo
// que el foco. La spec firmada se lo asigna POR SU NOMBRE —§Pantalla 1, «No es un control; es un
// indicador gráfico (≥ 3:1)»— y el hard-stop de la ráfaga repite «gráficos/foco ≥ 3:1, en claro y
// en oscuro».
//
// Se mide contra DOS superficies y no contra una: la franja es `inset-y-0`, así que cruza la
// tarjeta y también la cabecera de la tabla. Medir sólo sobre la tarjeta dejaría sin comprobar el
// tramo que se pinta sobre `--flit-bg-table-header`.
//
// Y se mide el extremo opaco del degradado, que es donde el aviso tiene que leerse: el píxel del
// borde derecho vale exactamente `opaco(token, superficie)`. El degradado se apaga hacia la
// izquierda por diseño; lo que el AC7 pide ver es el borde.
//
// Por qué NO se le aplicó la exención de los separadores (que es la salida fácil y sería mentira):
// aquella exención del 26 ago 2026 protege dos tokens cuyo valor CLARO ya incumplía antes de la
// ráfaga y cuya subida repintaría el borde de todas las tarjetas del producto. Éste es un token
// NUEVO: no hay deuda previa que proteger ni pantalla que se deforme. Su primer valor
// —rgba(22,39,68,0.26) / rgba(0,0,0,0.55)— fallaba además la invariante de respaldo de aquel
// precedente, porque el oscuro separaba MENOS que el claro (1,36 < 1,70).
const AVISO_DESBORDE = [['--flit-shadow-desborde', ['tarjeta', 'cabecera']]];

// `--flit-border-soft` y `--flit-border-input` son SEPARADORES, y aquí hay que ser exacto para no
// vender una comprobación que no se hace: sus valores CLAROS dan 1,27 y 1,35 sobre tarjeta, muy
// por debajo del 3:1 — y son los del producto de hoy, anteriores a esta HU. Subirlos repintaría el
// borde de todas las tarjetas de FLITO, que es un cambio visual que nadie pidió.
// OJO con la procedencia, porque la primera versión de este comentario la citaba mal: la spec
// firmada NO los dejaba fuera — su tabla «Qué se redefine» los listaba con el mismo ≥ 3:1 que el
// resto. Lo que los exime es la DECISIÓN DEL PO del 26 ago 2026, recogida en la enmienda
// «los separadores no llevan el 3:1» de docs/ux/shell-tema-y-responsive.md y en el AC7 de la
// HU #11899. La exención alcanza a estos dos tokens aunque `--flit-border-input` sea el borde de
// un control: se eximen por nombre, no por categoría. `--flit-border-focus` NO entra —es el
// indicador de foco, SC 1.4.11 aplica de lleno— y se mide arriba contra 3:1.
// Lo que sí se puede exigir sin inventarse un umbral es que el par oscuro haga el MISMO trabajo:
// separar al menos tanto como separa el claro, y no desaparecer contra su superficie. Eso es lo
// que se mide. El día que se decida subir los separadores a 3:1, el sitio es esta constante.
const SEPARADORES = [
  ['--flit-border-soft', ['app', 'tarjeta']],
  ['--flit-border-input', ['app', 'modal', 'tarjeta']],
];
const MINIMO_SEPARADOR = 1.1;

const medidasSeparador = { claro: new Map(), oscuro: new Map() };

for (const tema of TEMAS) {
  const superficies = superficiesDe(tema);
  const porNombre = new Map(superficies);
  console.log(
    `\n── Kit, tema ${tema.toUpperCase()} ${'─'.repeat(60 - tema.length)}\n`
    + `Superficies — ${superficies.map(([n, c]) => `${n} ${hex(c)}`).join(' · ')}\n`,
  );

  const medir = (token, nombres, minimo, etiqueta) => {
    const tinta = parsear(`var(${token})`, token, tema);
    for (const nombre of nombres) {
      const bg = porNombre.get(nombre);
      const fg = opaco(tinta, bg);
      const r = ratio(fg, bg);
      const ok = r >= minimo;
      if (!ok) fallosPares++;
      console.log(
        `${ok ? '✓' : '✗'} ${token.padEnd(24)} ${etiqueta} ${nombre.padEnd(9)} `
        + `${hex(fg)} sobre ${hex(bg)} → ${r.toFixed(2)} (mín ${minimo})`,
      );
    }
  };

  for (const [token, soloEn] of TINTAS) {
    medir(token, soloEn ?? superficies.map(([n]) => n), MINIMO, 'texto sobre');
  }
  for (const token of FOCO) {
    medir(token, ['app', 'modal', 'tarjeta', 'cabecera'], MINIMO_NO_TEXTO, 'foco  sobre');
  }
  for (const [token, nombres] of AVISO_DESBORDE) {
    medir(token, nombres, MINIMO_NO_TEXTO, 'aviso sobre');
  }
  for (const [token, nombres] of SEPARADORES) {
    const tinta = parsear(`var(${token})`, token, tema);
    for (const nombre of nombres) {
      const bg = porNombre.get(nombre);
      const r = ratio(opaco(tinta, bg), bg);
      medidasSeparador[tema].set(`${token} ${nombre}`, r);
      const ok = r >= MINIMO_SEPARADOR;
      if (!ok) fallosPares++;
      console.log(
        `${ok ? '✓' : '✗'} ${token.padEnd(24)} borde sobre ${nombre.padEnd(9)} `
        + `${hex(opaco(tinta, bg))} sobre ${hex(bg)} → ${r.toFixed(2)} (mín ${MINIMO_SEPARADOR}, separador)`,
      );
    }
  }
}

// No regresión de los separadores entre temas: el par oscuro no puede separar PEOR que el claro.
console.log('');
for (const [clave, rClaro] of medidasSeparador.claro) {
  const rOscuro = medidasSeparador.oscuro.get(clave);
  const ok = rOscuro >= rClaro;
  if (!ok) fallosPares++;
  console.log(
    `${ok ? '✓' : '✗'} ${clave.padEnd(38)} oscuro ${rOscuro.toFixed(2)} ≥ claro ${rClaro.toFixed(2)}`,
  );
}

if (fallosPares > 0) {
  console.error(
    `\n✗ ${fallosPares} comprobación(es) de los pares --flit-* en rojo.`
      + '\n  Los hex se cambian en apps/web/src/styles/flit-tokens.css y en NINGÚN otro sitio: los'
      + '\n  consumidores del kit ya leen el token, así que repintarlos uno a uno no arregla nada y'
      + '\n  además reabre la divergencia que la HU #11899 cerró.'
      + '\n  Ojo con la dirección del arreglo: aclarar una tinta para salvar un punto puede hundir'
      + '\n  otro que cae sobre una superficie más clara (las seis se listan arriba con su hex).',
  );
}

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
} else {
  console.log(`✓ Los ${resultados[0].total} puntos de la CommandPalette cumplen ${MINIMO}:1 en tema ${TEMAS.join(' y ')}.`);
}

// ── Gradientes FLIT (Bug #11766) ─────────────────────────────────────────────────────────
// Segunda invariante, independiente de la anterior: TODO punto de TODO `--flit-gradient-*`
// admite texto BLANCO PURO con al menos 4,5:1.
//
// Cabe en este script —que no abre navegador— porque es una invariante del TOKEN y no del DOM:
// no hace falta saber qué nodo lleva la etiqueta. Si se cumple, cualquier texto blanco sobre
// cualquiera de los cuatro gradientes cumple por construcción, y eso alcanza de una vez a los
// 112 puntos de llamada `var(--flit-gradient-*)` que hay hoy en 60 archivos de apps/web/src
// (medido con `rg -o 'var\(--flit-gradient-(primary|success|sidebar|danger)\)' apps/web/src`).
// Ninguna otra capa los alcanza: ~104 de esos puntos son `style={{}}` escritos en la página, así
// que arreglar GradientButton y flitBtnPrimaryStyle cerraría 2 de 112.
//
// LO QUE ESTE BLOQUE NO VE, dicho para que nadie lo suponga: un `text-white/85` encima (el alfa
// vive en el TSX y baja el ratio), un `linear-gradient(...)` a pelo sin token, y un
// `hover:opacity` que mezcla el fondo con la página clara al pasar el ratón. Esos tres se cierran
// en la revisión de PR y en los specs; aquí no hay forma de verlos.
let fallosGradiente = 0;
const BLANCO = [255, 255, 255];
const GRADIENTES = [
  '--flit-gradient-primary',
  '--flit-gradient-success',
  '--flit-gradient-sidebar',
  '--flit-gradient-danger',
];

// Muestras por tramo, extremos incluidos.
//
// Para texto BLANCO, hoy, las dos paradas bastarían: la luminancia a lo largo de un tramo sRGB es
// convexa en t, así que su MÁXIMO —el peor caso del blanco— cae siempre en un extremo. Conviene
// decirlo con ese matiz y no vender el muestreo como si salvara el caso de hoy: con las cuatro
// rampas actuales, bajar MUESTRAS_POR_TRAMO a 2 daría los mismos cuatro veredictos.
//
// Se muestrea por lo que el gate tendrá que aguantar mañana, que es donde la demostración de
// arriba deja de valer: una TERCERA parada (la convexidad es por tramo, y con tres paradas el
// peor punto puede ser una de las intermedias), un `in oklab` futuro —que ya no interpola por
// canal en sRGB—, y sobre todo una TINTA OSCURA, para la que lo que importa es el MÍNIMO, y el
// mínimo sí cae dentro. No es hipotético: con el anillo navy sobre --flit-gradient-sidebar el
// mínimo está en el 90 % (2,65) y no en el extremo (2,66). Ese caso concreto lo habrían cazado
// igual las dos paradas —se lleva 0,01—, pero enseña que el interior manda, y no hay ninguna
// garantía de que la próxima vez el margen vuelva a ser de céntimos.
//
// Un gradiente no se evalúa por sus extremos como si el contraste interpolara: en `success` el
// máximo cae en el 45 % (5,20) por encima de sus dos extremos (5,07 y 5,14), porque entre
// #1E7B75 y #3C7C17 los canales se mueven en direcciones opuestas.
//
// Muestrear cuesta microsegundos. No es el número el que sostiene el gate: es el muestreo.
const MUESTRAS_POR_TRAMO = 21;

/**
 * Corta la lista de un `linear-gradient(...)` por las comas de PRIMER NIVEL. Un `split(',')` a
 * secas parte por dentro de cualquier función —`rgba(185, 65, 32, .6)` se volvía «rgba(185», y el
 * error resultante señalaba a la coma en vez de al alfa, que es el problema real—. Con el corte a
 * nivel cero cada parada llega entera y el mensaje puede nombrar lo que de verdad pasa.
 */
function separarParadas(lista) {
  const partes = [];
  let nivel = 0;
  let actual = '';
  for (const ch of lista) {
    if (ch === '(') nivel++;
    else if (ch === ')') nivel--;
    if (ch === ',' && nivel === 0) {
      partes.push(actual.trim());
      actual = '';
    } else actual += ch;
  }
  partes.push(actual.trim());
  return partes.filter((x) => x.length > 0);
}

/**
 * Paradas de un `linear-gradient(...)`, en orden. Cada parada puede ser un hex o un
 * `var(--token)`, que se resuelve con el mismo `parsear()` que usa el resto del gate.
 *
 * Que acepte `var()` no es comodidad: es lo que permite que los gradientes REFERENCIEN los
 * tokens `-ink` en vez de repetir su hex a mano. Con el hex duplicado, `--flit-cyan-ink` y las
 * paradas eran dos fuentes de verdad que nadie ataba: tocar el token dejaba los gradientes
 * quietos y el gate seguía en verde —porque, en efecto, no se habían movido— y la tinta sólida
 * y el gradiente derivaban en silencio. Ahora hay una sola fuente y el gate la sigue.
 *
 * FALLA —nunca aprueba— si el token deja de ser un linear-gradient, si una parada trae alfa, o
 * si trae algo que este parser no interpolaría igual que el navegador (`in oklab`): un gate que
 * se calla ante lo que no entiende es un gate apagado, que es la regla que ya rige `ganadora()`.
 */
function paradasGradiente(valor, token) {
  const cuerpo = valor.match(/^linear-gradient\(([\s\S]*)\)$/i);
  if (!cuerpo) {
    throw new Error(
      `${token} ya no es un linear-gradient(): "${valor}". Si el token pasó a ser un color sólido`
        + ' o una composición de capas, hay que reescribir esta comprobación, no borrarla.',
    );
  }
  const paradas = [];
  for (const parte of separarParadas(cuerpo[1])) {
    // Ángulo o palabra clave de dirección: no aportan color.
    if (/^-?[\d.]+(deg|grad|rad|turn)$/i.test(parte) || /^to\s+[a-z\s]+$/i.test(parte)) continue;
    const parada = parte.match(/^(#[0-9a-f]{3}|#[0-9a-f]{6}|var\(.+?\)|rgba?\([^)]*\))(?:\s+([\d.]+)%)?$/i);
    if (!parada) {
      throw new Error(
        `${token}: no se pudo interpretar la parada "${parte}". Este gate interpola por canal en`
          + ' sRGB, que es lo que hace el navegador con un linear-gradient sin `in <colorspace>`;'
          + ' con otro espacio de color o con alfa, las muestras dejarían de ser las que se pintan.',
      );
    }
    // Un `var(--x, reserva)` NO se acepta, y no es purismo: `resolverVar()` sólo reconoce la
    // forma `var(--token)`, así que con reserva se le escapa y el `#hex` que acaba encontrando es
    // EL DE LA RESERVA — justo el color que el navegador NO usa cuando el token está declarado.
    // Medido: con `var(--flit-cyan-ink, #4FD4CC)` el gate leía #4fd4cc mientras la página pintaba
    // #1e7b75. Ahí se puso rojo por suerte; con la reserva oscura y el token claro habría salido
    // VERDE sobre una pantalla incumpliendo, que es exactamente lo que este archivo existe para
    // que no pase.
    if (/^var\(/i.test(parada[1]) && parada[1].includes(',')) {
      throw new Error(
        `${token}: la parada "${parte}" usa \`var()\` con valor de reserva. Este gate no sabe cuál`
          + ' de los dos pintaría el navegador, y adivinar sería peor que fallar. Usa'
          + ' `var(--token)` a secas.',
      );
    }
    // `parsear()` resuelve el `var()` contra los CSS de tokens y devuelve {color, alfa}.
    const { color, alfa } = parsear(parada[1], `${token}, parada "${parte}"`);
    if (alfa !== 1) {
      throw new Error(
        `${token}: la parada "${parte}" es translúcida (alfa ${alfa}). Lo que se pinta depende`
          + ' entonces de lo que haya DETRÁS del gradiente, que este gate no conoce. Compón la'
          + ' capa a mano en un caso de CASOS, o usa un color opaco.',
      );
    }
    paradas.push({ color, pos: parada[2] === undefined ? null : +parada[2] });
  }
  if (paradas.length < 2) throw new Error(`${token}: se esperaban 2 paradas o más, hay ${paradas.length}.`);
  // Posiciones omitidas: la primera es 0 %, la última 100 %, y las de en medio se reparten
  // uniformemente entre sus vecinas conocidas (regla de CSS Images).
  if (paradas[0].pos === null) paradas[0].pos = 0;
  if (paradas.at(-1).pos === null) paradas.at(-1).pos = 100;
  for (let i = 0; i < paradas.length; i++) {
    if (paradas[i].pos !== null) continue;
    let j = i;
    while (paradas[j].pos === null) j++;
    const desde = paradas[i - 1].pos;
    const paso = (paradas[j].pos - desde) / (j - i + 1);
    for (let k = i; k < j; k++) paradas[k].pos = desde + paso * (k - i + 1);
  }
  return paradas;
}

/**
 * Recorre el gradiente y devuelve el PEOR ratio, con el porcentaje y el hex compuesto donde cae.
 * `tintaDe` recibe la muestra del fondo porque una tinta translúcida (un anillo de foco con alfa)
 * cambia de color según lo que tenga debajo. Un gate que sólo dice «falla» obliga a repetir el
 * cálculo a mano, así que se devuelve DÓNDE falla.
 */
function peorDelGradiente(paradas, tintaDe) {
  let peor = { r: Infinity, pos: 0, fondo: paradas[0].color };
  for (let s = 0; s < paradas.length - 1; s++) {
    const [a, b] = [paradas[s], paradas[s + 1]];
    for (let i = 0; i < MUESTRAS_POR_TRAMO; i++) {
      const t = i / (MUESTRAS_POR_TRAMO - 1);
      const fondo = a.color.map((c, k) => Math.round(c + (b.color[k] - c) * t));
      const r = ratio(tintaDe(fondo), fondo);
      if (r < peor.r) peor = { r, pos: a.pos + (b.pos - a.pos) * t, fondo };
    }
  }
  return peor;
}

const rampas = GRADIENTES.map((token) => ({
  token,
  paradas: paradasGradiente(ganadora(flitTokens, FLIT_TOKENS_CSS, [':root'], token).valor, token),
}));

console.log(`\nGradientes FLIT — texto blanco puro, ${MUESTRAS_POR_TRAMO} muestras por tramo`);
for (const { token, paradas } of rampas) {
  const peor = peorDelGradiente(paradas, () => BLANCO);
  const ok = peor.r >= MINIMO;
  if (!ok) fallosGradiente++;
  console.log(
    `${ok ? '✓' : '✗'} ${token.padEnd(26)} peor ${peor.r.toFixed(2)} en ${peor.pos.toFixed(0).padStart(3)}% (${hex(peor.fondo)})`,
  );
}

// Hard-stop de la spec firmada (docs/ux/shell-tema-y-responsive.md, § Hard-stops): PROHIBIDO
// `--flit-cyan` (#4FD4CC) como parada de un gradiente que sirve de fondo a texto blanco. Es el
// peor punto histórico del sistema —1,81:1— y el motivo por el que el Bug #11766 movió los cuatro
// ramos al nivel `-ink`.
//
// El bucle de ratios de aquí arriba ya lo cazaría hoy, así que esta comprobación parece de más.
// No lo es, y la diferencia importa: aquélla prohíbe el NÚMERO mientras el umbral valga 4,5; ésta
// prohíbe el COLOR. Sobreviven cosas distintas — un texto que dejara de ser blanco puro, un
// umbral de texto grande (3:1), un muestreo distinto — y la prohibición de la spec es por color.
const CIAN_PROHIBIDO = rgb('#4FD4CC');
let paradasCian = 0;
for (const { token, paradas } of rampas) {
  for (const parada of paradas) {
    if (!parada.color.every((c, i) => c === CIAN_PROHIBIDO[i])) continue;
    paradasCian++;
    fallosGradiente++;
    console.log(
      `✗ ${token.padEnd(26)} parada en #4FD4CC al ${parada.pos.toFixed(0)}% — prohibido como fondo`
        + ' de texto blanco (spec § Hard-stops). Usa --flit-cyan-ink.',
    );
  }
}
if (paradasCian === 0) {
  console.log(`✓ ${'#4FD4CC'.padEnd(26)} no aparece como parada en ninguno de los ${GRADIENTES.length} gradientes.`);
}

// ── Acoplamiento: el anillo de foco del drawer (SC 1.4.11) ───────────────────────────────
// `.flit-focus-light` tiene un único consumidor, FlitSidebar, y la superficie que pinta ese
// componente es --flit-gradient-sidebar (FlitSidebar.tsx:185). Se comprueba aparte de la lista de
// arriba porque su mínimo es otro —3:1, indicador de foco, no texto— y porque es la trampa de
// #11766: la regla es navy desde #11604 y lo es PORQUE el gradiente era claro. Si el gradiente se
// oscurece, ese arreglo se invierte y el anillo deja de cumplir sin que nada avise. Aquí avisa.
const anillo = leer(flitTokens, FLIT_TOKENS_CSS, ['.flit-focus-light:focus-visible'], 'box-shadow');
const rampaDrawer = rampas.find((r) => r.token === '--flit-gradient-sidebar');
const peorAnillo = peorDelGradiente(rampaDrawer.paradas, (fondo) => sobre(anillo.color, anillo.alfa, fondo));
const anilloOk = peorAnillo.r >= MINIMO_NO_TEXTO;
if (!anilloOk) fallosGradiente++;
console.log(
  `${anilloOk ? '✓' : '✗'} ${'.flit-focus-light'.padEnd(26)} peor ${peorAnillo.r.toFixed(2)} en `
    + `${peorAnillo.pos.toFixed(0).padStart(3)}% (${hex(peorAnillo.fondo)}) — anillo ${hex(sobre(anillo.color, anillo.alfa, peorAnillo.fondo))} sobre el gradiente del drawer, mínimo ${MINIMO_NO_TEXTO}`,
);

if (fallos + fallosGradiente + fallosPares > 0) {
  console.error(
    `\n✗ ${fallos + fallosGradiente + fallosPares} comprobación(es) de contraste en rojo.`
      + '\n  Si lo que falla son los gradientes: la salida de arriba dice en qué % del recorrido y'
      + '\n  con qué color compuesto, así que no hay que remedir a mano. Y no se arregla repintando'
      + '\n  los consumidores —son más de cien y casi todos escriben el gradiente en línea—: se'
      + '\n  arregla en flit-tokens.css, que es la única capa que los alcanza a todos.'
      + '\n  Ojo con QUÉ se edita ahí: las paradas de --flit-gradient-* son `var(--flit-*-ink)`, así'
      + '\n  que el color vive en el token -ink y mover ESE mueve el gradiente y el chip a la vez.'
      + '\n  Si sólo quieres mover el gradiente, cambia la parada; si sólo la tinta, el token.'
      + '\n  Si lo que falla es .flit-focus-light: su color y el gradiente del drawer están acoplados,'
      + '\n  se mueven juntos o se rompe el foco visible (SC 1.4.11). Ver docs/ux/gradientes-texto-kit-flit.md.',
  );
  process.exit(1);
}
console.log(
  `\n✓ Contraste OK: CommandPalette en tema ${TEMAS.join(' y ')} (${resultados[0].total} puntos),`
    + ` los pares --flit-* del kit (${PARES_OBLIGATORIOS.length} tokens con par oscuro, medidos en`
    + ` los dos temas), el aviso de desborde de FlitTable con umbral ${MINIMO_NO_TEXTO}:1`
    + ` y los ${GRADIENTES.length} gradientes FLIT + su anillo de foco.`,
);
