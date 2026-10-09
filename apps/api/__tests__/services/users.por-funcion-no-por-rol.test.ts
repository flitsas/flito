// HU #13425 (Feature #13414) — AC2: `users/` decide por FUNCIÓN, nunca por el nombre del rol. Un
// usuario cuyo rol se LLAMA `admin` pero no tiene la función correspondiente recibe 403 al crear un
// usuario, al asignar un rol y al cambiar la contraseña de otro; y un rol con cualquier otro nombre
// que sí tiene la función pasa. `authMiddleware`, `exigirFuncion` y `tieneFuncion` son los de verdad,
// sobre el double de permisos de `helpers/auth.ts`.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken, registrarUsuarioDePrueba } from '../helpers/auth.js';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const transactionMock = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: insertMock, update: updateMock, delete: vi.fn(), transaction: transactionMock, execute: vi.fn() },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
const argonHashMock = vi.fn().mockResolvedValue('HASH-NUEVO');
vi.mock('argon2', () => ({ default: { hash: argonHashMock, verify: vi.fn() }, hash: argonHashMock, verify: vi.fn() }));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const STRONG_PWD = 'Aa1!aaaa';

beforeEach(() => {
  selectMock.mockReset();
  insertMock.mockReset().mockReturnValue(chain([]));
  updateMock.mockReset().mockReturnValue(chain([]));
  argonHashMock.mockClear();
  transactionMock.mockReset().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    insert: () => ({ values: () => Promise.resolve() }),
  }));
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/users/users.routes.js');
  app.use('/api/users', router);
  return app;
}

/** Token de `sub` con un rol de ESE nombre y SOLO esas funciones (el registro se fija tras firmar). */
async function sesion(sub: number, rol: string, funciones: string[]): Promise<string> {
  const token = await testToken({ sub, role: 'admin' });
  await registrarUsuarioDePrueba(sub, { rol, tipoEnlace: 'ninguno', funcionesDelRol: funciones, excepciones: [] });
  return `Bearer ${token}`;
}

const noTocaNada = () => {
  expect(selectMock).not.toHaveBeenCalled();
  expect(insertMock).not.toHaveBeenCalled();
  expect(transactionMock).not.toHaveBeenCalled();
  expect(argonHashMock).not.toHaveBeenCalled();
};

describe('HU #13425 AC2 — un rol LLAMADO admin sin la función → 403', () => {
  const SIN_USUARIOS = ['pagina.usuarios', 'pagina.perfil']; // ve la pantalla, sin operaciones de usuarios

  it('crear usuario sin `usuarios.usuario.crear` → 403', async () => {
    const auth = await sesion(401, 'admin', SIN_USUARIOS);
    const r = await request(await buildApp()).post('/api/users').set('Authorization', auth)
      .send({ username: 'nuevo', name: 'Nuevo', password: STRONG_PWD, role: 'auditor' });
    expect(r.status).toBe(403);
    noTocaNada();
  });

  it('asignar rol (PATCH /:id con `role`) sin `usuarios.usuario.editar` → 403', async () => {
    const auth = await sesion(402, 'admin', SIN_USUARIOS);
    const r = await request(await buildApp()).patch('/api/users/9').set('Authorization', auth).send({ role: 'auditor' });
    expect(r.status).toBe(403);
    noTocaNada();
  });

  it('contraseña AJENA sin `usuarios.contrasena.cambiar_ajena` → 403 `Sin permisos`', async () => {
    const auth = await sesion(403, 'admin', SIN_USUARIOS);
    const r = await request(await buildApp()).patch('/api/users/9/password').set('Authorization', auth)
      .send({ currentPassword: 'x', newPassword: STRONG_PWD });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'Sin permisos' });
    noTocaNada();
  });
});

describe('HU #13425 AC2/AC7 — otro nombre de rol con la función → pasa', () => {
  it('rol `gestor_personas` con `usuarios.contrasena.cambiar_ajena` cambia la contraseña ajena → 200', async () => {
    const auth = await sesion(404, 'gestor_personas', ['usuarios.contrasena.cambiar_ajena']);
    selectMock.mockReturnValueOnce(chain([{ id: 9, passwordHash: 'h', role: 'auditor', active: true, deletedAt: null }]));
    const r = await request(await buildApp()).patch('/api/users/9/password').set('Authorization', auth)
      .send({ currentPassword: 'x', newPassword: STRONG_PWD });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });
});
