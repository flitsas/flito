// Qué valor quedó ligado a QUÉ comparación del SQL renderizado.
//
// Nace de una aserción que pasaba sin comprobar lo que decía (HU #11916). Un test del aislamiento
// del canal Cliente afirmaba la frontera así:
//
//     expect(sql).toContain('"flito_soat"."origen" =');
//     expect(params).toContain('cliente');
//
// Las dos líneas son ciertas a la vez aunque la condición compare `origen` contra OTRA cosa: basta
// con que el literal `'cliente'` esté enlazado en cualquier otro punto del mismo WHERE —y en la cola
// del canal hay varios— para que `toContain` pase. Es la misma clase de verde vacío que el gate ya
// encontró cinco veces en esta cadena: la aserción mira el conjunto, no la posición.
//
// `PgDialect.sqlToQuery()` devuelve el SQL con marcadores posicionales (`$1`, `$2`, …) y el array de
// parámetros en ese mismo orden, así que la posición SÍ está disponible: solo hay que leerla.

import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const dialecto = new PgDialect();

export interface SqlRenderizado {
  sql: string;
  params: unknown[];
}

/** El SQL que Postgres recibiría, con sus parámetros en orden. */
export function renderizar(condicion: SQL): SqlRenderizado {
  const q = dialecto.sqlToQuery(condicion);
  return { sql: q.sql, params: q.params as unknown[] };
}

const escapar = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Los valores ligados a la comparación de ESTA columna: `col = $N` o `col in ($N, $M, …)`.
 *
 * Lanza si la columna no aparece comparada. Es deliberado: devolver `[]` haría que un
 * `expect(...).not.toContain(x)` pasara también cuando la condición entera desapareció del código,
 * que es justo el mutante que estas pruebas tienen que atrapar.
 */
export function ligadosA(q: SqlRenderizado, columna: string): unknown[] {
  const col = escapar(columna);
  const igualdad = new RegExp(`${col}\\s*=\\s*\\$(\\d+)`).exec(q.sql);
  if (igualdad) return [q.params[Number(igualdad[1]) - 1]];

  const lista = new RegExp(`${col}\\s+in\\s*\\(([^)]*)\\)`, 'i').exec(q.sql);
  if (lista) {
    return [...lista[1].matchAll(/\$(\d+)/g)].map((m) => q.params[Number(m[1]) - 1]);
  }
  throw new Error(`El SQL no compara ${columna}. Recibido:\n${q.sql}`);
}

/** Azúcar para el caso de un solo valor. */
export function ligadoA(q: SqlRenderizado, columna: string): unknown {
  const vs = ligadosA(q, columna);
  if (vs.length !== 1) throw new Error(`${columna} tiene ${vs.length} valores ligados, no uno`);
  return vs[0];
}

// ── El invariante del GROUP BY (Bug #12058) ────────────────────────────────
//
// PostgreSQL decide si una expresión proyectada está agrupada comparando el ÁRBOL de la consulta, no
// el valor que los parámetros acabarán llevando: `COALESCE(codigo, $12)` en el SELECT y
// `COALESCE(codigo, $13)` en el GROUP BY son expresiones DISTINTAS aunque los dos parámetros valgan
// lo mismo, y la consulta entera se rechaza con `42803`. Y es facilísimo llegar ahí sin querer,
// porque Drizzle no deduplica: cada interpolación de un literal es un parámetro NUEVO.
//
// Sobre el TEXTO del SQL el fallo es invisible —las dos interpolaciones se leen idénticas—, así que
// esto se afirma sobre la consulta RENDERIZADA, que es donde los placeholders ya están numerados. En
// el CI no hay PostgreSQL (ningún workflow levanta base), y esta es la única forma de que la clase de
// error quede vigilada en la suite en vez de descubrirse en un 500.

/** Una expresión del `GROUP BY` que el motor no puede casar con nada de la proyección. */
export interface GrupoHuerfano {
  /** La expresión del `GROUP BY`, tal como quedó renderizada. */
  expresion: string;
  /** Contra qué se comparó: la lista del `SELECT` de ese mismo nivel. */
  proyeccion: string[];
}

