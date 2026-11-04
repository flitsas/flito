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

// HU #14291 (R9): valores de frontera fijados con la fórmula original, ejecutada antes de extraerla a
// `shared/utils/redondeo.ts`. Se afirma lo que llega a la BD, que es donde el redondeo importa.
describe('redondeo a dos decimales — lo que se persiste no cambia (HU #14291)', () => {
  /** Encola un INSERT que guarda sus `values` y responde `filas`. */
  function capturarInsert(filas: unknown[] = []) {
    const values = vi.fn(() => Object.assign(Promise.resolve(filas), { returning: async () => filas }));
    kdb.insert.mockReturnValueOnce({ values } as never);
    return values;
  }

  it('crearLiquidacion redondea cada subtotal y el total', async () => {
    const cabecera = capturarInsert([{ id: 1 }]);
    const lineas = capturarInsert();

    await crearLiquidacion({
      items: [
        { descripcion: 'flotante por debajo de .005', cantidad: 1, valorUnitario: 1.005 },
        { descripcion: 'negativo', cantidad: 1, valorUnitario: -1.555 },
        { descripcion: 'cero', cantidad: 0, valorUnitario: 5 },
      ],
      userId: 1,
    });

    const subtotales = (lineas.mock.calls[0] as unknown as [Array<{ subtotal: string }>])[0].map((l) => l.subtotal);
    expect(subtotales).toEqual(['1', '-1.55', '0']);
    expect((cabecera.mock.calls[0] as unknown as [{ total: string }])[0].total).toBe('-0.55');
  });

  it('crearLiquidacion limpia el ruido de flotante de la suma', async () => {
    const cabecera = capturarInsert([{ id: 1 }]);
    capturarInsert();

    await crearLiquidacion({
      items: [
        { descripcion: 'a', cantidad: 1, valorUnitario: 0.1 },
        { descripcion: 'b', cantidad: 1, valorUnitario: 0.2 },
      ],
      userId: 1,
    });

    expect((cabecera.mock.calls[0] as unknown as [{ total: string }])[0].total).toBe('0.3');
  });

  it.each([
    [1.005, '1'],
    [100.005, '100.01'],
    [-1.005, '-1'],
    [0, '0'],
  ])('confirmarPago guarda el monto %s como %s', async (monto, esperado) => {
    kdb.when.select('liquidaciones', [{ id: 1, estado: 'borrador', total: '0', createdAt: now, confirmadaAt: null }]);
    const pago = capturarInsert();

    await confirmarPago({ liquidacionId: 1, monto, userId: 1 });

    expect((pago.mock.calls[0] as unknown as [{ monto: string }])[0].monto).toBe(esperado);
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
