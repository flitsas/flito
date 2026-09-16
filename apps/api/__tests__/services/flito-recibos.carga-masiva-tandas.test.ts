// HU #12051 — tandas de la carga masiva de recibos: tope HTTP 5, OCR en pool, persist serial,
// CA-08 antes del pool. OCR y storage mockeados.
//
// HU #12590 (AC1): la ruta resuelve la FASE y se la pasa al servicio — `fase` del form manda;
// `sinMarcaDeAgua='true'` sigue valiendo como «liquidación» por compatibilidad; una fase fuera del
// catálogo es 400 antes de OCR, transacción o storage.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';
import { CampoImpuesto, CARGA_MASIVA_MAX_BYTES_ARCHIVO, FaseRecibo } from '@operaciones/shared-types';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: insertMock, update: updateMock, delete: vi.fn(), transaction: transactionMock, execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const extraerMock = vi.fn();
vi.mock('../../src/modules/flito-ocr/flito-ocr.service.js', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, extraerReciboImpuesto: extraerMock };
});
const uploadMock = vi.fn().mockResolvedValue('flito/impuestos/recibos/k.pdf');
vi.mock('../../src/services/storage.js', () => ({ uploadEntityDocument: uploadMock }));

const { cargarRecibosSpy } = vi.hoisted(() => ({ cargarRecibosSpy: vi.fn() }));
vi.mock('../../src/modules/flito-impuestos/flito-recibos.service.js', async (orig) => {
  const real = await orig() as typeof import('../../src/modules/flito-impuestos/flito-recibos.service.js');
  return {
    ...real,
    cargarRecibos: async (...args: Parameters<typeof real.cargarRecibos>) => {
      cargarRecibosSpy(...args);
      return real.cargarRecibos(...args);
    },
  };
});

beforeEach(() => {
  selectMock.mockReset(); insertMock.mockReset(); updateMock.mockReset(); transactionMock.mockReset();
  extraerMock.mockReset(); uploadMock.mockReset(); cargarRecibosSpy.mockReset();
  uploadMock.mockResolvedValue('flito/impuestos/recibos/k.pdf');
});

const campo = (valor: string | null, confianza: number) => ({ valor, confianza, confiable: confianza >= 0.85 });
const UUID = '00000000-0000-0000-0000-0000000000dd';
const candidato = {
  impuestoId: UUID, estado: 'solicitado', organismoCodigo: '08001', tramiteIdFlit: 'FLIT-1', tramiteId: 't1',
  placa: 'QTQ100', companiaId: 1, carpeta: null, valorLiquidado: '500000', diferenciaActiva: false, tolerancia: '0',
  liquidadoEn: null,
};
const reciboOk = {
  [CampoImpuesto.PLACA]: campo('QTQ100', 0.95),
  [CampoImpuesto.VALOR_TOTAL]: campo('634900', 0.95),
  [CampoImpuesto.NUMERO_RECIBO]: campo('R-1', 0.95),
};
/**
 * Una placa por archivo (`r0.pdf` → QTQ000, `r1.pdf` → QTQ001…): estas pruebas miden tandas y
 * concurrencia, no el cruce, y con la MISMA placa en todo el lote la HU #12614 (AC5) los trataría
 * como el par liquidación/pago de un solo impuesto y, sin sello legible, los rechazaría.
 */
const reciboDe = async (doc: { nombreArchivo: string }) => ({
  ...reciboOk, [CampoImpuesto.PLACA]: campo(`QTQ${doc.nombreArchivo.replace(/\D/g, '').padStart(3, '0')}`, 0.95),
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-impuestos/flito-impuestos.routes.js');
  app.use('/api/flito/impuestos', router);
  app.use((err: { code?: string; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ error: err.message ?? String(err), code: err.code });
  });
  return app;
}
const auth = async () => `Bearer ${await testToken({ sub: 5, username: 'g@x.io', role: 'admin' })}`;
const pdf = (i: number) => Buffer.from(`%PDF-recibo-${i}`);

function mockTxOk() {
  transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => {
    const txInsert = vi.fn().mockReturnValueOnce(chain([{ id: 'sop1' }])).mockReturnValue(chain([]));
    const txUpdate = vi.fn().mockReturnValue(chain([]));
    return cb({ insert: txInsert, update: txUpdate });
  });
}

function mockHashesLibresLuegoCandidato(n: number) {
  for (let i = 0; i < n; i++) selectMock.mockReturnValueOnce(chain([]));
  for (let i = 0; i < n; i++) {
    selectMock.mockReturnValueOnce(chain([candidato]));
    selectMock.mockReturnValueOnce(chain([]));
  }
}

async function postRecibos(n: number, opts?: { buffers?: Buffer[]; sinMarca?: boolean; fase?: string }) {
  const app = await buildApp();
  let req = request(app).post('/api/flito/impuestos/recibos').set('Authorization', await auth());
  if (opts?.sinMarca) req = req.field('sinMarcaDeAgua', 'true');
  if (opts?.fase !== undefined) req = req.field('fase', opts.fase);
  for (let i = 0; i < n; i++) req = req.attach('archivos', opts?.buffers?.[i] ?? pdf(i), `r${i}.pdf`);
  return req;
}

