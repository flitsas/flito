import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chain } from '../helpers/db.js';

// Mocks de db, client RNDC, credenciales service, operaciones repo.
const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const transactionMock = vi.fn();
const executeMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock,
    insert: insertMock,
    update: updateMock,
    transaction: transactionMock,
    execute: executeMock,
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const ingresarManifiestoMock = vi.fn();
const consultarEstadoIngresoMock = vi.fn();
const modoMock = vi.fn(() => 'mock' as const);
vi.mock('../../src/modules/rndc/client/factory.js', () => ({
  getRndcClient: () => ({
    ingresarRemesa: vi.fn(),
    ingresarManifiesto: ingresarManifiestoMock,
    anularRemesa: vi.fn(),
    anularManifiesto: vi.fn(),
    consultarEstadoIngreso: consultarEstadoIngresoMock,
    modo: modoMock,
  }),
}));

const getActiveCredencialesMock = vi.fn();
vi.mock('../../src/modules/rndc/credenciales.service.js', () => ({
  getActiveCredenciales: getActiveCredencialesMock,
}));

const logOperacionMock = vi.fn();
vi.mock('../../src/modules/rndc/operaciones.repo.js', () => ({
  logOperacion: logOperacionMock,
}));

const VALID_CREDS = {
  creds: {
    numNit: '900123456-1',
    claveQR: 'top-secret',
    habilitadorNit: '900654321',
    empresaNit: '900123456',
    ambiente: 'sandbox' as const,
  },
};

const MANIFIESTO_BASE = {
  id: 10,
  numero: 'MAN-202605-0001',
  estadoEnvio: 'pendiente_envio',
  intentosEnvio: 0,
  consecutivoRndc: null,
  vehiculoPrincipalId: 1,
  conductorId: 2,
  municipioOrigenDane: '05001',
  municipioDestinoDane: '11001',
  fechaExpedicion: '2026-05-06',
  valorFleteTotal: '1000000',
  anuladoAt: null,
  deletedAt: null,
};

// Helper: mockea db.transaction(claim) con un row que pasa todas las validaciones.
function mockClaimTxOk(row = MANIFIESTO_BASE, remesasOk = true) {
  transactionMock.mockImplementationOnce(async (cb: any) => {
    const tx = {
      execute: vi.fn().mockResolvedValue([]),
      select: vi.fn()
        .mockReturnValueOnce(chain([row]))                                           // primer SELECT FOR UPDATE
        .mockReturnValueOnce(chain(remesasOk ? [{ id: 1, estado: 'activa', anuladoAt: null }] : [])),
      update: vi.fn().mockReturnValueOnce(chain([])),                                // flip a 'enviando'
    };
    return cb(tx);
  });
}

// Helper: mockea db.transaction(success) — actualiza manifiesto + idempotency.
function mockSuccessTx() {
  transactionMock.mockImplementationOnce(async (cb: any) => {
    const tx = {
      update: vi.fn()
        .mockReturnValueOnce(chain([])) // update manifiestos
        .mockReturnValueOnce(chain([])), // update idempotency
    };
    return cb(tx);
  });
}

