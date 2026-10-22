// HU #12825 (AC5) — frontera HTTP de POST /api/flito/impuestos/:id/reanalizar. Monta el router
// PADRE, no el sub-router suelto: así se cubre que la autenticación se hereda del `router.use`.
//
// El servicio es el real (con drizzle mockeado) y el paso de análisis llama a un RUNT falso por el
// limitador global: la respuesta 202 tiene que salir ANTES de que ese RUNT se consulte.

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
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
const runtMock = vi.fn().mockResolvedValue({ ok: true, data: {} });
vi.mock('../../src/modules/runt/runt.service.js', () => ({ consultarVehiculoRunt: (...a: unknown[]) => runtMock(...a) }));

const analisis = await import('../../src/modules/flito-impuestos/flito-impuestos.analisis.service.js');

const ID = '71030cce-1a4c-4fb6-855d-fcc80aadc4e9';
const HACE_UNA_HORA = new Date(Date.now() - 3_600_000);

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-impuestos/flito-impuestos.routes.js');
  app.use('/api/flito/impuestos', router);
  return app;
}
const auth = async (role: TestRole) => `Bearer ${await testToken({ sub: 9, username: 'u@flit.io', role })}`;
const post = async (role: TestRole, id = ID) =>
  request(await buildApp()).post(`/api/flito/impuestos/${id}/reanalizar`).set('Authorization', await auth(role));
const dentro = () => chain([{ imp: { id: ID, organismoCodigo: '05001', estado: 'solicitado' }, dentroDeFrontera: true }]);

beforeEach(async () => {
  analisis.__resetColaAnalisis();
  selectMock.mockReset(); updateMock.mockReset(); runtMock.mockClear(); auditMock.mockClear();
  // El paso que la HU 12827 registrará: consulta el RUNT por el limitador global.
  const { consultarVehiculoRunt } = await import('../../src/modules/runt/runt.service.js');
  analisis.registrarPasoAnalisis('runt', async ({ runt }) => { await runt.ejecutar(() => consultarVehiculoRunt('ABC123')); });
});

describe('POST /:id/reanalizar', () => {
  it('202 inmediato: en_curso, auditado, y el RUNT se consulta DESPUÉS de responder (una vez)', async () => {
    selectMock
      .mockReturnValueOnce(dentro())                                                  // buscarConAcceso
      .mockReturnValueOnce(chain([{ estado: 'solicitado', analisisEstado: 'error_analisis' }]))
      .mockReturnValueOnce(chain([]))                                                  // sin certificación vigente
      .mockReturnValue(chain([{ analisisEstado: 'en_curso', analisisEncoladoEn: new Date(), analizadoEn: HACE_UNA_HORA }]));
    updateMock.mockReturnValueOnce(chain([{ id: ID }])).mockReturnValue(chain([]));

    // El RUNT no responde hasta que el test lo suelte: si la ruta esperara al job, nunca daría 202.
    let soltarRunt!: () => void;
    runtMock.mockImplementationOnce(() => new Promise((res) => { soltarRunt = () => res({ ok: true, data: {} }); }));
    let runtAlAuditar = -1;
    auditMock.mockImplementationOnce(async () => { runtAlAuditar = runtMock.mock.calls.length; });

    const r = await post('admin');

    expect(r.status).toBe(202);
    expect(r.body).toEqual({ id: ID, analisisEstado: 'en_curso' });
    expect(runtAlAuditar).toBe(0); // justo antes de responder, el job aún no había consultado
    expect(auditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'update', resource: 'flito_impuesto', resourceId: ID,
    }));
    await vi.waitFor(() => expect(runtMock).toHaveBeenCalledTimes(1));
    soltarRunt();
    await analisis.__colaAnalisisVacia();
    expect(runtMock).toHaveBeenCalledTimes(1); // AC5: una sola consulta
  });

  it('sin la función impuestos.tramite.certificar → 403 y no toca la base', async () => {
    const r = await post('auditor');
    expect(r.status).toBe(403);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('sin token → 401 (autenticación heredada del router padre)', async () => {
    const r = await request(await buildApp()).post(`/api/flito/impuestos/${ID}/reanalizar`);
    expect(r.status).toBe(401);
  });

  it('fuera de la frontera o inexistente → 404 (no 403)', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const r = await post('admin');
    expect(r.status).toBe(404);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('ya en curso → 409 ANALISIS_EN_CURSO, sin encolar otro job', async () => {
    selectMock.mockReturnValueOnce(dentro())
      .mockReturnValueOnce(chain([{ estado: 'solicitado', analisisEstado: 'en_curso' }]));
    const r = await post('admin');
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('ANALISIS_EN_CURSO');
    await analisis.__colaAnalisisVacia();
    expect(runtMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('histórico sin análisis → 409 SIN_ANALISIS', async () => {
    selectMock.mockReturnValueOnce(dentro())
      .mockReturnValueOnce(chain([{ estado: 'solicitado', analisisEstado: null }]));
    const r = await post('admin');
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('SIN_ANALISIS');
  });

  it('id que no es uuid → 400', async () => {
    const r = await post('admin', 'no-es-uuid');
    expect(r.status).toBe(400);
    expect(selectMock).not.toHaveBeenCalled();
  });
});
