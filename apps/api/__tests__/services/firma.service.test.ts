// TRAM-INNOV-B3 — firma.service (mock provider, db keyed por tabla).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createKeyedDb } from '../helpers/keyed-db.js';

const kdb = createKeyedDb();

// Import estático de firma.service → la factory de vi.mock corre en el hoisting,
// antes de inicializar `kdb`. Un Proxy difiere el acceso a `kdb.db` hasta runtime.
vi.mock('../../src/db/client.js', () => ({
  db: new Proxy({}, { get: (_t, p) => (kdb.db as Record<string | symbol, unknown>)[p] }),
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

import { solicitarFirma, completarFirma, getFirmaResumen } from '../../src/modules/firma/firma.service.js';
import type { FirmaProvider } from '../../src/modules/firma/provider.js';

const stubProvider: FirmaProvider = {
  nombre: 'mock',
  crearSolicitud: vi.fn().mockResolvedValue({ envelopeId: 'env_test_1', signUrl: 'https://test/firma/env_test_1' }),
};

beforeEach(() => { kdb.reset(); (stubProvider.crearSolicitud as any).mockClear(); });

describe('solicitarFirma', () => {
  it('happy path traspaso_standard → firma enviada + signUrl', async () => {
    kdb.when
      .select('tramites_digitales', [{ id: 7, tipologiaCodigo: 'traspaso_standard' }])
      .select('tramite_participantes', [{ id: 11, nombre: 'Ana', email: 'ana@x.co', rol: 'comprador' }])
      .select('tramite_firmas', [])
      .insert('tramite_firmas', [{ id: 1, tramiteId: 7, rol: 'comprador', docTipo: 'compraventa', proveedor: 'mock', envelopeId: 'env_test_1', estado: 'enviada', solicitadoAt: new Date(), firmadoAt: null }])
      .insert('tramite_eventos', []);

    const r = await solicitarFirma({ tramiteId: 7, rol: 'comprador', userId: 1, provider: stubProvider });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.firma.estado).toBe('enviada');
      expect(r.signUrl).toContain('env_test_1');
    }
    expect(stubProvider.crearSolicitud).toHaveBeenCalledOnce();
  });

  it('tipología distinta de traspaso_standard → tipologia_invalida', async () => {
    kdb.when.select('tramites_digitales', [{ id: 7, tipologiaCodigo: 'sucesion' }]);
    const r = await solicitarFirma({ tramiteId: 7, rol: 'comprador', userId: 1, provider: stubProvider });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('tipologia_invalida');
    expect(stubProvider.crearSolicitud).not.toHaveBeenCalled();
  });

  it('trámite inexistente → not_found', async () => {
    kdb.when.select('tramites_digitales', []);
    const r = await solicitarFirma({ tramiteId: 99, rol: 'comprador', userId: 1, provider: stubProvider });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });

  it('rol inválido → rol_invalido (sin tocar BD)', async () => {
    const r = await solicitarFirma({ tramiteId: 7, rol: 'mandatario', userId: 1, provider: stubProvider });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('rol_invalido');
  });

  it('participante sin email → participante_sin_email', async () => {
    kdb.when
      .select('tramites_digitales', [{ id: 7, tipologiaCodigo: 'traspaso_standard' }])
      .select('tramite_participantes', [{ id: 11, nombre: 'Ana', email: null, rol: 'comprador' }]);
    const r = await solicitarFirma({ tramiteId: 7, rol: 'comprador', userId: 1, provider: stubProvider });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('participante_sin_email');
  });

  it('idempotencia: ya hay firma activa → duplicada', async () => {
    kdb.when
      .select('tramites_digitales', [{ id: 7, tipologiaCodigo: 'traspaso_standard' }])
      .select('tramite_participantes', [{ id: 11, nombre: 'Ana', email: 'ana@x.co', rol: 'comprador' }])
      .select('tramite_firmas', [{ id: 1 }]); // activa
    const r = await solicitarFirma({ tramiteId: 7, rol: 'comprador', userId: 1, provider: stubProvider });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('duplicada');
    expect(stubProvider.crearSolicitud).not.toHaveBeenCalled();
  });

  // TRAM-TRASPASO-F2 — gate de contrato (solo modalidad traspaso).
  // Dos SELECT sobre tramites_digitales (tramite + chequeo de contrato): usar
  // selectOnce (FIFO) porque .select fija un único fallback por tabla.
  it('modalidad traspaso sin contrato → contrato_requerido', async () => {
    kdb.when
      .selectOnce('tramites_digitales', [{ id: 7, tipologiaCodigo: 'traspaso_standard', modalidad: 'traspaso' }])
      // hayContratoCompraventa: vehiculo sin _docs_generados + sin documento compraventa.
      .selectOnce('tramites_digitales', [{ vehiculo: {} }])
      .select('tramites_documentos', []);
    const r = await solicitarFirma({ tramiteId: 7, rol: 'comprador', userId: 1, provider: stubProvider });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('contrato_requerido');
    expect(stubProvider.crearSolicitud).not.toHaveBeenCalled();
  });

  it('modalidad traspaso con contrato generado → continúa (firma enviada)', async () => {
    kdb.when
      .selectOnce('tramites_digitales', [{ id: 7, tipologiaCodigo: 'traspaso_standard', modalidad: 'traspaso' }])
      // hayContratoCompraventa: contratoAt presente → true (no consulta documentos).
      .selectOnce('tramites_digitales', [{ vehiculo: { _docs_generados: { contratoAt: '2026-06-07T00:00:00Z' } } }])
      .select('tramite_participantes', [{ id: 11, nombre: 'Ana', email: 'ana@x.co', rol: 'comprador' }])
      .select('tramite_firmas', [])
      .insert('tramite_firmas', [{ id: 1, tramiteId: 7, rol: 'comprador', docTipo: 'compraventa', proveedor: 'mock', envelopeId: 'env_test_1', estado: 'enviada', solicitadoAt: new Date(), firmadoAt: null }])
      .insert('tramite_eventos', []);
    const r = await solicitarFirma({ tramiteId: 7, rol: 'comprador', userId: 1, provider: stubProvider });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.firma.estado).toBe('enviada');
    expect(stubProvider.crearSolicitud).toHaveBeenCalledOnce();
  });
});

