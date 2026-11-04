// HU #13985: test del ratchet de warnings. Corre con `node --test` (sin Vitest), como los demás
// checks de scripts/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COMANDO_UPDATE,
  SIN_REGLA,
  calcularActualizacion,
  contarWarnings,
  evaluar,
  evaluarContraBase,
  leerArchivoDeRama,
  leerSeveridades,
  listarArchivosVersionados,
  modoDesdeEntorno,
  serializarArchivo,
  severidadNumerica,
  validarArchivo,
} from './check-lint-baseline.mjs';

const archivo = (lineaBase = { 'prefer-const': 5 }, selladas = ['no-cond-assign']) => ({ lineaBase, selladas });
const SEVERIDADES = { 'prefer-const': 1, 'no-cond-assign': 2 };
const evaluarEn = (estricto, conteos, a = archivo(), severidades = SEVERIDADES) =>
  evaluar({ archivo: a, conteos, severidades, estricto });

function enTemporal(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'lint-baseline-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function repoGit(dir) {
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  return git;
}

test('superar la línea base falla y el mensaje nombra regla, conteo nuevo y línea base', () => {
  const [problema, ...resto] = evaluarEn(false, { 'prefer-const': 7 });
  assert.deepEqual(resto, []);
  assert.match(problema, /^prefer-const: 7 warnings, línea base 5\b/);
});

test('igualar la línea base pasa', () => {
  assert.deepEqual(evaluarEn(true, { 'prefer-const': 5 }), []);
});

test('regla ausente de la línea base cuenta como 0: un warning la supera', () => {
  const [problema] = evaluarEn(false, { 'prefer-const': 5, 'no-empty': 1 });
  assert.match(problema, /^no-empty: 1 warnings, línea base 0 \(no está en la línea base\)/);
});

test('reabrir una sellada bajándola a warn falla por conteo y por severidad', () => {
  const problemas = evaluarEn(false, { 'prefer-const': 5, 'no-cond-assign': 2 }, archivo(), {
    ...SEVERIDADES,
    'no-cond-assign': 1,
  });
  assert.equal(problemas.length, 2);
  assert.match(problemas[0], /^no-cond-assign: está sellada/);
  assert.match(problemas[1], /^no-cond-assign: 2 warnings, línea base 0 \(sellada\)/);
});

test('bajar sin actualizar en PR falla con el comando exacto', () => {
  const [problema, ...resto] = evaluarEn(true, { 'prefer-const': 3 });
  assert.deepEqual(resto, []);
  assert.match(problema, /^prefer-const: 3 warnings, línea base 5 sin actualizar/);
  assert.ok(problema.includes(COMANDO_UPDATE));
});

test('bajar sin actualizar en push pasa: el tip puede quedar por debajo', () => {
  assert.deepEqual(evaluarEn(false, { 'prefer-const': 3 }), []);
});

test('el cubo sin regla se comporta como una regla: no supera y baja, sin exigir severidad', () => {
  const a = archivo({ [SIN_REGLA]: 2 }, []);
  assert.deepEqual(evaluarEn(true, { [SIN_REGLA]: 2 }, a, {}), []);
  assert.match(evaluarEn(false, { [SIN_REGLA]: 3 }, a, {})[0], /^\(sin-regla\): 3 warnings, línea base 2/);
  assert.match(evaluarEn(true, {}, a, {})[0], /sin actualizar/);
});

test('una regla de la línea base en off falla, también en push', () => {
  const [problema] = evaluarEn(false, {}, archivo(), { ...SEVERIDADES, 'prefer-const': 0 });
  assert.match(problema, /^prefer-const: está en 'off'/);
});

test('una sellada en off falla', () => {
  const [problema] = evaluarEn(false, { 'prefer-const': 5 }, archivo(), { ...SEVERIDADES, 'no-cond-assign': 0 });
  assert.match(problema, /^no-cond-assign: está sellada/);
});

