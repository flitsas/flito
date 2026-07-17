// OPS-02b r2: mock KEYED por tabla. La generación de ROS encadena dos tablas
// distintas (laft_unusual_operations → laft_counterparties); migrado a keyed.
// `selectMock` etc. se conservan como alias drop-in para los SELECT únicos.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { laftCounterparty } from '../fixtures/laft/scenarios.js';
import { testToken } from '../helpers/auth.js';

const kdb = createKeyedDb();
const { select: selectMock, insert: insertMock, update: updateMock, transaction: transactionMock } = kdb;

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
  const { default: router } = await import('../../src/modules/laft/ros.routes.js');
  app.use('/api/laft/ros', router);
  return app;
}

describe('laft/ros — auth', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/laft/ros');
    expect(r.status).toBe(401);
  });

  it('proveedor → 403', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/ros').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });
});

describe('GET / — listado borradores', () => {
  it('compliance → 200 con listado', async () => {
    selectMock.mockReturnValueOnce(chain([
      { id: 1, operationId: 5, sirelRadicado: null, sentToUiafAt: null, counterpartyName: 'Juan' },
    ]));
    const token = await testToken({ sub: 1, role: 'compliance' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/ros').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body[0].counterpartyName).toBe('Juan');
  });
});

describe('GET /:id — detalle', () => {
  it('id no numérico → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/ros/abc').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('no encontrado → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/ros/99').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
  });
});

describe('POST /from-operation/:opId — generar ROS [keyed]', () => {
  it('id inválido → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/ros/from-operation/abc').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('operación no existe → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/ros/from-operation/99').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
  });

  it('operación con decisión != escalada/reportada → 400', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 1, decision: 'descartada', counterpartyId: null,
    }]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/ros/from-operation/1').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/escalada.*reportada/);
  });

  it('decisión "escalada" + sin counterpartyId → 201 con payload sin contraparte', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 1, decision: 'escalada', counterpartyId: null, source: 'manual', amount: '10000', currency: 'COP',
      detectedAt: new Date('2026-05-01'), description: 'X', signals: ['split'], analysisText: 'analisis',
    }]));
    let captured: any = null;
    insertMock.mockReturnValueOnce({
      values: (v: any) => { captured = v; return { returning: () => Promise.resolve([{ id: 9, ...v }]) }; },
    });
    const token = await testToken({ sub: 7, username: 'compliance', role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/ros/from-operation/1').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(201);
    expect(captured.operationId).toBe(1);
    expect(captured.generatedBy).toBe(7);
    expect(captured.sirelPayload.contraparte).toBeNull();
    expect(captured.sirelPayload.encabezado.tipo_reporte).toBe('ROS');
    expect(captured.sirelPayload.encabezado.empleado_cumplimiento).toBe('compliance');
    expect(laftAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'generate_ros_draft', resource: 'document' }),
    );
  });

  it('decisión "reportada" + counterpartyId → carga contraparte y embebe en payload', async () => {
    // Keyed: operación (laft_unusual_operations) + contraparte (laft_counterparties).
    kdb.when.select('laft_unusual_operations', [{
      id: 1, decision: 'reportada', counterpartyId: 42, source: 'auto', amount: '5000', currency: 'USD',
      detectedAt: new Date(), description: 'op', signals: [], analysisText: 'a',
    }]);
    kdb.when.select('laft_counterparties', laftCounterparty({
      id: 42, fullName: 'Juan', pepRole: 'Concejal', fundOrigin: 'Salario',
    }));
    let captured: any = null;
    insertMock.mockReturnValueOnce({
      values: (v: any) => { captured = v; return { returning: () => Promise.resolve([{ id: 10, ...v }]) }; },
    });
    const token = await testToken({ sub: 1, username: 'cump', role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/ros/from-operation/1').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(201);
    expect(captured.sirelPayload.contraparte).toMatchObject({
      tipo: 'natural', tipo_documento: 'CC', numero_documento: '900',
      nombre_completo: 'Juan', es_pep: true, cargo_pep: 'Concejal',
      nivel_riesgo: 'alto', estado_actual: 'pendiente',
    });
  });
});

