// HU #12825 (AC1/AC2) — el envío al gestor deja `en_curso` DENTRO de su transacción y encola el
// análisis DESPUÉS del commit, solo para los impuestos que nunca se analizaron.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { chain } from '../helpers/db.js';

const transactionMock = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), update: vi.fn(), insert: vi.fn(), delete: vi.fn(), transaction: transactionMock, execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const orden: string[] = [];
const encolarMock = vi.fn((ids: string[]) => { orden.push(`encolar:${ids.join(',')}`); });
vi.mock('../../src/modules/flito-impuestos/flito-impuestos.analisis.service.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  encolarAnalisis: (ids: string[]) => encolarMock(ids),
}));

const { enviarAlGestor } = await import('../../src/modules/flito-impuestos/flito-impuestos.service.js');

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const CTX = { userId: 5, username: 'u@x.io', role: 'admin', organismos: [] };
const render = (w: SQL) => new PgDialect().sqlToQuery(w);

function montarTx(locked: unknown[]) {
  const sets: Record<string, unknown>[] = [];
  const wheres: SQL[] = [];
  const txUpdate = vi.fn(() => {
    const c = chain([]) as unknown as Record<string, unknown>;
    c.set = (v: Record<string, unknown>) => { sets.push(v); return c; };
    c.where = (w: SQL) => { wheres.push(w); return c; };
    return c;
  });
  const tx = { select: vi.fn().mockReturnValue(chain(locked)), update: txUpdate, insert: vi.fn().mockReturnValue(chain([])) };
  transactionMock.mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => {
    const r = await cb(tx);
    orden.push('commit');
    return r;
  });
  return { sets, wheres, txUpdate };
}

beforeEach(() => { orden.length = 0; encolarMock.mockClear(); transactionMock.mockReset(); });

describe('enviarAlGestor → análisis post-envío', () => {
  it('marca en_curso solo a los nunca analizados y los encola DESPUÉS del commit', async () => {
    const { sets, wheres, txUpdate } = montarTx([{ id: A, analizadoEn: null }, { id: B, analizadoEn: new Date('2026-09-01T00:00:00Z') }]);

    const r = await enviarAlGestor([A, B], CTX);

    expect(r).toEqual({ enviados: [A, B], yaEnviados: [] });
    expect(txUpdate).toHaveBeenCalledTimes(2); // el cambio de estado + el en_curso, en la MISMA tx
    expect(sets[1]).toMatchObject({ analisisEstado: 'en_curso', analisisReencolados: 0 });
    expect(sets[1].analisisEncoladoEn).toBeInstanceOf(Date);
    const w = render(wheres[1]);
    expect(w.params).toEqual([A]);                    // B (ya analizado) no se toca: AC2
    expect(w.sql).toMatch(/"analizado_en" is null/);
    expect(orden).toEqual(['commit', `encolar:${A}`]);
  });

  it('si la transacción falla no se encola nada', async () => {
    transactionMock.mockRejectedValue(new Error('deadlock'));
    await expect(enviarAlGestor([A], CTX)).rejects.toThrow('deadlock');
    expect(encolarMock).not.toHaveBeenCalled();
  });

  it('todos ya analizados: sin UPDATE de análisis y encola la lista vacía', async () => {
    const { txUpdate } = montarTx([{ id: B, analizadoEn: new Date('2026-09-01T00:00:00Z') }]);
    await enviarAlGestor([B], CTX);
    expect(txUpdate).toHaveBeenCalledTimes(1);
    expect(encolarMock).toHaveBeenCalledWith([]);
  });

  it('nada que enviar (ya enviados) → no toca el análisis', async () => {
    const { txUpdate } = montarTx([]);
    const r = await enviarAlGestor([A], CTX);
    expect(r).toEqual({ enviados: [], yaEnviados: [A] });
    expect(txUpdate).not.toHaveBeenCalled();
    expect(encolarMock).toHaveBeenCalledWith([]);
  });
});
