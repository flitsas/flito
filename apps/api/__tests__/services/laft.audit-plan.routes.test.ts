// LAFT F5 · audit-plan.routes — crear (idempotente), patch, evidencia, cerrar.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { chain } from '../helpers/db.js';
import { adminAuth, testToken } from '../helpers/auth.js';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const transactionMock = vi.fn();
const executeMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock, insert: insertMock, update: updateMock,
    transaction: transactionMock, execute: executeMock, delete: vi.fn(),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

vi.mock('../../src/modules/laft/audit.service.js', () => ({
  laftAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/services/storage.js', () => ({
  uploadEntityDocument: vi.fn().mockResolvedValue('laft/audit-evidencia/1/key.pdf'),
}));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('express-rate-limit', () => ({ default: () => (_req: any, _res: any, next: any) => next() }));

let app: any;
beforeEach(async () => {
  selectMock.mockReset(); insertMock.mockReset(); updateMock.mockReset();
  transactionMock.mockReset(); executeMock.mockReset();
  executeMock.mockResolvedValue([{ '?column?': 1 }]);
  const { createApp } = await import('../../src/app.js');
  app = createApp();
});

function forUpdateChain(rows: any[]): any {
  return {
    from: () => ({
      where: () => ({
        for: () => ({ limit: () => Promise.resolve(rows) }),
        limit: () => Promise.resolve(rows),
      }),
    }),
  };
}

describe('LAFT F5 · /laft/audit-plan', () => {
  it('admin crea plan interna → 201', async () => {
    insertMock.mockReturnValueOnce({
      values: () => ({ returning: () => Promise.resolve([{
        id: 1, anio: 2026, tipo: 'interna', fechaPlanificada: '2026-12-01', estado: 'planeada',
      }]) }),
    });
    const r = await request(app).post('/api/laft/audit-plan').set('Authorization', await adminAuth())
      .send({ anio: 2026, tipo: 'interna', fechaPlanificada: '2026-12-01' });
    expect(r.status).toBe(201);
    expect(r.body.estado).toBe('planeada');
  });

  it('plan duplicado UNIQUE(anio,tipo) → 409', async () => {
    const dup: any = new Error('dup'); dup.code = '23505';
    insertMock.mockReturnValueOnce({
      values: () => ({ returning: () => Promise.reject(dup) }),
    });
    const r = await request(app).post('/api/laft/audit-plan').set('Authorization', await adminAuth())
      .send({ anio: 2026, tipo: 'interna', fechaPlanificada: '2026-12-01' });
    expect(r.status).toBe(409);
  });

  it('compliance puede crear plan → 201', async () => {
    insertMock.mockReturnValueOnce({
      values: () => ({ returning: () => Promise.resolve([{
        id: 2, anio: 2026, tipo: 'revisor_fiscal', estado: 'planeada',
      }]) }),
    });
    const tok = await testToken({ role: 'compliance', sub: 5 });
    const r = await request(app).post('/api/laft/audit-plan').set('Authorization', `Bearer ${tok}`)
      .send({ anio: 2026, tipo: 'revisor_fiscal', fechaPlanificada: '2026-12-15' });
    expect(r.status).toBe(201);
  });

  it('proveedor sin permiso → 403', async () => {
    const tok = await testToken({ role: 'proveedor', sub: 5 });
    const r = await request(app).post('/api/laft/audit-plan').set('Authorization', `Bearer ${tok}`)
      .send({ anio: 2026, tipo: 'interna', fechaPlanificada: '2026-12-01' });
    expect(r.status).toBe(403);
  });

  it('PATCH actualiza estado → 200', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{
        id: 1, estado: 'en_ejecucion',
      }]) }) }),
    });
    const r = await request(app).patch('/api/laft/audit-plan/1').set('Authorization', await adminAuth())
      .send({ estado: 'en_ejecucion' });
    expect(r.status).toBe(200);
  });

  it('cerrar sin hallazgos → 422', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        select: vi.fn().mockReturnValueOnce(forUpdateChain([{
          id: 1, estado: 'en_ejecucion', hallazgosMd: null, conclusionesMd: null,
          evidenciaStorageKey: null, fechaEjecutada: null,
        }])),
        update: vi.fn(),
      };
      return cb(tx);
    });
    const r = await request(app).post('/api/laft/audit-plan/1/cerrar').set('Authorization', await adminAuth());
    expect(r.status).toBe(422);
  });

  it('cerrar con todos los campos → 200', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        select: vi.fn().mockReturnValueOnce(forUpdateChain([{
          id: 1, estado: 'en_ejecucion',
          hallazgosMd: 'h', conclusionesMd: 'c',
          evidenciaStorageKey: 'k', fechaEjecutada: '2026-12-15',
        }])),
        update: vi.fn().mockReturnValue({
          set: () => ({ where: () => ({ returning: () => Promise.resolve([{
            id: 1, estado: 'cerrada', fechaEjecutada: '2026-12-15',
          }]) }) }),
        }),
      };
      return cb(tx);
    });
    const r = await request(app).post('/api/laft/audit-plan/1/cerrar').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('cerrada');
  });

  it('cerrar plan ya cerrado → 409', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        select: vi.fn().mockReturnValueOnce(forUpdateChain([{ id: 1, estado: 'cerrada' }])),
        update: vi.fn(),
      };
      return cb(tx);
    });
    const r = await request(app).post('/api/laft/audit-plan/1/cerrar').set('Authorization', await adminAuth());
    expect(r.status).toBe(409);
  });

  it('GET lista paginado', async () => {
    selectMock.mockReturnValueOnce(chain([
      { id: 2, anio: 2026, tipo: 'interna', estado: 'planeada' },
      { id: 1, anio: 2025, tipo: 'revisor_fiscal', estado: 'cerrada' },
    ]));
    selectMock.mockReturnValueOnce(chain([{ count: 2 }]));
    const r = await request(app).get('/api/laft/audit-plan?limit=10').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(2);
  });
});