describe('POST /:id/sent — marcar enviado al SIREL', () => {
  it('id inválido → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/ros/abc/sent').set('Authorization', `Bearer ${token}`)
      .send({ sirelRadicado: 'R-001' });
    expect(r.status).toBe(400);
  });

  it('sirelRadicado < 3 chars → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/ros/1/sent').set('Authorization', `Bearer ${token}`)
      .send({ sirelRadicado: 'AB' });
    expect(r.status).toBe(400);
  });

  it('UPDATE atómico devuelve fila → 200 + audit', async () => {
    let captured: any = null;
    updateMock.mockReturnValueOnce({
      set: (v: any) => {
        captured = v;
        return { where: () => ({ returning: () => Promise.resolve([{ id: 1, sirelRadicado: 'R-2026-01' }]) }) };
      },
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/ros/1/sent').set('Authorization', `Bearer ${token}`)
      .send({ sirelRadicado: 'R-2026-01', notes: 'enviado' });
    expect(r.status).toBe(200);
    expect(captured.sirelRadicado).toBe('R-2026-01');
    expect(captured.notes).toBe('enviado');
    expect(captured.sentToUiafAt).toBeInstanceOf(Date);
    expect(laftAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'mark_ros_sent' }),
    );
  });

  it('UPDATE atómico sin filas + record existe → 409 (ya enviado)', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    });
    selectMock.mockReturnValueOnce(chain([{ id: 1 }])); // existe
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/ros/1/sent').set('Authorization', `Bearer ${token}`)
      .send({ sirelRadicado: 'R-001' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/ya fue marcado/i);
  });

  it('UPDATE atómico sin filas + record no existe → 404', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    });
    selectMock.mockReturnValueOnce(chain([])); // no existe
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/ros/99/sent').set('Authorization', `Bearer ${token}`)
      .send({ sirelRadicado: 'R-001' });
    expect(r.status).toBe(404);
  });

  it('sentAt custom override del default new Date()', async () => {
    let captured: any = null;
    updateMock.mockReturnValueOnce({
      set: (v: any) => {
        captured = v;
        return { where: () => ({ returning: () => Promise.resolve([{ id: 1 }]) }) };
      },
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    await request(app).post('/api/laft/ros/1/sent').set('Authorization', `Bearer ${token}`)
      .send({ sirelRadicado: 'R-001', sentAt: '2026-01-15T10:00:00Z' });
    expect(captured.sentToUiafAt.toISOString()).toBe('2026-01-15T10:00:00.000Z');
  });
});

// ============================================================================
// F4: clasificar + sirel-radicado + SLA listing.
// ============================================================================

describe('POST /:id/clasificar — F4 SLA timer', () => {
  it('falta Idempotency-Key → 400', async () => {
    const token = await testToken({ sub: 1, role: 'compliance' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/ros/1/clasificar')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Idempotency-Key/);
  });

  it('ROS no existe → 404', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      return cb({
        select: () => chain([]),
        update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) }),
      });
    });
    const token = await testToken({ sub: 1, role: 'compliance' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/ros/99/clasificar')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'abcd1234efgh');
    expect(r.status).toBe(404);
  });

  it('clasificación nueva → setea sla_due_at = +24h y audita', async () => {
    let setSlaDue: Date | null = null;
    transactionMock.mockImplementationOnce(async (cb: any) => {
      return cb({
        select: () => chain([{ id: 1, clasificadoAt: null }]),
        update: () => ({
          set: (v: any) => {
            setSlaDue = v.slaDueAt;
            return { where: () => ({ returning: () => Promise.resolve([{ id: 1, ...v }]) }) };
          },
        }),
      });
    });
    const before = Date.now();
    const token = await testToken({ sub: 1, role: 'compliance' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/ros/1/clasificar')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'abcd1234efgh');
    expect(r.status).toBe(200);
    expect(setSlaDue).toBeInstanceOf(Date);
    const diffH = ((setSlaDue as unknown as Date).getTime() - before) / 3600_000;
    expect(diffH).toBeGreaterThanOrEqual(23.9);
    expect(diffH).toBeLessThanOrEqual(24.1);
    expect(laftAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'ros_clasificado' }),
    );
  });

  it('ROS ya clasificado → idempotente (200 sin nuevo audit)', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      return cb({
        select: () => chain([{ id: 1, clasificadoAt: new Date(), slaDueAt: new Date() }]),
        update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) }),
      });
    });
    const token = await testToken({ sub: 1, role: 'compliance' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/ros/1/clasificar')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'abcd1234efgh');
    expect(r.status).toBe(200);
    expect(laftAuditMock).not.toHaveBeenCalled();
  });
});

