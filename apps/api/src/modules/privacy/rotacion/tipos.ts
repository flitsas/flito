// Feature #13978, HU #13987 (ADR-0034 D3) — contrato entre el motor de rotación y cada descriptor.
import type { ColumnaCifrada } from '../../../shared/utils/pii-columnas.js';

export type IdFila = number | string;

/**
 * `id` es lo único de la fila que puede salir a la consola. `rowKey` es la clave de la AAD, que en
 * manifiestos es el `numero`: no se imprime.
 */
export interface FilaCifrada<C> {
  id: IdFila;
  rowKey: string;
  celda: C;
}

export interface Descriptor<C> {
  id: ColumnaCifrada;
  lote: number;
  /** Las celdas con dato cifrado de esta forma, en cualquier versión. */
  todas(despuesDe: IdFila | null): Promise<FilaCifrada<C>[]>;
  /** Las celdas que no están en `version`. */
  pendientes(despuesDe: IdFila | null, version: number): Promise<FilaCifrada<C>[]>;
  /** Hasta `n` pendientes, para el canario de columna (D4). */
  muestra(n: number, version: number): Promise<FilaCifrada<C>[]>;
  /** Versión de llave de la celda. Puede lanzar si el formato es inválido. */
  version(fila: FilaCifrada<C>): number;
  descifrar(fila: FilaCifrada<C>): Buffer | Promise<Buffer>;
  /** Con la versión vigente y sin escribir nada. */
  cifrar(plano: Buffer, fila: FilaCifrada<C>): C;
  /** Con guarda: `false` si la fila cambió desde la lectura. */
  escribir(fila: FilaCifrada<C>, valor: C): Promise<boolean>;
  /** Solo biometría: celdas en formatos que este script no toca (RN-RO5). */
  legado?(): Promise<{ bloquean: number; desconocido: number }>;
}
