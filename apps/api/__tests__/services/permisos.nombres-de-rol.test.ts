// HU #13425 (Feature #13414, Épica #13411, ADR-0022) — AC6: ninguna REGLA del servidor decide por el
// NOMBRE (código) del rol. Guarda estática sobre el fuente, por fichero, sin comentarios.
//
// Lo que queda medido son FILTROS DE DATOS (qué filas ve el usuario), no reglas de acceso: su
// reconducción es la HU #12871 y viven en `PENDIENTES_12871`, exacta (`toEqual`). Si aparece una
// comparación nueva, o desaparece una de la lista sin quitarla de aquí, el test se pone rojo.
//
// Fase A: ámbito `auth`, `users` y todos los `flito-*`. Fase B (tras rebasar sobre la HU #13421):
// `jornadas`, `pesv` y `drivers`, cuyas reglas por nombre pasaron a funciones del motor.
//
// Confirmado leyendo el código (2026-10-07) que las tres de `PENDIENTES_12871` solo ACOTAN filas:
//   · flito-impuestos.service.ts `esGestor` → `return null` / `inArray(organismos)` en la cola y el detalle.
//   · flito-recibos.service.ts `esGestor` → `inArray(flitoImpuestos.organismoCodigo, organismos)` del lote.
//   · flito-impuestos.routes.ts `contextoImpuesto` → carga los organismos del gestor (vacío = no ve nada).
// Ninguna devuelve 403 ni habilita una acción.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULOS = fileURLToPath(new URL('../../src/modules', import.meta.url));

/** Directorios de `src/modules` en el ámbito de la HU (Fase A + Fase B). */
const DIRECTORIOS = readdirSync(MODULOS)
  .filter((d) => ['auth', 'users', 'jornadas', 'pesv', 'drivers'].includes(d) || d.startsWith('flito-'))
  .filter((d) => statSync(join(MODULOS, d)).isDirectory())
  .sort();

/**
 * Formas en que el fuente compara contra un NOMBRE de rol. Se buscan literales: `eq(users.role, f.rol)`
 * (filtro del listado por un valor que manda el usuario) o `updates.role !== anterior.role` (¿cambió?)
 * no deciden por un nombre y no cuentan.
 */
