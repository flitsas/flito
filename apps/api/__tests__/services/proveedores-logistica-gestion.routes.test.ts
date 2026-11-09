// HU #14148 (Feature #14089) — impacto de un proveedor de logística. Servicio mockeado: permiso (403), validación (400) y
// mapeo HTTP. Las reglas de conteo y tope reales están en `db/flito-proveedores-logistica-gestion.test.ts` (PostgreSQL).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { testToken } from '../helpers/auth.js';

const m = vi.hoisted(() => ({
  impacto: vi.fn(), audit: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(),
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]) },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: m.audit }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const gestion = await import('../../src/modules/flito-parametrizacion/flito-proveedores-logistica-gestion.service.js');
vi.spyOn(gestion, 'impactoProveedorLogistica').mockImplementation(m.impacto);
const logistica = await import('../../src/modules/flito-parametrizacion/flito-proveedores-logistica.service.js');

beforeEach(() => { Object.values(m).forEach((f) => f.mockReset()); m.audit.mockResolvedValue(undefined); });

const ID = 'c0000000-0000-4000-8000-000000014148';
const BASE = '/api/flito/parametrizacion';
async function app() {
  const a = express(); a.use(express.json());
  a.use(`${BASE}/proveedores-logistica`, (await import('../../src/modules/flito-parametrizacion/flito-proveedores-logistica.routes.js')).default);
  a.use(BASE, (await import('../../src/modules/flito-parametrizacion/flito-parametrizacion.routes.js')).default);
  return a;
}
const con = (...funciones: string[]) => testToken({ sub: 1, role: 'admin', funciones }).then((t) => `Bearer ${t}`);
const sin = () => testToken({ sub: 2, role: 'financiera', funciones: ['clients.clientes.ver'] }).then((t) => `Bearer ${t}`);

describe('GET /proveedores-logistica/:id/impacto', () => {
  it('con la función de estado → { companias, nombres }', async () => {
    m.impacto.mockResolvedValue({ companias: 5, nombres: ['A', 'B', 'C'] });
    const r = await request(await app()).get(`${BASE}/proveedores-logistica/${ID}/impacto`).set('Authorization', await con('parametrizacion.proveedores.estado'));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ companias: 5, nombres: ['A', 'B', 'C'] });
  });
  it('sin la función → 403 y el servicio no se consulta', async () => {
    const r = await request(await app()).get(`${BASE}/proveedores-logistica/${ID}/impacto`).set('Authorization', await sin());
    expect(r.status).toBe(403);
    expect(m.impacto).not.toHaveBeenCalled();
  });
  it('id no uuid → 400; inexistente → 404', async () => {
    const t = await con('parametrizacion.proveedores.estado');
    expect((await request(await app()).get(`${BASE}/proveedores-logistica/xx/impacto`).set('Authorization', t)).status).toBe(400);
    const { ProveedorLogisticaNoEncontradoError } = logistica;
    m.impacto.mockRejectedValue(new ProveedorLogisticaNoEncontradoError());
    expect((await request(await app()).get(`${BASE}/proveedores-logistica/${ID}/impacto`).set('Authorization', t)).status).toBe(404);
  });
});
