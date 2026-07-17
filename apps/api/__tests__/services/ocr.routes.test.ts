import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';
import { env } from '../../src/config/env.js';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock,
    insert: insertMock,
    update: updateMock,
    transaction: transactionMock,
    delete: vi.fn(),
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({
  audit: auditMock,
}));

// Mock del pipeline OCR — del archivo ocr.pipeline.js (módulo separado, vi.mock funciona).
const extractSinglePageMock = vi.fn();
const flattenToLegacyShapeMock = vi.fn();
vi.mock('../../src/modules/vehicles/ocr.pipeline.js', () => ({
  extractSinglePage: extractSinglePageMock,
  flattenToLegacyShape: flattenToLegacyShapeMock,
}));

// Mock pdf-lib para PDFDocument.load (evita parsear PDFs reales).
const pdfLoadMock = vi.fn();
vi.mock('pdf-lib', () => ({
  PDFDocument: { load: pdfLoadMock },
}));

// Mock https.request — para la rama PNG (ocrSingleDocument).
const httpsRequestMock = vi.fn();
vi.mock('https', () => ({
  default: { request: httpsRequestMock },
  request: httpsRequestMock,
}));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

beforeEach(() => {
  selectMock.mockReset();
  insertMock.mockReset();
  updateMock.mockReset();
  transactionMock.mockReset();
  auditMock.mockClear();
  extractSinglePageMock.mockReset();
  flattenToLegacyShapeMock.mockReset();
  pdfLoadMock.mockReset();
  httpsRequestMock.mockReset();
  // Default: ANTHROPIC_API_KEY presente
  env.ANTHROPIC_API_KEY = 'sk-test-key';
});

async function buildApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  const { default: router } = await import('../../src/modules/vehicles/ocr.routes.js');
  app.use('/api/vehicles', router);
  return app;
}

// PDF magic bytes "%PDF" + relleno
const PDF_BUFFER = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(100, 0)]);
// PNG magic bytes
const PNG_BUFFER = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47]), Buffer.alloc(100, 0)]);

describe('ocr.routes — auth', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).post('/api/vehicles/ocr');
    expect(r.status).toBe(401);
  });

  it('proveedor → 403 (admin only)', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).post('/api/vehicles/ocr').set('Authorization', `Bearer ${token}`)
      .attach('file', PDF_BUFFER, { filename: 'doc.pdf', contentType: 'application/pdf' });
    expect(r.status).toBe(403);
  });
});

describe('POST /ocr — validaciones', () => {
  it('sin archivo → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/vehicles/ocr').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/PDF requerido/i);
  });

  it('sin ANTHROPIC_API_KEY → 500', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    env.ANTHROPIC_API_KEY = undefined;
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/vehicles/ocr').set('Authorization', `Bearer ${token}`)
      .attach('file', PDF_BUFFER, { filename: 'doc.pdf', contentType: 'application/pdf' });
    expect(r.status).toBe(500);
    expect(r.body.message).toMatch(/API key/);
  });

  it('archivo no es PDF ni PNG → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/vehicles/ocr').set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('not-pdf-or-png'), { filename: 'doc.txt', contentType: 'text/plain' });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/PDF o PNG/);
  });

  it('PDF con > 100 páginas → 400', async () => {
    pdfLoadMock.mockResolvedValueOnce({ getPageCount: () => 150 });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/vehicles/ocr').set('Authorization', `Bearer ${token}`)
      .attach('file', PDF_BUFFER, { filename: 'doc.pdf', contentType: 'application/pdf' });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/Máximo soportado: 100/);
  });
});