describe('envio.service — encolar', () => {
  beforeEach(() => {
    selectMock.mockReset();
    insertMock.mockReset();
    updateMock.mockReset();
    transactionMock.mockReset();
    executeMock.mockReset();
    ingresarManifiestoMock.mockReset();
    consultarEstadoIngresoMock.mockReset();
    getActiveCredencialesMock.mockReset();
    logOperacionMock.mockReset();
  });

  it('encolarManifiesto actualiza estado a pendiente_envio', async () => {
    updateMock.mockReturnValueOnce(chain([]));
    const { encolarManifiesto } = await import('../../src/modules/rndc/envio.service.js');
    await encolarManifiesto(42);
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it('encolarRemesa actualiza estado a pendiente_envio', async () => {
    updateMock.mockReturnValueOnce(chain([]));
    const { encolarRemesa } = await import('../../src/modules/rndc/envio.service.js');
    await encolarRemesa(7);
    expect(updateMock).toHaveBeenCalledTimes(1);
  });
});

describe('envio.service — procesarManifiesto: estados no procesables', () => {
  beforeEach(() => {
    selectMock.mockReset();
    insertMock.mockReset();
    updateMock.mockReset();
    transactionMock.mockReset();
    ingresarManifiestoMock.mockReset();
    getActiveCredencialesMock.mockReset();
  });

  it('manifiesto no encontrado → cancelado_pre_envio (sin SOAP)', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        execute: vi.fn().mockResolvedValue([]),
        select: vi.fn().mockReturnValueOnce(chain([])), // no row
        update: vi.fn(),
      };
      return cb(tx);
    });
    const { procesarManifiesto } = await import('../../src/modules/rndc/envio.service.js');
    const r = await procesarManifiesto(999);
    expect(r.estadoFinal).toBe('cancelado_pre_envio');
    expect(ingresarManifiestoMock).not.toHaveBeenCalled();
  });

  it('manifiesto soft-deleted → cancelado_pre_envio', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        execute: vi.fn().mockResolvedValue([]),
        select: vi.fn().mockReturnValueOnce(chain([{ ...MANIFIESTO_BASE, deletedAt: new Date() }])),
        update: vi.fn(),
      };
      return cb(tx);
    });
    const { procesarManifiesto } = await import('../../src/modules/rndc/envio.service.js');
    const r = await procesarManifiesto(10);
    expect(r.estadoFinal).toBe('cancelado_pre_envio');
  });

  it('manifiesto ya aceptado → cancelado_pre_envio (no reenvía)', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        execute: vi.fn().mockResolvedValue([]),
        select: vi.fn().mockReturnValueOnce(chain([{ ...MANIFIESTO_BASE, estadoEnvio: 'aceptado' }])),
        update: vi.fn(),
      };
      return cb(tx);
    });
    const { procesarManifiesto } = await import('../../src/modules/rndc/envio.service.js');
    const r = await procesarManifiesto(10);
    expect(r.estadoFinal).toBe('cancelado_pre_envio');
    expect(ingresarManifiestoMock).not.toHaveBeenCalled();
  });

  it('manifiesto fallido_definitivo → cancelado_pre_envio', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        execute: vi.fn().mockResolvedValue([]),
        select: vi.fn().mockReturnValueOnce(chain([{ ...MANIFIESTO_BASE, estadoEnvio: 'fallido_definitivo' }])),
        update: vi.fn(),
      };
      return cb(tx);
    });
    const { procesarManifiesto } = await import('../../src/modules/rndc/envio.service.js');
    const r = await procesarManifiesto(10);
    expect(r.estadoFinal).toBe('cancelado_pre_envio');
  });

  it('manifiesto anulado (anuladoAt) → cancelado_pre_envio + flip a estado', async () => {
    const setCallSpy = vi.fn().mockReturnValueOnce(chain([]));
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        execute: vi.fn().mockResolvedValue([]),
        select: vi.fn().mockReturnValueOnce(chain([{ ...MANIFIESTO_BASE, anuladoAt: new Date() }])),
        update: vi.fn(() => ({ set: setCallSpy })) as any,
      };
      // re-cablear chain de update para que set() siga funcionando con el spy
      tx.update = vi.fn().mockReturnValueOnce({ set: () => chain([]) }) as any;
      return cb(tx);
    });
    const { procesarManifiesto } = await import('../../src/modules/rndc/envio.service.js');
    const r = await procesarManifiesto(10);
    expect(r.estadoFinal).toBe('cancelado_pre_envio');
  });

  it('remesa asociada anulada → cancelado_pre_envio sin SOAP', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        execute: vi.fn().mockResolvedValue([]),
        select: vi.fn()
          .mockReturnValueOnce(chain([MANIFIESTO_BASE]))                              // claim
          .mockReturnValueOnce(chain([{ id: 1, estado: 'anulada', anuladoAt: null }])), // remesas asociadas
        update: vi.fn().mockReturnValueOnce(chain([])),
      };
      return cb(tx);
    });
    const { procesarManifiesto } = await import('../../src/modules/rndc/envio.service.js');
    const r = await procesarManifiesto(10);
    expect(r.estadoFinal).toBe('cancelado_pre_envio');
    expect(ingresarManifiestoMock).not.toHaveBeenCalled();
  });
});

