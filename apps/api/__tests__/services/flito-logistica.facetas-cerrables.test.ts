// HU #14116 — GET /facetas: companiasCerrables con precioEntregaCliente + lts (null ≠ 0).
// HU #14123 — el mismo DTO gana precioEntregaFlit, misma `ahora`, null ≠ 0, sin vigenciaId.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { chain } from '../helpers/db.js';

const selectMock = vi.fn();
const selectDistinctMock = vi.fn();
const precioTrasladoDeMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock, selectDistinct: selectDistinctMock, insert: vi.fn(),
    update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn(),
  },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/modules/flito-logistica/flito-logistica-precios.js', () => ({
  precioTrasladoDe: (...a: unknown[]) => precioTrasladoDeMock(...a),
}));

const { facetas } = await import('../../src/modules/flito-logistica/flito-logistica.consulta.js');

const D1 = '11111111-1111-4111-8111-111111111111';
const D2 = '22222222-2222-4222-8222-222222222222';
const D3 = '33333333-3333-4333-8333-333333333333';
const VIG = '66666666-6666-4666-8666-666666666666';
const ALCANCE = { enlace: 'compania' as const, companiaId: 5 };

const dialecto = new PgDialect();
const aSql = (c: unknown) => dialecto.sqlToQuery(c as SQL);

function doc(over: Record<string, unknown> = {}) {
  return {
    documentoId: D1, placa: 'ABC123', numeroLt: 'LT-1', idFlit: 'FLIT-1',
    companiaId: 5, nombre: 'ACME', ...over,
  };
}

let whereCerrables: unknown;

beforeEach(() => {
  selectMock.mockReset();
  selectDistinctMock.mockReset();
  precioTrasladoDeMock.mockReset();
  whereCerrables = undefined;
  selectDistinctMock.mockReturnValue(chain([]));
});

function conDocs(rows: unknown[]) {
  selectMock.mockImplementation(() => {
    const c = chain(rows);
    const inner = c.where;
    c.where = (w: unknown) => {
      whereCerrables = w;
      return inner.call(c, w);
    };
    return c;
  });
}

describe('facetas — companiasCerrables (HU #14116)', () => {
  it('precioEntregaCliente y precioEntregaFlit: null (sin tarifa) vs 0 configurado, sin coerción', async () => {
    conDocs([
      doc({ documentoId: D1, companiaId: 5, nombre: 'ACME' }),
      doc({ documentoId: D2, placa: 'XYZ789', numeroLt: 'LT-2', idFlit: 'FLIT-2', companiaId: 7, nombre: 'Beta' }),
    ]);
    precioTrasladoDeMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ valor: 0, vigenciaId: VIG })
      .mockResolvedValueOnce({ valor: 0, vigenciaId: VIG });

    const f = await facetas(ALCANCE);
    expect(f.companiasCerrables).toEqual([
      {
        companiaId: 5, nombre: 'ACME', disponibles: 1, precioEntregaCliente: null, precioEntregaFlit: null,
        lts: [{ documentoId: D1, placa: 'ABC123', numeroLt: 'LT-1', idFlit: 'FLIT-1' }],
      },
      {
        companiaId: 7, nombre: 'Beta', disponibles: 1, precioEntregaCliente: 0, precioEntregaFlit: 0,
        lts: [{ documentoId: D2, placa: 'XYZ789', numeroLt: 'LT-2', idFlit: 'FLIT-2' }],
      },
    ]);
    expect(JSON.stringify(f.companiasCerrables)).not.toMatch(/vigenciaId/);
    expect(precioTrasladoDeMock).toHaveBeenCalledTimes(4);
    const ahora = precioTrasladoDeMock.mock.calls[0]![2];
    expect(ahora).toBeInstanceOf(Date);
    expect(precioTrasladoDeMock).toHaveBeenNthCalledWith(1, 5, 'cliente', ahora);
    expect(precioTrasladoDeMock).toHaveBeenNthCalledWith(2, 5, 'flit', ahora);
    expect(precioTrasladoDeMock).toHaveBeenNthCalledWith(3, 7, 'cliente', ahora);
    expect(precioTrasladoDeMock).toHaveBeenNthCalledWith(4, 7, 'flit', ahora);
  });

  it('LTs solo clasificado y agrupadas por esa compañía; disponibles === lts.length', async () => {
    conDocs([
      doc({ documentoId: D1, placa: 'ABC123', numeroLt: 'LT-1', idFlit: 'FLIT-1', companiaId: 5, nombre: 'ACME' }),
      doc({ documentoId: D2, placa: 'DEF456', numeroLt: 'LT-2', idFlit: 'FLIT-2', companiaId: 5, nombre: 'ACME' }),
      doc({ documentoId: D3, placa: 'GHI789', numeroLt: 'LT-3', idFlit: 'FLIT-3', companiaId: 7, nombre: 'Beta' }),
    ]);
    precioTrasladoDeMock.mockResolvedValue({ valor: 12000, vigenciaId: VIG });

    const f = await facetas(ALCANCE);
    const sql = aSql(whereCerrables);
    expect(sql.params).toContain('clasificado');
    expect(f.companiasCerrables).toHaveLength(2);
    const acme = f.companiasCerrables.find((c) => c.companiaId === 5)!;
    const beta = f.companiasCerrables.find((c) => c.companiaId === 7)!;
    expect(acme.lts.map((l) => l.documentoId)).toEqual([D1, D2]);
    expect(beta.lts.map((l) => l.documentoId)).toEqual([D3]);
    expect(acme.disponibles).toBe(acme.lts.length);
    expect(beta.disponibles).toBe(beta.lts.length);
    expect(acme.lts.every((l) => !('companiaId' in l))).toBe(true);
  });

  it('el DTO no expone vigenciaId', async () => {
    conDocs([doc()]);
    precioTrasladoDeMock.mockResolvedValue({ valor: 12000, vigenciaId: VIG });

    const f = await facetas(ALCANCE);
    expect(JSON.stringify(f.companiasCerrables)).not.toMatch(/vigenciaId/);
    expect(f.companiasCerrables[0]).toEqual({
      companiaId: 5, nombre: 'ACME', disponibles: 1, precioEntregaCliente: 12000, precioEntregaFlit: 12000,
      lts: [{ documentoId: D1, placa: 'ABC123', numeroLt: 'LT-1', idFlit: 'FLIT-1' }],
    });
    expect(Object.keys(f.companiasCerrables[0]!)).toEqual([
      'companiaId', 'nombre', 'disponibles', 'precioEntregaCliente', 'precioEntregaFlit', 'lts',
    ]);
  });
});