describe('POST /ocr — flujo PDF', () => {
  it('todas las páginas fallan → 502', async () => {
    pdfLoadMock.mockResolvedValueOnce({ getPageCount: () => 2 });
    extractSinglePageMock.mockRejectedValue(new Error('Anthropic timeout'));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/vehicles/ocr').set('Authorization', `Bearer ${token}`)
      .attach('file', PDF_BUFFER, { filename: 'doc.pdf', contentType: 'application/pdf' });
    expect(r.status).toBe(502);
    expect(r.body.message).toMatch(/no respondió/);
  });

  it('extracted = [] (todas devuelven null) → 400 sin vehículos', async () => {
    pdfLoadMock.mockResolvedValueOnce({ getPageCount: () => 2 });
    extractSinglePageMock.mockResolvedValue(null);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/vehicles/ocr').set('Authorization', `Bearer ${token}`)
      .attach('file', PDF_BUFFER, { filename: 'doc.pdf', contentType: 'application/pdf' });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/No se encontraron vehículos/);
  });

  it('placa formato inválido → descartada por dedup (devuelve [] con 200)', async () => {
    pdfLoadMock.mockResolvedValueOnce({ getPageCount: () => 1 });
    extractSinglePageMock.mockResolvedValue({ _model: 'haiku-x' } as any);
    flattenToLegacyShapeMock.mockReturnValueOnce({
      placa: 'INVALID', // no matchea [A-Z]{3}\d{3} → skipped en byPlate
      _confidence: 90,
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/vehicles/ocr').set('Authorization', `Bearer ${token}`)
      .attach('file', PDF_BUFFER, { filename: 'doc.pdf', contentType: 'application/pdf' });
    // El check "vehicles vacío" ocurre ANTES del dedup. Tras dedup queda vacío pero responde 200.
    expect(r.status).toBe(200);
    expect(r.body.vehicles).toEqual([]);
  });

  it('extracción exitosa → 200 + audit + Number coercion en monetarios', async () => {
    pdfLoadMock.mockResolvedValueOnce({ getPageCount: () => 1 });
    extractSinglePageMock.mockResolvedValueOnce({ _model: 'haiku-x', _confidence_avg: 90, _math_check: 'ok', _warnings: [] } as any);
    flattenToLegacyShapeMock.mockReturnValueOnce({
      placa: 'ABZ555', marca: 'TOYOTA', modelo: '2020',
      avaluoComercial: '50000000', impuesto: '1000000', totalPagar: '1100000',
      _confidence: 90,
    });
    const token = await testToken({ sub: 7, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/vehicles/ocr').set('Authorization', `Bearer ${token}`)
      .attach('file', PDF_BUFFER, { filename: 'doc.pdf', contentType: 'application/pdf' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.vehicles).toHaveLength(1);
    expect(r.body.vehicles[0].placa).toBe('ABZ555');
    expect(r.body.vehicles[0].avaluoComercial).toBe(50_000_000); // Number coerced
    expect(r.body.vehicles[0].modelo).toBe(2020);
    // FLOTA-03: bloque meta de observabilidad (página solo-Haiku, sin Sonnet).
    expect(r.body.meta).toMatchObject({ totalPages: 1, extracted: 1, sonnetAttempted: 0, sonnetErrors: 0, haikuOnlyPages: 1 });
    expect(auditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'upload', resource: 'ocr' }),
    );
  });

  it('FLOTA-03: meta reporta sonnetErrors + sonnetErrorTypes cuando Sonnet falla (post INC-OCR)', async () => {
    pdfLoadMock.mockResolvedValueOnce({ getPageCount: () => 1 });
    extractSinglePageMock.mockResolvedValueOnce({
      _model: 'claude-sonnet-4-6', _confidence_avg: 70, _math_check: 'mismatch', _warnings: [],
      _sonnet_attempted: true, _sonnet_errored: true, _sonnet_error_type: 'not_found_error',
    } as any);
    flattenToLegacyShapeMock.mockReturnValueOnce({ placa: 'ABZ777', _confidence: 70, _model: 'claude-sonnet-4-6' });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/vehicles/ocr').set('Authorization', `Bearer ${token}`)
      .attach('file', PDF_BUFFER, { filename: 'doc.pdf', contentType: 'application/pdf' });
    expect(r.status).toBe(200);
    expect(r.body.meta).toMatchObject({
      totalPages: 1, extracted: 1, sonnetAttempted: 1, sonnetErrors: 1, haikuOnlyPages: 0,
      sonnetErrorTypes: { not_found_error: 1 },
    });
  });

  it('dedup por placa: 2 páginas misma placa → conserva la de mayor _confidence', async () => {
    pdfLoadMock.mockResolvedValueOnce({ getPageCount: () => 2 });
    extractSinglePageMock
      .mockResolvedValueOnce({ _model: 'haiku' } as any)
      .mockResolvedValueOnce({ _model: 'sonnet' } as any);
    flattenToLegacyShapeMock
      .mockReturnValueOnce({ placa: 'ABC555', marca: 'TOYOTA', _confidence: 60, totalPagar: 1000 })
      .mockReturnValueOnce({ placa: 'ABC555', marca: 'CHEVROLET', _confidence: 95, totalPagar: 2000 });

    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/vehicles/ocr').set('Authorization', `Bearer ${token}`)
      .attach('file', PDF_BUFFER, { filename: 'doc.pdf', contentType: 'application/pdf' });
    expect(r.status).toBe(200);
    expect(r.body.vehicles).toHaveLength(1);
    // Conserva la de mayor confianza (95)
    expect(r.body.vehicles[0].marca).toBe('CHEVROLET');
    expect(r.body.vehicles[0].totalPagar).toBe(2000);
  });

  it('múltiples placas distintas → todas se conservan', async () => {
    pdfLoadMock.mockResolvedValueOnce({ getPageCount: () => 3 });
    extractSinglePageMock.mockResolvedValue({ _model: 'haiku' } as any);
    flattenToLegacyShapeMock
      .mockReturnValueOnce({ placa: 'ABZ001', _confidence: 80 })
      .mockReturnValueOnce({ placa: 'ABZ002', _confidence: 85 })
      .mockReturnValueOnce({ placa: 'ABZ003', _confidence: 90 });

    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/vehicles/ocr').set('Authorization', `Bearer ${token}`)
      .attach('file', PDF_BUFFER, { filename: 'doc.pdf', contentType: 'application/pdf' });
    expect(r.status).toBe(200);
    expect(r.body.vehicles).toHaveLength(3);
  });

  it('1 página fallida pero 1 OK → 200 (no aborta)', async () => {
    pdfLoadMock.mockResolvedValueOnce({ getPageCount: () => 2 });
    extractSinglePageMock
      .mockRejectedValueOnce(new Error('timeout p1'))
      .mockResolvedValueOnce({ _model: 'haiku' } as any);
    flattenToLegacyShapeMock.mockReturnValueOnce({ placa: 'ABZ555', _confidence: 90 });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/vehicles/ocr').set('Authorization', `Bearer ${token}`)
      .attach('file', PDF_BUFFER, { filename: 'doc.pdf', contentType: 'application/pdf' });
    expect(r.status).toBe(200);
    expect(r.body.vehicles).toHaveLength(1);
  });
});

describe('POST /ocr-export', () => {
  it('vehicles vacío → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/vehicles/ocr-export').set('Authorization', `Bearer ${token}`)
      .send({ vehicles: [] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Sin datos/);
  });

  it('genera Excel con headers correctos + audit', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/vehicles/ocr-export').set('Authorization', `Bearer ${token}`)
      .send({ vehicles: [{ placa: 'ABZ555', marca: 'TOYOTA', avaluoComercial: 50_000_000 }] });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/spreadsheetml/);
    expect(r.headers['content-disposition']).toMatch(/attachment.*Impuestos_/);
    expect(auditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'export', resource: 'ocr' }),
    );
  });
});

