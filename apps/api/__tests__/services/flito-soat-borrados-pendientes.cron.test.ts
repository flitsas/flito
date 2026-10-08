// HU #13410 — programación del reintento horario de los borrados pendientes:
// `flito-soat-borrados-pendientes.cron.ts`. AC8 (puerta positiva + candado + una corrida a la vez).
// Matriz qa-a-13410, archivo F3. Patrón de `flito-soat-retencion.cron.test.ts`.

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

const TZ_ORIGINAL = process.env.TZ;
process.env.TZ = 'UTC';
afterAll(() => {
  if (TZ_ORIGINAL === undefined) delete process.env.TZ;
  else process.env.TZ = TZ_ORIGINAL;
});

const m = vi.hoisted(() => ({
  env: { SOAT_BORRADOS_PENDIENTES_CRON_ENABLED: false as boolean },
  orden: [] as string[],
  lineas: [] as unknown[][],
  lockLibre: true,
}));

const corridaMock = vi.hoisted(() => vi.fn());
const withLockMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/config/env.js', () => ({ env: m.env }));
vi.mock('../../src/shared/utils/lock.js', () => ({ withLock: withLockMock }));
vi.mock('../../src/modules/flito-soat/flito-soat-borrados-pendientes.service.js', () => ({
  LOTE_BORRADOS: 100, ejecutarBorradosPendientes: corridaMock,
}));
vi.mock('../../src/shared/logger.js', () => {
  const l = {
    info: (...a: unknown[]) => { m.lineas.push(a); },
    warn: (...a: unknown[]) => { m.lineas.push(a); },
    error: (...a: unknown[]) => { m.lineas.push(a); },
    debug: () => {},
    child: () => l,
  };
  return { loggerFor: () => l, logger: l };
});

const cron = await import('../../src/modules/flito-soat/flito-soat-borrados-pendientes.cron.js');

const RESUMEN = { leidos: 2, borrados: 1, inexistentes: 1, referenciados: 0, fallidos: 0, alertados: 0, abiertos: 0 };
const texto = () => JSON.stringify(m.lineas);

beforeEach(() => {
  cron.stopSoatBorradosPendientesCron();
  cron.reiniciarEstadoBorrados();
  m.env.SOAT_BORRADOS_PENDIENTES_CRON_ENABLED = false;
  m.orden = []; m.lineas = []; m.lockLibre = true;
  corridaMock.mockReset().mockImplementation(async () => { m.orden.push('corrida'); return RESUMEN; });
  withLockMock.mockReset().mockImplementation(async (_n: string, _t: number, fn: () => Promise<unknown>) => {
    m.orden.push('lock');
    return m.lockLibre ? fn() : null;
  });
});
afterEach(() => { cron.stopSoatBorradosPendientesCron(); vi.useRealTimers(); });

describe('AC8 — puerta positiva SOAT_BORRADOS_PENDIENTES_CRON_ENABLED', () => {
  it('TC-8.1 sin la puerta: no arranca, lo dice nombrando la variable, y ninguna hora corre', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    cron.startSoatBorradosPendientesCron();
    await vi.advanceTimersByTimeAsync(cron.INTERVALO_BORRADOS_MS * 3);
    expect(texto()).toContain('SOAT_BORRADOS_PENDIENTES_CRON_ENABLED');
    expect(texto()).toContain('DESHABILITADO');
    expect(withLockMock).not.toHaveBeenCalled();
    expect(corridaMock).not.toHaveBeenCalled();
  });

  it('TC-8.2 con la puerta: corre cada hora, dentro del candado propio, con TTL menor que el intervalo', async () => {
    m.env.SOAT_BORRADOS_PENDIENTES_CRON_ENABLED = true;
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    cron.startSoatBorradosPendientesCron();
    expect(texto()).toContain('ACTIVO');
    await vi.advanceTimersByTimeAsync(cron.INTERVALO_BORRADOS_MS - 1);
    expect(corridaMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(corridaMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(cron.INTERVALO_BORRADOS_MS);
    expect(corridaMock).toHaveBeenCalledTimes(2);
    expect(cron.INTERVALO_BORRADOS_MS).toBe(60 * 60_000);
    const [nombre, ttl] = withLockMock.mock.calls[0];
    expect(nombre).toBe('flito-storage-borrados-pendientes');
    expect(nombre).not.toBe('flito-soat-retencion');
    expect(ttl).toBeLessThan(cron.INTERVALO_BORRADOS_MS);
    expect(m.orden.slice(0, 2)).toEqual(['lock', 'corrida']);
  });

  it('start dos veces no duplica el timer; stop lo detiene', async () => {
    m.env.SOAT_BORRADOS_PENDIENTES_CRON_ENABLED = true;
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    cron.startSoatBorradosPendientesCron();
    cron.startSoatBorradosPendientesCron();
    await vi.advanceTimersByTimeAsync(cron.INTERVALO_BORRADOS_MS);
    expect(corridaMock).toHaveBeenCalledTimes(1);
    cron.stopSoatBorradosPendientesCron();
    await vi.advanceTimersByTimeAsync(cron.INTERVALO_BORRADOS_MS * 2);
    expect(corridaMock).toHaveBeenCalledTimes(1);
  });
});

describe('AC8 — candado y una corrida a la vez', () => {
  it('TC-8.3 otra instancia tiene el candado → no corre, lo registra', async () => {
    m.lockLibre = false;
    expect(await cron.latidoBorradosPendientes()).toBe('otra_instancia');
    expect(corridaMock).not.toHaveBeenCalled();
    expect(texto()).toContain('otra instancia');
  });

  it('un latido con otro en vuelo no entra', async () => {
    let soltar!: () => void;
    corridaMock.mockImplementationOnce(() => new Promise((r) => { soltar = () => r(RESUMEN); }));
    const primero = cron.latidoBorradosPendientes();
    await vi.waitFor(() => expect(corridaMock).toHaveBeenCalledTimes(1));
    expect(await cron.latidoBorradosPendientes()).toBe('en_vuelo');
    soltar();
    expect(await primero).toBe('corrida');
    expect(corridaMock).toHaveBeenCalledTimes(1);
  });

  it('la corrida que falla devuelve `fallo`, loguea solo el nombre del error y libera el vuelo', async () => {
    corridaMock.mockRejectedValueOnce(new TypeError('clientes/900123456/k.pdf explotó'));
    expect(await cron.latidoBorradosPendientes()).toBe('fallo');
    expect(texto()).toContain('TypeError');
    expect(texto()).not.toContain('900123456');
    expect(await cron.latidoBorradosPendientes()).toBe('corrida');
  });

  it('el log de la corrida lleva solo conteos (warn si quedaron fallidos)', async () => {
    corridaMock.mockResolvedValueOnce({ ...RESUMEN, fallidos: 1 });
    expect(await cron.latidoBorradosPendientes()).toBe('corrida');
    const ultima = m.lineas.at(-1)!;
    expect(ultima[0]).toMatchObject({ leidos: 2, fallidos: 1 });
    expect(String(ultima[1])).toContain('se reintentan');
  });
});
