// HU #12873 (ADR-0025) — Migración 0232: la base del árbol (columnas + siembra de acciones). Estática:
// el CI no levanta Postgres; la doble aplicación sobre la base local va en el HANDOFF de la HU (P6).
//
// Se afirma «la anterior es 0231_» y NUNCA «la 0232 es la última» (memoria: no congelar el tip).
// Mutantes nombrados:
//   · cambiar un nombre de acción en `gestion.ts` sin regenerar → cae «el bloque es la salida del generador».
//   · quitar `'accion'` del CHECK de `tipo` → cae «el CHECK admite los cuatro tipos» (y en base, el INSERT).
//   · añadir una fila de reparto a un rol con nombre → cae «sin literales de rol».
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { permisosFunciones } from '../../src/db/schema.js';
import { sqlSiembraArbol } from '../../src/modules/permisos/arbol/sql-arbol.js';
import { bloqueGenerado, literalesDeRol } from '../helpers/permisos-seed-sql.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0232_permisos_arbol_gestion_siembra.sql';
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const SQL = readFileSync(path.join(DIR, ARCHIVO), 'utf8');
const SIN_COMENTARIOS = SQL.replace(/--[^\n]*/g, '');

describe('0232 — análisis estático', () => {
  it('sin BEGIN/COMMIT propio; número único; la anterior es la 0231 (no «es la última»)', () => {
    expect(scanForTxControl(ARCHIVO, SQL)).toEqual([]);
    const sqls = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0232_'))).toEqual([ARCHIVO]);
    expect(sqls[sqls.indexOf(ARCHIVO) - 1]).toBe('0231_enlace_proveedor_y_retiro_tipo_principal.sql');
  });

  it('cabecera: archivo, HU y autor', () => {
    const cabecera = SQL.split('\n').slice(0, 6).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/HU #12873/);
    expect(cabecera).toMatch(/^-- Autor: /m);
  });

  it('el bloque entre marcas es EXACTAMENTE la salida del generador (`--arbol gestion`)', () => {
    expect(bloqueGenerado(SQL)).toBe(sqlSiembraArbol('gestion'));
  });

  it('DDL idempotente: columnas IF NOT EXISTS, FK guardada por nombre, índice IF NOT EXISTS, CHECK DROP/ADD', () => {
    expect(SIN_COMENTARIOS).toMatch(/ADD COLUMN IF NOT EXISTS padre_codigo varchar\(80\);/);
    expect(SIN_COMENTARIOS).toMatch(/ADD COLUMN IF NOT EXISTS nivel smallint;/);
    expect(SIN_COMENTARIOS).toMatch(/ADD COLUMN IF NOT EXISTS orden integer NOT NULL DEFAULT 0;/);
    expect(SIN_COMENTARIOS).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'permisos_funciones_padre_codigo_permisos_funciones_codigo_fk'\)/);
    expect(SIN_COMENTARIOS).toMatch(/REFERENCES permisos_funciones\(codigo\) ON DELETE RESTRICT ON UPDATE CASCADE/);
    expect(SIN_COMENTARIOS).toMatch(/CREATE INDEX IF NOT EXISTS permisos_funciones_padre_idx ON permisos_funciones \(padre_codigo\);/);
    expect(SIN_COMENTARIOS).toMatch(/DROP CONSTRAINT IF EXISTS permisos_funciones_tipo_chk;/);
    expect(SIN_COMENTARIOS).toMatch(/CHECK \(tipo IN \('pagina', 'operacion', 'elemento', 'accion'\)\)/);
    expect(SIN_COMENTARIOS).toMatch(/CHECK \(nivel IS NULL OR nivel BETWEEN 1 AND 3\)/);
    expect(SIN_COMENTARIOS).toMatch(/ON CONFLICT \(codigo\) DO UPDATE SET/);
    expect(SIN_COMENTARIOS).toMatch(/IS DISTINCT FROM \(EXCLUDED\.modulo/);
  });

  it('schema.ts declara lo mismo: columnas, FK a sí misma (RESTRICT/CASCADE), índice y los dos CHECK con su nombre', () => {
    const cfg = getTableConfig(permisosFunciones);
    const col = (n: string) => cfg.columns.find((c) => c.name === n);
    expect(col('padre_codigo')?.getSQLType()).toBe('varchar(80)');
    expect(col('nivel')?.getSQLType()).toBe('smallint');
    expect(col('orden')?.notNull).toBe(true);
    const fk = cfg.foreignKeys.map((f) => ({ nombre: f.getName(), del: f.onDelete, upd: f.onUpdate }));
    expect(fk).toEqual([{ nombre: 'permisos_funciones_padre_codigo_permisos_funciones_codigo_fk', del: 'restrict', upd: 'cascade' }]);
    expect(cfg.indexes.map((i) => i.config.name)).toContain('permisos_funciones_padre_idx');
    expect(cfg.checks.map((c) => c.name).sort()).toEqual(['permisos_funciones_nivel_chk', 'permisos_funciones_tipo_chk']);
  });

  it('solo siembra: ni reparto, ni excepciones, ni borrados; sin literales de rol', () => {
    expect(SIN_COMENTARIOS).not.toMatch(/permisos_rol_funcion|permisos_usuario_funcion|\bDELETE FROM\b|\bTRUNCATE\b/i);
    expect(literalesDeRol(SQL)).toEqual([]);
  });
});
