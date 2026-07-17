// TRAM-INNOV-B3 — firma.routes (solicitar/listar) + webhook HMAC.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import crypto from 'crypto';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken } from '../helpers/auth.js';

const kdb = createKeyedDb();

afterEach(() => { delete process.env.FIRMA_WEBHOOK_SECRET; });

vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

beforeEach(() => { kdb.reset(); });

async function buildFirmaApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/firma/firma.routes.js');
  app.use('/api/tramites', router);
  return app;
}

describe('POST /tramites/:id/firma/solicitar', () => {
  it('sin token → 401', async () => {
    const app = await buildFirmaApp();
    const r = await request(app).post('/api/tramites/7/firma/solicitar').send({ rol: 'comprador' });
    expect(r.status).toBe(401);
  });

  it('rol transito → 403 (solo admin)', async () => {
    const token = await testToken({ sub: 4, role: 'transito', transitoCodigo: '05001' });
    const app = await buildFirmaApp();
    const r = await request(app).post('/api/tramites/7/firma/solicitar').set('Authorization', `Bearer ${token}`).send({ rol: 'comprador' });
    expect(r.status).toBe(403);
  });

  it('body inválido (sin rol) → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildFirmaApp();
    const r = await request(app).post('/api/tramites/7/firma/solicitar').set('Authorization', `Bearer ${token}`).send({});
    expect(r.status).toBe(400);
  });

  it('tipología no traspaso_standard → 400 con code', async () => {
    kdb.when.select('tramites_digitales', [{ id: 7, tipologiaCodigo: 'sucesion' }]);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildFirmaApp();
    const r = await request(app).post('/api/tramites/7/firma/solicitar').set('Authorization', `Bearer ${token}`).send({ rol: 'comprador' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('tipologia_invalida');
  });

  it('idempotencia: firma activa → 409 duplicada', async () => {
    kdb.when
      .select('tramites_digitales', [{ id: 7, tipologiaCodigo: 'traspaso_standard' }])
      .select('tramite_participantes', [{ id: 11, nombre: 'Ana', email: 'ana@x.co', rol: 'comprador' }])
      .select('tramite_firmas', [{ id: 1 }]);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildFirmaApp();
    const r = await request(app).post('/api/tramites/7/firma/solicitar').set('Authorization', `Bearer ${token}`).send({ rol: 'comprador' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('duplicada');
  });

  it('happy path → 201 firma + signUrl', async () => {
    kdb.when
      .select('tramites_digitales', [{ id: 7, tipologiaCodigo: 'traspaso_standard' }])
      .select('tramite_participantes', [{ id: 11, nombre: 'Ana', email: 'ana@x.co', rol: 'comprador' }])
      .select('tramite_firmas', [])
      .insert('tramite_firmas', [{ id: 1, tramiteId: 7, rol: 'comprador', docTipo: 'compraventa', proveedor: 'mock', envelopeId: 'env_1', estado: 'enviada', solicitadoAt: new Date(), firmadoAt: null }])
      .insert('tramite_eventos', []);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildFirmaApp();
    const r = await request(app).post('/api/tramites/7/firma/solicitar').set('Authorization', `Bearer ${token}`).send({ rol: 'comprador' });
    expect(r.status).toBe(201);
    expect(r.body.firma.estado).toBe('enviada');
    expect(typeof r.body.signUrl).toBe('string');
  });

  it('GET lista firmas (admin) → 200', async () => {
    kdb.when.select('tramite_firmas', [{ id: 1, tramiteId: 7, rol: 'comprador', estado: 'enviada' }]);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildFirmaApp();
    const r = await request(app).get('/api/tramites/7/firma').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.firmas)).toBe(true);
  });
});

describe('POST /webhooks/firma/:proveedor (HMAC)', () => {
  async function buildWebhookApp() {
    const { default: router } = await import('../../src/modules/firma/webhook.routes.js');
    const app = express();
    app.use('/api/webhooks/firma', express.raw({ type: '*/*' }));
    app.use('/api/webhooks/firma', router);
    return app;
  }

  it('sin FIRMA_WEBHOOK_SECRET → 503', async () => {
    delete process.env.FIRMA_WEBHOOK_SECRET;
    vi.resetModules();
    const app = await buildWebhookApp();
    const r = await request(app).post('/api/webhooks/firma/mock').set('content-type', 'application/json').send(JSON.stringify({ envelopeId: 'x', evento: 'firmada' }));
    expect(r.status).toBe(503);
  });

  it('HMAC inválido → 401', async () => {
    process.env.FIRMA_WEBHOOK_SECRET = 'whsec_test';
    vi.resetModules();
    const app = await buildWebhookApp();
    const r = await request(app).post('/api/webhooks/firma/mock').set('content-type', 'application/json').set('x-firma-signature', 'deadbeef').send(JSON.stringify({ envelopeId: 'x', evento: 'firmada' }));
    expect(r.status).toBe(401);
  });

  it('HMAC válido → 200 firmada', async () => {
    process.env.FIRMA_WEBHOOK_SECRET = 'whsec_test';
    vi.resetModules();
    kdb.when
      .select('tramite_firmas', [{ id: 1, tramiteId: 7, rol: 'comprador', docTipo: 'compraventa', proveedor: 'mock', envelopeId: 'env_x', estado: 'enviada', pdfPath: null, sha256: null }])
      .update('tramite_firmas', [{ id: 1, tramiteId: 7, rol: 'comprador', estado: 'firmada', firmadoAt: new Date() }])
      .insert('tramite_eventos', []);
    const app = await buildWebhookApp();
    const body = JSON.stringify({ envelopeId: 'env_x', evento: 'firmada' });
    const sig = crypto.createHmac('sha256', 'whsec_test').update(Buffer.from(body)).digest('hex');
    const r = await request(app).post('/api/webhooks/firma/mock').set('content-type', 'application/json').set('x-firma-signature', sig).send(body);
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('firmada');
  });
});
