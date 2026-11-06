// F4.2 (Feature #14326, HU #14351, #14353, ADR-0039 §6.4 y §6.5) — el contrato que fija el paso contract-first: la guarda
// `soloSinEnlaceOProveedor`, `esPropio` por proveedor y los dos stubs. Quien llene un stub cambia aquí su 501 por el 200.
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express, { type Request, type Response } from 'express';
import { chain } from '../helpers/db.js';
import { conAlcance } from '../helpers/frontera.js';
import { testToken } from '../helpers/auth.js';

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn().mockImplementation(() => chain([])), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));

const { default: logisticaRoutes } = await import('../../src/modules/flito-logistica/flito-logistica.routes.js');
const { soloSinEnlaceOProveedor } = await import('../../src/shared/middleware/frontera-enlace.js');
const { esPropio } = await import('../../src/shared/alcance-filas.js');

const ACTA = '14353000-0000-4000-8000-000000000001';
const appLogistica = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/flito/logistica', conAlcance('logistica', logisticaRoutes));
  return app;
};
const tokenCon = (funciones: string[]) => testToken({ role: 'operador_x', sub: 88, tipoEnlace: 'ninguno', funciones } as never);

describe('soloSinEnlaceOProveedor', () => {
  const pasar = (frontera?: unknown) => {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();
    soloSinEnlaceOProveedor()({ frontera } as unknown as Request, res as unknown as Response, next);
    return { res, next };
  };

  it.each(['ninguno', 'proveedor'])('deja pasar al enlace %s', (enlace) => {
    const { res, next } = pasar({ enlace, modulo: 'logistica' });
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each([['compania'], ['organismos_transito']])('cierra con 403 al enlace %s', (enlace) => {
    const { res, next } = pasar({ enlace, modulo: 'logistica' });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Sin permisos' });
  });

  it('falla cerrado si la frontera no decidió', () => {
    const { res, next } = pasar(undefined);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('lleva su marca para el centinela, distinta de la de `soloSinEnlace`', () => {
    const guarda = soloSinEnlaceOProveedor() as unknown as Record<string, unknown>;
    expect(guarda.fronteraSoloSinEnlaceOProveedor).toBe(true);
    expect(guarda.fronteraSoloSinEnlace).toBeUndefined();
  });
});

describe('esPropio con enlace proveedor', () => {
  const A = { enlace: 'proveedor', proveedorId: 'a' } as const;
  it('alcanza solo a su proveedor', () => {
    expect(esPropio(A, { proveedorId: 'a' })).toBe(true);
    expect(esPropio(A, { proveedorId: 'b' })).toBe(false);
  });
  it('sin dueño, o sin proveedor en el usuario, no es suyo', () => {
    expect(esPropio(A, { proveedorId: null })).toBe(false);
    expect(esPropio(A, { companiaId: 1 })).toBe(false);
    expect(esPropio({ enlace: 'proveedor', proveedorId: null }, { proveedorId: null })).toBe(false);
  });
});

describe('POST /buscar (R3)', () => {
  const buscar = async (cuerpo: object, funciones = ['logistica.consola.ver']) => request(appLogistica())
    .post('/api/flito/logistica/buscar').set('Authorization', `Bearer ${await tokenCon(funciones)}`).send(cuerpo);

  it('sin la función → 403', async () => {
    expect((await buscar({}, [])).status).toBe(403);
  });
  it('sin token → 401', async () => {
    expect((await request(appLogistica()).post('/api/flito/logistica/buscar').send({})).status).toBe(401);
  });
  it('rechaza un campo desconocido (`.strict()`)', async () => {
    expect((await buscar({ buscar: 'ZZA101', otro: 1 })).status).toBe(400);
  });
  it.each([[{ estados: 'pendiente' }], [{ empresas: '900' }], [{ page: 0 }], [{ pageSize: 201 }]])('rechaza %j', async (cuerpo) => {
    expect((await buscar(cuerpo)).status).toBe(400);
  });
  it('stub: con cuerpo válido responde 501', async () => {
    const r = await buscar({ buscar: 'ZZA101', estados: ['pendiente'], empresas: ['900'], page: 1, pageSize: 50 });
    expect(r.status).toBe(501);
  });
});

describe('GET /actas/:id/mensajeros (R1)', () => {
  const mensajeros = async (id: string, funciones = ['logistica.actas.despachar']) => request(appLogistica())
    .get(`/api/flito/logistica/actas/${id}/mensajeros`).set('Authorization', `Bearer ${await tokenCon(funciones)}`);

  it('sin la función → 403', async () => {
    expect((await mensajeros(ACTA, ['logistica.actas.ver'])).status).toBe(403);
  });
  it('un id que no es uuid se responde como un acta inexistente', async () => {
    expect((await mensajeros('no-es-uuid')).status).toBe(404);
  });
  it('stub: responde 501', async () => {
    expect((await mensajeros(ACTA)).status).toBe(501);
  });
});
