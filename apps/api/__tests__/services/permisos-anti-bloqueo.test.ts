// HU #12084 AC4 — El invariante anti-bloqueo (`shared/permisos-anti-bloqueo.ts`): orden lock →
// escritura → cuenta; el lock lleva `FOR UPDATE OF users` y `ORDER BY id`; la cuenta lleva el
// predicado del resolutor (`interno`, `active`, rol ∪ concedida, ∖ revocada).
// HU #13424 (ADR-0022 §D3, AC3–AC7) — cuatro funciones y CONJUNCIÓN: cuenta a quien las reúne todas
// en el mismo usuario; cero → lanza nombrando la que quedó sin titular (o la primera de la lista).
// La fila de la cuenta llega en el orden de la proyección: [todas, f0, f1, f2, f3].
//
// Sin base y sin el mock `chain`: el mock keyed ignora `orderBy` y `for` (memoria del repo: «el mock
// ignora orderBy»), así que un aserto sobre el lock escrito contra él sería verde vacío. Aquí el
// ejecutor es `drizzle-orm/pg-proxy`, que renderiza el SQL REAL y entrega cada sentencia a un
// callback: se afirma sobre el texto y los parámetros que irían a Postgres. La concurrencia de
// verdad (dos sesiones) está en `__tests__/db/permisos-anti-bloqueo.concurrencia.test.ts`.
//
// Mutaciones que este fichero ve: M1 (`=== 0` → `> 0`, o quitar el `throw`), M3 (quitar
// `.for('update')`), M4 (quitar `orderBy(users.id)`), M7 (quitar `tipo_principal = 'interno'`),
// M8 (quitar la rama `revocar`).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/pg-proxy';

/**
 * db-review de la HU #12084 (orden de locks): el `db` que ven los SERVICIOS es también un pg-proxy
 * que graba cada sentencia, con `transaction` reducida a «llama al callback con el mismo ejecutor»
 * (el driver proxy no soporta transacciones). Responde por FORMA de sentencia con lo mínimo para
 * que `borrarRol`, `editarRol` y `guardarCuadro` lleguen al final; lo que se afirma es el ORDEN en
 * que se renderizan el `for update of "users"` (la población P) y el `for update` de `permisos_roles`.
 */
const servicios = vi.hoisted(() => ({ sentencias: [] as { sql: string; params: unknown[] }[] }));
vi.mock('../../src/db/client.js', async () => {
  const { drizzle: proxy } = await import('drizzle-orm/pg-proxy');
  const AHORA = new Date('2026-09-10T12:00:00Z');
  const rol = (tipoPrincipal: string) => ['gestor_x', 'Gestor X', null, 'ninguno', tipoPrincipal, false, true, AHORA, AHORA];
  const base = proxy(async (sql: string, params: unknown[]) => {
    servicios.sentencias.push({ sql, params });
    if (/for update of "users"/i.test(sql)) return { rows: [[1]] };
    if (/count\(\*\) filter/i.test(sql)) return { rows: [[1, 1, 1, 1, 1]] };
    if (/from "permisos_roles"[\s\S]*for update$/i.test(sql)) return { rows: [rol('interno')] };
    if (/^update "permisos_roles"/i.test(sql)) return { rows: [rol('externo')] };
    if (/count\(\*\)::int/i.test(sql)) return { rows: [[0]] };
    return { rows: [] };
  });
  const db = Object.assign(base, { transaction: async (cb: (tx: unknown) => unknown) => cb(base) });
  return { db, getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }) };
});
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
import {
  BloqueoAdministracionError, CONDICION_USUARIO_VIVO, FUNCIONES_DE_ADMINISTRACION, conSeguroAntiBloqueo,
  type EjecutorSeguro,
} from '../../src/shared/permisos-anti-bloqueo.js';

interface Sentencia { sql: string; params: unknown[] }

/**
 * Un ejecutor que renderiza SQL de verdad y responde por FORMA de sentencia: al lock (`for update`)
 * con ids, a la cuenta (`count(*) filter`) con los contadores que el caso fije.
 */
function ejecutor(contadores: number[] = [1, 1, 1, 1, 1]) {
  const sentencias: Sentencia[] = [];
  const eventos: string[] = [];
  const db = drizzle(async (sql, params) => {
    sentencias.push({ sql, params });
    if (/for update/i.test(sql)) { eventos.push('lock'); return { rows: [[1], [2]] }; }
    if (/count\(\*\) filter/i.test(sql)) { eventos.push('cuenta'); return { rows: [contadores] }; }
    throw new Error(`sentencia inesperada: ${sql}`);
  });
  return { tx: db as unknown as EjecutorSeguro, sentencias, eventos };
}

