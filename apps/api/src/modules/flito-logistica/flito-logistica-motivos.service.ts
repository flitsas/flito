// HU #14119 (Feature C3.1 #14093, Épica #13758, ADR-0030) — Catálogo de motivos de llegada a FLIT.
// Tabla `flito_logistica_motivos_llegada` (0275). HTTP en `flito-logistica-motivos.routes.ts`.
// Sin DELETE: inactivar conserva el id para el histórico (`flito_logistica_traslado_lts.motivo_llegada_id`).
// «Destino lejano (transportadora externa)» es SOLO un nombre del catálogo: sin precio, guía ni proveedor.
import { asc, eq, ne, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { flitoLogisticaMotivosLlegada } from '../../db/schema.js';

export const INDICE_MOTIVO_LLEGADA_NOMBRE = 'uq_flito_log_motivos_llegada_nombre';

export class MotivoLlegadaNoEncontradoError extends Error {
  constructor() { super('Motivo de llegada no encontrado'); this.name = 'MotivoLlegadaNoEncontradoError'; }
}
export class MotivoLlegadaDuplicadoError extends Error {
  constructor(nombre: string) {
    super(`Ya existe un motivo de llegada llamado "${nombre}".`);
    this.name = 'MotivoLlegadaDuplicadoError';
  }
}

export type FilaMotivoLlegada = typeof flitoLogisticaMotivosLlegada.$inferSelect;

export function motivoLlegadaDto(m: FilaMotivoLlegada) {
  return { id: m.id, nombre: m.nombre, activo: m.activo, orden: m.orden };
}

function esDuplicadoNombre(e: unknown): boolean {
  for (let x: unknown = e, i = 0; x && typeof x === 'object' && i < 3; x = (x as { cause?: unknown }).cause, i++) {
    const pg = x as { code?: unknown; constraint_name?: unknown; constraint?: unknown };
    if (pg.code === '23505' && (pg.constraint_name ?? pg.constraint) === INDICE_MOTIVO_LLEGADA_NOMBRE) return true;
  }
  return false;
}

async function nombreTomado(nombre: string, excluirId?: string): Promise<boolean> {
  const filas = await db.select({ id: flitoLogisticaMotivosLlegada.id })
    .from(flitoLogisticaMotivosLlegada)
    .where(
      excluirId === undefined
        ? sql`lower(${flitoLogisticaMotivosLlegada.nombre}) = lower(${nombre})`
        : sql`lower(${flitoLogisticaMotivosLlegada.nombre}) = lower(${nombre}) AND ${ne(flitoLogisticaMotivosLlegada.id, excluirId)}`,
    )
    .limit(1);
  return filas.length > 0;
}

async function escribir<T>(fn: () => Promise<T>, nombre?: string): Promise<T> {
  try { return await fn(); } catch (e) {
    if (nombre !== undefined && esDuplicadoNombre(e)) throw new MotivoLlegadaDuplicadoError(nombre);
    throw e;
  }
}

export async function listarMotivos(opts: { soloActivos?: boolean } = {}): Promise<FilaMotivoLlegada[]> {
  const q = db.select().from(flitoLogisticaMotivosLlegada);
  const filtrado = opts.soloActivos === true ? q.where(eq(flitoLogisticaMotivosLlegada.activo, true)) : q;
  return filtrado.orderBy(asc(flitoLogisticaMotivosLlegada.orden), asc(flitoLogisticaMotivosLlegada.nombre));
}

/** Para el viaje a FLIT (HU #14122): no montar GET público. */
export async function listarMotivosActivos(): Promise<FilaMotivoLlegada[]> {
  return listarMotivos({ soloActivos: true });
}

export async function crearMotivoLlegada(d: {
  nombre: string; orden?: number; creadoPorId: number;
}): Promise<FilaMotivoLlegada> {
  if (await nombreTomado(d.nombre)) throw new MotivoLlegadaDuplicadoError(d.nombre);
  const [creado] = await escribir(() => db.insert(flitoLogisticaMotivosLlegada).values({
    nombre: d.nombre, orden: d.orden ?? 0, creadoPorId: d.creadoPorId,
  }).returning(), d.nombre);
  return creado!;
}

export async function actualizarMotivoLlegada(
  id: string, d: { nombre?: string; orden?: number },
): Promise<FilaMotivoLlegada> {
  if (d.nombre !== undefined && await nombreTomado(d.nombre, id)) throw new MotivoLlegadaDuplicadoError(d.nombre);
  const [act] = await escribir(() => db.update(flitoLogisticaMotivosLlegada)
    .set({ ...d, updatedAt: new Date() })
    .where(eq(flitoLogisticaMotivosLlegada.id, id)).returning(), d.nombre);
  if (act === undefined) throw new MotivoLlegadaNoEncontradoError();
  return act;
}

export async function cambiarEstadoMotivoLlegada(id: string, activo: boolean): Promise<FilaMotivoLlegada> {
  const [act] = await db.update(flitoLogisticaMotivosLlegada)
    .set({ activo, updatedAt: new Date() })
    .where(eq(flitoLogisticaMotivosLlegada.id, id)).returning();
  if (act === undefined) throw new MotivoLlegadaNoEncontradoError();
  return act;
}
