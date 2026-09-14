// FLITO — catálogo de tipos de servicio adicional (HU #12541, Feature #12540, épica #12246).
//
// Lo que FLIT cobra aparte del trámite (paz y salvo, diagnóstico, derecho de petición…) como un
// catálogo editable por Finanzas. Aquí solo vive el CATÁLOGO; la asignación a trámites es otra HU.
//
// RN-01 — Baja LÓGICA: un tipo nunca se borra ni se reactiva. Dar de baja es `activo=false` +
//         `dado_de_baja_en` + actor, en la misma fila; la fila sigue existiendo (auditoría, historial).
// RN-02 — El nombre es único entre los ACTIVOS comparado PLEGADO (minúsculas, sin tilde): «Diagnóstico»
//         y «diagnostico» chocan. Lo garantiza el índice parcial de la 0191 y no un pre-chequeo: una
//         sola verdad (el índice) cubre también la carrera entre dos POST simultáneos (AC6). Dar de
//         baja libera el nombre.
// RN-03 — Editar y dar de baja solo operan sobre un tipo ACTIVO: un id inexistente, un uuid mal formado
//         o un tipo ya dado de baja son el MISMO 404 («no hay tipo activo con ese id»), sin filtrar si
//         la fila existe.
// RN-04 — Los tres tipos sembrados por la migración no tienen marca ni protección especial (AC2).

import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type {
  CrearServicioAdicionalInput, EditarServicioAdicionalInput, ServicioAdicionalTipo,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoServiciosAdicionalesTipos } from '../../db/schema.js';

/** Error de negocio (400). Las subclases afinan el código HTTP en la ruta. */
export class ServicioAdicionalError extends Error {}
/** No hay tipo ACTIVO con ese id (404): inexistente, uuid inválido o dado de baja (RN-03). */
export class ServicioAdicionalNoEncontradoError extends ServicioAdicionalError {}
/** Otro tipo activo ya lleva ese nombre plegado (409, `NOMBRE_DUPLICADO`). */
export class ServicioAdicionalConflictoError extends ServicioAdicionalError {
  constructor(message: string, public readonly choca: { id: string; nombre: string } | null) { super(message); }
}

const t = flitoServiciosAdicionalesTipos;

/**
 * El nombre PLEGADO: minúsculas y sin tilde ni diéresis. Es la MISMA expresión del índice parcial
 * `idx_flito_serv_adic_tipos_nombre_activo` de la 0191; si cambia allí, cambia aquí. `translate()`
 * y no `unaccent()`: DEV no tiene la extensión. Acepta una columna (orden, comparación) o un texto
 * (el nombre que se quiere comparar, que viaja como parámetro).
 */
export const nombrePlegado = (x: AnyPgColumn | string): SQL =>
  sql`lower(translate(${x}, 'áéíóúÁÉÍÓÚñÑüÜ', 'aeiouAEIOUnNuU'))`;

type FilaTipo = typeof flitoServiciosAdicionalesTipos.$inferSelect;

/** La fila en la forma del contrato: `numeric` → `Number()`, fechas → ISO. */
export function aDto(f: FilaTipo): ServicioAdicionalTipo {
  return {
    id: f.id, nombre: f.nombre, descripcion: f.descripcion ?? null, valor: Number(f.valor),
    activo: f.activo,
    dadoDeBajaEn: f.dadoDeBajaEn ? f.dadoDeBajaEn.toISOString() : null,
    dadoDeBajaPorId: f.dadoDeBajaPorId ?? null,
    creadoEn: f.creadoEn.toISOString(), creadoPorId: f.creadoPorId ?? null,
    actualizadoEn: f.actualizadoEn.toISOString(), actualizadoPorId: f.actualizadoPorId ?? null,
  };
}

const esChoqueDeLlave = (e: unknown): boolean => (e as { code?: string }).code === '23505';

