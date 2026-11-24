// Feature #14323, HU #14328, #14329 y #14330 — migración 0292 y comprobación previa (ADR-0039 §5).
//
// Solo estática desde la HU #14355: la parte con BD aplicaba la 0292 sobre la base, y la 0314 retiró las columnas que
// la 0292 lee (ver el final del archivo).

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns } from 'drizzle-orm';
import { SERVICIOS_PROVEEDOR, SERVICIO_DE_MODULO } from '@operaciones/shared-types';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import * as schema from '../../src/db/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const ARCHIVO = '0292_flito_proveedores_padre.sql';
const MIGRACION = readFileSync(path.join(DIR, ARCHIVO), 'utf8');
const PREFLIGHT = readFileSync(path.resolve(__dirname, '../../src/db/manual/flito-proveedores-preflight.sql'), 'utf8');
const SEED = readFileSync(path.resolve(__dirname, '../../src/scripts/flito-seed.ts'), 'utf8');
const SIN_COMENTARIOS = MIGRACION.replace(/--[^\n]*/g, '');

const entre = (texto: string, abre: string, cierra: string): string => {
  const a = texto.indexOf(abre);
  const b = texto.indexOf(cierra);
  expect(a, abre).toBeGreaterThanOrEqual(0);
  expect(b, cierra).toBeGreaterThan(a);
  return texto.slice(a, b);
};


