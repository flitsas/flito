// HU #12541 — Migración 0191: catálogo de tipos de servicio adicional (tabla + índice único parcial
// plegado + siembra de 3 tipos + 4 funciones repartidas a admin y financiera). Análisis estático e
// idempotencia contra BD local si hay TEST_DATABASE_URL (P6).
//
// Se afirma «la anterior es 0190_» y NUNCA «la 0191 es la última»: congelar el tip pone rojo el CI
// del PR siguiente (memoria: test-de-migracion-no-exigir-es-la-ultima).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { funcionesDeSql, repartoDeSql, MIGRACIONES_CON_REPARTO } from '../helpers/permisos-seed-sql.js';
import { OPERACIONES_DECLARADAS } from '../../src/modules/permisos/catalogo-operaciones.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0191_servicios_adicionales_tipos.sql';
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const RUTA = path.join(DIR, ARCHIVO);
const SQL_0191 = readFileSync(RUTA, 'utf8');
const SIN_COMENTARIOS = SQL_0191.replace(/--[^\n]*/g, '');

const PLEGADO = "lower(translate(nombre, 'áéíóúÁÉÍÓÚñÑüÜ', 'aeiouAEIOUnNuU'))";
const FUNCIONES = [
  'parametrizacion.servicios_adicionales.crear',
  'parametrizacion.servicios_adicionales.dar_de_baja',
  'parametrizacion.servicios_adicionales.editar',
  'parametrizacion.servicios_adicionales.listar',
];

describe('0191 — análisis estático', () => {
  it('sin BEGIN/COMMIT del archivo; DO etiquetado; número único; la anterior es la 0190', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0191)).toEqual([]);
    expect(SQL_0191).toMatch(/DO \$resumen0191\$/);
    expect(SQL_0191).toMatch(/END \$resumen0191\$;/);
    const sqls = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    expect(sqls.filter((f) => f.startsWith('0191_'))).toEqual([ARCHIVO]);
    const anterior = sqls[sqls.indexOf(ARCHIVO) - 1]!;
    expect(anterior.startsWith('0190_')).toBe(true);
  });

  it('crea la tabla con las columnas del AC1, los tres CHECK y las tres FK a users ON DELETE RESTRICT', () => {
    expect(SIN_COMENTARIOS).toMatch(/CREATE TABLE IF NOT EXISTS flito_servicios_adicionales_tipos/);
    for (const col of [
      /id uuid PRIMARY KEY DEFAULT gen_random_uuid\(\)/, /nombre varchar\(120\) NOT NULL/, /descripcion text,/,
      /valor numeric\(14,2\) NOT NULL/, /activo boolean NOT NULL DEFAULT true/, /dado_de_baja_en timestamptz,/,
      /creado_en timestamptz NOT NULL DEFAULT now\(\)/, /actualizado_en timestamptz NOT NULL DEFAULT now\(\)/,
    ]) expect(SIN_COMENTARIOS).toMatch(col);
    for (const fk of ['dado_de_baja_por_id', 'creado_por_id', 'actualizado_por_id']) {
      expect(SIN_COMENTARIOS).toMatch(new RegExp(`${fk} integer REFERENCES users\\(id\\) ON DELETE RESTRICT`));
    }
    expect(SIN_COMENTARIOS.match(/ON DELETE RESTRICT/g)).toHaveLength(3);
    expect(SIN_COMENTARIOS).toMatch(/flito_serv_adic_tipos_valor_chk CHECK \(valor >= 0\)/);
    expect(SIN_COMENTARIOS).toMatch(/flito_serv_adic_tipos_nombre_chk CHECK \(btrim\(nombre\) <> ''\)/);
    expect(SIN_COMENTARIOS).toMatch(/flito_serv_adic_tipos_baja_chk CHECK \(activo = \(dado_de_baja_en IS NULL\)\)/);
  });

  it('índice único PARCIAL sobre el nombre plegado con translate() (nunca unaccent), y el mismo literal en el ON CONFLICT', () => {
    expect(SIN_COMENTARIOS).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_flito_serv_adic_tipos_nombre_activo/);
    expect(SIN_COMENTARIOS).not.toMatch(/unaccent/i);
    // Dos veces: el índice y el ON CONFLICT de la siembra; las dos con `WHERE activo`.
    expect(SIN_COMENTARIOS.split(PLEGADO)).toHaveLength(3);
    expect(SIN_COMENTARIOS).toMatch(new RegExp(`\\(${PLEGADO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)\\s*WHERE activo;`));
    expect(SIN_COMENTARIOS).toMatch(new RegExp(`ON CONFLICT \\(${PLEGADO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\) WHERE activo DO NOTHING;`));
  });

  it('siembra los tres predefinidos con valor 0, sin autor y sin marca especial (AC2)', () => {
    expect(SIN_COMENTARIOS).toMatch(/INSERT INTO flito_servicios_adicionales_tipos \(nombre, valor\) VALUES/);
    for (const nombre of ['Paz y salvo de impuestos', 'Diagnóstico', 'Derecho de petición']) {
      expect(SIN_COMENTARIOS).toContain(`('${nombre}', 0)`);
    }
    expect(SIN_COMENTARIOS.match(/', 0\)/g)).toHaveLength(3);
    expect(SIN_COMENTARIOS).not.toMatch(/predefinido|protegido|es_sistema/i);
  });

  it('siembra las cuatro funciones (parametrizacion, operacion) y las reparte a admin y financiera, a nadie más (AC3)', () => {
    const funciones = funcionesDeSql([SQL_0191]);
    expect([...funciones.keys()].sort()).toEqual(FUNCIONES);
    for (const f of funciones.values()) {
      expect(f.modulo).toBe('parametrizacion');
      expect(f.tipo).toBe('operacion');
      expect(f.nombre).not.toBe('');
      expect(f.descripcion).not.toBe('');
    }
    const reparto = repartoDeSql([SQL_0191]);
    expect([...reparto.keys()].sort()).toEqual(['admin', 'financiera']);
    expect([...reparto.get('admin')!].sort()).toEqual(FUNCIONES);
    expect([...reparto.get('financiera')!].sort()).toEqual(FUNCIONES);
  });

  it('los textos de negocio son byte a byte los del catálogo de operaciones', () => {
    const funciones = funcionesDeSql([SQL_0191]);
    for (const codigo of FUNCIONES) {
      const op = OPERACIONES_DECLARADAS.find((o) => o.codigo === codigo)!;
      expect(op, codigo).toBeDefined();
      expect(funciones.get(codigo)!.nombre).toBe(op.nombre);
      expect(funciones.get(codigo)!.descripcion).toBe(op.descripcion);
    }
  });

  it('el helper de paridad la lee (MIGRACIONES_CON_REPARTO)', () => {
    expect(MIGRACIONES_CON_REPARTO).toContain(ARCHIVO);
  });
});