describe('HU #12051 — carga masiva recibos tandas', () => {
  it('POST /recibos con 6 attach → ≠ 200 (tope HTTP 5)', async () => {
    const r = await postRecibos(6);
    expect(r.status).not.toBe(200);
  });

  it('5 attach + mocks → 200', async () => {
    mockHashesLibresLuegoCandidato(5);
    extraerMock.mockImplementation(reciboDe);
    mockTxOk();
    const r = await postRecibos(5);
    expect(r.status).toBe(200);
    expect(r.body.conciliados).toHaveLength(5);
    expect(extraerMock).toHaveBeenCalledTimes(5);
  });

  it('attach > 15 MiB → rechazo multer (regresión 12050)', async () => {
    const grande = Buffer.alloc(CARGA_MASIVA_MAX_BYTES_ARCHIVO + 1);
    const r = await postRecibos(1, { buffers: [grande] });
    expect(r.status).not.toBe(200);
    expect(extraerMock).not.toHaveBeenCalled();
  });

  it('3 archivos, extraer con delay: maxInflight OCR ≥ 2 (pool, no for serial)', async () => {
    mockHashesLibresLuegoCandidato(3);
    mockTxOk();
    let inflight = 0;
    let maxInflight = 0;
    extraerMock.mockImplementation(async (doc: { nombreArchivo: string }) => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 40));
      inflight -= 1;
      return reciboDe(doc);
    });
    const r = await postRecibos(3);
    expect(r.status).toBe(200);
    expect(maxInflight).toBeGreaterThanOrEqual(2);
  });

  it('upload/tx: maxInflight === 1 (persist serial)', async () => {
    mockHashesLibresLuegoCandidato(3);
    extraerMock.mockImplementation(reciboDe);
    let inflight = 0;
    let maxInflight = 0;
    const track = async <T>(fn: () => Promise<T>): Promise<T> => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      try { return await fn(); } finally { inflight -= 1; }
    };
    uploadMock.mockImplementation(() => track(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return 'flito/impuestos/recibos/k.pdf';
    }));
    transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => track(async () => {
      await new Promise((r) => setTimeout(r, 20));
      const txInsert = vi.fn().mockReturnValueOnce(chain([{ id: 'sop1' }])).mockReturnValue(chain([]));
      const txUpdate = vi.fn().mockReturnValue(chain([]));
      return cb({ insert: txInsert, update: txUpdate });
    }));
    const r = await postRecibos(3);
    expect(r.status).toBe(200);
    expect(maxInflight).toBe(1);
  });

  it('hash ya persistido → duplicados y extraerReciboImpuesto NO se llama (CA-08)', async () => {
    selectMock.mockReturnValueOnce(chain([{ impuestoId: UUID }]));
    const r = await postRecibos(1);
    expect(r.status).toBe(200);
    expect(r.body.duplicados).toHaveLength(1);
    expect(extraerMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('compat: sinMarcaDeAgua=true sin `fase` llega al servicio como liquidación', async () => {
    mockHashesLibresLuegoCandidato(1);
    extraerMock.mockResolvedValue(reciboOk);
    mockTxOk();
    const r = await postRecibos(1, { sinMarca: true });
    expect(r.status).toBe(200);
    expect(cargarRecibosSpy).toHaveBeenCalled();
    expect(cargarRecibosSpy.mock.calls[0][1]).toBe(FaseRecibo.LIQUIDACION);
    // Liquidación del impuesto: el resumen la cuenta en `liquidados`, no en `conciliados`.
    expect(r.body.liquidados).toHaveLength(1);
    expect(r.body.conciliados).toHaveLength(0);
  });
});

describe('HU #12590 (AC1) — la fase la declara quien carga', () => {
  it("fase='liquidacion' llega al servicio y cada suelto va como liquidación", async () => {
    mockHashesLibresLuegoCandidato(2);
    extraerMock.mockImplementation(reciboDe);
    mockTxOk();
    const r = await postRecibos(2, { fase: 'liquidacion' });
    expect(r.status).toBe(200);
    expect(cargarRecibosSpy.mock.calls[0][1]).toBe(FaseRecibo.LIQUIDACION);
    expect(r.body.liquidados).toHaveLength(2);
    expect(r.body.conciliados).toHaveLength(0);
    expect(r.body.enRevision).toHaveLength(0);
  });

  it("sin `fase` ni `sinMarcaDeAgua` → 'pago'; fase='pago' → 'pago'", async () => {
    mockHashesLibresLuegoCandidato(1);
    extraerMock.mockResolvedValue(reciboOk);
    mockTxOk();
    const r1 = await postRecibos(1);
    expect(r1.status).toBe(200);
    expect(cargarRecibosSpy.mock.calls[0][1]).toBe(FaseRecibo.PAGO);
    expect(r1.body.conciliados).toHaveLength(1);
    expect(r1.body.liquidados).toHaveLength(0);

    cargarRecibosSpy.mockReset();
    mockHashesLibresLuegoCandidato(1);
    const r2 = await postRecibos(1, { fase: 'pago' });
    expect(r2.status).toBe(200);
    expect(cargarRecibosSpy.mock.calls[0][1]).toBe(FaseRecibo.PAGO);
  });

  it("`fase` explícita manda sobre `sinMarcaDeAgua`", async () => {
    mockHashesLibresLuegoCandidato(1);
    extraerMock.mockResolvedValue(reciboOk);
    mockTxOk();
    const r = await postRecibos(1, { sinMarca: true, fase: 'pago' });
    expect(r.status).toBe(200);
    expect(cargarRecibosSpy.mock.calls[0][1]).toBe(FaseRecibo.PAGO);
  });

  it('fase fuera del catálogo → 400 ANTES de OCR, transacción, storage y servicio', async () => {
    const r = await postRecibos(1, { fase: 'x' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/fase inválida/);
    expect(cargarRecibosSpy).not.toHaveBeenCalled();
    expect(extraerMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
    // Ni siquiera se resolvió el contexto: cero consultas.
    expect(selectMock).not.toHaveBeenCalled();
  });
});
