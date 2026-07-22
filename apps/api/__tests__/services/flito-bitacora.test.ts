// FLITO Bitácora (Fase 5 P4). Consulta de solo lectura sobre audit_logs restringida al dominio FLITO;
// mapea userEmail→actorNombre. Operaciones/Auditoría leen; los gestores no.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const { default: bitacoraRoutes } = await import('../../src/modules/flito-bitacora/flito-bitacora.routes.js');

const app = express();
app.use(express.json());
app.use('/api/flito/bitacora', bitacoraRoutes);

beforeEach(() => { selectMock.mockReset(); });

const fila = (over: Record<string, unknown> = {}) => ({
  id: 1, userId: 7, userEmail: 'op@flitsas.io', action: 'update', resource: 'flito_soat',
  resourceId: 's1', detail: 'algo', ipAddress: null, userAgent: null, createdAt: new Date('2026-07-10T00:00:00Z'), ...over,
});

describe('GET / — registros del dominio FLITO', () => {
  it('mapea userEmail→actorNombre y devuelve los items', async () => {
    selectMock.mockReturnValue(chain([fila()]));
    const token = await testToken({ role: 'admin' });
    const res = await request(app).get('/api/flito/bitacora').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ resource: 'flito_soat', resourceId: 's1', action: 'update', actorNombre: 'op@flitsas.io', actorId: 7, detalle: 'algo' });
  });

  it('Auditoría también puede leer', async () => {
    selectMock.mockReturnValue(chain([]));
    const token = await testToken({ role: 'auditor' });
    const res = await request(app).get('/api/flito/bitacora').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it('un gestor no entra (403)', async () => {
    const token = await testToken({ role: 'proveedor' });
    const res = await request(app).get('/api/flito/bitacora').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});

describe('GET /:resource/:resourceId — historia de una entidad', () => {
  it('recurso desconocido → 400', async () => {
    const token = await testToken({ role: 'admin' });
    const res = await request(app).get('/api/flito/bitacora/otra_cosa/x').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it('recurso FLITO válido → 200 con historia', async () => {
    selectMock.mockReturnValue(chain([fila({ resource: 'flito_tramite', resourceId: 't1' })]));
    const token = await testToken({ role: 'admin' });
    const res = await request(app).get('/api/flito/bitacora/flito_tramite/t1').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body[0].resource).toBe('flito_tramite');
  });
});
