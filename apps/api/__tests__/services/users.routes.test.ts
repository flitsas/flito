import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock,
    insert: insertMock,
    update: updateMock,
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const argonHashMock = vi.fn();
const argonVerifyMock = vi.fn();
vi.mock('argon2', () => ({
  default: { hash: argonHashMock, verify: argonVerifyMock },
  hash: argonHashMock,
  verify: argonVerifyMock,
}));

const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({
  audit: auditMock,
}));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

beforeEach(() => {
  selectMock.mockReset();
  insertMock.mockReset();
  updateMock.mockReset();
  argonHashMock.mockReset().mockResolvedValue('HASHED');
  argonVerifyMock.mockReset();
  auditMock.mockClear();
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/users/users.routes.js');
  app.use('/api/users', router);
  return app;
}

const STRONG_PWD = 'Aa1!aaaa'; // mín 8, mayús, minús, dígito, especial

describe('PATCH /:id/password — cambio de contraseña', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).patch('/api/users/1/password')
      .send({ currentPassword: 'x', newPassword: STRONG_PWD });
    expect(r.status).toBe(401);
  });

  it('id no numérico → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/users/abc/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'x', newPassword: STRONG_PWD });
    expect(r.status).toBe(400);
  });

  it('user no-admin intenta cambiar password de OTRO → 403', async () => {
    const token = await testToken({ sub: 5, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).patch('/api/users/9/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'x', newPassword: STRONG_PWD });
    expect(r.status).toBe(403);
  });

  it('newPassword sin mayúscula → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/users/1/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'x', newPassword: 'aa1!aaaa' });
    expect(r.status).toBe(400);
  });

  it('newPassword < 8 chars → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/users/1/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'x', newPassword: 'A1!a' });
    expect(r.status).toBe(400);
  });

  it('user no existe → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/users/999/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'x', newPassword: STRONG_PWD });
    expect(r.status).toBe(404);
  });

  it('cambio propio: argon2.verify de currentPassword falla → 401', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 1, passwordHash: 'oldhash', role: 'admin', active: true,
    }]));
    argonVerifyMock.mockResolvedValueOnce(false);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/users/1/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'mala', newPassword: STRONG_PWD });
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/contraseña actual/i);
  });

  it('cambio propio: success → hash + update + audit', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 1, passwordHash: 'oldhash', role: 'admin', active: true,
    }]));
    argonVerifyMock.mockResolvedValueOnce(true);
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => Promise.resolve(undefined) }),
    });

    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/users/1/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'OK', newPassword: STRONG_PWD });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(argonHashMock).toHaveBeenCalledWith(STRONG_PWD);
    expect(auditMock).toHaveBeenCalled();
  });

  it('admin cambia password de OTRO: NO requiere currentPassword (no llama verify)', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 9, passwordHash: 'hold', role: 'proveedor', active: true,
    }]));
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => Promise.resolve(undefined) }),
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/users/9/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'irrelevant', newPassword: STRONG_PWD });
    expect(r.status).toBe(200);
    expect(argonVerifyMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/users — listar (solo admin)', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/users');
    expect(r.status).toBe(401);
  });

  it('proveedor → 403 (requireRole admin)', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).get('/api/users').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });

  it('admin → 200 con lista + audit export', async () => {
    selectMock.mockReturnValueOnce(chain([
      { id: 1, username: 'admin', name: 'A', email: null, role: 'admin', active: true, allowedPages: null, createdAt: new Date() },
      { id: 2, username: 'prov', name: 'P', email: 'p@x.com', role: 'proveedor', active: true, allowedPages: [], createdAt: new Date() },
    ]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/users').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(2);
    expect(auditMock.mock.calls[0][1].action).toBe('export');
  });
});

