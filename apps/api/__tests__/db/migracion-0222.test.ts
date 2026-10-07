// HU #13362 (Feature #13360, Épica #13201) — 0222: columnas `etiqueta` y `soat_incompleta_id` en
// `flito_soportes`, CHECK del tipo nuevo, y la función `soat.documentos_adicionales.ver` repartida a
// operación FLIT (`admin`) y proveedor SOAT (`proveedor`), NUNCA al `cliente` (TC-26).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { MIGRACIONES_CON_REPARTO, funcionesDeSql, leerRepartoSembrado } from '../helpers/permisos-seed-sql.js';
import { OPERACIONES_DECLARADAS } from '../../src/modules/permisos/catalogo-operaciones.js';
import { GUARDAS_MEDIDAS } from '../../src/modules/permisos/inventario.generado.js';
import { llaveDe } from '../../src/modules/permisos/inventario-guardas.js';
import { catalogoCompleto } from '../../src/modules/permisos/catalogo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0222_flito_soportes_documentos_adicionales_soat.sql';
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const SQL_0222 = readFileSync(path.join(DIR, ARCHIVO), 'utf8');
const SIN_COMENTARIOS = SQL_0222.replace(/--[^\n]*/g, '');
const CODIGO = 'soat.documentos_adicionales.ver';
const LLAVE = 'flito-soat/flito-soat-documentos.routes.ts GET /:id/documentos-adicionales';
const ROLES = ['admin', 'proveedor'];

describe('0222 — análisis estático', () => {
  it('sin BEGIN/COMMIT; DO etiquetados; sin `$$` sin etiqueta; número único; la anterior es la 0221_', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0222)).toEqual([]);
    expect(SQL_0222).toMatch(/DO \$resumen0222\$/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
    const sqls = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0222_'))).toEqual([ARCHIVO]);
    expect(sqls[sqls.indexOf(ARCHIVO) - 1]).toMatch(/^0221_/);
    expect(SQL_0222.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(SQL_0222).toMatch(/^-- Autor: /m);
  });

  it('columnas nullables e idempotentes; FK a incompletas SIN cascade; índice parcial; CHECK guardado', () => {
    expect(SIN_COMENTARIOS).toMatch(/ADD COLUMN IF NOT EXISTS etiqueta varchar\(150\);/);
    expect(SIN_COMENTARIOS).toMatch(/ADD COLUMN IF NOT EXISTS soat_incompleta_id uuid REFERENCES flito_soat_incompletas\(id\);/);
    expect(SIN_COMENTARIOS).not.toMatch(/CASCADE|NOT NULL DEFAULT|DROP|DELETE/);
    expect(SIN_COMENTARIOS).toMatch(/CREATE INDEX IF NOT EXISTS idx_flito_soportes_soat_incompleta\s+ON flito_soportes \(soat_incompleta_id\) WHERE soat_incompleta_id IS NOT NULL;/);
    expect(SIN_COMENTARIOS).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'flito_soportes_documento_adicional_chk'\)/);
  });

  it('siembra la función con los textos byte a byte del catálogo, en su router', () => {
    const funciones = funcionesDeSql([SQL_0222]);
    expect([...funciones.keys()]).toEqual([CODIGO]);
    const op = OPERACIONES_DECLARADAS.find((o) => o.codigo === CODIGO)!;
    expect(op.llave).toBe(LLAVE);
    const f = catalogoCompleto().find((c) => c.codigo === CODIGO)!;
    expect(funciones.get(CODIGO)).toEqual({
      codigo: CODIGO, modulo: f.modulo, nombre: op.nombre, descripcion: op.descripcion, tipo: 'operacion',
    });
  });

  it('reparto: admin y proveedor; el cliente NO (foto, SQL y plegado de todas las migraciones)', () => {
    const g = GUARDAS_MEDIDAS.find((x) => llaveDe(x) === LLAVE)!;
    expect([...g.roles].sort()).toEqual(ROLES);
    expect(MIGRACIONES_CON_REPARTO).toContain(ARCHIVO);
    const total = leerRepartoSembrado();
    for (const rol of ROLES) expect(total.get(rol)!.has(CODIGO), rol).toBe(true);
    expect(total.get('cliente')?.has(CODIGO) ?? false).toBe(false);
    expect(SIN_COMENTARIOS).toMatch(/IF n_ops <> 1 OR n_cliente <> 0 THEN\s*RAISE EXCEPTION/);
  });
});

const URL_BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL_BASE)('0222 — aplicar ×2 sobre BD ya migrada (P6)', () => {
  let sql: postgres.Sql;
  const ROLLBACK = Symbol('rollback');
  beforeAll(() => { sql = postgres(URL_BASE!, { max: 1, onnotice: () => {} }); });
  afterAll(async () => { await sql?.end(); });

  it('dos pasadas sin fallar; columnas y reparto; el CHECK rechaza un adicional sin etiqueta', async () => {
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(SQL_0222);
        await tx.unsafe(SQL_0222);
        const cols = await tx<{ column_name: string; is_nullable: string; character_maximum_length: number | null }[]>`
          SELECT column_name, is_nullable, character_maximum_length FROM information_schema.columns
          WHERE table_name = 'flito_soportes' AND column_name IN ('etiqueta', 'soat_incompleta_id') ORDER BY column_name`;
        expect(cols.map((c) => [c.column_name, c.is_nullable, c.character_maximum_length]))
          .toEqual([['etiqueta', 'YES', 150], ['soat_incompleta_id', 'YES', null]]);
        const roles = await tx<{ rol_codigo: string }[]>`
          SELECT rol_codigo FROM permisos_rol_funcion WHERE funcion_codigo = ${CODIGO} ORDER BY rol_codigo`;
        expect(roles.map((r) => r.rol_codigo)).toEqual(ROLES);
        await tx.unsafe('SAVEPOINT chk');
        await expect(tx.unsafe(`INSERT INTO flito_soportes (tipo, nombre_archivo, content_type, storage_key, hash, tamano_bytes, subido_por_nombre)
          VALUES ('documento_adicional_soat', 'a.pdf', 'application/pdf', 'k', repeat('a', 64), 1, 'x')`))
          .rejects.toMatchObject({ code: '23514' });
        await tx.unsafe('ROLLBACK TO SAVEPOINT chk');
        throw ROLLBACK;
      });
    } catch (e) { if (e !== ROLLBACK) throw e; }
  }, 60_000);
});
