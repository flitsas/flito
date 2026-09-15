// HU #12545 — Migración 0193: la puente `flito_tramite_servicios_adicionales` (snapshot del tipo por
// trámite, UNIQUE (tramite_id, tipo_id), índice por trámite, CHECK valor >= 0, FKs con cláusula
// explícita) + 3 funciones `finanzas.servicios_adicionales.*` repartidas: `ver` a admin, financiera
// y auditor; `asignar`/`quitar` a admin y financiera. Calco de migracion-0191/0192.test.ts.
//
// Se afirma «la anterior es 0192_» y NUNCA «la 0193 es la última»: congelar el tip pone rojo el CI
// del PR siguiente (memoria: test-de-migracion-no-exigir-es-la-ultima). Mutantes nombrados:
//   · M-01a — cambiar `ON DELETE RESTRICT` del tipo por CASCADE: cae el aserto de FK.
//   · M-02a — quitar `('financiera', 'finanzas.servicios_adicionales.quitar')`: cae «financiera tiene
//     las tres» y la paridad plegada de migracion-0179.test.ts.
//   · M-02b — añadir `('auditor', 'finanzas.servicios_adicionales.asignar')`: cae «auditor solo ve».
//   · Quitar el UNIQUE del SQL: cae el aserto de la constraint (y, contra base, el 23505 del P6).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import {
  MIGRACIONES_CON_REPARTO, funcionesDeSql, leerRepartoSembrado, leerRetirosSembrados, repartoDeSql,
} from '../helpers/permisos-seed-sql.js';
import { OPERACIONES_DECLARADAS } from '../../src/modules/permisos/catalogo-operaciones.js';
import { catalogoCompleto } from '../../src/modules/permisos/catalogo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0193_tramite_servicios_adicionales.sql';
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const RUTA = path.join(DIR, ARCHIVO);
const SQL_0193 = readFileSync(RUTA, 'utf8');
const SIN_COMENTARIOS = SQL_0193.replace(/--[^\n]*/g, '');

const VER = 'finanzas.servicios_adicionales.ver';
const ASIGNAR = 'finanzas.servicios_adicionales.asignar';
const QUITAR = 'finanzas.servicios_adicionales.quitar';
const FUNCIONES = [ASIGNAR, QUITAR, VER];

