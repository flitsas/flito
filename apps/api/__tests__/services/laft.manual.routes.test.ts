// LAFT F5 · manual.routes — flujo create→firmar→publicar + WORM trigger.
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
    select: selectMock, insert: insertMock, update: updateMock, transaction: transactionMock,
    execute: executeMock, delete: vi.fn(),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

vi.mock('../../src/modules/laft/audit.service.js', () => ({
  laftAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/services/storage.js', () => ({
  uploadEntityDocument: vi.fn().mockResolvedValue('laft/manual/1/key.pdf'),
  getEntityDocumentStream: vi.fn().mockResolvedValue({ pipe: () => undefined }),
}));

vi.mock('../../src/modules/laft/manual/pdf-builder.js', () => ({
  buildManualPdf: vi.fn().mockResolvedValue(Buffer.from('PDF')),
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

describe('LAFT F5 · /laft/manual', () => {
  it('admin crea borrador → 201 con version=1', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        execute: vi.fn().mockResolvedValue([{ next: 1 }]),
        insert: vi.fn().mockReturnValue({
          values: () => ({ returning: () => Promise.resolve([{
            id: 1, version: 1, titulo: 'Manual SARLAFT', contenidoMd: 'x'.repeat(50),
            sha256: 'abc', publicado: false, motivoCambio: null,
          }]) }),
        }),
      };
      return cb(tx);
    });
    updateMock.mockReturnValue({ set: () => ({ where: () => Promise.resolve(undefined) }) });
    const r = await request(app).post('/api/laft/manual').set('Authorization', await adminAuth())
      .send({ titulo: 'Manual SARLAFT v1', contenidoMd: 'x'.repeat(50) });
    expect(r.status).toBe(201);
    expect(r.body.version).toBe(1);
  });

  it('compliance no puede CREAR (solo admin) → 403', async () => {
    const tok = await testToken({ role: 'compliance', sub: 7 });
    const r = await request(app).post('/api/laft/manual').set('Authorization', `Bearer ${tok}`)
      .send({ contenidoMd: 'x'.repeat(50) });
    expect(r.status).toBe(403);
  });

  it('payload corto contenidoMd < 20 → 400', async () => {
    const r = await request(app).post('/api/laft/manual').set('Authorization', await adminAuth())
      .send({ contenidoMd: 'corto' });
    expect(r.status).toBe(400);
  });

  it('firmar representante (1ra firma) → 200 sin firmadoAt', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        select: vi.fn().mockReturnValueOnce(forUpdateChain([{
          id: 1, version: 1, publicado: false,
          firmadoPorRepresentante: null, firmadoPorOficial: null, firmadoAt: null,
          contenidoMd: 'x', titulo: 't', motivoCambio: null,
        }])),
        update: vi.fn().mockReturnValue({
          set: () => ({ where: () => ({ returning: () => Promise.resolve([{
            id: 1, version: 1, firmadoPorRepresentante: 1, firmadoPorOficial: null, firmadoAt: null,
          }]) }) }),
        }),
      };
      return cb(tx);
    });
    selectMock.mockReturnValueOnce(chain([{ id: 1, name: 'Admin', role: 'admin' }])); // signer
    const r = await request(app).post('/api/laft/manual/1/firmar').set('Authorization', await adminAuth())
      .send({ rol: 'representante' });
    expect(r.status).toBe(200);
    expect(r.body.firmadoPorRepresentante).toBe(1);
  });

  it('firmar oficial (2da firma) → setea firmadoAt', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        select: vi.fn().mockReturnValueOnce(forUpdateChain([{
          id: 1, version: 1, publicado: false,
          firmadoPorRepresentante: 99, firmadoPorOficial: null, firmadoAt: null,
          contenidoMd: 'x', titulo: 't', motivoCambio: null,
        }])),
        update: vi.fn().mockReturnValue({
          set: (data: any) => {
            expect(data.firmadoAt).toBeInstanceOf(Date);
            return { where: () => ({ returning: () => Promise.resolve([{ id: 1, ...data }]) }) };
          },
        }),
      };
      return cb(tx);
    });
    selectMock.mockReturnValue(chain([{ id: 1, name: 'X', role: 'compliance' }]));
    const tok = await testToken({ role: 'compliance', sub: 5 });
    const r = await request(app).post('/api/laft/manual/1/firmar').set('Authorization', `Bearer ${tok}`)
      .send({ rol: 'oficial' });
    expect(r.status).toBe(200);
  });

  it('firmar versión publicada → 409 (WORM)', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        select: vi.fn().mockReturnValueOnce(forUpdateChain([{ id: 1, publicado: true }])),
        update: vi.fn(),
      };
      return cb(tx);
    });
    const r = await request(app).post('/api/laft/manual/1/firmar').set('Authorization', await adminAuth())
      .send({ rol: 'oficial' });
    expect(r.status).toBe(409);
  });

  it('publicar sin ambas firmas → 409', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        select: vi.fn().mockReturnValueOnce(forUpdateChain([{
          id: 1, publicado: false, firmadoPorRepresentante: 1, firmadoPorOficial: null,
        }])),
        update: vi.fn(),
      };
      return cb(tx);
    });
    const r = await request(app).post('/api/laft/manual/1/publicar').set('Authorization', await adminAuth());
    expect(r.status).toBe(409);
  });

  it('publicar con ambas firmas → 200', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        select: vi.fn().mockReturnValueOnce(forUpdateChain([{
          id: 1, publicado: false, firmadoPorRepresentante: 1, firmadoPorOficial: 2,
        }])),
        update: vi.fn().mockReturnValue({
          set: () => ({ where: () => ({ returning: () => Promise.resolve([{
            id: 1, publicado: true, version: 1, publicadoAt: new Date(),
          }]) }) }),
        }),
      };
      return cb(tx);
    });
    const r = await request(app).post('/api/laft/manual/1/publicar').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.publicado).toBe(true);
  });

  it('intento update post-publicación → trigger BD lanza P0001 → 500', async () => {
    transactionMock.mockImplementationOnce(async () => {
      const err: any = new Error('Manual SARLAFT versión publicada es WORM — crear nueva versión');
      err.code = 'P0001';
      throw err;
    });
    const r = await request(app).post('/api/laft/manual/1/firmar').set('Authorization', await adminAuth())
      .send({ rol: 'oficial' });
    expect([409, 500]).toContain(r.status); // 500 si propaga, 409 si lo capturamos.
  });

  it('GET /vigente sin manual publicado → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const r = await request(app).get('/api/laft/manual/vigente').set('Authorization', await adminAuth());
    expect(r.status).toBe(404);
  });

  it('GET / lista versiones', async () => {
    selectMock.mockReturnValueOnce(chain([
      { id: 2, version: 2, publicado: true },
      { id: 1, version: 1, publicado: true },
    ]));
    const r = await request(app).get('/api/laft/manual').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(2);
  });
});
