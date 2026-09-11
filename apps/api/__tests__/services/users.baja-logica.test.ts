// HU #12089 — Baja lógica de usuarios: DELETE marca deleted_at, reactivar, listado,
// self-baja, unicidad, auditoría sin PII, grep anti-hard-delete, schema RESTRICT.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import express from 'express';
import { PgDialect } from 'drizzle-orm/pg-core';
import { getTableName } from 'drizzle-orm';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';
import { users } from '../../src/db/schema.js';
import { CONDICION_USUARIO_VIVO } from '../../src/shared/permisos-anti-bloqueo.js';
import { condicionesUsuarios } from '../../src/modules/users/users.service.js';

const {
  selectMock, insertMock, updateMock, deleteMock, transactionMock, dbMock,
  invalidarCacheMock, auditoriaMock,
} = vi.hoisted(() => {
  const selectMock = vi.fn();
  const insertMock = vi.fn();
  const updateMock = vi.fn();
  const deleteMock = vi.fn();
  const transactionMock = vi.fn();
  const dbMock = {
    select: selectMock,
    insert: insertMock,
    update: updateMock,
    delete: deleteMock,
    transaction: transactionMock,
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  };
  return {
    selectMock, insertMock, updateMock, deleteMock, transactionMock, dbMock,
    invalidarCacheMock: vi.fn(),
    auditoriaMock: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../../src/db/client.js', () => ({
  db: dbMock,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

vi.mock('../../src/shared/middleware/audit.js', () => ({
  audit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../src/shared/middleware/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/middleware/auth.js')>();
  return { ...actual, invalidateSessionCacheFor: (id: number) => invalidarCacheMock(id) };
});

vi.mock('../../src/modules/users/users.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/users/users.service.js')>();
  return {
    ...actual,
    rolAsignable: vi.fn(async (codigo: string) => (
      codigo === 'admin' || codigo === 'operario'
        ? { codigo, tipoEnlace: 'ninguno', tipoPrincipal: 'interno', activo: true }
        : null
    )),
  };
});

vi.mock('../../src/shared/permisos-anti-bloqueo.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/permisos-anti-bloqueo.js')>();
  return {
    ...actual,
    conSeguroAntiBloqueo: async <T>(_tx: unknown, escritura: () => Promise<T>) => escritura(),
  };
});

vi.mock('../../src/shared/permisos-efectivos.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/permisos-efectivos.js')>();
  return {
    ...actual,
    invalidarPermisosDe: vi.fn(),
  };
});

vi.mock('../../src/shared/historial/permisos-auditoria.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/historial/permisos-auditoria.js')>();
  return {
    ...actual,
    registrarCambioPermisos: (...args: unknown[]) => auditoriaMock(...args),
    registrarCambiosPermisos: vi.fn().mockResolvedValue(undefined),
  };
});

const { default: usersRouter } = await import('../../src/modules/users/users.routes.js');

const app = express();
app.use(express.json());
app.use('/api/users', usersRouter);

const ADMIN = 1;
const OTRO = 42;
const authAdmin = async () => `Bearer ${await testToken({ sub: ADMIN, username: 'admin', role: 'admin' })}`;

const dialecto = new PgDialect();
const render = (cond: unknown) => dialecto.sqlToQuery(cond as never);

beforeEach(() => {
  selectMock.mockReset();
  insertMock.mockReset();
  updateMock.mockReset();
  deleteMock.mockReset();
  invalidarCacheMock.mockReset();
  auditoriaMock.mockReset().mockResolvedValue(undefined);
  transactionMock.mockReset().mockImplementation(async (cb: (tx: unknown) => unknown) => cb(dbMock));
  process.env.AUTH_SKIP_SESSION_INVAL_CHECK = '1';
});

