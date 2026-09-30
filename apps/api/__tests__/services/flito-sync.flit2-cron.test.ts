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
// HU #13188: el programa NO se mockea; se lee real.
const { leerPrograma, reiniciarProgramaParaTest } = await import('../../src/modules/flito-sync/flit2-programa.js');
const { componerEstado } = await import('../../src/modules/flito-sync/flit2-estado.service.js');

const RESULTADO = {
  leidos: 2, nuevos: 2, actualizados: 0, sinCambios: 0, conflictos: 0, sinVehiculo: 0, eliminadosIgnorados: 0,
  invalidos: 0, companiasFaltantes: 0, organismosSinEmparejar: 0, paginas: 1, hasMore: false,
  modo: 'cursor' as const, ejecutadoEn: '2026-09-29T15:00:00.000Z',
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'Date'], now: new Date('2026-09-29T15:00:00Z') });
  entorno.cron = true;
  reiniciarProgramaParaTest();
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

describe('HU #13188 · pulso de la lectura automática', () => {
  const iso = (d: Date | null) => (d ? d.toISOString() : null);

  it('AC1: con el cron encendido, activa, cada 300000 ms, próxima a los 5 min del arranque y sin lectura en curso', () => {
    startFlitSync();
    const p = leerPrograma();
    expect(p).toEqual({ activa: true, intervaloMs: 300_000, proximaEn: new Date('2026-09-29T15:05:00Z'), enCurso: false });

    const estado = componerEstado({
      ambienteListo: true, acceso: null, lectura: null, tramitesEnmascarados: 0, programa: p,
    }, new Date());
    const a = estado.automatica;
    expect(a.generadoEn).toBe('2026-09-29T15:00:00.000Z');
    const delta = Date.parse(a.proximaEn!) - Date.parse(a.generadoEn);
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThanOrEqual(300_000);
  });

  it('AC1: arrancar dos veces no reinicia la próxima corrida', async () => {
    startFlitSync();
    await vi.advanceTimersByTimeAsync(60_000);
    startFlitSync();
    expect(iso(leerPrograma().proximaEn)).toBe('2026-09-29T15:05:00.000Z');
  });

  it('AC2: cada tick que lee adelanta la próxima un intervalo desde ese tick', async () => {
    startFlitSync();
    await vi.advanceTimersByTimeAsync(INTERVALO_FLIT2_MS);
    expect(leerConCandadoMock).toHaveBeenCalledTimes(1);
    expect(iso(leerPrograma().proximaEn)).toBe('2026-09-29T15:10:00.000Z');
  });

  it('AC2: el tick que se salta porque la anterior sigue en curso también adelanta la próxima', async () => {
    let soltar!: () => void;
    leerConCandadoMock.mockImplementationOnce(() => new Promise((ok) => { soltar = () => ok(RESULTADO); }));
    startFlitSync();
    await vi.advanceTimersByTimeAsync(INTERVALO_FLIT2_MS);
    await vi.advanceTimersByTimeAsync(INTERVALO_FLIT2_MS);
    expect(leerConCandadoMock).toHaveBeenCalledTimes(1);
    expect(iso(leerPrograma().proximaEn)).toBe('2026-09-29T15:15:00.000Z');
    soltar();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('AC2: el tick que se salta porque el candado está tomado también adelanta la próxima', async () => {
    leerConCandadoMock.mockRejectedValue(new Flit2LecturaEnCursoError());
    startFlitSync();
    await vi.advanceTimersByTimeAsync(INTERVALO_FLIT2_MS);
    expect(leerConCandadoMock).toHaveBeenCalledTimes(1);
    expect(iso(leerPrograma().proximaEn)).toBe('2026-09-29T15:10:00.000Z');
  });

  it('AC3: con FLIT2_SYNC_CRON=false, inactiva y sin intervalo ni próxima', () => {
    entorno.cron = false;
    startFlitSync();
    expect(leerPrograma()).toEqual({ activa: false, intervaloMs: null, proximaEn: null, enCurso: false });
  });

  it('AC3: con FLIT2_SYNC_CRON=false tras haber estado encendida, arrancar la deja apagada', () => {
    startFlitSync();
    stopFlitSync();
    entorno.cron = false;
    startFlitSync();
    expect(leerPrograma().activa).toBe(false);
  });

  it('AC3: stopFlitSync apaga el programa encendido', () => {
    startFlitSync();
    stopFlitSync();
    expect(leerPrograma()).toEqual({ activa: false, intervaloMs: null, proximaEn: null, enCurso: false });
  });
});
