// HU #14113 — programación de la purga por retención de la cédula de logística:
// `flito-logistica-retencion.cron.ts`. Puerta positiva, candado, hora de Colombia, AC4 (logs).

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TZ_ORIGINAL = process.env.TZ;
process.env.TZ = 'UTC';
afterAll(() => {
  if (TZ_ORIGINAL === undefined) delete process.env.TZ;
  else process.env.TZ = TZ_ORIGINAL;
});

const m = vi.hoisted(() => ({
  env: { LOGISTICA_RETENCION_CRON_ENABLED: false as boolean },
  orden: [] as string[],
  lineas: [] as unknown[][],
  lockLibre: true,
}));

const purgaMock = vi.hoisted(() => vi.fn());
const withLockMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/config/env.js', () => ({ env: m.env }));
vi.mock('../../src/shared/utils/lock.js', () => ({ withLock: withLockMock }));
vi.mock('../../src/modules/flito-logistica/flito-logistica-retencion.service.js', () => ({
  ANIOS_RETENCION: 10,
  corteRetencion: (ahora: Date) => {
    const c = new Date(ahora.getTime());
    c.setUTCFullYear(c.getUTCFullYear() - 10);
    return c;
  },
  ejecutarPurgaRetencionLogistica: purgaMock,
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

const cron = await import('../../src/modules/flito-logistica/flito-logistica-retencion.cron.js');

const RESUMEN = { actasPurgadas: 2, recogidaPurgadas: 1 };
const texto = () => JSON.stringify(m.lineas);
const NOMBRE_PLANTA = 'Persona Sintetica Lopez';
const CEDULA_PLANTA = '1020304050';

beforeEach(() => {
  cron.stopLogisticaRetencionCron();
  cron.reiniciarEstadoRetencion();
  m.env.LOGISTICA_RETENCION_CRON_ENABLED = false;
  m.orden = []; m.lineas = []; m.lockLibre = true;
  purgaMock.mockReset().mockImplementation(async () => { m.orden.push('purga'); return RESUMEN; });
  withLockMock.mockReset().mockImplementation(async (_n: string, _t: number, fn: () => Promise<unknown>) => {
    m.orden.push('lock');
    return m.lockLibre ? fn() : null;
  });
});
afterEach(() => { cron.stopLogisticaRetencionCron(); vi.useRealTimers(); });

describe('puerta positiva LOGISTICA_RETENCION_CRON_ENABLED', () => {
  it('sin la puerta: no arranca, lo dice en el log nombrando la variable, y ningún latido purga', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-10-07T08:05:00Z')); // 03:05 Bogotá
    cron.startLogisticaRetencionCron();
    await vi.advanceTimersByTimeAsync(cron.LATIDO_RETENCION_MS * 3);
    expect(texto()).toContain('LOGISTICA_RETENCION_CRON_ENABLED');
    expect(texto()).toContain('DESHABILITADA');
    expect(withLockMock).not.toHaveBeenCalled();
    expect(purgaMock).not.toHaveBeenCalled();
  });

  it('con la puerta: el latido a las 03:05 de Bogotá purga dentro del candado', async () => {
    m.env.LOGISTICA_RETENCION_CRON_ENABLED = true;
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-10-07T07:58:00Z')); // 02:58 Bogotá
    cron.startLogisticaRetencionCron();
    expect(texto()).toContain('ACTIVA');
    await vi.advanceTimersByTimeAsync(cron.LATIDO_RETENCION_MS); // 03:08
    expect(purgaMock).toHaveBeenCalledTimes(1);
  });
});

describe('candado: una sola instancia', () => {
  it('withLock con nombre flito-logistica-retencion y TTL < 1 h; la purga va DENTRO y recibe el `ahora` del latido', async () => {
    const ahora = new Date('2026-10-07T08:30:00Z');
    expect(await cron.latidoRetencionLogistica(ahora)).toBe('corrida');
    expect(withLockMock).toHaveBeenCalledTimes(1);
    const [nombre, ttl] = withLockMock.mock.calls[0];
    expect(nombre).toBe('flito-logistica-retencion');
    expect(ttl).toBeLessThan(60 * 60_000);
    expect(m.orden).toEqual(['lock', 'purga']);
    expect(purgaMock).toHaveBeenCalledWith({ ahora });
  });

  it('otra instancia tiene el candado: no purga y lo registra', async () => {
    m.lockLibre = false;
    expect(await cron.latidoRetencionLogistica(new Date('2026-10-07T08:30:00Z'))).toBe('otra_instancia');
    expect(purgaMock).not.toHaveBeenCalled();
    expect(texto()).toContain('otra instancia');
  });
});

describe('hora de Colombia, una vez al día', () => {
  it('03:00 Bogotá = 08:00 UTC corre; 03:00 UTC (22:00 Bogotá) no; no se repite el mismo día; al día siguiente sí', async () => {
    expect(await cron.latidoRetencionLogistica(new Date('2026-10-07T03:00:00Z'))).toBe('fuera_de_ventana');
    expect(await cron.latidoRetencionLogistica(new Date('2026-10-07T07:59:59Z'))).toBe('fuera_de_ventana');
    expect(await cron.latidoRetencionLogistica(new Date('2026-10-07T08:00:00Z'))).toBe('corrida');
    expect(await cron.latidoRetencionLogistica(new Date('2026-10-07T08:50:00Z'))).toBe('ya_corrio_hoy');
    expect(await cron.latidoRetencionLogistica(new Date('2026-10-07T09:00:00Z'))).toBe('fuera_de_ventana');
    expect(await cron.latidoRetencionLogistica(new Date('2026-10-08T08:10:00Z'))).toBe('corrida');
    expect(purgaMock).toHaveBeenCalledTimes(2);
  });

  it('relojBogota no depende del huso del proceso', () => {
    expect(cron.relojBogota(new Date('2026-10-08T04:30:00Z'))).toEqual({ dia: '2026-10-07', hora: 23 });
  });
});

describe('AC4 — sin PII en logs del cron', () => {
  it('la corrida loguea conteos, host y cutoff; no cédula ni nombre; un fallo loguea el nombre del error', async () => {
    expect(await cron.latidoRetencionLogistica(new Date('2026-10-07T08:00:00Z'))).toBe('corrida');
    const ok = texto();
    expect(ok).toContain('actasPurgadas');
    expect(ok).toContain('recogidaPurgadas');
    expect(ok).toContain('cutoff');
    expect(ok).toContain('2016-10-07T08:00:00.000Z');
    expect(ok).not.toContain(NOMBRE_PLANTA);
    expect(ok).not.toContain(CEDULA_PLANTA);

    cron.reiniciarEstadoRetencion();
    m.lineas = [];
    purgaMock.mockRejectedValueOnce(Object.assign(new Error(`cedula ${CEDULA_PLANTA} de ${NOMBRE_PLANTA}`), { name: 'Error' }));
    expect(await cron.latidoRetencionLogistica(new Date('2026-10-07T08:00:00Z'))).toBe('fallo');
    const fallo = texto();
    expect(fallo).not.toContain(CEDULA_PLANTA);
    expect(fallo).not.toContain(NOMBRE_PLANTA);
    expect(fallo).toContain('"Error"');
  });
});

describe('cabecera RN del cron', () => {
  it('declara qué se borra, 10 años desde la entrega, qué se conserva y la base legal', () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(
      path.resolve(dir, '../../src/modules/flito-logistica/flito-logistica-retencion.cron.ts'),
      'utf8',
    );
    const cabecera = src.slice(0, src.indexOf('import '));
    expect(cabecera).toMatch(/RN-RET1/);
    expect(cabecera).toMatch(/10 años desde la entrega/);
    expect(cabecera).toMatch(/documento_cifrado/);
    expect(cabecera).toMatch(/documento_ultimos/);
    expect(cabecera).toMatch(/CONSERVA la fila/);
    expect(cabecera).toMatch(/nombre/);
    expect(cabecera).toMatch(/firma_storage_key/);
    expect(cabecera).toMatch(/Ley 1581/);
    expect(cabecera).toMatch(/LOGISTICA_RETENCION_CRON_ENABLED/);
  });
});
