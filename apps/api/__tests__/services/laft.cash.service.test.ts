// LAFT F3 · cash.service — registro + breach individual/acumulado + idempotency.
// OPS-02b r2: mock KEYED por tabla. Los SELECT externos (params laft_parametros +
// contraparte laft_counterparties) se enrutan por tabla; el tx interno conserva su
// propio mock posicional (makeTx) porque es la transacción bajo prueba.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chain } from '../helpers/db.js';
import { createKeyedDb } from '../helpers/keyed-db.js';

const kdb = createKeyedDb();
const { select: selectMock, insert: insertMock, update: updateMock, transaction: transactionMock, execute: executeMock } = kdb;

vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

beforeEach(() => {
  kdb.reset();
  executeMock.mockResolvedValue([]);
});

// =============================================================================
// Helpers para construir el "tx" mock que entrega db.transaction(cb).
// Cada test arma una secuencia esperada de selects/inserts.
// =============================================================================

interface MockTxOpts {
  /** Idempotency lookup: filas previas o []. */
  idempPrev?: any[];
  /** Idempotency previous cash row (cuando idempPrev tiene cashTxnId). */
  idempCashRow?: any[];
  /** SUM mensual (string). */
  monthlySum?: string;
  /** Cash insert returning. */
  cashInsertRow?: any;
  /** Unusual operation insert returning. */
  unusualInsertRow?: any;
}

function makeTx(opts: MockTxOpts) {
  const txSelect = vi.fn();
  const txInsert = vi.fn();
  const txUpdate = vi.fn();
  const txExecute = vi.fn().mockResolvedValue([]);

  // 1) idempotency lookup (si hay key)
  if (opts.idempPrev !== undefined) {
    txSelect.mockReturnValueOnce(chain(opts.idempPrev));
  }
  // 2) idempotency cash row (solo si idempPrev tiene cashTxnId)
  if (opts.idempCashRow !== undefined) {
    txSelect.mockReturnValueOnce(chain(opts.idempCashRow));
  }
  // 3) SUM mensual previa (siempre que no sea idempotent return)
  if (opts.monthlySum !== undefined) {
    txSelect.mockReturnValueOnce(chain([{ total: opts.monthlySum }]));
  }
  // 4) INSERT cash txn
  if (opts.cashInsertRow !== undefined) {
    txInsert.mockReturnValueOnce({
      values: () => ({ returning: () => Promise.resolve([opts.cashInsertRow]) }),
    });
  }
  // 5) INSERT unusual operation
  if (opts.unusualInsertRow !== undefined) {
    txInsert.mockReturnValueOnce({
      values: () => ({ returning: () => Promise.resolve([opts.unusualInsertRow]) }),
    });
    // 6) UPDATE cash txn con unusual_operation_id
    txUpdate.mockReturnValueOnce({
      set: () => ({ where: () => Promise.resolve(undefined) }),
    });
  }
  // 7) idempotency record insert (último siempre cuando hay key)
  txInsert.mockReturnValueOnce({
    values: () => ({ onConflictDoNothing: () => Promise.resolve(undefined) }),
  });

  const tx = {
    select: txSelect,
    insert: txInsert,
    update: txUpdate,
    execute: txExecute,
  };
  return tx;
}

const COUNTERPARTY_ROW = {
  id: 5,
  fullName: 'Distribuidora Andina S.A.S.',
  docNumber: '900123456',
  status: 'vinculada',
};

