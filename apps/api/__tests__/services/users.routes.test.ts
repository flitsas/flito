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

/**
 * HU #12169 (AC6) — `rolAsignable()` pregunta a la tabla `permisos_roles`, y esa consulta NO puede
 * entrar en la cola posicional de `selectMock`: cada `mockReturnValueOnce` de este archivo está
 * casado con una consulta concreta del handler, y meter una más al principio del alta desplazaría la
 * cola de la veintena larga de casos que ya existen. Se envuelve el SERVICIO —no se sustituye— con
 * `importOriginal`, igual que arriba con `auth`: `crearUsuario`, `actualizarUsuario` y las lecturas
 * de organismos siguen siendo las de verdad, que es lo que estos tests prueban.
 *
 * La consulta REAL de `rolAsignable` (qué tabla, con qué condición, y el `activo = true`) se vigila
 * aparte, en `users.rol-asignable.test.ts`. Un mock aquí no podría probarla: probaría el mock.
 */
/**
 * HU #12082 (AC4, TC #12262) — la caché de PERMISOS se invalida DESPUÉS del commit. Se envuelve el
 * módulo —no se sustituye— para que `fijarFuenteDePermisos` siga siendo real: es lo que el helper de
 * tokens usa para que `requireRole`/`requirePage` de este archivo no consuman `selectMock`. La secuencia
 * de eventos (`commit` cuando el callback de la transacción resuelve, `invalidar-permisos` cuando se
 * llama al spy) es lo que fija el orden.
 */
const eventos: string[] = [];
const invalidarPermisosMock = vi.fn((id: number) => { eventos.push(`invalidar-permisos:${id}`); });
vi.mock('../../src/shared/permisos-efectivos.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/permisos-efectivos.js')>();
  return { ...actual, invalidarPermisosDe: (id: number) => invalidarPermisosMock(id) };
});

/**
 * HU #12084 (AC4) — el invariante anti-bloqueo envuelve el `UPDATE` de `cambiarActivo` y el cuerpo de
 * `actualizarUsuario` cuando cambia el rol. Se envuelve el módulo —no se sustituye— con un
 * PASSTHROUGH por defecto: el invariante real hace dos `select` (lock y cuenta) que desordenarían la
 * cola posicional de `selectMock` de la veintena larga de casos de PATCH. Lo que el invariante
 * consulta se prueba en `permisos-anti-bloqueo.test.ts` (SQL real) y en `db/permisos-anti-bloqueo.
 * concurrencia.test.ts` (dos sesiones). Aquí se prueba que las dos rutas LO INVOCAN dentro de su
 * transacción y mapean su excepción a 409 sin confirmar.
 */
const seguroMock = vi.fn(async (_tx: unknown, escritura: () => Promise<unknown>) => escritura());
vi.mock('../../src/shared/permisos-anti-bloqueo.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/permisos-anti-bloqueo.js')>();
  return {
    ...actual,
    conSeguroAntiBloqueo: (tx: unknown, escritura: () => Promise<unknown>, funciones?: readonly string[]) =>
      seguroMock(tx, escritura, funciones),
  };
});

