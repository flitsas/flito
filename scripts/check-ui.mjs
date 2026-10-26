// Gate estático de patrón visual en los módulos FLITO (decisión «ux-enforcement» del
// 2026-10-26): las reglas de diseño ya existen (`docs/ux/_principios-flito.md`, regla 13
// de AGENTS.md), pero nada las hacía cumplir — de ahí botones sin affordance, tablas
// desordenadas y HEX sueltos reportados por el PO. Este escáner recorre
// `apps/web/src/pages/Flito*.tsx` y `apps/web/src/components/flito/**` (sin `*.test.*`) y
// reporta `fichero:línea` de cada forma prohibida:
//
//   U1  `<table>` cruda — en los módulos FLITO la tabla es la `FlitTable` del kit
//       (`components/flit/flitPageKit.tsx`): scroll, cabeceras y estados resueltos.
//   U2  HEX suelto (`#fff`, `#FDE8E3`, …) — regla 13 de AGENTS.md: colores de las
//       utilidades/tokens ya usados (`--flit-*`, `bg-flit-card`, …), no de HEX sueltos.
//   U3  Control (`<button>`/`<input>`/`<select>`) con altura fija distinta de la canónica
//       del kit (`h-10`): `h-9`, `h-8`, … en su className — la «Uniformidad de barra» de
//       AGENTS.md / flit-code-review (una sola altura de control; sin overrides ad-hoc).
//       `h-10` explícita se admite: ES la altura canónica (input alineado con botón).
//
// Alcance declarado: solo los módulos FLITO (donde el kit `flit/` aplica). Las pantallas
// legacy anteriores al kit (PESV, RNDC, flota, laft, …) quedan fuera a propósito.
//
// Excepciones: SOLO las de `EXCEPCIONES`, por fichero y regla, con motivo y número exacto
// de hallazgos (mismo patrón que `check-roles-web.mjs`): si el fichero gana uno, rojo; si
// deja de tenerlos, rojo hasta retirar la entrada — no hay ratchet silencioso.
//
// Uso: node scripts/check-ui.mjs          (exit 1 si hay hallazgos fuera de excepción)
// Test: node --test scripts/check-ui.test.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const RE_TABLA = /<table[\s>]/;
const RE_HEX = /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?(?:[0-9a-fA-F]{2})?\b/g;
const RE_CONTROL_ALTURA = /<(button|input|select)\b[^>]*className\s*=\s*\{?\s*["'`][^"'`]*\bh-(?:[0-9]|1[12])\b/;

/**
 * Excepciones declaradas. Rutas relativas a la raíz del repo, con `/`, por regla.
 * `veces` = número exacto de hallazgos de esa regla en ese fichero.
 */
export const EXCEPCIONES = {
  'apps/web/src/components/flito/CargaComprobantes.tsx': {
    U1: { veces: 1, motivo: 'Deuda declarada: migración a FlitTable pendiente (requiere HU propia).' },
  },
  'apps/web/src/components/flito/CargaRecibosImpuestos.tsx': {
    U1: { veces: 1, motivo: 'Deuda declarada: migración a FlitTable pendiente (requiere HU propia).' },
  },
  'apps/web/src/components/flito/soat/CargaMasivaSoat.tsx': {
    U1: { veces: 1, motivo: 'Deuda declarada: migración a FlitTable pendiente (requiere HU propia).' },
  },
  'apps/web/src/pages/FlitoTramites.tsx': {
    U2: { veces: 2, motivo: '`#fff` sobre estilos inline de estados de trámite; migrar a tokens --flit-* (HU propia).' },
    U3: { veces: 2, motivo: 'Filtros con `flitInp h-9` (override ad-hoc de la altura canónica h-10); alineación de barra pendiente (HU propia).' },
  },
  'apps/web/src/pages/FlitoBitacora.tsx': {
    U3: { veces: 1, motivo: '`flitInp h-8 w-20` en el límite de filas (override ad-hoc); alineación de barra pendiente (HU propia).' },
  },
  'apps/web/src/components/flito/FirmaCanvas.tsx': {
    U2: { veces: 1, motivo: '`strokeStyle` del canvas 2D (no es CSS): el kit no expone token de tinta de firma.' },
  },
  'apps/web/src/components/flito/conciliacion/BloqueConciliar.tsx': {
    U2: { veces: 1, motivo: 'Fondo de alerta `#FDE8E3` sin token equivalente en el kit; migrar cuando exista (HU propia).' },
  },
};

/** Quita comentarios de línea para no contar HEX/`<table>` mencionados en prosa. */
function sinComentarioLinea(linea) {
  const i = linea.indexOf('//');
  return i === -1 ? linea : linea.slice(0, i);
}

/** Analiza un fuente y devuelve `{ linea, regla, texto }[]`. Puro: lo usa el test con fixtures. */
export function analizar(codigo) {
  const hallazgos = [];
  const lineas = codigo.split('\n');
  let enBloque = false;
  lineas.forEach((cruda, idx) => {
    let linea = cruda;
    // Comentarios de bloque /* … */ (pueden abrir y cerrar en la misma línea).
    let limpia = '';
    for (let i = 0; i < linea.length; i++) {
      if (!enBloque && linea[i] === '/' && linea[i + 1] === '*') { enBloque = true; i++; continue; }
      if (enBloque && linea[i] === '*' && linea[i + 1] === '/') { enBloque = false; i++; continue; }
      if (!enBloque) limpia += linea[i];
    }
    linea = sinComentarioLinea(limpia);
    const n = idx + 1;
    if (RE_TABLA.test(linea)) {
      hallazgos.push({ linea: n, regla: 'U1', texto: linea.trim().slice(0, 120) });
    }
    for (const m of linea.matchAll(RE_HEX)) {
      hallazgos.push({ linea: n, regla: 'U2', texto: `${m[0]} — ${linea.trim().slice(0, 110)}` });
    }
    if (RE_CONTROL_ALTURA.test(linea)) {
      hallazgos.push({ linea: n, regla: 'U3', texto: linea.trim().slice(0, 120) });
    }
  });
  return hallazgos;
}

function listar(raiz) {
  const acc = [];
  // Páginas Flito*.tsx (solo el nivel de `pages/`).
  const dirPages = join(raiz, 'apps/web/src/pages');
  for (const nombre of readdirSync(dirPages)) {
    if (/^Flito.*\.tsx$/.test(nombre) && !/\.test\.tsx$/.test(nombre)) acc.push(join(dirPages, nombre));
  }
  // Componentes flito (recursivo).
  const walk = (dir) => {
    for (const nombre of readdirSync(dir)) {
      const ruta = join(dir, nombre);
      if (statSync(ruta).isDirectory()) { if (nombre !== 'node_modules') walk(ruta); continue; }
      if (!/\.(ts|tsx)$/.test(nombre) || /\.test\.tsx?$/.test(nombre) || nombre.endsWith('.d.ts')) continue;
      acc.push(ruta);
    }
  };
  walk(join(raiz, 'apps/web/src/components/flito'));
  return acc;
}

/**
 * Recorre el árbol y aplica las excepciones. Devuelve `{ errores: string[], exentos: string[] }`.
 * `excepciones` y `ficheros` son inyectables para el test.
 */
export function verificar({ raiz = process.cwd(), excepciones = EXCEPCIONES, ficheros } = {}) {
  const errores = [];
  const exentos = [];
  const entradas = ficheros ?? listar(raiz).map((ruta) => ({
    rel: relative(raiz, ruta).split(sep).join('/'),
    codigo: readFileSync(ruta, 'utf8'),
  }));
  const vistos = new Map(); // `${rel}#${regla}` → nº hallazgos
  for (const { rel, codigo } of entradas) {
    const hs = analizar(codigo);
    if (hs.length === 0) continue;
    const porRegla = new Map();
    for (const h of hs) {
      if (!porRegla.has(h.regla)) porRegla.set(h.regla, []);
      porRegla.get(h.regla).push(h);
    }
    for (const [regla, lista] of porRegla) {
      const exc = excepciones[rel]?.[regla];
      const clave = `${rel}#${regla}`;
      if (exc) {
        vistos.set(clave, lista.length);
        if (lista.length === exc.veces) {
          exentos.push(...lista.map((h) => `${rel}:${h.linea} [${h.regla}] (excepción: ${exc.motivo})`));
          continue;
        }
        errores.push(`${rel}: la excepción ${regla} declara ${exc.veces} hallazgo(s) y hay ${lista.length}.`);
      }
      errores.push(...lista.map((h) => `${rel}:${h.linea} [${h.regla}] ${h.texto}`));
    }
  }
  if (!ficheros) {
    for (const [rel, reglas] of Object.entries(excepciones)) {
      for (const regla of Object.keys(reglas)) {
        if (!vistos.has(`${rel}#${regla}`)) errores.push(`${rel}: excepción ${regla} sin hallazgos — retírala de EXCEPCIONES.`);
      }
    }
  }
  return { errores, exentos };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { errores, exentos } = verificar();
  for (const e of exentos) console.log(`  exento  ${e}`);
  if (errores.length) {
    console.error('check:ui — patrón visual FLITO (tablas del kit, sin HEX sueltos, alturas del kit):');
    for (const e of errores) console.error(`  ${e}`);
    console.error('Usa FlitTable del kit, tokens --flit-* y las clases flitBtn*/flitInp (docs/ux/_principios-flito.md).');
    process.exit(1);
  }
  console.log(`check:ui — OK: sin tablas crudas, HEX sueltos ni alturas fijas fuera del kit (${exentos.length} exento(s) declarado(s)).`);
}
