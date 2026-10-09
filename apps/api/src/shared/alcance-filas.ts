// HU #13426 (Feature #12871, ADR-0024 §4.4) — La forma «condición por enlace» que comparten los
// módulos FLITO abiertos a un enlace. Diseño: docs/arquitectura/hu-13426-alcance-por-enlace-modulos.md.
//
// Reglas (iguales en todos los módulos):
//   · Enlace `ninguno` → `undefined` (sin condición: lo ve todo, AC1).
//   · Enlace que el módulo SÍ contempla, con id → la condición de sus filas.
//   · Id ausente (companiaId null, organismos [], proveedorId null) → `sql\`false\``: CERO filas,
//     nunca «todo».
//   · Enlace que la condición NO contempla (p. ej. proveedor contra una condición de compañía) o
//     enlace desconocido → `sql\`false\``. La frontera ya lo corta antes; así un error de montaje
//     falla cerrado.
//
// El filtro NUNCA mira el nombre del rol (AC8/AC9): solo el enlace y su id, leídos de la base.
import { eq, inArray, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { AlcanceResuelto } from './middleware/frontera-enlace.js';

const NINGUNA_FILA: SQL = sql`false`;

/** Filas de la compañía del usuario. `undefined` = sin condición (enlace `ninguno`). */
export function condicionPorCompania(col: AnyColumn, a: AlcanceResuelto): SQL | undefined {
  if (a.enlace === 'ninguno') return undefined;
  if (a.enlace === 'compania' && a.companiaId != null) return eq(col, a.companiaId);
  return NINGUNA_FILA;
}

/** Filas de las secretarías del usuario. `undefined` = sin condición (enlace `ninguno`). */
export function condicionPorOrganismos(col: AnyColumn, a: AlcanceResuelto): SQL | undefined {
  if (a.enlace === 'ninguno') return undefined;
  if (a.enlace === 'organismos_transito' && a.organismos.length > 0) return inArray(col, a.organismos);
  return NINGUNA_FILA;
}

/** Filas del proveedor del usuario. `undefined` = sin condición (enlace `ninguno`). */
export function condicionPorProveedor(col: AnyColumn, a: AlcanceResuelto): SQL | undefined {
  if (a.enlace === 'ninguno') return undefined;
  if (a.enlace === 'proveedor' && a.proveedorId != null) return eq(col, a.proveedorId);
  return NINGUNA_FILA;
}

/** Escritura fuera del alcance. 403 con el mismo cuerpo que la frontera: `{ error: 'Sin permisos' }`. */
export class AlcanceAjenoError extends Error {
  readonly status = 403;
  constructor() {
    super('Sin permisos');
    this.name = 'AlcanceAjenoError';
  }
}

/** ¿Alcanza este enlace al dueño indicado? `ninguno` alcanza todo; un dueño ausente no es suyo. */
export function esPropio(
  a: AlcanceResuelto,
  dueno: { companiaId?: number | null; organismo?: string | null },
): boolean {
  if (a.enlace === 'ninguno') return true;
  if (a.enlace === 'compania') return a.companiaId != null && dueno.companiaId === a.companiaId;
  if (a.enlace === 'organismos_transito') {
    return dueno.organismo != null && a.organismos.includes(dueno.organismo);
  }
  return false;
}

/**
 * Escritura sobre un dueño concreto: lanza `AlcanceAjenoError` (403) si no es el suyo. NO consulta si
 * el registro existe (sin oráculo con ids enumerables).
 */
export function exigirPropio(
  a: AlcanceResuelto,
  dueno: { companiaId?: number | null; organismo?: string | null },
): void {
  if (!esPropio(a, dueno)) throw new AlcanceAjenoError();
}

/** El id de compañía que acota un agregado: `undefined` = global (sin enlace); `null` = cero filas. */
export function companiaDeAlcance(a: AlcanceResuelto): number | null | undefined {
  if (a.enlace === 'ninguno') return undefined;
  return a.enlace === 'compania' ? a.companiaId : null;
}
