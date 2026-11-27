// Épica #14548 (ADR-0051, bloque A) — la migración 0321 (permisos del visor de consumo de IA), estática: lo que se puede
// afirmar del texto sin base. La idempotencia contra una base real (P6: el archivo, dos veces, con BEGIN/ROLLBACK) la
// hace el hilo principal; aquí no se aplica a ninguna base.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SQL = readFileSync(join(__dirname, '../../src/db/migrations/0321_flito_ia_consumo_permisos.sql'), 'utf8');
/** Lo que el runner ejecuta: sin comentarios. */
const EJECUTABLE = SQL.replace(/--[^\n]*/g, '');
const INICIO = '-- ÁRBOL GENERADO (inicio)';
const FIN = '-- ÁRBOL GENERADO (fin)';
const BLOQUE = SQL.slice(SQL.indexOf(INICIO), SQL.indexOf(FIN));

describe('0321 — forma de la migración', () => {
  it('es SQL plano: no abre transacción propia (el runner aplica el fichero en una)', () => {
    expect(EJECUTABLE).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK|START TRANSACTION)\b/i);
  });

  it('no hace DDL ni borra nada (A-28)', () => {
    expect(EJECUTABLE).not.toMatch(/\b(CREATE|ALTER|DROP|TRUNCATE|DELETE)\b/i);
  });

  it('solo dos INSERT, ambos con ON CONFLICT: re-ejecutable sin efecto (A-27)', () => {
    expect(EJECUTABLE.match(/INSERT INTO \w+/g)).toEqual([
      'INSERT INTO permisos_funciones',
      'INSERT INTO permisos_rol_funcion',
    ]);
    expect(EJECUTABLE.match(/ON CONFLICT/g)).toHaveLength(2);
  });

  it('no toca las tablas de consumo de IA (D2)', () => {
    expect(EJECUTABLE).not.toMatch(/ia_consumo_log|ia_consumo_detalle|ia_tarifa_modelo/);
  });

  it('las marcas del árbol generado aparecen una vez y en orden', () => {
    expect(SQL.split(INICIO)).toHaveLength(2);
    expect(SQL.split(FIN)).toHaveLength(2);
    expect(SQL.indexOf(INICIO)).toBeLessThan(SQL.indexOf(FIN));
  });
});

describe('0321 — reparto (D4): solo admin', () => {
  it('todos los pares (rol, función) del reparto son del rol admin', () => {
    const roles = [...BLOQUE.matchAll(/\('([a-z_]+)', '([^']+)'\)/g)].map(([, rol]) => rol);
    expect(roles.length).toBeGreaterThan(0);
    expect(new Set(roles)).toEqual(new Set(['admin']));
  });

  it('la página y las tres acciones están sembradas con su código', () => {
    for (const codigo of ['pagina.ia_consumo', 'accion.ia_consumo.ver', 'accion.ia_consumo.exportar', 'accion.ia_consumo.ver_contenido']) {
      expect(BLOQUE, codigo).toContain(`'${codigo}'`);
    }
  });
});
