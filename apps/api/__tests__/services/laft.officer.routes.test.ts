// LAFT F5 · officer.routes — designar (cierra anterior atómico) + revocar + exists.
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
  uploadEntityDocument: vi.fn().mockResolvedValue('laft/officer/1/key.pdf'),
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

describe('LAFT F5 · /laft/officer', () => {
  it('GET /exists sin oficial vigente → false/false', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const r = await request(app).get('/api/laft/officer/exists').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.principal).toBe(false);
    expect(r.body.suplente).toBe(false);
  });

  it('GET /exists con principal ISO 17024 → ok=true', async () => {
    selectMock.mockReturnValueOnce(chain([{ rol: 'principal', iso: true }]));
    const r = await request(app).get('/api/laft/officer/exists').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.principal).toBe(true);
    expect(r.body.principalIso17024).toBe(true);
  });

  it('GET /vigentes lista oficiales activos', async () => {
    selectMock.mockReturnValueOnce(chain([
      { id: 1, rol: 'principal', userName: 'Alice' },
      { id: 2, rol: 'suplente', userName: 'Bob' },
    ]));
    const r = await request(app).get('/api/laft/officer/vigentes').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(2);
  });

  it('compliance no puede designar (solo admin) → 403', async () => {
    const tok = await testToken({ role: 'compliance', sub: 9 });
    const r = await request(app).post('/api/laft/officer').set('Authorization', `Bearer ${tok}`)
      .field('userId', '5')
      .field('rol', 'principal')
      .field('certificacionIso17024', 'true')
      .field('validFrom', '2026-06-01');
    expect(r.status).toBe(403);
  });

  it('designar principal cierra al anterior atómicamente → 201', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 5, name: 'Alice' }])); // user existe
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const updateSpy = vi.fn().mockReturnValue({ set: () => ({ where: () => Promise.resolve(undefined) }) });
      const tx = {
        select: vi.fn().mockReturnValueOnce(forUpdateChain([{
          id: 99, rol: 'principal', validTo: null, revocadoAt: null,
        }])), // anterior vigente
        update: updateSpy,
        insert: vi.fn().mockReturnValue({
          values: () => ({ returning: () => Promise.resolve([{
            id: 100, userId: 5, rol: 'principal', validFrom: '2026-06-01', validTo: null,
          }]) }),
        }),
      };
      const result = await cb(tx);
      // El anterior debió recibir UPDATE con validTo = day_before(2026-06-01) = 2026-05-31
      expect(updateSpy).toHaveBeenCalled();
      return result;
    });
    const r = await request(app).post('/api/laft/officer').set('Authorization', await adminAuth())
      .field('userId', '5')
      .field('rol', 'principal')
      .field('certificacionIso17024', 'true')
      .field('validFrom', '2026-06-01');
    expect(r.status).toBe(201);
    expect(r.body.userId).toBe(5);
  });

  it('designar sin oficial previo → 201 sin update previo', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 5, name: 'Bob' }]));
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        select: vi.fn().mockReturnValueOnce(forUpdateChain([])), // no hay anterior
        update: vi.fn(),
        insert: vi.fn().mockReturnValue({
          values: () => ({ returning: () => Promise.resolve([{
            id: 1, userId: 5, rol: 'suplente', validFrom: '2026-06-01',
          }]) }),
        }),
      };
      return cb(tx);
    });
    const r = await request(app).post('/api/laft/officer').set('Authorization', await adminAuth())
      .field('userId', '5').field('rol', 'suplente').field('validFrom', '2026-06-01');
    expect(r.status).toBe(201);
  });

  it('userId inexistente → 404', async () => {
    selectMock.mockReturnValueOnce(chain([])); // user no existe
    const r = await request(app).post('/api/laft/officer').set('Authorization', await adminAuth())
      .field('userId', '999').field('rol', 'principal').field('validFrom', '2026-06-01');
    expect(r.status).toBe(404);
  });

  it('validFrom inválido → 400', async () => {
    const r = await request(app).post('/api/laft/officer').set('Authorization', await adminAuth())
      .field('userId', '5').field('rol', 'principal').field('validFrom', 'no-date');
    expect(r.status).toBe(400);
  });

  it('revocar oficial → 200', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{
        id: 99, revocadoAt: new Date(), revocadoMotivo: 'salida voluntaria',
      }]) }) }),
    });
    const r = await request(app).post('/api/laft/officer/99/revocar').set('Authorization', await adminAuth())
      .send({ motivo: 'salida voluntaria documentada' });
    expect(r.status).toBe(200);
  });

  it('revocar sin motivo → 400', async () => {
    const r = await request(app).post('/api/laft/officer/99/revocar').set('Authorization', await adminAuth())
      .send({ motivo: 'cor' });
    expect(r.status).toBe(400);
  });

  it('revocar inexistente → 404', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    });
    const r = await request(app).post('/api/laft/officer/9999/revocar').set('Authorization', await adminAuth())
      .send({ motivo: 'no existe oficial con ese id' });
    expect(r.status).toBe(404);
  });
});
