// Genera styles/kit/*.css desde la propuesta: separa variables (sin capa) de componentes (capa components).
const fs = require('fs'); const path = require('path');
const postcss = require(require.resolve('postcss', { paths: ['/home/david/flit/flito'] }));
const [,, P, OUT] = process.argv;
const VAR_SEL = /^(:root|\[data-theme="dark"\]|:root:not\(\[data-theme="dark"\]\))$/;
const TABLA = /^(\[data-theme="dark"\]\s+)?(table|th|td|tbody|thead|tr)(\b|$)/;
function fix(css) { return css.replace(/assets\/kit\//g, '/kit/').replace(/assets\/ilustraciones\//g, '/kit/ilustraciones/'); }
function proc(file) {
  const root = postcss.parse(fix(fs.readFileSync(path.join(P, file), 'utf8')));
  const vars = [];
  root.walkRules((r) => {
    if (r.parent.type === 'root' && VAR_SEL.test(r.selector.trim()) && r.nodes.every((n) => n.type === 'comment' || (n.type === 'decl' && n.prop.startsWith('--')))) {
      vars.push(r.clone()); r.remove(); return;
    }
    if (r.parent.type === 'root' || r.parent.type === 'atrule') {
      r.selectors = r.selectors.map((s) => {
        s = s.trim();
        if (/^main$/.test(s)) return '.kit-main';
        if (s === 'body') return '.kit-cuerpo';
        if (TABLA.test(s)) return s.replace(TABLA, (m, d, el) => `${d || ''}.tabla-wrap ${el}`).replace(/\btable:not\(\.matriz\)/, 'table:not(.matriz)');
        if (/^table:not/.test(s)) return '.tabla-wrap ' + s;
        if (/^(img|button, input, select|a|html|\*, \*::before, \*::after)$/.test(s)) return null;
        return s;
      }).filter(Boolean);
      if (!r.selectors.length) r.remove();
    }
  });
  return { vars: vars.map(String).join('\n'), comps: root.toString() };
}
// ── Marca FLITO (ADR-0050) ──────────────────────────────────────────────────────────────────────
// El bloque final de contraste de la propuesta pisa el azul de marca en el tema claro con #1d53ff/#1746e0.
// David decidió (2026-11-26) que TODO el azul vuelva a #557eff, con un waiver de contraste acotado
// (`scripts/contraste-waivers.json`). La tabla son sustituciones EXACTAS con su número de apariciones: si la
// propuesta se movió y alguna no cuadra, el generador aborta en vez de dejar un azul a medias. También recoge
// el cursor de marca de `.kit-cuerpo`, retirado a mano en S0, para que regenerar sea idempotente.
const AZUL_HOVER = 'color-mix(in srgb, var(--kit-azul) 86%, var(--kit-tinta))';
const MARCA_FLITO = {
  'kit-variables.css': [
    ['--kit-azul: #1d53ff; --kit-azul-hover: #1746e0;', `--kit-azul: #557eff; --kit-azul-hover: ${AZUL_HOVER};`, 1],
    ['--color-action: #1d53ff; --gradient-action: linear-gradient(#1d53ff, #1d53ff); --gradient-action-hover: linear-gradient(#1746e0, #1746e0);',
      '--color-action: var(--kit-azul); --gradient-action: linear-gradient(var(--kit-azul), var(--kit-azul)); --gradient-action-hover: linear-gradient(var(--kit-azul-hover), var(--kit-azul-hover));', 1],
    ['--color-highlight: #1d53ff; --color-highlight-display: #1d53ff; --color-heading: #1d53ff; --color-info: #1d53ff;',
      '--color-highlight: var(--kit-azul); --color-highlight-display: var(--kit-azul); --color-heading: var(--kit-azul); --color-info: var(--kit-azul);', 1],
    ['--kit-azul-relleno: #1d53ff;', '--kit-azul-relleno: #557eff;', 1],
  ],
  'kit-ui.css': [
    ['.kit-cuerpo { font-size: var(--text-body); font-weight: 400; cursor: url("/kit/cursor.svg") 2 2, auto; }',
      '.kit-cuerpo { font-size: var(--text-body); font-weight: 400; }', 1],
    ['#1670b8 55%, #1d53ff 100%)', '#1670b8 55%, var(--kit-azul-relleno) 100%)', 1],
    ['.banner-muestra--azul { background: #1d53ff; }', '.banner-muestra--azul { background: var(--kit-azul-relleno); }', 1],
    ['border-color: #1d53ff; color: #1d53ff;', 'border-color: var(--kit-azul); color: var(--kit-azul);', 1],
    ['#1d53ff', 'var(--kit-azul-relleno)', 3],
  ],
};
function marcaFlito(archivo, css) {
  let out = css;
  for (const [de, a, n] of MARCA_FLITO[archivo] ?? []) {
    const veces = out.split(de).length - 1;
    if (veces !== n) throw new Error(`MARCA_FLITO ${archivo}: «${de}» aparece ${veces} vez/veces, se esperaban ${n}. ¿Se movió la propuesta?`);
    out = out.split(de).join(a);
  }
  if (/1d53ff|1746e0/i.test(out)) throw new Error(`MARCA_FLITO ${archivo}: quedó #1d53ff/#1746e0 tras el parche (ADR-0050).`);
  return out;
}
const escribir = (archivo, css) => fs.writeFileSync(path.join(OUT, archivo), marcaFlito(archivo, css));

const t = proc('tokens.css'); const p = proc('propuesta.css'); const k = proc('ui-kit-2026.css');
const tokensRaw = fix(fs.readFileSync(path.join(P, 'tokens.css'), 'utf8'));
escribir('kit-variables.css',
  '/* GENERADO desde docs/design/propuesta-ui-kit-2026 (repo flit, rama propuesta-2): tokens.css + bloques de\n * variables de propuesta.css y ui-kit-2026.css, en el mismo orden de cascada. No editar a mano: ver\n * docs/ux/rediseno-2026/README.md. Sin capa (gana a @layer), por eso aquí solo van variables. */\n\n' +
  tokensRaw + '\n/* ---- propuesta.css ---- */\n' + p.vars + '\n/* ---- ui-kit-2026.css ---- */\n' + k.vars + '\n');
escribir('kit-propuesta.css', '/* GENERADO desde propuesta.css (propuesta-2). Se importa en @layer components: las utilidades de Tailwind ganan.\n * Selectores globales de elemento retirados (los da el preflight); table/th/td acotados a .tabla-wrap; main → .kit-main; body → .kit-cuerpo. */\n' + p.comps);
escribir('kit-ui.css', '/* GENERADO desde ui-kit-2026.css (propuesta-2). Mismas reglas que kit-propuesta.css. */\n' + k.comps);
console.log('ok', t.vars.length, p.vars.length, k.vars.length);
