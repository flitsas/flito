// HU #12828 — orden de los pasos del análisis post-envío: extracción → comparación →
// autocertificación, y el memo `job` (con `consultaRunt`) es el MISMO objeto para los tres.

import { describe, it, expect, vi } from 'vitest';

const orden: string[] = [];
const jobs: unknown[] = [];
const paso = (n: string) => vi.fn(async ({ job }: { job: unknown }) => { orden.push(n); jobs.push(job); });

vi.mock('../../src/modules/flito-impuestos/flito-impuestos.extraccion.js', () => ({ pasoExtraccion: paso('extraccion') }));
vi.mock('../../src/modules/flito-impuestos/flito-impuestos.comparacion.js', () => ({ pasoComparacion: paso('comparacion') }));
vi.mock('../../src/modules/flito-impuestos/flito-impuestos.autocertificacion.js', () => ({ pasoAutocertificacion: paso('autocertificacion') }));

const fila = { analisisEstado: 'en_curso', analisisEncoladoEn: new Date('2026-09-01T00:00:00Z'), analizadoEn: null };
const cadena = (): Record<string, unknown> => {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit', 'set']) c[m] = () => c;
  c.then = (res: (v: unknown) => unknown) => Promise.resolve([fila]).then(res);
  return c;
};
vi.mock('../../src/db/client.js', () => ({ db: { select: () => cadena(), update: () => cadena() }, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const { registrarPasosAnalisisImpuestos } = await import('../../src/modules/flito-impuestos/flito-impuestos.analisis.pasos.js');
const { ejecutarAnalisis, __resetColaAnalisis } = await import('../../src/modules/flito-impuestos/flito-impuestos.analisis.service.js');

describe('registrarPasosAnalisisImpuestos', () => {
  it('ejecuta extracción → comparación → autocertificación con el mismo memo del job', async () => {
    __resetColaAnalisis();
    registrarPasosAnalisisImpuestos();

    await expect(ejecutarAnalisis('00000000-0000-0000-0000-0000000000c9')).resolves.toBe('completado');

    expect(orden).toEqual(['extraccion', 'comparacion', 'autocertificacion']);
    expect(new Set(jobs).size).toBe(1);
  });
});
