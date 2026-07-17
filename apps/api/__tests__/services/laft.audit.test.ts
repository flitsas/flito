import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const insertMock = vi.fn();
const selectMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    insert: insertMock,
    select: selectMock,
    update: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

beforeEach(() => {
  insertMock.mockReset();
  selectMock.mockReset();
});

describe('laft/audit.service — laftAudit', () => {
  it('inserta entrada con userId+username+ip+userAgent del request', async () => {
    let captured: any = null;
    insertMock.mockReturnValueOnce({
      values: (v: any) => { captured = v; return Promise.resolve(undefined); },
    });

    const { laftAudit } = await import('../../src/modules/laft/audit.service.js');
    const fakeReq: any = {
      user: { sub: 7, username: 'compliance' },
      headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8', 'user-agent': 'Mozilla/5.0' },
      ip: '127.0.0.1',
    };
    await laftAudit(fakeReq, {
      action: 'block',
      resource: 'counterparty',
      resourceId: 42,
      before: { status: 'pendiente' },
      after: { status: 'bloqueada' },
    });

    expect(captured.userId).toBe(7);
    expect(captured.userUsername).toBe('compliance');
    expect(captured.action).toBe('block');
    expect(captured.resource).toBe('counterparty');
    expect(captured.resourceId).toBe('42'); // string-ificado
    expect(captured.beforeState).toEqual({ status: 'pendiente' });
    expect(captured.afterState).toEqual({ status: 'bloqueada' });
    // x-forwarded-for usa el primero (NO los siguientes — defensa contra spoofing)
    expect(captured.ipAddress).toBe('1.2.3.4');
    expect(captured.userAgent).toBe('Mozilla/5.0');
  });

  it('user anónimo (sin req.user) → userId/username null', async () => {
    let captured: any = null;
    insertMock.mockReturnValueOnce({
      values: (v: any) => { captured = v; return Promise.resolve(undefined); },
    });
    const { laftAudit } = await import('../../src/modules/laft/audit.service.js');
    await laftAudit({ headers: {} } as any, { action: 'list_check', resource: 'list_check' });
    expect(captured.userId).toBeNull();
    expect(captured.userUsername).toBeNull();
    expect(captured.resourceId).toBeNull();
    expect(captured.beforeState).toBeNull();
    expect(captured.afterState).toBeNull();
  });

  it('userAgent trunca a 500 chars (defensa contra log bomb)', async () => {
    let captured: any = null;
    insertMock.mockReturnValueOnce({
      values: (v: any) => { captured = v; return Promise.resolve(undefined); },
    });
    const { laftAudit } = await import('../../src/modules/laft/audit.service.js');
    await laftAudit({
      headers: { 'user-agent': 'A'.repeat(1000) },
    } as any, { action: 'x', resource: 'counterparty' });
    expect(captured.userAgent.length).toBe(500);
  });

  it('sin x-forwarded-for → fallback a req.ip', async () => {
    let captured: any = null;
    insertMock.mockReturnValueOnce({
      values: (v: any) => { captured = v; return Promise.resolve(undefined); },
    });
    const { laftAudit } = await import('../../src/modules/laft/audit.service.js');
    await laftAudit({ headers: {}, ip: '10.0.0.5' } as any, { action: 'x', resource: 'counterparty' });
    expect(captured.ipAddress).toBe('10.0.0.5');
  });

  it('insert throws → silencioso (no propaga, no rompe operación)', async () => {
    insertMock.mockReturnValueOnce({
      values: () => Promise.reject(new Error('BD down')),
    });
    const { laftAudit } = await import('../../src/modules/laft/audit.service.js');
    await expect(laftAudit({ headers: {} } as any, { action: 'x', resource: 'counterparty' }))
      .resolves.toBeUndefined();
  });
});

describe('laft/audit.routes — GET / (read-only audit log)', () => {
  async function buildApp() {
    const app = express();
    app.use(express.json());
    const { default: router } = await import('../../src/modules/laft/audit.routes.js');
    app.use('/api/laft/audit', router);
    return app;
  }

  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/laft/audit');
    expect(r.status).toBe(401);
  });

  it('rol proveedor → 403 (requireRole admin|compliance)', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/audit').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });

  it('compliance → 200 con rows + total + limit + offset', async () => {
    selectMock.mockReturnValueOnce(chain([
      { id: 1, action: 'block', resource: 'counterparty', resourceId: '42' },
    ]));
    selectMock.mockReturnValueOnce(chain([{ count: 100 }]));
    const token = await testToken({ sub: 1, role: 'compliance' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/audit').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.rows).toHaveLength(1);
    expect(r.body.total).toBe(100);
    expect(r.body.limit).toBe(100);
    expect(r.body.offset).toBe(0);
  });

  it('limit cap 500', async () => {
    let capturedLimit: number | null = null;
    selectMock.mockReturnValueOnce({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: (n: number) => {
              capturedLimit = n;
              return { offset: () => Promise.resolve([]) };
            },
          }),
        }),
      }),
    });
    selectMock.mockReturnValueOnce(chain([{ count: 0 }]));
    const token = await testToken({ sub: 1, role: 'compliance' });
    const app = await buildApp();
    await request(app).get('/api/laft/audit?limit=999').set('Authorization', `Bearer ${token}`);
    expect(capturedLimit).toBe(500);
  });

  it('filtros resource + resourceId aplican', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1 }]));
    selectMock.mockReturnValueOnce(chain([{ count: 1 }]));
    const token = await testToken({ sub: 1, role: 'compliance' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/audit?resource=counterparty&resourceId=42')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });
});