/**
 * Las expresiones del `GROUP BY` que NO son ninguna de la lista del `SELECT` ni una referencia
 * ordinal — es decir, las que PostgreSQL rechazaría con `42803`.
 *
 * Es el invariante, no la implementación: agrupar por `1, 2`, por el nombre de una columna ya
 * normalizada en una pata anterior, o repitiendo la MISMA expresión, son tres formas válidas, y
 * refactorizar de una a otra no rompe esto. Lo único que sale en la lista es la divergencia real.
 *
 * Comparación en minúsculas y con los espacios colapsados: `COALESCE` y `coalesce` son el mismo nodo
 * para el motor. Los placeholders NO se normalizan — son justo lo que tiene que coincidir.
 *
 * **Lanza si no encuentra ni un `GROUP BY` que analizar**, en vez de devolver `[]`. Es la misma
 * doctrina que `ligadosA` y por el mismo motivo: `expect(gruposHuerfanos(q)).toEqual([])` pasaría
 * IGUAL si el `GROUP BY` desapareció de la consulta o si el analizador de aquí abajo dejó de verlo,
 * y entonces el aserto estaría verde sin haber comprobado nada. Este archivo es la guarda de un Bug
 * que existió justamente porque tres asertos verdes convivieron con un endpoint que respondía 500
 * desde el primer día; un verde vacío DENTRO de esa guarda sería el mismo fallo otra vez. El
 * llamador que quiera afirmar «esta consulta no agrupa» tiene la aserción de texto para eso.
 */
export function gruposHuerfanos(q: SqlRenderizado): GrupoHuerfano[] {
  const bloques = bloquesAgrupados(q.sql);
  if (bloques.length === 0) {
    throw new Error(
      'No hay ni un GROUP BY que analizar: se esperaba al menos una cláusula GROUP BY con la lista '
      + 'del SELECT de su mismo nivel. O la consulta dejó de agrupar, o el analizador dejó de verla. '
      + `SQL recibido:\n${q.sql}`,
    );
  }

  const huerfanos: GrupoHuerfano[] = [];
  for (const { grupos, selects } of bloques) {
    const proyectadas = new Set(selects.flatMap((s) => {
      const { expresion, alias } = partirAlias(s);
      // El alias cuenta: PostgreSQL admite agrupar por el nombre de salida de la proyección.
      return alias ? [normalizar(expresion), normalizar(alias)] : [normalizar(expresion)];
    }));
    for (const g of grupos) {
      const n = normalizar(g);
      if (/^\d+$/.test(n) || proyectadas.has(n)) continue;
      huerfanos.push({ expresion: g.trim(), proyeccion: selects.map((s) => s.trim()) });
    }
  }
  return huerfanos;
}

/**
 * Cuántas veces está ligado un valor. Un literal interpolado dos veces son DOS parámetros.
 *
 * Lanza con la lista de parámetros VACÍA, por lo mismo que `gruposHuerfanos` lanza sin `GROUP BY`:
 * contar apariciones en una consulta que no ligó ni un valor siempre da `0`, y un
 * `expect(vecesLigado(q, x)).toBe(0)` —la forma natural de escribir «este literal ya no viaja»—
 * quedaría verde también cuando lo que se rompió fue el renderizado. Con `toBe(1)`, que es como se
 * usa hoy, el fallo sí se vería; la guarda está para que la SIGUIENTE aserción tampoco pueda mentir.
 */
export function vecesLigado(q: SqlRenderizado, valor: unknown): number {
  if (q.params.length === 0) {
    throw new Error(
      'La consulta no ligó ni un parámetro: contar apariciones aquí siempre daría 0. '
      + `SQL recibido:\n${q.sql}`,
    );
  }
  return q.params.filter((p) => p === valor).length;
}

const normalizar = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** `expr AS nombre` → las dos partes. Sin `AS`, la expresión entera. */
function partirAlias(s: string): { expresion: string; alias: string | null } {
  const m = /^([\s\S]+?)\s+as\s+("?[a-z_][a-z0-9_]*"?)\s*$/i.exec(s.trim());
  return m ? { expresion: m[1]!, alias: m[2]!.replace(/"/g, '') } : { expresion: s, alias: null };
}

/**
 * El mapa del SQL carácter a carácter: en qué nivel de paréntesis está cada uno y cuál NO es
 * estructura (va dentro de una cadena o de un comentario).
 *
 * Se calcula una vez y de ahí sale todo lo demás. Sin él, un `indexOf('GROUP BY')` leería comas de
 * dentro de un `COALESCE(...)`, palabras clave escritas dentro de un literal —la consulta de la
 * bandeja tiene un `IN ('fallido', 'no_realizado')`— o texto de un comentario como si fueran
 * estructura de la consulta.
 */
interface Mapa {
  nivel: number[];
  opaco: boolean[];
}

function mapear(sql: string): Mapa {
  const nivel: number[] = new Array(sql.length).fill(0);
  const opaco: boolean[] = new Array(sql.length).fill(false);
  let n = 0;

  for (let i = 0; i < sql.length; i += 1) {
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length) {
        // `''` dentro de una cadena es una comilla escapada, no el cierre.
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") break;
        j += 1;
      }
      for (let k = i; k <= Math.min(j, sql.length - 1); k += 1) { nivel[k] = n; opaco[k] = true; }
      i = j;
      continue;
    }
    if (sql[i] === '-' && sql[i + 1] === '-') {
      let j = i;
      while (j < sql.length && sql[j] !== '\n') { nivel[j] = n; opaco[j] = true; j += 1; }
      i = j - 1;
      continue;
    }
    if (sql[i] === '(') { nivel[i] = n; n += 1; continue; }
    if (sql[i] === ')') { n -= 1; nivel[i] = n; continue; }
    nivel[i] = n;
  }
  return { nivel, opaco };
}

