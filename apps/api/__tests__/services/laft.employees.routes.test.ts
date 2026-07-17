import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();
const updateMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock,
    update: updateMock,
    transaction: transactionMock,
    insert: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const checkAllListsMock = vi.fn();
const decideFromMatchesMock = vi.fn();
vi.mock('../../src/modules/laft/match.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/laft/match.service.js')>();
  return { ...actual, checkAllLists: checkAllListsMock, decideFromMatches: decideFromMatchesMock };
});

const laftAuditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/modules/laft/audit.service.js', () => ({ laftAudit: laftAuditMock }));

vi.mock('express-rate-limit', () => ({
  default: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

beforeEach(() => {
  selectMock.mockReset();
  updateMock.mockReset();
  transactionMock.mockReset();
  checkAllListsMock.mockReset().mockResolvedValue([]);
  decideFromMatchesMock.mockReset().mockReturnValue({ shouldBlock: false, reason: null, needsReview: false, bindingMatches: [] });
  laftAuditMock.mockClear();
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/laft/employees/employees.routes.js');
  app.use('/api/laft/employees', router);
  return app;
}

const VALID_KYC = {
  factorPersona: { value: 1 },
  factorCanal: { value: 1 },
  factorZona: { value: 1 },
  pep: false,
};

describe('laft/employees — auth', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/laft/employees');
    expect(r.status).toBe(401);
  });

  it('proveedor → 403', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/employees').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });
});

describe('GET /api/laft/employees — listado', () => {
  it('compliance + sin filtros → 200', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, userId: 10, riskLevel: 'bajo' }]));
    selectMock.mockReturnValueOnce(chain([{ count: 1 }]));
    const token = await testToken({ sub: 1, role: 'compliance' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/employees').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(1);
    expect(r.body.rows).toHaveLength(1);
  });
});

describe('POST /api/laft/employees/:userId/kyc — happy path', () => {
  it('crea KYC para empleado, sin match → 201 + audit', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        select: vi.fn(() => ({
          from: () => ({
            where: () => ({
              for: () => ({
                limit: () => Promise.resolve([{ id: 10, name: 'Juan', username: 'jperez' }]),
              }),
            }),
          }),
        })),
        insert: vi.fn(() => ({
          values: (v: any) => ({
            returning: () => Promise.resolve([{
              id: 100, ...v, version: 1, createdAt: new Date(), updatedAt: new Date(),
            }]),
          }),
        })),
        update: vi.fn(),
      };
      return cb(tx);
    });

    const token = await testToken({ sub: 7, role: 'admin' });
    const app = await buildApp();
    const r = await request(app)
      .post('/api/laft/employees/10/kyc')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'kyc-emp-10-aaaaaaaa')
      .send(VALID_KYC);
    expect(r.status).toBe(201);
    expect(r.body.userId).toBe(10);
    expect(r.body.matchBlocked).toBe(false);
    expect(r.body.riskLevel).toBe('bajo'); // 1+1+1=3 → bajo
    expect(laftAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'create_employee_kyc' }),
    );
  });

  it('match en lista vinculante → matchBlocked=true + auto_block audit + bumpea session', async () => {
    checkAllListsMock.mockResolvedValueOnce([
      { listId: 1, listCode: 'OFAC', listName: 'OFAC SDN', binding: true, score: 100, kind: 'doc_exact', entryId: 9, entryName: 'Juan', entryDoc: 'jperez' },
    ]);
    decideFromMatchesMock.mockReturnValueOnce({
      shouldBlock: true, reason: 'doc_exact OFAC', needsReview: false, bindingMatches: [],
    });

    const sessionUpdate: { called: boolean } = { called: false };
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        select: vi.fn(() => ({
          from: () => ({
            where: () => ({
              for: () => ({
                limit: () => Promise.resolve([{ id: 10, name: 'Juan', username: 'jperez' }]),
              }),
            }),
          }),
        })),
        insert: vi.fn(() => ({
          values: (v: any) => ({
            returning: () => Promise.resolve([{ id: 100, ...v, version: 1 }]),
          }),
        })),
        update: vi.fn(() => ({
          set: () => ({
            where: () => { sessionUpdate.called = true; return Promise.resolve(undefined); },
          }),
        })),
      };
      return cb(tx);
    });

    const token = await testToken({ sub: 7, role: 'admin' });
    const app = await buildApp();
    const r = await request(app)
      .post('/api/laft/employees/10/kyc')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'kyc-emp-10-bbbbbbbb')
      .send(VALID_KYC);
    expect(r.status).toBe(201);
    expect(r.body.matchBlocked).toBe(true);
    expect(sessionUpdate.called).toBe(true); // session_invalidated_at bumpeado
    expect(laftAuditMock).toHaveBeenCalledTimes(2);
    expect(laftAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'employee_auto_block' }),
    );
  });

  it('userId no encontrado → 404', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        select: vi.fn(() => ({
          from: () => ({ where: () => ({ for: () => ({ limit: () => Promise.resolve([]) }) }) }),
        })),
        insert: vi.fn(),
        update: vi.fn(),
      };
      return cb(tx);
    });

    const token = await testToken({ sub: 7, role: 'admin' });
    const app = await buildApp();
    const r = await request(app)
      .post('/api/laft/employees/9999/kyc')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'kyc-emp-9999aaaa')
      .send(VALID_KYC);
    expect(r.status).toBe(404);
  });

  it('Idempotency-Key faltante → 400', async () => {
    const token = await testToken({ sub: 7, role: 'admin' });
    const app = await buildApp();
    const r = await request(app)
      .post('/api/laft/employees/10/kyc')
      .set('Authorization', `Bearer ${token}`)
      .send(VALID_KYC);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Idempotency-Key/i);
  });

  it('PEP=true sin pepDetalle → 400', async () => {
    const token = await testToken({ sub: 7, role: 'admin' });
    const app = await buildApp();
    const r = await request(app)
      .post('/api/laft/employees/10/kyc')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'kyc-emp-10-pepfail')
      .send({ ...VALID_KYC, pep: true });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/pepDetalle/i);
  });
});

describe('PATCH /api/laft/employees/:userId — optimistic lock', () => {
  it('version mismatch → 409', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 1, userId: 10, version: 5, factorPersona: null, factorCanal: null, factorZona: null,
      pep: false, antecedentesResultado: null, riskLevel: 'bajo', matchBlocked: false,
    }]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app)
      .patch('/api/laft/employees/10')
      .set('Authorization', `Bearer ${token}`)
      .send({ pep: true, pepDetalle: 'X', version: 1 });
    expect(r.status).toBe(409);
  });
});

describe('GET /api/laft/employees/:userId — detalle', () => {
  it('no existe → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/employees/999').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
  });

  it('encontrado → 200', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, userId: 10, riskLevel: 'bajo', matchBlocked: false }]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/employees/10').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.userId).toBe(10);
  });
});
