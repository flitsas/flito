// Feature #13978, HU #13987 (ADR-0034 D3) — lectura común de los descriptores de rotación.
import { and, asc, gt, type SQL } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { db } from '../../../db/client.js';
import type { ColumnaCifrada } from '../../../shared/utils/pii-columnas.js';
import type { Descriptor, FilaCifrada, IdFila } from './tipos.js';

interface DefLectura<C> {
  id: ColumnaCifrada;
  lote: number;
  tabla: PgTable;
  pk: AnyPgColumn;
  seleccion: Record<string, AnyPgColumn>;
  fila(r: Record<string, unknown>): FilaCifrada<C>;
  hayDato: SQL | undefined;
  enOtraVersion(version: number): SQL;
}

type Lectura<C> = Pick<Descriptor<C>, 'id' | 'lote' | 'todas' | 'pendientes' | 'muestra'>;

/** Lectura por clave primaria (keyset). No guarda estado: lo pendiente es lo que no está en la versión. */
export function lecturaPorClave<C>(def: DefLectura<C>): Lectura<C> {
  const leer = async (cond: SQL | undefined, despuesDe: IdFila | null, limite: number) => {
    const filas = await db.select(def.seleccion).from(def.tabla)
      .where(and(cond, despuesDe === null ? undefined : gt(def.pk, despuesDe)))
      .orderBy(asc(def.pk))
      .limit(limite);
    return (filas as Record<string, unknown>[]).map(def.fila);
  };
  const conVersion = (version: number) => and(def.hayDato, def.enOtraVersion(version));
  return {
    id: def.id,
    lote: def.lote,
    todas: (despuesDe) => leer(def.hayDato, despuesDe, def.lote),
    pendientes: (despuesDe, version) => leer(conVersion(version), despuesDe, def.lote),
    muestra: (n, version) => leer(conVersion(version), null, n),
  };
}
