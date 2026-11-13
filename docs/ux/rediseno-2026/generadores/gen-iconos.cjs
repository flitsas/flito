// iconos-kit.ts (flit develop packages/ui) → árbol de nodos TS, sin innerHTML.
const fs = require('fs');
const [,, SRC, OUT] = process.argv;
const src = fs.readFileSync(SRC, 'utf8');
const body = src.slice(src.indexOf('{', src.indexOf('export const GLIFOS')));
const end = body.search(/\n\} as const/);
// el objeto es JSON con comentarios //
const json = body.slice(0, end + 2).split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n').replace(/\}\s*as\s+Record[^;]*$/, '}');
const G = Function('return ' + json)();
const camel = (a) => (a === 'class' ? 'className' : a.startsWith('xlink:') ? 'xlinkHref' : a.replace(/-([a-z])/g, (_, c) => c.toUpperCase()));
function parse(s) {
  const re = /<(\/?)([a-zA-Z]+)([^>]*?)(\/?)>/g; const root = []; const st = [root]; let m;
  while ((m = re.exec(s))) {
    const [, close, tag, attrs, self] = m;
    if (close) { st.pop(); continue; }
    const a = {}; attrs.replace(/([a-zA-Z:-]+)="([^"]*)"/g, (_, k, v) => { a[camel(k)] = v; });
    const node = [tag, a]; st[st.length - 1].push(node);
    if (!self) { node.push([]); st.push(node[2]); }
  }
  return root;
}
const lines = Object.entries(G).map(([k, g]) => `  ${JSON.stringify(k)}: { vb: ${JSON.stringify(g.vb)}, n: ${JSON.stringify(parse(g.inner))} },`);
fs.writeFileSync(OUT, `/* eslint-disable max-lines */
// GENERADO desde flit develop packages/ui/src/iconos-kit.ts (Manual UI Kit 2026, propuesta-2). No editar a mano.
// Cada glifo es un árbol [etiqueta, atributos, hijos]; «__K__» en un atributo se sustituye por un id único (máscaras).
export type NodoSvg = [string, Record<string, string>, NodoSvg[]?];
export interface Glifo { vb: string; n: NodoSvg[] }
export const GLIFOS = {
${lines.join('\n')}
} satisfies Record<string, Glifo>;
export type NombreIcono = keyof typeof GLIFOS;
`);
console.log(Object.keys(G).length, 'glifos');
