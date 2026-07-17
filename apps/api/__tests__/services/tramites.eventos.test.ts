// TRAM-INNOV A2 — timeline del expediente + verificación pública (QR).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const { selectMock, insertMock, updateMock } = vi.hoisted(() => ({
  selectMock: vi.fn(), insertMock: vi.fn(), updateMock: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: insertMock, update: updateMock, delete: vi.fn(), execute: vi.fn().mockResolvedValue([]) },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

import { sha256, VERIFY_TOKEN_RE } from '../../src/modules/tramites/eventos.js';

describe('A2 · helpers', () => {
  it('sha256 determinístico (64 hex)', () => {
    const h = sha256(Buffer.from('hola mundo'));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256(Buffer.from('hola mundo'))).toBe(h);
  });
  it('VERIFY_TOKEN_RE acepta tokens url-safe largos y rechaza cortos', () => {
    expect(VERIFY_TOKEN_RE.test('a'.repeat(32))).toBe(true);
    expect(VERIFY_TOKEN_RE.test('short')).toBe(false);
    expect(VERIFY_TOKEN_RE.test('bad token!')).toBe(false);
  });
});

beforeEach(() => { selectMock.mockReset(); insertMock.mockReset(); updateMock.mockReset(); });

async function buildTramitesApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/tramites/tramites.routes.js');
  app.use('/api/tramites', router);
  return app;
}
async function buildPublicApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/tramites/verify.public.routes.js');
  app.use('/api/public/tramite-verificar', router);
  return app;
}

describe('GET /api/tramites/:id/timeline', () => {
  it('id inválido → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildTramitesApp();
    const r = await request(app).get('/api/tramites/0/timeline').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('devuelve eventos cronológicos', async () => {
    selectMock.mockReturnValueOnce(chain([
      { id: 1, tipo: 'creado', actorRole: 'admin', payload: { vin: 'ABC' }, docHash: null, createdAt: new Date('2026-01-01') },
      { id: 2, tipo: 'documento_subido', actorRole: 'admin', payload: { tipo: 'soat' }, docHash: 'a'.repeat(64), createdAt: new Date('2026-01-02') },
    ]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildTramitesApp();
    const r = await request(app).get('/api/tramites/5/timeline').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.eventos).toHaveLength(2);
    expect(r.body.eventos[1].docHash).toHaveLength(64);
  });
});

describe('POST /api/tramites/:id/verify-token', () => {
  it('trámite inexistente → 404', async () => {
    updateMock.mockReturnValueOnce({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildTramitesApp();
    const r = await request(app).post('/api/tramites/9/verify-token').set('Authorization', `Bearer ${token}`).send({});
    expect(r.status).toBe(404);
  });

  it('genera token url-safe + url + qrPng (data URI)', async () => {
    updateMock.mockReturnValueOnce({ set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 9 }]) }) }) });
    insertMock.mockReturnValueOnce({ values: () => Promise.resolve([]) }); // emitEvento
    const token = await testToken({ sub: 3, role: 'admin' });
    const app = await buildTramitesApp();
    const r = await request(app).post('/api/tramites/9/verify-token').set('Authorization', `Bearer ${token}`).send({});
    expect(r.status).toBe(200);
    expect(r.body.token).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(r.body.url).toContain('/tramite/verificar?t=');
    expect(r.body.qrPng).toMatch(/^data:image\/png;base64,/);
  });
});

describe('GET /api/public/tramite-verificar (sin auth)', () => {
  it('token inválido → 404 valido:false (no enumera)', async () => {
    const app = await buildPublicApp();
    const r = await request(app).get('/api/public/tramite-verificar?t=short');
    expect(r.status).toBe(404);
    expect(r.body.valido).toBe(false);
  });

  it('token válido → integridad sin PII completa (VIN enmascarado)', async () => {
    // 1) lookup del trámite vigente
    selectMock.mockReturnValueOnce(chain([{ id: 7, estado: 'enviado_transito', placa: 'ABC123', vin: 'MAZ123TEST456789', tipologia: 'traspaso_standard', expires: new Date('2030-01-01') }]));
    // 2) últimos 3 eventos
    selectMock.mockReturnValueOnce(chain([
      { tipo: 'enviado_transito', docHash: null, createdAt: new Date('2026-01-03') },
      { tipo: 'documento_subido', docHash: 'b'.repeat(64), createdAt: new Date('2026-01-02') },
    ]));
    const app = await buildPublicApp();
    const r = await request(app).get(`/api/public/tramite-verificar?t=${'a'.repeat(32)}`);
    expect(r.status).toBe(200);
    expect(r.body.valido).toBe(true);
    expect(r.body.vinMasked).toMatch(/6789$/);
    expect(r.body.vinMasked).not.toContain('MAZ');
    expect(r.body.eventos).toHaveLength(2);
    // No expone cédulas ni nombres (campos PII), solo tipo/hash/timestamp.
    expect(JSON.stringify(r.body)).not.toMatch(/"comprador"|"nombre"|"compradorDoc"|"vendedorDoc"/i);
    expect(r.body.eventos[0]).not.toHaveProperty('payload');
  });
});
