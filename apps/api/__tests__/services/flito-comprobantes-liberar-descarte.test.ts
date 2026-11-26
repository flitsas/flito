/**
 * Épica #14707 (ADR-0049 §5, D11; decisión cerrada 3) — `liberarComprobantesDeDescarte`.
 *
 * Sin base: `tx` es un doble mínimo que responde por orden a los dos SELECT (todos los aplicados y los que salen con
 * `FOR UPDATE SKIP LOCKED`) y registra los INSERT de auditoría. El núcleo de desaplicar (`liberarAplicadoEnTx`) y el
 * libro de bolsas (`movimientoPorLlave`) son espías: su mecánica la cubren `flito-comprobantes-desaplicar.test.ts` y
 * `descarte-tramite-muerto.test.ts`.
 *
 * Afirma: se piden los aplicados de los conceptos y trámites indicados con `SKIP LOCKED`; un bloqueado por otra
 * sesión cuenta como no liberado; el periodo cerrado NO se libera, no aborta y queda auditado; una salida de bolsa
 * por conciliación/sellado no se revierte y queda auditada; un error distinto se propaga. Sin VIN ni placa.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../src/shared/logger.js', () => ({ logger: logMock, loggerFor: () => logMock }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
const h = vi.hoisted(() => ({ liberar: vi.fn(), movimiento: vi.fn() }));
vi.mock('../../src/modules/flito-comprobantes/flito-comprobantes.desaplicar.js', () => ({ liberarAplicadoEnTx: h.liberar }));
vi.mock('../../src/modules/flito-bolsas/flito-bolsas.libro.js', () => ({ movimientoPorLlave: h.movimiento }));

const { liberarComprobantesDeDescarte } = await import('../../src/modules/flito-comprobantes/flito-comprobantes.liberar-descarte.js');
const { ComprobanteError } = await import('../../src/modules/flito-comprobantes/flito-comprobantes.service.js');

function txFalso(respuestas: Array<Array<{ id: string }>>) {
  const fors: unknown[][] = [];
  const auditorias: Array<Record<string, unknown>> = [];
  const select = vi.fn(() => {
    const filas = respuestas.shift() ?? [];
    const c: Record<string, unknown> = {
      from: () => c, where: () => c, orderBy: () => c,
      for: (...a: unknown[]) => { fors.push(a); return c; },
      then: (ok: (v: unknown) => unknown) => Promise.resolve(filas).then(ok),
    };
    return c;
  });
  const insert = vi.fn(() => ({ values: async (v: Record<string, unknown>) => { auditorias.push(v); } }));
  return { tx: { select, insert } as never, fors, auditorias };
}

const periodoCerrado = () => new ComprobanteError(409, 'periodo_cerrado' as never, 'El periodo de la bolsa ya está cerrado');

beforeEach(() => {
  h.liberar.mockReset().mockResolvedValue(undefined);
  h.movimiento.mockReset().mockResolvedValue(undefined);
  logMock.warn.mockClear();
});

describe('Épica #14707 — liberarComprobantesDeDescarte (D11)', () => {
  it('libera los aplicados con SKIP LOCKED; un bloqueado por otra sesión cuenta como no liberado', async () => {
    const { tx, fors } = txFalso([[{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }], [{ id: 'c1' }, { id: 'c2' }]]);
    const r = await liberarComprobantesDeDescarte(tx, { tramiteIds: ['t-m'], conceptos: ['soat', 'impuesto'] as never, radicado: 'R-1' });
    expect(r).toEqual({ liberados: 2, noLiberados: 1 });
    expect(fors).toEqual([['update', { skipLocked: true }]]);
    expect(h.liberar.mock.calls.map((c) => c[1])).toEqual(['c1', 'c2']);
    expect(h.liberar.mock.calls[0]![2]).toContain('R-1');
    expect(logMock.warn).toHaveBeenCalledWith({ radicado: 'R-1', bloqueados: 1 }, expect.any(String));
  });

  it('decisión cerrada 3: periodo cerrado → no se libera, la tx sigue y queda en audit_logs', async () => {
    const { tx, auditorias } = txFalso([[{ id: 'c1' }, { id: 'c2' }], [{ id: 'c1' }, { id: 'c2' }]]);
    h.liberar.mockRejectedValueOnce(periodoCerrado());
    const r = await liberarComprobantesDeDescarte(tx, { tramiteIds: ['t-m'], conceptos: ['soat'] as never, radicado: 'R-2' });
    expect(r).toEqual({ liberados: 1, noLiberados: 1 });
    expect(auditorias).toHaveLength(1);
    expect(auditorias[0]).toMatchObject({ userId: null, userEmail: 'sistema', resource: 'flito_comprobante', resourceId: 'c1' });
    expect(String(auditorias[0]!.detail)).toMatch(/periodo de la bolsa está cerrado/);
  });

  it('un error que no es de periodo cerrado se propaga (la tx del sync se revierte entera)', async () => {
    const { tx } = txFalso([[{ id: 'c1' }], [{ id: 'c1' }]]);
    h.liberar.mockRejectedValueOnce(new Error('fallo de base'));
    await expect(liberarComprobantesDeDescarte(tx, { tramiteIds: ['t-m'], conceptos: ['soat'] as never, radicado: 'R-3' }))
      .rejects.toThrow('fallo de base');
  });

  it('salida de bolsa del SOAT por conciliación/sellado: no se revierte y se audita; una de comprobante no', async () => {
    const a = txFalso([]);
    h.movimiento.mockResolvedValueOnce({ origen: 'conciliacion' });
    const r = await liberarComprobantesDeDescarte(a.tx, { tramiteIds: [], conceptos: [], radicado: 'R-4', soatDescartadoId: 'soat-9' });
    expect(r).toEqual({ liberados: 0, noLiberados: 1 });
    expect(h.movimiento).toHaveBeenCalledWith(expect.anything(), 'salida:soat:soat-9');
    expect(a.auditorias[0]).toMatchObject({ resourceId: 'soat-9' });
    expect(String(a.auditorias[0]!.detail)).toMatch(/no se revierte automáticamente/);

    const b = txFalso([]);
    h.movimiento.mockResolvedValueOnce({ origen: 'comprobante' });
    expect(await liberarComprobantesDeDescarte(b.tx, { tramiteIds: [], conceptos: [], radicado: 'R-5', soatDescartadoId: 'soat-9' }))
      .toEqual({ liberados: 0, noLiberados: 0 });
    expect(b.auditorias).toEqual([]);
  });

  it('sin trámites o sin conceptos no consulta comprobantes', async () => {
    const { tx } = txFalso([]);
    expect(await liberarComprobantesDeDescarte(tx, { tramiteIds: ['t'], conceptos: [], radicado: 'R-6' })).toEqual({ liberados: 0, noLiberados: 0 });
    expect((tx as unknown as { select: ReturnType<typeof vi.fn> }).select).not.toHaveBeenCalled();
  });
});
