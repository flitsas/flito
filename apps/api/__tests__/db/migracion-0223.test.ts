// HU #13364 (Feature #13361, Épica #13201) — 0223: índice único parcial
// `uq_flito_soportes_adicional_soat_hash` y las funciones `soat.documentos_adicionales.cargar` /
// `.eliminar`, repartidas a operación FLIT (`admin`) y proveedor SOAT (`proveedor`), NUNCA al `cliente` (TC-49).
//
// La parte con BD (TEST_DATABASE_URL) ejercita además el `ON CONFLICT (soat_id, hash) WHERE …` REAL de
// `insertarAdicionalesDeCarga`: el mock `chain` no lo verifica, y si el predicado no coincide con el del
// índice Postgres responde 42P10.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql as dsql } from 'drizzle-orm';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { MIGRACIONES_CON_REPARTO, funcionesDeSql, leerRepartoSembrado } from '../helpers/permisos-seed-sql.js';
import { OPERACIONES_DECLARADAS } from '../../src/modules/permisos/catalogo-operaciones.js';
import { GUARDAS_MEDIDAS } from '../../src/modules/permisos/inventario.generado.js';
import { llaveDe } from '../../src/modules/permisos/inventario-guardas.js';
import { catalogoCompleto } from '../../src/modules/permisos/catalogo.js';
import * as schema from '../../src/db/schema.js';
import { insertarAdicionalesDeCarga } from '../../src/modules/flito-soat/flito-soat-documentos.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0223_flito_soportes_documentos_adicionales_carga_eliminar.sql';
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const SQL_0223 = readFileSync(path.join(DIR, ARCHIVO), 'utf8');
const SIN_COMENTARIOS = SQL_0223.replace(/--[^\n]*/g, '');
const RUTAS = 'flito-soat/flito-soat-documentos.routes.ts';
const FUNCIONES = [
  { codigo: 'soat.documentos_adicionales.cargar', llave: `${RUTAS} POST /:id/documentos-adicionales` },
  { codigo: 'soat.documentos_adicionales.eliminar', llave: `${RUTAS} DELETE /:id/documentos-adicionales/:soporteId` },
];
const ROLES = ['admin', 'proveedor'];
const PREDICADO = "tipo = 'documento_adicional_soat' AND descartado = false AND soat_id IS NOT NULL";

