// Qué ORDER BY emitió el servicio, leído del SQL y aplicado a filas de verdad.
//
// ── Por qué hace falta ───────────────────────────────────────────────────────────────────────────
//
// Ni `helpers/db.ts` ni `helpers/keyed-db.ts` ordenan nada: `orderBy` es passthrough y las filas
// vuelven en el orden en que el test las registró. Un test que afirme «la primera fila es la más
// reciente» mirando la respuesta del mock pasa igual con `asc`, con `desc` y sin `ORDER BY`: no está
// comprobando el orden, está comprobando su propia fixture.
//
// La salida es lo que PostgreSQL recibiría. `terminosDeOrden` la lee —columna y sentido— y
// `ordenarComoPostgres` la APLICA a las filas del test. Así el aserto se escribe sobre datos («la
// primera es la del 29 de agosto») y sigue muriendo si alguien voltea el criterio, porque el
// criterio se lee del código bajo prueba en vez de darse por supuesto.
//
// Lo que NO hace: decidir cuál es el orden correcto. Si el servicio ordena mal, aquí se ordena mal
// igual —como haría la base— y es el `expect` del test quien lo declara defecto.

import { getTableName, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const dialecto = new PgDialect();

export interface TerminoDeOrden {
  /** Nombre de la columna en la BD (`created_at`), no el del modelo. */
  columna: string;
  /** Tal como PostgreSQL lo interpretaría: sin sufijo es `asc`. */
  direccion: 'asc' | 'desc';
}

/** `"flito_soat"."created_at" desc` → `{ columna: 'created_at', direccion: 'desc' }`. */
function leerTermino(termino: unknown): TerminoDeOrden {
  // Una columna a pelo (`orderBy(tabla.createdAt)`) no es un `SQL` y no se puede renderizar. Cuenta
  // como `asc`, que es lo que haría PostgreSQL: quitar el `desc` es un mutante que tiene que caer,
  // no un error del helper.
  const col = termino as { name?: unknown; table?: unknown };
  if (typeof col?.name === 'string' && col.table !== undefined) {
    try {
      getTableName(col.table as never);
      return { columna: col.name, direccion: 'asc' };
    } catch { /* no era una columna: sigue por la vía del SQL */ }
  }

  const { sql } = dialecto.sqlToQuery(termino as SQL);
  const m = /"([^"]+)"\s*(asc|desc)?\s*$/i.exec(sql.trim());
  if (!m) throw new Error(`No se reconoce este término de ORDER BY: ${sql}`);
  return { columna: m[1], direccion: (m[2]?.toLowerCase() as 'asc' | 'desc') ?? 'asc' };
}

/**
 * Los términos del `ORDER BY`, en orden.
 *
 * Lanza si la lista viene vacía. Es deliberado: un servicio que dejara de ordenar devolvería `[]`
 * aquí y un `toEqual` sobre filas ya ordenadas por la fixture pasaría — el mismo verde vacío que
 * este helper existe para no dar.
 */
export function terminosDeOrden(orden: unknown[]): TerminoDeOrden[] {
  if (orden.length === 0) throw new Error('La consulta no llevaba ORDER BY');
  return orden.map(leerTermino);
}

type Valor = string | number | Date | null | undefined;

/**
 * Las filas como las devolvería PostgreSQL con ese `ORDER BY`.
 *
 * `lector` traduce el nombre de la columna al campo de la fixture (`created_at` → `createdAt`): el
 * SQL habla en snake_case y las filas del mock en camelCase, y adivinar la conversión aquí escondería
 * un fallo de nombre detrás de un `undefined` que compara igual con todo.
 *
 * El orden es ESTABLE (`Array.prototype.sort` lo es): dos filas que empatan en todos los términos
 * conservan el orden de la fixture. Eso es justo lo que deja ver el desempate — si el criterio de
 * desempate desaparece del código, las filas empatadas salen como se registraron.
 */
export function ordenarComoPostgres<T>(
  filas: readonly T[],
  terminos: readonly TerminoDeOrden[],
  lector: (fila: T, columna: string) => Valor,
): T[] {
  const comparable = (v: Valor): string | number => {
    if (v instanceof Date) return v.getTime();
    if (v === null || v === undefined) throw new Error('Valor nulo en una clave de orden: la fixture no lo trae');
    return v;
  };
  return [...filas].sort((a, b) => {
    for (const t of terminos) {
      const va = comparable(lector(a, t.columna));
      const vb = comparable(lector(b, t.columna));
      if (va === vb) continue;
      const signo = va < vb ? -1 : 1;
      return t.direccion === 'desc' ? -signo : signo;
    }
    return 0;
  });
}
