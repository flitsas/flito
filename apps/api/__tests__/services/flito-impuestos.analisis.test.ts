// HU #12825 — cola del análisis post-envío de impuestos: dedup, idempotencia (AC2), aislamiento de
// fallos (AC3), recuperación de huérfanos (AC4) y reintento manual (AC5).
//
// Los `WHERE` se asertan sobre el SQL RENDERIZADO que el servicio pasó a `.where(...)`, no sobre la
// fila que devuelve el mock: el mock devuelve lo que se le diga, cumpla o no la condición.
// Reloj fijo + TZ=UTC en el comando.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const selectMock = vi.fn();
const updateMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, update: updateMock, insert: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const {
  __colaAnalisisVacia, __resetColaAnalisis, barrerAnalisisHuerfanos, condicionesHuerfanos, encolarAnalisis,
  ejecutarAnalisis, reanalizarImpuesto, registrarPasoAnalisis,
} = await import('../../src/modules/flito-impuestos/flito-impuestos.analisis.service.js');
const { limitadorRunt } = await import('../../src/modules/flito-impuestos/runt-limitador.js');

const dialect = new PgDialect();
const render = (w: SQL) => dialect.sqlToQuery(w);

interface Grabacion { set?: Record<string, unknown>; where?: SQL }
/** Chain grabador: resuelve a `filas` y guarda lo que se le pasó a `.set()` y `.where()`. */
function grabador(filas: unknown[] = [], g: Grabacion = {}) {
  const c: Record<string, unknown> = {};
  Object.assign(c, {
    from: () => c, limit: () => c, returning: () => c,
    set: (v: Record<string, unknown>) => { g.set = v; return c; },
    where: (w: SQL) => { g.where = w; return c; },
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(filas).then(res, rej),
  });
  return c;
}
/** Programa las respuestas de `db.update` y devuelve lo grabado, en orden de llamada. */
function updates(...respuestas: unknown[][]): Grabacion[] {
  const g: Grabacion[] = [];
  updateMock.mockImplementation(() => { const x: Grabacion = {}; g.push(x); return grabador(respuestas[g.length - 1] ?? [], x); });
  return g;
}

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const AHORA = new Date('2026-09-23T15:00:00Z');
const ANTES = new Date('2026-09-23T14:00:00Z');
const filaEnCurso = (over: Record<string, unknown> = {}) =>
  [{ analisisEstado: 'en_curso', analisisEncoladoEn: AHORA, analizadoEn: null, ...over }];

beforeEach(() => {
  __resetColaAnalisis();
  selectMock.mockReset(); updateMock.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(AHORA);
});
afterEach(() => { vi.useRealTimers(); });

