// HU #13957 (Feature #13940, Épica #13671) — el nombre de un proveedor SOAT solo lo ocupa un proveedor VIGENTE.
//
// Ruta con la BD mockeada: el listado solo trae vigentes. Alta y edición se retiraron (HU #14334): la unicidad entre vigentes y
// su carrera se miden en `db/proveedores-gestion.test.ts`. El índice y la 0259 contra PostgreSQL, en `db/migracion-0259.test.ts`.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { testToken } from '../helpers/auth.js';

const { selectMock, insertMock, updateMock, auditMock } = vi.hoisted(() => ({
  selectMock: vi.fn(), insertMock: vi.fn(), updateMock: vi.fn(), auditMock: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock, insert: insertMock, update: updateMock, delete: vi.fn(), transaction: vi.fn(),
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const dialecto = new PgDialect();
let wheres: { sql: string; params: unknown[] }[] = [];

/** SELECT `from().where().limit()` / `from().where().orderBy()` que registra el WHERE y devuelve `filas`. */
function select(filas: unknown[]) {
  return {
    from: () => ({
      where: (w: SQL) => {
        wheres.push(dialecto.sqlToQuery(w));
        return { limit: () => Promise.resolve(filas), orderBy: () => Promise.resolve(filas) };
      },
    }),
  };
}

const fila = (extra: Record<string, unknown> = {}) => ({
  id: 'b0000000-0000-4000-8000-000000000002', nombre: 'Seguros Andinos', estrategia: 'portal', umbralOcr: null,
  slaHoras: null, activo: true, createdAt: new Date(), deletedAt: null, deletedBy: null, ...extra,
});
const URL = '/api/flito/parametrizacion/proveedores-soat';

beforeEach(() => {
  selectMock.mockReset(); insertMock.mockReset(); updateMock.mockReset();
  auditMock.mockReset().mockResolvedValue(undefined);
  wheres = [];
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-parametrizacion/flito-parametrizacion.routes.js');
  app.use('/api/flito/parametrizacion', router);
  return app;
}
const auth = async () => `Bearer ${await testToken({ sub: 1, username: 'u', role: 'admin' })}`;

describe('GET /proveedores-soat — no lista eliminados (HU #13957)', () => {
  it('filtra deleted_at IS NULL', async () => {
    selectMock.mockReturnValueOnce(select([fila()]));
    const r = await request(await buildApp()).get(URL).set('Authorization', await auth());
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
    expect(wheres[0]!.sql).toMatch(/"flito_proveedores_soat"\."deleted_at" is null/);
  });
});
