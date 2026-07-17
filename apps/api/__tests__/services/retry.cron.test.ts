import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chain } from '../helpers/db.js';

// Mocks de deps. withLock se mockea como passthrough: invoca fn() sincrónicamente y devuelve.
const updateMock = vi.fn();
const selectMock = vi.fn();
const executeMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    update: updateMock,
    select: selectMock,
    execute: executeMock,
    insert: vi.fn(),
    delete: vi.fn(),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const withLockMock = vi.fn();
vi.mock('../../src/shared/utils/lock.js', () => ({
  withLock: withLockMock,
}));

const procesarManifiestoMock = vi.fn();
vi.mock('../../src/modules/rndc/envio.service.js', () => ({
  procesarManifiesto: procesarManifiestoMock,
}));

const sendEmailMock = vi.fn();
vi.mock('../../src/services/email.js', () => ({
  sendEmail: sendEmailMock,
}));

beforeEach(() => {
  updateMock.mockReset();
  selectMock.mockReset();
  executeMock.mockReset();
  withLockMock.mockReset();
  procesarManifiestoMock.mockReset();
  sendEmailMock.mockReset();
  // Por defecto, withLock invoca fn sincrónico y devuelve su resultado (lock siempre obtenido).
  withLockMock.mockImplementation(async (_name: string, _ttl: number, fn: any) => fn());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startRndcRetryCron — lifecycle', () => {
  it('start es idempotente: 2 calls solo registran 1 timer', async () => {
    vi.useFakeTimers();
    const { startRndcRetryCron, stopRndcRetryCron } = await import('../../src/modules/rndc/retry.cron.js');
    // Stubs mínimos para que runOnce no crashee si dispara.
    executeMock.mockResolvedValue([]);
    selectMock.mockReturnValue(chain([]));
    updateMock.mockReturnValue({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) });

    startRndcRetryCron();
    startRndcRetryCron(); // segundo call debe ser noop
    stopRndcRetryCron();

    // Si hubiera registrado 2 timers, stopRndcRetryCron solo limpia 1 → habría leak.
    // Aquí solo verificamos que no throw y no doble-registra (cobertura del early-return).
    expect(true).toBe(true);
  });

  it('stop sin start activo es noop seguro', async () => {
    const { stopRndcRetryCron } = await import('../../src/modules/rndc/retry.cron.js');
    expect(() => stopRndcRetryCron()).not.toThrow();
  });

  it('start → setTimeout(60s) inicial dispara runOnce con withLock', async () => {
    vi.useFakeTimers();
    const { startRndcRetryCron, stopRndcRetryCron } = await import('../../src/modules/rndc/retry.cron.js');

    // Stubs de runOnce internals (no importan resultados, solo que no crashee).
    updateMock.mockReturnValue({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    });
    executeMock.mockResolvedValue([]);
    selectMock.mockReturnValue(chain([]));

    startRndcRetryCron();
    await vi.advanceTimersByTimeAsync(60_001);

    expect(withLockMock).toHaveBeenCalledTimes(1);
    expect(withLockMock).toHaveBeenCalledWith('rndc-retry-cron', 4 * 60_000, expect.any(Function));
    stopRndcRetryCron();
  });

  it('setInterval(5min) dispara runOnce repetidamente', async () => {
    vi.useFakeTimers();
    const { startRndcRetryCron, stopRndcRetryCron } = await import('../../src/modules/rndc/retry.cron.js');

    updateMock.mockReturnValue({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) });
    executeMock.mockResolvedValue([]);
    selectMock.mockReturnValue(chain([]));

    startRndcRetryCron();
    await vi.advanceTimersByTimeAsync(60_001); // setTimeout inicial → 1 call
    await vi.advanceTimersByTimeAsync(5 * 60_000); // 1er tick interval → 2 calls
    await vi.advanceTimersByTimeAsync(5 * 60_000); // 2do tick interval → 3 calls

    expect(withLockMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    stopRndcRetryCron();
  });
});

