// HU #14664 (AC2/AC3/AC4/AC6) — frontera HTTP de PATCH .../documento-factura y POST
// .../documento-factura/reintentar. Monta el router PADRE (hereda authMiddleware), calco de
// flito-impuestos.direccion.routes.test.ts. Los asertos del UPDATE van sobre lo que el servicio pasó
// a `.set()`, no sobre la fila que devuelve el mock.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken, type TestRole } from '../helpers/auth.js';

const selectMock = vi.fn();
const updateMock = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, update: updateMock, insert: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: (...a: unknown[]) => auditMock(...a) }));
const piiMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: (...a: unknown[]) => piiMock(...a) }));
const logs: unknown[] = [];
vi.mock('../../src/shared/logger.js', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const capt = (...a: unknown[]) => { logs.push(a); };
  const fake = { info: capt, warn: capt, error: capt, debug: capt, child: () => fake };
  return { ...real, loggerFor: () => fake, logger: fake };
});
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const descargarMock = vi.fn();
const extraerMock = vi.fn();
class FacturaNoDisponibleErrorFake extends Error {
  constructor(public readonly motivo: string) { super(`Factura de venta no disponible (${motivo})`); this.name = 'FacturaNoDisponibleError'; }
}
vi.mock('../../src/modules/flito-impuestos/flito-impuestos.extraccion.js', () => ({
  descargarFacturaDeImpuesto: (...a: unknown[]) => descargarMock(...a),
  extraerDeFactura: (...a: unknown[]) => extraerMock(...a),
  FacturaNoDisponibleError: FacturaNoDisponibleErrorFake,
}));

const ID = '71030cce-1a4c-4fb6-855d-fcc80aadc4ea';

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-impuestos/flito-impuestos.routes.js');
  const { conAlcance } = await import('../../src/shared/middleware/frontera-enlace.js');
  app.use('/api/flito/impuestos', conAlcance('impuestos', router)); // HU #13426: como en app.ts
  return app;
}
const auth = async (role: TestRole) => `Bearer ${await testToken({ sub: 9, username: 'ops@flit.io', role })}`;
const patch = async (role: TestRole, body: unknown, id = ID) =>
  request(await buildApp()).patch(`/api/flito/impuestos/${id}/documento-factura`).set('Authorization', await auth(role)).send(body as object);
const reintentar = async (role: TestRole, body: unknown, id = ID) =>
  request(await buildApp()).post(`/api/flito/impuestos/${id}/documento-factura/reintentar`).set('Authorization', await auth(role)).send(body as object);
const dentro = () => chain([{ imp: { id: ID, organismoCodigo: '05001', estado: 'pagado' }, dentroDeFrontera: true }]);

/** Graba el `.set()` del UPDATE y devuelve `filas` desde `.returning()`. */
function grabador(filas: unknown[], g: { set?: Record<string, unknown> }) {
  const c: Record<string, unknown> = {};
  Object.assign(c, {
    set: (v: Record<string, unknown>) => { g.set = v; return c; },
    where: () => c, returning: () => c,
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(filas).then(res, rej),
  });
  return c;
}

const campo = (valor: string | null, confiable = true) => ({ valor, confianza: confiable ? 1 : 0.4, confiable });
const filaCorregida = (over: Record<string, unknown> = {}) => ({
  id: ID, extraccionFacturaVenta: { numeroFactura: campo('FAC-NUEVA') }, ...over,
});

beforeEach(() => {
  selectMock.mockReset(); updateMock.mockReset(); auditMock.mockClear(); piiMock.mockClear();
  descargarMock.mockReset(); extraerMock.mockReset(); logs.length = 0;
});

