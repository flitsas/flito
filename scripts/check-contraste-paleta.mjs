// Gate de contraste sin navegador (`npm run check:contraste`, job de CI) — UI Kit 2026 (Épica #14560).
//
// ── Por qué se reescribió (S0, ronda 2) ──────────────────────────────────────────────────────
// La versión anterior medía la piel vieja: la CommandPalette sobre `--flit-*` / `--aura-*` con sus
// capas translúcidas (Bugs #11720 y #11767) y todo punto de cada `--flit-gradient-*` con texto
// blanco (Bug #11766). Con el UI Kit 2026 esos tokens son ALIAS (`styles/tokens.css` §4) y el kit
// no lleva degradados en botones ni en superficies («degradado» de acción = relleno plano), así
// que los casos de gradientes se ELIMINARON: medían algo que ya no se pinta. Lo que se conserva es
// el principio de los dos bugs: leer los valores del CSS REAL y recomponer la superficie que de
// verdad hay debajo, nunca comparar contra una lista de ratios copiada a mano (un gate que compara
// contra su propia foto no protege nada). Si alguien cambia un hex del kit, este script remide.
//
// ── Waiver de contraste (ADR-0050) ──────────────────────────────────────────────────────────
// Waiver de contraste — decisión de David, 2026-11-26, `docs/ux/flito-tramites-rediseno.md` §6 (R3), y
// `docs/adr/ADR-0050-azul-557eff-waiver-contraste.md`. El azul de marca #557eff deja bajo AA una lista
// CERRADA de pares, que vive en `scripts/contraste-waivers.json` (la lee también el helper de axe de E2E).
// Reglas: `AA` no cambia; una entrada solo aplica si el texto o el fondo del par es exactamente el `color`
// del waiver (si el azul se mueve, el par vuelve a medirse contra 4,5); por debajo de su `minimo` sigue
// siendo FALLA; y TRINQUETE: una entrada que no corresponde a ningún caso medido, o cuyo par ya cumple AA,
// hace fallar el gate («retira la entrada del waiver»). Cada caso lleva una `clave` estable para casarlo.
//
// Sigue existiendo por el mismo motivo de siempre: `axe` no es dependencia del repo y el CI no
// ejecuta E2E, así que ningún otro gate del pipeline ve un contraste roto.
//
// ── Qué mide (AA 4,5:1, tema claro y oscuro) ────────────────────────────────────────────────
//   1. Texto primario, secundario y terciario sobre fondo y superficie.
//   2. Azul de texto (`--color-action`: #557EFF claro, bajo waiver ADR-0050 / #8FB0FF oscuro) sobre fondo, superficie y hover.
//   3. Blanco sobre botón azul, tinta y naranja (también el «Salir» del menú de usuario y las
//      cabeceras azules del dock y del menú), y tinta sobre el botón verde.
//   4. Cada `--ct` de `.kit-etiqueta` sobre su fondo `color-mix(--c 10 %, superficie)`.
//   5. CommandPalette: ítem activo (texto sobre `--kit-hover`), título de grupo y teclas.
//
// ── Cómo lee el CSS ─────────────────────────────────────────────────────────────────────────
// Recorre, en el orden de cascada de `src/index.css`, `kit/kit-variables.css`, `tokens.css`,
// `kit/kit-propuesta.css`, `kit/kit-ui.css`, `kit/kit-react.css` e `index.css`. Ignora lo que está
// dentro de `@media`/`@theme` (el gemelo `prefers-color-scheme` de tokens.css repite los valores de
// `[data-theme="dark"]`). Tema claro = `:root` + `:root:not([data-theme="dark"])`; oscuro = `:root`
// + `[data-theme="dark"]`. Gana la especificidad mayor y, a igualdad, la declaración posterior.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web', 'src');
const ARCHIVOS = [
  'styles/kit/kit-variables.css',
  'styles/tokens.css',
  'styles/kit/kit-propuesta.css',
  'styles/kit/kit-ui.css',
  'styles/kit/kit-react.css',
  'index.css',
];
const AA = 4.5;
const WAIVER = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'contraste-waivers.json'), 'utf8'));

