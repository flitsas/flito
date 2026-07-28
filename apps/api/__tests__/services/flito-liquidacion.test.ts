// HU #10965 — liquidación sellada del trámite (Feature #10939 §2.3).
//
// Lo que se prueba aquí: qué bloquea, qué se considera «no aplica», y sobre qué se calcula el
// 4x1000. El comportamiento transaccional (sellar, reversar, facturar) se verifica además contra
// Postgres real, porque los mocks no detectan un constraint mal escrito.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chain } from '../helpers/db.js';

const selectMock = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const tarifaDeMock = vi.fn();
vi.mock('../../src/modules/flito-parametrizacion/flito-tarifas.service.js', () => ({
  tarifaDe: tarifaDeMock,
}));

const { calcular, TASA_GMF } = await import('../../src/modules/flito-liquidacion/flito-liquidacion.service.js');

/** Fila del trámite con todo pagado y una compañía que no autogestiona nada. */
function filaCompleta(over: Record<string, unknown> = {}) {
  return {
    tramiteId: 't1', idFlit: 'FLIT-1', tipoTramite: 'Traspaso', companiaId: 7,
    logisticaAutogestionable: false, soatAutogestionable: false, impuestosAutogestionable: false,
    soatId: 's1', soatEstado: 'pagado', soatValorPagado: '450000',
    impuestoId: 'i1', impuestoEstado: 'pagado', impuestoValorPagado: '120000',
    derechoValor: '80000',
    ...over,
  };
}

/** Por defecto ambas tarifas configuradas: trámite digital 200.000 y logística 15.000. */
function tarifasConfiguradas() {
  tarifaDeMock.mockImplementation(async (_c: unknown, concepto: string) =>
    concepto === 'tramite_digital'
      ? { valor: 200000, origen: 'especifica' }
      : { valor: 15000, origen: 'generica' });
}

beforeEach(() => {
  selectMock.mockReset();
  tarifaDeMock.mockReset();
  tarifasConfiguradas();
});

describe('calcular — el 4x1000 va sobre los desembolsos reales', () => {
  it('la base son SOAT + impuesto + derecho, no el total', async () => {
    selectMock.mockReturnValueOnce(chain([filaCompleta()]));
    const c = await calcular('t1');

    // 450.000 + 120.000 + 80.000 = 650.000. El trámite digital y la logística NO forman base:
    // son honorarios propios, no giros a un tercero por el banco.
    expect(c.baseGmf).toBe(650000);
    expect(c.tasaGmf).toBe(TASA_GMF);
    expect(c.valorGmf).toBe(2600);
    expect(c.total).toBe(650000 + 200000 + 15000 + 2600);
    expect(c.faltantes).toEqual([]);
  });

  it('la tasa aplicada viaja con el cálculo, no se asume al leer', async () => {
    selectMock.mockReturnValueOnce(chain([filaCompleta()]));
    const c = await calcular('t1');
    expect(c.tasaGmf).toBe(0.004);
  });
});

describe('calcular — qué NO aplica (null, nunca cero)', () => {
  it('la compañía que autogestiona el SOAT no lo paga ni suma a la base', async () => {
    selectMock.mockReturnValueOnce(chain([filaCompleta({ soatAutogestionable: true })]));
    const c = await calcular('t1');
    expect(c.soat.valor).toBeNull();
    expect(c.soat.bloquea).toBe(false);
    expect(c.baseGmf).toBe(120000 + 80000);
    expect(c.faltantes).toEqual([]);
  });

  it('la compañía que autogestiona la logística no la paga', async () => {
    selectMock.mockReturnValueOnce(chain([filaCompleta({ logisticaAutogestionable: true })]));
    const c = await calcular('t1');
    expect(c.logistica.valor).toBeNull();
    expect(c.logistica.bloquea).toBe(false);
    expect(c.total).toBe(650000 + 200000 + 2600); // sin los 15.000 de logística
  });

  it('un trámite exento de impuesto (sin registro) no bloquea', async () => {
    selectMock.mockReturnValueOnce(chain([filaCompleta({ impuestoId: null, impuestoEstado: null, impuestoValorPagado: null })]));
    const c = await calcular('t1');
    expect(c.impuesto.valor).toBeNull();
    expect(c.impuesto.bloquea).toBe(false);
    expect(c.faltantes).toEqual([]);
  });
});

describe('calcular — qué bloquea el sellado', () => {
  it('un impuesto sin pagar impide liquidar y dice por qué', async () => {
    selectMock.mockReturnValueOnce(chain([filaCompleta({ impuestoEstado: 'solicitado', impuestoValorPagado: null })]));
    const c = await calcular('t1');
    expect(c.impuesto.bloquea).toBe(true);
    expect(c.faltantes).toContain('Impuesto en estado "solicitado"');
  });

  it('un SOAT sin pagar impide liquidar', async () => {
    selectMock.mockReturnValueOnce(chain([filaCompleta({ soatEstado: 'pendiente', soatValorPagado: null })]));
    const c = await calcular('t1');
    expect(c.faltantes).toContain('SOAT en estado "pendiente"');
  });

  it('sin recibo de derecho de tránsito no se puede liquidar', async () => {
    // El derecho es el dato que este Feature vino a hacer real: sellar sin él sería volver a inventar.
    selectMock.mockReturnValueOnce(chain([filaCompleta({ derechoValor: null })]));
    const c = await calcular('t1');
    expect(c.derecho.bloquea).toBe(true);
    expect(c.faltantes).toContain('Sin recibo de derecho de tránsito');
  });

  it('sin tarifa configurada bloquea y NO cuenta como cero', async () => {
    tarifaDeMock.mockResolvedValue({ valor: null, origen: 'no_configurada' });
    selectMock.mockReturnValueOnce(chain([filaCompleta()]));
    const c = await calcular('t1');
    expect(c.tramiteDigital.valor).toBeNull();
    expect(c.tramiteDigital.origen).toBe('No configurado');
    expect(c.faltantes).toContain('Tarifa de trámite digital no configurada para la compañía');
    expect(c.faltantes).toContain('Tarifa de logística no configurada para la compañía');
  });

  it('acumula todos los faltantes, no solo el primero', async () => {
    // Quien va a liquidar necesita la lista completa; arreglar de uno en uno es una tortura.
    tarifaDeMock.mockResolvedValue({ valor: null, origen: 'no_configurada' });
    selectMock.mockReturnValueOnce(chain([filaCompleta({
      soatEstado: 'pendiente', soatValorPagado: null,
      impuestoEstado: 'solicitado', impuestoValorPagado: null,
      derechoValor: null,
    })]));
    const c = await calcular('t1');
    expect(c.faltantes.length).toBe(5);
  });

  it('un trámite inexistente falla claro', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    await expect(calcular('no-existe')).rejects.toThrow(/no existe/i);
  });
});

describe('calcular — redondeo', () => {
  it('el GMF se redondea a dos decimales', async () => {
    selectMock.mockReturnValueOnce(chain([filaCompleta({ soatValorPagado: '333333', impuestoValorPagado: null, impuestoId: null, derechoValor: '1' })]));
    const c = await calcular('t1');
    expect(c.baseGmf).toBe(333334);
    expect(c.valorGmf).toBe(1333.34);
  });
});
