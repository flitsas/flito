// HU #13804 (AC7, D6) — programación de la purga a 12 meses de los intentos (RN-DRF1..4) y variables
// de entorno de HU-2. El DELETE real contra PostgreSQL vive en `__tests__/db/migracion-0246.test.ts`.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const purgaMock = vi.fn();
const lockMock = vi.fn();
vi.mock('../../../src/db/client.js', () => ({ db: {}, getPoolStats: vi.fn() }));
vi.mock('../../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn() }));
vi.mock('../../../src/shared/utils/lock.js', () => ({ withLock: (...a: unknown[]) => lockMock(...a) }));
vi.mock('../../../src/modules/flito-dr-flit/dr-flit-purga.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/modules/flito-dr-flit/dr-flit-purga.service.js')>()),
  ejecutarPurgaDrFlit: (...a: unknown[]) => purgaMock(...a),
}));

const cron = await import('../../../src/modules/flito-dr-flit/dr-flit.cron.js');
const { cortePurgaDrFlit } = await import('../../../src/modules/flito-dr-flit/dr-flit-purga.service.js');

// 03:15 en Bogotá = 08:15 UTC.
const EN_VENTANA = new Date('2026-10-22T08:15:00Z');
const FUERA = new Date('2026-10-22T09:15:00Z');

beforeEach(() => {
  cron.reiniciarEstadoPurgaDrFlit();
  purgaMock.mockReset().mockResolvedValue({ borrados: 3, lotes: 1, corte: '2025-10-22T08:15:00.000Z' });
  lockMock.mockReset().mockImplementation(async (_n: string, _t: number, fn: () => Promise<unknown>) => fn());
});

describe('RN-DRF1 — corte de 12 meses', () => {
  it('ahora − 12 meses de calendario', () => {
    expect(cortePurgaDrFlit(new Date('2026-10-22T08:15:00Z')).toISOString()).toBe('2025-10-22T08:15:00.000Z');
  });
});

describe('RN-DRF2/4 — latido', () => {
  it('fuera de las 03:00 de Bogotá no hace nada', async () => {
    expect(await cron.latidoPurgaDrFlit(FUERA)).toBe('fuera_de_ventana');
    expect(lockMock).not.toHaveBeenCalled();
  });

  it('en ventana: corre con candado una vez al día y pasa `ahora` a la purga', async () => {
    expect(await cron.latidoPurgaDrFlit(EN_VENTANA)).toBe('corrida');
    expect(lockMock.mock.calls[0]![0]).toBe(cron.NOMBRE_LOCK_PURGA_DRFLIT);
    expect(purgaMock).toHaveBeenCalledWith({ ahora: EN_VENTANA });
    expect(await cron.latidoPurgaDrFlit(new Date('2026-10-22T08:25:00Z'))).toBe('ya_corrio_hoy');
    expect(purgaMock).toHaveBeenCalledTimes(1);
  });

  it('otra instancia tiene el candado → no purga', async () => {
    lockMock.mockResolvedValue(null);
    expect(await cron.latidoPurgaDrFlit(EN_VENTANA)).toBe('otra_instancia');
    expect(purgaMock).not.toHaveBeenCalled();
  });

  it('fallo → no marca el día: el latido siguiente lo reintenta', async () => {
    purgaMock.mockRejectedValueOnce(new Error('db caída'));
    expect(await cron.latidoPurgaDrFlit(EN_VENTANA)).toBe('fallo');
    expect(await cron.latidoPurgaDrFlit(EN_VENTANA)).toBe('corrida');
  });
});

describe('RN-DRF3 — puerta positiva', () => {
  it('sin DRFLIT_PURGA_CRON_ENABLED=1 no programa nada', () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    cron.startDrflitPurgaCron();
    expect(spy).not.toHaveBeenCalled();
    cron.stopDrflitPurgaCron();
    spy.mockRestore();
  });
});

describe('env.ts — variables de HU-2', () => {
  async function cargarEnv(vars: Record<string, string>) {
    vi.resetModules();
    for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);
    return import('../../../src/config/env.js');
  }
  afterEach(() => { vi.unstubAllEnvs(); });

  it('defaults del mapeo verificado (Bug #13713) y del limitador', async () => {
    const { env } = await cargarEnv({});
    expect(env).toMatchObject({
      DRFLIT_ADO_TIMEOUT_MS: 15_000, DRFLIT_ADO_PENDIENTE_VENCE_S: 120, DRFLIT_ADO_TIPO: 'Bug',
      DRFLIT_ADO_CAMPO_DETALLE: 'Microsoft.VSTS.TCM.ReproSteps', DRFLIT_ADO_CAMPO_PRIORIDAD: 'Microsoft.VSTS.Common.Priority',
      DRFLIT_ADO_CAMPO_AMBIENTE: 'Custom.Environment', DRFLIT_ADO_TAGS: 'FLITO', DRFLIT_ADO_TAGS_PRUEBAS: 'FLITO-PRUEBAS',
      DRFLIT_RADICACIONES_POR_HORA: 5, DRFLIT_PURGA_CRON_ENABLED: false,
    });
    expect(env.DRFLIT_ADO_AREA_PATH).toBeUndefined();
  });

  it('DRFLIT_ADO_CAMPO_AMBIENTE vacío = no se envía; DRFLIT_PURGA_CRON_ENABLED=1 enciende', async () => {
    const { env } = await cargarEnv({ DRFLIT_ADO_CAMPO_AMBIENTE: '', DRFLIT_PURGA_CRON_ENABLED: '1' });
    expect(env.DRFLIT_ADO_CAMPO_AMBIENTE).toBe('');
    expect(env.DRFLIT_PURGA_CRON_ENABLED).toBe(true);
  });

  it.each([
    ['DRFLIT_ADO_CAMPO_DETALLE', 'System.Title/../relations'],
    ['DRFLIT_ADO_CAMPO_PRIORIDAD', 'Priority'],
    ['DRFLIT_ADO_CAMPO_AMBIENTE', '/fields/x'],
    ['DRFLIT_ADO_TIPO', 'Bug?x=1'],
    ['DRFLIT_ADO_TIMEOUT_MS', '500'],
    ['DRFLIT_ADO_PENDIENTE_VENCE_S', '10'],
    ['DRFLIT_RADICACIONES_POR_HORA', '0'],
  ])('%s=%s → la API no arranca (no inyecta rutas en el json-patch ni en la URL)', async (k, v) => {
    await expect(cargarEnv({ [k]: v })).rejects.toThrow(new RegExp(k));
  });
});
