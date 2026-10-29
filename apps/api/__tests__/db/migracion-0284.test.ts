// HU #14119 AC5 — la 0284 re-siembra los tres motivos y la función `logistica.motivos.gestionar`.
// Estática (siempre) + contra PostgreSQL solo con TEST_DATABASE_URL (en tx con ROLLBACK).
process.env.TZ = 'UTC';

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { abrirBase, enTx, leerMigracion, URL_BASE } from '../helpers/base-en-tx.js';

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));

const ARCHIVO = '0284_flito_logistica_motivos_permiso.sql';
const SQL = leerMigracion(ARCHIVO);
const sinComentarios = (s: string) => s.replace(/--[^\n]*/g, '');
const NOMBRES = [
  'Sin dirección de entrega al recoger',
  'Destino lejano (transportadora externa)',
  'Otro',
] as const;

describe('0284 — reglas del archivo (estática)', () => {
  it('sin control de transacción propio', () => {
    expect(scanForTxControl(ARCHIVO, SQL)).toEqual([]);
  });

  it('AC5: los tres literales con ON CONFLICT (lower(nombre)); no CREATE TABLE', () => {
    const s = sinComentarios(SQL);
    for (const n of NOMBRES) expect(SQL).toContain(`'${n}'`);
    expect(s).toMatch(/ON CONFLICT \(lower\(nombre\)\) DO NOTHING/);
    expect(s).not.toMatch(/CREATE TABLE/i);
    expect(s).not.toMatch(/\bprecio\b/i);
    expect(s).not.toMatch(/\bgu[ií]a\b/i);
  });

  it('siembra logistica.motivos.gestionar como opcional de ver_consola, solo admin', () => {
    const s = sinComentarios(SQL);
    expect(s).toMatch(/'logistica\.motivos\.gestionar'/);
    expect(s).toMatch(/'accion\.logistica\.ver_consola'/);
    expect(s).toMatch(/'admin',\s*'logistica\.motivos\.gestionar'/);
  });
});

describe.skipIf(!URL_BASE)('0284 — contra la base real', () => {
  let sql: ReturnType<typeof abrirBase>;
  beforeAll(() => { sql = abrirBase(); });
  afterAll(async () => { await sql?.end(); });

  it('AC5: aplicar 0284 dos veces deja estable el count de los tres nombres y de la función', async () => {
    await enTx(sql, async (tx) => {
      const contarNombres = async () => {
        const [n] = await tx`SELECT count(*)::int AS n FROM flito_logistica_motivos_llegada
          WHERE nombre IN ${tx(NOMBRES)}`;
        return n!.n as number;
      };
      const contarFn = async () => {
        const [n] = await tx`SELECT count(*)::int AS n FROM permisos_funciones
          WHERE codigo = 'logistica.motivos.gestionar'`;
        return n!.n as number;
      };
      await tx.unsafe(SQL);
      const nombres = await contarNombres();
      const fns = await contarFn();
      expect(nombres).toBe(3);
      expect(fns).toBe(1);
      await tx.unsafe(SQL);
      expect(await contarNombres()).toBe(nombres);
      expect(await contarFn()).toBe(fns);
    });
  }, 60_000);
});
