// TRAM-TRASPASO-F1 — createTramite (modalidad traspaso) + transicionarEstadoStt.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createKeyedDb } from '../helpers/keyed-db.js';

const kdb = createKeyedDb();

vi.mock('../../src/db/client.js', () => ({
  db: new Proxy({}, { get: (_t, p) => (kdb.db as Record<string | symbol, unknown>)[p] }),
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

import { createTramite, transicionarEstadoStt } from '../../src/modules/tramites/tramites.service.js';

beforeEach(() => { kdb.reset(); });

describe('createTramite — traspaso (placa-first)', () => {
  it('genera radicado y nace en estado radicado con workflow', async () => {
    kdb.execute.mockResolvedValue([{ seq: '7' }]); // nextval('tramite_radicado_seq')
    kdb.when.insert('tramites_digitales', [{
      id: 1, vin: null, placa: 'ABC123', estado: 'radicado', modalidadEntrada: 'traspaso',
      numeroRadicado: 'TD-2026-00007', workflow: [{ de: null, a: 'radicado' }],
    }]);
    const t = await createTramite({ modalidadEntrada: 'traspaso', placa: 'ABC123', vehiculo: { marca: 'Mazda' } }, 3);
    expect(t.estado).toBe('radicado');
    expect((t as any).modalidadEntrada).toBe('traspaso');
    expect((t as any).numeroRadicado).toBe('TD-2026-00007');
  });
});

describe('transicionarEstadoStt', () => {
  it('traspaso radicado → en_validacion (ok + append workflow)', async () => {
    kdb.when
      .select('tramites_digitales', [{ estado: 'radicado', modalidad: 'traspaso', radicado: 'TD-2026-00007', workflow: [], organismoCodigo: '05001', vehiculo: { _vendedor: { documento: '111' } }, comprador: { documento: '222' }, furGenerado: false }])
      .select('tramites_validaciones', [
        { id: 1, parte: 'vendedor', documento: '111', estado: 'aprobado' },
        { id: 2, parte: 'comprador', documento: '222', estado: 'aprobado' },
      ])
      .update('tramites_digitales', [{ id: 1 }]);
    const r = await transicionarEstadoStt({ tramiteId: 1, estado: 'en_validacion', userId: 3, username: 'op' });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.estado).toBe('en_validacion'); expect(r.numeroRadicado).toBe('TD-2026-00007'); }
  });

  it('transito de otro organismo → organismo_forbidden', async () => {
    kdb.when.select('tramites_digitales', [{ estado: 'radicado', modalidad: 'traspaso', radicado: 'TD-x', workflow: [], organismoCodigo: '05266' }]);
    const r = await transicionarEstadoStt({
      tramiteId: 1, estado: 'en_validacion', userId: 7, username: 'stt',
      actorRole: 'transito', transitoCodigo: '05001',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('organismo_forbidden');
  });

  it('transición inválida → transicion_invalida', async () => {
    kdb.when.select('tramites_digitales', [{ estado: 'radicado', modalidad: 'traspaso', radicado: 'TD-x', workflow: [], organismoCodigo: null }]);
    const r = await transicionarEstadoStt({ tramiteId: 1, estado: 'entregado', userId: 3, username: 'op' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('transicion_invalida');
  });

  it('trámite no traspaso → no_traspaso', async () => {
    kdb.when.select('tramites_digitales', [{ estado: 'borrador', modalidad: 'matricula_inicial', radicado: null, workflow: [], organismoCodigo: null }]);
    const r = await transicionarEstadoStt({ tramiteId: 1, estado: 'en_validacion', userId: 3, username: 'op' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('no_traspaso');
  });

  it('inexistente → not_found', async () => {
    kdb.when.select('tramites_digitales', []);
    const r = await transicionarEstadoStt({ tramiteId: 99, estado: 'en_validacion', userId: 3, username: 'op' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });
});
