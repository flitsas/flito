// HU #13092 (Feature #13059) — lectura programada de FLIT 2 (AC1, AC2 en el proceso, AC8 del cron).
// Timers falsos: ninguna espera real de 5 min.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const entorno = vi.hoisted(() => ({ cron: true }));
vi.mock('../../src/config/env.js', async (orig) => {
  const real = (await orig()) as { env: Record<string, unknown> };
  return { env: new Proxy(real.env, { get: (t, k) => (k === 'FLIT2_SYNC_CRON' ? entorno.cron : t[k as string]) }) };
});
const leerConCandadoMock = vi.fn();
const auditarMock = vi.fn(async () => undefined);
vi.mock('../../src/modules/flito-sync/flit2-lectura.service.js', () => ({
  leerConCandado: leerConCandadoMock, auditarLecturaProgramada: auditarMock,
}));
const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../src/shared/logger.js', () => ({ logger: logMock, loggerFor: () => logMock }));

const { startFlitSync, stopFlitSync, correrLecturaFlit2Programada, INTERVALO_FLIT2_MS } =
  await import('../../src/modules/flito-sync/flito-sync.cron.js');
const { Flit2SinAccesoError, Flit2LecturaEnCursoError, Flit2RespuestaError } =
  await import('../../src/modules/flito-sync/flit2.errors.js');

const RESULTADO = {
  leidos: 2, nuevos: 2, actualizados: 0, sinCambios: 0, conflictos: 0, sinVehiculo: 0, eliminadosIgnorados: 0,
  invalidos: 0, companiasFaltantes: 0, organismosSinEmparejar: 0, paginas: 1, hasMore: false,
  modo: 'cursor' as const, ejecutadoEn: '2026-09-29T15:00:00.000Z',
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'Date'], now: new Date('2026-09-29T15:00:00Z') });
  entorno.cron = true;
  leerConCandadoMock.mockReset().mockResolvedValue(RESULTADO);
  auditarMock.mockClear();
  for (const m of Object.values(logMock)) m.mockClear();
});
afterEach(() => {
  stopFlitSync();
  vi.useRealTimers();
});

describe('HU #13092 AC1 · cada 5 min con FLIT2_SYNC_CRON encendida', () => {
  it('no corre en el tick del arranque; corre a los 5 min y luego cada 5 min, como «cron»', async () => {
    expect(INTERVALO_FLIT2_MS).toBe(5 * 60_000);
    startFlitSync();
    await vi.advanceTimersByTimeAsync(0);
    expect(leerConCandadoMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(INTERVALO_FLIT2_MS - 1);
    expect(leerConCandadoMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(leerConCandadoMock).toHaveBeenCalledTimes(1);
    expect(leerConCandadoMock).toHaveBeenCalledWith('cron');
    await vi.advanceTimersByTimeAsync(INTERVALO_FLIT2_MS);
    expect(leerConCandadoMock).toHaveBeenCalledTimes(2);
  });

  it('con FLIT2_SYNC_CRON=false no corre nunca', async () => {
    entorno.cron = false;
    startFlitSync();
    await vi.advanceTimersByTimeAsync(INTERVALO_FLIT2_MS * 3);
    expect(leerConCandadoMock).not.toHaveBeenCalled();
  });

  it('arrancar dos veces no duplica el timer; stop lo detiene', async () => {
    startFlitSync();
    startFlitSync();
    await vi.advanceTimersByTimeAsync(INTERVALO_FLIT2_MS);
    expect(leerConCandadoMock).toHaveBeenCalledTimes(1);
    stopFlitSync();
    await vi.advanceTimersByTimeAsync(INTERVALO_FLIT2_MS * 2);
    expect(leerConCandadoMock).toHaveBeenCalledTimes(1);
  });

  it('sin acceso vigente la corrida no llega a leer y no se audita ni se registra como fallo', async () => {
    leerConCandadoMock.mockRejectedValue(new Flit2SinAccesoError());
    await correrLecturaFlit2Programada();
    expect(auditarMock).not.toHaveBeenCalled();
    expect(logMock.warn).not.toHaveBeenCalled();
    expect(logMock.error).not.toHaveBeenCalled();
  });
});

describe('HU #13092 · desenlaces de la corrida programada', () => {
  it('AC8: una corrida que termina bien pasa su resultado a la auditoría del sistema', async () => {
    await correrLecturaFlit2Programada();
    expect(auditarMock).toHaveBeenCalledWith(RESULTADO);
  });

  it('AC2: un tick que llega con la corrida anterior en curso se salta (no reserva otra conexión)', async () => {
    let soltar!: () => void;
    leerConCandadoMock.mockImplementationOnce(() => new Promise((ok) => { soltar = () => ok(RESULTADO); }));
    const primera = correrLecturaFlit2Programada();
    await correrLecturaFlit2Programada();
    expect(leerConCandadoMock).toHaveBeenCalledTimes(1);
    soltar();
    await primera;
    await correrLecturaFlit2Programada();
    expect(leerConCandadoMock).toHaveBeenCalledTimes(2);
  });

  it('AC2: con el candado en otro proceso, el tick se salta sin auditar', async () => {
    leerConCandadoMock.mockRejectedValue(new Flit2LecturaEnCursoError());
    await correrLecturaFlit2Programada();
    expect(auditarMock).not.toHaveBeenCalled();
    expect(logMock.warn).not.toHaveBeenCalled();
  });

  it('un error de FLIT 2 o de la base (p. ej. migración sin aplicar) no escapa del tick: se registra sin detalle', async () => {
    leerConCandadoMock.mockRejectedValueOnce(new Flit2RespuestaError(400, 'invalid_cursor'));
    await expect(correrLecturaFlit2Programada()).resolves.toBeUndefined();
    expect(logMock.warn).toHaveBeenCalledWith({ codigo: 'flit2_respuesta' }, expect.any(String));

    leerConCandadoMock.mockRejectedValueOnce(new Error('relation "flito_sync_flit2_lectura" does not exist'));
    await expect(correrLecturaFlit2Programada()).resolves.toBeUndefined();
    expect(logMock.error).toHaveBeenCalledWith({ err: 'Error' }, expect.any(String));
    expect(auditarMock).not.toHaveBeenCalled();
  });
});
