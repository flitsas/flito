// HU #13237 (Feature #13236, Épica #12736) — Migración 0217: tabla `flito_sync_interruptor` (flit1 y
// flit2 sembradas encendidas) y la función `tramites.sincronizacion.configurar`, sembrada SOLO a admin.
// Calco de migracion-0214.test.ts.
//
// Se afirma «la anterior es 0216_» y NUNCA «la 0217 es la última» (memoria:
// test-de-migracion-no-exigir-es-la-ultima): una migración posterior no debe poner este test en rojo.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import {
  MIGRACIONES_CON_REPARTO, funcionesDeSql, leerRepartoSembrado, leerRetirosSembrados, repartoDeSql,
} from '../helpers/permisos-seed-sql.js';
import { OPERACIONES_DECLARADAS } from '../../src/modules/permisos/catalogo-operaciones.js';
import { GUARDAS_MEDIDAS } from '../../src/modules/permisos/inventario.generado.js';
import { llaveDe } from '../../src/modules/permisos/inventario-guardas.js';
import { catalogoCompleto, repartoDePartida } from '../../src/modules/permisos/catalogo.js';
import { flitoSyncInterruptor } from '../../src/db/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0217_sync_interruptor_fuente.sql';
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const SQL_0217 = readFileSync(path.join(DIR, ARCHIVO), 'utf8');
const SIN_COMENTARIOS = SQL_0217.replace(/--[^\n]*/g, '');
const SQLS = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();

const CONFIGURAR = 'tramites.sincronizacion.configurar';
const LLAVE = 'flito-sync/flito-sync-interruptores.routes.ts PUT /interruptores/:fuente';

