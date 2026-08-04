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

/**
 * Fila del trámite con todo pagado, una compañía que no autogestiona nada y un organismo que sí
 * entrega el impuesto en gestión: FLITO gestiona los cinco conceptos, así que los cinco se exigen.
 */
function filaCompleta(over: Record<string, unknown> = {}) {
  return {
    tramiteId: 't1', idFlit: 'FLIT-1', tipoTramite: 'Traspaso', companiaId: 7,
    logisticaAutogestionable: false, soatAutogestionable: false, impuestosAutogestionable: false,
    modalidadOrganismo: 'requiere_gestion',
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

describe('calcular — el 4x1000 va sobre el total del trámite', () => {
  it('la base son los cinco conceptos, y el GMF se suma encima', async () => {
    selectMock.mockReturnValueOnce(chain([filaCompleta()]));
    const c = await calcular('t1');

    // 450.000 + 120.000 + 80.000 + 200.000 + 15.000 = 865.000. El gravamen se calcula sobre esa
    // suma y se añade al final, así que el total es la base más su propio GMF.
    expect(c.baseGmf).toBe(865000);
    expect(c.tasaGmf).toBe(TASA_GMF);
    expect(c.valorGmf).toBe(3460);
    expect(c.total).toBe(865000 + 3460);
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
    expect(c.baseGmf).toBe(120000 + 80000 + 200000 + 15000);
    expect(c.faltantes).toEqual([]);
  });

  it('la compañía que autogestiona la logística no la paga', async () => {
    selectMock.mockReturnValueOnce(chain([filaCompleta({ logisticaAutogestionable: true })]));
    const c = await calcular('t1');
    expect(c.logistica.valor).toBeNull();
    expect(c.logistica.bloquea).toBe(false);
    // Sin los 15.000 de logística: ni en la base ni, por tanto, en el GMF.
    expect(c.baseGmf).toBe(850000);
    expect(c.total).toBe(850000 + 3400);
  });

  it('la compañía que autogestiona el impuesto no lo paga', async () => {
    selectMock.mockReturnValueOnce(chain([filaCompleta({
      impuestosAutogestionable: true, impuestoId: null, impuestoEstado: null, impuestoValorPagado: null,
    })]));
    const c = await calcular('t1');
    expect(c.impuesto.valor).toBeNull();
    expect(c.impuesto.bloquea).toBe(false);
    expect(c.faltantes).toEqual([]);
  });

  it('el organismo que no entrega el impuesto en gestión tampoco lo hace exigible (RN-01)', async () => {
    // El segundo eje de la regla: la compañía querría que FLITO se lo gestionara, pero ese organismo
    // no lo entrega. Sin vigencia abierta el default es el mismo, autogestionado.
    selectMock.mockReturnValueOnce(chain([filaCompleta({
      modalidadOrganismo: null, impuestoId: null, impuestoEstado: null, impuestoValorPagado: null,
    })]));
    const c = await calcular('t1');
    expect(c.impuesto.bloquea).toBe(false);
    expect(c.impuesto.origen).toBe('El organismo no requiere gestión del impuesto');
    expect(c.faltantes).toEqual([]);
  });

  it('a la compañía que lo autogestiona todo solo se le cobran trámite digital y derecho', async () => {
    // Es el caso que describe la operación: sin SOAT, sin impuesto y sin logística de FLITO, el
    // trámite se liquida igual — con esos dos conceptos y nada más.
    selectMock.mockReturnValueOnce(chain([filaCompleta({
      soatAutogestionable: true, impuestosAutogestionable: true, logisticaAutogestionable: true,
      soatId: null, soatEstado: null, soatValorPagado: null,
      impuestoId: null, impuestoEstado: null, impuestoValorPagado: null,
    })]));
    const c = await calcular('t1');
    expect(c.faltantes).toEqual([]);
    expect(c.baseGmf).toBe(80000 + 200000);
  });
});

describe('calcular — lo que FLITO gestiona TIENE que tener valor', () => {
  // El fallo que esto cierra: la ausencia de registro se leía como «exento» y dejaba sellar. Pero el
  // sync tampoco crea el registro cuando el trámite no llegó a Asignado o le faltaba emparejar
  // compañía u organismo, así que una compañía a la que FLITO le gestiona TODO se liquidaba sin SOAT
  // y sin impuesto, congelando un total al que le faltaban dos desembolsos reales.

  it('sin SOAT gestionado no se puede liquidar, aunque no exista el registro', async () => {
    selectMock.mockReturnValueOnce(chain([filaCompleta({
      soatId: null, soatEstado: null, soatValorPagado: null,
    })]));
    const c = await calcular('t1');
    expect(c.soat.bloquea).toBe(true);
    expect(c.faltantes).toContain('Sin SOAT gestionado');
  });

  it('sin impuesto gestionado tampoco, si el organismo lo entrega en gestión', async () => {
    selectMock.mockReturnValueOnce(chain([filaCompleta({
      impuestoId: null, impuestoEstado: null, impuestoValorPagado: null,
    })]));
    const c = await calcular('t1');
    expect(c.impuesto.bloquea).toBe(true);
    expect(c.faltantes).toContain('Sin impuesto gestionado');
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
    // 333.333 + 1 + 200.000 (digital) + 15.000 (logística) = 548.334; × 0,004 = 2.193,336
    expect(c.baseGmf).toBe(548334);
    expect(c.valorGmf).toBe(2193.34);
  });
});
