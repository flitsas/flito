// LAFT F3 · aros.routes — generar PDF trimestral (con/sin actividad) + download.
// OPS-02b r2: mock KEYED por tabla. Los SELECT (download + listado) van a
// laft_reportes_uiaf vía `kdb.selectOnce` (FIFO por tabla) → orden irrelevante.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken } from '../helpers/auth.js';

const kdb = createKeyedDb();

vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const laftAuditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/modules/laft/audit.service.js', () => ({
  laftAudit: laftAuditMock,
}));

// Stub completo de aros.service para que el test no toque pdf-lib en cada caso.
const generarArosMock = vi.fn();
const buildArosResumenMock = vi.fn();
const buildArosPdfMock = vi.fn();
vi.mock('../../src/modules/laft/cash/aros.service.js', () => ({
  generarAros: generarArosMock,
  buildArosResumen: buildArosResumenMock,
  buildArosPdf: buildArosPdfMock,
  trimestreRange: (a: number, t: number) => ({ desde: `${a}-01-01`, hasta: `${a}-03-31` }),
}));

const downloadReporteMock = vi.fn();
const uploadReporteMock = vi.fn();
vi.mock('../../src/modules/laft/cash/reportes-storage.js', () => ({
  downloadReporte: downloadReporteMock,
  uploadReporte: uploadReporteMock,
}));

vi.mock('express-rate-limit', () => ({
  default: () => (_req: any, _res: any, next: any) => next(),
  ipKeyGenerator: (s: string) => s,
}));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

beforeEach(() => {
  kdb.reset();
  laftAuditMock.mockClear();
  generarArosMock.mockReset();
  downloadReporteMock.mockReset();
  uploadReporteMock.mockReset();
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/laft/cash/aros.routes.js');
  app.use('/api/laft/aros', router);
  return app;
}

describe('LAFT F3 · aros.routes — POST /generar/:anio/:trimestre', () => {
  it('trimestre inválido → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/aros/generar/2025/5').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('trimestre en curso → 422', async () => {
    const today = new Date();
    const anio = today.getUTCFullYear();
    // Trimestre que contiene hoy = mes futuro o no terminado
    const trimestre = Math.floor(today.getUTCMonth() / 3) + 1;
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post(`/api/laft/aros/generar/${anio}/${trimestre}`).set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(422);
  });

  it('AROS de ausencia (sin ROS, sin reportadas) → 201 y resumen.esAusencia=true', async () => {
    generarArosMock.mockResolvedValueOnce({
      reporte: { id: 1, tipo: 'AROS', sha256: 'h', formato: 'PDF', periodoAnio: 2024, periodoTrimestre: 4 },
      resumen: {
        trimestre: 4, anio: 2024, desde: '2024-10-01', hasta: '2024-12-31',
        totalRosEnviados: 0, totalUnusualReportadas: 0, totalCashBreaches: 0,
        esAusencia: true, detalle: { ros: [], unusualReportadas: [] },
      },
      idempotent: false,
    });
    const token = await testToken({ sub: 7, role: 'compliance' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/aros/generar/2024/4').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(201);
    expect(r.body.resumen.esAusencia).toBe(true);
    expect(r.body.idempotent).toBe(false);
    expect(laftAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'aros_generate' }),
    );
  });

  it('AROS con actividad (con ROS) → 201 con resumen.esAusencia=false', async () => {
    generarArosMock.mockResolvedValueOnce({
      reporte: { id: 2, tipo: 'AROS', sha256: 'h2', formato: 'PDF', periodoAnio: 2024, periodoTrimestre: 4 },
      resumen: {
        trimestre: 4, anio: 2024, desde: '2024-10-01', hasta: '2024-12-31',
        totalRosEnviados: 2, totalUnusualReportadas: 1, totalCashBreaches: 5,
        esAusencia: false,
        detalle: {
          ros: [{ id: 10, sirelRadicado: 'R-1', sentToUiafAt: new Date('2024-11-01') }],
          unusualReportadas: [{ id: 30, description: 'op X', decidedAt: new Date('2024-12-15') }],
        },
      },
      idempotent: false,
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/aros/generar/2024/4').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(201);
    expect(r.body.resumen.esAusencia).toBe(false);
    expect(r.body.resumen.totalRosEnviados).toBe(2);
  });

  it('idempotent → 200', async () => {
    generarArosMock.mockResolvedValueOnce({
      reporte: { id: 3, tipo: 'AROS', sha256: 'h3' },
      resumen: { esAusencia: true, totalRosEnviados: 0, totalUnusualReportadas: 0, totalCashBreaches: 0 },
      idempotent: true,
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/aros/generar/2024/4').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.idempotent).toBe(true);
    // Idempotent no llama audit (acción ya registrada al crear)
    expect(laftAuditMock).not.toHaveBeenCalled();
  });
});

describe('LAFT F3 · aros.routes — GET /:anio/:trimestre/download [keyed]', () => {
  it('no existe → 404', async () => {
    kdb.when.selectOnce('laft_reportes_uiaf', []);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/aros/2024/4/download').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
  });

  it('existe → 200 PDF', async () => {
    kdb.when.selectOnce('laft_reportes_uiaf', [{
      id: 1, tipo: 'AROS', storageKey: 'AROS/2024/Q4/x.pdf', sha256: 'h4',
    }]);
    downloadReporteMock.mockResolvedValueOnce(Buffer.from('%PDF-1.7'));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/aros/2024/4/download').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/application\/pdf/);
    expect(r.headers['x-reporte-sha256']).toBe('h4');
  });
});

describe('LAFT F3 · aros.routes — GET / [keyed]', () => {
  it('list paginado', async () => {
    kdb.when.selectOnce('laft_reportes_uiaf', [{ id: 1, tipo: 'AROS', periodoAnio: 2024, periodoTrimestre: 4 }]);
    kdb.when.selectOnce('laft_reportes_uiaf', [{ count: 1 }]);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/aros').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(1);
  });
});
