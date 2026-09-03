// HU #12051 — tandas de la carga masiva SOAT: tope HTTP 5, OCR en pool, persist serial, CA-08
// antes del pool. OCR y storage mockeados; estilo flito-soat.factura.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';
import { CampoSoat, CARGA_MASIVA_MAX_BYTES_ARCHIVO } from '@operaciones/shared-types';

const selectMock = vi.fn();
const updateMock = vi.fn();
const insertMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, update: updateMock, insert: insertMock, delete: vi.fn(), transaction: transactionMock, execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const extraerMock = vi.fn();
vi.mock('../../src/modules/flito-ocr/flito-ocr.service.js', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, extraerFacturaSoat: extraerMock };
});
const uploadMock = vi.fn().mockResolvedValue('flito/soat/facturas/k.pdf');
vi.mock('../../src/services/storage.js', () => ({ uploadEntityDocument: uploadMock }));

beforeEach(() => {
  selectMock.mockReset(); updateMock.mockReset(); insertMock.mockReset(); transactionMock.mockReset();
  extraerMock.mockReset(); uploadMock.mockReset();
  uploadMock.mockResolvedValue('flito/soat/facturas/k.pdf');
});

const campo = (valor: string | null, confianza: number) => ({ valor, confianza, confiable: confianza >= 0.85 });
const UUID = '00000000-0000-0000-0000-000000000001';
const datosCarga = [{ soatId: UUID, vin: '9BWZZZ377VT004251', estado: 'solicitado', placa: 'QTQ100', companiaId: 1, carpeta: null, umbralOcr: null }];
const extraccionCruza = {
  [CampoSoat.PLACA]: campo('QTQ100', 0.95), [CampoSoat.VIN]: campo('9BWZZZ377VT004251', 0.95),
  [CampoSoat.NUMERO_POLIZA]: campo('FLIT-1', 0.95), [CampoSoat.VALOR_TOTAL]: campo('250000', 0.95),
  [CampoSoat.ASEGURADORA]: campo('SURA', 0.95),
};

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-soat/flito-soat.routes.js');
  app.use('/api/flito/soat', router);
  app.use((err: { code?: string; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ error: err.message ?? String(err), code: err.code });
  });
  return app;
}
const auth = async () => `Bearer ${await testToken({ sub: 7, username: 'gestor@x.io', role: 'admin' })}`;
const pdf = (i: number) => Buffer.from(`%PDF-soat-${i}`);

function mockTxOk() {
  transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => {
    const txSelect = vi.fn().mockReturnValue(chain([{ n: 1 }]));
    const txUpdate = vi.fn().mockReturnValue(chain([]));
    const txInsert = vi.fn().mockReturnValueOnce(chain([{ id: 'sop-nuevo' }])).mockReturnValue(chain([]));
    return cb({ select: txSelect, update: txUpdate, insert: txInsert });
  });
}

function mockHashesLibresLuegoDatos(n: number) {
  for (let i = 0; i < n; i++) selectMock.mockReturnValueOnce(chain([]));
  selectMock.mockReturnValue(chain(datosCarga));
}

async function postFacturas(n: number, buffers?: Buffer[]) {
  const app = await buildApp();
  let req = request(app).post('/api/flito/soat/facturas').set('Authorization', await auth());
  for (let i = 0; i < n; i++) req = req.attach('archivos', buffers?.[i] ?? pdf(i), `f${i}.pdf`);
  return req;
}

describe('HU #12051 — carga masiva SOAT tandas', () => {
  it('POST /facturas con 6 attach → ≠ 200 (tope HTTP 5)', async () => {
    const r = await postFacturas(6);
    expect(r.status).not.toBe(200);
  });

  it('5 attach + mocks → 200', async () => {
    mockHashesLibresLuegoDatos(5);
    extraerMock.mockResolvedValue(extraccionCruza);
    mockTxOk();
    const r = await postFacturas(5);
    expect(r.status).toBe(200);
    expect(r.body.pagados).toHaveLength(5);
    expect(extraerMock).toHaveBeenCalledTimes(5);
  });

  it('attach > 15 MiB → rechazo multer (regresión 12050)', async () => {
    const grande = Buffer.alloc(CARGA_MASIVA_MAX_BYTES_ARCHIVO + 1);
    const r = await postFacturas(1, [grande]);
    expect(r.status).not.toBe(200);
    expect(extraerMock).not.toHaveBeenCalled();
  });

  it('3 archivos, extraer con delay: maxInflight OCR ≥ 2 (pool, no for serial)', async () => {
    mockHashesLibresLuegoDatos(3);
    mockTxOk();
    let inflight = 0;
    let maxInflight = 0;
    extraerMock.mockImplementation(async () => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 40));
      inflight -= 1;
      return extraccionCruza;
    });
    const r = await postFacturas(3);
    expect(r.status).toBe(200);
    expect(maxInflight).toBeGreaterThanOrEqual(2);
  });

  it('upload/tx: maxInflight === 1 (persist serial)', async () => {
    mockHashesLibresLuegoDatos(3);
    extraerMock.mockResolvedValue(extraccionCruza);
    let inflight = 0;
    let maxInflight = 0;
    const track = async <T>(fn: () => Promise<T>): Promise<T> => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      try { return await fn(); } finally { inflight -= 1; }
    };
    uploadMock.mockImplementation(() => track(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return 'flito/soat/facturas/k.pdf';
    }));
    transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => track(async () => {
      await new Promise((r) => setTimeout(r, 20));
      const txSelect = vi.fn().mockReturnValue(chain([{ n: 1 }]));
      const txUpdate = vi.fn().mockReturnValue(chain([]));
      const txInsert = vi.fn().mockReturnValueOnce(chain([{ id: 'sop-nuevo' }])).mockReturnValue(chain([]));
      return cb({ select: txSelect, update: txUpdate, insert: txInsert });
    }));
    const r = await postFacturas(3);
    expect(r.status).toBe(200);
    expect(maxInflight).toBe(1);
  });

  it('hash ya persistido → duplicados y extraerFacturaSoat NO se llama (CA-08)', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 'sop-previo' }]));
    const r = await postFacturas(1);
    expect(r.status).toBe(200);
    expect(r.body.duplicados).toHaveLength(1);
    expect(extraerMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });
});
