// OPS-02b r2: mock KEYED por tabla. El GET /:id corre `Promise.all` sobre dos
// tablas distintas (laft_counterparties + laft_beneficial_owners) — el caso clásico
// order-dependent; migrado a keyed. `selectMock`/`updateMock` se conservan como
// alias drop-in para los tests de un solo SELECT.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { laftCounterparty } from '../fixtures/laft/scenarios.js';
import { testToken } from '../helpers/auth.js';

const kdb = createKeyedDb();
const { select: selectMock, update: updateMock, transaction: transactionMock } = kdb;

vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const checkAllListsMock = vi.fn();
const decideFromMatchesMock = vi.fn();
vi.mock('../../src/modules/laft/match.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/laft/match.service.js')>();
  return {
    ...actual,
    checkAllLists: checkAllListsMock,
    decideFromMatches: decideFromMatchesMock,
  };
});

const laftAuditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/modules/laft/audit.service.js', () => ({
  laftAudit: laftAuditMock,
}));

vi.mock('express-rate-limit', () => ({
  default: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

beforeEach(() => {
  kdb.reset();
  checkAllListsMock.mockReset().mockResolvedValue([]);
  decideFromMatchesMock.mockReset().mockReturnValue({ shouldBlock: false, reason: null, needsReview: false, bindingMatches: [] });
  laftAuditMock.mockClear();
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/laft/counterparties.routes.js');
  app.use('/api/laft/counterparties', router);
  return app;
}

const VALID_PN = {
  kind: 'PN',
  docType: 'CC',
  docNumber: '900-123',
  fullName: 'Juan Pérez',
  fundOrigin: 'Salario mensual de empresa privada',
  factorCounterparty: 1, factorProduct: 1, factorChannel: 1, factorJurisdiction: 1,
};

const VALID_PJ = {
  kind: 'PJ',
  docType: 'NIT',
  docNumber: '900456',
  fullName: 'Empresa SAS',
  fundOrigin: 'Operación comercial regular',
  factorCounterparty: 2, factorProduct: 2, factorChannel: 2, factorJurisdiction: 2,
  beneficialOwners: [
    { docType: 'CC', docNumber: '111', fullName: 'Socio A', ownershipPct: 60 },
    { docType: 'CC', docNumber: '222', fullName: 'Socio B', ownershipPct: 40 },
  ],
};

describe('laft/counterparties — auth', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/laft/counterparties');
    expect(r.status).toBe(401);
  });

  it('proveedor → 403', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/counterparties').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });
});

describe('GET / — listado con filtros', () => {
  it('compliance + filtros válidos → 200 con paginación', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, fullName: 'Juan' }]));
    selectMock.mockReturnValueOnce(chain([{ count: 1 }]));
    const token = await testToken({ sub: 1, role: 'compliance' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/counterparties?status=vinculada&risk=alto&search=juan')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(1);
  });

  it('status fuera de enum → ignorado (no aplica)', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    selectMock.mockReturnValueOnce(chain([{ count: 0 }]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/counterparties?status=hackeado')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });
});

describe('GET /:id — detalle con beneficiarios [keyed]', () => {
  it('id no numérico → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/counterparties/abc').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('no encontrado → 404', async () => {
    // Promise.all sobre 2 tablas → keyed por tabla (orden irrelevante).
    kdb.when.select('laft_counterparties', []);
    kdb.when.select('laft_beneficial_owners', []);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/counterparties/999').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
  });

  it('encontrado → 200 con beneficialOwners adjuntos', async () => {
    kdb.when.select('laft_counterparties', laftCounterparty({ id: 1, fullName: 'X', kind: 'PJ' }));
    kdb.when.select('laft_beneficial_owners', [{ id: 10, counterpartyId: 1, fullName: 'Socio' }]);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/counterparties/1').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.beneficialOwners).toHaveLength(1);
  });
});

describe('POST / — crear (validaciones cruzadas + transaction)', () => {
  it('docNumber con caracteres no permitidos → 400 (regex zod)', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/counterparties').set('Authorization', `Bearer ${token}`)
      .send({ ...VALID_PN, docNumber: 'abc@!' });
    expect(r.status).toBe(400);
  });

  it('isPep=true sin pepRole/pepKinship → 400 (validación cruzada)', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/counterparties').set('Authorization', `Bearer ${token}`)
      .send({ ...VALID_PN, isPep: true });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/PEP.*cargo.*vínculo/i);
  });

  it('PJ sin beneficiarios → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/counterparties').set('Authorization', `Bearer ${token}`)
      .send({ ...VALID_PJ, beneficialOwners: [] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/beneficiario final/i);
  });

  it('PN exitoso → 201 con risk evaluado + audit', async () => {
    let cpInserted: any = null;
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        insert: vi.fn(() => ({
          values: (v: any) => {
            cpInserted = v;
            return { returning: () => Promise.resolve([{ id: 5, ...v, version: 1 }]) };
          },
        })),
        // F2: update post-insert para cifrar PII (mig 0063). Mock chainable set/where.
        update: vi.fn(() => ({
          set: () => ({ where: () => Promise.resolve(undefined) }),
        })),
      };
      return cb(tx);
    });
    const token = await testToken({ sub: 7, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/counterparties').set('Authorization', `Bearer ${token}`)
      .send(VALID_PN);
    expect(r.status).toBe(201);
    expect(cpInserted.docNumber).toBe('900123'); // normalizeDoc + uppercase
    expect(cpInserted.fullName).toBe('Juan Pérez'); // trimmed
    expect(cpInserted.riskLevel).toBe('bajo'); // 4 factores en 1 = score 4 → bajo
    expect(cpInserted.status).toBe('pendiente');
    expect(cpInserted.createdBy).toBe(7);
    expect(cpInserted.nextReviewAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.body.riskScore).toBe(4);
    expect(laftAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'create_counterparty' }),
    );
  });

  it('PJ con beneficiarios → inserta cp + tx.insert(beneficial_owners)', async () => {
    let beneficialInserted: any = null;
    let insertCallCount = 0;
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        insert: vi.fn(() => ({
          values: (v: any) => {
            insertCallCount++;
            if (insertCallCount === 1) {
              return { returning: () => Promise.resolve([{ id: 5, ...v, version: 1 }]) };
            }
            beneficialInserted = v;
            return Promise.resolve(undefined);
          },
        })),
        // F2: update post-insert para cifrar PII (mig 0063). Mock chainable set/where.
        update: vi.fn(() => ({
          set: () => ({ where: () => Promise.resolve(undefined) }),
        })),
      };
      return cb(tx);
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/counterparties').set('Authorization', `Bearer ${token}`)
      .send(VALID_PJ);
    expect(r.status).toBe(201);
    expect(beneficialInserted).toHaveLength(2);
    expect(beneficialInserted[0].counterpartyId).toBe(5);
    expect(beneficialInserted[0].ownershipPct).toBe('60'); // numeric → string
  });

  it('match en lista vinculante → auto-bloqueo en MISMA transaction + 2 audits', async () => {
    checkAllListsMock.mockResolvedValueOnce([
      { listId: 1, listCode: 'OFAC', listName: 'OFAC', binding: true, score: 100, kind: 'doc_exact', entryId: 9, entryName: 'X', entryDoc: '900123' },
    ]);
    decideFromMatchesMock.mockReturnValueOnce({
      shouldBlock: true, reason: 'doc_exact OFAC', needsReview: false, bindingMatches: [],
    });

    let updateInTxValues: any = null;
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        insert: vi.fn(() => ({
          values: () => ({ returning: () => Promise.resolve([{ id: 5, version: 1, docNumber: '900123', fullName: 'Juan' }]) }),
        })),
        update: vi.fn(() => ({
          set: (v: any) => {
            updateInTxValues = v;
            return { where: () => ({ returning: () => Promise.resolve([{ id: 5, version: 2, status: 'bloqueada' }]) }) };
          },
        })),
      };
      return cb(tx);
    });

    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/counterparties').set('Authorization', `Bearer ${token}`)
      .send(VALID_PN);
    expect(r.status).toBe(201);
    expect(updateInTxValues).toMatchObject({ status: 'bloqueada', blockReason: 'doc_exact OFAC', version: 2 });
    expect(r.body.listDecision.shouldBlock).toBe(true);
    expect(laftAuditMock).toHaveBeenCalledTimes(2);
    expect(laftAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'auto_block' }),
    );
  });

  it('error duplicate key (constraint) → 409', async () => {
    transactionMock.mockImplementationOnce(async () => {
      throw new Error('duplicate key value violates unique constraint laft_counterparties_doc_unique');
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/counterparties').set('Authorization', `Bearer ${token}`)
      .send(VALID_PN);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Ya existe contraparte/i);
  });

  it('error genérico en transaction → 500', async () => {
    transactionMock.mockImplementationOnce(async () => { throw new Error('BD down'); });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/counterparties').set('Authorization', `Bearer ${token}`)
      .send(VALID_PN);
    expect(r.status).toBe(500);
  });
});

