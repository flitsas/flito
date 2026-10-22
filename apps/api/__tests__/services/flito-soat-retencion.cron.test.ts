// HU #13409 — programación de la purga por retención del SOAT descartado: `flito-soat-retencion.cron.ts`.
// AC7 (candado + puerta positiva + hora de Colombia) y AC9 (cabecera RN).
//
// TZ=UTC para todo el archivo, como `flito-soat-vigencia.cron.test.ts`: en una máquina en −05 un cron
// atado a `getHours()` del proceso coincidiría con Bogotá y pasaría; en UTC difieren 5 h siempre.

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
  env: { SOAT_RETENCION_CRON_ENABLED: false as boolean },
  orden: [] as string[],
  lineas: [] as unknown[][],
  lockLibre: true,
}));

const purgaMock = vi.hoisted(() => vi.fn());
const withLockMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/config/env.js', () => ({ env: m.env }));
vi.mock('../../src/shared/utils/lock.js', () => ({ withLock: withLockMock }));
vi.mock('../../src/modules/flito-soat/flito-soat-retencion.service.js', () => ({
  DIAS_RETENCION: 30, LOTE_RETENCION: 200, ejecutarPurgaRetencion: purgaMock,
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

const cron = await import('../../src/modules/flito-soat/flito-soat-retencion.cron.js');

const RESUMEN = { consideradas: 2, purgadas: 2, conPendientes: 0, archivos: 5, bytes: 999 };
const texto = () => JSON.stringify(m.lineas);

beforeEach(() => {
  cron.stopSoatRetencionCron();
  cron.reiniciarEstadoRetencion();
  m.env.SOAT_RETENCION_CRON_ENABLED = false;
  m.orden = []; m.lineas = []; m.lockLibre = true;
  purgaMock.mockReset().mockImplementation(async () => { m.orden.push('purga'); return RESUMEN; });
  withLockMock.mockReset().mockImplementation(async (_n: string, _t: number, fn: () => Promise<unknown>) => {
    m.orden.push('lock');
    return m.lockLibre ? fn() : null;
  });
});
afterEach(() => { cron.stopSoatRetencionCron(); vi.useRealTimers(); });

describe('AC7 — puerta positiva SOAT_RETENCION_CRON_ENABLED', () => {
  it('TC7.1 sin la puerta: no arranca, lo dice en el log nombrando la variable, y ningún latido purga', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-10-07T08:05:00Z')); // 03:05 Bogotá
    cron.startSoatRetencionCron();
    await vi.advanceTimersByTimeAsync(cron.LATIDO_RETENCION_MS * 3);
    expect(texto()).toContain('SOAT_RETENCION_CRON_ENABLED');
    expect(texto()).toContain('DESHABILITADA');
    expect(withLockMock).not.toHaveBeenCalled();
    expect(purgaMock).not.toHaveBeenCalled();
  });

  it('con la puerta: el latido a las 03:05 de Bogotá purga dentro del candado', async () => {
    m.env.SOAT_RETENCION_CRON_ENABLED = true;
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-10-07T07:58:00Z')); // 02:58 Bogotá
    cron.startSoatRetencionCron();
    expect(texto()).toContain('ACTIVA');
    await vi.advanceTimersByTimeAsync(cron.LATIDO_RETENCION_MS); // 03:08
    expect(purgaMock).toHaveBeenCalledTimes(1);
  });
});

describe('AC7 — candado: una sola instancia', () => {
  it('TC7.2 withLock con nombre flito-soat-retencion y TTL < 1 h; la purga va DENTRO y recibe el `ahora` del latido', async () => {
    const ahora = new Date('2026-10-07T08:30:00Z');
    expect(await cron.latidoRetencionSoat(ahora)).toBe('corrida');
    expect(withLockMock).toHaveBeenCalledTimes(1);
    const [nombre, ttl] = withLockMock.mock.calls[0];
    expect(nombre).toBe('flito-soat-retencion');
    expect(ttl).toBeLessThan(60 * 60_000);
    expect(m.orden).toEqual(['lock', 'purga']);
    expect(purgaMock).toHaveBeenCalledWith({ ahora });
  });

  it('TC7.2 otra instancia tiene el candado: no purga y lo registra', async () => {
    m.lockLibre = false;
    expect(await cron.latidoRetencionSoat(new Date('2026-10-07T08:30:00Z'))).toBe('otra_instancia');
    expect(purgaMock).not.toHaveBeenCalled();
    expect(texto()).toContain('otra instancia');
  });
});

describe('AC7 — hora de Colombia, una vez al día', () => {
  it('TC7.3 03:00 Bogotá = 08:00 UTC corre; 03:00 UTC (22:00 Bogotá) no; no se repite el mismo día; al día siguiente sí', async () => {
    expect(await cron.latidoRetencionSoat(new Date('2026-10-07T03:00:00Z'))).toBe('fuera_de_ventana');
    expect(await cron.latidoRetencionSoat(new Date('2026-10-07T07:59:59Z'))).toBe('fuera_de_ventana');
    expect(await cron.latidoRetencionSoat(new Date('2026-10-07T08:00:00Z'))).toBe('corrida');
    expect(await cron.latidoRetencionSoat(new Date('2026-10-07T08:50:00Z'))).toBe('ya_corrio_hoy');
    expect(await cron.latidoRetencionSoat(new Date('2026-10-07T09:00:00Z'))).toBe('fuera_de_ventana');
    expect(await cron.latidoRetencionSoat(new Date('2026-10-08T08:10:00Z'))).toBe('corrida');
    expect(purgaMock).toHaveBeenCalledTimes(2);
  });

  it('relojBogota no depende del huso del proceso', () => {
    expect(cron.relojBogota(new Date('2026-10-08T04:30:00Z'))).toEqual({ dia: '2026-10-07', hora: 23 });
  });

  it('una corrida que falla no marca el día: el latido siguiente de la hora reintenta; el log lleva el nombre del error, no el mensaje', async () => {
    purgaMock.mockRejectedValueOnce(new Error('soat/incompletas/900123456/factura.pdf'));
    expect(await cron.latidoRetencionSoat(new Date('2026-10-07T08:00:00Z'))).toBe('fallo');
    expect(texto()).not.toContain('900123456');
    expect(await cron.latidoRetencionSoat(new Date('2026-10-07T08:10:00Z'))).toBe('corrida');
  });
});

describe('AC9 — cabecera RN del cron', () => {
  it('TC9.1 declara qué se borra, 30 días desde el descarte, qué se conserva y la base legal', () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(path.resolve(dir, '../../src/modules/flito-soat/flito-soat-retencion.cron.ts'), 'utf8');
    const cabecera = src.slice(0, src.indexOf('import '));
    expect(cabecera).toMatch(/RN-RET1/);
    expect(cabecera).toMatch(/30 días desde el descarte/);
    expect(cabecera).toMatch(/BORRA del almacenamiento/);
    expect(cabecera).toMatch(/factura_storage_key/);
    expect(cabecera).toMatch(/documento_adicional_soat/);
    expect(cabecera).toMatch(/CONSERVA la fila de la solicitud/);
    expect(cabecera).toMatch(/Ley 1581/);
  });
});