describe('envio.service — idempotencia', () => {
  beforeEach(() => {
    selectMock.mockReset();
    insertMock.mockReset();
    updateMock.mockReset();
    transactionMock.mockReset();
    ingresarManifiestoMock.mockReset();
    getActiveCredencialesMock.mockReset();
    logOperacionMock.mockReset();
  });

  it('ya tiene consecutivoRndc → marca aceptado sin SOAP', async () => {
    mockClaimTxOk({ ...MANIFIESTO_BASE, consecutivoRndc: 'CR-EXISTENTE' });
    updateMock.mockReturnValueOnce(chain([]));

    const { procesarManifiesto } = await import('../../src/modules/rndc/envio.service.js');
    const r = await procesarManifiesto(10);
    expect(r.ok).toBe(true);
    expect(r.estadoFinal).toBe('aceptado');
    expect(r.consecutivoRndc).toBe('CR-EXISTENTE');
    expect(ingresarManifiestoMock).not.toHaveBeenCalled();
  });

  it('idempotency_keys con mismo hash → reusar consecutivo (sin SOAP)', async () => {
    mockClaimTxOk();
    getActiveCredencialesMock.mockResolvedValueOnce(VALID_CREDS);

    // El requestHash que el servicio computa internamente es determinístico para un payload dado.
    // Generamos el mismo payload literal que el servicio para que el hash coincida.
    const { hashRequest } = await import('../../src/shared/utils/crypto.js');
    const payload = {
      consec: MANIFIESTO_BASE.numero,
      vehiculoPrincipalId: MANIFIESTO_BASE.vehiculoPrincipalId,
      conductorId: MANIFIESTO_BASE.conductorId,
      municipioOrigenDane: MANIFIESTO_BASE.municipioOrigenDane,
      municipioDestinoDane: MANIFIESTO_BASE.municipioDestinoDane,
      fechaExpedicion: MANIFIESTO_BASE.fechaExpedicion,
      valorFleteTotal: MANIFIESTO_BASE.valorFleteTotal,
    };
    const expectedHash = hashRequest(payload);

    selectMock.mockReturnValueOnce(chain([{
      consecutivoLocal: MANIFIESTO_BASE.numero,
      consecutivoRndc: 'CR-PREVIA',
      requestHash: expectedHash,
    }]));
    updateMock.mockReturnValueOnce(chain([]));

    const { procesarManifiesto } = await import('../../src/modules/rndc/envio.service.js');
    const r = await procesarManifiesto(10);
    expect(r.ok).toBe(true);
    expect(r.consecutivoRndc).toBe('CR-PREVIA');
    expect(r.mensaje).toMatch(/idempotencia/i);
    expect(ingresarManifiestoMock).not.toHaveBeenCalled();
  });

  it('idempotency_keys con hash distinto → PAYLOAD_DIVERGENCE → error_envio', async () => {
    mockClaimTxOk();
    getActiveCredencialesMock.mockResolvedValueOnce(VALID_CREDS);
    selectMock.mockReturnValueOnce(chain([{
      consecutivoLocal: MANIFIESTO_BASE.numero,
      consecutivoRndc: 'CR-PREVIA',
      requestHash: 'hash-DIFERENTE',
    }]));
    updateMock.mockReturnValueOnce(chain([])); // marca error_envio

    const { procesarManifiesto } = await import('../../src/modules/rndc/envio.service.js');
    const r = await procesarManifiesto(10);
    expect(r.ok).toBe(false);
    expect(r.estadoFinal).toBe('error_envio');
    expect(r.codigo).toBe('PAYLOAD_DIVERGENCE');
    expect(ingresarManifiestoMock).not.toHaveBeenCalled();
  });

  it('sin credenciales activas → error transitorio', async () => {
    mockClaimTxOk();
    getActiveCredencialesMock.mockResolvedValueOnce(null);
    updateMock.mockReturnValueOnce(chain([])); // marcarErrorTransitorio

    const { procesarManifiesto } = await import('../../src/modules/rndc/envio.service.js');
    const r = await procesarManifiesto(10);
    expect(r.ok).toBe(false);
    expect(r.estadoFinal).toBe('error_envio'); // intentos=0, threshold 5
    expect(r.mensaje).toMatch(/credenciales/i);
    expect(ingresarManifiestoMock).not.toHaveBeenCalled();
  });
});