// ---------- 1. Parser mínimo: reglas de primer nivel (sin @media / @theme / @font-face) ----------
function reglas(css) {
  const limpio = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const salida = [];
  let i = 0;
  while (i < limpio.length) {
    const llave = limpio.indexOf('{', i);
    if (llave < 0) break;
    let cabeza = limpio.slice(i, llave);
    // Sentencias `@import …;` sueltas antes de la regla.
    const pyc = cabeza.lastIndexOf(';');
    if (pyc >= 0) cabeza = cabeza.slice(pyc + 1);
    cabeza = cabeza.trim();
    let prof = 1;
    let j = llave + 1;
    while (j < limpio.length && prof > 0) {
      if (limpio[j] === '{') prof++;
      else if (limpio[j] === '}') prof--;
      j++;
    }
    const cuerpo = limpio.slice(llave + 1, j - 1);
    if (!cabeza.startsWith('@')) {
      const decl = {};
      for (const parte of cuerpo.split(';')) {
        const dp = parte.indexOf(':');
        if (dp < 0) continue;
        decl[parte.slice(0, dp).trim()] = parte.slice(dp + 1).trim().replace(/\s*!important$/, '');
      }
      salida.push({ selectores: cabeza.split(',').map((s) => s.trim().replace(/\s+/g, ' ')), decl });
    }
    i = j;
  }
  return salida;
}

const REGLAS = ARCHIVOS.flatMap((f) => reglas(readFileSync(join(RAIZ, f), 'utf8')));

const OSCURO = '[data-theme="dark"]';
const NO_OSCURO = ':root:not([data-theme="dark"])';

// Variables globales por tema.
function variablesDe(tema) {
  const peso = (sel) => {
    if (sel === ':root') return 1;
    if (tema === 'claro' && sel === NO_OSCURO) return 2;
    if (tema === 'oscuro' && sel === OSCURO) return 1;
    return 0;
  };
  const vars = new Map();
  REGLAS.forEach((r, orden) => {
    const p = Math.max(...r.selectores.map(peso));
    if (p === 0) return;
    for (const [k, v] of Object.entries(r.decl)) {
      if (!k.startsWith('--')) continue;
      const previo = vars.get(k);
      if (!previo || p > previo.p || (p === previo.p && orden >= previo.orden)) vars.set(k, { v, p, orden });
    }
  });
  return new Map(Array.from(vars, ([k, { v }]) => [k, v]));
}

/**
 * Declaraciones de un componente en un tema: las del selector base y, encima, las de su variante con
 * prefijo de tema (`[data-theme="dark"] sel` o `:root:not([data-theme="dark"]) sel`). Último gana.
 */
function propsDe(selector, tema) {
  const prefijo = tema === 'oscuro' ? OSCURO : NO_OSCURO;
  const base = {};
  const conTema = {};
  for (const r of REGLAS) {
    if (r.selectores.includes(selector)) Object.assign(base, r.decl);
    if (r.selectores.includes(`${prefijo} ${selector}`)) Object.assign(conTema, r.decl);
  }
  return { ...base, ...conTema };
}

/** Como `propsDe`, pero para reglas oscuras cuyo selector solo EMPIEZA por `[data-theme="dark"] <inicio>`. */
function propsOscuroQueEmpieza(inicio) {
  const out = {};
  for (const r of REGLAS) if (r.selectores.some((s) => s.startsWith(`${OSCURO} ${inicio}`))) Object.assign(out, r.decl);
  return out;
}

