// ADR-0035 §C (HU #13981, AC7). Corre con `node --test`. Los casos de extremo a extremo crean
// un repositorio git desechable, igual que el merge que CI compara contra origin/develop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DIR_MIGRACIONES, MANIFIESTO, analizar, parsearNameStatus, validarManifiesto, verificar } from './check-migraciones-inmutables.mjs';

const SHA_A = 'a'.repeat(64);
const sha256 = (texto) => createHash('sha256').update(texto).digest('hex');
const mig = (nombre) => `${DIR_MIGRACIONES}/${nombre}`;
const entrada = (archivo, shaDisco, extra = {}) => ({ archivo, shaLedger: SHA_A, shaDisco, motivo: 'falló en DEV', wi: '#13981', ...extra });

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'check-migraciones-'));
  const g = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'develop');
  mkdirSync(path.join(dir, DIR_MIGRACIONES), { recursive: true });
  const escribir = (ruta, contenido) => {
    mkdirSync(path.dirname(path.join(dir, ruta)), { recursive: true });
    writeFileSync(path.join(dir, ruta), contenido);
  };
  escribir(mig('0001_a.sql'), 'SELECT 1;\n');
  escribir(mig('0002_b.sql'), 'SELECT 2;\n');
  escribir(mig('README.md'), 'hola\n');
  escribir(mig('meta/_journal.json'), '{}\n');
  escribir(MANIFIESTO, '[]\n');
  g('add', '.');
  g('commit', '-qm', 'base');
  g('checkout', '-qb', 'pr');
  const commit = () => {
    g('add', '-A');
    g('commit', '-qm', 'cambio', '--allow-empty');
  };
  const correr = () => {
    const errores = [];
    const codigo = verificar({ base: 'develop', cwd: dir, log: () => {}, error: (l) => errores.push(l) });
    return { codigo, salida: errores.join('\n') };
  };
  return { dir, g, escribir, commit, correr, limpiar: () => rmSync(dir, { recursive: true, force: true }) };
}

function conRepo(nombre, fn) {
  test(nombre, () => {
    const r = repo();
    try {
      fn(r);
    } finally {
      r.limpiar();
    }
  });
}

conRepo('AC7: modificar una migración existente falla y la nombra', ({ escribir, commit, correr }) => {
  escribir(mig('0001_a.sql'), 'SELECT 100;\n');
  commit();
  const { codigo, salida } = correr();
  assert.equal(codigo, 1);
  assert.match(salida, /M apps\/api\/src\/db\/migrations\/0001_a\.sql/);
  assert.doesNotMatch(salida, /0002_b/);
});

conRepo('AC7: borrar una migración existente falla', ({ dir, commit, correr }) => {
  rmSync(path.join(dir, mig('0001_a.sql')));
  commit();
  const { codigo, salida } = correr();
  assert.equal(codigo, 1);
  assert.match(salida, /D .*0001_a\.sql/);
});

conRepo('AC7: renombrar cuenta como borrado y falla', ({ g, commit, correr }) => {
  g('mv', mig('0001_a.sql'), mig('0003_a.sql'));
  commit();
  const { codigo, salida } = correr();
  assert.equal(codigo, 1);
  assert.match(salida, /D .*0001_a\.sql/);
});

conRepo('AC7: cambio de tipo (archivo a symlink) falla', ({ dir, commit, correr }) => {
  rmSync(path.join(dir, mig('0001_a.sql')));
  execFileSync('ln', ['-s', '0002_b.sql', path.join(dir, mig('0001_a.sql'))]);
  commit();
  const { codigo, salida } = correr();
  assert.equal(codigo, 1);
  assert.match(salida, /T .*0001_a\.sql/);
});

conRepo('una migración nueva pasa, y renumerarla dentro de la rama también', ({ g, escribir, commit, correr }) => {
  escribir(mig('0003_c.sql'), 'SELECT 3;\n');
  commit();
  assert.equal(correr().codigo, 0);
  g('mv', mig('0003_c.sql'), mig('0004_c.sql'));
  commit();
  assert.equal(correr().codigo, 0);
});

conRepo('README, meta/ y el manifiesto no cuentan', ({ dir, escribir, commit, correr }) => {
  escribir(mig('README.md'), 'cambio\n');
  rmSync(path.join(dir, mig('meta')), { recursive: true });
  escribir(MANIFIESTO, '[ ]\n');
  commit();
  assert.equal(correr().codigo, 0);
});