const lockDe = (s: Sentencia[]) => s.find((x) => /for update/i.test(x.sql))!;
const cuentaDe = (s: Sentencia[]) => s.find((x) => /count\(\*\) filter/i.test(x.sql))!;

describe('AC4 — conSeguroAntiBloqueo: orden y forma del lock', () => {
  it('bloquea la población ANTES de escribir y cuenta DESPUÉS, y devuelve lo que la escritura devolvió', async () => {
    const { tx, eventos } = ejecutor();
    const r = await conSeguroAntiBloqueo(tx, async () => { eventos.push('escritura'); return 'hecho'; });
    expect(r).toBe('hecho');
    expect(eventos).toEqual(['lock', 'escritura', 'cuenta']);
  });

  it('el lock es SELECT … FOR UPDATE OF users, en orden fijo por users.id (M3, M4)', async () => {
    const { tx, sentencias } = ejecutor();
    await conSeguroAntiBloqueo(tx, async () => undefined);
    const lock = lockDe(sentencias);
    expect(lock.sql).toMatch(/^select "users"\."id" from "users" inner join "permisos_roles"/);
    expect(lock.sql).toMatch(/order by "users"\."id" for update of "users"$/);
    // Solo la tabla principal: `OF users`, no `permisos_roles`.
    expect(lock.sql).not.toMatch(/for update of "permisos_roles"/);
  });

  it('el lock restringe a activos, vivos y de rol interno, y a quienes hoy tienen ALGUNA de las cuatro funciones', async () => {
    const { tx, sentencias } = ejecutor();
    await conSeguroAntiBloqueo(tx, async () => undefined);
    const lock = lockDe(sentencias);
    expect(lock.sql).toMatch(/"users"\."active" = \$\d+/);
    expect(lock.sql).toMatch(/"permisos_roles"\."tipo_principal" = \$\d+/);
    expect(lock.params).toContain(true);
    expect(lock.params).toContain('interno');
    // Las cuatro funciones de administración, unidas por OR: el lock es SUPERCONJUNTO de la población
    // contada (bloquear solo a quien ya reúne las cuatro dejaría fuera a quien está a una escritura).
    for (const f of FUNCIONES_DE_ADMINISTRACION) expect(lock.params.filter((p) => p === f), f).toHaveLength(3);
    expect(lock.sql).toMatch(/\) or exists \(/);
    expect(lock.sql).not.toMatch(/\) and \(\(exists/);
  });
});

describe('AC4 — el predicado es el del resolutor: (rol ∪ concedida) ∖ revocada, sobre internos activos (M7, M8)', () => {
  it('la cuenta lleva el `count(*) filter` conjunto y uno por función, con las TRES ramas de permisos_usuario_funcion', async () => {
    const { tx, sentencias } = ejecutor();
    await conSeguroAntiBloqueo(tx, async () => undefined);
    const cuenta = cuentaDe(sentencias);
    // 1 conjunto (las cuatro con AND) + 4 individuales (solo para nombrar la función del 409).
    expect(cuenta.sql.match(/count\(\*\) filter \(where/g)).toHaveLength(5);
    // Por cada aparición de `tiene(F)`: rol (exists permisos_rol_funcion) OR concedida, AND NOT revocada.
    expect(cuenta.sql.match(/exists \(select 1 from "permisos_rol_funcion"/g)).toHaveLength(8);
    expect(cuenta.sql.match(/exists \(select 1 from "permisos_usuario_funcion"/g)).toHaveLength(16);
    expect(cuenta.sql.match(/not exists \(select 1 from "permisos_usuario_funcion"/g)).toHaveLength(8);
    expect(cuenta.params.filter((p) => p === 'conceder')).toHaveLength(8);
    expect(cuenta.params.filter((p) => p === 'revocar')).toHaveLength(8);
    // Correlación con la fila exterior: por el rol del usuario y por su id.
    expect(cuenta.sql).toMatch(/"permisos_rol_funcion"\."rol_codigo" = "users"\."role"/);
    expect(cuenta.sql).toMatch(/"permisos_usuario_funcion"\."user_id" = "users"\."id"/);
    // Y la población: activos, internos y vivos (deleted_at IS NULL, HU #12089).
    expect(cuenta.sql).toMatch(/where \("users"\."active" = \$\d+ and "permisos_roles"\."tipo_principal" = \$\d+ and "users"\."deleted_at" is null\)/);
    expect(cuenta.params).toContain('interno');
  });

  it('HU #13424 — el primer contador es la CONJUNCIÓN: las cuatro funciones, unidas por AND, en el mismo usuario', async () => {
    const { tx, sentencias } = ejecutor();
    await conSeguroAntiBloqueo(tx, async () => undefined);
    const cuenta = cuentaDe(sentencias);
    const primero = cuenta.sql.slice(cuenta.sql.indexOf('count(*) filter'), cuenta.sql.indexOf('count(*) filter', 1 + cuenta.sql.indexOf('count(*) filter')));
    expect(primero.match(/exists \(select 1 from "permisos_rol_funcion"/g)).toHaveLength(4);
    expect(primero.match(/\) and \(\(exists/g)).toHaveLength(3); // tiene(f1) and tiene(f2) and …
    expect(primero).not.toMatch(/\)\) or \(\(exists/);
    // Cada `tiene(F)` aporta 5 parámetros; los 20 primeros son los del contador conjunto: las cuatro.
    const delConjunto = cuenta.params.slice(0, 20);
    for (const f of FUNCIONES_DE_ADMINISTRACION) expect(delConjunto, f).toContain(f);
  });

  it('CONDICION_USUARIO_VIVO es deleted_at IS NULL (HU #12089) y ya está en el lock y en la cuenta', async () => {
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const dialecto = new PgDialect();
    const renderizado = dialecto.sqlToQuery(CONDICION_USUARIO_VIVO);
    expect(renderizado.sql).toMatch(/"deleted_at" is null/i);
    const { tx, sentencias } = ejecutor();
    await conSeguroAntiBloqueo(tx, async () => undefined);
    expect(lockDe(sentencias).sql).toMatch(/"users"\."deleted_at" is null/);
    expect(cuentaDe(sentencias).sql).toMatch(/"users"\."deleted_at" is null/);
  });
});

describe('HU #13424 AC3/AC4 — nadie reúne las cuatro → lanza nombrando la función (M1)', () => {
  const MENSAJE = 'No se puede guardar: FLITO se quedaría sin ningún usuario activo que pueda administrar Usuarios y Roles y permisos.';

  it('una función se queda sin ningún titular → BloqueoAdministracionError con ESA función, tras haber escrito', async () => {
    // [todas, pagina.users, usuarios.usuario.editar, pagina.roles_permisos, permisos.cuadro.guardar]
    const { tx, eventos } = ejecutor([0, 2, 2, 0, 2]);
    const p = conSeguroAntiBloqueo(tx, async () => { eventos.push('escritura'); });
    await expect(p).rejects.toBeInstanceOf(BloqueoAdministracionError);
    await expect(p).rejects.toMatchObject({ funcion: 'pagina.roles_permisos', message: MENSAJE });
    // La escritura SÍ corrió: es la transacción la que revierte al recibir la excepción.
    expect(eventos).toEqual(['lock', 'escritura', 'cuenta']);
  });

  it('cada función conserva algún titular pero NADIE las reúne todas → lanza igual (la conjunción manda)', async () => {
    // El caso que el invariante viejo («≥ 1 por función») dejaba pasar: dos personas que se reparten
    // las cuatro. Mutante nombrado: decidir con los contadores individuales en vez de `todas` → no lanza.
    const { tx } = ejecutor([0, 1, 1, 1, 1]);
    await expect(conSeguroAntiBloqueo(tx, async () => undefined)).rejects.toMatchObject({
      funcion: FUNCIONES_DE_ADMINISTRACION[0], message: MENSAJE,
    });
  });

  it('AC6 — queda al menos un usuario con las cuatro → no lanza', async () => {
    const { tx } = ejecutor([1, 1, 1, 1, 1]);
    await expect(conSeguroAntiBloqueo(tx, async () => 'ok')).resolves.toBe('ok');
  });

  it('un contador ausente (fila vacía) cuenta como cero: negar por defecto', async () => {
    const { tx } = ejecutor([] as number[]);
    await expect(conSeguroAntiBloqueo(tx, async () => undefined)).rejects.toBeInstanceOf(BloqueoAdministracionError);
  });

  it('≥1 con las cuatro → no lanza', async () => {
    const { tx } = ejecutor([3, 5, 4, 3, 6]);
    await expect(conSeguroAntiBloqueo(tx, async () => 42)).resolves.toBe(42);
  });

  it('la excepción de la escritura sale tal cual y no se cuenta', async () => {
    const { tx, eventos } = ejecutor();
    await expect(conSeguroAntiBloqueo(tx, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(eventos).toEqual(['lock']);
  });
  it('un usuario con `revocar permisos.cuadro.guardar` no cuenta como administrador (HU #12087)', async () => {
    // `tiene(F)` = (rol ∪ concedida) ∖ revocada. Sin el NOT EXISTS de `revocar`, un admin al que
    // se le quitó la función seguiría contando y el invariante no bloquearía el último retiro.
    const { tx, sentencias } = ejecutor();
    await conSeguroAntiBloqueo(tx, async () => undefined);
    const cuenta = cuentaDe(sentencias);
    expect(cuenta.sql.match(/not exists \(select 1 from "permisos_usuario_funcion"/g)).toHaveLength(8);
    expect(cuenta.params.filter((p) => p === 'revocar')).toHaveLength(8);
    expect(cuenta.params).toContain('permisos.cuadro.guardar');
    // La exclusión va atada al mismo user_id / funcion_codigo que la concesión.
    expect(cuenta.sql).toMatch(/"permisos_usuario_funcion"\."user_id" = "users"\."id"/);
    expect(cuenta.sql).toMatch(/"permisos_usuario_funcion"\."efecto" = \$\d+/);
  });
});

describe('AC4 — el parámetro `funciones` existe para el test de concurrencia', () => {
  it('por defecto son las cuatro de «Usuarios» y «Roles y permisos» (HU #13424, P-2) y nada más', () => {
    expect(FUNCIONES_DE_ADMINISTRACION).toEqual([
      'pagina.users', 'usuarios.usuario.editar', 'pagina.roles_permisos', 'permisos.cuadro.guardar',
    ]);
  });

  it('con una lista propia, el lock y la cuenta miran SOLO esa función', async () => {
    const { tx, sentencias } = ejecutor([1, 1]);
    await conSeguroAntiBloqueo(tx, async () => undefined, ['zz.prueba.administrar']);
    expect(lockDe(sentencias).params).not.toContain('permisos.cuadro.guardar');
    expect(lockDe(sentencias).params.filter((p) => p === 'zz.prueba.administrar')).toHaveLength(3);
    // El conjunto (de una sola función) y su contador individual.
    expect(cuentaDe(sentencias).sql.match(/count\(\*\) filter/g)).toHaveLength(2);
  });
});

describe('db-review HU #12084 — orden de locks en los servicios de roles: la población P ANTES que la fila del rol', () => {
  const ACTOR = { userId: 1, email: null, rol: 'admin' };
  const indiceDe = (re: RegExp) => servicios.sentencias.findIndex((x) => re.test(x.sql));
  const LOCK_P = /for update of "users"$/i;
  const LOCK_ROL = /from "permisos_roles"[\s\S]*for update$/i;

  beforeEach(() => { servicios.sentencias.length = 0; });

  // **Mutante:** devolver el `for('update')` del rol antes del envoltorio en `borrarRol` → rojo aquí.
  it('borrarRol: primero `for update of "users"`, después el `for update` de permisos_roles, y el DELETE tras los dos', async () => {
    const { borrarRol } = await import('../../src/modules/permisos/permisos-roles.service.js');
    await borrarRol('gestor_x', ACTOR);
    const p = indiceDe(LOCK_P);
    const rol = indiceDe(LOCK_ROL);
    const del = indiceDe(/^delete from "permisos_roles"/i);
    expect(p, servicios.sentencias.map((x) => x.sql).join('\n')).toBe(0);
    expect(rol).toBeGreaterThan(p);
    expect(del).toBeGreaterThan(rol);
    expect(indiceDe(/count\(\*\) filter/i)).toBeGreaterThan(del);
  });

  it('editarRol con `tipoPrincipal`: P primero, el rol después, el UPDATE tras los dos', async () => {
    const { editarRol } = await import('../../src/modules/permisos/permisos-roles.service.js');
    const r = await editarRol('gestor_x', { tipoPrincipal: 'externo' }, ACTOR);
    expect(r.estado).toBe('ok');
    const p = indiceDe(LOCK_P);
    const rol = indiceDe(LOCK_ROL);
    expect(p, servicios.sentencias.map((x) => x.sql).join('\n')).toBe(0);
    expect(rol).toBeGreaterThan(p);
    expect(indiceDe(/^update "permisos_roles"/i)).toBeGreaterThan(rol);
  });

  it('editarRol SIN `tipoPrincipal` (solo nombre) no toma P: el `for update` del rol va solo', async () => {
    const { editarRol } = await import('../../src/modules/permisos/permisos-roles.service.js');
    const r = await editarRol('gestor_x', { nombre: 'Otro' }, ACTOR);
    expect(r.estado).toBe('ok');
    expect(indiceDe(LOCK_P)).toBe(-1);
    expect(indiceDe(LOCK_ROL)).toBe(0);
  });

  it('guardarCuadro: el mismo orden (P → rol), que es la referencia que los otros dos copian', async () => {
    const { guardarCuadro } = await import('../../src/modules/permisos/permisos-roles.service.js');
    await guardarCuadro('gestor_x', [], ACTOR);
    const p = indiceDe(LOCK_P);
    expect(p).toBeGreaterThanOrEqual(0);
    expect(indiceDe(LOCK_ROL)).toBeGreaterThan(p);
  });
});

describe('AC4 — el invariante vive en UN sitio y lo invocan las cinco operaciones (cuatro hoy + el enganche de la #12089)', () => {
  const aqui = path.dirname(fileURLToPath(import.meta.url));
  const fuente = (rel: string) => readFileSync(path.resolve(aqui, '../../src', rel), 'utf8');
  const sinComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

  it('users.service.ts: actualizarUsuario, cambiarActivo y darDeBaja invocan conSeguroAntiBloqueo(tx, …)', () => {
    const src = sinComentarios(fuente('modules/users/users.service.ts'));
    expect(src).toMatch(/import \{ conSeguroAntiBloqueo \} from '\.\.\/\.\.\/shared\/permisos-anti-bloqueo\.js';/);
    // Tres caminos: rol/funciones, desactivar, baja (#12089).
    expect(src.match(/conSeguroAntiBloqueo\(tx,/g)).toHaveLength(3);
    expect(src).toMatch(/updates\.role !== undefined \|\| funcionesDestino !== null \? conSeguroAntiBloqueo\(tx, cuerpo\) : cuerpo\(\)/);
    expect(src).toMatch(/await conSeguroAntiBloqueo\(tx, \(\) => tx\.update\(users\)\s*\.set\(\{ active: sql`NOT active`/);
    expect(src).toMatch(/export async function darDeBaja[\s\S]*?conSeguroAntiBloqueo\(tx,/);
  });

  it('permisos-roles.service.ts: borrar el rol y guardar el cuadro lo invocan con su `tx`; crear no (añadir nunca bloquea)', () => {
    const src = sinComentarios(fuente('modules/permisos/permisos-roles.service.ts'));
    expect(src.match(/conSeguroAntiBloqueo\(tx,/g)).toHaveLength(3); // borrar, editar tipoPrincipal, guardar cuadro
    // Los tres envuelven la transacción ENTERA (población primero; db-review de la HU #12084).
    expect(src).toMatch(/db\.transaction\(async \(tx\) => conSeguroAntiBloqueo\(tx, async \(\) => \{\s*const \[rol\] = await tx\.select\(\)\.from\(permisosRoles\)/);
    expect(src).toMatch(/cambios\.tipoPrincipal !== undefined \? conSeguroAntiBloqueo\(tx, \(\) => cuerpo\(tx\)\) : cuerpo\(tx\)/);
    expect(src).toMatch(/db\.transaction\(async \(tx\) => conSeguroAntiBloqueo\(tx, async \(\): Promise<RespuestaGuardarCuadro>/);
    const crear = src.slice(src.indexOf('export async function crearRol'), src.indexOf('export type ResultadoEditarRol'));
    expect(crear).not.toMatch(/conSeguroAntiBloqueo/);
  });

  it('HU #13424 AC1 — el motor no trata a `admin` por su nombre: ni en el seguro, ni en el servicio de permisos, ni en users', () => {
    // ADR-0022 §D1.4: fuera de comentarios, ningún literal `'admin'` decide en estos archivos.
    for (const rel of [
      'shared/permisos-anti-bloqueo.ts', 'shared/permisos-efectivos.ts', 'modules/permisos/permisos.service.ts',
      'modules/permisos/permisos-roles.service.ts', 'modules/users/users.service.ts', 'modules/users/users.routes.ts',
      'modules/users/users-baja.ts',
    ]) {
      expect(sinComentarios(fuente(rel)), rel).not.toMatch(/'admin'/);
    }
  });

  it('nadie copia la cuenta: fuera de permisos-anti-bloqueo.ts no hay otro `count(*) filter` sobre users con tipo_principal', () => {
    for (const rel of ['modules/users/users.service.ts', 'modules/permisos/permisos-roles.service.ts', 'modules/users/users.routes.ts', 'modules/permisos/permisos.routes.ts']) {
      expect(sinComentarios(fuente(rel)), rel).not.toMatch(/count\(\*\) filter/);
      expect(sinComentarios(fuente(rel)), rel).not.toMatch(/FUNCIONES_DE_ADMINISTRACION/);
    }
  });
});