const rolAsignableMock = vi.fn();
vi.mock('../../src/modules/users/users.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/users/users.service.js')>();
  return { ...actual, rolAsignable: (codigo: string) => rolAsignableMock(codigo) };
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
    values: (v: unknown) => {
      escrituras.push({ tabla: nombre, valores: v });
      // El historial (HU #12171) se escribe DENTRO de la transacción: el evento sirve para afirmar el
      // orden «insert auditoría → commit → invalidar». La fila insertada solo la fija el INSERT de `users`.
      if (nombre === 'permisos_auditoria') eventos.push('insert-auditoria');
      else filaInsertada = { id: 99, ...(v as object) };
      return t;
    },
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
  transactionMock.mockReset().mockImplementation(async (cb: (tx: unknown) => unknown) => {
    const r = await cb(dbMock);
    eventos.push('commit');
    return r;
  });
  insertMock.mockImplementation(insertPorDefecto);
  invalidarCacheMock.mockReset().mockImplementation((id: number) => { eventos.push(`invalidar-sesion:${id}`); });
  invalidarPermisosMock.mockClear();
  seguroMock.mockReset().mockImplementation(async (_tx: unknown, escritura: () => Promise<unknown>) => escritura());
  eventos.length = 0;
  escrituras.length = 0;
  borrados.length = 0;
  filaInsertada = {};
  argonHashMock.mockReset().mockResolvedValue('HASHED');
  argonVerifyMock.mockReset();
  auditMock.mockClear();
  // Por defecto, el rol del cuerpo existe y está activo: es el caso de los ~25 tests que ya había y
  // que no van de esto. Los casos del AC6 lo sobrescriben con `mockResolvedValueOnce(null)`.
  rolAsignableMock.mockReset().mockResolvedValue({ tipoEnlace: 'ninguno' });
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

  it('admin → 200 con lista + audit view (HU #12172: listar no es exportar)', async () => {
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
    // Antes de la HU #12172 esto se registraba como `export` SIN generar archivo alguno.
    expect(auditMock.mock.calls[0][1].action).toBe('view');
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
    selectMock.mockReturnValueOnce(chain([{ id: 1, role: 'admin', active: true, allowedPages: [] }])); // antes, dentro de la tx y con FOR UPDATE (HU #12171)
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
    selectMock.mockReturnValueOnce(chain([{ id: 5, role: 'proveedor', active: true, flitoProveedorSoatId: PROVEEDOR }])); // antes, dentro de la tx y con FOR UPDATE (HU #12171)
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

describe('TC #12262 AC4 — caché de 60 s por user_id; la escritura del administrador (usuario o rol) la invalida después del commit y el retiro de acceso marca sessionInvalidatedAt', () => {
  const filaProveedor = { id: 5, role: 'proveedor', active: true, flitoProveedorSoatId: PROVEEDOR };
  const devuelto = { id: 5, name: 'P', username: 'p', email: null, role: 'proveedor', active: true, allowedPages: [], createdAt: new Date() };

  it('PATCH /users/5 que le retira una página: invalidarPermisosDe(5) DESPUÉS del commit, sessionInvalidatedAt marcado e invalidateSessionCacheFor(5)', async () => {
    selectMock.mockReturnValueOnce(chain([{ ...filaProveedor, allowedPages: ['transito'] }]));
    selectMock.mockReturnValueOnce(chain([{ ...filaProveedor, allowedPages: ['transito'] }])); // antes, dentro de la tx y con FOR UPDATE (HU #12171)
    selectMock.mockReturnValueOnce(chain([])); // organismos del usuario (HU #12053)
    let capturado: any = null;
    updateMock.mockReturnValueOnce({
      set: (v: any) => { capturado = v; return { where: () => ({ returning: () => Promise.resolve([devuelto]) }) }; },
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    eventos.length = 0; // el helper invalida al admin al registrarlo; lo que se mide es lo del PATCH
    const r = await request(await buildApp()).patch('/api/users/5').set('Authorization', `Bearer ${token}`)
      .send({ allowedPages: [] });
    expect(r.status).toBe(200);
    expect(capturado.sessionInvalidatedAt).toBeInstanceOf(Date);
    expect(invalidarCacheMock).toHaveBeenCalledWith(5);
    expect(invalidarPermisosMock).toHaveBeenCalledWith(5);
    // El orden: la transacción confirmó ANTES de tocar cualquier caché. Mutante: invalidar dentro
    // del tx deja que una petición concurrente rellene la caché con la foto vieja durante 60 s.
    expect(eventos.indexOf('commit')).toBeGreaterThanOrEqual(0);
    expect(eventos.indexOf('invalidar-permisos:5')).toBeGreaterThan(eventos.indexOf('commit'));
    expect(eventos.indexOf('invalidar-sesion:5')).toBeGreaterThan(eventos.indexOf('commit'));
  });

  it('PATCH /users/5 de solo nombre: la caché de permisos se invalida igual (barato y seguro), sin bumpear la sesión', async () => {
    selectMock.mockReturnValueOnce(chain([filaProveedor]));
    selectMock.mockReturnValueOnce(chain([filaProveedor])); // antes, dentro de la tx y con FOR UPDATE (HU #12171)
    selectMock.mockReturnValueOnce(chain([]));
    let capturado: any = null;
    updateMock.mockReturnValueOnce({
      set: (v: any) => { capturado = v; return { where: () => ({ returning: () => Promise.resolve([{ ...devuelto, name: 'Nuevo' }]) }) }; },
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    eventos.length = 0;
    const r = await request(await buildApp()).patch('/api/users/5').set('Authorization', `Bearer ${token}`).send({ name: 'Nuevo' });
    expect(r.status).toBe(200);
    expect(capturado.sessionInvalidatedAt).toBeUndefined();
    expect(invalidarCacheMock).not.toHaveBeenCalled();
    expect(eventos).toEqual(['commit', 'invalidar-permisos:5']);
  });

  it('un PATCH sin cambios (400) o sobre un usuario que no existe (404) NO invalida nada', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await testToken({ sub: 1, role: 'admin' });
    invalidarPermisosMock.mockClear();
    const r = await request(await buildApp()).patch('/api/users/77').set('Authorization', `Bearer ${token}`).send({ name: 'X' });
    expect(r.status).toBe(404);
    expect(invalidarPermisosMock).not.toHaveBeenCalled();
  });

  it('PATCH /:id/toggle y POST /:id/invalidate-sessions también invalidan la caché de permisos', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 5, role: 'proveedor', active: false }]));
    selectMock.mockReturnValueOnce(chain([]));
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ ...devuelto, active: true }]) }) }),
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    expect((await request(await buildApp()).patch('/api/users/5/toggle').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    expect(invalidarPermisosMock).toHaveBeenCalledWith(5);

    invalidarPermisosMock.mockClear();
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 5, username: 'p' }]) }) }),
    });
    expect((await request(await buildApp()).post('/api/users/5/invalidate-sessions').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    expect(invalidarPermisosMock).toHaveBeenCalledWith(5);
  });

  // La invalidación por ROL (`invalidarPermisosDeRol`, la llamará la #12084) se prueba en
  // `permisos-resolutor.test.ts`: aquí el seam del helper es el que manda y no se toca.
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
    selectMock.mockReturnValueOnce(chain([{ id: 5, role: 'cliente', active: true, companiaId: 3 }])); // antes, dentro de la tx y con FOR UPDATE (HU #12171)
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
    selectMock.mockReturnValueOnce(chain([{ id: 5, role: 'cliente', active: true, companiaId: 3 }])); // antes, dentro de la tx y con FOR UPDATE (HU #12171)
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
    selectMock.mockReturnValueOnce(chain([GESTOR_BEFORE]));                      // antes, en la tx con FOR UPDATE (HU #12171)
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
    selectMock.mockReturnValueOnce(chain([GESTOR_BEFORE])); // antes, en la tx con FOR UPDATE (HU #12171)
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
    selectMock.mockReturnValueOnce(chain([GESTOR_BEFORE]));                       // antes, en la tx con FOR UPDATE (HU #12171)
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
    selectMock.mockReturnValueOnce(chain([GESTOR_BEFORE])); // antes, en la tx con FOR UPDATE (HU #12171)
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
    selectMock.mockReturnValueOnce(chain([{ id: 6, role: 'proveedor', active: true, companiaId: null, flitoProveedorSoatId: PROVEEDOR }])); // antes, en la tx con FOR UPDATE (HU #12171)
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

