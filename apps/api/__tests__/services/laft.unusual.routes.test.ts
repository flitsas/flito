// OPS-02b r2: mock KEYED por tabla. El listado (rows + count) sobre
// laft_unusual_operations usa FIFO (`selectOnce`); `selectMock` se conserva como
// alias drop-in para los SELECT únicos.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken } from '../helpers/auth.js';

const kdb = createKeyedDb();
const { select: selectMock, insert: insertMock, update: updateMock } = kdb;

vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

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
  laftAuditMock.mockClear();
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/laft/unusual.routes.js');
  app.use('/api/laft/unusual', router);
  return app;
}

describe('laft/unusual — auth', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/laft/unusual');
    expect(r.status).toBe(401);
  });

  it('proveedor → 403', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/unusual').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });
});

describe('GET / — listado con filtros [keyed]', () => {
  it('compliance + decision válida → filtra', async () => {
    // rows + count sobre laft_unusual_operations → FIFO keyed.
    kdb.when.selectOnce('laft_unusual_operations', [{ id: 1 }]);
    kdb.when.selectOnce('laft_unusual_operations', [{ count: 1 }]);
    const token = await testToken({ sub: 1, role: 'compliance' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/unusual?decision=escalada')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.rows).toHaveLength(1);
    expect(r.body.total).toBe(1);
  });

  it('decision inválida → ignorada (no aplica filtro)', async () => {
    kdb.when.selectOnce('laft_unusual_operations', []);
    kdb.when.selectOnce('laft_unusual_operations', [{ count: 0 }]);
    const token = await testToken({ sub: 1, role: 'compliance' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/unusual?decision=hackeado')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });

  it('limit cap 200', async () => {
    let capturedLimit: number | null = null;
    selectMock.mockReturnValueOnce({
      from: () => ({
        leftJoin: () => ({
          where: () => ({
            orderBy: () => ({
              limit: (n: number) => { capturedLimit = n; return { offset: () => Promise.resolve([]) }; },
            }),
          }),
        }),
      }),
    });
    selectMock.mockReturnValueOnce(chain([{ count: 0 }]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    await request(app).get('/api/laft/unusual?limit=999').set('Authorization', `Bearer ${token}`);
    expect(capturedLimit).toBe(200);
  });
});

describe('GET /:id', () => {
  it('id inválido → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/unusual/0').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('no encontrado → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/unusual/99').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
  });

  it('encontrado → 200', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, decision: 'pendiente' }]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/unusual/1').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });
});

describe('POST / — crear señal de alerta', () => {
  const VALID = {
    source: 'manual',
    signals: ['split-payment'],
    description: 'Operación dividida en multiples pagos del mismo cliente',
    currency: 'COP',
  };

  it('signals vacío → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/unusual').set('Authorization', `Bearer ${token}`)
      .send({ ...VALID, signals: [] });
    expect(r.status).toBe(400);
  });

  it('description < 10 chars → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/unusual').set('Authorization', `Bearer ${token}`)
      .send({ ...VALID, description: 'corto' });
    expect(r.status).toBe(400);
  });

  it('counterpartyId pasado pero no existe → 400', async () => {
    selectMock.mockReturnValueOnce(chain([])); // contraparte no existe
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/unusual').set('Authorization', `Bearer ${token}`)
      .send({ ...VALID, counterpartyId: 999 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/contraparte no existe/i);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('éxito sin counterpartyId → 201 + audit', async () => {
    let captured: any = null;
    insertMock.mockReturnValueOnce({
      values: (v: any) => { captured = v; return { returning: () => Promise.resolve([{ id: 1, ...v, decision: 'pendiente' }]) }; },
    });
    const token = await testToken({ sub: 7, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/unusual').set('Authorization', `Bearer ${token}`)
      .send({ ...VALID, amount: 1500000 });
    expect(r.status).toBe(201);
    expect(captured.detectedBy).toBe(7);
    expect(captured.amount).toBe('1500000'); // numeric → string para drizzle decimal
    expect(captured.counterpartyId).toBeNull();
    expect(laftAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'create_unusual_operation', resource: 'document' }),
    );
  });
});

describe('PATCH /:id — análisis y decisión (optimistic lock)', () => {
  it('version mismatch → 409', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, version: 2, decision: 'pendiente', counterpartyId: null, decidedBy: null, decidedAt: null }]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/laft/unusual/1').set('Authorization', `Bearer ${token}`)
      .send({ decision: 'escalada', version: 1 });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/desactualizada/i);
  });

  it('decision="descartada" sin reason → 400 (requiere justificación)', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, version: 1, decision: 'pendiente', counterpartyId: 5, decidedBy: null, decidedAt: null }]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/laft/unusual/1').set('Authorization', `Bearer ${token}`)
      .send({ decision: 'descartada', version: 1 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/justificación/i);
  });

  it('decision="reportada" sin counterpartyId → 422 (SARLAFT requiere sujeto)', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, version: 1, decision: 'escalada', counterpartyId: null, decidedBy: null, decidedAt: null }]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/laft/unusual/1').set('Authorization', `Bearer ${token}`)
      .send({ decision: 'reportada', decisionReason: 'enviar', version: 1 });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/sin contraparte/i);
    expect(r.body.hint).toBeTruthy();
  });

  it('éxito: cambio de decisión actualiza decidedBy/decidedAt + version+1', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 1, version: 1, decision: 'pendiente', counterpartyId: 5,
      decidedBy: null, decidedAt: null, analysisText: null, decisionReason: null,
    }]));
    let captured: any = null;
    updateMock.mockReturnValueOnce({
      set: (v: any) => {
        captured = v;
        return { where: () => ({ returning: () => Promise.resolve([{ id: 1, ...v, decision: 'escalada' }]) }) };
      },
    });
    const token = await testToken({ sub: 7, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/laft/unusual/1').set('Authorization', `Bearer ${token}`)
      .send({ decision: 'escalada', analysisText: 'patrón sospechoso', version: 1 });
    expect(r.status).toBe(200);
    expect(captured.version).toBe(2);
    expect(captured.decidedBy).toBe(7); // cambio de decisión → set decidedBy
    expect(captured.decidedAt).toBeInstanceOf(Date);
    expect(captured.analysisText).toBe('patrón sospechoso');
  });

  it('mismo decision (no cambio) → preserva decidedBy/decidedAt previos', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 1, version: 1, decision: 'escalada', counterpartyId: 5,
      decidedBy: 99, decidedAt: new Date('2026-01-01'),
      analysisText: null, decisionReason: 'inicial',
    }]));
    let captured: any = null;
    updateMock.mockReturnValueOnce({
      set: (v: any) => { captured = v; return { where: () => ({ returning: () => Promise.resolve([{ id: 1, ...v }]) }) }; },
    });
    const token = await testToken({ sub: 7, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/laft/unusual/1').set('Authorization', `Bearer ${token}`)
      .send({ decision: 'escalada', analysisText: 'updated', version: 1 });
    expect(r.status).toBe(200);
    expect(captured.decidedBy).toBe(99); // preservado
    expect(captured.decidedAt).toEqual(new Date('2026-01-01'));
  });

  it('UPDATE atómico no devuelve fila → 409 concurrencia', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 1, version: 1, decision: 'pendiente', counterpartyId: 5,
      decidedBy: null, decidedAt: null, analysisText: null, decisionReason: null,
    }]));
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/laft/unusual/1').set('Authorization', `Bearer ${token}`)
      .send({ decision: 'escalada', version: 1 });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/concurrencia/i);
  });
});
