// LAFT F3 · rte.routes — generar CSV mensual + idempotencia + descarga.
//
// OPS-02b r2: mock KEYED por tabla. Las queries multi-tabla (existing en
// laft_reportes_uiaf → breaches en laft_cash_txns) se enrutan por tabla; las
// repeticiones sobre una misma tabla usan FIFO (`selectOnce`). Orden irrelevante.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken } from '../helpers/auth.js';

const kdb = createKeyedDb();
// `selectMock` se conserva como alias drop-in (tests de un solo SELECT siguen
// usando el patrón posicional); los multi-tabla migran a `kdb.when`.
const { select: selectMock, insert: insertMock } = kdb;

vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const laftAuditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/modules/laft/audit.service.js', () => ({
  laftAudit: laftAuditMock,
}));

const uploadReporteMock = vi.fn();
const downloadReporteMock = vi.fn();
vi.mock('../../src/modules/laft/cash/reportes-storage.js', () => ({
  uploadReporte: uploadReporteMock,
  downloadReporte: downloadReporteMock,
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
  uploadReporteMock.mockReset();
  downloadReporteMock.mockReset();
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/laft/cash/rte.routes.js');
  app.use('/api/laft/rte', router);
  return app;
}

describe('LAFT F3 · rte.routes — auth', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/laft/rte');
    expect(r.status).toBe(401);
  });
  it('proveedor → 403', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/rte').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });
});

describe('LAFT F3 · POST /generar/:anio/:mes [keyed]', () => {
  it('mes inválido → 400', async () => {
    const token = await testToken({ sub: 1, role: 'compliance' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/rte/generar/2026/13').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('mes futuro (en curso) → 422', async () => {
    // Mes en curso: año actual + mes actual.
    const today = new Date();
    const anio = today.getUTCFullYear();
    const mes = today.getUTCMonth() + 1;
    const token = await testToken({ sub: 1, role: 'compliance' });
    const app = await buildApp();
    const r = await request(app).post(`/api/laft/rte/generar/${anio}/${mes}`).set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/mes en curso/i);
  });

  it('reporte ya existe → 200 idempotent', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 9, tipo: 'RTE', formato: 'CSV', periodoAnio: 2025, periodoMes: 1,
      sha256: 'abc', storageKey: 'RTE/2025/01/x.csv',
    }]));
    const token = await testToken({ sub: 1, role: 'compliance' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/rte/generar/2025/1').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.idempotent).toBe(true);
  });

  it('happy path → genera CSV + insert + audit', async () => {
    // Keyed: existing en laft_reportes_uiaf → []; breaches en laft_cash_txns → 2.
    kdb.when.select('laft_reportes_uiaf', []);
    kdb.when.select('laft_cash_txns', [
      {
        docType: 'NIT', docNumber: '900111', fullName: 'Andina SAS',
        fecha: '2025-01-15', amount: '12000000', kind: 'efectivo',
        numeroRecibo: 'R-1', indiv: true, acum: false,
      },
      {
        docType: 'CC', docNumber: '79123', fullName: 'Pérez',
        fecha: '2025-01-22', amount: '8000000', kind: 'efectivo',
        numeroRecibo: null, indiv: false, acum: true,
      },
    ]);
    uploadReporteMock.mockResolvedValueOnce({
      storageKey: 'RTE/2025/01/RTE-2025-01.csv',
      sha256: 'd34db33f',
      sizeBytes: 256,
    });
    insertMock.mockReturnValueOnce({
      values: (v: any) => ({ returning: () => Promise.resolve([{ id: 50, ...v }]) }),
    });

    const token = await testToken({ sub: 7, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/rte/generar/2025/1').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(201);
    expect(r.body.totalOperaciones).toBe(2);
    expect(uploadReporteMock).toHaveBeenCalledWith(expect.objectContaining({
      tipo: 'RTE', anio: 2025, mes: 1, formato: 'CSV',
    }));
    // El body del CSV contiene header en español + las 2 filas + BOM.
    const callArg = uploadReporteMock.mock.calls[0][0];
    const csvText = (callArg.body as Buffer).toString('utf-8');
    expect(csvText).toMatch(/^﻿/); // BOM
    expect(csvText).toContain('Tipo Documento');
    expect(csvText).toContain('NIT/Documento');
    expect(csvText).toContain('Nombre/Razón Social');
    expect(csvText).toContain('Causa');
    expect(csvText).toContain('Andina SAS');
    expect(csvText).toContain('Individual'); // causa primer breach
    expect(csvText).toContain('Acumulado mensual');
    expect(laftAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'rte_generate', resource: 'document' }),
    );
  });

  it('carrera: insert duplica → recupera el existente y devuelve 200 idempotent', async () => {
    // Keyed: laft_reportes_uiaf se consulta 2 veces (existing → recovery) → FIFO.
    kdb.when.selectOnce('laft_reportes_uiaf', []); // existing none
    kdb.when.select('laft_cash_txns', []); // breaches none
    uploadReporteMock.mockResolvedValueOnce({ storageKey: 'k', sha256: 's', sizeBytes: 0 });
    // Insert → 23505
    insertMock.mockReturnValueOnce({
      values: () => ({ returning: () => Promise.reject(Object.assign(new Error('dup'), { code: '23505' })) }),
    });
    // Recovery select returns the row (segundo SELECT sobre laft_reportes_uiaf)
    kdb.when.selectOnce('laft_reportes_uiaf', [{ id: 99, tipo: 'RTE', formato: 'CSV', periodoAnio: 2025, periodoMes: 1 }]);

    const token = await testToken({ sub: 7, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/rte/generar/2025/1').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.idempotent).toBe(true);
  });
});

describe('LAFT F3 · GET /:anio/:mes/download', () => {
  it('no existe → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await testToken({ sub: 1, role: 'compliance' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/rte/2024/12/download').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
  });

  it('existe → bytes con sha256 header', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 1, tipo: 'RTE', storageKey: 'RTE/2024/12/x.csv', sha256: 'h2',
    }]));
    downloadReporteMock.mockResolvedValueOnce(Buffer.from('﻿Tipo,...\r\nfila', 'utf-8'));
    const token = await testToken({ sub: 1, role: 'compliance' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/rte/2024/12/download').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.headers['x-reporte-sha256']).toBe('h2');
  });
});

describe('LAFT F3 · GET /', () => {
  it('list paginado', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, tipo: 'RTE' }]));
    selectMock.mockReturnValueOnce(chain([{ count: 1 }]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/rte').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(1);
    expect(r.body.rows).toHaveLength(1);
  });
});