// ───────── HU #12169 (AC6): el rol se valida contra el CATÁLOGO, no contra la constante ─────────
//
// Lo que cambia y por qué importa: hasta esta HU el rol se validaba con `z.enum(ALL_ROLES)`, una
// constante COMPILADA. Con ella, un rol que el administrador acaba de crear era inasignable hasta la
// siguiente publicación — CF-03 imposible. Ahora la forma la mira Zod y la PERTENENCIA se le pregunta
// a `permisos_roles`.
//
// **Mutante nombrado del AC7:** quitar la llamada a `rolAsignable` del `POST` deja en rojo
// «rol inexistente → 400» (pasaría a 201 sobre el mock, y en base sería un 23503 servido como 500).
describe('POST /api/users — el rol se pregunta al catálogo (HU #12169, AC6)', () => {
  const BODY = {
    username: 'rol_nuevo_user', name: 'Usuario de rol nuevo', email: 'rn@x.com',
    password: STRONG_PWD, role: 'consulta_cliente', allowedPages: [],
  };

  it('rol inexistente en el catálogo → 400 con mensaje, y no se escribe NADA', async () => {
    rolAsignableMock.mockReset().mockResolvedValue(null);
    const r = await request(await buildApp()).post('/api/users').set('Authorization', await cabecera())
      .send(BODY);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('El rol no existe o está inactivo');
    expect(insertMock).not.toHaveBeenCalled();
    // Y ni siquiera se consultó el username: el rol se mira ANTES que nada.
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('rol que existe pero está INACTIVO → 400: `activo` gobierna la asignación', async () => {
    // `rolAsignable` ya exige `activo` en su consulta (ver users.rol-asignable.test.ts): un rol
    // desactivado le sale como `null` igual que uno inexistente, y el handler responde lo mismo.
    rolAsignableMock.mockReset().mockResolvedValue(null);
    const r = await request(await buildApp()).post('/api/users').set('Authorization', await cabecera())
      .send({ ...BODY, role: 'mensajero' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('El rol no existe o está inactivo');
  });

  it('CF-03: un rol RECIÉN CREADO por el administrador se asigna de inmediato → 201', async () => {
    // Este es el caso que `z.enum(ALL_ROLES)` hacía imposible: `consulta_cliente` no está en
    // USER_ROLES y no lo estará nunca; es una fila del catálogo.
    rolAsignableMock.mockReset().mockResolvedValue({ tipoEnlace: 'ninguno' });
    selectMock.mockReturnValueOnce(chain([])); // username libre

    const r = await request(await buildApp()).post('/api/users').set('Authorization', await cabecera())
      .send(BODY);

    expect(r.status).toBe(201);
    expect(rolAsignableMock).toHaveBeenCalledWith('consulta_cliente');
    expect(r.body.role).toBe('consulta_cliente');
    const [escrito] = filasDe('users');
    expect((escrito.valores as { role: string }).role).toBe('consulta_cliente');
  });

  it('la FORMA sigue siendo cosa de Zod: un código con mayúsculas o espacios ni llega al catálogo', async () => {
    const r = await request(await buildApp()).post('/api/users').set('Authorization', await cabecera())
      .send({ ...BODY, role: 'Consulta Cliente' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Datos inválidos');
    expect(rolAsignableMock).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/users/:id — el rol se pregunta al catálogo (HU #12169, AC6)', () => {
  it('cambiar a un rol inexistente → 400 y no se actualiza nada', async () => {
    rolAsignableMock.mockReset().mockResolvedValue(null);
    selectMock.mockReturnValueOnce(chain([{ id: 5, role: 'mensajero', active: true }])); // el usuario

    const token = await testToken({ sub: 1, role: 'admin' });
    const r = await request(await buildApp()).patch('/api/users/5')
      .set('Authorization', `Bearer ${token}`).send({ role: 'rol_inventado' });

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('El rol no existe o está inactivo');
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('editar SIN tocar el rol no consulta el catálogo: un rol desactivado después no bloquea la edición', async () => {
    // Es la regla del AC6 leída al derecho: `activo` gobierna la ASIGNACIÓN, no la autenticación ni
    // la edición. Si esto consultara siempre, cambiarle el nombre a un usuario cuyo rol se desactivó
    // fallaría con un mensaje sobre un campo que el administrador no tocó.
    selectMock.mockReturnValueOnce(chain([{ id: 5, role: 'mensajero', active: true }]));
    selectMock.mockReturnValueOnce(chain([{ id: 5, role: 'mensajero', active: true }])); // antes, en la tx con FOR UPDATE (HU #12171)
    selectMock.mockReturnValueOnce(chain([])); // organismos previos
    updateMock.mockReturnValueOnce(updateProyectado({ id: 5, role: 'mensajero' }, () => {}));
    selectMock.mockReturnValueOnce(chain([])); // organismos finales

    const token = await testToken({ sub: 1, role: 'admin' });
    const r = await request(await buildApp()).patch('/api/users/5')
      .set('Authorization', `Bearer ${token}`).send({ name: 'Nombre nuevo' });

    expect(r.status).toBe(200);
    expect(rolAsignableMock).not.toHaveBeenCalled();
  });
});

// ─────────── HU #12171 (Feature #12072, ADR-0014): el historial de cambios con su antes y su después ───────────
//
// Cada escritura del módulo deja, ADEMÁS del `audit()` de siempre, filas en `permisos_auditoria` con
// el valor anterior y el posterior, campo a campo, dentro de la MISMA transacción. Lo que se afirma:
//   · AC1: rol, páginas, ámbito (compañía, proveedor, organismos), estado activo, alta y contraseña;
//   · AC4: del actor el correo; del titular solo id y rol — ni correo, ni nombre, ni hash;
//   · el orden: la fila del historial entra ANTES del commit, y las cachés se invalidan DESPUÉS.
describe('HU #12171 — permisos_auditoria: antes/después de cada cambio, en la transacción', () => {
  const ACTOR = 'admin@flit.test';
  const cabeceraActor = async () => `Bearer ${await testToken({ sub: 1, role: 'admin', username: ACTOR })}`;

  /** Las filas que llegaron a `insert(permisosAuditoria).values(...)`, aplanadas. */
  const filasAuditoria = (): Record<string, unknown>[] =>
    escrituras.filter((e) => e.tabla === 'permisos_auditoria').flatMap((e) => e.valores as Record<string, unknown>[]);
  const porCampo = (campo: string) => filasAuditoria().find((f) => f.campo === campo);

  /** AC4, en negativo: nada del titular salvo id y rol; nada de secretos. Se aplica a TODAS las filas. */
  function sinPiiDelTitular(filas: Record<string, unknown>[]) {
    expect(filas.length).toBeGreaterThan(0);
    for (const f of filas) {
      const plano = JSON.stringify(f).toLowerCase();
      for (const prohibido of ['passwordhash', 'password_hash', 'hashed', '"email"', '"name"', '"username"', 'documento', 'telefono', 'phone']) {
        expect(plano, `la fila del historial no puede llevar ${prohibido}`).not.toContain(prohibido);
      }
      expect(f.usuarioAfectadoId).toEqual(expect.any(Number));
      expect(f.usuarioAfectadoRol).toEqual(expect.any(String));
      expect(f.actorEmail).toBe(ACTOR);
      expect(f.actorUserId).toBe(1);
      expect(f.origen).toBe('usuario');
      expect(f.loteId).toEqual(expect.any(String));
    }
    // Un acto = un lote: todas las filas comparten `loteId`.
    expect(new Set(filas.map((f) => f.loteId)).size).toBe(1);
  }

  it('alta (POST /): filas `crear` con rol, páginas y el ámbito; sin antes; dentro de la tx y antes de invalidar', async () => {
    selectMock.mockReturnValueOnce(chain([])); // username libre
    selectMock.mockReturnValueOnce(chain([{ id: PROVEEDOR }])); // el proveedor existe
    eventos.length = 0;
    const r = await request(await buildApp()).post('/api/users').set('Authorization', await cabeceraActor())
      .send({ ...BODY_PROVEEDOR, flitoProveedorSoatId: PROVEEDOR, allowedPages: ['soat'] });
    expect(r.status).toBe(201);

    const filas = filasAuditoria();
    sinPiiDelTitular(filas);
    expect(filas.every((f) => f.entidad === 'usuario' && f.accion === 'crear' && f.valorAntes === null)).toBe(true);
    expect(porCampo('role')).toMatchObject({ valorDespues: 'proveedor', usuarioAfectadoId: 99, usuarioAfectadoRol: 'proveedor' });
    expect(porCampo('allowed_pages')).toMatchObject({ valorDespues: { conjunto: ['soat'], concedidas: ['soat'], revocadas: [] } });
    expect(porCampo('flito_proveedor_soat_id')).toMatchObject({ valorDespues: PROVEEDOR });
    expect(porCampo('compania_id')).toBeUndefined();
    expect(eventos.indexOf('insert-auditoria')).toBeLessThan(eventos.indexOf('commit'));
    expect(eventos.indexOf('commit')).toBeLessThan(eventos.indexOf('invalidar-permisos:99'));
  });

  it('cambio de rol (PATCH /:id): una fila `role` con el antes y el después; el rol del titular es el del momento', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 5, role: 'proveedor', active: true, flitoProveedorSoatId: PROVEEDOR }])); // before (ruta)
    selectMock.mockReturnValueOnce(chain([{ id: 5, role: 'proveedor', active: true, allowedPages: [], flitoProveedorSoatId: PROVEEDOR, companiaId: null, transitoCodigo: null }])); // antes (tx, FOR UPDATE)
    selectMock.mockReturnValueOnce(chain([])); // organismos
    updateMock.mockReturnValueOnce(updateProyectado({ id: 5, role: 'auditor', name: 'P', username: 'p', email: null, active: true, allowedPages: [], createdAt: new Date() }, () => {}));
    eventos.length = 0;
    const r = await request(await buildApp()).patch('/api/users/5').set('Authorization', await cabeceraActor()).send({ role: 'auditor' });
    expect(r.status).toBe(200);

    sinPiiDelTitular(filasAuditoria());
    expect(porCampo('role')).toMatchObject({ entidad: 'usuario', accion: 'editar', valorAntes: 'proveedor', valorDespues: 'auditor', usuarioAfectadoId: 5, usuarioAfectadoRol: 'proveedor' });
    // Degradar desde `proveedor` le quita el proveedor SOAT: ese cambio también queda con su antes.
    expect(porCampo('flito_proveedor_soat_id')).toMatchObject({ valorAntes: PROVEEDOR, valorDespues: null });
    expect(eventos.indexOf('insert-auditoria')).toBeLessThan(eventos.indexOf('commit'));
    expect(eventos.indexOf('commit')).toBeLessThan(eventos.indexOf('invalidar-permisos:5'));
  });

  it('cambio de páginas permitidas: el historial dice QUÉ páginas había y QUÉ páginas quedaron (mutación 1 del AC6)', async () => {
    const antes = { id: 5, role: 'auditor', active: true, allowedPages: ['soat', 'transito'], flitoProveedorSoatId: null, companiaId: null, transitoCodigo: null };
    selectMock.mockReturnValueOnce(chain([antes]));
    selectMock.mockReturnValueOnce(chain([antes]));
    selectMock.mockReturnValueOnce(chain([]));
    updateMock.mockReturnValueOnce(updateProyectado({ id: 5, role: 'auditor', name: 'A', username: 'a', email: null, active: true, allowedPages: ['soat', 'clients'], createdAt: new Date() }, () => {}));
    const r = await request(await buildApp()).patch('/api/users/5').set('Authorization', await cabeceraActor())
      .send({ allowedPages: ['clients', 'soat'] });
    expect(r.status).toBe(200);

    const fila = porCampo('allowed_pages');
    expect(fila).toBeDefined();
    expect(fila!.valorAntes).toEqual({ conjunto: ['soat', 'transito'] });
    // El «después» es lo que la mutación 1 borra: sin él la fila solo diría «hubo un cambio».
    expect(fila!.valorDespues).toEqual({ conjunto: ['clients', 'soat'], concedidas: ['clients'], revocadas: ['transito'] });
    // Y NO hay fila de rol ni de ámbito: solo lo que cambió.
    expect(filasAuditoria().map((f) => f.campo)).toEqual(['allowed_pages']);
  });

  it('TC-05: el «antes» es el de la fila bloqueada en la tx (FOR UPDATE), no el `before` de la ruta; y el bloqueo va antes del UPDATE y del historial', async () => {
    // La ruta leyó ['transito'] (el «viejo») para sus guardas; entre esa lectura y la transacción otro
    // administrador dejó ['soat'] (el «vigente»). Lo que el historial debe afirmar como anterior es
    // ['soat']. Códigos reales de página: `allowedPagesSchema` filtra con `isValidPage`.
    const base = { id: 5, role: 'auditor', active: true, flitoProveedorSoatId: null, companiaId: null, transitoCodigo: null };
    selectMock.mockReturnValueOnce(chain([{ ...base, allowedPages: ['transito'] }])); // before (ruta): el viejo
    const enTx = chain([{ ...base, allowedPages: ['soat'] }]); // antes (tx, FOR UPDATE): el vigente
    const forOriginal = enTx.for;
    enTx.for = (...args: unknown[]) => { eventos.push('select:users:for-update'); return (forOriginal as (...a: unknown[]) => typeof enTx)(...args); };
    selectMock.mockReturnValueOnce(enTx); // antes (tx)
    selectMock.mockReturnValueOnce(chain([])); // organismos
    updateMock.mockReturnValueOnce(updateProyectado(
      { id: 5, role: 'auditor', name: 'A', username: 'a', email: null, active: true, allowedPages: ['soat', 'clients'], createdAt: new Date() },
      () => { eventos.push('update:users'); },
    ));
    eventos.length = 0;
    const r = await request(await buildApp()).patch('/api/users/5').set('Authorization', await cabeceraActor())
      .send({ allowedPages: ['soat', 'clients'] });
    expect(r.status).toBe(200);

    const fila = porCampo('allowed_pages');
    expect(fila).toBeDefined();
    // Mutante 1: usar el `before` de la ruta como `valorAntes` → aquí saldría ['transito'].
    expect(fila!.valorAntes).toEqual({ conjunto: ['soat'] });
    expect(fila!.valorDespues).toEqual({ conjunto: ['clients', 'soat'], concedidas: ['clients'], revocadas: [] });
    // Mutante 2: quitar `.for('update')` → el evento no existe y los índices dan -1.
    expect(eventos.indexOf('select:users:for-update')).toBeGreaterThanOrEqual(0);
    expect(eventos.indexOf('select:users:for-update')).toBeLessThan(eventos.indexOf('update:users'));
    expect(eventos.indexOf('update:users')).toBeLessThan(eventos.indexOf('insert-auditoria'));
    expect(eventos.indexOf('insert-auditoria')).toBeLessThan(eventos.indexOf('commit'));
  });

  it('el mismo conjunto de páginas en otro orden NO deja fila: el orden no es un cambio', async () => {
    const antes = { id: 5, role: 'auditor', active: true, allowedPages: ['soat', 'transito'], flitoProveedorSoatId: null, companiaId: null, transitoCodigo: null };
    selectMock.mockReturnValueOnce(chain([antes]));
    selectMock.mockReturnValueOnce(chain([antes]));
    selectMock.mockReturnValueOnce(chain([]));
    updateMock.mockReturnValueOnce(updateProyectado({ id: 5, role: 'auditor', name: 'A', username: 'a', email: null, active: true, allowedPages: ['transito', 'soat'], createdAt: new Date() }, () => {}));
    const r = await request(await buildApp()).patch('/api/users/5').set('Authorization', await cabeceraActor())
      .send({ allowedPages: ['transito', 'soat'] });
    expect(r.status).toBe(200);
    expect(filasAuditoria()).toEqual([]);
  });

  it('cambio de ámbito: compañía (cliente) y organismos (gestor) con su antes y su después', async () => {
    // Compañía 3 → 9.
    selectMock.mockReturnValueOnce(chain([{ id: 5, role: 'cliente', active: true, companiaId: 3 }]));
    selectMock.mockReturnValueOnce(chain([{ id: 9 }])); // la compañía nueva existe
    selectMock.mockReturnValueOnce(chain([{ id: 5, role: 'cliente', active: true, allowedPages: [], companiaId: 3, flitoProveedorSoatId: null, transitoCodigo: null }]));
    selectMock.mockReturnValueOnce(chain([]));
    updateMock.mockReturnValueOnce(updateProyectado({ id: 5, role: 'cliente', name: 'C', username: 'c', email: null, active: true, allowedPages: [], companiaId: 9, createdAt: new Date() }, () => {}));
    let r = await request(await buildApp()).patch('/api/users/5').set('Authorization', await cabeceraActor()).send({ companiaId: 9 });
    expect(r.status).toBe(200);
    expect(porCampo('compania_id')).toMatchObject({ valorAntes: 3, valorDespues: 9, usuarioAfectadoId: 5, usuarioAfectadoRol: 'cliente' });
    sinPiiDelTitular(filasAuditoria());

    // Organismos [A] → [A, B].
    escrituras.length = 0;
    const GESTOR_BEFORE = { id: 5, role: 'gestor_impuestos', active: true, companiaId: null, flitoProveedorSoatId: null };
    selectMock.mockReturnValueOnce(chain([GESTOR_BEFORE]));
    selectMock.mockReturnValueOnce(chain([{ codigo: ORG_A }, { codigo: ORG_B }])); // existen
    selectMock.mockReturnValueOnce(chain([{ ...GESTOR_BEFORE, allowedPages: [], transitoCodigo: null }]));
    selectMock.mockReturnValueOnce(chain([{ codigo: ORG_A }])); // anteriores
    updateMock.mockReturnValueOnce(updateProyectado({ id: 5, role: 'gestor_impuestos', name: 'G', username: 'g', email: null, active: true, allowedPages: [], createdAt: new Date() }, () => {}));
    r = await request(await buildApp()).patch('/api/users/5').set('Authorization', await cabeceraActor()).send({ organismosCodigos: [ORG_B, ORG_A] });
    expect(r.status).toBe(200);
    expect(porCampo('organismos_codigos')).toMatchObject({
      valorAntes: { conjunto: [ORG_A] },
      valorDespues: { conjunto: [ORG_A, ORG_B], concedidas: [ORG_B], revocadas: [] },
    });
    expect(filasAuditoria().map((f) => f.campo)).toEqual(['organismos_codigos']);
  });

  it('estado activo (PATCH /:id/toggle): fila `active` con `desactivar`, true → false, en la transacción', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 9, role: 'admin', active: true }]));
    selectMock.mockReturnValueOnce(chain([{ count: 2 }]));
    selectMock.mockReturnValueOnce(chain([])); // organismos (tx)
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 9, active: false, name: 'A', username: 'a', email: null, role: 'admin', allowedPages: null, createdAt: new Date() }]) }) }),
    });
    eventos.length = 0;
    const r = await request(await buildApp()).patch('/api/users/9/toggle').set('Authorization', await cabeceraActor());
    expect(r.status).toBe(200);
    sinPiiDelTitular(filasAuditoria());
    expect(porCampo('active')).toMatchObject({ entidad: 'usuario', accion: 'desactivar', valorAntes: true, valorDespues: false, usuarioAfectadoId: 9, usuarioAfectadoRol: 'admin' });
    expect(eventos.indexOf('insert-auditoria')).toBeLessThan(eventos.indexOf('commit'));
    expect(eventos.indexOf('commit')).toBeLessThan(eventos.indexOf('invalidar-sesion:9'));
  });

  it('reactivar: fila `active` con `activar`, false → true', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 5, role: 'proveedor', active: false }]));
    selectMock.mockReturnValueOnce(chain([]));
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 5, active: true, name: 'P', username: 'p', email: null, role: 'proveedor', allowedPages: null, createdAt: new Date() }]) }) }),
    });
    const r = await request(await buildApp()).patch('/api/users/5/toggle').set('Authorization', await cabeceraActor());
    expect(r.status).toBe(200);
    expect(porCampo('active')).toMatchObject({ accion: 'activar', valorAntes: false, valorDespues: true });
  });

  it('contraseña (PATCH /:id/password): el HECHO queda, sin valores; el correo es el del ACTOR, no el del titular (mutación 3 del AC6)', async () => {
    const TITULAR_EMAIL = 'titular@ejemplo.test';
    selectMock.mockReturnValueOnce(chain([{ id: 9, passwordHash: 'hold', role: 'proveedor', active: true, email: TITULAR_EMAIL, username: 'titular' }]));
    updateMock.mockReturnValueOnce({ set: () => ({ where: () => Promise.resolve(undefined) }) });
    eventos.length = 0;
    const r = await request(await buildApp()).patch('/api/users/9/password').set('Authorization', await cabeceraActor())
      .send({ currentPassword: 'irrelevant', newPassword: STRONG_PWD });
    expect(r.status).toBe(200);

    const filas = filasAuditoria();
    sinPiiDelTitular(filas);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ campo: 'password', accion: 'editar', valorAntes: null, valorDespues: null, usuarioAfectadoId: 9, usuarioAfectadoRol: 'proveedor' });
    expect(filas[0]!.actorEmail).toBe(ACTOR);
    expect(filas[0]!.actorEmail).not.toBe(TITULAR_EMAIL);
    expect(JSON.stringify(filas[0])).not.toContain('HASHED');
    expect(JSON.stringify(filas[0])).not.toContain(TITULAR_EMAIL);
    expect(eventos.indexOf('insert-auditoria')).toBeLessThan(eventos.indexOf('commit'));
  });

  it('si el historial NO se puede escribir, el cambio NO se confirma: la transacción rechaza y no hay commit (mutación 5)', async () => {
    // Se prueba en el SERVICIO y no por HTTP: `buildApp` no monta `express-async-errors` (lo hace
    // `app.ts`), y lo que la mutación 5 tiene que dejar en rojo es que el escritor NO se trague el
    // error. Sin try/catch, el rechazo sube, `db.transaction` no confirma y la ruta no invalida nada.
    const { chainReject } = await import('../helpers/db.js');
    const { actualizarUsuario } = await import('../../src/modules/users/users.service.js');
    insertMock.mockImplementation((tabla: unknown) => (
      nombreTabla(tabla) === 'permisos_auditoria'
        ? { values: () => chainReject(new Error('permisos_auditoria: fuera de servicio')) }
        : insertPorDefecto(tabla)
    ));
    const antes = { id: 5, role: 'auditor', active: true, allowedPages: ['soat'], flitoProveedorSoatId: null, companiaId: null, transitoCodigo: null };
    selectMock.mockReturnValueOnce(chain([antes]));
    selectMock.mockReturnValueOnce(chain([]));
    let capturado: Record<string, unknown> = {};
    updateMock.mockReturnValueOnce(updateProyectado({ id: 5, role: 'auditor', name: 'A', username: 'a', email: null, active: true, allowedPages: [], createdAt: new Date() }, (v) => { capturado = v; }));
    eventos.length = 0;

    await expect(actualizarUsuario(
      5, { updates: { allowedPages: [] }, organismosDestino: null, invalidarPorCampos: true },
      { userId: 1, email: ACTOR, rol: 'admin' },
    )).rejects.toThrow(/fuera de servicio/);

    // El UPDATE llegó a ejecutarse dentro de la transacción… y la transacción NO confirmó.
    expect(capturado.allowedPages).toEqual([]);
    expect(eventos).not.toContain('commit');
    expect(invalidarPermisosMock).not.toHaveBeenCalled();
    expect(invalidarCacheMock).not.toHaveBeenCalled();
  });
});