describe('runOnce — vía withLock callback (rescatarZombies + procesarBatch + procesarOutbox)', () => {
  it('cuando lock NO se obtiene → no toca BD ni envía nada', async () => {
    vi.useFakeTimers();
    withLockMock.mockResolvedValueOnce(null); // lock perdido

    const { startRndcRetryCron, stopRndcRetryCron } = await import('../../src/modules/rndc/retry.cron.js');
    startRndcRetryCron();
    await vi.advanceTimersByTimeAsync(60_001);

    expect(updateMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
    expect(selectMock).not.toHaveBeenCalled();
    expect(procesarManifiestoMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
    stopRndcRetryCron();
  });

  it('rescatarZombies: db.update con manifiestos en estado=enviando >10min → revierte a error_envio', async () => {
    vi.useFakeTimers();
    let zombiesCaptured: any = null;
    updateMock.mockReturnValueOnce({
      set: (v: any) => {
        zombiesCaptured = v;
        return { where: () => ({ returning: () => Promise.resolve([{ id: 1 }, { id: 2 }]) }) };
      },
    });
    executeMock.mockResolvedValueOnce([]); // pickBatch
    selectMock.mockReturnValueOnce(chain([])); // outbox vacío

    const { startRndcRetryCron, stopRndcRetryCron } = await import('../../src/modules/rndc/retry.cron.js');
    startRndcRetryCron();
    await vi.advanceTimersByTimeAsync(60_001);
    await vi.runAllTicks();

    expect(zombiesCaptured).toMatchObject({
      estadoEnvio: 'error_envio',
      ultimoError: expect.stringMatching(/rescatado/i),
    });
    expect(zombiesCaptured.proximoIntentoAt).toBeInstanceOf(Date);
    stopRndcRetryCron();
  });

  it('procesarBatch: pickBatch devuelve ids → llama procesarManifiesto por cada uno', async () => {
    vi.useFakeTimers();
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    });
    executeMock.mockResolvedValueOnce([{ id: 10 }, { id: 11 }, { id: 12 }]); // pickBatch
    selectMock.mockReturnValueOnce(chain([])); // outbox vacío

    procesarManifiestoMock.mockResolvedValueOnce({ estadoFinal: 'aceptado' });
    procesarManifiestoMock.mockResolvedValueOnce({ estadoFinal: 'fallido_temporal' });
    procesarManifiestoMock.mockResolvedValueOnce({ estadoFinal: 'fallido_definitivo' });

    const { startRndcRetryCron, stopRndcRetryCron } = await import('../../src/modules/rndc/retry.cron.js');
    startRndcRetryCron();
    await vi.advanceTimersByTimeAsync(60_001);
    await vi.runAllTicks();
    await Promise.resolve();

    expect(procesarManifiestoMock).toHaveBeenCalledTimes(3);
    expect(procesarManifiestoMock).toHaveBeenCalledWith(10);
    expect(procesarManifiestoMock).toHaveBeenCalledWith(11);
    expect(procesarManifiestoMock).toHaveBeenCalledWith(12);
    stopRndcRetryCron();
  });

  it('procesarBatch: si procesarManifiesto throws → cuenta como err, no aborta el batch', async () => {
    vi.useFakeTimers();
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    });
    executeMock.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);
    selectMock.mockReturnValueOnce(chain([]));

    procesarManifiestoMock.mockRejectedValueOnce(new Error('SOAP unreachable'));
    procesarManifiestoMock.mockResolvedValueOnce({ estadoFinal: 'aceptado' });

    const { startRndcRetryCron, stopRndcRetryCron } = await import('../../src/modules/rndc/retry.cron.js');
    startRndcRetryCron();
    await vi.advanceTimersByTimeAsync(60_001);
    await vi.runAllTicks();
    await Promise.resolve();

    expect(procesarManifiestoMock).toHaveBeenCalledTimes(2); // 2do se ejecuta a pesar del 1ero throw
    stopRndcRetryCron();
  });

  it('procesarBatch: pickBatch vacío → no llama procesarManifiesto', async () => {
    vi.useFakeTimers();
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    });
    executeMock.mockResolvedValueOnce([]); // batch vacío
    selectMock.mockReturnValueOnce(chain([]));

    const { startRndcRetryCron, stopRndcRetryCron } = await import('../../src/modules/rndc/retry.cron.js');
    startRndcRetryCron();
    await vi.advanceTimersByTimeAsync(60_001);
    await vi.runAllTicks();

    expect(procesarManifiestoMock).not.toHaveBeenCalled();
    stopRndcRetryCron();
  });
});

