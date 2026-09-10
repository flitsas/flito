// HU #12084 AC4 — El invariante anti-bloqueo (`shared/permisos-anti-bloqueo.ts`): orden lock →
// escritura → cuenta; el lock lleva `FOR UPDATE OF users` y `ORDER BY id`; la cuenta lleva el
// predicado del resolutor (`interno`, `active`, rol ∪ concedida, ∖ revocada); cero en cualquiera de
// las dos funciones → lanza con la función que faltó.
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

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/pg-proxy';
import {
  BloqueoAdministracionError, CONDICION_USUARIO_VIVO, FUNCIONES_DE_ADMINISTRACION, conSeguroAntiBloqueo,
  type EjecutorSeguro,
} from '../../src/shared/permisos-anti-bloqueo.js';

interface Sentencia { sql: string; params: unknown[] }

/**
 * Un ejecutor que renderiza SQL de verdad y responde por FORMA de sentencia: al lock (`for update`)
 * con ids, a la cuenta (`count(*) filter`) con los contadores que el caso fije.
 */
function ejecutor(contadores: number[] = [1, 1]) {
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

  it('el lock restringe a activos, vivos y de rol interno, y a quienes hoy tienen ALGUNA de las dos funciones', async () => {
    const { tx, sentencias } = ejecutor();
    await conSeguroAntiBloqueo(tx, async () => undefined);
    const lock = lockDe(sentencias);
    expect(lock.sql).toMatch(/"users"\."active" = \$\d+/);
    expect(lock.sql).toMatch(/"permisos_roles"\."tipo_principal" = \$\d+/);
    expect(lock.params).toContain(true);
    expect(lock.params).toContain('interno');
    // Las dos funciones de administración, unidas por OR.
    expect(lock.params.filter((p) => p === 'permisos.cuadro.guardar')).toHaveLength(3);
    expect(lock.params.filter((p) => p === 'usuarios.usuario.editar')).toHaveLength(3);
    expect(lock.sql).toMatch(/\) or exists \(/);
  });
});

