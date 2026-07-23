// FLITO Impuestos — carga de recibos → Pagado (Fase 4 P3). Verifica evaluarReciboImpuesto (puro),
// dedup CA-08 por hash, cruce contra EN_GESTION, conciliación → PAGADO y revisión. drizzle + OCR +
// storage mockeados; invariantes de BD además con smoke.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';
import { CampoImpuesto, MotivoRevision } from '@operaciones/shared-types';

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

const { evaluarReciboImpuesto, evaluarDiferencia } = await import('../../src/modules/flito-impuestos/flito-recibos.service.js');

beforeEach(() => { selectMock.mockReset(); insertMock.mockReset(); updateMock.mockReset(); transactionMock.mockReset(); extraerMock.mockReset(); uploadMock.mockClear(); });

const campo = (valor: string | null, confianza: number) => ({ valor, confianza, confiable: confianza >= 0.85 });

// ─────────────────────────── evaluarReciboImpuesto (puro) ────────────────────

describe('evaluarReciboImpuesto — solo placa (llave) + valorTotal bloquean', () => {
  it('placa y valorTotal confiables → aprobada', () => {
    const e = { [CampoImpuesto.PLACA]: campo('QTQ100', 0.95), [CampoImpuesto.VALOR_TOTAL]: campo('634900', 0.95) };
    expect(evaluarReciboImpuesto(e, 0.85)).toEqual({ aprobada: true });
  });
  it('placa bajo umbral → CONFIANZA_INSUFICIENTE', () => {
    const e = { [CampoImpuesto.PLACA]: campo('QTQ100', 0.3), [CampoImpuesto.VALOR_TOTAL]: campo('634900', 0.95) };
    expect(evaluarReciboImpuesto(e, 0.85).motivo).toBe(MotivoRevision.CONFIANZA_INSUFICIENTE);
  });
  it('valorTotal bajo umbral → CONFIANZA_INSUFICIENTE', () => {
    const e = { [CampoImpuesto.PLACA]: campo('QTQ100', 0.95), [CampoImpuesto.VALOR_TOTAL]: campo('634900', 0.3) };
    const v = evaluarReciboImpuesto(e, 0.85);
    expect(v.aprobada).toBe(false);
    expect(v.detalle).toContain(CampoImpuesto.VALOR_TOTAL);
  });
  it('placa ausente → CONFIANZA_INSUFICIENTE', () => {
    const e = { [CampoImpuesto.VALOR_TOTAL]: campo('634900', 0.95) };
    expect(evaluarReciboImpuesto(e, 0.85).aprobada).toBe(false);
  });
});

// ─────────────────────── evaluarDiferencia (D-5, Fase 7) ─────────────────────

describe('evaluarDiferencia — marca de diferencia de valor por organismo (D-5)', () => {
  it('organismo con flag apagado → nunca marca, aunque haya diferencia', () => {
    expect(evaluarDiferencia({ diferenciaActiva: false, valorLiquidado: '100000', tolerancia: '0' }, '999999')).toBe(false);
  });
  it('flag encendido + diferencia sobre tolerancia → marca', () => {
    expect(evaluarDiferencia({ diferenciaActiva: true, valorLiquidado: '100000', tolerancia: '1000' }, '105000')).toBe(true);
  });
  it('flag encendido pero diferencia dentro de la tolerancia → no marca', () => {
    expect(evaluarDiferencia({ diferenciaActiva: true, valorLiquidado: '100000', tolerancia: '5000' }, '104000')).toBe(false);
  });
  it('flag encendido pero sin valorLiquidado fiable → no marca', () => {
    expect(evaluarDiferencia({ diferenciaActiva: true, valorLiquidado: null, tolerancia: '0' }, '104000')).toBe(false);
  });
  it('flag encendido pero sin valorPagado → no marca', () => {
    expect(evaluarDiferencia({ diferenciaActiva: true, valorLiquidado: '100000', tolerancia: '0' }, null)).toBe(false);
  });
});

// ─────────────────────────── Ruta POST /recibos ──────────────────────────────

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-impuestos/flito-impuestos.routes.js');
  app.use('/api/flito/impuestos', router);
  return app;
}
const auth = async (role: string) => `Bearer ${await testToken({ sub: 5, username: 'g@x.io', role: role as never })}`;
const UUID = '00000000-0000-0000-0000-0000000000dd';

