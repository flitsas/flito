#!/usr/bin/env node
// HU #13985 (Feature #13976): ratchet de warnings ESLint por regla. Independiente de FROZEN_CEILINGS.
//
//   node scripts/check-lint-baseline.mjs            gate (lo corre el job `lint` de CI)
//   node scripts/check-lint-baseline.mjs --update   baja la línea base; nunca sube ni añade reglas
//
// Qué se mide: los archivos de `git ls-files`, que es lo que CI ve. Los sin versionar del checkout
// no cuentan y `dist` no entra (ignorado en eslint.config.mjs). Un archivo nuevo debe estar en el
// índice (`git add`) para que el gate local lo vea.
//
// Modos, según el entorno:
//   - Local, o PR a develop: estricto. Exige bajar la línea base si el conteo bajó y compara el
//     archivo contra el de origin/develop (no puede subir; si develop no lo tiene, no compara).
//   - Push, o PR de promoción (staging/release/main): solo «no superar» y «no apagar». Dos PRs
//     paralelos que bajan la misma regla dejan el tip por debajo de la línea base, y un hotfix en
//     la base de una promoción no es una subida: ninguno de los dos debe poner el CI en rojo.
//
// Warnings sin regla: las directivas `eslint-disable` sin uso llegan con ruleId null. Van a un cubo
// explícito, SIN_REGLA, que se trata como una regla más, salvo que no se sella ni tiene severidad.
//
// Sellar una regla: subirla a 'error' en eslint.config.mjs y correr --update, que la pasa de
// `lineaBase` a `selladas`. Una sellada debe seguir en 'error'.
//
// Límite conocido: la severidad se comprueba en una ruta por zona del repo (SONDAS). Un 'off'
// acotado a un archivo concreto o un `eslint-disable` de archivo no se detectan aquí.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

export const RUTA_LINEA_BASE = 'scripts/lint-baseline.json';
export const SIN_REGLA = '(sin-regla)';
export const COMANDO_UPDATE = 'node scripts/check-lint-baseline.mjs --update';
const REF_DEVELOP = 'origin/develop';
const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Las extensiones que `eslint .` recoge con este config. Pasarle a ESLint solo lo versionado da
// el mismo conjunto que CI (sin build previo) aunque el checkout tenga archivos sueltos.
const EXTENSIONES_LINT = /\.(?:[cm]?js|[cm]?ts|tsx)$/;

// Rutas sintéticas, una por zona con config propia: calculateConfigForFile no exige que existan.
// El mínimo entre sondas evita que un 'off' acotado a una zona pase por la regla global.
const SONDAS_GENERALES = [
  'apps/api/src/sonda.ts',
  'apps/api/__tests__/sonda.test.ts',
  'apps/web/src/sonda.tsx',
  'apps/web/e2e/tests/sonda.spec.ts',
  'packages/shared-types/src/sonda.ts',
  'scripts/sonda.mjs',
];
const SONDAS_REACT_HOOKS = ['apps/web/src/sonda.tsx']; // el plugin solo se registra en apps/web/src

const comoLista = (valor) => [...valor].sort();

export function modoDesdeEntorno(env) {
  const evento = env.GITHUB_EVENT_NAME;
  const haciaDevelop = evento === 'pull_request' && env.GITHUB_BASE_REF === 'develop';
  return !evento || haciaDevelop
    ? { nombre: evento ? 'PR a develop' : 'local', estricto: true, refBase: REF_DEVELOP }
    : { nombre: evento === 'pull_request' ? `PR a ${env.GITHUB_BASE_REF}` : evento, estricto: false, refBase: null };
}

export function validarArchivo(archivo) {
  const lineaBase = archivo?.lineaBase;
  const selladas = archivo?.selladas;
  if (lineaBase === null || typeof lineaBase !== 'object' || Array.isArray(lineaBase)) {
    throw new Error(`${RUTA_LINEA_BASE}: falta el objeto "lineaBase" (regla → conteo).`);
  }
  if (!Array.isArray(selladas)) throw new Error(`${RUTA_LINEA_BASE}: falta la lista "selladas".`);
  for (const [regla, conteo] of Object.entries(lineaBase)) {
    if (!Number.isInteger(conteo) || conteo < 0) {
      throw new Error(`${RUTA_LINEA_BASE}: conteo inválido para ${regla}: ${conteo}.`);
    }
    if (selladas.includes(regla)) {
      throw new Error(`${RUTA_LINEA_BASE}: ${regla} está en "lineaBase" y en "selladas" a la vez.`);
    }
  }
  if (selladas.includes(SIN_REGLA)) {
    throw new Error(`${RUTA_LINEA_BASE}: ${SIN_REGLA} no es una regla y no se puede sellar.`);
  }
  return archivo;
}

export function serializarArchivo({ lineaBase, selladas }) {
  const ordenada = Object.fromEntries(comoLista(Object.keys(lineaBase)).map((r) => [r, lineaBase[r]]));
  return `${JSON.stringify({ lineaBase: ordenada, selladas: comoLista(selladas) }, null, 2)}\n`;
}