// ─────────── HU #12084 (AC4): las dos rutas pasan por el invariante anti-bloqueo, dentro de su tx ───────────
const { BloqueoAdministracionError } = await import('../../src/shared/permisos-anti-bloqueo.js');

describe('HU #12084 AC4 — el invariante anti-bloqueo envuelve cambiar el rol y desactivar', () => {

  it('PATCH /:id con `role`: el invariante se invoca con el `tx` de la transacción y envuelve el UPDATE', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 5, role: 'admin', active: true }])); // before
    selectMock.mockReturnValueOnce(chain([{ count: 1 }])); // pre-check: hay otro admin
    selectMock.mockReturnValueOnce(chain([{ id: 5, role: 'admin', active: true, allowedPages: null }])); // anterior (tx, FOR UPDATE)
    selectMock.mockReturnValueOnce(chain([])); // organismos
    updateMock.mockReturnValueOnce(updateProyectado({ id: 5, role: 'admin', active: true, name: 'A', username: 'a', email: null, allowedPages: null, createdAt: new Date() }, () => {}));
    rolAsignableMock.mockResolvedValueOnce({ tipoEnlace: 'ninguno' });
    const token = await testToken({ sub: 1, role: 'admin' });
    const r = await request(await buildApp()).patch('/api/users/5').set('Authorization', `Bearer ${token}`).send({ role: 'auditor' });
    expect(r.status).toBe(200);
    expect(seguroMock).toHaveBeenCalledTimes(1);
    expect(seguroMock.mock.calls[0][0]).toBe(dbMock); // el `tx` (la transacción corre contra dbMock)
    // El UPDATE ocurrió DENTRO de la escritura envuelta: antes de invocar el seguro no había ninguno.
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it('PATCH /:id SIN `role` (solo el nombre) no paga el lock: el invariante no se invoca', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 5, role: 'auditor', active: true }]));
    selectMock.mockReturnValueOnce(chain([{ id: 5, role: 'auditor', active: true, allowedPages: null }]));
    selectMock.mockReturnValueOnce(chain([]));
    updateMock.mockReturnValueOnce(updateProyectado({ id: 5, role: 'auditor', active: true, name: 'A', username: 'a', email: null, allowedPages: null, createdAt: new Date() }, () => {}));
    const token = await testToken({ sub: 1, role: 'admin' });
    const r = await request(await buildApp()).patch('/api/users/5').set('Authorization', `Bearer ${token}`).send({ name: 'Nuevo nombre' });
    expect(r.status).toBe(200);
    expect(seguroMock).not.toHaveBeenCalled();
  });

  it('PATCH /:id: si el invariante lanza, 409 con el motivo, sin commit y sin invalidar nada', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 5, role: 'admin', active: true }]));
    selectMock.mockReturnValueOnce(chain([{ count: 1 }]));
    seguroMock.mockImplementationOnce(async () => { throw new BloqueoAdministracionError('usuarios.usuario.editar'); });
    rolAsignableMock.mockResolvedValueOnce({ tipoEnlace: 'ninguno' });
    const token = await testToken({ sub: 1, role: 'admin' });
    const r = await request(await buildApp()).patch('/api/users/5').set('Authorization', `Bearer ${token}`).send({ role: 'auditor' });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'Dejaría cero usuarios activos capaces de administrar usuarios', funcion: 'usuarios.usuario.editar' });
    expect(eventos).not.toContain('commit');
    expect(invalidarPermisosMock).not.toHaveBeenCalled();
    expect(invalidarCacheMock).not.toHaveBeenCalled();
  });

  it('PATCH /:id/toggle: el invariante envuelve el UPDATE y su excepción es 409 sin commit', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 9, role: 'admin', active: true }]));
    selectMock.mockReturnValueOnce(chain([{ count: 2 }])); // pre-check: hay otro admin
    seguroMock.mockImplementationOnce(async () => { throw new BloqueoAdministracionError('permisos.cuadro.guardar'); });
    const token = await testToken({ sub: 1, role: 'admin' });
    const r = await request(await buildApp()).patch('/api/users/9/toggle').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/administrar permisos/);
    expect(seguroMock).toHaveBeenCalledTimes(1);
    expect(seguroMock.mock.calls[0][0]).toBe(dbMock);
    expect(eventos).not.toContain('commit');
    expect(invalidarCacheMock).not.toHaveBeenCalled();
  });

  it('PATCH /:id/toggle: reactivar también pasa por el invariante (se envuelve siempre)', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 5, role: 'proveedor', active: false }]));
    selectMock.mockReturnValueOnce(chain([]));
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 5, active: true, name: 'P', username: 'p', email: null, role: 'proveedor', allowedPages: null, createdAt: new Date() }]) }) }),
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const r = await request(await buildApp()).patch('/api/users/5/toggle').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(seguroMock).toHaveBeenCalledTimes(1);
  });
});