describe('0292 — análisis estático', () => {
  it('número propio y sin control de transacción propio: el runner envuelve el archivo', () => {
    expect(scanForTxControl(ARCHIVO, MIGRACION)).toEqual([]);
    const sqls = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    // Solo que nadie más lleve su número: no qué número tiene la anterior, que cambia con cada merge ajeno.
    expect(sqls.filter((f) => f.startsWith(ARCHIVO.slice(0, 5)))).toEqual([ARCHIVO]);
  });

  it('#14328 AC2: la parada va antes de cualquier tabla, columna, índice, función o trigger', () => {
    const parada = SIN_COMENTARIOS.indexOf('DO $parada$');
    expect(parada).toBeGreaterThan(0);
    for (const ddl of ['CREATE TABLE', 'CREATE UNIQUE INDEX', 'ALTER TABLE', 'CREATE OR REPLACE', 'CREATE TRIGGER', 'INSERT INTO', 'UPDATE users']) {
      expect(SIN_COMENTARIOS.indexOf(ddl), ddl).toBeGreaterThan(parada);
    }
    expect(SIN_COMENTARIOS.slice(0, parada).trim()).toMatch(/^SET LOCAL lock_timeout = '\d+s';\s+LOCK TABLE [^;]+;$/);
  });

  it('#14328: el SET LOCAL lock_timeout precede al LOCK TABLE, para no esperar sin límite con la API caída', () => {
    const limite = SIN_COMENTARIOS.indexOf("SET LOCAL lock_timeout = '30s';");
    expect(limite).toBeGreaterThanOrEqual(0);
    expect(limite).toBeLessThan(SIN_COMENTARIOS.indexOf('LOCK TABLE'));
  });

  it('#14328 AC6: las consultas de las paradas son idénticas en la migración y en la comprobación previa', () => {
    const paradas = entre(MIGRACION, '-- >>> PARADAS', '-- <<< PARADAS');
    expect(entre(PREFLIGHT, '-- >>> PARADAS', '-- <<< PARADAS')).toBe(paradas);
    expect(paradas).toContain('NOMBRE REPETIDO');
    expect(paradas).toContain('NIT REPETIDO');
    expect(paradas).toContain('IDENTIFICADOR REPETIDO');
  });

  it('#14328 AC3: las paradas no seleccionan el NIT para mostrarlo', () => {
    const paradas = entre(MIGRACION, '-- >>> PARADAS', '-- <<< PARADAS').replace(/--[^\n]*/g, '');
    expect(paradas).not.toMatch(/format\([^)]*\.nit\b/);
    expect(paradas).not.toMatch(/string_agg\([^)]*\.nit\b/);
    expect(paradas).not.toMatch(/\bl\.nit\s+AS\b/);
  });

  it('#14328 AC6: la comprobación previa fija la transacción en solo lectura y no crea ni escribe nada', () => {
    const sin = PREFLIGHT.replace(/--[^\n]*/g, '');
    expect(sin).toContain("set_config('transaction_read_only', 'on', true)");
    expect(sin).not.toMatch(/\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|GRANT)\b/);
  });

  it('#14328: el mensaje de la parada dirige a la comprobación previa', () => {
    expect(SIN_COMENTARIOS).toContain('Ejecute apps/api/src/db/manual/flito-proveedores-preflight.sql, corrija los datos');
  });

  it('#14329 AC7: sin RENAME, DROP de columna o tabla, ni NOT NULL sobre tablas existentes', () => {
    expect(SIN_COMENTARIOS).not.toMatch(/\bRENAME\b/);
    expect(SIN_COMENTARIOS).not.toMatch(/DROP\s+(COLUMN|TABLE|CONSTRAINT|VIEW|INDEX|FUNCTION)/i);
    expect(SIN_COMENTARIOS).not.toMatch(/SET\s+NOT\s+NULL/i);
    expect(SIN_COMENTARIOS.match(/DROP\s+\w+/gi)!.every((d) => /^DROP\s+TRIGGER$/i.test(d))).toBe(true);
    for (const a of SIN_COMENTARIOS.match(/ADD COLUMN[^;]+;/g)!) expect(a).not.toMatch(/NOT NULL/);
  });

  it('#14329 AC2: SERVICIOS_PROVEEDOR es la lista y coincide con los literales de la vista; sin tabla de catálogo', () => {
    expect(SERVICIOS_PROVEEDOR).toEqual(['soat', 'logistica']);
    expect(SERVICIO_DE_MODULO).toEqual({ soat: 'soat', logistica: 'logistica' });
    const vista = /CREATE OR REPLACE VIEW flito_proveedor_servicios_v AS[\s\S]*?;/.exec(SIN_COMENTARIOS)![0];
    expect([...vista.matchAll(/'(\w+)'::text/g)].map((m) => m[1])).toEqual([...SERVICIOS_PROVEEDOR]);
    expect([...SIN_COMENTARIOS.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]))
      .toEqual(['flito_proveedores', 'flito_proveedores_auditoria']);
  });

  it('#14329 AC8: el seed no depende de ON CONFLICT en el perfil, que no alcanza al padre', () => {
    expect(SEED).not.toMatch(/insert\(flitoProveedoresLogistica\)[\s\S]{0,200}onConflictDoNothing/);
  });

  it('Drizzle declara el padre, la auditoría y las columnas nuevas, todas opcionales sobre lo existente', () => {
    const padre = getTableColumns(schema.flitoProveedores);
    expect(padre.nit.notNull).toBe(false);
    expect(padre.deletedAt.notNull).toBe(false);
    expect(getTableColumns(schema.flitoProveedoresAuditoria).proveedorId.notNull).toBe(true);
    expect(getTableColumns(schema.users).flitoProveedorId.notNull).toBe(false);
    expect(getTableColumns(schema.flitoProveedoresLogistica).deletedAt.notNull).toBe(false);
    expect(getTableColumns(schema.flitoProveedoresLogistica).deletedBy.notNull).toBe(false);
  });
});

// HU #14355: se retira la parte contra PostgreSQL. Aplicaba la 0292 entera dentro de la transacción, y la 0292 copia y
// sincroniza desde las columnas viejas de los perfiles y desde `users.flito_proveedor_soat_id`, que la 0314 eliminó: ya
// no se puede aplicar sobre un esquema al día. La parte estática sigue (incluida la igualdad de las paradas con la
// comprobación previa); la retirada de la sincronización la mide `db/migracion-0314.test.ts`.
