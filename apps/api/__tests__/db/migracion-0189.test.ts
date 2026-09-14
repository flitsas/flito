// HU #12088 — Migración 0189: unificación de organismos en la puente + trigger solo puente.
//
// Mitad estática (siempre): el SQL dice backfill de `transito`, NULL de columna, REPLACE del
// predicado sin brazo `transito_codigo`, recreación del trigger OF role, COMMENT OBSOLETA.
// Mitad contra Postgres: opcional con TEST_DATABASE_URL (P6: aplicar ×2).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanForTxControl } from '../../src/scripts/db-apply.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0189_users_ambito_organismos_unificado.sql';
const RUTA = path.resolve(__dirname, '../../src/db/migrations', ARCHIVO);
const SQL = readFileSync(RUTA, 'utf8');
const SIN_COMENTARIOS = SQL.replace(/--[^\n]*/g, '');

describe('0189 — unificación organismos (análisis estático)', () => {
  it('no trae control de transacción propio (ADR-DB-001)', () => {
    expect(scanForTxControl(ARCHIVO, SQL)).toEqual([]);
  });

  it('cabecera: archivo, HU #12088 y autor', () => {
    const cabecera = SQL.split('\n').slice(0, 10).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/HU #12088/);
    expect(cabecera).toMatch(/^-- Autor: /m);
  });

  it('backfill: users.role=transito → flito_gestor_organismos con JOIN anti-23503', () => {
    expect(SIN_COMENTARIOS).toMatch(
      /INSERT\s+INTO\s+flito_gestor_organismos[\s\S]*FROM\s+users\s+u[\s\S]*JOIN\s+organismos_transito_config[\s\S]*role\s*=\s*'transito'[\s\S]*ON\s+CONFLICT\s+DO\s+NOTHING/i,
    );
  });

  it('limpia users.transito_codigo en rol transito (espejo 0173)', () => {
    expect(SIN_COMENTARIOS).toMatch(
      /UPDATE\s+users\s+SET\s+transito_codigo\s*=\s*NULL[\s\S]*role\s*=\s*'transito'/i,
    );
  });

  it('REPLACE function: solo puente (sin brazo NEW.transito_codigo)', () => {
    expect(SIN_COMENTARIOS).toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+users_ambito_organismos_requerido/i);
    expect(SIN_COMENTARIOS).toMatch(/tipo_enlace[\s\S]*organismos_transito[\s\S]*flito_gestor_organismos/i);
    // El predicado unificado NO debe aceptar la columna como forma válida.
    const fn = SIN_COMENTARIOS.split(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+users_ambito_organismos_requerido/i)[1]
      ?.split(/DROP\s+TRIGGER/i)[0] ?? '';
    expect(fn).not.toMatch(/NEW\.transito_codigo\s+IS\s+NULL/i);
    expect(fn).not.toMatch(/NEW\.transito_codigo\s+IS\s+NOT\s+NULL/i);
  });

  it('recrea el trigger OF role (ya no OF transito_codigo)', () => {
    expect(SIN_COMENTARIOS).toMatch(
      /CREATE\s+CONSTRAINT\s+TRIGGER\s+users_ambito_organismos_trg[\s\S]*AFTER\s+INSERT\s+OR\s+UPDATE\s+OF\s+role\s+ON\s+users/i,
    );
    expect(SIN_COMENTARIOS).not.toMatch(
      /users_ambito_organismos_trg[\s\S]*UPDATE\s+OF\s+role,\s*transito_codigo/i,
    );
  });

  it('COMMENT ON COLUMN users.transito_codigo marca OBSOLETA', () => {
    expect(SIN_COMENTARIOS).toMatch(
      /COMMENT\s+ON\s+COLUMN\s+users\.transito_codigo\s+IS[\s\S]*OBSOLETA/i,
    );
  });
});