describe('PATCH /:id/documento-factura — AC2', () => {
  it('con la función, motivo y un campo: 200, confiable=true, auditado — en CUALQUIER estado (AC4)', async () => {
    selectMock.mockReturnValueOnce(dentro());
    const g: { set?: Record<string, unknown> } = {};
    updateMock.mockReturnValueOnce(grabador([filaCorregida()], g));

    const r = await patch('admin', { numeroFactura: 'FAC-NUEVA', motivo: 'número ilegible en la factura' });

    expect(r.status).toBe(200);
    expect(g.set!.updatedAt).toBeInstanceOf(Date);
    expect(r.body).toEqual({ numeroFactura: campo('FAC-NUEVA'), fechaFactura: null, avaluoComercial: null, ultimoCambio: null });
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'update', resource: 'flito_impuesto', resourceId: ID }));
    expect(piiMock).not.toHaveBeenCalled(); // AGENTS §16: no es PII del titular
  });

  it('400 sin motivo, sin ningún campo, o id inválido — y no toca la base', async () => {
    for (const body of [{ numeroFactura: 'X' }, { motivo: 'motivo válido y largo' }, { numeroFactura: 'X', motivo: 'muy' }]) {
      const r = await patch('admin', body);
      expect(r.status).toBe(400);
    }
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('sin la función impuestos.tramite.certificar (auditor) → 403 y la fila no cambia', async () => {
    const r = await patch('auditor', { numeroFactura: 'X', motivo: 'motivo válido y largo' });
    expect(r.status).toBe(403);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('fuera de la frontera o inexistente → 404 (no 403) y sin UPDATE', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const r = await patch('admin', { numeroFactura: 'X', motivo: 'motivo válido y largo' });
    expect(r.status).toBe(404);
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('POST /:id/documento-factura/reintentar — AC3', () => {
  it('con la función: 200, descarga + relee, y audita el reintento', async () => {
    selectMock.mockReturnValueOnce(dentro());
    descargarMock.mockResolvedValueOnce({ bytes: Buffer.from('x'), contentType: 'application/pdf' });
    extraerMock.mockResolvedValueOnce({ numeroFactura: campo('FAC-FRESCA'), fechaFactura: campo('2026-11-01'), avaluoComercial: campo('1000'), vin: campo('X') });
    const g: { set?: Record<string, unknown> } = {};
    updateMock.mockReturnValueOnce(grabador([{ id: ID, extraccionFacturaVenta: { numeroFactura: campo('FAC-FRESCA'), fechaFactura: campo('2026-11-01'), avaluoComercial: campo('1000') } }], g));

    const r = await reintentar('admin', { motivo: 'reintentar lectura de la factura' });

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ numeroFactura: campo('FAC-FRESCA'), fechaFactura: campo('2026-11-01'), avaluoComercial: campo('1000'), ultimoCambio: null });
    expect(auditMock).toHaveBeenCalledTimes(1);
  });

  it('409 FACTURA_NO_DISPONIBLE: nunca el motivo crudo del error', async () => {
    selectMock.mockReturnValueOnce(dentro());
    descargarMock.mockRejectedValueOnce(new FacturaNoDisponibleErrorFake('url_nula'));
    const r = await reintentar('admin', { motivo: 'reintentar lectura de la factura' });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ code: 'FACTURA_NO_DISPONIBLE', error: 'No se pudo obtener la factura de venta para releerla.' });
    expect(JSON.stringify(r.body)).not.toContain('url_nula');
    expect(updateMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('400 sin motivo o motivo corto; 403 sin la función; 404 fuera de frontera', async () => {
    const corto = await reintentar('admin', { motivo: 'no' });
    expect(corto.status).toBe(400);

    const sinFuncion = await reintentar('auditor', { motivo: 'reintentar lectura de la factura' });
    expect(sinFuncion.status).toBe(403);

    selectMock.mockReturnValueOnce(chain([]));
    const fuera = await reintentar('admin', { motivo: 'reintentar lectura de la factura' });
    expect(fuera.status).toBe(404);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('sin token → 401 en ambas rutas (autenticación heredada del router padre)', async () => {
    const app = await buildApp();
    const r1 = await request(app).patch(`/api/flito/impuestos/${ID}/documento-factura`).send({ numeroFactura: 'X', motivo: 'motivo válido y largo' });
    const r2 = await request(app).post(`/api/flito/impuestos/${ID}/documento-factura/reintentar`).send({ motivo: 'motivo válido y largo' });
    expect(r1.status).toBe(401);
    expect(r2.status).toBe(401);
  });
});
