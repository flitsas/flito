#!/usr/bin/env node
// ADR-0035 §C (HU #13981, AC7): un PR a develop no puede modificar, borrar ni renombrar una
// migración que ya existe en develop, porque entrar a develop equivale a aplicarse en DEV.
//
// Válvula: una migración que falló (rollback, sin ledger) o que rompe la cadena en BD limpia
// solo se arregla editándola. El check pasa si el mismo PR añade a derivas-aceptadas.json una
// entrada con motivo cuyo `shaDisco` coincide con el archivo en HEAD (`null` si se borró).
//
// Un archivo que no está en develop aparece como `A`: renumerar dentro de la rama pasa.
// `README.md`, `meta/` y el manifiesto quedan fuera. Uso: --base origin/develop
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const DIR_MIGRACIONES = 'apps/api/src/db/migrations';
export const MANIFIESTO = `${DIR_MIGRACIONES}/derivas-aceptadas.json`;

const MIGRACION_PRIMER_NIVEL = new RegExp(`^${DIR_MIGRACIONES}/[^/]+\\.sql$`);
const SHA256 = /^[0-9a-f]{64}$/;
const ESTADOS_PROHIBIDOS = new Set(['M', 'D', 'T']);

// Salida de `git diff --name-status -z`: estado\0ruta\0estado\0ruta\0
export function parsearNameStatus(salidaZ) {
  const partes = salidaZ.split('\0').filter(Boolean);
  const cambios = [];
  for (let i = 0; i + 1 < partes.length; i += 2) {
    cambios.push({ estado: partes[i][0], ruta: partes[i + 1] });
  }
  return cambios;
}

export function migracionesTocadas(cambios) {
  return cambios.filter((c) => MIGRACION_PRIMER_NIVEL.test(c.ruta) && ESTADOS_PROHIBIDOS.has(c.estado));
}

export function validarManifiesto(crudo) {
  const datos = JSON.parse(crudo);
  if (!Array.isArray(datos)) throw new Error('debe ser un arreglo');
  datos.forEach((e, i) => {
    const valida = typeof e?.archivo === 'string' && e.archivo.endsWith('.sql')
      && typeof e.shaLedger === 'string' && SHA256.test(e.shaLedger)
      && (e.shaDisco === null || (typeof e.shaDisco === 'string' && SHA256.test(e.shaDisco)))
      && typeof e.motivo === 'string' && e.motivo.trim() !== ''
      && typeof e.wi === 'string' && e.wi.trim() !== '';
    if (!valida) throw new Error(`entrada ${i}: exige archivo, shaLedger, shaDisco, motivo y wi`);
  });
  return datos;
}

const claveEntrada = (e) => `${e.archivo}|${e.shaLedger}|${e.shaDisco}`;

/**
 * @param cambios [{estado, ruta}] del diff del PR
 * @param manifiestoBase entradas en la base del PR
 * @param manifiestoHead entradas en HEAD
 * @param shaEnHead (ruta) => sha256 del archivo en HEAD, o null si no existe
 * @returns rutas sin válvula: cada una es una violación
 */
export function analizar({ cambios, manifiestoBase, manifiestoHead, shaEnHead }) {
  const enBase = new Set(manifiestoBase.map(claveEntrada));
  const nuevas = manifiestoHead.filter((e) => !enBase.has(claveEntrada(e)));
  return migracionesTocadas(cambios).filter((c) => {
    const archivo = c.ruta.slice(DIR_MIGRACIONES.length + 1);
    const shaActual = c.estado === 'D' ? null : shaEnHead(c.ruta);
    return !nuevas.some((e) => e.archivo === archivo && e.shaDisco === shaActual);
  });
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

function leerEnRevision(cwd, revision, ruta) {
  try {
    return git(cwd, 'show', `${revision}:${ruta}`);
  } catch {
    return null;
  }
}

// Devuelve el código de salida. Un error de git hace fallar el check: nunca pasa en silencio.
export function verificar({ base, cwd = process.cwd(), log = console.log, error = console.error }) {
  let cambios;
  let mergeBase;
  try {
    mergeBase = git(cwd, 'merge-base', base, 'HEAD').toString().trim();
    cambios = parsearNameStatus(git(cwd, 'diff', '--name-status', '--no-renames', '-z', `${base}...HEAD`).toString());
  } catch (e) {
    error(`check-migraciones-inmutables: no se pudo calcular el diff contra ${base}: ${e.message}`);
    return 2;
  }

  let manifiestoHead;
  try {
    const crudo = leerEnRevision(cwd, 'HEAD', MANIFIESTO);
    manifiestoHead = crudo === null ? [] : validarManifiesto(crudo.toString());
  } catch (e) {
    error(`check-migraciones-inmutables: ${MANIFIESTO} no es válido: ${e.message}`);
    return 1;
  }
  let manifiestoBase = [];
  try {
    const crudo = leerEnRevision(cwd, mergeBase, MANIFIESTO);
    if (crudo !== null) manifiestoBase = validarManifiesto(crudo.toString());
  } catch {
    // Una base corrupta no bloquea: quien lo corrige es este PR, con el HEAD ya validado.
  }

  const shaEnHead = (ruta) => {
    const bytes = leerEnRevision(cwd, 'HEAD', ruta);
    return bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
  };
  const violaciones = analizar({ cambios, manifiestoBase, manifiestoHead, shaEnHead });

  if (violaciones.length === 0) {
    log(`check-migraciones-inmutables: OK (${migracionesTocadas(cambios).length} con entrada en el manifiesto)`);
    return 0;
  }
  error('check-migraciones-inmutables: este PR altera migraciones que ya existen en develop:');
  for (const v of violaciones) {
    error(`  ${v.estado} ${v.ruta}`);
    const sha = v.estado === 'D' ? 'null' : shaEnHead(v.ruta);
    error(`    Crea una migración nueva. Si solo se arregla editándola (falló o rompe la cadena en BD limpia),`);
    error(`    añade en este PR a ${MANIFIESTO} una entrada con motivo y wi, con shaDisco=${sha} (ADR-0035 §C).`);
  }
  return 1;
}

function leerBase(argv) {
  const i = argv.indexOf('--base');
  return i >= 0 ? argv[i + 1] : undefined;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const base = leerBase(process.argv.slice(2));
  if (!base) {
    console.error('Uso: node scripts/check-migraciones-inmutables.mjs --base origin/develop');
    process.exit(2);
  }
  process.exit(verificar({ base }));
}