describe('completarFirma', () => {
  it('envelope conocido → firmada + evento', async () => {
    kdb.when
      .select('tramite_firmas', [{ id: 1, tramiteId: 7, rol: 'comprador', docTipo: 'compraventa', proveedor: 'mock', envelopeId: 'env_test_1', estado: 'enviada', pdfPath: null, sha256: null }])
      .update('tramite_firmas', [{ id: 1, tramiteId: 7, rol: 'comprador', estado: 'firmada', firmadoAt: new Date() }])
      .insert('tramite_eventos', []);
    const r = await completarFirma({ envelopeId: 'env_test_1', resultado: 'firmada', sha256: 'a'.repeat(64) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.firma.estado).toBe('firmada');
  });

  it('envelope desconocido → envelope_no_encontrado', async () => {
    kdb.when.select('tramite_firmas', []);
    const r = await completarFirma({ envelopeId: 'nope', resultado: 'firmada' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('envelope_no_encontrado');
  });
});

describe('getFirmaResumen', () => {
  it('mapea rol+estado y filtra roles desconocidos', async () => {
    kdb.when.select('tramite_firmas', [
      { rol: 'comprador', estado: 'firmada' },
      { rol: 'vendedor', estado: 'enviada' },
      { rol: 'mandatario', estado: 'firmada' },
    ]);
    const r = await getFirmaResumen(7);
    expect(r).toEqual([
      { rol: 'comprador', estado: 'firmada' },
      { rol: 'vendedor', estado: 'enviada' },
    ]);
  });
});