export function contarWarnings(resultados) {
  const conteos = {};
  let errores = 0;
  for (const { messages } of resultados) {
    for (const { severity, ruleId } of messages) {
      if (severity === 2) {
        errores += 1;
      } else {
        const clave = ruleId ?? SIN_REGLA;
        conteos[clave] = (conteos[clave] ?? 0) + 1;
      }
    }
  }
  return { conteos, errores };
}

export function severidadNumerica(entrada) {
  const valor = Array.isArray(entrada) ? entrada[0] : entrada;
  if (valor === 'error' || valor === 2) return 2;
  if (valor === 'warn' || valor === 1) return 1;
  return 0; // 'off', 0 o regla ausente del config
}

// Apagar una regla la deja en 0 warnings: sin esto, el ratchet se esquivaría con un 'off'.
export function problemasDeSeveridad({ lineaBase, selladas }, severidades) {
  const problemas = [];
  for (const regla of Object.keys(lineaBase)) {
    if (regla !== SIN_REGLA && !severidades[regla]) {
      problemas.push(
        `${regla}: está en 'off' pero sigue en la línea base (${lineaBase[regla]}). ` +
          `Déjala en 'warn' en eslint.config.mjs; una regla del ratchet no se apaga.`,
      );
    }
  }
  for (const regla of selladas) {
    if (severidades[regla] !== 2) {
      problemas.push(
        `${regla}: está sellada y debe seguir en 'error' en eslint.config.mjs; no se puede reabrir.`,
      );
    }
  }
  return problemas;
}

export function evaluar({ archivo, conteos, severidades, estricto }) {
  const { lineaBase, selladas } = archivo;
  const problemas = problemasDeSeveridad(archivo, severidades);
  for (const regla of comoLista(new Set([...Object.keys(conteos), ...Object.keys(lineaBase)]))) {
    const conteo = conteos[regla] ?? 0;
    const tope = lineaBase[regla] ?? 0;
    if (conteo > tope) {
      const origen = regla in lineaBase ? '' : selladas.includes(regla) ? ' (sellada)' : ' (no está en la línea base)';
      problemas.push(
        `${regla}: ${conteo} warnings, línea base ${tope}${origen}. ` +
          `Sobran ${conteo - tope}: corrígelos (los lista \`npm run lint\`); la línea base no se sube.`,
      );
    } else if (estricto && conteo < tope) {
      problemas.push(
        `${regla}: ${conteo} warnings, línea base ${tope} sin actualizar. ` +
          `Corre \`${COMANDO_UPDATE}\` e incluye ${RUTA_LINEA_BASE} en este PR.`,
      );
    } else if (estricto && regla !== SIN_REGLA && severidades[regla] === 2 && regla in lineaBase) {
      problemas.push(
        `${regla}: ya está en 'error' pero sigue en la línea base. ` +
          `Corre \`${COMANDO_UPDATE}\` para pasarla a "selladas".`,
      );
    }
  }
  return problemas;
}

// AC3: el archivo del PR contra el de la rama base. `base` null = arranque, nada que comparar.
export function evaluarContraBase(archivo, base) {
  if (base === null) return [];
  const problemas = [];
  const { lineaBase, selladas } = archivo;
  for (const regla of comoLista(Object.keys(lineaBase))) {
    const enBase = base.lineaBase[regla] ?? 0;
    if (lineaBase[regla] > enBase) {
      problemas.push(
        `${regla}: la línea base sube de ${enBase} a ${lineaBase[regla]} frente a la rama base. ` +
          `Subirla está prohibido: corrige los warnings.`,
      );
    }
  }
  for (const regla of comoLista(Object.keys(base.lineaBase))) {
    if (!(regla in lineaBase) && !selladas.includes(regla)) {
      problemas.push(
        `${regla}: salió de la línea base (${base.lineaBase[regla]}) sin sellarse. ` +
          `Restáurala; solo sale subiéndola a 'error' y corriendo \`${COMANDO_UPDATE}\`.`,
      );
    }
  }
  for (const regla of comoLista(base.selladas)) {
    if (!selladas.includes(regla)) {
      problemas.push(`${regla}: estaba sellada en la rama base y no se puede reabrir.`);
    }
  }
  return problemas;
}

// Solo baja o sella; nunca añade una regla ni aumenta un conteo, sea cual sea la medición.
export function calcularActualizacion({ lineaBase, selladas }, conteos, severidades) {
  const nueva = { lineaBase: {}, selladas: [...selladas] };
  for (const [regla, tope] of Object.entries(lineaBase)) {
    const conteo = conteos[regla] ?? 0;
    if (regla !== SIN_REGLA && severidades[regla] === 2 && conteo === 0) {
      nueva.selladas.push(regla);
    } else {
      nueva.lineaBase[regla] = Math.min(conteo, tope);
    }
  }
  return nueva;
}

