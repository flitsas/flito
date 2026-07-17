// TRAM-INNOV-B3 — firma desde el portal del participante (token-based).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createKeyedDb } from '../helpers/keyed-db.js';

const kdb = createKeyedDb();

vi.mock('../../src/db/client.js', () => ({
  db: new Proxy({}, { get: (_t, p) => (kdb.db as Record<string | symbol, unknown>)[p] }),
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

import { getFirmaPortalUrl, simularFirmaPortal } from '../../src/modules/tramites/portal.js';

const TOKEN = 'tok_abcdefghijklmnop'; // cumple PORTAL_TOKEN_RE (>=16)
const PART = { id: 11, tramiteId: 7, rol: 'comprador', consent1581At: new Date(), completedAt: null, expiresAt: new Date(Date.now() + 86400000) };

beforeEach(() => { kdb.reset(); });

describe('getFirmaPortalUrl', () => {
  it('participante con firma activa → ok + url', async () => {
    kdb.when
      .select('tramite_participantes', [PART])
      .select('tramite_firmas', [{ id: 1, tramiteId: 7, rol: 'comprador', proveedor: 'mock', estado: 'enviada', envelopeId: 'env_x', metadata: { signUrl: 'https://test/firma/env_x' } }]);
    const r = await getFirmaPortalUrl(TOKEN);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.url).toContain('env_x'); expect(r.proveedor).toBe('mock'); }
  });

  it('sin firma pendiente → ok:false', async () => {
    kdb.when.select('tramite_participantes', [PART]).select('tramite_firmas', []);
    const r = await getFirmaPortalUrl(TOKEN);
    expect(r.ok).toBe(false);
  });

  it('token con formato inválido → ok:false (no consulta)', async () => {
    const r = await getFirmaPortalUrl('corto');
    expect(r.ok).toBe(false);
  });
});

describe('simularFirmaPortal', () => {
  it('firma mock → completa (firmada)', async () => {
    kdb.when
      .select('tramite_participantes', [PART])
      .select('tramite_firmas', [{ id: 1, tramiteId: 7, rol: 'comprador', docTipo: 'compraventa', proveedor: 'mock', estado: 'enviada', envelopeId: 'env_x', pdfPath: null, sha256: null }])
      .update('tramite_firmas', [{ id: 1, tramiteId: 7, rol: 'comprador', estado: 'firmada', firmadoAt: new Date() }])
      .insert('tramite_eventos', []);
    const r = await simularFirmaPortal(TOKEN);
    expect(r.ok).toBe(true);
  });

  it('proveedor no-mock → no_mock', async () => {
    kdb.when
      .select('tramite_participantes', [PART])
      .select('tramite_firmas', [{ id: 1, tramiteId: 7, rol: 'comprador', proveedor: 'zapsign', estado: 'enviada', envelopeId: 'env_z' }]);
    const r = await simularFirmaPortal(TOKEN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('no_mock');
  });

  it('sin firma → sin_firma', async () => {
    kdb.when.select('tramite_participantes', [PART]).select('tramite_firmas', []);
    const r = await simularFirmaPortal(TOKEN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('sin_firma');
  });
});
