import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { getTableName } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const deleteMock = vi.fn();
const transactionMock = vi.fn();

/**
 * El objeto `db` se declara aparte porque `db.transaction` ejecuta el callback contra ESTE MISMO
 * mock (HU #12053): el alta y la edición escriben en `users` y en `flito_gestor_organismos` dentro
 * de una transacción, y con un `tx` distinto los asertos sobre `insertMock`/`deleteMock` no verían
 * nada de lo que pasa dentro.
 */
const dbMock = {
  select: selectMock,
  insert: insertMock,
  update: updateMock,
  delete: deleteMock,
  transaction: transactionMock,
  execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
};

vi.mock('../../src/db/client.js', () => ({
  db: dbMock,
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

/**
 * AC4 tiene DOS mitades y esta es la segunda: `session_invalidated_at` en la fila (que se afirma
 * sobre el `set` capturado) y el purgado de la caché de sesiones. El módulo se envuelve —no se
 * sustituye— para que `authMiddleware` y `requireRole` sigan siendo los de verdad: con un
 * `authMiddleware` de mentira, todos los 401/403 de este archivo dejarían de probar nada.
 */
const invalidarCacheMock = vi.fn();
vi.mock('../../src/shared/middleware/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/middleware/auth.js')>();
  return { ...actual, invalidateSessionCacheFor: (id: number) => invalidarCacheMock(id) };
});

// ── Mocks que RESPETAN la proyección ─────────────────────────────────────────────────────────────
//
// El `chain` de los helpers devuelve la fila ENTERA aunque el `select`/`returning` pidiera menos, así
// que un aserto del tipo «`userSelect` trae `flitoProveedorSoatId`» pasa en verde SIN el cambio de
// producción. Estos mocks proyectan de verdad: lo que no está en la proyección no sale.

/** Deja de la fila solo las claves de la proyección; lo que no está en la fila sale `null`. */
function proyectar(fila: Record<string, unknown>, sel: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(sel)) out[k] = fila[k] ?? null;
  return out;
}

const nombreTabla = (t: unknown): string => { try { return getTableName(t as never); } catch { return '__expr__'; } };
const render = (cond: unknown): { sql: string; params: unknown[] } => {
  const q = new PgDialect().sqlToQuery(cond as never);
  return { sql: q.sql, params: q.params as unknown[] };
};

/** Lo que se escribió, por tabla: `insert`/`delete` comparten mock y hay DOS tablas en juego. */
const escrituras: { tabla: string; valores: unknown }[] = [];
const borrados: { tabla: string; where: unknown }[] = [];

/** Filas que devuelve el `returning` del INSERT de `users`, sobre las que se aplica la proyección. */
let filaInsertada: Record<string, unknown> = {};

function insertPorDefecto(tabla: unknown): Record<string, unknown> {
  const nombre = nombreTabla(tabla);
  const t: Record<string, unknown> = {
    values: (v: unknown) => { escrituras.push({ tabla: nombre, valores: v }); filaInsertada = { id: 99, ...(v as object) }; return t; },
    onConflictDoNothing: () => t,
    returning: (sel: Record<string, unknown>) => Promise.resolve([proyectar(filaInsertada, sel)]),
    then: (res: (v: unknown) => unknown) => Promise.resolve([]).then(res),
  };
  return t;
}

function deletePorDefecto(tabla: unknown): Record<string, unknown> {
  const nombre = nombreTabla(tabla);
  return { where: (c: unknown) => { borrados.push({ tabla: nombre, where: c }); return chain([]); } };
}

/** UPDATE que proyecta el `returning` sobre `fila` + lo que el handler acaba de poner en el `set`. */
function updateProyectado(fila: Record<string, unknown>, capturar: (v: Record<string, unknown>) => void) {
  return {
    set: (v: Record<string, unknown>) => {
      capturar(v);
      return { where: () => ({ returning: (sel: Record<string, unknown>) => Promise.resolve([proyectar({ ...fila, ...v }, sel)]) }) };
    },
  };
}

