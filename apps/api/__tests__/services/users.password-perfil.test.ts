// HU #13255 (Feature #13254) — `PATCH /api/users/:id/password` abierto al canal externo SOLO para la
// propia contraseña (AC2-AC7), con freno por usuario (D2). HU #13425 (AC4): la propia ya no exige
// `pagina.perfil` (decisión del PO del 2026-10-07); la ajena sigue vedada al externo.
//
// `authMiddleware` y `guardiaFrontera` son los de VERDAD: desde la HU #12875 la regla es por ENLACE
// del resolutor (el helper `testToken` registra `cliente` con enlace compañía y `proveedor` con enlace
// proveedor): con enlace, la propia sí y la ajena nunca. Un 403 de aquí sale de la cadena real. «Clave intacta» se afirma sobre la escritura:
// ni `transaction` (donde `restablecerContrasena` escribe el hash) ni `argon2.hash` se tocan.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken, registrarUsuarioDePrueba } from '../helpers/auth.js';

const selectMock = vi.fn();
const transactionMock = vi.fn();
const updateMock = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: vi.fn(), update: updateMock, delete: vi.fn(), transaction: transactionMock, execute: vi.fn() },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
const argonHashMock = vi.fn().mockResolvedValue('HASH-NUEVO');
const argonVerifyMock = vi.fn();
vi.mock('argon2', () => ({
  default: { hash: argonHashMock, verify: argonVerifyMock }, hash: argonHashMock, verify: argonVerifyMock,
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));
const invalidarSesionMock = vi.fn();
const blacklistMock = vi.fn();
vi.mock('../../src/shared/middleware/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/middleware/auth.js')>();
  return {
    ...actual,
    invalidateSessionCacheFor: (id: number) => invalidarSesionMock(id),
    blacklistToken: (t: string) => blacklistMock(t),
  };
});

const STRONG_PWD = 'Aa1!aaaa';
/** Lo que `restablecerContrasena` escribe dentro de la transacción, por tabla. */
let escrituras: Array<{ op: string; valores: Record<string, unknown> }> = [];

beforeEach(() => {
  selectMock.mockReset();
  transactionMock.mockReset();
  updateMock.mockReset();
  argonVerifyMock.mockReset();
  argonHashMock.mockClear();
  invalidarSesionMock.mockClear();
  blacklistMock.mockClear();
  escrituras = [];
  transactionMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({
    update: () => ({ set: (v: Record<string, unknown>) => { escrituras.push({ op: 'update', valores: v }); return { where: () => Promise.resolve() }; } }),
    insert: () => ({ values: (v: Record<string, unknown>) => { escrituras.push({ op: 'insert', valores: v }); return Promise.resolve(); } }),
  }));
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/users/users.routes.js');
  app.use('/api/users', router);
  return app;
}

/** El titular existe y su clave actual verifica (o no). */
function titular(id: number, role: string, actualOk = true) {
  selectMock.mockReturnValueOnce(chain([{ id, passwordHash: 'hash-viejo', role, active: true, deletedAt: null }]));
  argonVerifyMock.mockResolvedValueOnce(actualOk);
}

const patch = async (app: express.Express, id: number, token: string, body: Record<string, unknown> = { currentPassword: 'Actual1!', newPassword: STRONG_PWD }) =>
  request(app).patch(`/api/users/${id}/password`).set('Authorization', `Bearer ${token}`).send(body);

function claveIntacta() {
  expect(transactionMock).not.toHaveBeenCalled();
  expect(argonHashMock).not.toHaveBeenCalled();
  expect(escrituras).toEqual([]);
}