test('una regla ya en error que sigue en la línea base pide --update en PR', () => {
  const a = archivo({ 'prefer-const': 0 }, []);
  const severidades = { 'prefer-const': 2 };
  assert.ok(evaluarEn(true, {}, a, severidades)[0].includes(COMANDO_UPDATE));
  assert.deepEqual(evaluarEn(false, {}, a, severidades), []);
});

test('subir la línea base contra la rama base se rechaza', () => {
  const [problema] = evaluarContraBase(archivo({ 'prefer-const': 6 }), archivo({ 'prefer-const': 5 }));
  assert.match(problema, /^prefer-const: la línea base sube de 5 a 6/);
});

test('añadir una regla con conteo a la línea base es subirla desde 0', () => {
  const [problema] = evaluarContraBase(archivo({ 'prefer-const': 5, 'no-empty': 1 }), archivo());
  assert.match(problema, /^no-empty: la línea base sube de 0 a 1/);
});

test('bajar la línea base contra la rama base pasa', () => {
  assert.deepEqual(evaluarContraBase(archivo({ 'prefer-const': 4 }), archivo()), []);
});

test('la rama base sin archivo no compara: el PR de arranque pasa', () => {
  assert.deepEqual(evaluarContraBase(archivo({ 'prefer-const': 999 }), null), []);
});

test('sacar una regla de la línea base sin sellarla se rechaza; sellándola pasa', () => {
  const [problema] = evaluarContraBase(archivo({}), archivo());
  assert.match(problema, /^prefer-const: salió de la línea base \(5\) sin sellarse/);
  assert.deepEqual(evaluarContraBase(archivo({}, ['no-cond-assign', 'prefer-const']), archivo()), []);
});

test('quitar una regla de las selladas de la base se rechaza', () => {
  const [problema] = evaluarContraBase(archivo({ 'prefer-const': 5 }, []), archivo());
  assert.match(problema, /^no-cond-assign: estaba sellada/);
});

test('--update nunca sube ni añade reglas, aunque la medición sea mayor', () => {
  const nueva = calcularActualizacion(archivo(), { 'prefer-const': 9, 'no-empty': 4 }, SEVERIDADES);
  assert.deepEqual(nueva, archivo());
});

test('--update baja al conteo medido y deja en 0 lo que aún está en warn', () => {
  assert.deepEqual(calcularActualizacion(archivo(), { 'prefer-const': 2 }, SEVERIDADES).lineaBase, {
    'prefer-const': 2,
  });
  assert.deepEqual(calcularActualizacion(archivo(), {}, SEVERIDADES).lineaBase, { 'prefer-const': 0 });
});

test('--update sella la regla subida a error: sale de la línea base y entra en selladas', () => {
  const nueva = calcularActualizacion(archivo(), {}, { 'prefer-const': 2, 'no-cond-assign': 2 });
  assert.deepEqual(nueva, archivo({}, ['no-cond-assign', 'prefer-const']));
});

test('--update nunca sella el cubo sin regla', () => {
  const a = archivo({ [SIN_REGLA]: 3 }, []);
  assert.deepEqual(calcularActualizacion(a, {}, {}), archivo({ [SIN_REGLA]: 0 }, []));
});

test('modo: local y PR a develop son estrictos contra origin/develop', () => {
  for (const env of [{}, { GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'develop' }]) {
    const { estricto, refBase } = modoDesdeEntorno(env);
    assert.equal(estricto, true);
    assert.equal(refBase, 'origin/develop');
  }
});

test('modo: push y PRs de promoción solo vigilan no superar, sin comparar con la base', () => {
  for (const env of [
    { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'staging' },
    { GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'release' },
  ]) {
    const { estricto, refBase } = modoDesdeEntorno(env);
    assert.equal(estricto, false);
    assert.equal(refBase, null);
  }
});

test('contarWarnings agrupa por regla, manda los ruleId null al cubo y separa los errores', () => {
  const { conteos, errores } = contarWarnings([
    {
      messages: [
        { severity: 1, ruleId: 'prefer-const' },
        { severity: 1, ruleId: 'prefer-const' },
        { severity: 1, ruleId: null },
      ],
    },
    { messages: [{ severity: 2, ruleId: null }] },
  ]);
  assert.deepEqual(conteos, { 'prefer-const': 2, [SIN_REGLA]: 1 });
  assert.equal(errores, 1);
});

