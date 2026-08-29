// HU #11914 (Feature #11912) — paridad entre la migración 0169 y `schema.ts`, y guarda del contrato
// de la propia migración.
//
// El índice `idx_flito_soat_compania` está escrito DOS veces: en el `.sql`, que es lo que corre en
// `db:apply` y en el CD, y en `schema.ts`, que es lo que lee quien escribe una consulta. Nada vigila
// que digan lo mismo, y la divergencia no falla: cuela. Un índice declarado solo en `schema.ts` no
// existe en ninguna base; uno declarado solo en el `.sql` desaparece el día que alguien regenere
// desde el esquema.
//
// Qué mutaciones se cazan aquí:
//
//   · **El índice sobre otra columna.** `compania_id` es el predicado de aislamiento del rol
//     `cliente`; un índice sobre `estado` no sirve para eso y el test seguiría verde si solo mirara
//     que «hay un índice nuevo».
//   · **`CREATE INDEX` sin `IF NOT EXISTS`.** La segunda pasada aborta con 42P07 y para la cadena.
//   · **`CONCURRENTLY`.** No puede correr dentro de la transacción que el runner abre por archivo
//     (ADR-DB-001): fallaría en el despliegue, no aquí.
//   · **Control de transacción propio en el archivo** — el mismo guarda que aplica el runner.
//
// Análisis estático puro: NO toca la base.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { flitoSoat } from '../../src/db/schema.js';
import { scanForTxControl } from '../../src/scripts/db-apply.js';

const ARCHIVO = '0169_flito_soat_indice_compania.sql';
const CRUDO = readFileSync(fileURLToPath(new URL(`../../src/db/migrations/${ARCHIVO}`, import.meta.url)), 'utf8');

/**
 * Quita los comentarios `--` conservando los saltos de línea, sin entrar en las cadenas: los cuerpos
 * de `COMMENT ON` son literales SQL y ahí un `--` es texto.
 *
 * No es cosmético: la cabecera de esta migración EXPLICA en prosa lo que NO hace (`CONCURRENTLY`, un
 * bloque de GRANT vacío). Sin podarla, la explicación de lo descartado alimentaría las
 * comprobaciones de lo que sí se hizo.
 */
function podarComentarios(texto: string): string {
  let salida = '';
  let enCadena = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (enCadena) {
      salida += c;
      if (c === "'") enCadena = false;
      continue;
    }
    if (c === "'") { enCadena = true; salida += c; continue; }
    if (c === '-' && texto[i + 1] === '-') {
      while (i < texto.length && texto[i] !== '\n') i++;
      salida += '\n';
      continue;
    }
    salida += c;
  }
  return salida;
}

const SQL = podarComentarios(CRUDO);

describe('migración 0169 — el índice de aislamiento por compañía', () => {
  it('**crea `idx_flito_soat_compania` sobre `flito_soat (compania_id)` y no sobre otra cosa**', () => {
    expect(SQL).toMatch(/CREATE INDEX IF NOT EXISTS\s+idx_flito_soat_compania\s+ON\s+flito_soat\s*\(\s*compania_id\s*\)/i);
  });

  it('es idempotente: `IF NOT EXISTS`, o la segunda pasada aborta con 42P07', () => {
    const creaciones = SQL.match(/CREATE\s+(UNIQUE\s+)?INDEX[^;]*/gi) ?? [];
    expect(creaciones).toHaveLength(1);
    for (const c of creaciones) expect(c.toUpperCase()).toContain('IF NOT EXISTS');
  });

  it('NO usa CONCURRENTLY: el runner envuelve cada archivo en una transacción (ADR-DB-001)', () => {
    expect(SQL.toUpperCase()).not.toContain('CONCURRENTLY');
  });

  it('no lleva control de transacción propio — medido con el guarda REAL del runner', () => {
    // `scanForTxControl` es lo que aborta el `db:apply` con exit 2. Se usa la función del runner y no
    // una reimplementación, para que lo comprobado sea literalmente lo que corre en el CD.
    expect(scanForTxControl(ARCHIVO, CRUDO)).toEqual([]);
  });

  it('no crea, altera ni borra nada más: esta migración es SOLO el índice', () => {
    for (const prohibido of ['CREATE TABLE', 'ALTER TABLE', 'DROP TABLE', 'ALTER TYPE', 'UPDATE ', 'DELETE ', 'INSERT ']) {
      expect(SQL.toUpperCase()).not.toContain(prohibido);
    }
  });

  it('deja el índice comentado: quien lo vea en un `\\d` tiene que poder saber para qué es', () => {
    expect(SQL).toMatch(/COMMENT ON INDEX\s+idx_flito_soat_compania/i);
  });
});

describe('paridad con `schema.ts`', () => {
  it('**`schema.ts` declara el MISMO índice, con el mismo nombre y la misma columna**', () => {
    const { indexes } = getTableConfig(flitoSoat);
    const indice = indexes.find((i) => i.config.name === 'idx_flito_soat_compania');
    expect(indice, 'schema.ts tiene que declarar idx_flito_soat_compania').toBeDefined();

    const columnas = (indice!.config.columns as Array<{ name?: string }>).map((c) => c.name);
    expect(columnas).toEqual(['compania_id']);
    // No es único: varias filas comparten compañía, y un UNIQUE aquí rompería el segundo alta.
    expect(indice!.config.unique).toBe(false);
  });
});