beforeEach(() => {
  selectMock.mockReset();
  insertMock.mockReset();
  updateMock.mockReset();
  deleteMock.mockReset().mockImplementation(deletePorDefecto);
  transactionMock.mockReset().mockImplementation(async (cb: (tx: unknown) => unknown) => cb(dbMock));
  insertMock.mockImplementation(insertPorDefecto);
  invalidarCacheMock.mockReset();
  escrituras.length = 0;
  borrados.length = 0;
  filaInsertada = {};
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

// HU #12053 — las dos ataduras de ámbito. Un `proveedor` SIN proveedor SOAT y un `gestor_impuestos`
// SIN organismos son, desde esta HU, usuarios que la API declara imposibles (AC3): los cuerpos de
// los casos que no van de eso tienen que traerlas o el 400 llega por el motivo equivocado.
const PROVEEDOR = '11111111-2222-3333-4444-555555555555';
const ORG_A = '05001';
const ORG_B = '05266';

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
    selectMock.mockReturnValueOnce(chain([])); // los organismos de la página (HU #12053)
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
    flitoProveedorSoatId: PROVEEDOR,
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
      // Sin `flitoProveedorSoatId`: el ámbito del proveedor SOBRA en cualquier otro rol (AC3).
      .send({ ...VALID_BODY, username: 'auditor1', role: 'auditor', flitoProveedorSoatId: undefined });
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
    selectMock.mockReturnValueOnce(chain([{ id: PROVEEDOR }])); // el proveedor SOAT existe
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
    selectMock.mockReturnValueOnce(chain([])); // organismos del usuario (HU #12053)
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
    selectMock.mockReturnValueOnce(chain([])); // organismos del usuario (HU #12053)
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 1, role: 'auditor', name: 'A', username: 'a', email: null, active: true, allowedPages: null, createdAt: new Date() }]) }) }),
    });

    const token = await testToken({ sub: 99, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/users/1').set('Authorization', `Bearer ${token}`)
      .send({ role: 'auditor' });
    expect(r.status).toBe(200);
    expect(r.body.role).toBe('auditor');
    expect(auditMock.mock.calls[0][1].detail).toContain('admin→auditor');
  });

  it('actualizar solo nombre → 200 sin guard de admin', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 5, role: 'proveedor', active: true, flitoProveedorSoatId: PROVEEDOR }]));
    selectMock.mockReturnValueOnce(chain([])); // organismos del usuario (HU #12053)
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
    selectMock.mockReturnValueOnce(chain([])); // organismos del usuario (HU #12053)
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
    selectMock.mockReturnValueOnce(chain([])); // organismos del usuario (HU #12053)
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