describe('POST /:id/sirel-radicado', () => {
  it('falta Idempotency-Key → 400', async () => {
    const token = await testToken({ sub: 1, role: 'compliance' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/ros/1/sirel-radicado')
      .set('Authorization', `Bearer ${token}`)
      .send({ sirelRadicado: 'R-2026-001' });
    expect(r.status).toBe(400);
  });

  it('ROS sin radicado → registra y cierra SLA', async () => {
    let captured: any = null;
    transactionMock.mockImplementationOnce(async (cb: any) => {
      return cb({
        select: () => chain([{ id: 1, sirelAcuseAt: null, sirelRadicado: null, sentToUiafAt: null, notes: null }]),
        update: () => ({
          set: (v: any) => { captured = v; return { where: () => ({ returning: () => Promise.resolve([{ id: 1, ...v }]) }) }; },
        }),
      });
    });
    const token = await testToken({ sub: 1, role: 'compliance' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/ros/1/sirel-radicado')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'abcd1234efgh')
      .send({ sirelRadicado: 'R-2026-001' });
    expect(r.status).toBe(200);
    expect(captured.sirelRadicado).toBe('R-2026-001');
    expect(captured.sirelAcuseAt).toBeInstanceOf(Date);
    expect(laftAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'ros_sirel_radicado' }),
    );
  });

  it('ROS ya con mismo radicado → 200 idempotente', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      return cb({
        select: () => chain([{ id: 1, sirelAcuseAt: new Date(), sirelRadicado: 'R-2026-001' }]),
        update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) }),
      });
    });
    const token = await testToken({ sub: 1, role: 'compliance' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/ros/1/sirel-radicado')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'abcd1234efgh')
      .send({ sirelRadicado: 'R-2026-001' });
    expect(r.status).toBe(200);
  });

  it('ROS con radicado distinto → 409', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      return cb({
        select: () => chain([{ id: 1, sirelAcuseAt: new Date(), sirelRadicado: 'R-2026-001' }]),
        update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) }),
      });
    });
    const token = await testToken({ sub: 1, role: 'compliance' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/ros/1/sirel-radicado')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'abcd1234efgh')
      .send({ sirelRadicado: 'R-DIFERENTE' });
    expect(r.status).toBe(409);
  });
});

describe('GET /sla/abiertos', () => {
  it('devuelve lista ordenada por sla_due_at', async () => {
    selectMock.mockReturnValueOnce(chain([
      { id: 1, slaDueAt: new Date('2026-05-08T20:00:00Z'), slaBreached: false, counterpartyName: 'A' },
      { id: 2, slaDueAt: new Date('2026-05-09T10:00:00Z'), slaBreached: false, counterpartyName: 'B' },
    ]));
    const token = await testToken({ sub: 1, role: 'compliance' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/ros/sla/abiertos')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(2);
    expect(r.body[0].counterpartyName).toBe('A');
  });
});