describe('0193 — análisis estático', () => {
  it('sin BEGIN/COMMIT del archivo; DO etiquetado; sin `$` en comentarios; número único; la anterior es la 0192', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0193)).toEqual([]);
    expect(SQL_0193).toMatch(/DO \$resumen0193\$/);
    expect(SQL_0193).toMatch(/END \$resumen0193\$;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
    expect(SQL_0193.match(/--[^\n]*\$/g)).toBeNull();
    const sqls = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0193_'))).toEqual([ARCHIVO]);
    // No exige «es la última»: la convención pide max+1 EN SU MOMENTO.
    expect(sqls[sqls.indexOf(ARCHIVO) - 1]).toBe('0192_pagina_flito_servicios_adicionales.sql');
  });

  it('la cabecera cumple la convención del README: archivo, motivo (Feature/HU) y autor', () => {
    const cabecera = SQL_0193.split('\n').slice(0, 12).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/Feature #12544/);
    expect(cabecera).toMatch(/HU #12545/);
  });

  it('crea la puente con las columnas del AC1: FKs con cláusula explícita (CASCADE al trámite, RESTRICT al tipo y a users), CHECK y snapshot (M-01a)', () => {
    expect(SIN_COMENTARIOS).toMatch(/CREATE TABLE IF NOT EXISTS flito_tramite_servicios_adicionales \(/);
    for (const col of [
      /id uuid PRIMARY KEY DEFAULT gen_random_uuid\(\)/,
      /tramite_id uuid NOT NULL REFERENCES flito_tramites\(id\) ON DELETE CASCADE/,
      /tipo_id uuid NOT NULL REFERENCES flito_servicios_adicionales_tipos\(id\) ON DELETE RESTRICT/,
      /nombre varchar\(120\) NOT NULL/, /descripcion text,/, /valor numeric\(14,2\) NOT NULL/,
      // users.id es integer (0191 y schema.ts): un uuid aquí reventaría el db:apply.
      /asignado_por_id integer REFERENCES users\(id\) ON DELETE RESTRICT/,
      /asignado_en timestamptz NOT NULL DEFAULT now\(\)/,
    ]) expect(SIN_COMENTARIOS).toMatch(col);
    expect(SIN_COMENTARIOS.match(/ON DELETE RESTRICT/g)).toHaveLength(2);
    expect(SIN_COMENTARIOS.match(/ON DELETE CASCADE/g)).toHaveLength(1);
    expect(SIN_COMENTARIOS).toMatch(/CONSTRAINT flito_tramite_serv_adic_valor_chk CHECK \(valor >= 0\)/);
    // Sin `activo`, sin fecha de baja: la puente se borra físicamente, no se da de baja (CF-04).
    expect(SIN_COMENTARIOS).not.toMatch(/activo boolean|dado_de_baja/);
  });

  it('UNIQUE (tramite_id, tipo_id) como CONSTRAINT (el 23505 que el servicio traduce a 409) y un índice por tramite_id; sin unaccent', () => {
    expect(SIN_COMENTARIOS).toMatch(/CONSTRAINT flito_tramite_serv_adic_tramite_tipo_uq UNIQUE \(tramite_id, tipo_id\)/);
    expect(SIN_COMENTARIOS).toMatch(/CREATE INDEX IF NOT EXISTS idx_flito_tramite_serv_adic_tramite\s+ON flito_tramite_servicios_adicionales \(tramite_id\);/);
    expect(SIN_COMENTARIOS).not.toMatch(/unaccent/i);
    expect(SQL_0193).toMatch(/COMMENT ON COLUMN flito_tramite_servicios_adicionales\.valor IS 'Snapshot del valor del tipo al asignar; nunca se relee del catálogo\.'/);
  });

  it('siembra exactamente las tres funciones (finanzas, operacion) con los textos byte a byte del catálogo de operaciones', () => {
    expect(SIN_COMENTARIOS.match(/INSERT INTO permisos_/g)).toHaveLength(2);
    expect(SIN_COMENTARIOS).toMatch(/ON CONFLICT \(codigo\) DO NOTHING;/);
    expect(SIN_COMENTARIOS).toMatch(/ON CONFLICT \(rol_codigo, funcion_codigo\) DO NOTHING;/);
    expect(SIN_COMENTARIOS).not.toMatch(/DO UPDATE/);
    const funciones = funcionesDeSql([SQL_0193]);
    expect([...funciones.keys()].sort()).toEqual(FUNCIONES);
    for (const codigo of FUNCIONES) {
      const op = OPERACIONES_DECLARADAS.find((o) => o.codigo === codigo);
      expect(op, codigo).toBeDefined();
      // La llave es la guarda REAL: fichero del módulo nuevo, no `finanzas/finanzas.routes.ts` (ADR-0017).
      expect(op!.llave.startsWith('finanzas-servicios-adicionales/finanzas-servicios-adicionales.routes.ts ')).toBe(true);
      const f = funciones.get(codigo)!;
      expect(f.modulo).toBe('finanzas');
      expect(f.tipo).toBe('operacion');
      expect(f.nombre).toBe(op!.nombre);
      expect(f.descripcion).toBe(op!.descripcion);
    }
  });

  it('reparte `ver` a admin, financiera y auditor; `asignar` y `quitar` solo a admin y financiera (M-02a, M-02b)', () => {
    const reparto = repartoDeSql([SQL_0193]);
    expect([...reparto.keys()].sort()).toEqual(['admin', 'auditor', 'financiera']);
    expect([...reparto.get('admin')!].sort()).toEqual(FUNCIONES);
    expect([...reparto.get('financiera')!].sort()).toEqual(FUNCIONES);
    expect([...reparto.get('auditor')!]).toEqual([VER]);
    // Y el catálogo del código dice lo mismo (paridad con inventario.generado.ts).
    const catalogo = catalogoCompleto().filter((c) => c.codigo.startsWith('finanzas.servicios_adicionales.'));
    expect(catalogo.map((c) => c.codigo).sort()).toEqual(FUNCIONES);
    expect(catalogo.find((c) => c.codigo === VER)!.roles).toEqual(['admin', 'auditor', 'financiera']);
    expect(catalogo.find((c) => c.codigo === ASIGNAR)!.roles).toEqual(['admin', 'financiera']);
    expect(catalogo.find((c) => c.codigo === QUITAR)!.roles).toEqual(['admin', 'financiera']);
  });

  it('no retira nada y el helper de paridad la lee justo después de la 0192; plegado, auditor sigue sin escribir', () => {
    const retiros = leerRetirosSembrados([ARCHIVO]);
    expect(retiros.funciones.size).toBe(0);
    expect(retiros.reparto.size).toBe(0);
    expect(MIGRACIONES_CON_REPARTO.indexOf(ARCHIVO)).toBe(MIGRACIONES_CON_REPARTO.indexOf('0192_pagina_flito_servicios_adicionales.sql') + 1);
    const total = leerRepartoSembrado();
    for (const rol of ['admin', 'financiera']) for (const f of FUNCIONES) expect(total.get(rol)!.has(f), `${rol} ${f}`).toBe(true);
    expect(total.get('auditor')!.has(VER)).toBe(true);
    expect(total.get('auditor')!.has(ASIGNAR)).toBe(false);
    expect(total.get('auditor')!.has(QUITAR)).toBe(false);
  });

  it('el resumen final revienta si la tabla, las funciones o el reparto quedaron inconsistentes', () => {
    expect(SIN_COMENTARIOS).toMatch(/IF n_tabla <> 1 OR n_funcion <> 3 OR n_reparto <> 7 THEN\s*RAISE EXCEPTION/);
  });
});