describe('PATCH /:id — update con optimistic lock', () => {
  it('version mismatch → 409', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, version: 5, factorCounterparty: 1, factorProduct: 1, factorChannel: 1, factorJurisdiction: 1, riskLevel: 'bajo', status: 'pendiente' }]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/laft/counterparties/1').set('Authorization', `Bearer ${token}`)
      .send({ fullName: 'Nuevo', version: 1 });
    expect(r.status).toBe(409);
  });

  it('cambio de factores → recalcula riskLevel + nextReviewAt', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 1, version: 1, factorCounterparty: 1, factorProduct: 1, factorChannel: 1, factorJurisdiction: 1,
      riskLevel: 'bajo', status: 'pendiente',
    }]));
    let captured: any = null;
    updateMock.mockReturnValueOnce({
      set: (v: any) => { captured = v; return { where: () => ({ returning: () => Promise.resolve([{ id: 1, ...v }]) }) }; },
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/laft/counterparties/1').set('Authorization', `Bearer ${token}`)
      .send({ factorCounterparty: 3, factorProduct: 3, factorChannel: 3, factorJurisdiction: 3, version: 1 });
    expect(r.status).toBe(200);
    expect(captured.riskLevel).toBe('alto'); // 3+3+3+3=12
    expect(captured.version).toBe(2); // +1
    expect(captured.nextReviewAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('UPDATE atómico no devuelve fila → 409 concurrencia', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 1, version: 1, factorCounterparty: 1, factorProduct: 1, factorChannel: 1, factorJurisdiction: 1,
      riskLevel: 'bajo', status: 'pendiente',
    }]));
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/laft/counterparties/1').set('Authorization', `Bearer ${token}`)
      .send({ fullName: 'XX', version: 1 });
    expect(r.status).toBe(409);
  });
});