/** El tipo ACTIVO que ya lleva ese nombre plegado (para el 409), o null si no se encuentra. */
async function activoConNombre(nombre: string): Promise<{ id: string; nombre: string } | null> {
  const [fila] = await db.select({ id: t.id, nombre: t.nombre }).from(t)
    .where(and(eq(t.activo, true), eq(nombrePlegado(t.nombre), nombrePlegado(nombre))))
    .limit(1);
  return fila ?? null;
}

/** Los tipos activos; con `incluirBajas`, también los dados de baja. Orden estable por nombre plegado. */
export async function listarTipos(incluirBajas = false): Promise<ServicioAdicionalTipo[]> {
  const filas = await db.select().from(t)
    .where(incluirBajas ? undefined : eq(t.activo, true))
    .orderBy(asc(nombrePlegado(t.nombre)), asc(t.id));
  return filas.map(aDto);
}

/**
 * ALTA. El nombre ya llega recortado y validado por Zod; el choque con un activo lo detecta el índice
 * (23505) y se relee la fila que choca para el 409 (RN-02).
 */
export async function crearTipo(d: CrearServicioAdicionalInput, usuarioId: number | null): Promise<ServicioAdicionalTipo> {
  const ahora = new Date();
  try {
    const [fila] = await db.insert(t).values({
      nombre: d.nombre, descripcion: d.descripcion ?? null, valor: String(d.valor),
      creadoPorId: usuarioId, creadoEn: ahora, actualizadoPorId: usuarioId, actualizadoEn: ahora,
    }).returning();
    return aDto(fila!);
  } catch (e) {
    if (!esChoqueDeLlave(e)) throw e;
    throw new ServicioAdicionalConflictoError('Ya existe un tipo de servicio adicional activo con ese nombre', await activoConNombre(d.nombre));
  }
}

/**
 * EDICIÓN de un tipo ACTIVO: cualquier subconjunto de nombre/descripción/valor. Siempre escribe
 * `actualizadoPorId`/`actualizadoEn`. Cero filas afectadas = 404 (RN-03); 23505 = 409 (RN-02).
 */
export async function editarTipo(id: string, cambios: EditarServicioAdicionalInput, usuarioId: number | null): Promise<ServicioAdicionalTipo> {
  const set: Partial<typeof t.$inferInsert> = { actualizadoPorId: usuarioId, actualizadoEn: new Date() };
  if (cambios.nombre !== undefined) set.nombre = cambios.nombre;
  if (cambios.descripcion !== undefined) set.descripcion = cambios.descripcion;
  if (cambios.valor !== undefined) set.valor = String(cambios.valor);
  let fila: FilaTipo | undefined;
  try {
    [fila] = await db.update(t).set(set).where(and(eq(t.id, id), eq(t.activo, true))).returning();
  } catch (e) {
    if (!esChoqueDeLlave(e)) throw e;
    // Un 23505 al editar solo puede venir del nombre (es la única columna del índice).
    throw new ServicioAdicionalConflictoError('Ya existe otro tipo de servicio adicional activo con ese nombre',
      cambios.nombre === undefined ? null : await activoConNombre(cambios.nombre));
  }
  if (!fila) throw new ServicioAdicionalNoEncontradoError('El tipo de servicio adicional no existe o ya está dado de baja');
  return aDto(fila);
}

/** BAJA lógica de un tipo ACTIVO (RN-01). Segunda baja o id inexistente = 404 (RN-03). */
export async function darDeBajaTipo(id: string, usuarioId: number | null): Promise<ServicioAdicionalTipo> {
  const ahora = new Date();
  const [fila] = await db.update(t)
    .set({ activo: false, dadoDeBajaEn: ahora, dadoDeBajaPorId: usuarioId, actualizadoPorId: usuarioId, actualizadoEn: ahora })
    .where(and(eq(t.id, id), eq(t.activo, true)))
    .returning();
  if (!fila) throw new ServicioAdicionalNoEncontradoError('El tipo de servicio adicional no existe o ya está dado de baja');
  return aDto(fila);
}
