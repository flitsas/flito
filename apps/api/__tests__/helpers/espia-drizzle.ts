// Espía de escrituras sobre el mock keyed de drizzle.
//
// El helper `keyed-db` responde por tabla, pero no cuenta QUÉ se escribió: `.values()` y `.set()`
// son passthrough. Sin eso, afirmar sobre un asiento obliga a mirar la fila que el propio test
// devolvió, que es una tautología. Esto envuelve los chains para registrar el payload real.
//
// También captura los parámetros del último `where`, que es lo único que permite a un resolver
// saber POR QUÉ LLAVE se está preguntando cuando una misma tabla se consulta con varios filtros.

import { getTableName } from 'drizzle-orm';
import type { KeyedDb } from './keyed-db.js';

export interface Mutacion {
  tabla: string;
  datos: Record<string, unknown>;
  /**
   * Valores enlazados del `where` de esta mutación.
   *
   * Sin esto, un UPDATE condicionado y uno sin condición son indistinguibles para el mock —que
   * ignora el filtro y devuelve lo que el test registró—, así que un test podría afirmar que una
   * carrera está resuelta cuando la condición que la resuelve ya no está en el código.
   */
  filtros: string[];
  /**
   * Condiciones `where` en crudo, tal como las construyó drizzle.
   *
   * `filtros` alcanza para «¿se filtró por esta llave?», pero no para «¿qué columnas y qué operadores
   * entraron en el WHERE?». Cuando eso importa —un UPDATE masivo cuya seguridad depende de una
   * condición concreta— el test las serializa con `PgDialect.sqlToQuery()` y afirma sobre el SQL real
   * en vez de sobre lo que el mock quiso devolver.
   */
  condiciones: unknown[];
}

export interface EspiaDrizzle {
  /** INSERT ejecutados, en orden. */
  inserts: Mutacion[];
  /** UPDATE ejecutados, en orden. */
  updates: Mutacion[];
  insertsEn: (tabla: string) => Mutacion[];
  updatesEn: (tabla: string) => Mutacion[];
  /** Payload del último INSERT en esa tabla, o `{}` si no hubo ninguno. */
  ultimoInsertEn: (tabla: string) => Record<string, unknown>;
  /** Tablas escritas, en orden: sirve para afirmar qué va antes de qué. */
  secuencia: () => string[];
  /** Valores enlazados del último `where` ejecutado. */
  filtros: () => string[];
  /** Valores enlazados de TODOS los `where` de la operación, aplanados. */
  filtrosUsados: () => string[];
  /**
   * Condiciones `where` de los SELECT, en crudo y en orden.
   *
   * `filtros`/`filtrosUsados` recogen los valores enlazados que `paramsDe` sabe reconocer, y hay
   * formas de construir un `sql` cuyos valores no quedan en un objeto con `.value` —una lista
   * interpolada con `sql.join`, por ejemplo—. Cuando lo que se prueba es el PREDICADO y no la llave
   * (una purga cuya corrección depende de cómo compara), el test serializa la condición con
   * `PgDialect.sqlToQuery()` y afirma sobre el SQL y los parámetros reales.
   */
  condicionesLeidas: () => unknown[];
  /** Limpia lo registrado y reinstala el espía. Llamar DESPUÉS de `kdb.reset()`. */
  reiniciar: () => void;
}

function nombreTabla(tbl: unknown): string {
  try { return getTableName(tbl as never); } catch { return '__expr__'; }
}

/**
 * Valores de los parámetros de una condición drizzle (`eq`, `and`, `like`…).
 *
 * Un `Param` guarda el valor en `.value`; los trozos de texto del SQL lo guardan como array, así que
 * quedarse con los strings sueltos deja exactamente los valores enlazados. Los números no se
 * recogen: se busca identificar llaves y periodos, que siempre son texto.
 */
export function paramsDe(cond: unknown): string[] {
  const out: string[] = [];
  const visitar = (n: unknown): void => {
    if (n === null || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(visitar); return; }
    const o = n as Record<string, unknown>;
    if (typeof o.value === 'string') out.push(o.value);
    if (Array.isArray(o.queryChunks)) o.queryChunks.forEach(visitar);
  };
  visitar(cond);
  return out;
}

/** Engancha el `where` de una mutación para dejar sus valores enlazados junto al payload. */
function anotarWhere(chain: Record<string, unknown>, m: Mutacion): void {
  const original = chain.where as (v: unknown) => unknown;
  chain.where = (cond: unknown) => {
    m.filtros.push(...paramsDe(cond));
    m.condiciones.push(cond);
    return original(cond);
  };
}

export function crearEspia(kdb: KeyedDb): EspiaDrizzle {
  const inserts: Mutacion[] = [];
  const updates: Mutacion[] = [];
  let ultimosFiltros: string[] = [];
  const historialFiltros: string[] = [];
  const condicionesDeSelect: unknown[] = [];

  function instalar(): void {
    const selectBase = kdb.select.getMockImplementation() as (...a: unknown[]) => Record<string, unknown>;
    kdb.select.mockImplementation((...args: unknown[]) => {
      const c = selectBase(...args);
      const original = c.where as (v: unknown) => unknown;
      c.where = (cond: unknown) => {
        ultimosFiltros = paramsDe(cond);
        historialFiltros.push(...ultimosFiltros);
        condicionesDeSelect.push(cond);
        return original(cond);
      };
      return c;
    });

    const insertBase = kdb.insert.getMockImplementation() as (t: unknown) => Record<string, unknown>;
    kdb.insert.mockImplementation((tbl: unknown) => {
      const c = insertBase(tbl);
      const original = c.values as (v: unknown) => unknown;
      c.values = (v: Record<string, unknown>) => {
        const m: Mutacion = { tabla: nombreTabla(tbl), datos: v, filtros: [], condiciones: [] };
        inserts.push(m);
        anotarWhere(c, m);
        return original(v);
      };
      return c;
    });

    const updateBase = kdb.update.getMockImplementation() as (t: unknown) => Record<string, unknown>;
    kdb.update.mockImplementation((tbl: unknown) => {
      const c = updateBase(tbl);
      const original = c.set as (v: unknown) => unknown;
      c.set = (v: Record<string, unknown>) => {
        const m: Mutacion = { tabla: nombreTabla(tbl), datos: v, filtros: [], condiciones: [] };
        updates.push(m);
        anotarWhere(c, m);
        return original(v);
      };
      return c;
    });
  }

  instalar();

  return {
    inserts,
    updates,
    insertsEn: (tabla) => inserts.filter((m) => m.tabla === tabla),
    updatesEn: (tabla) => updates.filter((m) => m.tabla === tabla),
    ultimoInsertEn: (tabla) => inserts.filter((m) => m.tabla === tabla).at(-1)?.datos ?? {},
    secuencia: () => inserts.map((m) => m.tabla),
    filtros: () => ultimosFiltros,
    filtrosUsados: () => historialFiltros,
    condicionesLeidas: () => condicionesDeSelect,
    reiniciar: () => {
      inserts.length = 0;
      updates.length = 0;
      historialFiltros.length = 0;
      condicionesDeSelect.length = 0;
      ultimosFiltros = [];
      instalar();
    },
  };
}