describe('LAFT F3 · cash.service — getCashParams', () => {
  it('lee parámetros de BD y cachea', async () => {
    kdb.when.select('laft_parametros', [
      { clave: 'rte_umbral_individual_cop', valor: '15000000' },
      { clave: 'rte_umbral_acumulado_mensual_cop', valor: '60000000' },
    ]);
    const { getCashParams, resetCashParamsCache } = await import('../../src/modules/laft/cash/cash.service.js');
    resetCashParamsCache();
    const p = await getCashParams();
    expect(p.umbralIndividualCop).toBe(15_000_000);
    expect(p.umbralAcumuladoMensualCop).toBe(60_000_000);
    // Segunda llamada — cache hit, no debe consultar BD
    const p2 = await getCashParams();
    expect(p2.umbralIndividualCop).toBe(15_000_000);
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('valores inválidos → fallback a defaults seguros', async () => {
    kdb.when.select('laft_parametros', [
      { clave: 'rte_umbral_individual_cop', valor: 'not-a-number' },
      { clave: 'rte_umbral_acumulado_mensual_cop', valor: '-100' },
    ]);
    const { getCashParams, resetCashParamsCache } = await import('../../src/modules/laft/cash/cash.service.js');
    resetCashParamsCache();
    const p = await getCashParams();
    expect(p.umbralIndividualCop).toBe(10_000_000);
    expect(p.umbralAcumuladoMensualCop).toBe(50_000_000);
  });
});

describe('LAFT F3 · cash.service — registrarCashTxn', () => {
  beforeEach(async () => {
    // Cada test fresco: reset cache de params + mock params.
    const { resetCashParamsCache } = await import('../../src/modules/laft/cash/cash.service.js');
    resetCashParamsCache();
    // Mock seed para getCashParams (siempre se llama antes del tx).
    kdb.when.select('laft_parametros', [
      { clave: 'rte_umbral_individual_cop', valor: '10000000' },
      { clave: 'rte_umbral_acumulado_mensual_cop', valor: '50000000' },
    ]);
  });

  it('contraparte no existe → throw httpStatus 400', async () => {
    // El primer select que se hace es contraparte (NO params, porque cache hit en este test).
    kdb.when.select('laft_counterparties', []); // contraparte vacío
    const { registrarCashTxn, resetCashParamsCache } = await import('../../src/modules/laft/cash/cash.service.js');
    resetCashParamsCache();
    // Forzar miss de cache: mockear params como segundo select
    kdb.when.select('laft_parametros', [
      { clave: 'rte_umbral_individual_cop', valor: '10000000' },
    ]);
    await expect(registrarCashTxn({
      counterpartyId: 999,
      amount: 5_000_000,
      currency: 'COP',
      kind: 'efectivo',
      fecha: '2026-04-01',
    }, 1, 'idem-' + Date.now())).rejects.toMatchObject({ httpStatus: 400 });
  });

  it('happy path efectivo bajo umbral → registra sin breach', async () => {
    kdb.when.select('laft_counterparties', [COUNTERPARTY_ROW]); // contraparte ok

    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = makeTx({
        idempPrev: [],
        monthlySum: '0',
        cashInsertRow: {
          id: 100, counterpartyId: 5, amount: '5000000', currency: 'COP', kind: 'efectivo',
          fecha: '2026-04-01', thresholdIndividualBreached: false, thresholdAcumuladoBreached: false,
          unusualOperationId: null, rosDraftId: null,
        },
      });
      return cb(tx);
    });

    const { registrarCashTxn } = await import('../../src/modules/laft/cash/cash.service.js');
    const r = await registrarCashTxn({
      counterpartyId: 5, amount: 5_000_000, currency: 'COP',
      kind: 'efectivo', fecha: '2026-04-01',
    }, 7, 'idem-aaa-bbb-ccc');
    expect(r.breachIndividual).toBe(false);
    expect(r.breachAcumulado).toBe(false);
    expect(r.unusualOperationId).toBeNull();
    expect(r.idempotent).toBe(false);
    expect(r.txn.id).toBe(100);
  });

  it('breach individual → crea unusual operation con signal "efectivo_umbral_individual"', async () => {
    kdb.when.select('laft_counterparties', [COUNTERPARTY_ROW]);
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = makeTx({
        idempPrev: [],
        monthlySum: '0',
        cashInsertRow: {
          id: 101, counterpartyId: 5, amount: '12000000', kind: 'efectivo',
          thresholdIndividualBreached: true, thresholdAcumuladoBreached: false,
          unusualOperationId: null,
        },
        unusualInsertRow: { id: 555 },
      });
      return cb(tx);
    });

    const { registrarCashTxn } = await import('../../src/modules/laft/cash/cash.service.js');
    const r = await registrarCashTxn({
      counterpartyId: 5, amount: 12_000_000, currency: 'COP',
      kind: 'efectivo', fecha: '2026-04-15',
    }, 7, 'idem-breach-ind');
    expect(r.breachIndividual).toBe(true);
    expect(r.breachAcumulado).toBe(false);
    expect(r.unusualOperationId).toBe(555);
  });

  it('breach acumulado mensual: monthlyBefore=45M + 8M=53M cruza umbral 50M', async () => {
    kdb.when.select('laft_counterparties', [COUNTERPARTY_ROW]);
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = makeTx({
        idempPrev: [],
        monthlySum: '45000000',
        cashInsertRow: {
          id: 102, counterpartyId: 5, amount: '8000000', kind: 'efectivo',
          thresholdIndividualBreached: false, thresholdAcumuladoBreached: true,
          unusualOperationId: null,
        },
        unusualInsertRow: { id: 777 },
      });
      return cb(tx);
    });

    const { registrarCashTxn } = await import('../../src/modules/laft/cash/cash.service.js');
    const r = await registrarCashTxn({
      counterpartyId: 5, amount: 8_000_000, currency: 'COP',
      kind: 'efectivo', fecha: '2026-04-20',
    }, 7, 'idem-breach-acum');
    expect(r.breachIndividual).toBe(false);
    expect(r.breachAcumulado).toBe(true);
    expect(r.unusualOperationId).toBe(777);
    expect(r.monthlySumAfter).toBe(53_000_000);
  });

  it('mes ya estaba sobre el umbral acumulado: NO reporta breach acumulado dos veces', async () => {
    kdb.when.select('laft_counterparties', [COUNTERPARTY_ROW]);
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = makeTx({
        idempPrev: [],
        monthlySum: '60000000', // ya cruzado en una txn previa
        cashInsertRow: {
          id: 103, counterpartyId: 5, amount: '500000', kind: 'efectivo',
          thresholdIndividualBreached: false, thresholdAcumuladoBreached: false,
          unusualOperationId: null,
        },
      });
      return cb(tx);
    });

    const { registrarCashTxn } = await import('../../src/modules/laft/cash/cash.service.js');
    const r = await registrarCashTxn({
      counterpartyId: 5, amount: 500_000, currency: 'COP',
      kind: 'efectivo', fecha: '2026-04-25',
    }, 7, 'idem-no-redoble');
    expect(r.breachAcumulado).toBe(false);
    expect(r.unusualOperationId).toBeNull();
  });

  it('idempotency: 2da llamada con misma key devuelve fila previa sin insertar', async () => {
    kdb.when.select('laft_counterparties', [COUNTERPARTY_ROW]);
    const PREV = {
      id: 200, counterpartyId: 5, amount: '5000000', kind: 'efectivo',
      thresholdIndividualBreached: false, thresholdAcumuladoBreached: false,
      unusualOperationId: null, rosDraftId: null,
    };
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const txSelect = vi.fn();
      txSelect.mockReturnValueOnce(chain([{ key: 'idem-x', scope: 'cash_txn', cashTxnId: 200 }]));
      txSelect.mockReturnValueOnce(chain([PREV]));
      const tx = {
        select: txSelect,
        insert: vi.fn(),
        update: vi.fn(),
        execute: vi.fn().mockResolvedValue([]),
      };
      return cb(tx);
    });

    const { registrarCashTxn } = await import('../../src/modules/laft/cash/cash.service.js');
    const r = await registrarCashTxn({
      counterpartyId: 5, amount: 5_000_000, currency: 'COP',
      kind: 'efectivo', fecha: '2026-04-01',
    }, 7, 'idem-x');
    expect(r.idempotent).toBe(true);
    expect(r.txn.id).toBe(200);
  });

  it('kind=transferencia: nunca produce breach, no consulta SUM efectivo en breach detection', async () => {
    kdb.when.select('laft_counterparties', [COUNTERPARTY_ROW]);
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = makeTx({
        idempPrev: [],
        monthlySum: '0',
        cashInsertRow: {
          id: 104, counterpartyId: 5, amount: '100000000', kind: 'transferencia',
          thresholdIndividualBreached: false, thresholdAcumuladoBreached: false,
          unusualOperationId: null,
        },
      });
      return cb(tx);
    });

    const { registrarCashTxn } = await import('../../src/modules/laft/cash/cash.service.js');
    const r = await registrarCashTxn({
      counterpartyId: 5, amount: 100_000_000, currency: 'COP',
      kind: 'transferencia', fecha: '2026-04-10',
    }, 7, 'idem-transfer');
    expect(r.breachIndividual).toBe(false);
    expect(r.breachAcumulado).toBe(false);
  });
});
