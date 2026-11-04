// ADR-0035 (HU #14102): drizzle-kit está retirado y nada puede revivirlo por casualidad.
// El stub se ejecuta de verdad: no toca BD alguna, solo imprime el error y sale con 1.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RAIZ = fileURLToPath(new URL('../../../../', import.meta.url));
const API = path.join(RAIZ, 'apps/api');
const leerJson = (ruta: string) => JSON.parse(readFileSync(ruta, 'utf8'));
const pkgRaiz = leerJson(path.join(RAIZ, 'package.json'));
const pkgApi = leerJson(path.join(API, 'package.json'));

function correrScript(cwd: string, script: string) {
  // Sin DATABASE_URL: el stub no debe necesitarla, y así un error no podría apuntar a una BD.
  const env = { ...process.env };
  delete env.DATABASE_URL;
  return spawnSync('npm', ['run', '--silent', script], { cwd, env, encoding: 'utf8' });
}

describe('AC2: los scripts de drizzle-kit terminan con error y remiten al ADR', () => {
  it.each([
    ['apps/api', API, 'db:generate'],
    ['apps/api', API, 'db:migrate'],
    ['raíz', RAIZ, 'db:generate'],
    ['raíz', RAIZ, 'db:migrate'],
  ])('%s %s %s', (_lugar, cwd, script) => {
    const r = correrScript(cwd, script);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('ADR-0035');
    expect(r.stderr).toContain('retirado');
  });

  it('ningún script ejecuta el binario', () => {
    for (const comando of [...Object.values(pkgRaiz.scripts), ...Object.values(pkgApi.scripts)] as string[]) {
      expect(comando).not.toMatch(/drizzle-kit\s+(generate|migrate|push|check|introspect|studio|pull|up)\b/);
    }
  });
});

describe('AC2: la dependencia no está, así que un lockfile no puede «arreglarla»', () => {
  it('apps/api y la raíz no la declaran; drizzle-orm sigue', () => {
    for (const pkg of [pkgRaiz, pkgApi]) {
      expect(pkg.dependencies?.['drizzle-kit']).toBeUndefined();
      expect(pkg.devDependencies?.['drizzle-kit']).toBeUndefined();
    }
    expect(pkgApi.dependencies['drizzle-orm']).toBeDefined();
  });

  it('el lockfile no la resuelve', () => {
    const lock = leerJson(path.join(RAIZ, 'package-lock.json'));
    expect(Object.keys(lock.packages).filter((k: string) => k.includes('drizzle-kit'))).toEqual([]);
  });

  it('no queda config para que un drizzle-kit descargado la encuentre', () => {
    for (const archivo of ['drizzle.config.ts', 'drizzle.config.js', 'drizzle.config.json']) {
      expect(existsSync(path.join(API, archivo))).toBe(false);
      expect(existsSync(path.join(RAIZ, archivo))).toBe(false);
    }
  });
});

describe('AC3 y AC4: retirada de meta/ y de las herramientas', () => {
  it('meta/ no existe y el runner sigue teniendo sus .sql y su manifiesto', () => {
    const migraciones = path.join(API, 'src/db/migrations');
    expect(existsSync(path.join(migraciones, 'meta'))).toBe(false);
    expect(existsSync(path.join(migraciones, 'derivas-aceptadas.json'))).toBe(true);
    expect(readdirSync(migraciones).filter((f) => f.endsWith('.sql')).length).toBeGreaterThan(0);
  });

  it('push, check, introspect y studio no tienen script', () => {
    const scripts = [...Object.keys(pkgRaiz.scripts), ...Object.keys(pkgApi.scripts)];
    expect(scripts.filter((s) => /^db:(push|check|introspect|pull|studio)$/.test(s))).toEqual([]);
  });

  it('el tooling de apps ya no referencia un archivo borrado', () => {
    const naming = readFileSync(path.join(RAIZ, 'scripts/check-naming.mjs'), 'utf8');
    expect(naming).not.toContain('drizzle.config.ts');
  });
});
