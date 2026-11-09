// HU #14349 — lo que se comprueba sin base: que la 0298 y el esquema Drizzle dicen lo mismo y que el corte no depende de nadie.
// Las reglas de la normalización se prueban contra Postgres en `flito-logistica.corte-proveedor.pg.test.ts`.
import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { flitoLogisticaCorteProveedor } from '../../src/db/schema.js';
import { leerMigracion } from '../helpers/base-en-tx.js';

const SQL_0297 = leerMigracion('0298_flito_logistica_corte_proveedor.sql');
const sinComentarios = SQL_0297.replace(/--.*$/gm, '');

describe('0298 — fecha de corte (estático)', () => {
  it('AC1: la fecha sale de `now()`, sin variable de entorno ni parámetro', () => {
    expect(sinComentarios).toMatch(/VALUES \(true, now\(\)\)/);
    expect(sinComentarios).not.toMatch(/current_setting|\\set|:'/i);
  });

  it('AC2: la inserción no pisa una fecha registrada', () => {
    expect(sinComentarios).toMatch(/ON CONFLICT \(unica\) DO NOTHING/);
    expect(sinComentarios).not.toMatch(/DO UPDATE/i);
  });

  it('la normalización va en la misma sentencia que el registro: solo corre si esta ejecución registró la fecha', () => {
    const sentencias = sinComentarios.split(';').map((s) => s.trim()).filter(Boolean);
    const conUpdate = sentencias.filter((s) => /UPDATE flito_logistica_documentos/.test(s));
    expect(conUpdate).toHaveLength(1);
    expect(conUpdate[0]).toMatch(/^WITH registro AS \(\s*INSERT INTO flito_logistica_corte_proveedor/);
    expect(conUpdate[0]).toMatch(/RETURNING corte_en/);
    expect(conUpdate[0]).toMatch(/CROSS JOIN registro r/);
  });

  it('sin transacción propia (la pone el runner) y con límite de lock', () => {
    expect(sinComentarios).not.toMatch(/\b(BEGIN|COMMIT)\b/i);
    expect(sinComentarios).toMatch(/SET LOCAL lock_timeout/);
  });

  it('el esquema Drizzle declara la misma tabla, sin deriva', () => {
    const t = getTableConfig(flitoLogisticaCorteProveedor);
    expect(t.name).toBe('flito_logistica_corte_proveedor');
    expect(t.columns.map((c) => [c.name, c.getSQLType(), c.notNull, c.primary, c.hasDefault])).toEqual([
      ['unica', 'boolean', true, true, true],
      ['corte_en', 'timestamp with time zone', true, false, true],
    ]);
    expect(t.checks.map((c) => c.name)).toEqual(['ck_flito_log_corte_proveedor_unica']);
    expect(sinComentarios).toMatch(/CONSTRAINT ck_flito_log_corte_proveedor_unica CHECK \(unica\)/);
  });
});
