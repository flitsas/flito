// HU #11966 — guarda de contrato de la migración 0172: los datos del canal Cliente que el Excel
// necesita persistidos (`vehicles` + `flito_compradores`) y el CHECK del titular.
//
// Análisis estático puro: NO toca la base. P6 (aplicar el SQL dos veces contra la BD local) vive en
// el HANDOFF del backend-agent, no aquí — un test que abriera una conexión no correría en CI.
//
// Lo que estas dos suites afirman, por orden de lo que costaría más caro si dejara de ser verdad:
//
//   1. **Las siete columnas son NULLABLE y sin DEFAULT.** Es la mitad del AC6: un `NOT NULL` sobre
//      `vehicles` obligaría a un DEFAULT y el único candidato de `puertas` sería `'4'` —escribir en
//      la base la constante de la plantilla como si fuera un dato medido—, y sobre
//      `flito_compradores` obligaría a un backfill que partiera `nombre_completo` por el espacio.
//   2. **Cero backfill.** Ni un `UPDATE`. Las solicitudes ya radicadas no se tocan (AC6), y un
//      `UPDATE` aquí sería exactamente lo que la HU prohíbe, aplicado a todas de golpe.
//   3. **Idempotencia real** (P6): `ADD COLUMN IF NOT EXISTS` × 7 y el CHECK reciclado con
//      `DROP CONSTRAINT IF EXISTS` + `ADD` — PostgreSQL no admite `ADD CONSTRAINT IF NOT EXISTS`.
//   4. **Paridad con `schema.ts`.** La lección de la 0157: un CHECK que solo vive en la base
//      convence a quien lee `schema.ts` de que no hace falta migración, y el primer INSERT nuevo
//      muere con 23514.
//   5. **La 0171 no se reescribe** — ya está aplicada y su sha256 registrado en
//      `_kyverum_applied_migrations`. Se comprueba leyéndola: si alguien la editara, este test cae.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { flitoCompradores, vehicles } from '../../src/db/schema.js';
import { scanForTxControl } from '../../src/scripts/db-apply.js';

