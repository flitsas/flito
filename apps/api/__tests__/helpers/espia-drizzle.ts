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

export function crearEspia(kdb: KeyedDb): EspiaDrizzle {
  const inserts: Mutacion[] = [];
  const updates: Mutacion[] = [];
  let ultimosFiltros: string[] = [];
  const historialFiltros: string[] = [];

  function instalar(): void {
    const selectBase = kdb.select.getMockImplementation() as (...a: unknown[]) => Record<string, unknown>;
    kdb.select.mockImplementation((...args: unknown[]) => {
      const c = selectBase(...args);
      const original = c.where as (v: unknown) => unknown;
      c.where = (cond: unknown) => {
        ultimosFiltros = paramsDe(cond);
        historialFiltros.push(...ultimosFiltros);
        return original(cond);
      };
      return c;
    });

    const insertBase = kdb.insert.getMockImplementation() as (t: unknown) => Record<string, unknown>;
    kdb.insert.mockImplementation((tbl: unknown) => {
      const c = insertBase(tbl);
      const original = c.values as (v: unknown) => unknown;
      c.values = (v: Record<string, unknown>) => {
        inserts.push({ tabla: nombreTabla(tbl), datos: v });
        return original(v);
      };
      return c;
    });

    const updateBase = kdb.update.getMockImplementation() as (t: unknown) => Record<string, unknown>;
    kdb.update.mockImplementation((tbl: unknown) => {
      const c = updateBase(tbl);
      const original = c.set as (v: unknown) => unknown;
      c.set = (v: Record<string, unknown>) => {
        updates.push({ tabla: nombreTabla(tbl), datos: v });
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
    reiniciar: () => {
      inserts.length = 0;
      updates.length = 0;
      historialFiltros.length = 0;
      ultimosFiltros = [];
      instalar();
    },
  };
}