// null si la ref existe y no tiene el archivo (arranque). Sin la ref lanza: pasar en silencio
// desactivaría el gate si CI deja de traerla.
export function leerArchivoDeRama(ref, ruta, cwd = RAIZ) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  try {
    git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
  } catch {
    throw new Error(`No está disponible la ref ${ref}; corre \`git fetch origin develop\`.`);
  }
  try {
    git('cat-file', '-e', `${ref}:${ruta}`);
  } catch {
    return null;
  }
  return validarArchivo(JSON.parse(git('show', `${ref}:${ruta}`)));
}

export function listarArchivosVersionados(raiz) {
  const salida = execFileSync('git', ['ls-files', '-z'], {
    cwd: raiz,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return salida
    .split('\0')
    .filter((ruta) => EXTENSIONES_LINT.test(ruta) && existsSync(join(raiz, ruta)));
}

export async function leerSeveridades(raiz, reglas) {
  const eslint = new ESLint({ cwd: raiz });
  const porSonda = new Map();
  const reglasDe = async (sonda) => {
    if (!porSonda.has(sonda)) {
      porSonda.set(sonda, (await eslint.calculateConfigForFile(sonda)).rules ?? {});
    }
    return porSonda.get(sonda);
  };
  const severidades = {};
  for (const regla of reglas) {
    const sondas = regla.startsWith('react-hooks/') ? SONDAS_REACT_HOOKS : SONDAS_GENERALES;
    const valores = await Promise.all(
      sondas.map(async (sonda) => severidadNumerica((await reglasDe(sonda))[regla])),
    );
    severidades[regla] = Math.min(...valores);
  }
  return severidades;
}

// En CI el job `lint` corre antes `eslint . --cache` con la misma ubicación y estrategia: con
// ESLINT_CACHE_LOCATION definida, esta segunda pasada lee los resultados de esa caché en vez de
// volver a analizar el repo entero (~40 s). Sin la variable (local, tests) no se usa caché.
export function opcionesCache(env) {
  const ubicacion = env.ESLINT_CACHE_LOCATION;
  return ubicacion ? { cache: true, cacheLocation: ubicacion, cacheStrategy: 'content' } : {};
}

async function medir(raiz) {
  const eslint = new ESLint({ cwd: raiz, warnIgnored: false, ...opcionesCache(process.env) });
  return contarWarnings(await eslint.lintFiles(listarArchivosVersionados(raiz)));
}

function fallar(problemas, entorno) {
  const prefijo = entorno.GITHUB_ACTIONS ? '::error::' : '';
  for (const problema of problemas) console.error(`${prefijo}${problema}`);
  process.exitCode = 1;
}

async function main(argv, entorno) {
  const desconocidos = argv.filter((arg) => arg !== '--update');
  if (desconocidos.length > 0) {
    throw new Error(`Argumento desconocido: ${desconocidos.join(' ')}. Uso: [--update]`);
  }
  const actualizar = argv.includes('--update');
  const rutaArchivo = join(RAIZ, RUTA_LINEA_BASE);
  let archivo = validarArchivo(JSON.parse(readFileSync(rutaArchivo, 'utf8')));
  const modo = modoDesdeEntorno(entorno);

  const { conteos, errores } = await medir(RAIZ);
  if (errores > 0) {
    // Un error de parseo oculta los warnings de ese archivo: la medición no sería fiable.
    fallar([`ESLint reporta ${errores} errores; corrígelos con \`npm run lint\` antes de medir.`], entorno);
    return;
  }
  const reglasConConfig = (a) => [...Object.keys(a.lineaBase), ...a.selladas].filter((r) => r !== SIN_REGLA);
  const severidades = await leerSeveridades(RAIZ, reglasConConfig(archivo));

  if (actualizar) {
    const apagadas = problemasDeSeveridad(archivo, severidades);
    if (apagadas.length > 0) {
      // Bajar a 0 una regla apagada blanquearía el 'off'.
      fallar(apagadas, entorno);
      return;
    }
    archivo = calcularActualizacion(archivo, conteos, severidades);
    writeFileSync(rutaArchivo, serializarArchivo(archivo));
    console.log(`${RUTA_LINEA_BASE} actualizado.`);
  }

  const problemas = evaluar({ archivo, conteos, severidades, estricto: modo.estricto });
  if (modo.refBase) {
    const base = leerArchivoDeRama(modo.refBase, RUTA_LINEA_BASE);
    if (base === null) console.log(`${modo.refBase} aún no tiene ${RUTA_LINEA_BASE}: no se compara.`);
    problemas.push(...evaluarContraBase(archivo, base));
  }
  if (problemas.length > 0) {
    fallar(problemas, entorno);
    return;
  }

  for (const [regla, tope] of Object.entries(archivo.lineaBase)) {
    if (tope === 0 && regla !== SIN_REGLA) {
      console.log(`${regla}: en 0. Se puede sellar: súbela a 'error' y corre \`${COMANDO_UPDATE}\`.`);
    }
  }
  const total = Object.values(conteos).reduce((suma, n) => suma + n, 0);
  console.log(
    `Ratchet de lint OK (${modo.nombre}): ${total} warnings, ` +
      `${Object.keys(archivo.lineaBase).length} en línea base, ${archivo.selladas.length} selladas.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), process.env).catch((error) => {
    console.error(error.message);
    process.exitCode = 2;
  });
}