// ─────────── HU #11913 (Feature #11912): rol `cliente` y compañía obligatoria ───────────
//
// El AC2 —«no queda un usuario cliente usable»— se sostiene en TRES capas: la de Zod que se prueba
// aquí, el CHECK `users_cliente_compania_chk` de la migración 0168, y el `return null` de
// `contextoSoat()` (probado en flito-soat.cliente-aislamiento.test.ts). Las tres hacen falta: esta
// es la única que produce el mensaje que el admin lee, y la única que NO protege a un seed ni a un
// `psql` de soporte.
describe('POST /api/users — rol cliente y compañía (AC1/AC2 de la HU #11913)', () => {
  const BODY_CLIENTE = {
    username: 'cliente_uno', name: 'Cliente Uno', email: 'c@x.com',
    password: STRONG_PWD, role: 'cliente', allowedPages: [],
  };

  it('rol cliente SIN compañía → 400 con el mensaje del copy, y NADA escrito (AC2)', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/users').set('Authorization', `Bearer ${token}`)
      .send(BODY_CLIENTE);
    expect(r.status).toBe(400);
    // El campo importa tanto como el texto: `ApiError.toUserMessage` antepone el nombre del campo,
    // así que el admin lee «companiaId: Compañía requerida para el rol Cliente».
    expect(r.body.details.fieldErrors.companiaId).toContain('Compañía requerida para el rol Cliente');
    // «No queda un usuario cliente usable»: ni siquiera se consultó si el username estaba libre.
    expect(insertMock).not.toHaveBeenCalled();
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('rol cliente CON compañía existente → 201 y la FK queda escrita (AC1)', async () => {
    selectMock.mockReturnValueOnce(chain([]));            // username libre
    selectMock.mockReturnValueOnce(chain([{ id: 3 }]));   // la compañía existe
    let captured: any = null;
    insertMock.mockReturnValueOnce({
      values: (v: any) => {
        captured = v;
        return { returning: () => Promise.resolve([{ id: 80, ...v, active: true, createdAt: new Date() }]) };
      },
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/users').set('Authorization', `Bearer ${token}`)
      .send({ ...BODY_CLIENTE, companiaId: 3 });
    expect(r.status).toBe(201);
    expect(captured.role).toBe('cliente');
    expect(captured.companiaId).toBe(3);
    // El DTO la devuelve: la lista de usuarios necesita poder decir de qué compañía es cada cliente.
    expect(r.body.companiaId).toBe(3);
  });

  it('rol cliente con una compañía que NO existe → 400 y no un 500 de FK', async () => {
    selectMock.mockReturnValueOnce(chain([]));   // username libre
    selectMock.mockReturnValueOnce(chain([]));   // la compañía no está
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/users').set('Authorization', `Bearer ${token}`)
      .send({ ...BODY_CLIENTE, companiaId: 4242 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/no existe/i);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('otro rol CON compañía → 400 (la compañía es del cliente y de nadie más)', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/users').set('Authorization', `Bearer ${token}`)
      .send({ ...BODY_CLIENTE, role: 'proveedor', companiaId: 3 });
    expect(r.status).toBe(400);
    expect(r.body.details.fieldErrors.companiaId)
      .toContain('Solo los usuarios Cliente pueden tener compañía asignada');
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('un rol que no es cliente no arrastra compañía aunque el cuerpo la traiga vacía', async () => {
    selectMock.mockReturnValueOnce(chain([])); // username libre
    selectMock.mockReturnValueOnce(chain([{ id: PROVEEDOR }])); // el proveedor SOAT existe
    let captured: any = null;
    insertMock.mockReturnValueOnce({
      values: (v: any) => {
        captured = v;
        return { returning: () => Promise.resolve([{ id: 81, ...v, active: true, createdAt: new Date() }]) };
      },
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/users').set('Authorization', `Bearer ${token}`)
      .send({ username: 'prov_x', name: 'P', password: STRONG_PWD, role: 'proveedor', flitoProveedorSoatId: PROVEEDOR });
    expect(r.status).toBe(201);
    expect(captured.companiaId).toBeNull();
  });
});

describe('PATCH /api/users/:id — compañía del cliente (AC2 por la puerta de la edición)', () => {
  it('quitarle la compañía a un cliente → 400', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 5, role: 'cliente', active: true, companiaId: 3 }]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/users/5').set('Authorization', `Bearer ${token}`)
      .send({ companiaId: null });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Compañía requerida para el rol Cliente');
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('ASCENDER a cliente sin dar compañía → 400 (el hueco que deja un PATCH de solo rol)', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 5, role: 'proveedor', active: true, companiaId: null }]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/users/5').set('Authorization', `Bearer ${token}`)
      .send({ role: 'cliente' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Compañía requerida para el rol Cliente');
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('cambiar la compañía de un cliente → 200 e INVALIDA sesiones', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 5, role: 'cliente', active: true, companiaId: 3 }]));
    selectMock.mockReturnValueOnce(chain([{ id: 9 }])); // la compañía nueva existe
    selectMock.mockReturnValueOnce(chain([])); // organismos del usuario (HU #12053)
    let capturado: any = null;
    updateMock.mockReturnValueOnce({
      set: (v: any) => { capturado = v; return { where: () => ({ returning: () => Promise.resolve([{ id: 5, role: 'cliente', companiaId: 9, name: 'C', username: 'c', email: null, active: true, allowedPages: [], createdAt: new Date() }]) }) }; },
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/users/5').set('Authorization', `Bearer ${token}`)
      .send({ companiaId: 9 });
    expect(r.status).toBe(200);
    expect(capturado.companiaId).toBe(9);
    // `companiaId` NO viaja en el JWT, pero cambiarla cambia QUÉ VE esa persona: que vuelva a
    // entrar limpia. Es lo que el copy de UX promete al admin en el toast.
    expect(capturado.sessionInvalidatedAt).toBeInstanceOf(Date);
  });

  it('degradar a un cliente le QUITA la compañía (no queda un ámbito colgado)', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 5, role: 'cliente', active: true, companiaId: 3 }]));
    selectMock.mockReturnValueOnce(chain([])); // organismos del usuario (HU #12053)
    let capturado: any = null;
    updateMock.mockReturnValueOnce({
      set: (v: any) => { capturado = v; return { where: () => ({ returning: () => Promise.resolve([{ id: 5, role: 'auditor', companiaId: null, name: 'C', username: 'c', email: null, active: true, allowedPages: [], createdAt: new Date() }]) }) }; },
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/users/5').set('Authorization', `Bearer ${token}`)
      .send({ role: 'auditor' });
    expect(r.status).toBe(200);
    expect(capturado.companiaId).toBeNull();
  });

  it('ponerle compañía a quien no es cliente → 400', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 5, role: 'proveedor', active: true, companiaId: null }]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/users/5').set('Authorization', `Bearer ${token}`)
      .send({ companiaId: 3 });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Solo los usuarios Cliente pueden tener compañía asignada');
    expect(updateMock).not.toHaveBeenCalled();
  });
});

