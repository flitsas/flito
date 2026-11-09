// Emisor mínimo de YAML para los contratos: determinista y sin dependencias. Las cadenas ambiguas van con comillas de JSON,
// que YAML acepta tal cual. No hace falta leer YAML genérico: check-rutas-contrato.mjs solo necesita la sección `paths`.

const SEGURO = /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ_/][A-Za-z0-9ÁÉÍÓÚÜÑáéíóúüñ_/.\- ]*$/;
const RESERVADAS = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off', 'y', 'n', '~']);

function escalar(v) {
  if (v === null) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  if (SEGURO.test(s) && !RESERVADAS.has(s.toLowerCase()) && !s.endsWith(' ')) return s;
  return JSON.stringify(s);
}

const vacio = (v) => (Array.isArray(v) ? '[]' : '{}');
const compuesto = (v) => v !== null && typeof v === 'object' && Object.keys(v).length > 0;

function emitir(v, sangria, lineas) {
  const pre = ' '.repeat(sangria);
  if (Array.isArray(v)) {
    for (const item of v) {
      if (!compuesto(item)) { lineas.push(`${pre}- ${item !== null && typeof item === 'object' ? vacio(item) : escalar(item)}`); continue; }
      const sub = [];
      emitir(item, sangria + 2, sub);
      sub[0] = `${pre}- ${sub[0].slice(sangria + 2)}`;
      lineas.push(...sub);
    }
    return;
  }
  for (const [clave, valor] of Object.entries(v)) {
    if (valor === undefined) continue;
    const k = escalar(clave);
    if (compuesto(valor)) {
      lineas.push(`${pre}${k}:`);
      emitir(valor, sangria + 2, lineas);
    } else lineas.push(`${pre}${k}: ${valor !== null && typeof valor === 'object' ? vacio(valor) : escalar(valor)}`);
  }
}

export function aYaml(doc) {
  const lineas = [];
  emitir(doc, 0, lineas);
  return `${lineas.join('\n')}\n`;
}
