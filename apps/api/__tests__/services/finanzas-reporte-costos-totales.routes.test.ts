// Reporte de costos (Épica #14560): la tabla esperaba a las agregaciones del universo.
//
// Medido en local (8.625 trámites, sin filtro): el costo de proveedor consolidado ~17 s, los totales
// ~0,8 s, las filas ~0,1 s. Las agregaciones salen a `GET /reporte-costos/totales` y la página las
// omite con `sinTotales=1`. Se prueba la frontera HTTP: qué función del servicio se llama con qué
// filtros, qué viaja en cada respuesta, la guarda y el registro PII. Sin el parámetro, la respuesta
// es la de siempre.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken, type TestRole } from '../helpers/auth.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const logPiiAccess = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: (...a: unknown[]) => logPiiAccess(...a) }));

const RESUMEN = { listo: 1, incompleto: 2, porFacturar: 3, facturado: 4 };
const PAGINA = { items: [], total: 7, page: 2, pageSize: 25, resumen: RESUMEN };
const TOTALES = {
  totales: { total: 1000, soat: 1, impuesto: 0, derechoTramite: 0, tramiteDigital: 0, logistica: 0,
    serviciosAdicionales: 0, gmf: 0, totalReintegro: 0, totalServicio: 0, filasIncompletas: 0 },
  totalesCostosProveedor: { costoProveedorSoat: 5, costoProveedorLogistica: 6, costoProveedorTotal: 11, tramitesCostoSinConfigurar: 1 },
};
const paginaReporteCostos = vi.fn().mockResolvedValue(PAGINA);
const totalesReporteCostos = vi.fn().mockResolvedValue(TOTALES);
const reporteCostos = vi.fn().mockResolvedValue({ ...PAGINA, ...TOTALES });

vi.mock('../../src/modules/finanzas/finanzas.service.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  paginaReporteCostos: (...a: unknown[]) => paginaReporteCostos(...a),
  totalesReporteCostos: (...a: unknown[]) => totalesReporteCostos(...a),
  reporteCostos: (...a: unknown[]) => reporteCostos(...a),
}));

const RUTA = '/api/finanzas/reporte-costos';
const RUTA_TOTALES = '/api/finanzas/reporte-costos/totales';

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/finanzas/finanzas.routes.js');
  app.use('/api/finanzas', router);
  return app;
}

const auth = async (role: TestRole) => `Bearer ${await testToken({ sub: 3, username: `${role}@flit.io`, role })}`;

beforeEach(() => {
  kdb.reset();
  logPiiAccess.mockClear(); paginaReporteCostos.mockClear(); totalesReporteCostos.mockClear(); reporteCostos.mockClear();
});

describe('GET /reporte-costos — compatibilidad y sinTotales', () => {
  it('sin el parámetro responde como siempre: página + totales + costo de proveedor, y registra la lectura PII', async () => {
    const app = await buildApp();
    const r = await request(app).get(RUTA).set('Authorization', await auth('financiera'));

    expect(r.status).toBe(200);
    expect(reporteCostos).toHaveBeenCalledTimes(1);
    expect(paginaReporteCostos).not.toHaveBeenCalled();
    expect(r.body).toMatchObject({ total: 7, resumen: RESUMEN, ...TOTALES });
    expect(logPiiAccess).toHaveBeenCalledTimes(1);
  });

  it.each(['1', 'true'])('sinTotales=%s devuelve la página SIN agregaciones y no las calcula', async (v) => {
    const app = await buildApp();
    const r = await request(app).get(`${RUTA}?sinTotales=${v}&page=2&pageSize=25&etapa=listo`)
      .set('Authorization', await auth('financiera'));

    expect(r.status).toBe(200);
    expect(paginaReporteCostos).toHaveBeenCalledTimes(1);
    expect(paginaReporteCostos.mock.calls[0][0]).toMatchObject({ page: 2, pageSize: 25, etapa: 'listo' });
    expect(reporteCostos).not.toHaveBeenCalled();
    expect(totalesReporteCostos).not.toHaveBeenCalled();
    expect(r.body).toEqual(PAGINA);
    expect(r.body).not.toHaveProperty('totales');
    expect(r.body).not.toHaveProperty('totalesCostosProveedor');
    // La página sigue llevando el titular: el registro PII no se pierde.
    expect(logPiiAccess).toHaveBeenCalledTimes(1);
  });

  it('sinTotales con otro valor → 400, sin consultar', async () => {
    const app = await buildApp();
    const r = await request(app).get(`${RUTA}?sinTotales=si`).set('Authorization', await auth('financiera'));

    expect(r.status).toBe(400);
    expect(reporteCostos).not.toHaveBeenCalled();
    expect(paginaReporteCostos).not.toHaveBeenCalled();
  });
});

describe('GET /reporte-costos/totales', () => {
  it('devuelve solo las agregaciones, con los MISMOS filtros del listado, y sin registro PII', async () => {
    const app = await buildApp();
    const r = await request(app)
      .get(`${RUTA_TOTALES}?empresas=A,B&etapa=por_facturar&desde=2026-01-01&costoProveedorSinConfigurar=true`)
      .set('Authorization', await auth('financiera'));

    expect(r.status).toBe(200);
    expect(r.body).toEqual(TOTALES);
    expect(totalesReporteCostos.mock.calls[0][0]).toMatchObject({
      empresas: ['A', 'B'], etapa: 'por_facturar', desde: '2026-01-01', costoProveedorSinConfigurar: true,
    });
    expect(logPiiAccess).not.toHaveBeenCalled();
  });

  it('el filtro costoProveedorSinConfigurar mal escrito también es 400 aquí', async () => {
    const app = await buildApp();
    const r = await request(app).get(`${RUTA_TOTALES}?costoProveedorSinConfigurar=si`)
      .set('Authorization', await auth('financiera'));
    expect(r.status).toBe(400);
    expect(totalesReporteCostos).not.toHaveBeenCalled();
  });

  it('sin token → 401', async () => {
    const app = await buildApp();
    expect((await request(app).get(RUTA_TOTALES)).status).toBe(401);
  });

  it.each(['proveedor', 'conductor', 'mensajero'] as TestRole[])('%s no lee el reporte → 403', async (role) => {
    const app = await buildApp();
    expect((await request(app).get(RUTA_TOTALES).set('Authorization', await auth(role))).status).toBe(403);
  });

  it.each(['admin', 'financiera', 'auditor'] as TestRole[])('%s lo consulta con la misma guarda del reporte', async (role) => {
    const app = await buildApp();
    expect((await request(app).get(RUTA_TOTALES).set('Authorization', await auth(role))).status).toBe(200);
  });
});
