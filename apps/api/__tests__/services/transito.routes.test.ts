import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();
const updateMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock,
    update: updateMock,
    insert: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
    execute: vi.fn().mockResolvedValue([]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

vi.mock('../../src/shared/middleware/audit.js', () => ({
  audit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../src/modules/tramites/eventos.js', () => ({
  emitEvento: vi.fn(),
}));

vi.mock('../../src/modules/tramites/notificaciones.js', () => ({
  notifyEstado: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/modules/vehicles/vehiculo-historial.js', () => ({
  appendEventoSafe: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  selectMock.mockReset();
  updateMock.mockReset();
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/tramites/transito.routes.js');
  app.use('/api/transito', router);
  return app;
}

/** Matriz TRAM-13 + TRAM-MT-01: scope por organismo. */
describe('transito — auth (TRAM-13)', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/transito/pendientes');
    expect(r.status).toBe(401);
  });

  it('rol proveedor → 403', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).get('/api/transito/pendientes').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });

  it('rol transito sin organismo → 403', async () => {
    selectMock.mockReturnValueOnce(chain([{ c: null }]));
    const token = await testToken({ sub: 7, role: 'transito' });
    const app = await buildApp();
    const r = await request(app).get('/api/transito/pendientes').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/organismo/i);
  });

  it('rol transito con organismo → 200 GET pendientes', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await testToken({ sub: 7, role: 'transito', transitoCodigo: '05001' });
    const app = await buildApp();
    const r = await request(app).get('/api/transito/pendientes').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
  });

  it('rol admin → 200 GET mis-tramites', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/transito/mis-tramites').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });
});

describe('transito — multitenant (TRAM-MT-01)', () => {
  it('tomar trámite de otro organismo → 403', async () => {
    const token = await testToken({ sub: 7, role: 'transito', transitoCodigo: '05001' });
    selectMock.mockReturnValueOnce(chain([{ estado: 'enviado_transito', organismoCodigo: '05266' }]));
    const app = await buildApp();
    const r = await request(app).post('/api/transito/tomar/99').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/otro organismo/i);
  });

  it('tomar trámite del mismo organismo → 200', async () => {
    const token = await testToken({ sub: 7, role: 'transito', transitoCodigo: '05001' });
    selectMock.mockReturnValueOnce(chain([{ estado: 'enviado_transito', organismoCodigo: '05001' }]));
    updateMock.mockReturnValueOnce({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve([{ id: 99, estado: 'recibido_transito', organismoCodigo: '05001' }]),
        }),
      }),
    });
    const app = await buildApp();
    const r = await request(app).post('/api/transito/tomar/99').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('recibido_transito');
  });

  it('GET organismos → catálogo', async () => {
    const token = await testToken({ sub: 7, role: 'transito', transitoCodigo: '05001' });
    const app = await buildApp();
    const r = await request(app).get('/api/transito/organismos').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body.some((o: { codigo: string }) => o.codigo === '05001')).toBe(true);
  });

  it('GET traspasos — transito con organismo → 200', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 20, modalidadEntrada: 'traspaso', estado: 'radicado', organismoCodigo: '05001', numeroRadicado: 'TD-2026-00002' }]));
    const token = await testToken({ sub: 7, role: 'transito', transitoCodigo: '05001' });
    const app = await buildApp();
    const r = await request(app).get('/api/transito/traspasos').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
  });
});