const URL_BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL_BASE)('0191 — aplicar ×2 sobre BD ya migrada (P6)', () => {
  let sql: postgres.Sql;
  const ROLLBACK = Symbol('rollback');

  beforeAll(() => {
    sql = postgres(URL_BASE!, { max: 1, onnotice: () => {} });
  });
  afterAll(async () => { await sql?.end(); });

  async function enTx<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    let salida!: T;
    try {
      await sql.begin(async (tx) => { salida = await fn(tx); throw ROLLBACK; });
    } catch (e) { if (e !== ROLLBACK) throw e; }
    return salida;
  }

  it('segunda pasada no rompe ni duplica: 3 activos sembrados, 4 funciones, 8 repartos', async () => {
    await enTx(async (tx) => {
      await tx.unsafe(SQL_0191);
      await tx.unsafe(SQL_0191);
      const tipos = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM flito_servicios_adicionales_tipos
         WHERE activo AND nombre IN ('Paz y salvo de impuestos', 'Diagnóstico', 'Derecho de petición')`;
      expect(tipos[0]!.n).toBe(3);
      const funciones = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM permisos_funciones WHERE codigo LIKE 'parametrizacion.servicios_adicionales.%'`;
      expect(funciones[0]!.n).toBe(4);
      const reparto = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM permisos_rol_funcion WHERE funcion_codigo LIKE 'parametrizacion.servicios_adicionales.%'`;
      expect(reparto[0]!.n).toBe(8);
    });
  }, 60_000);

  it('el índice parcial rechaza un activo con el mismo nombre plegado y lo admite si el homónimo está de baja', async () => {
    await enTx(async (tx) => {
      await tx.unsafe(SQL_0191);
      await expect(tx`INSERT INTO flito_servicios_adicionales_tipos (nombre, valor) VALUES ('DIAGNOSTICO', 1)`)
        .rejects.toMatchObject({ code: '23505' });
    });
    await enTx(async (tx) => {
      await tx.unsafe(SQL_0191);
      await tx`UPDATE flito_servicios_adicionales_tipos SET activo = false, dado_de_baja_en = now() WHERE nombre = 'Diagnóstico'`;
      const [nuevo] = await tx<{ id: string }[]>`INSERT INTO flito_servicios_adicionales_tipos (nombre, valor) VALUES ('diagnostico', 1) RETURNING id`;
      expect(nuevo!.id).toBeTruthy();
    });
  }, 60_000);
});
