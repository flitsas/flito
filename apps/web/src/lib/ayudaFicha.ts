// Encabezado de las fichas de Ayuda FLITO (Feature #13691 · HU #13703, diseño slim §1).
// Subconjunto estricto de YAML, parseado a mano (sin dependencia):
//   ---
//   resumen: texto en una línea (sin comillas; `:` y `,` no rompen nada)
//   palabras_clave:
//     - item
//   consultas:
//     - item
//   version: 1.0
//   fecha: 2026-10-20
//   ---
// Sin anidamiento, multilínea, comillas ni comentarios. Clave desconocida = error.
// Runtime tolerante (encabezado inválido → `encabezado: null`, el cuerpo se pinta igual);
// la prueba de artefactos es estricta (`errores.length > 0` = falla).
// Módulo puro: Playwright lo importa desde `src` (sin react, api ni import.meta.env).

export interface EncabezadoFicha {
  resumen: string;
  palabrasClave: string[];
  consultas: string[];
  version: string;
  /** ISO `AAAA-MM-DD`. */
  fecha: string;
}

export interface FichaParseada {
  /** `null` si falta el bloque o es inválido. */
  encabezado: EncabezadoFicha | null;
  /** Lo que hay después del `---` de cierre (o todo, si no hay bloque). */
  cuerpo: string;
  /** Vacío = válido. */
  errores: string[];
}

const DELIM = '---';
const CLAVES_ESCALAR = new Set(['resumen', 'version', 'fecha']);
const CLAVES_LISTA = new Set(['palabras_clave', 'consultas']);
const RE_VERSION = /^\d+\.\d+$/;
const RE_FECHA = /^(\d{4})-(\d{2})-(\d{2})$/;

export function esFechaIsoValida(iso: string): boolean {
  const m = RE_FECHA.exec(iso);
  if (!m) return false;
  const [a, mes, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(a, mes - 1, d));
  return t.getUTCFullYear() === a && t.getUTCMonth() === mes - 1 && t.getUTCDate() === d;
}

/** `'2026-10-20'` → `'20/10/2026'`. Sin `Date` local (sin desfase de zona horaria). */
export function fechaFichaLegible(iso: string): string {
  const m = RE_FECHA.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

export function parsearFicha(raw: string): FichaParseada {
  const lineas = raw.split('\n');
  if (lineas[0]?.replace(/\r$/, '') !== DELIM) {
    return { encabezado: null, cuerpo: raw, errores: ['La ficha no empieza con el encabezado `---`.'] };
  }
  const cierre = lineas.findIndex((l, i) => i > 0 && l.replace(/\r$/, '') === DELIM);
  if (cierre < 0) {
    return { encabezado: null, cuerpo: raw, errores: ['El encabezado no tiene `---` de cierre.'] };
  }
  const cuerpo = lineas.slice(cierre + 1).join('\n');
  const errores: string[] = [];
  const escalares = new Map<string, string>();
  const listas = new Map<string, string[]>();
  let listaActual: string | null = null;

  for (const bruta of lineas.slice(1, cierre)) {
    const linea = bruta.replace(/\r$/, '');
    if (linea.trim() === '') continue;
    const item = /^ {2}- (.*)$/.exec(linea);
    if (item) {
      const valor = item[1].trim();
      if (!listaActual) errores.push(`Ítem de lista fuera de una lista: «${linea.trim()}».`);
      else if (valor === '') errores.push(`Ítem vacío en \`${listaActual}\`.`);
      else listas.get(listaActual)?.push(valor);
      continue;
    }
    const par = /^([a-z_]+):(.*)$/.exec(linea);
    if (!par) {
      errores.push(`Línea no reconocida en el encabezado: «${linea.trim()}».`);
      listaActual = null;
      continue;
    }
    const clave = par[1];
    const valor = par[2].trim();
    listaActual = null;
    if (escalares.has(clave) || listas.has(clave)) {
      errores.push(`Clave repetida: \`${clave}\`.`);
      continue;
    }
    if (CLAVES_ESCALAR.has(clave)) {
      escalares.set(clave, valor);
    } else if (CLAVES_LISTA.has(clave)) {
      if (valor !== '') errores.push(`\`${clave}\` es una lista: deje la línea vacía y use «  - item».`);
      listas.set(clave, []);
      listaActual = clave;
    } else {
      errores.push(`Clave desconocida: \`${clave}\`.`);
    }
  }

  const resumen = escalares.get('resumen') ?? '';
  const version = escalares.get('version') ?? '';
  const fecha = escalares.get('fecha') ?? '';
  const palabrasClave = listas.get('palabras_clave') ?? [];
  const consultas = listas.get('consultas') ?? [];
  if (!resumen) errores.push('Falta `resumen`.');
  if (palabrasClave.length === 0) errores.push('`palabras_clave` necesita al menos un ítem.');
  if (consultas.length === 0) errores.push('`consultas` necesita al menos un ítem.');
  if (!RE_VERSION.test(version)) errores.push('`version` debe tener la forma 1.0.');
  if (!esFechaIsoValida(fecha)) errores.push('`fecha` debe ser una fecha válida AAAA-MM-DD.');

  const encabezado = errores.length === 0
    ? { resumen, palabrasClave, consultas, version, fecha }
    : null;
  return { encabezado, cuerpo, errores };
}