describe('POST /:id/status — cambio de estado', () => {
  it('status fuera de enum → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/counterparties/1/status').set('Authorization', `Bearer ${token}`)
      .send({ status: 'hackeado', version: 1 });
    expect(r.status).toBe(400);
  });

  it('no encontrado → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/counterparties/99/status').set('Authorization', `Bearer ${token}`)
      .send({ status: 'vinculada', version: 1 });
    expect(r.status).toBe(404);
  });

  it('status="bloqueada" sin reason → 400', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, version: 1, status: 'pendiente' }]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/counterparties/1/status').set('Authorization', `Bearer ${token}`)
      .send({ status: 'bloqueada', version: 1 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/motivo/i);
  });

  it('vincular exitoso → 200 + version+1 + audit status_vinculada', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, version: 1, status: 'pendiente' }]));
    let captured: any = null;
    updateMock.mockReturnValueOnce({
      set: (v: any) => { captured = v; return { where: () => ({ returning: () => Promise.resolve([{ id: 1, ...v }]) }) }; },
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/counterparties/1/status').set('Authorization', `Bearer ${token}`)
      .send({ status: 'vinculada', version: 1 });
    expect(r.status).toBe(200);
    expect(captured.status).toBe('vinculada');
    expect(captured.blockReason).toBeNull(); // status≠bloqueada → blockReason null
    expect(captured.version).toBe(2);
    expect(laftAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'status_vinculada' }),
    );
  });

  it('bloquear con motivo → blockReason persistido', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, version: 1, status: 'pendiente' }]));
    let captured: any = null;
    updateMock.mockReturnValueOnce({
      set: (v: any) => { captured = v; return { where: () => ({ returning: () => Promise.resolve([{ id: 1, ...v }]) }) }; },
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    await request(app).post('/api/laft/counterparties/1/status').set('Authorization', `Bearer ${token}`)
      .send({ status: 'bloqueada', reason: 'match OFAC manual', version: 1 });
    expect(captured.status).toBe('bloqueada');
    expect(captured.blockReason).toBe('match OFAC manual');
  });

  it('UPDATE atómico no devuelve fila → 409 concurrencia', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, version: 1, status: 'pendiente' }]));
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/counterparties/1/status').set('Authorization', `Bearer ${token}`)
      .send({ status: 'vinculada', version: 1 });
    expect(r.status).toBe(409);
  });
});