describe('0223 — análisis estático', () => {
  it('sin BEGIN/COMMIT; DO etiquetados; sin `$$` sin etiqueta; número único; la anterior es la 0222_', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0223)).toEqual([]);
    expect(SQL_0223).toMatch(/DO \$dup0223\$/);
    expect(SQL_0223).toMatch(/DO \$resumen0223\$/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
    const sqls = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0223_'))).toEqual([ARCHIVO]);
    expect(sqls[sqls.indexOf(ARCHIVO) - 1]).toMatch(/^0222_/);
    expect(SQL_0223.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(SQL_0223).toMatch(/^-- Autor: /m);
  });

  it('guarda de duplicados ANTES del índice; índice único parcial idempotente con el predicado de la carga', () => {
    const guarda = SIN_COMENTARIOS.indexOf('$dup0223$');
    const indice = SIN_COMENTARIOS.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_soportes_adicional_soat_hash');
    expect(guarda).toBeGreaterThan(-1);
    expect(indice).toBeGreaterThan(guarda);
    expect(SIN_COMENTARIOS).toMatch(/HAVING count\(\*\) > 1/);
    expect(SIN_COMENTARIOS).toMatch(/IF n_dup > 0 THEN\s*RAISE EXCEPTION/);
    expect(SIN_COMENTARIOS.replace(/\s+/g, ' ')).toContain(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_soportes_adicional_soat_hash ON flito_soportes (soat_id, hash) WHERE ${PREDICADO};`,
    );
    expect(SIN_COMENTARIOS).not.toMatch(/DROP|DELETE|ALTER TABLE/);
  });

  it('siembra las dos funciones con los textos byte a byte del catálogo, en su router', () => {
    const funciones = funcionesDeSql([SQL_0223]);
    expect([...funciones.keys()].sort()).toEqual(FUNCIONES.map((f) => f.codigo).sort());
    for (const { codigo, llave } of FUNCIONES) {
      const op = OPERACIONES_DECLARADAS.find((o) => o.codigo === codigo)!;
      expect(op.llave).toBe(llave);
      const f = catalogoCompleto().find((c) => c.codigo === codigo)!;
      expect(funciones.get(codigo)).toEqual({
        codigo, modulo: f.modulo, nombre: op.nombre, descripcion: op.descripcion, tipo: 'operacion',
      });
    }
  });

  it('reparto: admin y proveedor; el cliente NO (foto, SQL y plegado de todas las migraciones)', () => {
    expect(MIGRACIONES_CON_REPARTO).toContain(ARCHIVO);
    const total = leerRepartoSembrado();
    for (const { codigo, llave } of FUNCIONES) {
      const g = GUARDAS_MEDIDAS.find((x) => llaveDe(x) === llave)!;
      expect([...g.roles].sort(), llave).toEqual(ROLES);
      for (const rol of ROLES) expect(total.get(rol)!.has(codigo), `${rol} ${codigo}`).toBe(true);
      expect(total.get('cliente')?.has(codigo) ?? false, codigo).toBe(false);
    }
    expect(SIN_COMENTARIOS).toMatch(/IF n_ops <> 2 OR n_reparto <> 4 OR n_cliente <> 0 OR n_idx <> 1 THEN\s*RAISE EXCEPTION/);
  });
});

const URL_BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL_BASE)('0223 — aplicar ×2 sobre BD ya migrada (P6) y ON CONFLICT real', () => {
  let sql: postgres.Sql;
  const ROLLBACK = Symbol('rollback');
  beforeAll(() => { sql = postgres(URL_BASE!, { max: 1, onnotice: () => {} }); });
  afterAll(async () => { await sql?.end(); });

  it('dos pasadas; índice con su predicado; reparto sin cliente; insertarAdicionalesDeCarga respeta el índice', async () => {
    // Una sola transacción de Drizzle (la del servicio necesita un `tx` de Drizzle), revertida al final.
    const db = drizzle(sql, { schema });
    try {
      await db.transaction(async (tx) => {
        await tx.execute(dsql.raw(SQL_0223));
        await tx.execute(dsql.raw(SQL_0223));
        const [idx] = (await tx.execute(dsql`
          SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_flito_soportes_adicional_soat_hash'`)) as unknown as { indexdef: string }[];
        expect(idx.indexdef).toMatch(/CREATE UNIQUE INDEX .* \(soat_id, hash\) WHERE/);
        expect(idx.indexdef).toMatch(/documento_adicional_soat/);
        for (const { codigo } of FUNCIONES) {
          const roles = (await tx.execute(dsql`
            SELECT rol_codigo FROM permisos_rol_funcion WHERE funcion_codigo = ${codigo} ORDER BY rol_codigo`)) as unknown as { rol_codigo: string }[];
          expect(roles.map((r) => r.rol_codigo), codigo).toEqual(ROLES);
        }

        // ON CONFLICT real, con el SQL que genera Drizzle desde el servicio (no una copia).
        const [soat] = (await tx.execute(dsql`SELECT id FROM flito_soat LIMIT 1`)) as unknown as { id: string }[];
        const [user] = (await tx.execute(dsql`SELECT id FROM users LIMIT 1`)) as unknown as { id: number }[];
        if (!soat || !user) throw ROLLBACK; // BD sin solicitudes: la parte de la carga no aplica
        const hash = randomBytes(32).toString('hex');
        const base = {
          path: '/tmp/x', nombreArchivo: 'a.pdf', etiqueta: 'e', etiquetaDeNombre: false,
          contentType: 'application/pdf', tamanoBytes: 1,
        };
        const autor = { id: user.id, nombre: 'test-0223' };
        const r1 = await insertarAdicionalesDeCarga(tx as never, [{ ...base, hash, storageKey: 'k1' }], soat.id, autor);
        expect(r1.guardados).toHaveLength(1);
        expect(r1.perdedores).toEqual([]);
        const otro = randomBytes(32).toString('hex');
        const r2 = await insertarAdicionalesDeCarga(tx as never, [
          { ...base, hash, storageKey: 'k2' }, { ...base, hash: otro, storageKey: 'k3' },
        ], soat.id, autor);
        expect(r2.perdedores.map((p) => p.storageKey)).toEqual(['k2']);
        expect(r2.guardados).toHaveLength(1);
        const [n] = (await tx.execute(dsql`
          SELECT count(*)::int AS n FROM flito_soportes WHERE soat_id = ${soat.id} AND hash = ${hash}`)) as unknown as { n: number }[];
        expect(n.n).toBe(1);
        throw ROLLBACK;
      });
    } catch (e) { if (e !== ROLLBACK) throw e; }
  }, 60_000);
});
