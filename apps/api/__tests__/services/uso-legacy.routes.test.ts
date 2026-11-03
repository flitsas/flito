// HU #13989 (ADR-0033 §4, AC3) — GET /api/uso-legacy. R1–R4 de la lista del ADR, sobre la app real.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { chain } from '../helpers/db.js';
import { registrarUsuarioDePrueba, testToken } from '../helpers/auth.js';

vi.hoisted(() => { process.env.USO_LEGACY_CONTEO_ENABLED = '1'; });

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: vi.fn(), selectDistinct: vi.fn(), insert: vi.fn(() => chain([])), update: vi.fn(), delete: vi.fn(),
    execute: vi.fn().mockResolvedValue([]), transaction: vi.fn(),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/rateLimiter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/middleware/rateLimiter.js')>();
  const pasa = (_req: unknown, _res: unknown, next: () => void) => next();
  return { ...actual, apiLimiter: pasa, authLimiter: pasa, qrPublicLimiter: pasa };
});
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));

const { db } = await import('../../src/db/client.js');
const { hoyColombia } = await import('../../src/shared/utils/fecha-rango.js');

let app: Express;
let admin: string;

const fila = (i: number) => ({
  modulo: 'soat', ruta: `/api/soat/r${i}`, metodo: 'GET', consumidor: 'admin', total: 10, primerDia: '2026-10-01', ultimoDia: '2026-10-20',
});

beforeAll(async () => {
  const { createApp } = await import('../../src/app.js');
  app = createApp();
  admin = `Bearer ${await testToken({ sub: 88001, role: 'admin' })}`;
});
beforeEach(() => {
  vi.mocked(db.select).mockReset();
  vi.mocked(db.select).mockImplementation((() => chain([])) as never);
});

describe('R1 — admin consulta el uso agregado', () => {
  it('200 con filas, primerDia y ultimoDia, y con el rango pedido', async () => {
    vi.mocked(db.select).mockImplementation((() => chain([fila(1)])) as never);
    const r = await request(app).get('/api/uso-legacy?desde=2026-10-01&hasta=2026-10-20&modulo=soat').set('Authorization', admin);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ desde: '2026-10-01', hasta: '2026-10-20', filas: [fila(1)], truncado: false });
  });

  it('92 días exactos pasan', async () => {
    const r = await request(app).get('/api/uso-legacy?desde=2026-08-01&hasta=2026-10-31').set('Authorization', admin);
    expect(r.status).toBe(200);
  });
});

describe('R2 — guarda', () => {
  it('sin token → 401', async () => {
    expect((await request(app).get('/api/uso-legacy')).status).toBe(401);
  });

  it('sin la función → 403', async () => {
    const auth = `Bearer ${await testToken({ sub: 88002, role: 'contable' })}`;
    await registrarUsuarioDePrueba(88002, { rol: 'contable', tipoEnlace: 'ninguno', funcionesDelRol: [], excepciones: [] });
    const r = await request(app).get('/api/uso-legacy').set('Authorization', auth);
    expect(r.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('con la función sin enlace → 200: decide `permisos.catalogo.ver`, no el rol', async () => {
    const auth = `Bearer ${await testToken({ sub: 88004, role: 'contable' })}`;
    await registrarUsuarioDePrueba(88004, { rol: 'contable', tipoEnlace: 'ninguno', funcionesDelRol: ['permisos.catalogo.ver'], excepciones: [] });
    expect((await request(app).get('/api/uso-legacy').set('Authorization', auth)).status).toBe(200);
  });

  it('enlace compañía, aun con la función → 403 de frontera', async () => {
    const auth = `Bearer ${await testToken({ sub: 88003, role: 'cliente' })}`;
    await registrarUsuarioDePrueba(88003, { rol: 'cliente', tipoEnlace: 'compania', funcionesDelRol: ['permisos.catalogo.ver'], excepciones: [] });
    const r = await request(app).get('/api/uso-legacy').set('Authorization', auth);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('Sin permisos');
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('R3 — validación', () => {
  it.each([
    ['fecha inválida', 'desde=2026-02-30&hasta=2026-03-01'],
    ['formato inválido', 'desde=03/11/2026'],
    ['desde > hasta', 'desde=2026-10-20&hasta=2026-10-01'],
    ['rango > 92 días', 'desde=2026-08-01&hasta=2026-11-01'],
    ['módulo desconocido', 'modulo=flito-soat'],
  ])('%s → 400 con { error }', async (_nombre, query) => {
    const r = await request(app).get(`/api/uso-legacy?${query}`).set('Authorization', admin);
    expect(r.status).toBe(400);
    expect(typeof r.body.error).toBe('string');
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('R4 — valores por defecto y tope', () => {
  it('sin parámetros → los últimos 28 días, con hasta = hoy en Colombia', async () => {
    const r = await request(app).get('/api/uso-legacy').set('Authorization', admin);
    expect(r.status).toBe(200);
    expect(r.body.hasta).toBe(hoyColombia());
    const dias = (Date.parse(r.body.hasta) - Date.parse(r.body.desde)) / 86_400_000 + 1;
    expect(dias).toBe(28);
    expect(r.body.truncado).toBe(false);
  });

  it('con 2001 filas → 2000 y `truncado`', async () => {
    vi.mocked(db.select).mockImplementation((() => chain(Array.from({ length: 2001 }, (_, i) => fila(i)))) as never);
    const r = await request(app).get('/api/uso-legacy').set('Authorization', admin);
    expect(r.body.filas).toHaveLength(2000);
    expect(r.body.truncado).toBe(true);
  });
});