// ───────── HU #12053 (Feature #12052): ámbito del Proveedor y del Gestor de Impuestos ─────────
//
// Paridad deliberada con el bloque de `companiaId` de arriba (HU #11913): son la misma idea —un
// ámbito obligatorio y exclusivo de un rol— y las diferencias que sí importan están aquí:
//
//   · el ámbito del gestor es una LISTA y vive en OTRA TABLA (`flito_gestor_organismos`), así que
//     `organismosCodigos` no puede salir de `userSelect` (`.returning()` no hace join) y se compone;
//   · por eso el alta y la edición son transaccionales, y por eso el AC4 se afirma sobre las DOS
//     mitades: la marca en la fila y el purgado de la caché de sesiones;
//   · y por eso los mocks de este archivo proyectan de verdad: con el `chain` de los helpers, un
//     aserto sobre un campo que `userSelect` NO pide pasaría igual.

const cabecera = async () => `Bearer ${await testToken({ sub: 1, role: 'admin' })}`;

const BODY_PROVEEDOR = {
  username: 'prov_uno', name: 'Proveedor Uno', email: 'p@x.com',
  password: STRONG_PWD, role: 'proveedor', allowedPages: [],
};
const BODY_GESTOR = {
  username: 'gestor_uno', name: 'Gestor Uno', email: 'g@x.com',
  password: STRONG_PWD, role: 'gestor_impuestos', allowedPages: [],
};

const filasDe = (tabla: string) => escrituras.filter((e) => e.tabla === tabla);
const organismosEscritos = () => filasDe('flito_gestor_organismos').flatMap((e) => e.valores as { organismoCodigo: string }[]);