describe('cola en memoria', () => {
  it('el mismo id encolado varias veces tiene UN solo job', async () => {
    selectMock.mockReturnValue(grabador(filaEnCurso()));
    const g = updates([]);
    encolarAnalisis([A, A]);
    encolarAnalisis([A]);
    await __colaAnalisisVacia();
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(g).toHaveLength(1);
  });

  it('encolar no ejecuta nada de forma síncrona (AC1: la respuesta no espera)', async () => {
    selectMock.mockReturnValue(grabador(filaEnCurso()));
    updates([]);
    encolarAnalisis([A]);
    expect(selectMock).not.toHaveBeenCalled();
    await __colaAnalisisVacia();
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('AC3: un paso que falla marca error_analisis en SU impuesto y el otro termina completado', async () => {
    const paso = vi.fn(async ({ impuestoId }: { impuestoId: string }) => { if (impuestoId === A) throw new Error('ocr caído'); });
    registrarPasoAnalisis('prueba', paso);
    selectMock.mockReturnValue(grabador(filaEnCurso()));
    const g = updates([], []);
    encolarAnalisis([A, B]);
    await __colaAnalisisVacia();

    expect(paso).toHaveBeenCalledTimes(2);
    const porId = (id: string) => g.find((x) => render(x.where!).params.includes(id))!;
    expect(porId(A).set).toEqual({ analisisEstado: 'error_analisis', direccionPendienteRevision: expect.anything() });
    // HU #12833 (AC3): el fallo técnico marca la dirección pendiente SOLO si no había una confirmada.
    expect(render(porId(A).set!.direccionPendienteRevision as SQL).sql).toBe('"flito_impuestos"."direccion_fuente" IS NULL');
    expect(porId(B).set).toEqual({ analisisEstado: 'completado', analizadoEn: AHORA });
    // Los dos UPDATE son condicionales a seguir en_curso.
    for (const x of g) expect(render(x.where!).sql).toMatch(/"analisis_estado" = \$\d/);
    expect(render(porId(A).where!).params).toContain('en_curso');
  });

  it('los pasos reciben el limitador global del RUNT', async () => {
    const paso = vi.fn(async () => {});
    registrarPasoAnalisis('prueba', paso);
    selectMock.mockReturnValue(grabador(filaEnCurso()));
    updates([]);
    await ejecutarAnalisis(A);
    expect(paso).toHaveBeenCalledWith({ impuestoId: A, runt: limitadorRunt, job: {} });
  });

  it('HU 12827: los pasos de UNA ejecución comparten el mismo job; otra ejecución recibe uno nuevo', async () => {
    const vistos: object[] = [];
    registrarPasoAnalisis('uno', async ({ job }) => { vistos.push(job); job.consultaRunt = { estado: 'sin_respuesta' }; });
    registrarPasoAnalisis('dos', async ({ job }) => { vistos.push(job); });
    selectMock.mockReturnValue(grabador(filaEnCurso()));
    updates([], []);
    await ejecutarAnalisis(A);
    await ejecutarAnalisis(A);

    expect(vistos).toHaveLength(4);
    expect(vistos[1]).toBe(vistos[0]);
    expect(vistos[1]).toEqual({ consultaRunt: { estado: 'sin_respuesta' } });
    expect(vistos[2]).not.toBe(vistos[0]);
    expect(vistos[3]).toBe(vistos[2]);
  });

  it('HU 12827: un paso que persiste y lanza → error_analisis y el siguiente paso no corre', async () => {
    const siguiente = vi.fn(async () => {});
    registrarPasoAnalisis('comparacion', async () => { throw new Error('factura ilegible'); });
    registrarPasoAnalisis('autocertificacion', siguiente);
    selectMock.mockReturnValue(grabador(filaEnCurso()));
    const g = updates([]);
    expect(await ejecutarAnalisis(A)).toBe('error_analisis');
    expect(siguiente).not.toHaveBeenCalled();
    expect(g[0].set).toEqual({ analisisEstado: 'error_analisis', direccionPendienteRevision: expect.anything() });
    expect(render(g[0].set!.direccionPendienteRevision as SQL).sql).toBe('"flito_impuestos"."direccion_fuente" IS NULL');
  });
});

describe('ejecutarAnalisis', () => {
  it('AC2: analizado_en posterior al encolado → omitido, sin pasos ni escrituras', async () => {
    const paso = vi.fn(async () => {});
    registrarPasoAnalisis('prueba', paso);
    selectMock.mockReturnValue(grabador(filaEnCurso({ analisisEncoladoEn: ANTES, analizadoEn: AHORA })));
    updates();
    expect(await ejecutarAnalisis(A)).toBe('omitido');
    expect(paso).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('AC2/AC5: re-encolado DESPUÉS del último análisis → sí corre', async () => {
    const paso = vi.fn(async () => {});
    registrarPasoAnalisis('prueba', paso);
    selectMock.mockReturnValue(grabador(filaEnCurso({ analisisEncoladoEn: AHORA, analizadoEn: ANTES })));
    updates([]);
    expect(await ejecutarAnalisis(A)).toBe('completado');
    expect(paso).toHaveBeenCalledTimes(1);
  });

  it('una fila que ya no está en_curso → omitido', async () => {
    selectMock.mockReturnValue(grabador(filaEnCurso({ analisisEstado: 'completado' })));
    updates();
    expect(await ejecutarAnalisis(A)).toBe('omitido');
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('sin pasos registrados → completado SIN escribir analizado_en', async () => {
    selectMock.mockReturnValue(grabador(filaEnCurso()));
    const g = updates([]);
    expect(await ejecutarAnalisis(A)).toBe('completado');
    expect(g[0].set).toEqual({ analisisEstado: 'completado' });
    expect(g[0].set).not.toHaveProperty('analizadoEn');
  });
});

describe('AC4 — recuperación de huérfanos', () => {
  it('las condiciones: en_curso, encolado antes de ahora-10min y el contador de re-encolados', () => {
    const primera = render(condicionesHuerfanos(AHORA, [], false));
    expect(primera.sql).toMatch(/"analisis_estado" = \$1/);
    expect(primera.sql).toMatch(/"analisis_encolado_en" < \$2/);
    expect(primera.sql).toMatch(/"analisis_reencolados" = \$3/);
    expect(primera.params).toEqual(['en_curso', '2026-09-23T14:50:00.000Z', 0]);

    const segunda = render(condicionesHuerfanos(AHORA, [], true));
    expect(segunda.sql).toMatch(/"analisis_reencolados" >= \$3/);
    expect(segunda.params).toEqual(['en_curso', '2026-09-23T14:50:00.000Z', 1]);
  });

  it('un job vivo en el proceso no cuenta como huérfano', () => {
    const r = render(condicionesHuerfanos(AHORA, [A], false));
    expect(r.sql).toMatch(/"id" not in \(\$4\)/);
    expect(r.params).toContain(A);
  });

  it('barrido: primero marca error a los ya re-encolados, luego re-encola UNA vez a los demás', async () => {
    const g = updates([{ id: B }], [{ id: A }]);
    selectMock.mockReturnValue(grabador(filaEnCurso()));
    const r = await barrerAnalisisHuerfanos(AHORA);
    expect(r).toEqual({ reencolados: 1, fallidos: 1 });

    expect(g[0].set).toEqual({ analisisEstado: 'error_analisis', direccionPendienteRevision: expect.anything() });
    expect(render(g[0].set!.direccionPendienteRevision as SQL).sql).toBe('"flito_impuestos"."direccion_fuente" IS NULL');
    expect(render(g[0].where!).sql).toMatch(/"analisis_reencolados" >= /);

    expect(render(g[1].where!).sql).toMatch(/"analisis_reencolados" = /);
    expect(g[1].set!.analisisEncoladoEn).toEqual(AHORA);
    expect(dialect.sqlToQuery(g[1].set!.analisisReencolados as SQL).sql).toBe('"flito_impuestos"."analisis_reencolados" + 1');

    await __colaAnalisisVacia();
    expect(selectMock).toHaveBeenCalledTimes(1); // solo A se encoló; B quedó en error
  });

  it('segundo barrido sobre el mismo impuesto (ya re-encolado) → error_analisis y nada que encolar', async () => {
    updates([{ id: A }], []);
    const r = await barrerAnalisisHuerfanos(AHORA);
    expect(r).toEqual({ reencolados: 0, fallidos: 1 });
    await __colaAnalisisVacia();
    expect(selectMock).not.toHaveBeenCalled();
  });
});

describe('AC5 — reanalizarImpuesto', () => {
  const imp = (estado: string, analisisEstado: string | null) => grabador([{ estado, analisisEstado }]);

  it.each([
    ['con_novedad', 'completado', 'NO_SOLICITADO'],
    ['solicitado', null, 'SIN_ANALISIS'],
    ['solicitado', 'en_curso', 'ANALISIS_EN_CURSO'],
  ])('estado %s / análisis %s → %s, sin encolar', async (estado, analisis, esperado) => {
    selectMock.mockReturnValueOnce(imp(estado, analisis));
    updates();
    expect(await reanalizarImpuesto(A, AHORA)).toEqual({ resultado: esperado });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('con certificación vigente → YA_CERTIFICADO', async () => {
    selectMock.mockReturnValueOnce(imp('solicitado', 'error_analisis')).mockReturnValueOnce(grabador([{ id: 'cert' }]));
    updates();
    expect(await reanalizarImpuesto(A, AHORA)).toEqual({ resultado: 'YA_CERTIFICADO' });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('no existe → NO_ENCONTRADO', async () => {
    selectMock.mockReturnValueOnce(grabador([]));
    expect(await reanalizarImpuesto(A, AHORA)).toEqual({ resultado: 'NO_ENCONTRADO' });
  });

  it('terminado y sin certificación → UPDATE condicional atómico, en_curso y encolado', async () => {
    const paso = vi.fn(async () => {});
    registrarPasoAnalisis('prueba', paso);
    selectMock.mockReturnValueOnce(imp('solicitado', 'completado')).mockReturnValueOnce(grabador([]))
      .mockReturnValue(grabador(filaEnCurso({ analisisEncoladoEn: AHORA, analizadoEn: ANTES })));
    const g = updates([{ id: A }], []);

    expect(await reanalizarImpuesto(A, AHORA)).toEqual({ resultado: 'ENCOLADO', id: A, analisisEstado: 'en_curso' });
    // HU 12827: el reintento borra el semáforo de la corrida anterior.
    expect(g[0].set).toMatchObject({
      analisisEstado: 'en_curso', analisisEncoladoEn: AHORA, analisisReencolados: 0, semaforo: null, comparacionFacturaRunt: null,
      // HU #12833 (D6): el reintento limpia la dirección AUTOMÁTICA y conserva la manual.
      direccionPendienteRevision: false,
    });
    expect(render(g[0].set!.direccionFuente as SQL).sql).toBe(`NULLIF("flito_impuestos"."direccion_fuente", 'factura')`);
    expect(render(g[0].set!.direccionFactura as SQL).sql)
      .toBe(`CASE WHEN "flito_impuestos"."direccion_fuente" = 'manual' THEN "flito_impuestos"."direccion_factura" END`);
    for (const k of ['municipioFactura', 'departamentoFactura', 'direccionConfirmadaPorId', 'direccionConfirmadaPorNombre', 'direccionConfirmadaEn']) {
      expect(render(g[0].set![k] as SQL).sql, k).toMatch(/^CASE WHEN "flito_impuestos"\."direccion_fuente" = 'manual' THEN /);
    }
    const w = render(g[0].where!);
    expect(w.sql).toMatch(/"estado" = \$\d/);
    expect(w.sql).toMatch(/"analisis_estado" in \(\$\d, \$\d\)/);
    expect(w.params).toEqual([A, 'solicitado', 'completado', 'error_analisis']);

    expect(paso).not.toHaveBeenCalled(); // la respuesta no esperó al job
    await __colaAnalisisVacia();
    expect(paso).toHaveBeenCalledTimes(1); // y el job saltó la idempotencia
  });

  it('otro usuario ganó la carrera (0 filas) → ANALISIS_EN_CURSO y no se encola un segundo job', async () => {
    selectMock.mockReturnValueOnce(imp('solicitado', 'error_analisis')).mockReturnValueOnce(grabador([]));
    updates([]);
    expect(await reanalizarImpuesto(A, AHORA)).toEqual({ resultado: 'ANALISIS_EN_CURSO' });
    await __colaAnalisisVacia();
    expect(selectMock).toHaveBeenCalledTimes(2);
  });
});