describe('POST /ocr-import — upsert + stage logic', () => {
  it('vehicles vacío → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/vehicles/ocr-import').set('Authorization', `Bearer ${token}`)
      .send({ vehicles: [] });
    expect(r.status).toBe(400);
  });

  it('plate < 5 chars tras normalizar → skipped', async () => {
    transactionMock.mockImplementationOnce(async (cb) => {
      const tx = { select: vi.fn(), insert: vi.fn(), update: vi.fn() };
      return cb(tx);
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/vehicles/ocr-import').set('Authorization', `Bearer ${token}`)
      .send({ vehicles: [{ placa: 'AB' }] });
    expect(r.status).toBe(200);
    expect(r.body.skipped).toBe(1);
    expect(r.body.created).toBe(0);
  });

  it('vehículo no existe → INSERT con stage="impuesto"', async () => {
    let insertedValues: any = null;
    transactionMock.mockImplementationOnce(async (cb) => {
      const tx = {
        select: vi.fn(() => chain([])), // no existe
        insert: vi.fn(() => ({
          values: (v: any) => { insertedValues = v; return Promise.resolve(undefined); },
        })),
        update: vi.fn(),
      };
      return cb(tx);
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/vehicles/ocr-import').set('Authorization', `Bearer ${token}`)
      .send({
        vehicles: [{
          placa: 'ABZ555', marca: 'TOYOTA', modelo: '2020',
          avaluoComercial: '50000000', impuesto: '1000000', totalPagar: '1100000',
          formularioNo: '99999',
        }],
      });
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(1);
    expect(insertedValues.plate).toBe('ABZ555');
    expect(insertedValues.stage).toBe('impuesto');
    expect(insertedValues.year).toBe(2020);
    expect(insertedValues.taxAmount).toBe(1_000_000);
    expect(insertedValues.taxSource).toBe('ocr');
  });

  it('plate normalizada: lowercase + caracteres extra (a-bz-555 → ABZ555)', async () => {
    let insertedValues: any = null;
    transactionMock.mockImplementationOnce(async (cb) => {
      const tx = {
        select: vi.fn(() => chain([])),
        insert: vi.fn(() => ({
          values: (v: any) => { insertedValues = v; return Promise.resolve(undefined); },
        })),
        update: vi.fn(),
      };
      return cb(tx);
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    await request(app).post('/api/vehicles/ocr-import').set('Authorization', `Bearer ${token}`)
      .send({ vehicles: [{ placa: 'a-bz-555' }] });
    expect(insertedValues.plate).toBe('ABZ555');
  });

  it('year fuera de [1970-2030] → null', async () => {
    let insertedValues: any = null;
    transactionMock.mockImplementationOnce(async (cb) => {
      const tx = {
        select: vi.fn(() => chain([])),
        insert: vi.fn(() => ({
          values: (v: any) => { insertedValues = v; return Promise.resolve(undefined); },
        })),
        update: vi.fn(),
      };
      return cb(tx);
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    await request(app).post('/api/vehicles/ocr-import').set('Authorization', `Bearer ${token}`)
      .send({ vehicles: [{ placa: 'ABZ555', modelo: '1900' }] });
    expect(insertedValues.year).toBeNull();
  });

  it('vehículo existe en stage=ingreso → UPDATE con stage=impuesto (avanza)', async () => {
    let updateValues: any = null;
    transactionMock.mockImplementationOnce(async (cb) => {
      const tx = {
        select: vi.fn(() => chain([{ id: 5, stage: 'ingreso' }])),
        update: vi.fn(() => ({
          set: (v: any) => { updateValues = v; return { where: () => Promise.resolve(undefined) }; },
        })),
        insert: vi.fn(),
      };
      return cb(tx);
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/vehicles/ocr-import').set('Authorization', `Bearer ${token}`)
      .send({ vehicles: [{ placa: 'ABZ555' }] });
    expect(r.status).toBe(200);
    expect(r.body.updated).toBe(1);
    expect(updateValues.stage).toBe('impuesto');
  });

  it('vehículo en stage=soat_pendiente → NO retrocede stage (queda igual)', async () => {
    let updateValues: any = null;
    transactionMock.mockImplementationOnce(async (cb) => {
      const tx = {
        select: vi.fn(() => chain([{ id: 5, stage: 'soat_pendiente' }])),
        update: vi.fn(() => ({
          set: (v: any) => { updateValues = v; return { where: () => Promise.resolve(undefined) }; },
        })),
        insert: vi.fn(),
      };
      return cb(tx);
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    await request(app).post('/api/vehicles/ocr-import').set('Authorization', `Bearer ${token}`)
      .send({ vehicles: [{ placa: 'ABZ555' }] });
    expect(updateValues.stage).toBe('soat_pendiente'); // NO retrocede a 'impuesto'
  });

  it('vehículo en stage=listo → permanece en listo', async () => {
    let updateValues: any = null;
    transactionMock.mockImplementationOnce(async (cb) => {
      const tx = {
        select: vi.fn(() => chain([{ id: 5, stage: 'listo' }])),
        update: vi.fn(() => ({
          set: (v: any) => { updateValues = v; return { where: () => Promise.resolve(undefined) }; },
        })),
        insert: vi.fn(),
      };
      return cb(tx);
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    await request(app).post('/api/vehicles/ocr-import').set('Authorization', `Bearer ${token}`)
      .send({ vehicles: [{ placa: 'ABZ555' }] });
    expect(updateValues.stage).toBe('listo');
  });

  it('mix: created + updated + skipped en una llamada', async () => {
    let selectIdx = 0;
    transactionMock.mockImplementationOnce(async (cb) => {
      const tx = {
        select: vi.fn(() => {
          selectIdx++;
          if (selectIdx === 1) return chain([]); // ABZ001 nuevo
          if (selectIdx === 2) return chain([{ id: 9, stage: 'ingreso' }]); // ABZ002 existe
          return chain([]); // n/a
        }),
        insert: vi.fn(() => ({ values: () => Promise.resolve(undefined) })),
        update: vi.fn(() => ({ set: () => ({ where: () => Promise.resolve(undefined) }) })),
      };
      return cb(tx);
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/vehicles/ocr-import').set('Authorization', `Bearer ${token}`)
      .send({
        vehicles: [
          { placa: 'ABZ001' }, // created
          { placa: 'ABZ002' }, // updated
          { placa: 'AB' },     // skipped (< 5)
        ],
      });
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(1);
    expect(r.body.updated).toBe(1);
    expect(r.body.skipped).toBe(1);
    expect(r.body.total).toBe(3);
  });
});
