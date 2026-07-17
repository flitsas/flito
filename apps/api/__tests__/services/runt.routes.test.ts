import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { testToken } from '../helpers/auth.js';

// Mock service functions
const consultarVehiculoMock = vi.fn();
const consultarPersonaMock = vi.fn();
vi.mock('../../src/modules/runt/runt.service.js', () => ({
  consultarVehiculoRunt: consultarVehiculoMock,
  consultarPersonaRunt: consultarPersonaMock,
}));

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({
  audit: auditMock,
}));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

beforeEach(() => {
  consultarVehiculoMock.mockReset();
  consultarPersonaMock.mockReset();
  auditMock.mockClear();
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/runt/runt.routes.js');
  app.use('/api/runt', router);
  return app;
}

const adminToken = () => testToken({ sub: 1, role: 'admin' });

describe('runt — auth', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).post('/api/runt/consulta-vehiculo').send({ placa: 'ABC123' });
    expect(r.status).toBe(401);
  });
});

describe('POST /consulta-vehiculo', () => {
  it('sin placa ni vin → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/runt/consulta-vehiculo').set('Authorization', `Bearer ${token}`)
      .send({ documento: '123' });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/Placa o VIN/);
  });

  it('placa válida → 200 + audit', async () => {
    consultarVehiculoMock.mockResolvedValueOnce({ ok: true, data: { placa: 'ABC123' } });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/runt/consulta-vehiculo').set('Authorization', `Bearer ${token}`)
      .send({ placa: 'ABC123', documento: '123' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(auditMock).toHaveBeenCalled();
  });

  it('servicio throws → 500', async () => {
    consultarVehiculoMock.mockRejectedValueOnce(new Error('boom'));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/runt/consulta-vehiculo').set('Authorization', `Bearer ${token}`)
      .send({ placa: 'ABC123' });
    expect(r.status).toBe(500);
    expect(r.body.message).toMatch(/boom|RUNT/);
  });

  it('placa muy larga (>10) → 400 zod', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/runt/consulta-vehiculo').set('Authorization', `Bearer ${token}`)
      .send({ placa: 'ABCDEFGHIJK12345' });
    expect(r.status).toBe(400);
  });
});

describe('POST /consulta-persona', () => {
  it('sin documento → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/runt/consulta-persona').set('Authorization', `Bearer ${token}`)
      .send({});
    expect(r.status).toBe(400);
  });

  it('documento → 200 + audit con prefijo', async () => {
    consultarPersonaMock.mockResolvedValueOnce({ ok: true, data: { nombres: 'Juan' } });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/runt/consulta-persona').set('Authorization', `Bearer ${token}`)
      .send({ documento: '1040326572' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(auditMock.mock.calls[0][1].detail).toMatch(/1040/);
  });

  it('servicio throws → 500', async () => {
    consultarPersonaMock.mockRejectedValueOnce(new Error('timeout'));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/runt/consulta-persona').set('Authorization', `Bearer ${token}`)
      .send({ documento: '1040326572' });
    expect(r.status).toBe(500);
  });
});

describe('POST /ocr-cedula', () => {
  it('image too short → 400 (zod min 100)', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/runt/ocr-cedula').set('Authorization', `Bearer ${token}`)
      .send({ image: 'small', lado: 'frontal' });
    expect(r.status).toBe(400);
  });

  it('lado fuera enum → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/runt/ocr-cedula').set('Authorization', `Bearer ${token}`)
      .send({ image: 'a'.repeat(200), lado: 'lateral' });
    expect(r.status).toBe(400);
  });

  it('imagen >7MB clean → 400 (5MB limit)', async () => {
    // Construye un body que pase express.json (default 100kb) usando un app con limit alto
    const app = express();
    app.use(express.json({ limit: '20mb' }));
    const { default: router } = await import('../../src/modules/runt/runt.routes.js');
    app.use('/api/runt', router);
    const token = await adminToken();
    const r = await request(app).post('/api/runt/ocr-cedula').set('Authorization', `Bearer ${token}`)
      .send({ image: 'x'.repeat(8 * 1024 * 1024), lado: 'frontal' });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/5MB|max/i);
  });
});
