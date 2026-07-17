// TRAM-TRASPASO-F2 — generación de documentos legales (proxy CEA) + gate de firma.
//
// Cubre AC-F2: generarContrato/generarImprontas mapean upstream 200/500/timeout,
// marcan metadatos en el JSONB del vehículo, y hayContratoCompraventa detecta
// contrato generado o subido (tipo 'compraventa').

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createKeyedDb } from '../helpers/keyed-db.js';

const kdb = createKeyedDb();

const { requestWithRetry } = vi.hoisted(() => ({ requestWithRetry: vi.fn() }));

vi.mock('../../src/db/client.js', () => ({
  db: new Proxy({}, { get: (_t, p) => (kdb.db as Record<string | symbol, unknown>)[p] }),
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/shared/upstream.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/shared/upstream.js')>('../../src/shared/upstream.js');
  return { ...actual, requestWithRetry };
});

import { generarContrato, generarImprontas, hayContratoCompraventa } from '../../src/modules/tramites/tramites.service.js';
import { UpstreamError } from '../../src/shared/upstream.js';

const TRAMITE = {
  id: 1, placa: 'ABC123', vin: 'VIN123',
  comprador: { nombre: 'Comprador', documento: '111', tipoDoc: 'CC' },
  vehiculo: {
    marca: 'Mazda', linea: '3', modelo: '2020', numMotor: 'M1', numChasis: 'CH1',
    _vendedor: { nombre: 'Vendedor', documento: '222', tipoDoc: 'CC', ciudad: 'Medellín' },
    _comprador: { nombre: 'Comprador', documento: '111', tipoDoc: 'CC', ciudad: 'Medellín' },
    _comercial: { valorVenta: 30000000, causal: 'COMPRAVENTA' },
  },
};

beforeEach(() => { kdb.reset(); requestWithRetry.mockReset(); });

describe('generarContrato (proxy CEA)', () => {
  it('upstream 200 → PDF binario + marca contratoAt en el JSONB', async () => {
    kdb.when.select('tramites_digitales', [TRAMITE]).update('tramites_digitales', [{ id: 1 }]);
    requestWithRetry.mockResolvedValue({ statusCode: 200, buffer: Buffer.from('%PDF-contrato'), attempts: 1 });

    const r = await generarContrato(1, { orgNombre: 'CEA Demo', orgCiudad: 'Medellín' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.contentType).toBe('application/pdf');
      expect(r.pdf.toString()).toContain('%PDF-contrato');
    }
    // Llamó al endpoint internal con la x-internal-key.
    const call = requestWithRetry.mock.calls[0][0];
    expect(call.url).toContain('contrato-compraventa-internal');
    expect(call.headers['x-internal-key']).toBe('test-runt-internal-key-12345');
    // Persistió metadatos del documento.
    const upd = kdb.update.mock.calls.length;
    expect(upd).toBeGreaterThan(0);
  });

  it('TRAM-F3: incluye firmantes (sellos firma_serie) en el payload a CEA', async () => {
    kdb.when
      .select('tramites_digitales', [TRAMITE])
      .select('tramites_validaciones', [
        { parte: 'vendedor', nombre: 'Vendedor', documento: '222', tipoDoc: 'CC', email: 'ven@x.co', firmaSerie: 'KYV-FEA-20260607-AAA', firmaHash: 'h1', firmaTimestamp: null, estado: 'aprobado' },
        { parte: 'comprador', nombre: 'Comprador', documento: '111', tipoDoc: 'CC', email: 'comp@x.co', firmaSerie: 'KYV-FEA-20260607-BBB', firmaHash: 'h2', firmaTimestamp: null, estado: 'aprobado' },
      ])
      .update('tramites_digitales', [{ id: 1 }]);
    requestWithRetry.mockResolvedValue({ statusCode: 200, buffer: Buffer.from('%PDF'), attempts: 1 });

    const r = await generarContrato(1, {});
    expect(r.ok).toBe(true);
    const body = JSON.parse(requestWithRetry.mock.calls[0][0].body);
    expect(Array.isArray(body.firmantes)).toBe(true);
    expect(body.firmantes).toHaveLength(2);
    expect(body.firmantes[0].firma_serie).toMatch(/^KYV-FEA-/);
    expect(body.firmantes.map((f: any) => f.parte).sort()).toEqual(['COMPRADOR', 'VENDEDOR']);
  });

  it('upstream 500 → doc_upstream con status mapeado + upstreamStatus', async () => {
    kdb.when.select('tramites_digitales', [TRAMITE]);
    requestWithRetry.mockResolvedValue({ statusCode: 500, buffer: Buffer.from(''), attempts: 3 });

    const r = await generarContrato(1, {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('doc_upstream');
      expect((r as any).upstreamStatus).toBe(500);
    }
  });

  it('timeout (UpstreamError) → doc_timeout', async () => {
    kdb.when.select('tramites_digitales', [TRAMITE]);
    requestWithRetry.mockRejectedValue(new UpstreamError('timeout', 'timeout'));

    const r = await generarContrato(1, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('doc_timeout');
  });

  it('trámite inexistente → not_found (sin llamar upstream)', async () => {
    kdb.when.select('tramites_digitales', []);
    const r = await generarContrato(99, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
    expect(requestWithRetry).not.toHaveBeenCalled();
  });
});

describe('generarImprontas (proxy CEA, respuesta JSON base64)', () => {
  it('upstream 200 JSON → decodifica base64 + hash + marca improntasHash', async () => {
    kdb.when.select('tramites_digitales', [TRAMITE]).update('tramites_digitales', [{ id: 1 }]);
    const pdfB64 = Buffer.from('%PDF-improntas').toString('base64');
    const json = JSON.stringify({ ok: true, pdf: `data:application/pdf;base64,${pdfB64}`, hash: 'abc123hash' });
    requestWithRetry.mockResolvedValue({ statusCode: 200, buffer: Buffer.from(json), attempts: 1 });

    const r = await generarImprontas(1, {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pdf.toString()).toContain('%PDF-improntas');
      expect(r.hash).toBe('abc123hash');
    }
    expect(requestWithRetry.mock.calls[0][0].url).toContain('improntas-internal');
  });

  it('JSON inválido → doc_upstream', async () => {
    kdb.when.select('tramites_digitales', [TRAMITE]);
    requestWithRetry.mockResolvedValue({ statusCode: 200, buffer: Buffer.from('no-es-json'), attempts: 1 });
    const r = await generarImprontas(1, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('doc_upstream');
  });
});

describe('hayContratoCompraventa (gate firma)', () => {
  it('true si _docs_generados.contratoAt presente', async () => {
    kdb.when.select('tramites_digitales', [{ vehiculo: { _docs_generados: { contratoAt: '2026-06-07T00:00:00Z' } } }]);
    expect(await hayContratoCompraventa(1)).toBe(true);
  });

  it('true si hay documento tipo compraventa subido', async () => {
    kdb.when
      .select('tramites_digitales', [{ vehiculo: {} }])
      .select('tramites_documentos', [{ id: 9 }]);
    expect(await hayContratoCompraventa(1)).toBe(true);
  });

  it('false si no hay contrato generado ni subido', async () => {
    kdb.when
      .select('tramites_digitales', [{ vehiculo: {} }])
      .select('tramites_documentos', []);
    expect(await hayContratoCompraventa(1)).toBe(false);
  });
});