/** Dónde empieza cada aparición de una palabra clave que SÍ es estructura. */
function apariciones(sql: string, m: Mapa, palabra: RegExp): number[] {
  const salida: number[] = [];
  for (const x of sql.matchAll(new RegExp(palabra.source, 'gi'))) {
    const i = x.index;
    if (m.opaco[i]) continue;
    // Ni `casos.select` ni `xgroup by`: la palabra tiene que empezar de verdad.
    if (i > 0 && /[a-z0-9_$."]/i.test(sql[i - 1]!)) continue;
    salida.push(i);
  }
  return salida;
}

/** Palabras que cierran la lista del `SELECT` y la del `GROUP BY` en su mismo nivel. */
const CIERRA_SELECT = /(from|union|intersect|except)\b/;
const CIERRA_GRUPO = /(having|order\s+by|limit|offset|window|union|intersect|except)\b/;

/** El final de una lista abierta en `desde`: la palabra que cierre, o la salida del paréntesis. */
function finDeLista(sql: string, m: Mapa, desde: number, cierra: RegExp): number {
  const nivel = m.nivel[desde]!;
  const palabra = apariciones(sql, m, cierra).find((i) => i > desde && m.nivel[i] === nivel);
  let fin = palabra ?? sql.length;
  for (let i = desde; i < fin; i += 1) {
    if (!m.opaco[i] && m.nivel[i]! < nivel) { fin = i; break; }
  }
  return fin;
}

/**
 * Cada `GROUP BY` de la consulta con la lista del `SELECT` de SU nivel de paréntesis.
 *
 * El nivel importa: un CTE o una subconsulta tienen proyección propia, y casar un `GROUP BY` de
 * dentro contra el `SELECT` de fuera daría por bueno justo lo que el motor rechaza.
 */
function bloquesAgrupados(sql: string): Array<{ selects: string[]; grupos: string[] }> {
  const m = mapear(sql);
  const selects = apariciones(sql, m, /select\b/).map((i) => ({
    desde: i,
    nivel: m.nivel[i]!,
    lista: partir(sql, m, i + 'select'.length, finDeLista(sql, m, i, CIERRA_SELECT)),
  }));

  return apariciones(sql, m, /group\s+by\b/).map((i) => {
    const largo = /^group\s+by/i.exec(sql.slice(i))![0].length;
    // El `SELECT` dueño de este `GROUP BY` es el último de su mismo nivel abierto antes que él.
    const dueño = [...selects].reverse().find((s) => s.desde < i && s.nivel === m.nivel[i]);
    return {
      selects: dueño?.lista ?? [],
      grupos: partir(sql, m, i + largo, finDeLista(sql, m, i, CIERRA_GRUPO)),
    };
  });
}

/** Parte un tramo por sus comas de PRIMER nivel: `COALESCE(a, b)` es UN elemento, no dos. */
function partir(sql: string, m: Mapa, desde: number, hasta: number): string[] {
  const nivel = m.nivel[desde] ?? 0;
  const partes: string[] = [];
  let inicio = desde;
  for (let i = desde; i < hasta; i += 1) {
    if (sql[i] === ',' && !m.opaco[i] && m.nivel[i] === nivel) {
      partes.push(sql.slice(inicio, i));
      inicio = i + 1;
    }
  }
  partes.push(sql.slice(inicio, hasta));
  return partes.map((p) => p.replace(/--[^\n]*/g, ' ').trim()).filter((p) => p !== '');
}
