// FLITO comparendos — paridad entre la 0156 y `schema.ts` (HU #11557).
//
// La 0156 añade el `CHECK` que la 0154 dejó escrito como pendiente suyo: «o las dos columnas del
// sello de gestión puestas, o las dos nulas». Ese hecho vive en dos sitios —el `.sql`, que es lo que
// corre contra la base en `db:apply`, y `schema.ts`, que es lo que lee quien escribe una consulta— y
// hasta este archivo nada vigilaba que dijeran lo mismo.
//
// Qué mutación se está cazando. Ninguna de las obvias:
//
//   · **el CHECK formulado contra `causal_id` u `observacion`.** Es el error natural de quien lo lea
//     de pasada («si no hay gestión, ¿para qué el sello?») y rompería el AC2 en producción:
//     LIMPIAR la causal y la observación es un acto, deja autor y fecha, y con ese CHECK la base lo
//     rechazaría con un 23514. El test afirma qué columnas puede nombrar la expresión, no solo que
//     exista.
//
//   · **el CHECK relajado a una implicación sola** (`por IS NULL OR en IS NOT NULL`). Sigue siendo
//     un CHECK válido, sigue impidiendo una de las dos mitades y deja pasar la otra —la fecha sin
//     autor, que es justo la que el `ON DELETE RESTRICT` de la 0154 existe para impedir (ADR-0005)—.
//     Por eso se compara la expresión NORMALIZADA contra la forma esperada, en los dos lados y
//     contra el valor esperado, no un lado contra el otro: cambiarlo en los dos archivos a la vez
//     tampoco pasa.
//
//   · **la pérdida de la guarda de idempotencia.** PostgreSQL no admite `ADD CONSTRAINT IF NOT
//     EXISTS`, así que sin el `DO $$ ... IF NOT EXISTS (SELECT 1 FROM pg_constraint ...)` la segunda
//     pasada abortaría con un 42710 y dejaría parada la cadena de migraciones en cualquier ambiente
//     que vaya por detrás.
//
// La 0156 no se reescribe una vez aplicada (regla del repo): si este test se pone rojo, lo que toca
// es una migración NUEVA o corregir el otro lado, según de qué lado esté el error.
//
// Análisis estático puro: NO toca la base. El `.sql` se lee de disco y de `schema.ts` se importan los
// objetos de drizzle.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import { flitoComparendosRegistros } from '../../src/db/schema.js';
// El guarda de ADR-DB-001 tal como lo aplica el runner, no una reimplementación: es literalmente lo
// que abortaría el `db:apply`, incluida su forma de ignorar los bloques `$$ ... $$` —que aquí
// importa, porque este archivo SÍ tiene uno y su `BEGIN`/`END` no es control de transacción—.
import { scanForTxControl } from '../../src/scripts/db-apply.js';

const ARCHIVO = '0156_flito_comparendos_gestion_check.sql';
const RUTA = fileURLToPath(new URL(`../../src/db/migrations/${ARCHIVO}`, import.meta.url));

const CONSTRAINT = 'flito_comparendos_gestion_auditoria_chk';
const TABLA = 'flito_comparendos_registros';
const COLUMNAS = ['gestion_actualizada_en', 'gestion_actualizada_por'] as const;

const sql0156 = readFileSync(RUTA, 'utf8');

/**
 * Quita los comentarios `--` conservando los saltos de línea, sin comerse los `--` que viven DENTRO
 * de una cadena SQL (el `COMMENT ON CONSTRAINT` de este archivo es un literal largo).
 *
 * Es el mismo podador de la paridad de la 0154 y por el mismo motivo: la cabecera explica en prosa
 * lo que el archivo NO hace —por qué no hay `NOT VALID`, por qué no es un `ALTER TABLE` pelado— y
 * sin podarla, la explicación de cómo no es alimentaría la comprobación de cómo es.
 */
function podarComentarios(texto: string): string {
  let salida = '';
  let enCadena = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (!enCadena && c === '-' && texto[i + 1] === '-') {
      while (i < texto.length && texto[i] !== '\n') i++;
      salida += '\n';
      continue;
    }
    if (c === "'") enCadena = !enCadena;
    salida += c;
  }
  return salida;
}

const CUERPO = podarComentarios(sql0156).replace(/\s+/g, ' ').trim();

/**
 * La expresión del CHECK, normalizada a algo comparable entre el `.sql` y drizzle.
 *
 * Los dos lados escriben lo mismo de forma distinta —drizzle cualifica las columnas con el nombre
 * de la tabla entre comillas y respeta las mayúsculas del literal `is null`—, así que se compara sin
 * comillas, sin el prefijo de tabla, en minúsculas y sin espacios sobrantes. Lo que NO se normaliza
 * es la forma lógica: `=` entre dos predicados y `OR` de dos conjunciones seguirían siendo distintos,
 * y tienen que serlo (la segunda forma es la puerta por donde entra la versión relajada).
 */
