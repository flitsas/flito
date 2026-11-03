// Fix: `documentos.motivo` no se arrastra a estados posteriores; el evento conserva su motivo.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));

const { transicionar } = await import('../../src/modules/flito-logistica/flito-logistica.base.js');

const ctx = { userId: 1, username: 'op', role: 'admin', operaAjenas: true };
let sets: Record<string, unknown>[];
let eventos: Record<string, unknown>[];
const exec = {
  insert: () => ({ values: (v: Record<string, unknown>) => { eventos.push(v); return Promise.resolve([]); } }),
  update: () => ({ set: (v: Record<string, unknown>) => { sets.push(v); return { where: () => Promise.resolve([]) }; } }),
};
const run = (estado: string, nuevo: string, opts = {}) =>
  transicionar(exec as never, { id: 'd1', estado }, nuevo as never, ctx, opts);

beforeEach(() => { sets = []; eventos = []; });

describe('transicionar: motivo del documento', () => {
  it('una transición sin motivo lo deja en NULL (limpia el previo)', async () => {
    await run('en_flit', 'entregado');
    expect(sets[0]).toHaveProperty('motivo', null);
  });

  it('una transición con motivo lo reemplaza y el evento lo conserva', async () => {
    await run('recogido', 'novedad', { motivo: 'rota' });
    expect(sets[0]).toMatchObject({ estado: 'novedad', motivo: 'rota' });
    expect(eventos[0]).toMatchObject({ motivo: 'rota' });
  });

  it('anulación conserva su motivo y la entrega posterior lo limpia (evento de anulación intacto)', async () => {
    await run('despachado', 'en_flit', { tipo: 'anulacion', motivo: 'Viaje registrado por error' });
    expect(sets[0]).toMatchObject({ motivo: 'Viaje registrado por error' });
    await run('en_flit', 'entregado');
    expect(sets[1]).toHaveProperty('motivo', null);
    expect(eventos[0]).toMatchObject({ motivo: 'Viaje registrado por error' });
    expect(eventos[1]).toMatchObject({ motivo: null });
  });
});