const URL_BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL_BASE)('0193 — aplicar ×2 sobre BD ya migrada (P6)', () => {
  let sql: postgres.Sql;
  const ROLLBACK = Symbol('rollback');

  beforeAll(() => { sql = postgres(URL_BASE!, { max: 1, onnotice: () => {} }); });
  afterAll(async () => { await sql?.end(); });

  async function enTx<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    let salida!: T;
    try {
      await sql.begin(async (tx) => { salida = await fn(tx); throw ROLLBACK; });
    } catch (e) { if (e !== ROLLBACK) throw e; }
    return salida;
  }

  it('segunda pasada no rompe ni duplica: 1 tabla, 3 funciones, 7 repartos', async () => {
    await enTx(async (tx) => {
      await tx.unsafe(SQL_0193);
      await tx.unsafe(SQL_0193);
      const [tabla] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'flito_tramite_servicios_adicionales'`;
      expect(tabla!.n).toBe(1);
      const [funciones] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM permisos_funciones WHERE codigo LIKE 'finanzas.servicios_adicionales.%'`;
      expect(funciones!.n).toBe(3);
      const [reparto] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM permisos_rol_funcion WHERE funcion_codigo LIKE 'finanzas.servicios_adicionales.%'`;
      expect(reparto!.n).toBe(7);
    });
  }, 60_000);

  it('el UNIQUE rechaza el mismo tipo dos veces (23505), el CHECK el valor negativo (23514) y la FK un tipo inexistente (23503)', async () => {
    await enTx(async (tx) => {
      await tx.unsafe(SQL_0193);
      const [tramite] = await tx<{ id: string }[]>`SELECT id FROM flito_tramites LIMIT 1`;
      const [tipo] = await tx<{ id: string }[]>`SELECT id FROM flito_servicios_adicionales_tipos WHERE activo LIMIT 1`;
      if (!tramite || !tipo) return; // base sin trámites: el control positivo no se puede montar
      const fila = (valor: number, tipoId = tipo.id) => tx`
        INSERT INTO flito_tramite_servicios_adicionales (tramite_id, tipo_id, nombre, valor)
        VALUES (${tramite.id}, ${tipoId}, 'Diagnóstico', ${valor})`;
      await fila(85000);
      await expect(fila(85000)).rejects.toMatchObject({ code: '23505', constraint_name: 'flito_tramite_serv_adic_tramite_tipo_uq' });
    });
    await enTx(async (tx) => {
      await tx.unsafe(SQL_0193);
      const [tramite] = await tx<{ id: string }[]>`SELECT id FROM flito_tramites LIMIT 1`;
      const [tipo] = await tx<{ id: string }[]>`SELECT id FROM flito_servicios_adicionales_tipos WHERE activo LIMIT 1`;
      if (!tramite || !tipo) return;
      await expect(tx`
        INSERT INTO flito_tramite_servicios_adicionales (tramite_id, tipo_id, nombre, valor)
        VALUES (${tramite.id}, ${tipo.id}, 'Diagnóstico', -1)`).rejects.toMatchObject({ code: '23514' });
    });
    await enTx(async (tx) => {
      await tx.unsafe(SQL_0193);
      const [tramite] = await tx<{ id: string }[]>`SELECT id FROM flito_tramites LIMIT 1`;
      if (!tramite) return;
      await expect(tx`
        INSERT INTO flito_tramite_servicios_adicionales (tramite_id, tipo_id, nombre, valor)
        VALUES (${tramite.id}, gen_random_uuid(), 'Diagnóstico', 1)`).rejects.toMatchObject({ code: '23503' });
    });
  }, 60_000);
});
