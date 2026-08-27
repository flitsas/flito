// FLITO comparendos — paridad entre los índices de la 0153 y los de `schema.ts` (HU #11555).
//
// La migración `0153_flito_comparendos_indices_filtro.sql` crea tres índices sobre
// `flito_comparendos_registros` y `schema.ts` los declara OTRA VEZ en la API de drizzle. Son dos
// copias del mismo hecho en dos lenguajes distintos —el `.sql` es lo que realmente corre contra la
// base en `db:apply`, el `schema.ts` es lo que lee quien escribe una consulta y lo que diría un
// `drizzle-kit` si algún día se le preguntara— y hasta ahora nada vigilaba que siguieran diciendo
// lo mismo.
//
// Qué mutación se está cazando. No la obvia (borrar un índice de un lado se nota), sino la que deja
// el índice SINTÁCTICAMENTE VÁLIDO y FUNCIONALMENTE INÚTIL, que es la que nadie ve:
//
//   · que a `created_at` o a `id` se le caiga el `DESC` — o que se reordenen las columnas: el orden
//     y la dirección son exactamente lo que hace que el índice sirva el `ORDER BY created_at DESC,
//     id DESC` del cursor (RN-32). Con la cola cambiada el índice sigue acotando, pero el plan
//     recupera el nodo de `Sort` y vuelve a leer y ordenar el municipio entero en cada página.
//
//   · que el tercero pierda su `WHERE causal_id IS NULL`. Ese índice es PARCIAL por una razón que
//     no se adivina leyendo el código: `IS NULL` no fija la primera columna por IGUALDAD, así que
//     el índice compuesto de `causal_id` entrega el filtro pero NO el orden, y el `Sort` sobrevive
//     a cualquier plan (ni forzándolo a mano desaparece). Medido sobre 200.000 filas con el 85% sin
//     clasificar: 43 ms y 6.343 buffers sin el parcial, 0,14 ms y 7 buffers con él. Un `WHERE` que
//     se cae en un `git merge` no rompe ninguna consulta: solo la hace 300 veces más lenta.
//
// La 0153 no se reescribe una vez aplicada (regla del repo): si este test se pone rojo, lo que toca
// es una migración NUEVA o corregir `schema.ts`, según de qué lado esté el error.
//
// El test es análisis estático puro: NO toca la base. El `.sql` se lee de disco a propósito —copiar
// aquí las tres definiciones crearía una TERCERA copia y el problema volvería una casilla más
// allá— y del `schema.ts` se importan las declaraciones de drizzle, que son objetos en memoria.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { is, SQL } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { flitoComparendosRegistros } from '../../src/db/schema.js';

const RUTA_MIGRACION = fileURLToPath(
  new URL('../../src/db/migrations/0153_flito_comparendos_indices_filtro.sql', import.meta.url),
);

const TABLA = 'flito_comparendos_registros';

/**
 * Los tres índices que introduce la 0153.
 *
 * Hace falta enumerarlos —y solo esto— porque `schema.ts` declara sobre la MISMA tabla los índices
 * de la 0150 y de la 0152, que no viven en este `.sql`: sin acotar, la comparación exigiría que el
 * archivo de la 0153 contuviera índices que no le tocan. No es una copia de las definiciones: de
 * los nombres para adentro (columnas, orden, dirección, predicado) todo sale de los dos archivos.
 */
const INDICES_0153 = [
  'idx_flito_comparendos_municipio_creado',
  'idx_flito_comparendos_causal_creado',
  'idx_flito_comparendos_sin_causal_creado',
] as const;

/**
 * El de la 0153 que ya NO existe: la 0165 lo borró (HU #11878).
 *
 * El filtro por municipio se mudó de `municipio_fuente` a `municipio_comparendo`, así que este
 * índice se quedó sin su único consumidor y su sustituto vive en la 0165 con su propia paridad. La
 * 0153 se conserva intacta —es historial aplicado, y editarla haría que el `.sql` mintiera sobre lo
 * que hay en cualquier ambiente que ya la corrió—, de modo que este archivo tiene que declarar los
 * TRES y esperar solo DOS en `schema.ts`. Que esté aquí y no borrado del array es lo que permite
 * seguir afirmando la retirada en vez de dejar de mirar.
 */
const RETIRADO_POR_0165 = 'idx_flito_comparendos_municipio_creado';
/** Los de la 0153 que siguen vivos, que son los que tienen que estar en los dos sitios. */
const INDICES_VIGENTES = INDICES_0153.filter((n) => n !== RETIRADO_POR_0165);

type ColumnaIndexada = { columna: string; direccion: 'ASC' | 'DESC' };

type IndiceNormalizado = {
  nombre: string;
  tabla: string;
  columnas: ColumnaIndexada[];
  /** Predicado del índice parcial ya normalizado, o `null` si el índice es total. */
  parcial: string | null;
};

/**
 * Deja un fragmento de SQL en una forma comparable entre los dos lados: sin comillas ni
 * calificación por tabla (drizzle renderiza `"tabla"."columna"`, el `.sql` escribe `columna` a
 * secas), sin espacios de más y en minúsculas. Lo que queda —`causal_id is null`— es el HECHO, que
 * es lo único que este test compara.
 */