describe('AC4 — el predicado es el del resolutor: (rol ∪ concedida) ∖ revocada, sobre internos activos (M7, M8)', () => {
  it('la cuenta lleva un `count(*) filter` por función con las TRES ramas de permisos_usuario_funcion', async () => {
    const { tx, sentencias } = ejecutor();
    await conSeguroAntiBloqueo(tx, async () => undefined);
    const cuenta = cuentaDe(sentencias);
    expect(cuenta.sql.match(/count\(\*\) filter \(where/g)).toHaveLength(2);
    // Por cada función: rol (exists permisos_rol_funcion) OR concedida (exists … 'conceder'), AND NOT revocada.
    expect(cuenta.sql.match(/exists \(select 1 from "permisos_rol_funcion"/g)).toHaveLength(2);
    expect(cuenta.sql.match(/exists \(select 1 from "permisos_usuario_funcion"/g)).toHaveLength(4);
    expect(cuenta.sql.match(/not exists \(select 1 from "permisos_usuario_funcion"/g)).toHaveLength(2);
    expect(cuenta.params.filter((p) => p === 'conceder')).toHaveLength(2);
    expect(cuenta.params.filter((p) => p === 'revocar')).toHaveLength(2);
    // Correlación con la fila exterior: por el rol del usuario y por su id.
    expect(cuenta.sql).toMatch(/"permisos_rol_funcion"\."rol_codigo" = "users"\."role"/);
    expect(cuenta.sql).toMatch(/"permisos_usuario_funcion"\."user_id" = "users"\."id"/);
    // Y la población: activos, internos.
    expect(cuenta.sql).toMatch(/where \("users"\."active" = \$\d+ and "permisos_roles"\."tipo_principal" = \$\d+ and true\)/);
    expect(cuenta.params).toContain('interno');
  });

  it('CONDICION_USUARIO_VIVO es `true` hasta la #12089 y ya está en el lock y en la cuenta', async () => {
    expect(CONDICION_USUARIO_VIVO.queryChunks.map((c) => (c as { value?: string[] }).value?.join('') ?? '').join('')).toBe('true');
    const { tx, sentencias } = ejecutor();
    await conSeguroAntiBloqueo(tx, async () => undefined);
    expect(lockDe(sentencias).sql).toMatch(/ and true\)/);
    expect(cuentaDe(sentencias).sql).toMatch(/ and true\)/);
  });
});

describe('AC4 — cero titulares en cualquiera de las dos → lanza con la función que faltó (M1)', () => {
  it('cero para «administrar permisos» → BloqueoAdministracionError(permisos.cuadro.guardar), tras haber escrito', async () => {
    const { tx, eventos } = ejecutor([0, 1]);
    const p = conSeguroAntiBloqueo(tx, async () => { eventos.push('escritura'); });
    await expect(p).rejects.toBeInstanceOf(BloqueoAdministracionError);
    await expect(p).rejects.toMatchObject({ funcion: 'permisos.cuadro.guardar' });
    await expect(p).rejects.toThrow(/cero usuarios activos capaces de administrar permisos/);
    // La escritura SÍ corrió: es la transacción la que revierte al recibir la excepción.
    expect(eventos).toEqual(['lock', 'escritura', 'cuenta']);
  });

  it('cero para «administrar usuarios» → BloqueoAdministracionError(usuarios.usuario.editar)', async () => {
    const { tx } = ejecutor([3, 0]);
    await expect(conSeguroAntiBloqueo(tx, async () => undefined)).rejects.toMatchObject({
      funcion: 'usuarios.usuario.editar',
      message: expect.stringMatching(/administrar usuarios/),
    });
  });

  it('un contador ausente (fila vacía) cuenta como cero: negar por defecto', async () => {
    const { tx } = ejecutor([] as number[]);
    await expect(conSeguroAntiBloqueo(tx, async () => undefined)).rejects.toBeInstanceOf(BloqueoAdministracionError);
  });

  it('≥1 en las dos → no lanza', async () => {
    const { tx } = ejecutor([1, 1]);
    await expect(conSeguroAntiBloqueo(tx, async () => 42)).resolves.toBe(42);
  });

  it('la excepción de la escritura sale tal cual y no se cuenta', async () => {
    const { tx, eventos } = ejecutor();
    await expect(conSeguroAntiBloqueo(tx, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(eventos).toEqual(['lock']);
  });
});

describe('AC4 — el parámetro `funciones` existe para el test de concurrencia', () => {
  it('por defecto son las dos de administración y nada más', () => {
    expect(FUNCIONES_DE_ADMINISTRACION).toEqual(['permisos.cuadro.guardar', 'usuarios.usuario.editar']);
  });

  it('con una lista propia, el lock y la cuenta miran SOLO esa función', async () => {
    const { tx, sentencias } = ejecutor([1]);
    await conSeguroAntiBloqueo(tx, async () => undefined, ['zz.prueba.administrar']);
    expect(lockDe(sentencias).params).not.toContain('permisos.cuadro.guardar');
    expect(lockDe(sentencias).params.filter((p) => p === 'zz.prueba.administrar')).toHaveLength(3);
    expect(cuentaDe(sentencias).sql.match(/count\(\*\) filter/g)).toHaveLength(1);
  });
});

describe('AC4 — el invariante vive en UN sitio y lo invocan las cinco operaciones (cuatro hoy + el enganche de la #12089)', () => {
  const aqui = path.dirname(fileURLToPath(import.meta.url));
  const fuente = (rel: string) => readFileSync(path.resolve(aqui, '../../src', rel), 'utf8');
  const sinComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

  it('users.service.ts: cambiar el rol (actualizarUsuario, solo si viene `role`) y desactivar (cambiarActivo) lo invocan con su `tx`', () => {
    const src = sinComentarios(fuente('modules/users/users.service.ts'));
    expect(src).toMatch(/import \{ conSeguroAntiBloqueo \} from '\.\.\/\.\.\/shared\/permisos-anti-bloqueo\.js';/);
    expect(src.match(/conSeguroAntiBloqueo\(tx,/g)).toHaveLength(2);
    expect(src).toMatch(/updates\.role !== undefined \? conSeguroAntiBloqueo\(tx, cuerpo\) : cuerpo\(\)/);
    expect(src).toMatch(/await conSeguroAntiBloqueo\(tx, \(\) => tx\.update\(users\)\s*\.set\(\{ active: sql`NOT active`/);
    // El quinto camino (baja definitiva, #12089) deja el enganche escrito con nombre.
    expect(fuente('modules/users/users.service.ts')).toMatch(/#12089[\s\S]{0,200}conSeguroAntiBloqueo/);
  });

  it('permisos-roles.service.ts: borrar el rol y guardar el cuadro lo invocan con su `tx`; crear no (añadir nunca bloquea)', () => {
    const src = sinComentarios(fuente('modules/permisos/permisos-roles.service.ts'));
    expect(src.match(/conSeguroAntiBloqueo\(tx,/g)).toHaveLength(3); // borrar, editar tipoPrincipal, guardar cuadro
    expect(src).toMatch(/await conSeguroAntiBloqueo\(tx, async \(\) => \{\s*await tx\.delete\(permisosRoles\)/);
    expect(src).toMatch(/db\.transaction\(async \(tx\) => conSeguroAntiBloqueo\(tx, async \(\): Promise<RespuestaGuardarCuadro>/);
    const crear = src.slice(src.indexOf('export async function crearRol'), src.indexOf('export type ResultadoEditarRol'));
    expect(crear).not.toMatch(/conSeguroAntiBloqueo/);
  });

  it('nadie copia la cuenta: fuera de permisos-anti-bloqueo.ts no hay otro `count(*) filter` sobre users con tipo_principal', () => {
    for (const rel of ['modules/users/users.service.ts', 'modules/permisos/permisos-roles.service.ts', 'modules/users/users.routes.ts', 'modules/permisos/permisos.routes.ts']) {
      expect(sinComentarios(fuente(rel)), rel).not.toMatch(/count\(\*\) filter/);
      expect(sinComentarios(fuente(rel)), rel).not.toMatch(/FUNCIONES_DE_ADMINISTRACION/);
    }
  });
});