test('severidadNumerica entiende la forma normalizada y la regla ausente', () => {
  assert.equal(severidadNumerica([2, { max: 1 }]), 2);
  assert.equal(severidadNumerica('warn'), 1);
  assert.equal(severidadNumerica([0]), 0);
  assert.equal(severidadNumerica(undefined), 0);
});

test('validarArchivo rechaza conteos inválidos, reglas duplicadas y el cubo sellado', () => {
  assert.throws(() => validarArchivo({ selladas: [] }), /lineaBase/);
  assert.throws(() => validarArchivo(archivo({ 'prefer-const': -1 })), /conteo inválido/);
  assert.throws(() => validarArchivo(archivo({ a: 1 }, ['a'])), /a la vez/);
  assert.throws(() => validarArchivo(archivo({}, [SIN_REGLA])), /no se puede sellar/);
});

test('serializarArchivo ordena para que el diff de --update sea estable', () => {
  assert.equal(
    serializarArchivo(archivo({ b: 1, a: 2 }, ['z', 'y'])),
    `${JSON.stringify({ lineaBase: { a: 2, b: 1 }, selladas: ['y', 'z'] }, null, 2)}\n`,
  );
});

test('leerArchivoDeRama: null si la ref no tiene el archivo, contenido si lo tiene, lanza sin ref', () => {
  enTemporal((dir) => {
    const git = repoGit(dir);
    git('commit', '-q', '--allow-empty', '-m', 'sin archivo');
    git('tag', 'sin');
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'scripts/b.json'), serializarArchivo(archivo()));
    git('add', 'scripts/b.json');
    git('commit', '-q', '-m', 'con archivo');
    git('tag', 'con');
    assert.equal(leerArchivoDeRama('sin', 'scripts/b.json', dir), null);
    assert.deepEqual(leerArchivoDeRama('con', 'scripts/b.json', dir), archivo());
    assert.throws(() => leerArchivoDeRama('origin/nada', 'scripts/b.json', dir), /No está disponible la ref/);
  });
});

test('listarArchivosVersionados ignora lo sin versionar, lo borrado y lo que no es código', () => {
  enTemporal((dir) => {
    const git = repoGit(dir);
    for (const nombre of ['si.ts', 'borrado.ts', 'no.json']) writeFileSync(join(dir, nombre), '');
    git('add', '.');
    writeFileSync(join(dir, 'suelto.ts'), '');
    rmSync(join(dir, 'borrado.ts'));
    assert.deepEqual(listarArchivosVersionados(dir), ['si.ts']);
  });
});

test('leerSeveridades con ESLint real: un off acotado a una zona se ve; react-hooks solo mira apps/web/src', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lint-baseline-'));
  try {
    writeFileSync(
      join(dir, 'eslint.config.mjs'),
      `const hooks = { rules: { 'exhaustive-deps': { create: () => ({}) } } };
export default [
  { files: ['**/*.ts', '**/*.tsx', '**/*.mjs'], rules: { 'no-cond-assign': 'error', 'prefer-const': 'warn', 'no-empty': 'warn' } },
  { files: ['apps/web/src/**/*.tsx'], plugins: { 'react-hooks': hooks }, rules: { 'react-hooks/exhaustive-deps': 'warn' } },
  { files: ['apps/api/**/*.ts'], rules: { 'no-empty': 'off' } },
];`,
    );
    const reglas = ['no-cond-assign', 'prefer-const', 'no-empty', 'react-hooks/exhaustive-deps', 'no-debugger'];
    assert.deepEqual(await leerSeveridades(dir, reglas), {
      'no-cond-assign': 2,
      'prefer-const': 1,
      'no-empty': 0,
      'react-hooks/exhaustive-deps': 1,
      'no-debugger': 0,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