const candidato = {
  impuestoId: UUID, estado: 'solicitado', organismoCodigo: '08001', tramiteIdFlit: 'FLIT-1', placa: 'QTQ100',
  companiaId: 1, document: '900', carpeta: null, valorLiquidado: '500000',
};
const reciboOk = { [CampoImpuesto.PLACA]: campo('QTQ100', 0.95), [CampoImpuesto.VALOR_TOTAL]: campo('634900', 0.95), [CampoImpuesto.NUMERO_RECIBO]: campo('R-1', 0.95) };

describe('recibos — RBAC', () => {
  it('auditor → POST /recibos 403', async () => {
    const r = await request(await buildApp()).post('/api/flito/impuestos/recibos').set('Authorization', await auth('auditor')).attach('archivos', Buffer.from('%PDF'), 'r.pdf');
    expect(r.status).toBe(403);
  });
});

describe('recibos — flujo', () => {
  it('archivo idéntico ya cargado → duplicado (CA-08 por hash), sin OCR', async () => {
    selectMock.mockReturnValueOnce(chain([{ impuestoId: UUID }])); // dedup por hash
    const r = await request(await buildApp()).post('/api/flito/impuestos/recibos').set('Authorization', await auth('admin')).attach('archivos', Buffer.from('%PDF'), 'QTQ100.pdf');
    expect(r.status).toBe(200);
    expect(r.body.duplicados).toHaveLength(1);
    expect(extraerMock).not.toHaveBeenCalled();
  });

  it('placa que no cruza con ningún en gestión (ni pagado) → noAsociado', async () => {
    selectMock.mockReturnValueOnce(chain([]));  // dedup hash
    extraerMock.mockResolvedValueOnce(reciboOk);
    selectMock.mockReturnValueOnce(chain([]));  // candidato EN_GESTION
    selectMock.mockReturnValueOnce(chain([]));  // adjuntarComplemento: PAGADO
    const r = await request(await buildApp()).post('/api/flito/impuestos/recibos').set('Authorization', await auth('admin')).attach('archivos', Buffer.from('%PDF'), 'QTQ100.pdf');
    expect(r.status).toBe(200);
    expect(r.body.noAsociados).toHaveLength(1);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('cruza y confiable → concilia a PAGADO (RN-03 impuestos)', async () => {
    selectMock.mockReturnValueOnce(chain([]));           // dedup hash
    extraerMock.mockResolvedValueOnce(reciboOk);
    selectMock.mockReturnValueOnce(chain([candidato]));  // candidato EN_GESTION
    selectMock.mockReturnValueOnce(chain([]));           // dedup por número de recibo
    const txInsert = vi.fn().mockReturnValueOnce(chain([{ id: 'sop1' }])).mockReturnValueOnce(chain([])); // soporte + audit
    const txUpdate = vi.fn().mockReturnValue(chain([]));
    transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => cb({ insert: txInsert, update: txUpdate }));

    const r = await request(await buildApp()).post('/api/flito/impuestos/recibos').set('Authorization', await auth('admin')).attach('archivos', Buffer.from('%PDF'), 'QTQ100.pdf');
    expect(r.status).toBe(200);
    expect(r.body.conciliados).toHaveLength(1);
    expect(txUpdate).toHaveBeenCalledTimes(1); // → PAGADO
  });

  it('cruza pero baja confianza en valorTotal → revisión (CA-06), no paga', async () => {
    selectMock.mockReturnValueOnce(chain([]));           // dedup hash
    extraerMock.mockResolvedValueOnce({ ...reciboOk, [CampoImpuesto.VALOR_TOTAL]: campo('634900', 0.3) });
    selectMock.mockReturnValueOnce(chain([candidato]));  // candidato EN_GESTION
    selectMock.mockReturnValueOnce(chain([]));           // dedup por número de recibo
    const txInsert = vi.fn().mockReturnValueOnce(chain([{ id: 'sop1' }])).mockReturnValueOnce(chain([])).mockReturnValueOnce(chain([])); // soporte + revisión + audit
    const txUpdate = vi.fn().mockReturnValue(chain([]));
    transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => cb({ insert: txInsert, update: txUpdate }));

    const r = await request(await buildApp()).post('/api/flito/impuestos/recibos').set('Authorization', await auth('admin')).attach('archivos', Buffer.from('%PDF'), 'QTQ100.pdf');
    expect(r.status).toBe(200);
    expect(r.body.enRevision).toHaveLength(1);
    expect(txUpdate).not.toHaveBeenCalled(); // NO pasó a pagado
  });
});