describe('POST /api/users — las dos ataduras al crear (AC1/AC2/AC3)', () => {
  it('TC-12053-01: proveedor CON proveedor SOAT → 201, la FK se escribe y VUELVE en la respuesta', async () => {
    selectMock.mockReturnValueOnce(chain([]));                      // username libre
    selectMock.mockReturnValueOnce(chain([{ id: PROVEEDOR }]));     // el proveedor existe

    const r = await request(await buildApp()).post('/api/users').set('Authorization', await cabecera())
      .send({ ...BODY_PROVEEDOR, flitoProveedorSoatId: PROVEEDOR });

    expect(r.status).toBe(201);
    // Escrita: la columna sale en el INSERT con el valor del cuerpo.
    expect((filasDe('users')[0].valores as Record<string, unknown>).flitoProveedorSoatId).toBe(PROVEEDOR);
    // Y DEVUELTA: el `returning` de este mock respeta la proyección, así que esto solo pasa si
    // `flitoProveedorSoatId` está de verdad en `userSelect` (la celda «Ámbito» del listado lo pinta
    // sin abrir el formulario).
    expect(r.body.flitoProveedorSoatId).toBe(PROVEEDOR);
    // Invariante del contrato: SIEMPRE array, también para quien no es gestor.
    expect(r.body.organismosCodigos).toEqual([]);
  });

  it('TC-12053-02: DOS usuarios con el MISMO proveedor SOAT → los dos 201 (no hay unicidad)', async () => {
    const app = await buildApp();
    const crear = async (username: string) => {
      selectMock.mockReturnValueOnce(chain([]));
      selectMock.mockReturnValueOnce(chain([{ id: PROVEEDOR }]));
      return request(app).post('/api/users').set('Authorization', await cabecera())
        .send({ ...BODY_PROVEEDOR, username, flitoProveedorSoatId: PROVEEDOR });
    };

    const a = await crear('prov_uno');
    const b = await crear('prov_dos');

    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.flitoProveedorSoatId).toBe(PROVEEDOR);
    expect(b.body.flitoProveedorSoatId).toBe(PROVEEDOR);
    // Dos gestores del mismo proveedor es el escenario de CA-04 (toma atómica de la misma cola):
    // que compartan proveedor no es un choque, es el caso de uso.
    expect(filasDe('users')).toHaveLength(2);
  });

  it('TC-12053-05: gestor con DOS organismos → quedan los DOS, y los DOS vuelven', async () => {
    selectMock.mockReturnValueOnce(chain([]));                                  // username libre
    selectMock.mockReturnValueOnce(chain([{ codigo: ORG_A }, { codigo: ORG_B }])); // los dos existen

    const r = await request(await buildApp()).post('/api/users').set('Authorization', await cabecera())
      .send({ ...BODY_GESTOR, organismosCodigos: [ORG_A, ORG_B] });

    expect(r.status).toBe(201);
    expect(organismosEscritos().map((f) => f.organismoCodigo).sort()).toEqual([ORG_A, ORG_B]);
    expect(r.body.organismosCodigos).toEqual([ORG_A, ORG_B]);
    // Su ámbito NO se escribe en `transito_codigo`: esa columna vuelve a ser solo del rol `transito`.
    expect((filasDe('users')[0].valores as Record<string, unknown>).transitoCodigo).toBeNull();
  });

  it('TC-12053-05 (bis): el mismo organismo repetido se DEDUPLICA (la PK compuesta no lo perdona)', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    selectMock.mockReturnValueOnce(chain([{ codigo: ORG_A }]));

    const r = await request(await buildApp()).post('/api/users').set('Authorization', await cabecera())
      .send({ ...BODY_GESTOR, organismosCodigos: [ORG_A, ORG_A] });

    expect(r.status).toBe(201);
    // Sin la deduplicación, esto serían dos filas idénticas y un 23505 servido en un 500.
    expect(organismosEscritos()).toHaveLength(1);
  });

  it('TC-12053-07: un organismo fuera del catálogo PARAMETRIZADO → 400, no un 23503 en un 500', async () => {
    selectMock.mockReturnValueOnce(chain([]));                       // username libre
    selectMock.mockReturnValueOnce(chain([{ codigo: ORG_A }]));      // solo uno de los dos está

    const r = await request(await buildApp()).post('/api/users').set('Authorization', await cabecera())
      // '11001' (Bogotá) SÍ está en el catálogo nacional de shared-types —así que pasa Zod— y NO en
      // `organismos_transito_config`. Ese hueco es justo el que un `isKnownOrganismoCodigo` a secas
      // no cubre, y el que la FK convertiría en un 500 sin mensaje.
      .send({ ...BODY_GESTOR, organismosCodigos: [ORG_A, '11001'] });

    expect(r.status).toBe(400);
    expect(r.body.error).toContain('Alguno de los organismos no existe');
    expect(r.body.error).toContain('11001'); // se NOMBRA el que falta
    expect(escrituras).toHaveLength(0);
  });

  it('TC-12053-08: proveedor SIN proveedor SOAT → 400, y NADA escrito', async () => {
    const r = await request(await buildApp()).post('/api/users').set('Authorization', await cabecera())
      .send(BODY_PROVEEDOR);

    expect(r.status).toBe(400);
    expect(r.body.details.fieldErrors.flitoProveedorSoatId)
      .toContain('Proveedor SOAT requerido para el rol Proveedor');
    // «No queda un usuario proveedor usable»: ni se consultó si el username estaba libre.
    expect(insertMock).not.toHaveBeenCalled();
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('TC-12053-09: gestor SIN ningún organismo → 400, y NADA escrito', async () => {
    const r = await request(await buildApp()).post('/api/users').set('Authorization', await cabecera())
      .send({ ...BODY_GESTOR, organismosCodigos: [] });

    expect(r.status).toBe(400);
    expect(r.body.details.fieldErrors.organismosCodigos)
      .toContain('Organismos requeridos para el rol Gestor de Impuestos');
    expect(insertMock).not.toHaveBeenCalled();
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('TC-12053-09 (bis): el gestor que ni menciona el campo también es 400', async () => {
    const r = await request(await buildApp()).post('/api/users').set('Authorization', await cabecera())
      .send(BODY_GESTOR);

    expect(r.status).toBe(400);
    expect(r.body.details.fieldErrors.organismosCodigos)
      .toContain('Organismos requeridos para el rol Gestor de Impuestos');
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('TC-12053-11: ámbito de MÁS → 400 (simetría exacta con la compañía del cliente)', async () => {
    const app = await buildApp();

    const conProveedor = await request(app).post('/api/users').set('Authorization', await cabecera())
      .send({ ...BODY_GESTOR, organismosCodigos: [ORG_A], flitoProveedorSoatId: PROVEEDOR });
    expect(conProveedor.status).toBe(400);
    expect(conProveedor.body.details.fieldErrors.flitoProveedorSoatId)
      .toContain('Solo los usuarios Proveedor pueden tener proveedor SOAT asignado');

    const conOrganismos = await request(app).post('/api/users').set('Authorization', await cabecera())
      .send({ ...BODY_PROVEEDOR, flitoProveedorSoatId: PROVEEDOR, organismosCodigos: [ORG_A] });
    expect(conOrganismos.status).toBe(400);
    expect(conOrganismos.body.details.fieldErrors.organismosCodigos)
      .toContain('Solo los usuarios Gestor de Impuestos pueden tener organismos asignados');

    expect(insertMock).not.toHaveBeenCalled();
  });

  it('TC-12053-12: proveedor SOAT inexistente (llamada directa a la API) → 400 y no un 500 de FK', async () => {
    selectMock.mockReturnValueOnce(chain([]));   // username libre
    selectMock.mockReturnValueOnce(chain([]));   // el proveedor no está

    const r = await request(await buildApp()).post('/api/users').set('Authorization', await cabecera())
      .send({ ...BODY_PROVEEDOR, flitoProveedorSoatId: '99999999-9999-4999-8999-999999999999' });

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('El proveedor SOAT no existe');
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('TC-12053-12 (contraparte): un proveedor INACTIVO que existe se acepta — el filtro de activos es del front', async () => {
    // Decisión 9 de UX, deliberada y escrita en el contrato §3: el backend acepta lo que EXISTE. Si
    // rechazara los inactivos, editarle el nombre a un usuario atado a un proveedor desactivado
    // fallaría por un campo que el admin no tocó, y guardar le desharía la atadura.
    selectMock.mockReturnValueOnce(chain([]));
    selectMock.mockReturnValueOnce(chain([{ id: PROVEEDOR }])); // existe (activo=false, no se mira)

    const r = await request(await buildApp()).post('/api/users').set('Authorization', await cabecera())
      .send({ ...BODY_PROVEEDOR, flitoProveedorSoatId: PROVEEDOR });

    expect(r.status).toBe(201);
  });
});

describe('PATCH /api/users/:id — editar el ámbito (AC3/AC4)', () => {
  const GESTOR_BEFORE = { id: 5, role: 'gestor_impuestos', active: true, companiaId: null, flitoProveedorSoatId: null };

  it('TC-12053-13: cambiar SOLO los organismos invalida las sesiones (fila + caché)', async () => {
    selectMock.mockReturnValueOnce(chain([GESTOR_BEFORE]));                      // before
    selectMock.mockReturnValueOnce(chain([{ codigo: ORG_A }, { codigo: ORG_B }])); // existen los dos
    selectMock.mockReturnValueOnce(chain([{ codigo: ORG_A }]));                  // anteriores (en la tx)
    let capturado: Record<string, unknown> = {};
    updateMock.mockReturnValueOnce(updateProyectado(
      { id: 5, role: 'gestor_impuestos', name: 'G', username: 'g', email: null, active: true, allowedPages: [], createdAt: new Date() },
      (v) => { capturado = v; },
    ));

    const r = await request(await buildApp()).patch('/api/users/5').set('Authorization', await cabecera())
      .send({ organismosCodigos: [ORG_A, ORG_B] });

    expect(r.status).toBe(200);
    // Ninguna columna de `users` cambia: es la propia marca la que mantiene el UPDATE no vacío.
    expect(capturado.sessionInvalidatedAt).toBeInstanceOf(Date);
    expect(Object.keys(capturado)).toEqual(['sessionInvalidatedAt']);
    // La otra mitad del AC4: la caché de sesiones, purgada DESPUÉS del commit.
    expect(invalidarCacheMock).toHaveBeenCalledWith(5);
    expect(r.body.organismosCodigos).toEqual([ORG_A, ORG_B]);
  });

  it('TC-12053-13 (bis): reenviar EL MISMO conjunto en otro orden NO es un cambio → 400 Sin cambios', async () => {
    selectMock.mockReturnValueOnce(chain([GESTOR_BEFORE]));
    selectMock.mockReturnValueOnce(chain([{ codigo: ORG_A }, { codigo: ORG_B }]));
    selectMock.mockReturnValueOnce(chain([{ codigo: ORG_B }, { codigo: ORG_A }])); // anteriores

    const r = await request(await buildApp()).patch('/api/users/5').set('Authorization', await cabecera())
      .send({ organismosCodigos: [ORG_A, ORG_B] });

    // Conjuntos, no arrays: el orden no invalida la sesión de nadie.
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/sin cambios/i);
    expect(updateMock).not.toHaveBeenCalled();
    expect(invalidarCacheMock).not.toHaveBeenCalled();
  });

  it('TC-12053-14: el conjunto se REEMPLAZA, no se une', async () => {
    selectMock.mockReturnValueOnce(chain([GESTOR_BEFORE]));
    selectMock.mockReturnValueOnce(chain([{ codigo: ORG_B }]));                   // existe
    selectMock.mockReturnValueOnce(chain([{ codigo: ORG_A }, { codigo: ORG_B }])); // anteriores: DOS
    updateMock.mockReturnValueOnce(updateProyectado(
      { id: 5, role: 'gestor_impuestos', name: 'G', username: 'g', email: null, active: true, allowedPages: [], createdAt: new Date() },
      () => { /* el `set` no importa aquí */ },
    ));

    const r = await request(await buildApp()).patch('/api/users/5').set('Authorization', await cabecera())
      .send({ organismosCodigos: [ORG_B] });

    expect(r.status).toBe(200);
    // Lo que sobra se BORRA. El `NOT IN` es lo que distingue «reemplazar» de «añadir»: sin él, el
    // gestor conservaría para siempre el primer organismo que le dieron.
    const borrado = borrados.find((b) => b.tabla === 'flito_gestor_organismos');
    expect(borrado, 'el DELETE de los organismos que sobran').toBeDefined();
    const { sql, params } = render(borrado!.where);
    expect(sql.toLowerCase()).toContain('not in');
    expect(params).toContain(ORG_B);   // los que se quedan son los EXCLUIDOS del borrado
    expect(params).toContain(5);
    // Y la respuesta trae el conjunto nuevo, no la unión.
    expect(r.body.organismosCodigos).toEqual([ORG_B]);
  });

  it('TC-12053-15: `organismosCodigos: []` sobre un gestor → 400 (quitarle el ámbito no es editar)', async () => {
    selectMock.mockReturnValueOnce(chain([GESTOR_BEFORE]));

    const r = await request(await buildApp()).patch('/api/users/5').set('Authorization', await cabecera())
      .send({ organismosCodigos: [] });

    // Paridad exacta con «quitarle la compañía a un cliente»: el ámbito vacío deja un usuario que no
    // ve nada, que es justo lo que el AC3 declara imposible.
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Organismos requeridos para el rol Gestor de Impuestos');
    expect(updateMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('TC-12053-15 (bis): ASCENDER a gestor sin traer organismos ni tenerlos → 400', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 5, role: 'auditor', active: true, companiaId: null, flitoProveedorSoatId: null }]));
    selectMock.mockReturnValueOnce(chain([])); // no tenía ninguno

    const r = await request(await buildApp()).patch('/api/users/5').set('Authorization', await cabecera())
      .send({ role: 'gestor_impuestos' });

    // El hueco que deja un PATCH de solo rol: sin esta guarda queda un gestor sin ámbito.
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Organismos requeridos para el rol Gestor de Impuestos');
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('TC-12053-16: degradar a un gestor le QUITA todos los organismos', async () => {
    selectMock.mockReturnValueOnce(chain([GESTOR_BEFORE]));
    selectMock.mockReturnValueOnce(chain([{ codigo: ORG_A }, { codigo: ORG_B }])); // anteriores (tx)
    updateMock.mockReturnValueOnce(updateProyectado(
      { id: 5, role: 'auditor', name: 'G', username: 'g', email: null, active: true, allowedPages: [], createdAt: new Date() },
      () => { /* — */ },
    ));

    const r = await request(await buildApp()).patch('/api/users/5').set('Authorization', await cabecera())
      .send({ role: 'auditor' });

    expect(r.status).toBe(200);
    const borrado = borrados.find((b) => b.tabla === 'flito_gestor_organismos');
    expect(borrado, 'el DELETE de TODAS sus filas').toBeDefined();
    // Sin `NOT IN`: aquí se van todas, no «las que sobran».
    expect(render(borrado!.where).sql.toLowerCase()).not.toContain('not in');
    expect(r.body.organismosCodigos).toEqual([]);
    expect(invalidarCacheMock).toHaveBeenCalledWith(5);
  });

  it('TC-12053-16 (bis): degradar a un proveedor le QUITA el proveedor SOAT', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 6, role: 'proveedor', active: true, companiaId: null, flitoProveedorSoatId: PROVEEDOR }]));
    selectMock.mockReturnValueOnce(chain([])); // anteriores (tx): ninguno
    let capturado: Record<string, unknown> = {};
    updateMock.mockReturnValueOnce(updateProyectado(
      { id: 6, role: 'auditor', name: 'P', username: 'p', email: null, active: true, allowedPages: [], createdAt: new Date() },
      (v) => { capturado = v; },
    ));

    const r = await request(await buildApp()).patch('/api/users/6').set('Authorization', await cabecera())
      .send({ role: 'auditor' });

    expect(r.status).toBe(200);
    expect(capturado.flitoProveedorSoatId).toBeNull();
    expect(r.body.flitoProveedorSoatId).toBeNull();
  });

  it('TC-12053-11 (edición): ponerle organismos a quien no es gestor → 400', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 5, role: 'auditor', active: true, companiaId: null, flitoProveedorSoatId: null }]));

    const r = await request(await buildApp()).patch('/api/users/5').set('Authorization', await cabecera())
      .send({ organismosCodigos: [ORG_A] });

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Solo los usuarios Gestor de Impuestos pueden tener organismos asignados');
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/users — el listado trae las DOS ataduras (AC5)', () => {
  it('TC-12053-18: cada fila sale con su proveedor y sus organismos, y `[]` cuando no aplica', async () => {
    const filas = [
      { id: 3, username: 'prov', name: 'P', email: null, role: 'proveedor', active: true, allowedPages: [], transitoCodigo: null, companiaId: null, flitoProveedorSoatId: PROVEEDOR, createdAt: new Date() },
      { id: 5, username: 'gestor', name: 'G', email: null, role: 'gestor_impuestos', active: true, allowedPages: [], transitoCodigo: null, companiaId: null, flitoProveedorSoatId: null, createdAt: new Date() },
    ];
    // Proyectado: si `flitoProveedorSoatId` no estuviera en `userSelect`, no llegaría a la respuesta.
    selectMock.mockImplementationOnce((sel: Record<string, unknown>) => chain(filas.map((f) => proyectar(f, sel))));
    selectMock.mockReturnValueOnce(chain([
      { userId: 5, codigo: ORG_B },
      { userId: 5, codigo: ORG_A },
    ]));

    const r = await request(await buildApp()).get('/api/users').set('Authorization', await cabecera());

    expect(r.status).toBe(200);
    expect(r.body[0].flitoProveedorSoatId).toBe(PROVEEDOR);
    // Invariante del contrato: SIEMPRE un array. Nunca `null`, nunca ausente — así el front no
    // escribe `?? []` en ningún sitio.
    expect(r.body[0].organismosCodigos).toEqual([]);
    expect(r.body[1].organismosCodigos).toEqual([ORG_A, ORG_B]);
    // Una sola consulta más para TODA la página, no una por fila.
    expect(selectMock).toHaveBeenCalledTimes(2);
  });

  it('TC-12053-18 (bis): el toggle NO borra la lista de la fila al refrescar', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 5, role: 'gestor_impuestos', active: true }]));
    selectMock.mockReturnValueOnce(chain([{ codigo: ORG_A }, { codigo: ORG_B }])); // se LEEN
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: (sel: Record<string, unknown>) => Promise.resolve([proyectar(
        { id: 5, username: 'g', name: 'G', email: null, role: 'gestor_impuestos', active: false, allowedPages: [], transitoCodigo: null, companiaId: null, flitoProveedorSoatId: null, createdAt: new Date() },
        sel,
      )]) }) }),
    });

    const r = await request(await buildApp()).patch('/api/users/5/toggle').set('Authorization', await cabecera());

    expect(r.status).toBe(200);
    // Devolver `[]` aquí haría que el front vaciara la celda «Ámbito» con solo desactivar al gestor.
    expect(r.body.organismosCodigos).toEqual([ORG_A, ORG_B]);
  });
});