describe('HU #13255 — cambio de la PROPIA contraseña desde el canal externo', () => {
  // HU #13425 (AC4, decisión del PO del 2026-10-07) sustituye el AC2 de la #13255: la contraseña
  // PROPIA se cambia sin el permiso de Perfil, también desde el canal externo.
  it('HU #13425 AC4: externo SIN `pagina.perfil` cambia SU propia contraseña → 200 {ok:true}, verificando la actual', async () => {
    const token = await testToken({ sub: 301, role: 'cliente' });
    titular(301, 'cliente');
    const r = await patch(await buildApp(), 301, token);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(argonVerifyMock).toHaveBeenCalledWith('hash-viejo', 'Actual1!');
    expect(escrituras.filter((e) => e.op === 'update')).toEqual([{ op: 'update', valores: { passwordHash: 'HASH-NUEVO' } }]);
  });

  it('HU #13425 AC4: externo SIN `pagina.perfil` sobre OTRO id → 403 `Sin permisos`, clave intacta', async () => {
    const token = await testToken({ sub: 310, role: 'cliente' });
    const r = await patch(await buildApp(), 999, token);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'Sin permisos' });
    expect(selectMock).not.toHaveBeenCalled();
    claveIntacta();
  });

  it('HU #13425 AC4: resolutor que no decide (sin fila de permisos) → 403 también para la propia (falla cerrado)', async () => {
    const token = await testToken({ sub: 311, role: 'cliente' });
    await registrarUsuarioDePrueba(311, null as never);
    const r = await patch(await buildApp(), 311, token);
    expect(r.status).toBe(403);
    claveIntacta();
  });

  it('AC3: externo CON `pagina.perfil` sobre su propio id → 200 {ok:true}; escribe solo el hash y NO revoca su sesión', async () => {
    const token = await testToken({ sub: 302, role: 'cliente', funciones: ['pagina.perfil'] });
    titular(302, 'cliente');
    const r = await patch(await buildApp(), 302, token);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(argonVerifyMock).toHaveBeenCalledWith('hash-viejo', 'Actual1!');
    const update = escrituras.filter((e) => e.op === 'update');
    expect(update).toEqual([{ op: 'update', valores: { passwordHash: 'HASH-NUEVO' } }]);
    // El token actual sigue vivo: ni `session_invalidated_at`, ni purga de caché, ni lista negra.
    expect(JSON.stringify(escrituras)).not.toMatch(/sessionInvalidatedAt/);
    expect(invalidarSesionMock).not.toHaveBeenCalled();
    expect(blacklistMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    // Y la MISMA cabecera sigue autenticando después del cambio.
    const otra = await patch(await buildApp(), 302, token, { currentPassword: 'x', newPassword: 'corta' });
    expect(otra.status).toBe(400);
  });

  it('AC4: externo con Perfil y contraseña actual incorrecta → 401 «Contraseña actual incorrecta», clave intacta', async () => {
    const token = await testToken({ sub: 303, role: 'cliente', funciones: ['pagina.perfil'] });
    titular(303, 'cliente', false);
    const r = await patch(await buildApp(), 303, token);
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('Contraseña actual incorrecta');
    claveIntacta();
  });

  it('AC5: externo con Perfil y nueva contraseña fuera de la política → 400, clave intacta', async () => {
    const token = await testToken({ sub: 304, role: 'cliente', funciones: ['pagina.perfil'] });
    for (const mala of ['aa1!aaaa', 'AA1!AAAA', 'Aa!aaaaa', 'Aa1aaaaa', 'A1!a']) {
      const r = await patch(await buildApp(), 304, token, { currentPassword: 'Actual1!', newPassword: mala });
      expect(r.status, mala).toBe(400);
    }
    claveIntacta();
  });

  it('R1: externo con Perfil Y `cambiar_ajena` sobre OTRO id → 403 (al externo nunca se le permite la ajena)', async () => {
    const token = await testToken({ sub: 305, role: 'cliente', funciones: ['pagina.perfil', 'usuarios.contrasena.cambiar_ajena'] });
    const r = await patch(await buildApp(), 999, token);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'Sin permisos' });
    expect(selectMock).not.toHaveBeenCalled();
    claveIntacta();
  });

  it('HU #12875: un rol CON ENLACE creado desde el panel (no el literal `cliente`) sigue la misma regla: la propia sí, la ajena no', async () => {
    const token = await testToken({ sub: 306, role: 'financiera' });
    // Se re-registra DESPUÉS de emitir el token: decide el ENLACE del resolutor, no el rol del JWT.
    await registrarUsuarioDePrueba(306, { rol: 'aliado_x', tipoEnlace: 'proveedor', funcionesDelRol: ['usuarios.contrasena.cambiar_ajena'], excepciones: [] });
    const ajena = await patch(await buildApp(), 999, token);
    expect(ajena.status).toBe(403);
    expect(ajena.body).toEqual({ error: 'Sin permisos' });
    claveIntacta();
    titular(306, 'aliado_x');
    const propia = await patch(await buildApp(), 306, token);
    expect(propia.status).toBe(200);
  });

  it('AC6: con enlace (proveedor) y SIN `pagina.perfil` sigue cambiando la propia → 200', async () => {
    const token = await testToken({ sub: 307, role: 'proveedor' });
    titular(307, 'proveedor');
    const r = await patch(await buildApp(), 307, token);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });

  it('AC7: SIN enlace y CON `cambiar_ajena` cambia la de otro → 200, sin pedir la actual', async () => {
    const token = await testToken({ sub: 308, role: 'financiera', funciones: ['usuarios.contrasena.cambiar_ajena'] });
    titular(9, 'financiera');
    argonVerifyMock.mockReset();
    const r = await patch(await buildApp(), 9, token);
    expect(r.status).toBe(200);
    expect(argonVerifyMock).not.toHaveBeenCalled();
  });

  it('AC7: SIN enlace y SIN `cambiar_ajena` sobre otro id → 403, clave intacta', async () => {
    const token = await testToken({ sub: 309, role: 'financiera', funciones: ['pagina.perfil'] });
    const r = await patch(await buildApp(), 9, token);
    expect(r.status).toBe(403);
    claveIntacta();
  });
});

describe('D2 — `passwordChangeLimiter`: freno por USUARIO autenticado', () => {
  it('el 11.º intento en la ventana → 429 sin tocar la clave; otro usuario no comparte el contador', async () => {
    const app = await buildApp();
    const token = await testToken({ sub: 320, role: 'cliente', funciones: ['pagina.perfil'] });
    for (let i = 0; i < 10; i += 1) {
      const r = await patch(app, 320, token, { currentPassword: 'x', newPassword: 'corta' });
      expect(r.status, `intento ${i + 1}`).toBe(400);
    }
    const bloqueado = await patch(app, 320, token);
    expect(bloqueado.status).toBe(429);
    expect(bloqueado.body.error).toMatch(/Demasiados intentos de cambio de contraseña/);
    claveIntacta();
    // Misma IP (supertest), otro usuario: no hereda el freno.
    const otro = await testToken({ sub: 321, role: 'cliente', funciones: ['pagina.perfil'] });
    const r = await patch(app, 321, otro, { currentPassword: 'x', newPassword: 'corta' });
    expect(r.status).toBe(400);
  });
});