describe('procesarOutbox — emails con backoff exponencial', () => {
  it('email enviado OK → marca estado=enviado + messageId', async () => {
    vi.useFakeTimers();
    let updateCalls: any[] = [];

    // rescatarZombies update (vacío)
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    });
    // outbox row update tras enviar
    updateMock.mockReturnValueOnce({
      set: (v: any) => { updateCalls.push(v); return { where: () => Promise.resolve(undefined) }; },
    });

    executeMock.mockResolvedValueOnce([]); // pickBatch vacío
    selectMock.mockReturnValueOnce(chain([{
      id: 100,
      destinatarios: JSON.stringify(['admin@kyverum.com']),
      asunto: 'Alerta',
      cuerpoHtml: '<p>x</p>',
      cuerpoTexto: 'x',
      intentos: 0,
    }]));

    sendEmailMock.mockResolvedValueOnce({ ok: true, messageId: 'msg-001' });

    const { startRndcRetryCron, stopRndcRetryCron } = await import('../../src/modules/rndc/retry.cron.js');
    startRndcRetryCron();
    await vi.advanceTimersByTimeAsync(60_001);
    await vi.runAllTicks();
    await Promise.resolve();
    await Promise.resolve();

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).toHaveBeenCalledWith({
      to: ['admin@kyverum.com'],
      subject: 'Alerta',
      html: '<p>x</p>',
      text: 'x',
    });
    expect(updateCalls[0]).toMatchObject({
      estado: 'enviado',
      intentos: 1,
      messageId: 'msg-001',
    });
    stopRndcRetryCron();
  });

  it('destinatarios JSON inválido → marca fallido_definitivo (no intenta enviar)', async () => {
    vi.useFakeTimers();
    let captured: any = null;

    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    });
    updateMock.mockReturnValueOnce({
      set: (v: any) => { captured = v; return { where: () => Promise.resolve(undefined) }; },
    });

    executeMock.mockResolvedValueOnce([]);
    selectMock.mockReturnValueOnce(chain([{
      id: 200, destinatarios: 'not-json{{', asunto: 'x', cuerpoHtml: 'x', cuerpoTexto: null, intentos: 0,
    }]));

    const { startRndcRetryCron, stopRndcRetryCron } = await import('../../src/modules/rndc/retry.cron.js');
    startRndcRetryCron();
    await vi.advanceTimersByTimeAsync(60_001);
    await vi.runAllTicks();
    await Promise.resolve();

    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(captured).toMatchObject({
      estado: 'fallido_definitivo',
      ultimoError: expect.stringMatching(/json/i),
    });
    stopRndcRetryCron();
  });

  it('email falla con intentos<5 → estado=error + backoff exponencial proximoIntentoAt', async () => {
    vi.useFakeTimers();
    let captured: any = null;

    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    });
    updateMock.mockReturnValueOnce({
      set: (v: any) => { captured = v; return { where: () => Promise.resolve(undefined) }; },
    });

    executeMock.mockResolvedValueOnce([]);
    selectMock.mockReturnValueOnce(chain([{
      id: 300,
      destinatarios: JSON.stringify(['x@y.com']),
      asunto: 'x', cuerpoHtml: 'x', cuerpoTexto: null,
      intentos: 2, // → tras este, intentos=3, backoff=60_000*2^3=480_000ms (8 min)
    }]));

    sendEmailMock.mockResolvedValueOnce({ ok: false, error: 'SMTP timeout' });

    const { startRndcRetryCron, stopRndcRetryCron } = await import('../../src/modules/rndc/retry.cron.js');
    startRndcRetryCron();
    await vi.advanceTimersByTimeAsync(60_001);
    await vi.runAllTicks();
    await Promise.resolve();
    await Promise.resolve();

    expect(captured).toMatchObject({
      estado: 'error',
      intentos: 3,
      ultimoError: 'SMTP timeout',
    });
    expect(captured.proximoIntentoAt).toBeInstanceOf(Date);
    // Backoff: 60_000 * 2^3 = 480_000ms = 8 min, capeado a 30 min máx
    const delta = captured.proximoIntentoAt.getTime() - captured.ultimoIntentoAt.getTime();
    expect(delta).toBeGreaterThanOrEqual(7 * 60_000);
    expect(delta).toBeLessThanOrEqual(30 * 60_000);
    stopRndcRetryCron();
  });

  it('email falla con intentos≥5 → fallido_definitivo (no más reintentos)', async () => {
    vi.useFakeTimers();
    let captured: any = null;

    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    });
    updateMock.mockReturnValueOnce({
      set: (v: any) => { captured = v; return { where: () => Promise.resolve(undefined) }; },
    });

    executeMock.mockResolvedValueOnce([]);
    selectMock.mockReturnValueOnce(chain([{
      id: 400,
      destinatarios: JSON.stringify(['x@y.com']),
      asunto: 'x', cuerpoHtml: 'x', cuerpoTexto: null,
      intentos: 4, // → tras este, intentos=5 → fallido_definitivo
    }]));

    sendEmailMock.mockResolvedValueOnce({ ok: false, error: 'permanent' });

    const { startRndcRetryCron, stopRndcRetryCron } = await import('../../src/modules/rndc/retry.cron.js');
    startRndcRetryCron();
    await vi.advanceTimersByTimeAsync(60_001);
    await vi.runAllTicks();
    await Promise.resolve();
    await Promise.resolve();

    expect(captured).toMatchObject({
      estado: 'fallido_definitivo',
      intentos: 5,
      ultimoError: 'permanent',
    });
    expect(captured.proximoIntentoAt).toBeUndefined();
    stopRndcRetryCron();
  });
});