describe('POST /api/users — crear', () => {
  const VALID_BODY = {
    username: 'nuevo_user', name: 'Nuevo', email: 'n@x.com',
    password: STRONG_PWD, role: 'proveedor', allowedPages: [],
  };

  it('username con caracteres inválidos (espacios) → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/users').set('Authorization', `Bearer ${token}`)
      .send({ ...VALID_BODY, username: 'con espacios' });
    expect(r.status).toBe(400);
  });

  it('rol fuera del enum → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/users').set('Authorization', `Bearer ${token}`)
      .send({ ...VALID_BODY, role: 'superuser' });
    expect(r.status).toBe(400);
  });

  it('rol auditor → 201 (USR-2: auditor ahora asignable vía ALL_ROLES)', async () => {
    selectMock.mockReturnValueOnce(chain([])); // no existe previo
    let captured: any = null;
    insertMock.mockReturnValueOnce({
      values: (v: any) => {
        captured = v;
        return { returning: () => Promise.resolve([{ id: 77, ...v, active: true, createdAt: new Date() }]) };
      },
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/users').set('Authorization', `Bearer ${token}`)
      .send({ ...VALID_BODY, username: 'auditor1', role: 'auditor' });
    expect(r.status).toBe(201);
    expect(captured.role).toBe('auditor');
  });

  it('username ya existe → 409', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 5 }])); // ya existe
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/users').set('Authorization', `Bearer ${token}`).send(VALID_BODY);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/ya registrado/i);
  });

  it('éxito → 201 + hash + audit + email vacío convertido a undefined', async () => {
    selectMock.mockReturnValueOnce(chain([])); // no existe previo
    let capturedValues: any = null;
    insertMock.mockReturnValueOnce({
      values: (v: any) => {
        capturedValues = v;
        return { returning: () => Promise.resolve([{ id: 99, ...v, allowedPages: v.allowedPages, active: true, createdAt: new Date() }]) };
      },
    });

    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/users').set('Authorization', `Bearer ${token}`)
      .send({ ...VALID_BODY, email: '' });
    expect(r.status).toBe(201);
    expect(r.body.id).toBe(99);
    expect(argonHashMock).toHaveBeenCalledWith(STRONG_PWD);
    expect(capturedValues.passwordHash).toBe('HASHED');
    expect(capturedValues.email).toBeNull(); // empty string → null
    expect(capturedValues.allowedPages).toEqual([]);
    expect(auditMock.mock.calls[0][1].action).toBe('create');
  });
});

describe('PATCH /api/users/:id — editar', () => {
  it('id no numérico → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/users/abc').set('Authorization', `Bearer ${token}`)
      .send({ name: 'X' });
    expect(r.status).toBe(400);
  });

  it('user no existe → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/users/9').set('Authorization', `Bearer ${token}`)
      .send({ name: 'X' });
    expect(r.status).toBe(404);
  });

  it('body sin cambios → 400', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, role: 'admin', active: true }]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/users/1').set('Authorization', `Bearer ${token}`).send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/sin cambios/i);
  });

  it('degradar último admin → 409 (guard de safety)', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, role: 'admin', active: true }])); // before
    selectMock.mockReturnValueOnce(chain([{ count: 0 }])); // no hay otro admin activo
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/users/1').set('Authorization', `Bearer ${token}`)
      .send({ role: 'proveedor' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/último admin/i);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('degradar admin cuando hay OTRO admin activo → 200', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, role: 'admin', active: true }]));
    selectMock.mockReturnValueOnce(chain([{ count: 1 }])); // hay otro admin
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 1, role: 'proveedor', name: 'A', username: 'a', email: null, active: true, allowedPages: null, createdAt: new Date() }]) }) }),
    });

    const token = await testToken({ sub: 99, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/users/1').set('Authorization', `Bearer ${token}`)
      .send({ role: 'proveedor' });
    expect(r.status).toBe(200);
    expect(r.body.role).toBe('proveedor');
    expect(auditMock.mock.calls[0][1].detail).toContain('admin→proveedor');
  });

  it('actualizar solo nombre → 200 sin guard de admin', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 5, role: 'proveedor', active: true }]));
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 5, name: 'Nuevo', username: 'p', email: null, role: 'proveedor', active: true, allowedPages: null, createdAt: new Date() }]) }) }),
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/users/5').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Nuevo' });
    expect(r.status).toBe(200);
  });
});

describe('PATCH /:id/toggle — activar/desactivar', () => {
  it('admin intenta desactivarse a sí mismo → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/users/1/toggle').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/sí mismo/i);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('user no existe → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/users/9/toggle').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
  });

  it('desactivar último admin activo → 409', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 9, role: 'admin', active: true }]));
    selectMock.mockReturnValueOnce(chain([{ count: 0 }]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/users/9/toggle').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(409);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('desactivar admin cuando hay otro activo → 200', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 9, role: 'admin', active: true }]));
    selectMock.mockReturnValueOnce(chain([{ count: 2 }]));
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 9, active: false, name: 'A', username: 'a', email: null, role: 'admin', allowedPages: null, createdAt: new Date() }]) }) }),
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/users/9/toggle').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.active).toBe(false);
    expect(auditMock.mock.calls[0][1].detail).toContain('activo → inactivo');
  });

  it('reactivar (proveedor inactivo): no toca guard de admin', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 5, role: 'proveedor', active: false }]));
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 5, active: true, name: 'P', username: 'p', email: null, role: 'proveedor', allowedPages: null, createdAt: new Date() }]) }) }),
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/users/5/toggle').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.active).toBe(true);
  });
});
