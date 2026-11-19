// Contrato `ia-consumo` v1 (ADR-0047) — la 0306 y el espejo Drizzle tienen EXACTAMENTE las columnas, tipos,
// nulabilidad y orden del DDL del contrato (`docs/contratos/ia-consumo.v1.md`), que comparte FLIT 2.0. Estática
// siempre; contra PostgreSQL solo con TEST_DATABASE_URL (en tx con ROLLBACK).
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { abrirBase, enTx, leerMigracion, URL_BASE } from '../helpers/base-en-tx.js';

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));

const { iaConsumoDetalle, iaConsumoLog, iaTarifaModelo } = await import('../../src/db/schema/ia-consumo.js');

const ARCHIVO = '0306_ia_consumo_log.sql';
const SQL = leerMigracion(ARCHIVO);
const CONTRATO = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../docs/contratos/ia-consumo.v1.md'), 'utf8',
);
const TABLAS = ['ia_consumo_log', 'ia_consumo_detalle', 'ia_tarifa_modelo'] as const;

interface Columna { nombre: string; tipo: string; nulable: boolean }

/** Columnas de un `CREATE TABLE` (sin comentarios ni restricciones de tabla), normalizadas. */
function columnas(ddl: string, tabla: string): Columna[] {
  const sinComentarios = ddl.replace(/--[^\n]*/g, '');
  const m = new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?${tabla} \\(([\\s\\S]*?)\\n\\);`).exec(sinComentarios);
  if (!m) throw new Error(`sin CREATE TABLE ${tabla}`);
  return m[1]!.split('\n').map((l) => l.trim().replace(/,$/, '')).filter((l) => l && !/^UNIQUE\b/.test(l)).map((l) => {
    const [nombre, ...resto] = l.split(/\s+/);
    const def = resto.join(' ').replace(/\s+/g, ' ');
    const tipo = /^(numeric\(\d+,\d+\)|[a-z]+)/.exec(def)![1]!;
    return { nombre: nombre!, tipo, nulable: !/NOT NULL|PRIMARY KEY/.test(def) };
  });
}

const indices = (ddl: string) => [...ddl.replace(/--[^\n]*/g, '').matchAll(/CREATE INDEX (?:IF NOT EXISTS )?(\w+)\s+ON (\w+) (\([^)]*\))(?: WHERE ([^;]+))?;/g)]
  .map((m) => `${m[1]}|${m[2]}|${m[3]!.replace(/\s+/g, '')}|${(m[4] ?? '').trim()}`);

describe('0306 — conformidad con el contrato ia-consumo v1 (estática)', () => {
  it('sin control de transacción propio', () => {
    expect(scanForTxControl(ARCHIVO, SQL)).toEqual([]);
  });

  it.each(TABLAS)('%s: mismas columnas, tipos, nulabilidad y orden que el DDL del contrato', (tabla) => {
    expect(columnas(SQL, tabla)).toEqual(columnas(CONTRATO, tabla));
  });

  it('mismos índices que el contrato (nombre, columnas y filtro)', () => {
    expect(indices(SQL)).toEqual(indices(CONTRATO));
    expect(indices(SQL)).toHaveLength(6);
  });

  it('el espejo Drizzle declara las mismas columnas en el mismo orden', () => {
    for (const [tabla, t] of [['ia_consumo_log', iaConsumoLog], ['ia_consumo_detalle', iaConsumoDetalle], ['ia_tarifa_modelo', iaTarifaModelo]] as const) {
      const cfg = getTableConfig(t);
      expect(cfg.name).toBe(tabla);
      expect(cfg.columns.map((c) => [c.name, !c.notNull && !c.primary])).toEqual(columnas(SQL, tabla).map((c) => [c.nombre, c.nulable]));
    }
  });

  it('semilla: solo Anthropic, idempotente, modelos sin sufijo de fecha', () => {
    const valores = [...SQL.matchAll(/\('(\w+)', '([\w.-]+)',\s+DATE '(\d{4}-\d{2}-\d{2})'/g)].map((m) => [m[1], m[2]]);
    expect(valores.length).toBeGreaterThan(0);
    for (const [proveedor, modelo] of valores) {
      expect(proveedor).toBe('anthropic');
      expect(modelo).not.toMatch(/-\d{8}$/);
    }
    expect(valores.map((v) => v[1])).toEqual(expect.arrayContaining(['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-haiku-5-5']));
    expect(SQL).toMatch(/ON CONFLICT \(proveedor, modelo, vigente_desde\) DO NOTHING/);
  });
});

describe.skipIf(!URL_BASE)('0306 — contra la base real', () => {
  let sql: ReturnType<typeof abrirBase>;
  beforeAll(() => { sql = abrirBase(); });
  afterAll(async () => { await sql?.end(); });

  it('aplicar dos veces deja las tres tablas y la semilla una sola vez; el detalle cae en cascada', async () => {
    await enTx(sql, async (tx) => {
      await tx.unsafe(SQL);
      await tx.unsafe(SQL);
      const [n] = await tx`SELECT count(*)::int AS n FROM ia_tarifa_modelo WHERE proveedor = 'anthropic'`;
      expect(n!.n).toBe(5);
      const id = '018f0000-0000-7000-8000-000000000001';
      await tx`INSERT INTO ia_consumo_log (id, correlacion_id, fecha_inicio, fecha_fin, latencia_ms, aplicativo, servicio, ambiente,
        origen, modulo, proceso, tipo_tarea, proveedor, resultado)
        VALUES (${id}, ${id}, now(), now(), 1, 'flito', 'api', 'local', 'job', 'm', 'p', 'ocr', 'anthropic', 'exito')`;
      await tx`INSERT INTO ia_consumo_detalle (consumo_id, fecha_inicio, prompt_texto) VALUES (${id}, now(), 'x')`;
      await tx`DELETE FROM ia_consumo_log WHERE id = ${id}`;
      const [d] = await tx`SELECT count(*)::int AS n FROM ia_consumo_detalle WHERE consumo_id = ${id}`;
      expect(d!.n).toBe(0);
    });
  });
});
