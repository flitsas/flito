// HU #12833 (AC5/AC6) — frontera HTTP de PATCH /api/flito/impuestos/:id/direccion. Monta el router
// PADRE, no el sub-router suelto: así se cubre que la autenticación se hereda del `router.use`.
//
// Los asertos del `UPDATE` van sobre lo que el servicio pasó a `.set()` (grabador), no sobre la fila
// que devuelve el mock: el mock devuelve lo que se le diga.

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

const ID = '71030cce-1a4c-4fb6-855d-fcc80aadc4e9';
const DIR = 'CALLE 45 # 12-30 CENTINELA';
const BODY = { direccion: `  ${DIR}  `, municipio: 'MEDELLIN', departamento: 'ANTIOQUIA' };

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-impuestos/flito-impuestos.routes.js');
  app.use('/api/flito/impuestos', router);
  return app;
}
const auth = async (role: TestRole) => `Bearer ${await testToken({ sub: 9, username: 'ops@flit.io', role })}`;
const patch = async (role: TestRole, body: unknown = BODY, id = ID) =>
  request(await buildApp()).patch(`/api/flito/impuestos/${id}/direccion`).set('Authorization', await auth(role)).send(body as object);
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

const filaCorregida = (over: Record<string, unknown> = {}) => ({
  id: ID, direccionFuente: 'manual', direccionFactura: DIR, municipioFactura: 'MEDELLIN', departamentoFactura: 'ANTIOQUIA',
  direccionPendienteRevision: false, direccionConfirmadaPorNombre: 'ops@flit.io',
  direccionConfirmadaEn: new Date('2026-09-24T12:00:00Z'), analisisEstado: 'completado', extraccionFacturaVenta: null,
  ...over,
});

beforeEach(() => {
  selectMock.mockReset(); updateMock.mockReset(); auditMock.mockClear(); piiMock.mockClear(); logs.length = 0;
});

describe('PATCH /:id/direccion — AC5', () => {
  it('con la función: 200, guarda recortado y confirma (manual, pendiente=false, quién y cuándo), en CUALQUIER estado', async () => {
    selectMock.mockReturnValueOnce(dentro());
    const g: { set?: Record<string, unknown> } = {};
    updateMock.mockReturnValueOnce(grabador([filaCorregida()], g));

    const r = await patch('admin');

    expect(r.status).toBe(200);
    expect(g.set).toMatchObject({
      direccionFactura: DIR, municipioFactura: 'MEDELLIN', departamentoFactura: 'ANTIOQUIA',
      direccionFuente: 'manual', direccionPendienteRevision: false,
      direccionConfirmadaPorId: 9, direccionConfirmadaPorNombre: 'ops@flit.io',
    });
    expect(g.set!.direccionConfirmadaEn).toBeInstanceOf(Date);
    expect(r.body).toEqual({
      direccion: DIR, municipio: 'MEDELLIN', departamento: 'ANTIOQUIA', origen: 'manual',
      pendienteRevision: false, propuesta: null, confirmadaPor: 'ops@flit.io', confirmadaEn: '2026-09-24T12:00:00.000Z',
    });
  });

  it('auditado SIN la dirección: ni en audit, ni en el registro PII, ni en ningún log', async () => {
    selectMock.mockReturnValueOnce(dentro());
    updateMock.mockReturnValueOnce(grabador([filaCorregida()], {}));
    await patch('admin');

    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith(expect.anything(), {
      action: 'update', resource: 'flito_impuesto', resourceId: ID, detail: 'Dirección del comprador corregida',
    });
    expect(piiMock).toHaveBeenCalledTimes(1);
    expect(piiMock.mock.calls[0]![1]).toMatchObject({
      resourceTipo: 'flito_impuesto', accion: 'read', camposAccedidos: ['direccion', 'municipio', 'departamento'],
    });
    const rastro = JSON.stringify([auditMock.mock.calls.map((c) => c[1]), piiMock.mock.calls.map((c) => c[1]), logs]);
    expect(rastro).not.toContain('CENTINELA');
    expect(rastro).not.toContain('MEDELLIN');
  });
});

describe('PATCH /:id/direccion — AC6 y fronteras', () => {
  it.each<TestRole>(['auditor', 'gestor_impuestos'])('sin la función (%s) → 403 y la fila no cambia', async (rol) => {
    const r = await patch(rol);
    expect(r.status).toBe(403);
    expect(updateMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('sin token → 401 (autenticación heredada del router padre)', async () => {
    const r = await request(await buildApp()).patch(`/api/flito/impuestos/${ID}/direccion`).send(BODY);
    expect(r.status).toBe(401);
  });

  it('fuera de la frontera o inexistente → 404 (no 403) y sin UPDATE', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const r = await patch('admin');
    expect(r.status).toBe(404);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it.each([
    ['id no uuid', BODY, 'no-es-uuid'],
    ['dirección vacía tras recortar', { ...BODY, direccion: '   ' }, ID],
    ['falta el departamento', { direccion: DIR, municipio: 'MEDELLIN' }, ID],
    ['campo extra (.strict)', { ...BODY, direccionFuente: 'factura' }, ID],
    ['dirección de más de 200', { ...BODY, direccion: 'x'.repeat(201) }, ID],
  ])('400: %s, sin tocar la base ni devolver lo enviado', async (_n, body, id) => {
    const r = await patch('admin', body, id);
    expect(r.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
    expect(JSON.stringify(r.body)).not.toContain('CENTINELA');
  });
});
