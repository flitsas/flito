// TRAM-INNOV-B5-MVP — liquidacion.service (db keyed por tabla).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createKeyedDb } from '../helpers/keyed-db.js';

const kdb = createKeyedDb();

vi.mock('../../src/db/client.js', () => ({
  db: new Proxy({}, { get: (_t, p) => (kdb.db as Record<string | symbol, unknown>)[p] }),
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

import { crearLiquidacion, confirmarPago, getLiquidacion } from '../../src/modules/liquidacion/liquidacion.service.js';

const now = new Date();
beforeEach(() => { kdb.reset(); });

describe('crearLiquidacion', () => {
  it('calcula subtotales y total; estado borrador', async () => {
    kdb.when
      .insert('liquidaciones', [{ id: 1 }])
      .insert('liquidacion_items', [])
      // getLiquidacion:
      .select('liquidaciones', [{ id: 1, woId: 9, tramiteId: null, estado: 'borrador', total: '150.00', nota: 'OT', createdAt: now, confirmadaAt: null }])
      .select('liquidacion_items', [{ id: 1, descripcion: 'Mano de obra', cantidad: '2', valorUnitario: '50', subtotal: '100' }, { id: 2, descripcion: 'Repuesto', cantidad: '1', valorUnitario: '50', subtotal: '50' }])
      .select('pagos', []);

    const liq = await crearLiquidacion({ woId: 9, items: [{ descripcion: 'Mano de obra', cantidad: 2, valorUnitario: 50 }, { descripcion: 'Repuesto', cantidad: 1, valorUnitario: 50 }], userId: 1 });
    expect(liq.estado).toBe('borrador');
    expect(liq.total).toBe(150);
    expect(liq.items).toHaveLength(2);
    expect(liq.items[0].subtotal).toBe(100);
  });
});

describe('confirmarPago', () => {
  it('liquidación borrador → pago manual + confirmada', async () => {
    kdb.when
      .select('liquidaciones', [{ id: 1, estado: 'confirmada', woId: 9, tramiteId: null, total: '150.00', nota: null, createdAt: now, confirmadaAt: now }])
      .select('liquidacion_items', [])
      .select('pagos', [{ id: 1, metodo: 'manual', estado: 'manual_confirmado', monto: '150', referencia: null, nota: 'efectivo', createdAt: now }])
      .insert('pagos', [{ id: 1 }])
      .update('liquidaciones', [{ id: 1 }]);
    // Nota: la 1ª select (estado) y las de getLiquidacion comparten fallback de tabla.
    const r = await confirmarPago({ liquidacionId: 1, monto: 150, nota: 'efectivo', userId: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.liquidacion.estado).toBe('confirmada');
      expect(r.liquidacion.pagos[0].monto).toBe(150);
    }
  });

  it('liquidación inexistente → not_found', async () => {
    kdb.when.select('liquidaciones', []);
    const r = await confirmarPago({ liquidacionId: 99, monto: 10, userId: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });

  it('liquidación anulada → anulada', async () => {
    kdb.when.select('liquidaciones', [{ id: 1, estado: 'anulada' }]);
    const r = await confirmarPago({ liquidacionId: 1, monto: 10, userId: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('anulada');
  });
});

describe('getLiquidacion', () => {
  it('mapea numerics a number', async () => {
    kdb.when
      .select('liquidaciones', [{ id: 1, woId: 9, tramiteId: null, estado: 'confirmada', total: '99.50', nota: null, createdAt: now, confirmadaAt: now }])
      .select('liquidacion_items', [])
      .select('pagos', [{ id: 1, metodo: 'manual', estado: 'manual_confirmado', monto: '99.5', referencia: 'rcb-1', nota: null, createdAt: now }]);
    const liq = await getLiquidacion(1);
    expect(liq?.total).toBe(99.5);
    expect(liq?.pagos[0].monto).toBe(99.5);
    expect(typeof liq?.total).toBe('number');
  });
});
