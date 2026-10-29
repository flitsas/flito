// HU #14122 — la 0285 siembra `logistica.actas.firmar_flit` (solo admin) y entra al pliegue del seed.
// Estática (siempre) + contra PostgreSQL solo con TEST_DATABASE_URL (en tx con ROLLBACK).
process.env.TZ = 'UTC';

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { abrirBase, enTx, leerMigracion, URL_BASE } from '../helpers/base-en-tx.js';
import { MIGRACIONES_ANTES_DEL_ARBOL, MIGRACIONES_CON_REPARTO } from '../helpers/permisos-seed-sql.js';

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));

const ARCHIVO = '0285_flito_logistica_permiso_firmar_flit.sql';
const SQL = leerMigracion(ARCHIVO);
const sinComentarios = (s: string) => s.replace(/--[^\n]*/g, '');
const CODIGO = 'logistica.actas.firmar_flit';

describe('0285 — reglas del archivo (estática)', () => {
  it('sin control de transacción propio y sin DDL', () => {
    expect(scanForTxControl(ARCHIVO, SQL)).toEqual([]);
    const s = sinComentarios(SQL);
    expect(s).not.toMatch(/\b(BEGIN|COMMIT|ALTER|CREATE)\b/i);
  });

  it('siembra la función como opcional de despachar_entregar_devolver, solo admin', () => {
    const s = sinComentarios(SQL);
    expect(s).toMatch(/'logistica\.actas\.firmar_flit'/);
    expect(s).toMatch(/'accion\.logistica\.despachar_entregar_devolver'/);
    expect(s).toMatch(/'admin',\s*'logistica\.actas\.firmar_flit'/);
    expect(s).not.toMatch(/'mensajero'/);
    expect(s).not.toMatch(/'operaciones'/);
  });

  it('el archivo está en el pliegue: reparto y mundo plano', () => {
    expect(MIGRACIONES_CON_REPARTO).toContain(ARCHIVO);
    expect(MIGRACIONES_ANTES_DEL_ARBOL).toContain(ARCHIVO);
  });
});

describe.skipIf(!URL_BASE)('0285 — contra la base real', () => {
  let sql: ReturnType<typeof abrirBase>;
  beforeAll(() => { sql = abrirBase(); });
  afterAll(async () => { await sql?.end(); });

  it('aplicar 0285 dos veces deja estable el count de la función y el reparto admin', async () => {
    await enTx(sql, async (tx) => {
      const contarFn = async () => {
        const [n] = await tx`SELECT count(*)::int AS n FROM permisos_funciones WHERE codigo = ${CODIGO}`;
        return n!.n as number;
      };
      const contarAdmin = async () => {
        const [n] = await tx`SELECT count(*)::int AS n FROM permisos_rol_funcion
          WHERE funcion_codigo = ${CODIGO} AND rol_codigo = 'admin'`;
        return n!.n as number;
      };
      const contarOtros = async () => {
        const [n] = await tx`SELECT count(*)::int AS n FROM permisos_rol_funcion
          WHERE funcion_codigo = ${CODIGO} AND rol_codigo <> 'admin'`;
        return n!.n as number;
      };
      await tx.unsafe(SQL);
      expect(await contarFn()).toBe(1);
      expect(await contarAdmin()).toBe(1);
      expect(await contarOtros()).toBe(0);
      await tx.unsafe(SQL);
      expect(await contarFn()).toBe(1);
      expect(await contarAdmin()).toBe(1);
      expect(await contarOtros()).toBe(0);
    });
  }, 60_000);
});