describe('HU #12089 — schema y anti-hard-delete', () => {
  it('users.deletedBy declara ON DELETE RESTRICT en schema.ts', () => {
    const src = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/db/schema.ts'),
      'utf8',
    );
    // Solo deletedBy/deleted_by: exige onDelete 'restrict' en ESE references (no otro del archivo).
    // Mutar a 'set null' debe matar el aserto.
    const refs = src.match(
      /deletedBy:\s*integer\(\s*['"]deleted_by['"]\s*\)\.references\(([\s\S]*?)\)\s*,/,
    );
    expect(refs).not.toBeNull();
    expect(refs![1]).toMatch(/onDelete:\s*['"]restrict['"]/);
  });

  it('ningún fuente de producto hace db.delete(users) ni DELETE FROM users', () => {
    const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
    const ofensivos: string[] = [];
    const walk = (dir: string) => {
      for (const nombre of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, nombre.name);
        if (nombre.isDirectory()) {
          if (nombre.name === 'node_modules' || nombre.name === 'dist') continue;
          walk(p);
          continue;
        }
        if (!nombre.name.endsWith('.ts')) continue;
        const txt = readFileSync(p, 'utf8');
        const sinComentarios = txt.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
        if (/db\.delete\(\s*users\s*\)/.test(sinComentarios)) ofensivos.push(`${p}: db.delete(users)`);
        if (/DELETE\s+FROM\s+users\b/i.test(sinComentarios)) ofensivos.push(`${p}: DELETE FROM users`);
      }
    };
    walk(raiz);
    expect(ofensivos).toEqual([]);
    expect(getTableName(users)).toBe('users');
  });

  it('CONDICION_USUARIO_VIVO es deleted_at IS NULL', () => {
    expect(render(CONDICION_USUARIO_VIVO).sql).toMatch(/deleted_at" is null/i);
  });
});

describe('HU #12089 — condicionesUsuarios (listado default)', () => {
  it('sin flags exige deleted_at IS NULL', () => {
    const sql = render(condicionesUsuarios({})).sql;
    expect(sql).toMatch(/deleted_at" is null/i);
  });

  it('incluirBajas=true no exige IS NULL', () => {
    const cond = condicionesUsuarios({ incluirBajas: true });
    expect(cond).toBeUndefined();
  });

  it('soloBajas exige IS NOT NULL', () => {
    const sql = render(condicionesUsuarios({ soloBajas: true })!).sql;
    expect(sql).toMatch(/deleted_at" is not null/i);
  });
});

describe('DELETE /api/users/:id — baja lógica', () => {
  it('self-baja → 400', async () => {
    const res = await request(app)
      .delete(`/api/users/${ADMIN}`)
      .set('Authorization', await authAdmin());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sí mismo|si mismo/i);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('marca deleted_at/deleted_by + sessionInvalidatedAt, audita sin PII e invalida cache', async () => {
    const ahora = new Date('2026-09-11T15:00:00.000Z');
    vi.setSystemTime(ahora);

    selectMock
      .mockReturnValueOnce(chain([{ id: OTRO, deletedAt: null, role: 'operario', active: true }]))
      .mockReturnValueOnce(chain([{ deletedAt: null, role: 'operario' }]));

    const filaTras = {
      id: OTRO, username: 'ope', name: 'Ope', email: null, role: 'operario', active: true,
      allowedPages: [], transitoCodigo: null, companiaId: null, flitoProveedorSoatId: null,
      createdAt: ahora, deletedAt: ahora, deletedBy: ADMIN,
    };
    const returning = vi.fn().mockResolvedValue([filaTras]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    updateMock.mockReturnValueOnce({ set });
    selectMock.mockReturnValueOnce(chain([])).mockReturnValueOnce(chain([]));

    const res = await request(app)
      .delete(`/api/users/${OTRO}`)
      .set('Authorization', await authAdmin());

    expect(res.status).toBe(200);
    expect(res.body.deletedAt).toBeTruthy();
    expect(res.body.deletedBy).toBe(ADMIN);
    expect(invalidarCacheMock).toHaveBeenCalledWith(OTRO);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      deletedAt: ahora,
      deletedBy: ADMIN,
      sessionInvalidatedAt: ahora,
    }));

    expect(auditoriaMock).toHaveBeenCalled();
    const cambio = auditoriaMock.mock.calls[0][2];
    expect(cambio.accion).toBe('baja');
    expect(cambio.campo).toBe('deleted_at');
    expect(cambio.valorAntes).toBeNull();
    expect(String(cambio.valorDespues)).toMatch(/2026-09-11/);
    // Sin PII del afectado (username/email/name) en valores auditable.
    expect(JSON.stringify(cambio)).not.toMatch(/"ope"|"Ope"|@/);
    expect(cambio.usuarioAfectado).toEqual({ id: OTRO, rol: 'operario' });

    vi.useRealTimers();
  });

  it('usuario inexistente → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const res = await request(app)
      .delete('/api/users/99999')
      .set('Authorization', await authAdmin());
    expect(res.status).toBe(404);
  });
});

describe('POST /api/users/:id/reactivar', () => {
  it('limpia deleted_* y conserva active', async () => {
    const bajaEn = new Date('2026-09-01T12:00:00.000Z');
    selectMock.mockReturnValueOnce(chain([{ deletedAt: bajaEn, role: 'operario' }]));

    const fila = {
      id: OTRO, username: 'ope', name: 'Ope', email: null, role: 'operario', active: false,
      allowedPages: [], transitoCodigo: null, companiaId: null, flitoProveedorSoatId: null,
      createdAt: new Date(), deletedAt: null, deletedBy: null,
    };
    updateMock.mockReturnValueOnce({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([fila]),
        }),
      }),
    });
    selectMock.mockReturnValueOnce(chain([])).mockReturnValueOnce(chain([]));

    const res = await request(app)
      .post(`/api/users/${OTRO}/reactivar`)
      .set('Authorization', await authAdmin());

    expect(res.status).toBe(200);
    expect(res.body.deletedAt).toBeNull();
    expect(res.body.active).toBe(false);
    const cambio = auditoriaMock.mock.calls[0][2];
    expect(cambio.accion).toBe('reactivar');
    expect(cambio.campo).toBe('deleted_at');
    expect(cambio.valorDespues).toBeNull();
  });
});

describe('POST /api/users — unicidad con baja (AC6)', () => {
  it('username de fila existente (viva o baja) → 409 sugiriendo reactivar', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 9 }]));
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', await authAdmin())
      .send({
        username: 'yaexiste', name: 'X', password: 'Aa1!aaaa', role: 'operario',
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/reactivar/i);
  });
});

describe('GET /api/users — incluirBajas', () => {
  it('default pasa deleted_at IS NULL (cubierto por condicionesUsuarios; HTTP smoke)', async () => {
    // El predicado del listado ya se afirma arriba; aquí smoke: 200 con auth.
    selectMock.mockReturnValue(chain([]));
    const res = await request(app)
      .get('/api/users')
      .set('Authorization', await authAdmin());
    expect(res.status).toBe(200);
  });
});