conRepo('un .sql en subcarpeta no es del primer nivel', ({ escribir, commit, g, correr }) => {
  escribir(mig('sub/x.sql'), 'SELECT 1;\n');
  commit();
  g('checkout', '-q', 'develop');
  g('merge', '-q', '--ff-only', 'pr');
  g('checkout', '-q', 'pr');
  escribir(mig('sub/x.sql'), 'SELECT 2;\n');
  commit();
  assert.equal(correr().codigo, 0);
});

conRepo('válvula: la edición pasa si el PR añade una entrada con su sha en HEAD', ({ escribir, commit, correr }) => {
  const nuevo = 'SELECT 100;\n';
  escribir(mig('0001_a.sql'), nuevo);
  escribir(MANIFIESTO, JSON.stringify([entrada('0001_a.sql', sha256(nuevo))]));
  commit();
  assert.equal(correr().codigo, 0);
});

conRepo('válvula: con otro sha no pasa', ({ escribir, commit, correr }) => {
  escribir(mig('0001_a.sql'), 'SELECT 100;\n');
  escribir(MANIFIESTO, JSON.stringify([entrada('0001_a.sql', sha256('otra cosa'))]));
  commit();
  assert.equal(correr().codigo, 1);
});

conRepo('válvula: el borrado exige shaDisco null', ({ dir, escribir, commit, correr }) => {
  rmSync(path.join(dir, mig('0001_a.sql')));
  escribir(MANIFIESTO, JSON.stringify([entrada('0001_a.sql', null)]));
  commit();
  assert.equal(correr().codigo, 0);
});

conRepo('válvula: una entrada que ya estaba en develop no cubre una edición nueva', ({ g, escribir, commit, correr }) => {
  const nuevo = 'SELECT 100;\n';
  escribir(MANIFIESTO, JSON.stringify([entrada('0001_a.sql', sha256(nuevo))]));
  commit();
  g('checkout', '-q', 'develop');
  g('merge', '-q', '--ff-only', 'pr');
  g('checkout', '-q', 'pr');
  escribir(mig('0001_a.sql'), nuevo);
  commit();
  assert.equal(correr().codigo, 1);
});

conRepo('válvula: sin motivo el manifiesto es inválido y falla', ({ escribir, commit, correr }) => {
  const nuevo = 'SELECT 100;\n';
  escribir(mig('0001_a.sql'), nuevo);
  escribir(MANIFIESTO, JSON.stringify([entrada('0001_a.sql', sha256(nuevo), { motivo: '' })]));
  commit();
  const { codigo, salida } = correr();
  assert.equal(codigo, 1);
  assert.match(salida, /derivas-aceptadas\.json no es válido/);
});

conRepo('manifiesto con JSON roto falla aunque ninguna migración cambie', ({ escribir, commit, correr }) => {
  escribir(MANIFIESTO, 'no es json');
  commit();
  assert.equal(correr().codigo, 1);
});

conRepo('la evaluación usa el commit, no el árbol de trabajo', ({ escribir, commit, correr }) => {
  escribir(mig('0001_a.sql'), 'SELECT 100;\n');
  commit();
  escribir(mig('0001_a.sql'), 'SELECT 1;\n');
  assert.equal(correr().codigo, 1);
});

conRepo('una base inexistente falla, no pasa en silencio', ({ dir }) => {
  const errores = [];
  const codigo = verificar({ base: 'origin/no-existe', cwd: dir, log: () => {}, error: (l) => errores.push(l) });
  assert.equal(codigo, 2);
  assert.match(errores.join('\n'), /no se pudo calcular el diff/);
});

test('parsearNameStatus entiende la salida con -z', () => {
  assert.deepEqual(parsearNameStatus('M\0a.sql\0D\0b.sql\0'), [
    { estado: 'M', ruta: 'a.sql' },
    { estado: 'D', ruta: 'b.sql' },
  ]);
});

test('analizar: una entrada para otro archivo no sirve', () => {
  const violaciones = analizar({
    cambios: [{ estado: 'M', ruta: mig('0001_a.sql') }],
    manifiestoBase: [],
    manifiestoHead: [entrada('0002_b.sql', SHA_A)],
    shaEnHead: () => SHA_A,
  });
  assert.equal(violaciones.length, 1);
});

test('validarManifiesto rechaza lo que no es un arreglo y las entradas incompletas', () => {
  assert.deepEqual(validarManifiesto('[]'), []);
  assert.throws(() => validarManifiesto('{}'));
  assert.throws(() => validarManifiesto('[null]'));
  assert.throws(() => validarManifiesto(JSON.stringify([{ archivo: 'x.sql', shaLedger: SHA_A, shaDisco: null, motivo: 'x' }])));
});