const ARCHIVO = '0172_flito_soat_canal_datos_persistidos.sql';
const leer = (nombre: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/db/migrations/${nombre}`, import.meta.url)), 'utf8');

const CRUDO = leer(ARCHIVO);

/**
 * Quita los comentarios `--` sin tocar lo que va dentro de una cadena.
 *
 * Calcado de la suite de la 0171 y por el mismo motivo: la mitad de las afirmaciones de este archivo
 * son sobre lo que el SQL **no** dice (`NOT NULL`, `DEFAULT`, `UPDATE`), y la prosa de la cabecera de
 * la migración las nombra todas para explicar por qué no están. Sin podar, cada una de esas
 * negaciones sería verde por el comentario que la justifica.
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

/** Las siete columnas de la HU, con su tabla y su tipo exacto. */
const COLUMNAS = [
  { tabla: 'vehicles', columna: 'pasajeros_sentados', tipo: 'varchar(10)' },
  { tabla: 'vehicles', columna: 'puertas', tipo: 'varchar(5)' },
  { tabla: 'flito_compradores', columna: 'nombres', tipo: 'varchar(200)' },
  { tabla: 'flito_compradores', columna: 'apellidos', tipo: 'varchar(200)' },
  { tabla: 'flito_compradores', columna: 'razon_social', tipo: 'varchar(200)' },
  { tabla: 'flito_compradores', columna: 'municipio', tipo: 'varchar(100)' },
  { tabla: 'flito_compradores', columna: 'departamento', tipo: 'varchar(100)' },
] as const;

describe('migración 0172 — las siete columnas del canal Cliente', () => {
  it('no lleva control de transacción propio (ADR-DB-001)', () => {
    expect(scanForTxControl(ARCHIVO, CRUDO)).toEqual([]);
  });

  it.each(COLUMNAS)('añade `$tabla.$columna` como $tipo, con IF NOT EXISTS', ({ tabla, columna, tipo }) => {
    const escapado = tipo.replace('(', '\\(').replace(')', '\\)');
    expect(SQL).toMatch(
      new RegExp(`ALTER TABLE\\s+${tabla}\\s+ADD COLUMN IF NOT EXISTS\\s+${columna} ${escapado}\\s*;`, 'i'),
    );
  });

  it('**siete y solo siete `ADD COLUMN`**: ni una columna de más colada en la misma migración', () => {
    const adds = SQL.match(/ADD COLUMN IF NOT EXISTS/gi) ?? [];
    expect(adds).toHaveLength(7);
    // Y ningún `ADD COLUMN` sin la guarda: uno solo rompería la segunda pasada entera.
    const todos = SQL.match(/ADD COLUMN/gi) ?? [];
    expect(todos).toHaveLength(7);
  });

  it('**ninguna es NOT NULL y ninguna trae DEFAULT** — es la mitad del AC6, no una omisión', () => {
    // `NOT NULL` reventaría sobre las filas ya radicadas, que es justo lo que la HU prohíbe tocar; y
    // un DEFAULT en `puertas` solo podría ser `'4'`, la constante de la plantilla escrita como si
    // fuera un dato medido del vehículo. El mutante es añadir cualquiera de las dos.
    expect(SQL).not.toMatch(/ADD COLUMN IF NOT EXISTS[^;]*NOT NULL/i);
    expect(SQL).not.toMatch(/ADD COLUMN IF NOT EXISTS[^;]*DEFAULT/i);
  });

  it('**CERO backfill**: la migración no toca ni una fila existente (AC6)', () => {
    // La 0171 sí llevaba `UPDATE` y era correcto para su regla. Aquí no hay nada que rellenar: las
    // filas de trámite no usan estas columnas y las del canal radicadas antes de esta HU no se
    // reescriben. Un `UPDATE` aquí sería el AC6 roto para todas de golpe.
    expect(SQL).not.toMatch(/\bUPDATE\b/i);
    expect(SQL).not.toMatch(/\bINSERT\b/i);
    expect(SQL).not.toMatch(/\bDELETE\b/i);
  });

  it('no toca `flito_soat` ni el satélite: esta migración es de otras dos tablas', () => {
    expect(SQL).not.toMatch(/ALTER TABLE\s+flito_soat\b/i);
    expect(SQL).not.toMatch(/flito_soat_solicitud/i);
  });
});

describe('migración 0172 — el CHECK del titular, y su idempotencia', () => {
  it('**`razon_social` XOR `nombres`/`apellidos`**, con el predicado exacto', () => {
    expect(SQL).toMatch(/ADD CONSTRAINT\s+flito_compradores_titular_chk/i);
    expect(SQL).toMatch(
      /CHECK\s*\(\s*razon_social IS NULL OR \(nombres IS NULL AND apellidos IS NULL\)\s*\)/i,
    );
  });

  it('**el CHECK se recicla con DROP IF EXISTS + ADD** (PostgreSQL no admite ADD CONSTRAINT IF NOT EXISTS)', () => {
    const drop = SQL.search(/DROP CONSTRAINT IF EXISTS\s+flito_compradores_titular_chk/i);
    const add = SQL.search(/ADD CONSTRAINT\s+flito_compradores_titular_chk/i);
    expect(drop, 'falta el DROP: la segunda pasada moriría con 42710').toBeGreaterThanOrEqual(0);
    expect(add).toBeGreaterThanOrEqual(0);
    // El orden es el contrato, no una casualidad de escritura: con el ADD delante, la segunda pasada
    // aborta antes de llegar al DROP.
    expect(drop, 'el DROP tiene que ir ANTES del ADD').toBeLessThan(add);
  });

  it('las filas legacy lo cumplen: el predicado es cierto con los tres campos NULL', () => {
    // El CHECK se evalúa en la base sobre las ~7 052 filas existentes en el momento del ADD. Con los
    // tres NULL, `razon_social IS NULL` es TRUE y la disyunción entera es TRUE. Se comprueba aquí en
    // JS porque es la afirmación de la que depende que la migración no aborte al aplicarse.
    const cumple = (razonSocial: string | null, nombres: string | null, apellidos: string | null) =>
      razonSocial === null || (nombres === null && apellidos === null);
    expect(cumple(null, null, null), 'fila legacy del sync').toBe(true);
    expect(cumple(null, 'JUANA', 'PEREZ'), 'persona natural del canal').toBe(true);
    expect(cumple('TRANSPORTES SAS', null, null), 'persona jurídica del canal').toBe(true);
    expect(cumple('TRANSPORTES SAS', 'JUANA', null), 'las dos cosas a la vez → 23514').toBe(false);
    expect(cumple('TRANSPORTES SAS', null, 'PEREZ'), 'las dos cosas a la vez → 23514').toBe(false);
  });

  it('**no añade el recíproco** (`tipo_documento=NIT ⇒ razon_social NOT NULL`), y es deliberado', () => {
    // Bloquearía a un futuro escritor del sync que rellene `tipo_documento` sin razón social. La
    // mitad positiva la exige Zod en la única ruta que escribe estas columnas.
    //
    // Se mira el CHECK y no el archivo entero a propósito: `tipo_documento` aparece dentro de un
    // `COMMENT ON COLUMN`, que es una CADENA SQL y no un comentario `--`, así que `podarComentarios`
    // la conserva —correctamente— y un aserto sobre todo el texto sería rojo por la prosa.
    const check = /ADD CONSTRAINT\s+flito_compradores_titular_chk\s+CHECK\s*\(([^;]*)\)\s*;/i.exec(SQL);
    expect(check, 'no se encontró el CHECK del titular').not.toBeNull();
    expect(check![1]).not.toMatch(/tipo_documento/i);
  });

  it('un solo CONSTRAINT nuevo: no se cuela otro en la misma migración', () => {
    const adds = SQL.match(/ADD CONSTRAINT/gi) ?? [];
    expect(adds).toHaveLength(1);
  });
});

describe('paridad 0172 ↔ schema.ts', () => {
  const columnas = (t: Parameters<typeof getTableConfig>[0]) =>
    new Map(getTableConfig(t).columns.map((c) => [c.name, c]));

  it('`vehicles` declara las dos columnas, nullable y de tipo TEXTO', () => {
    const cols = columnas(vehicles);
    for (const nombre of ['pasajeros_sentados', 'puertas']) {
      const c = cols.get(nombre);
      expect(c, `${nombre} no está en schema.ts`).toBeDefined();
      expect(c!.notNull, `${nombre} no puede ser NOT NULL`).toBe(false);
      expect(c!.hasDefault, `${nombre} no puede traer DEFAULT`).toBe(false);
      // Texto y no integer, por la razón escrita en la 0166: `"0"`, `"05"` y `""` son valores
      // distinguibles que un integer colapsa o rechaza con 22P02 a mitad de un alta.
      expect(c!.getSQLType()).toMatch(/^varchar/);
    }
  });

  it('`flito_compradores` declara las cinco columnas, nullable', () => {
    const cols = columnas(flitoCompradores);
    for (const nombre of ['nombres', 'apellidos', 'razon_social', 'municipio', 'departamento']) {
      const c = cols.get(nombre);
      expect(c, `${nombre} no está en schema.ts`).toBeDefined();
      expect(c!.notNull, `${nombre} no puede ser NOT NULL`).toBe(false);
      expect(c!.hasDefault, `${nombre} no puede traer DEFAULT`).toBe(false);
    }
  });

  it('**el CHECK está declarado también en Drizzle** (lección de la 0157)', () => {
    const chks = getTableConfig(flitoCompradores).checks.map((c) => c.name);
    expect(chks).toContain('flito_compradores_titular_chk');
    // Y el de la 0167 sigue ahí: esta HU añade, no sustituye.
    expect(chks).toContain('flito_compradores_padre_chk');
  });

  it('`nombre_completo` sigue NOT NULL: es un derivado, no una columna que se pueda dejar vacía', () => {
    expect(columnas(flitoCompradores).get('nombre_completo')!.notNull).toBe(true);
  });
});

describe('la 0171 no se reescribe: ya está aplicada y su sha registrado', () => {
  it('conserva el `DROP NOT NULL` y el backfill que la definen', () => {
    const previa = podarComentarios(leer('0171_flito_soat_organismo_nullable_verificacion.sql'));
    expect(previa).toMatch(/ALTER TABLE\s+flito_soat\s+ALTER COLUMN\s+organismo_codigo\s+DROP NOT NULL/i);
    expect(previa).toMatch(/SET\s+verificacion_estado = 'ok'/i);
    // Y la 0172 no la contradice: `organismo_codigo` sigue nullable en Drizzle, porque el organismo
    // NO vuelve a ser compuerta (AC5 de la #11966).
    expect(previa).not.toMatch(/pasajeros_sentados|razon_social/i);
  });
});