function normalizar(expresion: string): string {
  return expresion
    .replace(/"/g, '')
    .replace(new RegExp(`${TABLA}\\.`, 'g'), '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

const ESPERADA = '(gestion_actualizada_en is null) = (gestion_actualizada_por is null)';

// ─────────────────────────── Lectura del `.sql` ─────────────────────────────────────────────────

/** La expresión tal como la escribe la migración, sacada de su `ADD CONSTRAINT ... CHECK (...)`. */
function expresionDelSql(): string {
  const m = new RegExp(`ADD CONSTRAINT ${CONSTRAINT} CHECK \\((.+?)\\); END IF`, 'i').exec(CUERPO);
  // Extractor estricto a propósito: una forma que no se entienda tiene que FALLAR, no ignorarse. Un
  // extractor permisivo da verde sobre un eje que ya no está mirando.
  expect(m, `no se supo leer el CHECK de ${CONSTRAINT} en ${ARCHIVO}`).not.toBeNull();
  return m![1];
}

/** La expresión según `schema.ts`, serializada con el mismo dialecto que usaría el driver. */
function expresionDelSchema(): string {
  const chequeos = getTableConfig(flitoComparendosRegistros).checks;
  const nuestro = chequeos.find((c) => c.name === CONSTRAINT);
  expect(nuestro, `\`schema.ts\` no declara el check ${CONSTRAINT}`).toBeDefined();
  return new PgDialect().sqlToQuery(nuestro!.value).sql;
}

// ─────────────────────────── Guardarraíl: ¿el extractor leyó algo? ──────────────────────────────

describe('migración 0156 — el extractor lee el archivo', () => {
  // Va primero: si el regex dejara de casar, todas las comparaciones de abajo pasarían por vacuidad.
  it('el .sql declara el CHECK y de él sale una expresión', () => {
    expect(CUERPO.length).toBeGreaterThan(0);
    expect(expresionDelSql().length).toBeGreaterThan(0);
  });

  it('`schema.ts` declara un check con ese mismo nombre sobre esa misma tabla', () => {
    expect(getTableConfig(flitoComparendosRegistros).name).toBe(TABLA);
    expect(expresionDelSchema().length).toBeGreaterThan(0);
  });
});

// ─────────────────────────── Paridad de la restricción ──────────────────────────────────────────

describe('el CHECK dice lo mismo en la migración y en `schema.ts`', () => {
  it('**la expresión es la esperada en los DOS lados**, no un lado comparado con el otro', () => {
    // Contra el valor esperado: un `git merge` que relajara la condición en los dos archivos a la
    // vez dejaría verde cualquier comparación entre copias.
    expect(normalizar(expresionDelSql())).toBe(ESPERADA);
    expect(normalizar(expresionDelSchema())).toBe(ESPERADA);
  });

  it('**la expresión solo puede nombrar las dos columnas del sello**', () => {
    // El error que este test existe para cazar: atar el sello a `causal_id` u `observacion` haría
    // que LIMPIAR la gestión —que también deja autor y fecha (AC2, RN-38)— muriera con un 23514.
    for (const lado of [
      { que: ARCHIVO, expresion: normalizar(expresionDelSql()) },
      { que: 'schema.ts', expresion: normalizar(expresionDelSchema()) },
    ]) {
      for (const columna of COLUMNAS) expect(lado.expresion).toContain(columna);
      expect(lado.expresion, `el CHECK de ${lado.que} nombra causal_id`).not.toContain('causal_id');
      expect(lado.expresion, `el CHECK de ${lado.que} nombra observacion`).not.toContain('observacion');
      expect(lado.expresion, `el CHECK de ${lado.que} nombra estado`).not.toContain('estado');
    }
  });
});

// ─────────────────────────── Invariantes del archivo (ADR-DB-001) ───────────────────────────────

describe('la 0156 como archivo: lo que puede y lo que no puede contener', () => {
  it('**no declara control de transacción** — con el guarda REAL del runner', () => {
    // El `BEGIN`/`END` del bloque `DO $$` no lo es, y esta es la única forma de afirmarlo sin
    // reimplementar (y ablandar) el regex del runner.
    expect(scanForTxControl(ARCHIVO, sql0156)).toEqual([]);
  });

  it('**lleva su guarda de idempotencia**: PostgreSQL no tiene `ADD CONSTRAINT IF NOT EXISTS`', () => {
    expect(CUERPO).toMatch(/IF NOT EXISTS \( SELECT 1 FROM pg_constraint WHERE conname = '[a-z0-9_]+' \)/i);
    // Y la guarda protege al constraint que de verdad se crea, no a otro nombre parecido: un
    // `conname` desalineado con el `ADD CONSTRAINT` haría que la segunda pasada abortara igual.
    const guardado = /WHERE conname = '([a-z0-9_]+)'/i.exec(CUERPO);
    expect(guardado![1]).toBe(CONSTRAINT);
  });

  it('**no es DML**: no siembra, no corrige y no reescribe una sola fila', () => {
    const cuerpo = CUERPO.toUpperCase();
    expect(cuerpo).not.toMatch(/\bINSERT\s+INTO\b/);
    expect(cuerpo).not.toMatch(/\bDELETE\s+FROM\b/);
    expect(cuerpo).not.toMatch(/\bUPDATE\s+[A-Z0-9_]+\s+SET\b/);
  });

  it('**no añade `NOT VALID`**: las filas existentes tienen las dos columnas en NULL', () => {
    // `NOT VALID` + `VALIDATE` solo tiene sentido en DOS transacciones, y el runner envuelve el
    // archivo en una. Dejarlo `NOT VALID` aquí sería quedarse con una restricción que no responde
    // por lo que ya está en la tabla, a cambio de nada.
    expect(CUERPO.toUpperCase()).not.toContain('NOT VALID');
  });

  it('no crea índices ni toca columnas: la forma la fijó la 0154', () => {
    expect(CUERPO.toUpperCase()).not.toMatch(/\bCREATE\s+(UNIQUE\s+)?INDEX\b/);
    expect(CUERPO.toUpperCase()).not.toMatch(/\bADD COLUMN\b/);
    expect(CUERPO.toUpperCase()).not.toMatch(/\bDROP\b/);
  });
});
