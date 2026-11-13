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
const t = proc('tokens.css'); const p = proc('propuesta.css'); const k = proc('ui-kit-2026.css');
const tokensRaw = fix(fs.readFileSync(path.join(P, 'tokens.css'), 'utf8'));
fs.writeFileSync(path.join(OUT, 'kit-variables.css'),
  '/* GENERADO desde docs/design/propuesta-ui-kit-2026 (repo flit, rama propuesta-2): tokens.css + bloques de\n * variables de propuesta.css y ui-kit-2026.css, en el mismo orden de cascada. No editar a mano: ver\n * docs/ux/rediseno-2026/README.md. Sin capa (gana a @layer), por eso aquí solo van variables. */\n\n' +
  tokensRaw + '\n/* ---- propuesta.css ---- */\n' + p.vars + '\n/* ---- ui-kit-2026.css ---- */\n' + k.vars + '\n');
fs.writeFileSync(path.join(OUT, 'kit-propuesta.css'), '/* GENERADO desde propuesta.css (propuesta-2). Se importa en @layer components: las utilidades de Tailwind ganan.\n * Selectores globales de elemento retirados (los da el preflight); table/th/td acotados a .tabla-wrap; main → .kit-main; body → .kit-cuerpo. */\n' + p.comps);
fs.writeFileSync(path.join(OUT, 'kit-ui.css'), '/* GENERADO desde ui-kit-2026.css (propuesta-2). Mismas reglas que kit-propuesta.css. */\n' + k.comps);
console.log('ok', t.vars.length, p.vars.length, k.vars.length);
