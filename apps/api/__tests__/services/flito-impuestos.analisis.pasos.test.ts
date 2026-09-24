// HU #12828 — orden de los pasos del análisis post-envío: extracción → comparación →
// autocertificación, y el memo `job` (con `consultaRunt`) es el MISMO objeto para los tres. Y el
// runner no loguea el `message` de un error de paso (el de Drizzle arrastra los params = PII).

import { describe, it, expect, vi } from 'vitest';

const orden: string[] = [];
const jobs: unknown[] = [];
const paso = (n: string) => vi.fn(async ({ job }: { job: unknown }) => { orden.push(n); jobs.push(job); });

vi.mock('../../src/modules/flito-impuestos/flito-impuestos.extraccion.js', () => ({ pasoExtraccion: paso('extraccion') }));
vi.mock('../../src/modules/flito-impuestos/flito-impuestos.comparacion.js', () => ({ pasoComparacion: paso('comparacion') }));
vi.mock('../../src/modules/flito-impuestos/flito-impuestos.autocertificacion.js', () => ({ pasoAutocertificacion: paso('autocertificacion') }));

const logWarn = vi.fn();
vi.mock('../../src/shared/logger.js', () => ({
  loggerFor: () => ({ info: vi.fn(), warn: logWarn, error: vi.fn(), debug: vi.fn() }),
}));

let fallaSelect: Error | null = null;
const fila = { analisisEstado: 'en_curso', analisisEncoladoEn: new Date('2026-09-01T00:00:00Z'), analizadoEn: null };
const cadena = (): Record<string, unknown> => {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit', 'set']) c[m] = () => c;
  c.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    (fallaSelect ? Promise.reject(fallaSelect) : Promise.resolve([fila])).then(res, rej);
  return c;
};
vi.mock('../../src/db/client.js', () => ({ db: { select: () => cadena(), update: () => cadena() }, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const { registrarPasosAnalisisImpuestos } = await import('../../src/modules/flito-impuestos/flito-impuestos.analisis.pasos.js');
const { ejecutarAnalisis, __resetColaAnalisis, registrarPasoAnalisis, encolarAnalisis, __colaAnalisisVacia } = await import('../../src/modules/flito-impuestos/flito-impuestos.analisis.service.js');

describe('registrarPasosAnalisisImpuestos', () => {
  it('ejecuta extracción → comparación → autocertificación con el mismo memo del job', async () => {
    __resetColaAnalisis();
    registrarPasosAnalisisImpuestos();

    await expect(ejecutarAnalisis('00000000-0000-0000-0000-0000000000c9')).resolves.toBe('completado');

    expect(orden).toEqual(['extraccion', 'comparacion', 'autocertificacion']);
    expect(new Set(jobs).size).toBe(1);
  });
});

// Valores INVENTADOS, con la forma del `message` de `DrizzleQueryError`.
const PLACA = 'ZZZ997';
const DOC = '9999999997';
const VIN = '9ZZTEST0000000003';
const errorConPii = () => Object.assign(
  new Error(`Failed query: insert into "flito_impuesto_certificaciones" params: ${PLACA},${DOC},${VIN}`),
  { name: 'DrizzleQueryError', cause: { code: '23505' } },
);

describe('logs del runner sin PII', () => {
  it('un paso que lanza con placa/documento/VIN en el message → el warn lleva solo nombre y código', async () => {
    __resetColaAnalisis(); logWarn.mockReset();
    registrarPasoAnalisis('falla', async () => { throw errorConPii(); });

    await expect(ejecutarAnalisis('00000000-0000-0000-0000-0000000000ca')).resolves.toBe('error_analisis');

    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn.mock.calls[0][0]).toEqual({
      impuestoId: '00000000-0000-0000-0000-0000000000ca', paso: 'falla', err: 'DrizzleQueryError', code: '23505',
    });
    const logs = JSON.stringify(logWarn.mock.calls);
    for (const pii of [PLACA, DOC, VIN, 'Failed query']) expect(logs).not.toContain(pii);
  });

  it('un fallo fuera de los pasos (job) tampoco loguea el message', async () => {
    __resetColaAnalisis(); logWarn.mockReset();
    fallaSelect = errorConPii();
    try {
      encolarAnalisis(['00000000-0000-0000-0000-0000000000cb']);
      await __colaAnalisisVacia();
    } finally { fallaSelect = null; }

    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn.mock.calls[0][0]).toEqual({
      impuestoId: '00000000-0000-0000-0000-0000000000cb', err: 'DrizzleQueryError', code: '23505',
    });
    const logs = JSON.stringify(logWarn.mock.calls);
    for (const pii of [PLACA, DOC, VIN, 'Failed query']) expect(logs).not.toContain(pii);
  });
});