describe('0217 — análisis estático', () => {
  it('sin BEGIN/COMMIT; DO etiquetado; sin `$$` sin etiqueta; sin unaccent(); número único', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0217)).toEqual([]);
    expect(SQL_0217).toMatch(/DO \$resumen0217\$/);
    expect(SQL_0217).toMatch(/END \$resumen0217\$;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
    expect(SIN_COMENTARIOS).not.toMatch(/unaccent/i);
    expect(SQLS.filter((f) => f.startsWith('0217_'))).toEqual([ARCHIVO]);
  });

  it('la anterior es la 0216_ (PII enmascarada de FLIT 2); nunca «es la última»', () => {
    expect(SQLS[SQLS.indexOf(ARCHIVO) - 1]).toMatch(/^0216_/);
  });

  it('la cabecera cumple la convención del README: archivo, motivo (HU/Feature) y autor', () => {
    const cabecera = SQL_0217.split('\n').slice(0, 12).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/HU #13237/);
    expect(cabecera).toMatch(/Feature #13236/);
  });

  it('crea la tabla del diseño: fuente PK con CHECK flit1/flit2, encendido NOT NULL DEFAULT true, quién con FK a users', () => {
    expect(SIN_COMENTARIOS).toMatch(/CREATE TABLE IF NOT EXISTS flito_sync_interruptor \(/);
    expect(SIN_COMENTARIOS).toMatch(/\n\s+fuente\s+varchar\(10\) PRIMARY KEY,/);
    expect(SIN_COMENTARIOS).toMatch(/\n\s+encendido\s+boolean NOT NULL DEFAULT true,/);
    expect(SIN_COMENTARIOS).toMatch(/\n\s+updated_at\s+timestamptz NULL,/);
    expect(SIN_COMENTARIOS).toMatch(/\n\s+updated_by\s+integer NULL REFERENCES users\(id\),/);
    expect(SIN_COMENTARIOS).toMatch(/CONSTRAINT ck_flito_sync_interruptor_fuente CHECK \(fuente IN \('flit1', 'flit2'\)\)/);
  });

  it('el esquema Drizzle declara las mismas columnas y el CHECK', () => {
    const cfg = getTableConfig(flitoSyncInterruptor);
    expect(cfg.name).toBe('flito_sync_interruptor');
    expect(cfg.columns.map((c) => c.name).sort()).toEqual(['encendido', 'fuente', 'updated_at', 'updated_by']);
    expect(cfg.columns.find((c) => c.name === 'fuente')!.primary).toBe(true);
    expect(cfg.columns.find((c) => c.name === 'encendido')!.notNull).toBe(true);
    expect(cfg.checks.map((c) => c.name)).toEqual(['ck_flito_sync_interruptor_fuente']);
    expect(cfg.foreignKeys).toHaveLength(1);
  });

  it('siembra las dos fuentes encendidas con ON CONFLICT DO NOTHING (la 2a pasada no re-enciende)', () => {
    expect(SIN_COMENTARIOS).toMatch(
      /INSERT INTO flito_sync_interruptor \(fuente\) VALUES\s*\('flit1'\),\s*\('flit2'\)\s*ON CONFLICT \(fuente\) DO NOTHING;/,
    );
  });

  it('siembra UNA operación del módulo tramites con los textos byte a byte del catálogo', () => {
    const funciones = funcionesDeSql([SQL_0217]);
    expect([...funciones.keys()]).toEqual([CONFIGURAR]);
    const op = OPERACIONES_DECLARADAS.find((o) => o.codigo === CONFIGURAR);
    expect(op).toBeDefined();
    expect(op!.llave).toBe(LLAVE);
    expect(funciones.get(CONFIGURAR)).toEqual({
      codigo: CONFIGURAR, modulo: 'tramites', nombre: op!.nombre, descripcion: op!.descripcion, tipo: 'operacion',
    });
    expect(funciones.get(CONFIGURAR)!.nombre).toBe('Configurar la sincronización con FLIT');
    const f = catalogoCompleto().find((c) => c.codigo === CONFIGURAR)!;
    expect(f.modulo).toBe('tramites');
    expect(f.tipo).toBe('operacion');
  });

  it('la foto la lleva como guarda de ruta con roles de partida = solo admin', () => {
    const g = GUARDAS_MEDIDAS.find((x) => llaveDe(x) === LLAVE);
    expect(g).toBeDefined();
    expect(g!.heredada).toBe(false);
    expect([...g!.roles]).toEqual(['admin']);
    expect(repartoDePartida().filter(([, c]) => c === CONFIGURAR).map(([r]) => r)).toEqual(['admin']);
  });

  it('reparto: SOLO admin; nadie más la recibe', () => {
    const r = repartoDeSql([SQL_0217]);
    expect([...r.keys()]).toEqual(['admin']);
    expect([...r.get('admin')!]).toEqual([CONFIGURAR]);
    const total = leerRepartoSembrado();
    expect([...total.entries()].filter(([, fs]) => fs.has(CONFIGURAR)).map(([rol]) => rol)).toEqual(['admin']);
  });

  it('no retira nada y el helper de paridad la lee después de la 0214', () => {
    const retiros = leerRetirosSembrados([ARCHIVO]);
    expect(retiros.funciones.size).toBe(0);
    expect(retiros.reparto.size).toBe(0);
    expect(MIGRACIONES_CON_REPARTO.indexOf(ARCHIVO))
      .toBeGreaterThan(MIGRACIONES_CON_REPARTO.indexOf('0214_flit2_acceso.sql'));
  });

  it('idempotente y con resumen que revienta si no cuadra; por código exacto, nunca por prefijo', () => {
    expect(SIN_COMENTARIOS).toMatch(/ON CONFLICT \(codigo\) DO NOTHING/);
    expect(SIN_COMENTARIOS.match(/ON CONFLICT \(rol_codigo, funcion_codigo\) DO NOTHING/g)).toHaveLength(1);
    expect(SIN_COMENTARIOS).not.toMatch(/DO UPDATE/);
    expect(SIN_COMENTARIOS).not.toMatch(/\bDELETE\b|\bDROP\b|\bALTER\b|\bUPDATE\b/);
    expect(SIN_COMENTARIOS).toMatch(/IF n_fuentes <> 2 OR n_ops <> 1 OR n_reparto <> 1 THEN\s*RAISE EXCEPTION/);
    expect(SIN_COMENTARIOS).not.toMatch(/LIKE 'tramites\.%'/);
  });
});

const URL_BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL_BASE)('0217 — aplicar ×2 sobre BD ya migrada (P6)', () => {
  let sql: postgres.Sql;
  const ROLLBACK = Symbol('rollback');

  beforeAll(() => { sql = postgres(URL_BASE!, { max: 1, onnotice: () => {} }); });
  afterAll(async () => { await sql?.end(); });

  it('la segunda pasada no duplica ni re-enciende lo apagado; solo admin tiene la función', async () => {
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(SQL_0217);
        await tx`UPDATE flito_sync_interruptor SET encendido = false WHERE fuente = 'flit2'`;
        await tx.unsafe(SQL_0217);
        const filas = await tx<{ fuente: string; encendido: boolean }[]>`SELECT fuente, encendido FROM flito_sync_interruptor ORDER BY fuente`;
        expect(filas).toEqual([{ fuente: 'flit1', encendido: true }, { fuente: 'flit2', encendido: false }]);
        const roles = await tx<{ rol_codigo: string }[]>`SELECT rol_codigo FROM permisos_rol_funcion WHERE funcion_codigo = ${CONFIGURAR}`;
        expect(roles.map((r) => r.rol_codigo)).toContain('admin');
        await expect(tx.savepoint((sp) => sp`INSERT INTO flito_sync_interruptor (fuente) VALUES ('flit3')`))
          .rejects.toMatchObject({ code: '23514' });
        throw ROLLBACK;
      });
    } catch (e) { if (e !== ROLLBACK) throw e; }
  }, 60_000);
});