// ---------- 2. Resolución de color: var(), color-mix(in srgb …), hex con alfa ----------
function hexARgba(hex) {
  let h = hex.replace('#', '').toLowerCase();
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
  const n = (k) => parseInt(h.slice(k, k + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
}

function partirArgs(s) {
  const args = [];
  let prof = 0;
  let actual = '';
  for (const c of s) {
    if (c === '(') prof++;
    if (c === ')') prof--;
    if (c === ',' && prof === 0) { args.push(actual.trim()); actual = ''; continue; }
    actual += c;
  }
  if (actual.trim()) args.push(actual.trim());
  return args;
}

function resolver(valor, vars, locales = {}, guarda = 0) {
  if (guarda > 30) throw new Error(`Ciclo de var() resolviendo «${valor}»`);
  const v = valor.trim();
  const mv = v.match(/^var\((--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/);
  if (mv) {
    const crudo = locales[mv[1]] ?? vars.get(mv[1]) ?? mv[2];
    if (crudo == null) throw new Error(`Variable sin definir: ${mv[1]}`);
    return resolver(crudo, vars, locales, guarda + 1);
  }
  const mm = v.match(/^color-mix\(\s*in srgb\s*,([\s\S]+)\)$/);
  if (mm) {
    const [a, b] = partirArgs(mm[1]);
    const pa = a.match(/^([\s\S]+?)\s+([\d.]+)%$/);
    const pb = b.match(/^([\s\S]+?)\s+([\d.]+)%$/);
    const ca = resolver(pa ? pa[1] : a, vars, locales, guarda + 1);
    const cb = resolver(pb ? pb[1] : b, vars, locales, guarda + 1);
    const wa = pa ? Number(pa[2]) / 100 : pb ? 1 - Number(pb[2]) / 100 : 0.5;
    const mix = (x, y) => x * wa + y * (1 - wa);
    return { r: mix(ca.r, cb.r), g: mix(ca.g, cb.g), b: mix(ca.b, cb.b), a: mix(ca.a, cb.a) };
  }
  if (/^#[0-9a-f]{3,8}$/i.test(v)) return hexARgba(v);
  if (v === 'white') return hexARgba('#ffffff');
  if (v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  throw new Error(`Color no soportado por el gate: «${v}»`);
}

/** Compone `arriba` (con alfa) sobre `abajo` (opaco). */
function sobre(arriba, abajo) {
  const a = arriba.a;
  return { r: arriba.r * a + abajo.r * (1 - a), g: arriba.g * a + abajo.g * (1 - a), b: arriba.b * a + abajo.b * (1 - a), a: 1 };
}

function luminancia({ r, g, b }) {
  const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function ratio(a, b) {
  const [l1, l2] = [luminancia(a), luminancia(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
const hex = ({ r, g, b }) => `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;

// ---------- 3. Casos ----------
function casosDe(tema) {
  const vars = variablesDe(tema);
  const color = (expr, locales) => resolver(expr, vars, locales);
  const fondo = color('var(--color-surface)');
  const superficie = color('var(--color-surface-elevated)');
  const hover = sobre(color('var(--kit-hover)'), superficie);
  const casos = [];
  const caso = (clave, nombre, texto, bajo) => casos.push({ clave, nombre, texto: sobre(texto, bajo), fondo: bajo });

  // 1. Texto
  for (const [n, t] of [['primario', '--color-text-primary'], ['secundario', '--color-text-secondary'], ['terciario', '--color-text-tertiary']]) {
    caso(`texto-${n}/fondo`, `texto ${n} / fondo`, color(`var(${t})`), fondo);
    caso(`texto-${n}/superficie`, `texto ${n} / superficie`, color(`var(${t})`), superficie);
  }
  // 2. Azul de texto
  const azul = color('var(--color-action)');
  caso('azul-texto/fondo', `azul de texto ${hex(azul)} / fondo`, azul, fondo);
  caso('azul-texto/superficie', `azul de texto ${hex(azul)} / superficie`, azul, superficie);
  caso('azul-texto/hover', `azul de texto ${hex(azul)} / hover`, azul, hover);

  // 3. Botones (fondo = --b o background del componente; texto = su color)
  const boton = (clave, nombre, props, extraOscuro = {}) => {
    const p = { ...props, ...(tema === 'oscuro' ? extraOscuro : {}) };
    const bg = color(p['background-color'] ?? p.background ?? 'var(--b)', p);
    caso(clave, nombre, color(p.color, p), sobre(bg, superficie));
  };
  const btn = propsDe('.btn', tema);
  boton('blanco/boton-azul', 'blanco / botón azul', btn, propsOscuroQueEmpieza('.btn:not(.secondary)'));
  boton('blanco/boton-tinta', 'blanco / botón tinta', { ...btn, ...propsDe('.btn.secondary', tema) });
  boton('blanco/boton-naranja', 'blanco / botón naranja (.btn.alerta)', { ...btn, ...propsDe('.btn.alerta', tema) });
  boton('blanco/salir-menu-usuario', 'blanco / «Salir» del menú de usuario', { ...btn, ...propsDe('.btn.secondary', tema), ...propsDe('.menu-flotante .menu-usuario__pie .btn', tema) });
  boton('tinta/boton-verde', 'tinta / botón verde (.btn.positiva)', { ...btn, ...propsDe('.btn.positiva', tema) });
  for (const [sel, clave] of [['.menu-usuario__cabeza', 'blanco/cabecera-menu-usuario'], ['.dock__cabeza', 'blanco/cabecera-dock']]) {
    const p = propsDe(sel, tema);
    caso(clave, `blanco / cabecera azul (${sel})`, color('var(--kit-sobre-relleno)'), color(p['background-color'] ?? p.background));
  }

  // 4. Etiquetas: --ct sobre color-mix(--c 10 %, superficie)
  const tonos = new Set();
  for (const r of REGLAS) for (const s of r.selectores) { const m = s.match(/^\.kit-etiqueta\[data-tono="([\w-]+)"\]$/); if (m) tonos.add(m[1]); }
  // El relleno claro es el ::after (el ::before, en --c pleno, es solo el borde de 1 px).
  const fondoEtiqueta = propsDe('.kit-etiqueta::after', tema).background;
  for (const tono of tonos) {
    const p = { ...propsDe('.kit-etiqueta', tema), ...propsDe(`.kit-etiqueta[data-tono="${tono}"]`, tema) };
    const locales = { '--c': p['--c'] };
    if (p['--ct']) locales['--ct'] = p['--ct'];
    const bg = sobre(color(fondoEtiqueta, locales), superficie);
    caso(`etiqueta/${tono}`, `etiqueta «${tono}» --ct / su fondo`, color(p.color, locales), bg);
  }

  // 5. CommandPalette (.kit-modal sobre superficie elevada)
  const modal = sobre(color(propsDe('.kit-modal', tema).background), fondo);
  const activo = sobre(color(propsDe('.resultado[aria-selected="true"]', tema).background), modal);
  caso('paleta/activo-titulo', 'paleta · ítem activo, título', color('var(--color-text-primary)'), activo);
  caso('paleta/activo-seccion', 'paleta · ítem activo, sección', color('var(--color-text-tertiary)'), activo);
  caso('paleta/grupo', 'paleta · título de grupo', color(propsDe('.resultados .grupo', tema).color), modal);
  const kbd = propsDe('.flit-shell-kbd', tema);
  caso('paleta/teclas', 'paleta · teclas (↑↓ ↵ Esc)', color(kbd.color), sobre(color(kbd.background), modal));
  return casos;
}

// ---------- 4. Informe ----------
// Con 2 decimales, como se imprime: el `minimo` del JSON es la cifra que se lee en la salida.
const r2 = (r) => Math.round(r * 100) / 100;
const colorWaiver = WAIVER.color.toLowerCase();
const usadas = new Set();
let fallos = 0;
let total = 0;
let bajoWaiver = 0;
const obsoletas = [];
for (const tema of ['claro', 'oscuro']) {
  console.log(`\n── Tema ${tema} ──`);
  for (const c of casosDe(tema)) {
    total++;
    const r = ratio(c.texto, c.fondo);
    const ok = r >= AA;
    const entrada = WAIVER.pares.find((w) => w.tema === tema && w.caso === c.clave);
    const ref = `${c.texto && hex(c.texto)} sobre ${hex(c.fondo)}  ${c.nombre}`;
    if (entrada) {
      usadas.add(`${tema}|${c.clave}`);
      if (ok) obsoletas.push(`${tema} · ${c.clave}: ya cumple AA (${r.toFixed(2)}:1)`);
    }
    const atado = entrada && (hex(c.texto) === colorWaiver || hex(c.fondo) === colorWaiver);
    if (!ok && atado && r2(r) >= entrada.minimo && r2(r) >= WAIVER.piso) {
      bajoWaiver++;
      console.log(`WAIVER ${r.toFixed(2).padStart(5)}:1  ${ref}  (ADR-0050, mínimo ${entrada.minimo.toFixed(2)})`);
      continue;
    }
    if (!ok) fallos++;
    console.log(`${ok ? 'OK  ' : 'FALLA'} ${r.toFixed(2).padStart(5)}:1  ${ref}${!ok && entrada ? `  (en el waiver, pero ${atado ? `bajo su mínimo ${entrada.minimo}` : `ya no es ${colorWaiver}`})` : ''}`);
  }
}
for (const w of WAIVER.pares) if (!usadas.has(`${w.tema}|${w.caso}`)) obsoletas.push(`${w.tema} · ${w.caso}: no corresponde a ningún caso medido`);
console.log(`\n${total - fallos - bajoWaiver}/${total} pares cumplen AA ${AA}:1 · ${bajoWaiver} bajo waiver ADR-0050.`);
if (obsoletas.length > 0) {
  for (const o of obsoletas) console.error(`WAIVER OBSOLETO — ${o}: retira la entrada del waiver (scripts/contraste-waivers.json).`);
}
if (fallos > 0) console.error(`check:contraste — ${fallos} par(es) por debajo de AA.`);
if (fallos > 0 || obsoletas.length > 0) process.exit(1);
console.log('check:contraste — OK.');