const COMPARACION_DE_ROL: RegExp[] = [
  /\.role\s*(?:===|!==|==|!=)\s*['"`][a-z_]+['"`]/g,
  /['"`][a-z_]+['"`]\s*(?:===|!==|==|!=)\s*[\w.!?]+\.role\b/g,
  /\beq\(\s*[\w.]+\.role\s*,\s*['"`][a-z_]+['"`]/g,
  /\binArray\(\s*[\w.]+\.role\s*,/g,
  /\[[^\]]*['"`][a-z_]+['"`][^\]]*\]\s*\.includes\(\s*[\w.!?]+\.role\s*\)/g,
  /\brequireRole\(/g,
  /\bswitch\s*\(\s*[\w.!?]+\.role\s*\)/g,
];

const sinComentarios = (fuente: string): string =>
  fuente.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

function ficherosTs(dir: string): string[] {
  const salida: string[] = [];
  for (const nombre of readdirSync(dir)) {
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) salida.push(...ficherosTs(ruta));
    else if (nombre.endsWith('.ts')) salida.push(ruta);
  }
  return salida;
}

/** `{ fichero, veces }` por cada fichero del ámbito con al menos una comparación, ordenado. */
function medir(): { fichero: string; veces: number }[] {
  const medidas: { fichero: string; veces: number }[] = [];
  for (const dir of DIRECTORIOS) {
    for (const ruta of ficherosTs(join(MODULOS, dir))) {
      const fuente = sinComentarios(readFileSync(ruta, 'utf8'));
      const veces = COMPARACION_DE_ROL.reduce((n, re) => n + (fuente.match(re)?.length ?? 0), 0);
      if (veces > 0) medidas.push({ fichero: relative(MODULOS, ruta), veces });
    }
  }
  return medidas.sort((a, b) => a.fichero.localeCompare(b.fichero));
}

/** Filtros de DATOS (ámbito de filas por organismo del gestor): los reconduce la HU #12871. */
const PENDIENTES_12871: { fichero: string; veces: number; que: string }[] = [
  { fichero: 'flito-impuestos/flito-impuestos.routes.ts', veces: 1, que: 'contextoImpuesto: carga los organismos del gestor' },
  { fichero: 'flito-impuestos/flito-impuestos.service.ts', veces: 1, que: 'esGestor: cola y detalle acotados a sus organismos' },
  { fichero: 'flito-impuestos/flito-recibos.service.ts', veces: 1, que: 'esGestor: lote de recibos acotado a sus organismos' },
];

/** Solo puede BAJAR. Subirlo exige decisión del Líder Técnico (una regla nueva por nombre de rol). */
const TOPE_13425 = 3;

describe('HU #13425 AC6 — ninguna regla del servidor decide por el nombre del rol (auth, users, flito-*, jornadas, pesv, drivers)', () => {
  it('el ámbito incluye auth, users, jornadas, pesv, drivers y los módulos flito-* (no se queda vacío por un renombre de carpeta)', () => {
    expect(DIRECTORIOS).toContain('auth');
    expect(DIRECTORIOS).toContain('users');
    for (const d of ['jornadas', 'pesv', 'drivers']) expect(DIRECTORIOS).toContain(d);
    expect(DIRECTORIOS).toContain('flito-logistica');
    expect(DIRECTORIOS).toContain('flito-impuestos');
    expect(DIRECTORIOS).toContain('flito-liquidacion');
    expect(DIRECTORIOS.filter((d) => d.startsWith('flito-')).length).toBeGreaterThanOrEqual(15);
  });

  it('lo medido es EXACTAMENTE la lista de filtros de datos pendientes de la #12871', () => {
    expect(medir()).toEqual(PENDIENTES_12871.map(({ fichero, veces }) => ({ fichero, veces })));
  });

  it(`el total no supera el tope (${TOPE_13425}) — ratchet: solo puede bajar`, () => {
    expect(PENDIENTES_12871.reduce((n, p) => n + p.veces, 0)).toBeLessThanOrEqual(TOPE_13425);
    expect(medir().reduce((n, m) => n + m.veces, 0)).toBeLessThanOrEqual(TOPE_13425);
  });

  it('auth, users, flito-logistica, jornadas, pesv y drivers: cero comparaciones (las reglas de la HU van por función)', () => {
    const conAlgo = medir().map((m) => m.fichero.split('/')[0]);
    for (const dir of ['auth', 'users', 'flito-logistica', 'jornadas', 'pesv', 'drivers']) expect(conAlgo).not.toContain(dir);
  });

  it('el detector ve cada forma (sonda contra un fuente sintético)', () => {
    const sonda = [
      "if (user.role !== 'cliente') return;",
      "const x = 'mensajero' === ctx.role;",
      "db.select().from(users).where(eq(users.role, 'mensajero'));",
      'where(inArray(users.role, roles));',
      "if (['admin', 'auditor'].includes(req.user!.role)) {}",
      "router.get('/', requireRole('admin'), h);",
      'switch (ctx.role) { default: }',
    ].join('\n');
    const porForma = COMPARACION_DE_ROL.map((re) => sonda.match(re)?.length ?? 0);
    expect(porForma).toEqual([1, 1, 1, 1, 1, 1, 1]);
    // Y lo que NO es regla por nombre no cuenta.
    const neutro = "if (updates.role !== anterior.role) {}\ncs.push(eq(users.role, f.rol));\n// ctx.role === 'admin'";
    expect(COMPARACION_DE_ROL.reduce((n, re) => n + (sinComentarios(neutro).match(re)?.length ?? 0), 0)).toBe(0);
  });
});