function normalizarSql(fragmento: string): string {
  return fragmento
    .replace(/"[a-z0-9_]+"\."/gi, '"')
    .replace(/"/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Una columna del `.sql`, tal cual: `created_at DESC` → `{ columna: 'created_at', direccion: 'DESC' }`.
 *
 * Deliberadamente ESTRICTA: si aparece cualquier cosa que no sea `columna [ASC|DESC]` —`NULLS
 * FIRST`, una clase de operador, una expresión— el test falla en vez de ignorarla en silencio. Un
 * extractor permisivo es peor que ninguno: daría verde sobre un eje que ya no está mirando.
 */
function columnaDelSql(fragmento: string): ColumnaIndexada {
  const bruto = normalizarSql(fragmento);
  const m = bruto.match(/^([a-z0-9_]+)(?:\s+(asc|desc))?$/);

  expect(
    m,
    `no se supo leer la columna '${bruto}' de un índice de la 0153: este extractor solo entiende `
    + '`columna [ASC|DESC]`. Si la migración usa una forma nueva, hay que enseñársela aquí (y no '
    + 'tocar la migración, que ya está aplicada)',
  ).not.toBeNull();

  return { columna: m![1], direccion: m![2] === 'desc' ? 'DESC' : 'ASC' };
}

/** Los `CREATE INDEX` de la migración, leídos del archivo. */
function indicesDelSql(sql: string): IndiceNormalizado[] {
  // Los comentarios se quitan ANTES: la cabecera de la 0153 habla en prosa de `CREATE INDEX
  // CONCURRENTLY` y transcribe el `ORDER BY` de la consulta. Sin esta poda, la explicación de por
  // qué el índice es así alimentaría la comparación de cómo es.
  const sinComentarios = sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

  const sentencias = [...sinComentarios.matchAll(
    /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([a-z0-9_]+)\s+ON\s+([a-z0-9_]+)\s*\(([^)]*)\)([^;]*);/gi,
  )];

  return sentencias.map(([, nombre, tabla, columnas, cola]) => {
    const where = cola.match(/\bWHERE\b(.+)/is);
    return {
      nombre: nombre.toLowerCase(),
      tabla: tabla.toLowerCase(),
      columnas: columnas.split(',').map(columnaDelSql),
      parcial: where ? normalizarSql(where[1]) : null,
    };
  });
}

/** Cómo llega una columna de índice desde drizzle: `desc(col)` como `SQL`, una columna a pelo no. */
type ColumnaDrizzle = SQL | { name: string; indexConfig?: { order?: 'asc' | 'desc' } };

/** Los índices declarados en `schema.ts`, leídos de los objetos de drizzle (no del texto). */
function indicesDelSchema(): IndiceNormalizado[] {
  const dialecto = new PgDialect();
  const config = getTableConfig(flitoComparendosRegistros);

  return config.indexes.map((idx) => {
    // drizzle tipa `config` como PARCIAL porque el builder se llena por pasos (`.on()`, `.where()`);
    // en una tabla ya construida el nombre y las columnas están siempre puestos, así que el tipo se
    // estrecha aquí, una sola vez y a la vista, en vez de a base de `!` repartidos.
    const c = idx.config as { name: string; columns: ColumnaDrizzle[]; where?: SQL };
    return {
      nombre: c.name.toLowerCase(),
      tabla: config.name.toLowerCase(),
      // `desc(t.createdAt)` no llega como columna sino como un `SQL` que drizzle renderiza
      // `"tabla"."columna" desc`; una columna a pelo llega como `IndexedColumn` y su dirección
      // vive en `indexConfig.order`. Los dos caminos terminan en el mismo `{ columna, direccion }`
      // para que la comparación con el `.sql` sea la misma en los dos casos.
      columnas: c.columns.map((col) => (
        is(col, SQL)
          ? columnaDelSql(dialecto.sqlToQuery(col).sql)
          : {
            columna: col.name.toLowerCase(),
            direccion: (col.indexConfig?.order === 'desc' ? 'DESC' : 'ASC') as 'ASC' | 'DESC',
          }
      )),
      parcial: c.where ? normalizarSql(dialecto.sqlToQuery(c.where).sql) : null,
    };
  });
}

/** `['municipio_fuente ASC', 'created_at DESC', 'id DESC']` — el orden del array ES parte del dato. */
function firma(columnas: ColumnaIndexada[]): string[] {
  return columnas.map((c) => `${c.columna} ${c.direccion}`);
}

const delSql = indicesDelSql(readFileSync(RUTA_MIGRACION, 'utf8'));
const delSchema = indicesDelSchema();

const buscar = (indices: IndiceNormalizado[], nombre: string) => indices.find((i) => i.nombre === nombre);

describe('migración 0153 — los índices del SQL y los de schema.ts no pueden divergir (HU #11555)', () => {
  it('el .sql declara exactamente los tres índices de la HU (si esto falla, el resto no vigila nada)', () => {
    // Primero el extractor, después la paridad: un `matchAll` que dejara de casar devolvería una
    // lista vacía y TODAS las comparaciones de abajo pasarían por vacuidad.
    expect([...delSql].map((i) => i.nombre).sort()).toEqual([...INDICES_0153].sort());
    expect(delSql.every((i) => i.tabla === TABLA)).toBe(true);
    expect(delSql.every((i) => i.columnas.length > 0)).toBe(true);
  });

  describe.each(INDICES_VIGENTES)('%s', (nombre) => {
    it('está declarado en los dos sitios', () => {
      expect(buscar(delSql, nombre), `falta en ${RUTA_MIGRACION}`).toBeDefined();
      expect(buscar(delSchema, nombre), 'falta en apps/api/src/db/schema.ts').toBeDefined();
    });

    it('mismas columnas, en el mismo ORDEN y con la misma DIRECCIÓN', () => {
      // Un array y no un set: reordenar `(municipio_fuente, created_at, id)` produce un índice
      // válido que ya no sirve el `ORDER BY` del cursor, y perder un `DESC` hace lo mismo. Los dos
      // ejes tienen que fallar, y el diff del array dice cuál de los dos se movió.
      expect(firma(buscar(delSchema, nombre)!.columnas)).toEqual(firma(buscar(delSql, nombre)!.columnas));
    });

    it('coinciden en ser parcial (o no) y en el predicado', () => {
      expect(buscar(delSchema, nombre)!.parcial).toBe(buscar(delSql, nombre)!.parcial);
    });

    it('está sobre la misma tabla', () => {
      expect(buscar(delSchema, nombre)!.tabla).toBe(buscar(delSql, nombre)!.tabla);
      expect(buscar(delSql, nombre)!.tabla).toBe(TABLA);
    });
  });

  // Los tres `it` de arriba comparan un lado con el otro, así que una mutación aplicada A LOS DOS
  // —el caso del refactor bienintencionado que "limpia" el `DESC` o el `WHERE` en ambos archivos—
  // los dejaría a todos en verde. Estas dos invariantes son las que se le plantan a eso: no
  // comparan copias entre sí, sino cada copia contra el contrato de la HU.
  describe('invariantes funcionales (RN-32 / AC5), no solo paridad entre copias', () => {
    it('los tres terminan en (created_at DESC, id DESC) — es el keyset del cursor', () => {
      // El desempate por `id` no es adorno: es la segunda mitad del keyset. Sin él, dos altas de la
      // misma corrida comparten `created_at` y el empate se ordena fuera del índice, que es justo
      // donde el cursor repite o salta filas.
      for (const indice of [...delSql, ...delSchema].filter((i) => INDICES_0153.includes(i.nombre as typeof INDICES_0153[number]))) {
        expect(firma(indice.columnas).slice(-2), `cola del cursor rota en '${indice.nombre}'`)
          .toEqual(['created_at DESC', 'id DESC']);
      }
    });

    it('el parcial es exactamente uno, el de sinCausal, y filtra por causal_id IS NULL', () => {
      // Sin el `WHERE`, ese índice queda idéntico a un prefijo del de la causal y deja de servir
      // para lo que se creó: 43 ms y 6.343 buffers en vez de 0,14 ms y 7. Y al revés: si a los
      // otros dos les apareciera un predicado, dejarían de cubrir el listado completo del filtro.
      for (const lado of [{ nombre: 'la 0153', indices: delSql }, { nombre: 'schema.ts', indices: delSchema }]) {
        const parciales = lado.indices
          .filter((i) => INDICES_0153.includes(i.nombre as typeof INDICES_0153[number]) && i.parcial !== null)
          .map((i) => `${i.nombre}: ${i.parcial}`);

        expect(parciales, `predicados parciales en ${lado.nombre}`)
          .toEqual(['idx_flito_comparendos_sin_causal_creado: causal_id is null']);
      }
    });
  });

  // ── El índice que la 0165 retiró (HU #11878) ──────────────────────────────────────────────────
  //
  // Un índice que desaparece de `schema.ts` sin que nadie lo afirme se lee como un descuido: la
  // paridad de arriba se quedaría diciendo «falta en schema.ts» y el arreglo evidente —volver a
  // declararlo— reintroduciría un índice que ya no sirve a nadie. Estas dos aserciones convierten la
  // ausencia en una decisión escrita.
  describe(`${RETIRADO_POR_0165} — retirado por la 0165`, () => {
    it('la 0153 lo sigue creando: es historial aplicado y no se edita', () => {
      expect(buscar(delSql, RETIRADO_POR_0165), `falta en ${RUTA_MIGRACION}`).toBeDefined();
    });

    it('**y `schema.ts` ya NO lo declara**: su columna dejó de ser la del filtro', () => {
      expect(buscar(delSchema, RETIRADO_POR_0165)).toBeUndefined();
      // Con su sustituto en el sitio, para que la ausencia no pueda confundirse con haberse quedado
      // sin índice para el filtro por municipio.
      expect(buscar(delSchema, 'idx_flito_comparendos_municipio_comparendo_creado')).toBeDefined();
    });
  });
});
