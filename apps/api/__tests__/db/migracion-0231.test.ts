// HU #12875 (Feature #12871, ADR-0024) — Migración 0231: enlace `proveedor_soat` → `proveedor`, CHECK de
// cuatro valores, trigger del ámbito con el valor nuevo y `tipo_principal` marcado RETIRADO (no borrado:
// expand/contract). Análisis estático; la aplicación ×2 contra Postgres (P6) va en el HANDOFF de la HU
// (TC-08a/b sobre la BD local), porque el CI no levanta Postgres.
//
// Mutantes que mata: un literal de código de rol (lo que tumbó el CD con la 0227), un UPDATE sin el
// `WHERE` del valor viejo (no idempotente), el CHECK viejo conservado, un `DROP COLUMN` adelantado.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { USER_ROLES } from '@operaciones/shared-types';
import { scanForTxControl } from '../../src/scripts/db-apply.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const ARCHIVO = '0231_enlace_proveedor_y_retiro_tipo_principal.sql';
const SQL = readFileSync(path.join(DIR, ARCHIVO), 'utf8');
const SIN_COMENTARIOS = SQL.replace(/--[^\n]*/g, '');

describe('0231 — reglas del archivo', () => {
  it('cabecera con el nombre del archivo, la HU y el autor; sin control de transacción propio', () => {
    expect(SQL.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(SQL.split('\n').slice(0, 12).join('\n')).toMatch(/HU #12875/);
    expect(SQL).toMatch(/^-- Autor: /m);
    expect(scanForTxControl(ARCHIVO, SQL)).toEqual([]);
  });

  it('la anterior es la 0230 y solo hay una 0231 (no exige ser la última)', () => {
    const sqls = readdirSync(DIR).filter((f) => f.endsWith('.sql'));
    expect(sqls.filter((f) => f.startsWith('0231_'))).toEqual([ARCHIVO]);
    expect(sqls.some((f) => f.startsWith('0230_'))).toBe(true);
  });

  it('SIN literales de código de rol: no compara `codigo`/`rol_codigo`/`role` con un texto ni inserta en tablas con FK a roles', () => {
    expect(SIN_COMENTARIOS).not.toMatch(/\b(codigo|rol_codigo|role)\s*(=|IN)\s*\(?\s*'/i);
    expect(SIN_COMENTARIOS).not.toMatch(/INSERT\s+INTO\s+(permisos_roles|permisos_rol_funcion|users)\b/i);
    // Ningún código de rol de fábrica aparece como literal, salvo `proveedor`, que es además el VALOR
    // de enlace nuevo (solo aparece en el SET, el CHECK y el trigger).
    for (const rol of USER_ROLES.filter((r) => r !== 'proveedor')) {
      expect(SIN_COMENTARIOS, rol).not.toMatch(new RegExp(`'${rol}'`));
    }
  });
});

describe('0231 — AC8: `proveedor_soat` → `proveedor`, idempotente', () => {
  it('el CHECK se quita ANTES del UPDATE y se repone DESPUÉS, con los cuatro valores nuevos', () => {
    const drop = SIN_COMENTARIOS.indexOf('DROP CONSTRAINT IF EXISTS permisos_roles_tipo_enlace_chk');
    const upd = SIN_COMENTARIOS.indexOf('UPDATE permisos_roles');
    const add = SIN_COMENTARIOS.indexOf('ADD CONSTRAINT permisos_roles_tipo_enlace_chk');
    expect(drop).toBeGreaterThan(-1);
    expect(upd).toBeGreaterThan(drop);
    expect(add).toBeGreaterThan(upd);
    expect(SIN_COMENTARIOS).toMatch(/CHECK \(tipo_enlace IN \('ninguno','compania','proveedor','organismos_transito'\)\)/);
  });

  it('el UPDATE solo toca el valor viejo (2.ª pasada = 0 filas) y deja auditoría de sistema por cada fila tocada', () => {
    expect(SIN_COMENTARIOS).toMatch(/SET tipo_enlace = 'proveedor', updated_at = now\(\)\s+WHERE tipo_enlace = 'proveedor_soat'\s+RETURNING codigo/);
    expect(SIN_COMENTARIOS).toMatch(/INSERT INTO permisos_auditoria[\s\S]*'rol', 'editar', 'tipo_enlace'[\s\S]*'sistema'[\s\S]*FROM ren CROSS JOIN lote/);
    // AC7 (TC-07c): ningún otro enlace se reescribe.
    expect(SIN_COMENTARIOS.match(/UPDATE permisos_roles/g)).toHaveLength(1);
  });

  it('el trigger del ámbito exige proveedor SOAT por el valor NUEVO, y ya no nombra el viejo', () => {
    const fn = /CREATE OR REPLACE FUNCTION users_ambito_requerido\(\)[\s\S]*?END \$fn\$;/.exec(SIN_COMENTARIOS)![0];
    expect(fn).toMatch(/IF te = 'proveedor' AND NEW\.flito_proveedor_soat_id IS NULL THEN/);
    expect(fn).not.toMatch(/proveedor_soat'/);
    expect(fn).toMatch(/IF te = 'compania' AND NEW\.compania_id IS NULL THEN/);
  });
});

describe('0231 — AC6: el tipo interno/externo se marca retirado y NO se borra (expand/contract)', () => {
  it('COMMENT «RETIRADA» sobre la columna, sin DROP COLUMN ni cambio de su CHECK', () => {
    expect(SIN_COMENTARIOS).toMatch(/COMMENT ON COLUMN permisos_roles\.tipo_principal IS\s+'RETIRADA \(HU #12875\)/);
    expect(SIN_COMENTARIOS).not.toMatch(/DROP COLUMN/i);
    expect(SIN_COMENTARIOS).not.toMatch(/permisos_roles_tipo_principal_chk/);
  });
});