describe('envio.service — llamada SOAP', () => {
  beforeEach(() => {
    selectMock.mockReset();
    insertMock.mockReset();
    updateMock.mockReset();
    transactionMock.mockReset();
    ingresarManifiestoMock.mockReset();
    consultarEstadoIngresoMock.mockReset();
    getActiveCredencialesMock.mockReset();
    logOperacionMock.mockReset();
  });

  it('SOAP éxito → aceptado + persiste consecutivoRndc + log WORM', async () => {
    mockClaimTxOk();
    getActiveCredencialesMock.mockResolvedValueOnce(VALID_CREDS);
    selectMock.mockReturnValueOnce(chain([])); // no idempotency previa
    insertMock.mockReturnValueOnce(chain([])); // insert idempotency in-flight

    ingresarManifiestoMock.mockResolvedValueOnce({
      ok: true, codigo: '00', consecutivoRndc: 'CR-NEW-001',
      mensaje: 'OK', rawXml: '<resp/>', durationMs: 120,
    });

    mockSuccessTx();

    const { procesarManifiesto } = await import('../../src/modules/rndc/envio.service.js');
    const r = await procesarManifiesto(10, '10.0.0.1');
    expect(r.ok).toBe(true);
    expect(r.estadoFinal).toBe('aceptado');
    expect(r.consecutivoRndc).toBe('CR-NEW-001');
    expect(logOperacionMock).toHaveBeenCalledTimes(1);
    expect(logOperacionMock).toHaveBeenCalledWith(expect.objectContaining({
      tipoOp: 'ingresarManifiesto',
      resultado: 'ok',
      ipOrigen: '10.0.0.1',
    }));
  });

  it('SOAP business error (ER03 vehículo) → fallido_definitivo + notificación admin', async () => {
    mockClaimTxOk();
    getActiveCredencialesMock.mockResolvedValueOnce(VALID_CREDS);
    selectMock.mockReturnValueOnce(chain([]));
    insertMock.mockReturnValueOnce(chain([]));

    ingresarManifiestoMock.mockResolvedValueOnce({
      ok: false, codigo: 'ER03', mensaje: 'Vehículo no registrado',
      rawXml: '<resp/>', durationMs: 80,
    });

    updateMock.mockReturnValueOnce(chain([])); // update manifiesto fallido
    selectMock.mockReturnValueOnce(chain([{ email: 'admin@kyverum.com' }])); // admins
    insertMock.mockReturnValueOnce(chain([])); // notificationOutbox

    const { procesarManifiesto } = await import('../../src/modules/rndc/envio.service.js');
    const r = await procesarManifiesto(10);
    expect(r.ok).toBe(false);
    expect(r.estadoFinal).toBe('fallido_definitivo');
    expect(logOperacionMock).toHaveBeenCalledWith(expect.objectContaining({ resultado: 'error_negocio' }));
  });

  it('SOAP duplicate (ER07) → reconcilia consultando estado → aceptado', async () => {
    mockClaimTxOk();
    getActiveCredencialesMock.mockResolvedValueOnce(VALID_CREDS);
    selectMock.mockReturnValueOnce(chain([])); // no idempotency previa
    insertMock.mockReturnValueOnce(chain([])); // insert in-flight

    ingresarManifiestoMock.mockResolvedValueOnce({
      ok: false, codigo: 'ER07', mensaje: 'Duplicado',
      rawXml: '<resp/>', durationMs: 70,
    });

    consultarEstadoIngresoMock.mockResolvedValueOnce({
      ok: true, codigo: '00', consecutivoRndc: 'CR-RECONCILED',
      mensaje: 'OK', rawXml: '<estado/>', durationMs: 50,
    });

    mockSuccessTx();

    const { procesarManifiesto } = await import('../../src/modules/rndc/envio.service.js');
    const r = await procesarManifiesto(10);
    expect(r.ok).toBe(true);
    expect(r.estadoFinal).toBe('aceptado');
    expect(r.consecutivoRndc).toBe('CR-RECONCILED');
    expect(r.mensaje).toMatch(/reconciliado/i);
  });

  it('SOAP duplicate ER07 + consulta no recupera → error transitorio', async () => {
    mockClaimTxOk();
    getActiveCredencialesMock.mockResolvedValueOnce(VALID_CREDS);
    selectMock.mockReturnValueOnce(chain([]));
    insertMock.mockReturnValueOnce(chain([]));

    ingresarManifiestoMock.mockResolvedValueOnce({
      ok: false, codigo: 'ER07', mensaje: 'Duplicado',
      rawXml: '', durationMs: 60,
    });
    consultarEstadoIngresoMock.mockRejectedValueOnce(new Error('boom'));
    updateMock.mockReturnValueOnce(chain([])); // marcarErrorTransitorio

    const { procesarManifiesto } = await import('../../src/modules/rndc/envio.service.js');
    const r = await procesarManifiesto(10);
    expect(r.ok).toBe(false);
    expect(r.estadoFinal).toBe('error_envio');
    expect(r.mensaje).toMatch(/ER07/i);
  });

  it('SOAP transient error (ER99) en intento <5 → error_envio', async () => {
    mockClaimTxOk({ ...MANIFIESTO_BASE, intentosEnvio: 1 });
    getActiveCredencialesMock.mockResolvedValueOnce(VALID_CREDS);
    selectMock.mockReturnValueOnce(chain([]));
    insertMock.mockReturnValueOnce(chain([]));

    ingresarManifiestoMock.mockResolvedValueOnce({
      ok: false, codigo: 'ER99', mensaje: 'Error interno RNDC',
      rawXml: '', durationMs: 90,
    });

    updateMock.mockReturnValueOnce(chain([])); // marcarErrorTransitorio set fallido_*

    const { procesarManifiesto } = await import('../../src/modules/rndc/envio.service.js');
    const r = await procesarManifiesto(10);
    expect(r.ok).toBe(false);
    expect(r.estadoFinal).toBe('error_envio'); // intento=2 < 5
  });

  it('SOAP transient en intento >=5 → fallido_temporal', async () => {
    mockClaimTxOk({ ...MANIFIESTO_BASE, intentosEnvio: 5 });
    getActiveCredencialesMock.mockResolvedValueOnce(VALID_CREDS);
    selectMock.mockReturnValueOnce(chain([]));
    insertMock.mockReturnValueOnce(chain([]));

    ingresarManifiestoMock.mockResolvedValueOnce({
      ok: false, codigo: 'NETWORK', mensaje: 'connect ECONNREFUSED',
      rawXml: '', durationMs: 5000,
    });

    updateMock.mockReturnValueOnce(chain([]));

    const { procesarManifiesto } = await import('../../src/modules/rndc/envio.service.js');
    const r = await procesarManifiesto(10);
    expect(r.estadoFinal).toBe('fallido_temporal'); // intento=6 >=5
  });

  it('SOAP transient en intento >=10 → fallido_definitivo + notificación', async () => {
    mockClaimTxOk({ ...MANIFIESTO_BASE, intentosEnvio: 9 });
    getActiveCredencialesMock.mockResolvedValueOnce(VALID_CREDS);
    selectMock.mockReturnValueOnce(chain([]));
    insertMock.mockReturnValueOnce(chain([]));

    ingresarManifiestoMock.mockResolvedValueOnce({
      ok: false, codigo: 'TIMEOUT', mensaje: 'TIMEOUT',
      rawXml: '', durationMs: 90000,
    });

    updateMock.mockReturnValueOnce(chain([])); // fallido_definitivo
    selectMock.mockReturnValueOnce(chain([{ email: 'admin@kyverum.com' }])); // admins
    insertMock.mockReturnValueOnce(chain([])); // notificationOutbox

    const { procesarManifiesto } = await import('../../src/modules/rndc/envio.service.js');
    const r = await procesarManifiesto(10);
    expect(r.estadoFinal).toBe('fallido_definitivo'); // intento=10 = MAX_INTENTOS
    expect(r.mensaje).toMatch(/TIMEOUT/i);
    // Notificación encolada (insertMock se llamó al menos 2 veces: idempotency + notificationOutbox)
    expect(insertMock).toHaveBeenCalledTimes(2);
  });

  it('callWithTimeout: client lanza error → response codigo NETWORK', async () => {
    mockClaimTxOk({ ...MANIFIESTO_BASE, intentosEnvio: 1 });
    getActiveCredencialesMock.mockResolvedValueOnce(VALID_CREDS);
    selectMock.mockReturnValueOnce(chain([]));
    insertMock.mockReturnValueOnce(chain([]));

    ingresarManifiestoMock.mockRejectedValueOnce(new Error('socket hangup'));
    updateMock.mockReturnValueOnce(chain([]));

    const { procesarManifiesto } = await import('../../src/modules/rndc/envio.service.js');
    const r = await procesarManifiesto(10);
    expect(r.ok).toBe(false);
    expect(r.estadoFinal).toBe('error_envio');
    expect(logOperacionMock).toHaveBeenCalledWith(expect.objectContaining({
      codigoResultado: 'NETWORK',
      resultado: 'error_tecnico',
    }));
  });
});
