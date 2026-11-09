// Traducción de rutas de Express a OpenAPI, compartida por generar-openapi.mjs y check-rutas-contrato.mjs para que
// comparen exactamente lo mismo.

/** `/a/:id(\\d+)/b/:otro?` → `/a/{id}/b/{otro}`. */
export function aRutaOpenApi(ruta) {
  return ruta.replace(/:([A-Za-z0-9_]+)(\((?:[^()]|\([^()]*\))*\))?\??/g, '{$1}');
}

/** Parámetros de ruta declarados, con el patrón de Express si lo tiene (`:id(\\d+)`). */
export function parametrosDeRuta(ruta) {
  const salida = [];
  for (const m of ruta.matchAll(/:([A-Za-z0-9_]+)(\(((?:[^()]|\([^()]*\))*)\))?/g)) {
    const schema = m[3] ? { type: 'string', pattern: `^${m[3]}$` } : { type: 'string' };
    salida.push({ name: m[1], in: 'path', required: true, description: `Parámetro ${m[1]} de la ruta.`, schema });
  }
  return salida;
}

export function identificadorDe(metodo, ruta) {
  const limpia = aRutaOpenApi(ruta).replace(/[{}]/g, '').replace(/^\/+/, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/-+$/, '');
  return `${metodo}-${limpia}`;
}

/** Del texto de un YAML de OpenAPI saca el conjunto `metodo ruta` de la sección `paths`. Sin dependencias. */
export function operacionesDeYaml(texto) {
  const operaciones = new Set();
  let enPaths = false;
  let ruta = null;
  for (const linea of texto.split(/\r?\n/)) {
    if (/^[A-Za-z]/.test(linea)) {
      enPaths = linea.startsWith('paths:');
      ruta = null;
      continue;
    }
    if (!enPaths) continue;
    const r = /^ {2}("?)(\/[^"]*)\1:\s*$/.exec(linea);
    if (r) { ruta = r[2]; continue; }
    const m = /^ {4}(get|post|put|patch|delete|head|options):\s*$/.exec(linea);
    if (m && ruta) operaciones.add(`${m[1]} ${ruta}`);
  }
  return operaciones;
}

/** Compara el inventario de Express con las operaciones del contrato. */
export function compararRutas(inventario, operaciones) {
  const reales = new Set(inventario.map((r) => `${r.metodo} ${aRutaOpenApi(r.ruta)}`));
  return {
    faltan: [...reales].filter((k) => !operaciones.has(k)).sort(),
    sobran: [...operaciones].filter((k) => !reales.has(k)).sort(),
  };
}
