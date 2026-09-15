// FLITO — servicios adicionales ASIGNADOS a un trámite (HU #12545, Feature #12544, épica #12246).
//
// El catálogo de tipos vive en flito-parametrizacion/flito-servicios-adicionales.service.ts; aquí
// vive la PUENTE `flito_tramite_servicios_adicionales`: qué servicios lleva cada trámite mientras
// no está liquidado. Módulo propio (no `finanzas/`) porque ese directorio es legacy del motor de
// permisos y no admite `exigirFuncion` (permisos.valla-legacy); ver ADR-0017.
//
// RN-01 — SNAPSHOT: al asignar se copian nombre, descripción y valor del tipo en ese instante.
//         Editar o dar de baja el tipo después no toca la puente (CF-03). Nadie relee el catálogo:
//         `listar` lee solo la puente (mutante 2 de la HU: un JOIN al catálogo lo pone rojo).
// RN-02 — Solo un trámite NO liquidado cambia de servicios: con fila en `flito_liquidaciones`
//         (cualquier estado; la reversa la borra) asignar y quitar son 409 TRAMITE_LIQUIDADO.
// RN-03 — La comprobación de RN-02 y la escritura van en la MISMA transacción, serializadas con
//         `SELECT … FOR UPDATE` sobre la fila de `flito_tramites` (ADR-0017, opción B1): la
//         liquidación toma el mismo bloqueo antes de leer la puente, así que ningún servicio entra
//         entre la lectura del sello y su COMMIT. Leer la puente/liquidación con `db` en vez de `tx`
//         rompería la serialización (mutante nombrado).
// RN-04 — Un tipo por trámite: lo garantiza el UNIQUE (tramite_id, tipo_id) de la 0193 y no un
//         pre-chequeo; el 23505 se traduce a 409 SERVICIO_YA_ASIGNADO (cubre la carrera de dos POST).
// RN-05 — Quitar es DELETE físico (CF-04): mientras el trámite no está liquidado ninguna liquidación
//         referencia la fila, y la sellada lleva su propia copia. El rastro queda en `audit`.
// RN-06 — Un tipo inexistente y uno dado de baja son el MISMO 404 TIPO_NO_DISPONIBLE (RN-03 del
//         catálogo); el id de asignación inexistente o de OTRO trámite es el mismo 404.

import { and, asc, eq } from 'drizzle-orm';
import type { ServiciosAdicionalesDeTramite, TramiteServicioAdicional } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import {
  flitoLiquidaciones, flitoServiciosAdicionalesTipos, flitoTramiteServiciosAdicionales, flitoTramites, users,
} from '../../db/schema.js';

/** Error de dominio de la asignación; las subclases fijan el código HTTP en la ruta. */
export class ServicioAdicionalTramiteError extends Error {}
/** El trámite no existe (404). */
export class TramiteNoEncontradoError extends ServicioAdicionalTramiteError {
  constructor() { super('El trámite no existe'); }
}
/** No hay tipo ACTIVO con ese id (404 `TIPO_NO_DISPONIBLE`): inexistente o dado de baja (RN-06). */
export class TipoNoDisponibleError extends ServicioAdicionalTramiteError {
  constructor() { super('El tipo de servicio adicional no existe o está dado de baja'); }
}
/** Ese tipo ya está en el trámite (409 `SERVICIO_YA_ASIGNADO`, RN-04). */
export class ServicioYaAsignadoError extends ServicioAdicionalTramiteError {
  constructor() { super('Ese servicio ya está asignado a este trámite'); }
}
/** El trámite tiene liquidación (409 `TRAMITE_LIQUIDADO`, RN-02). */
export class TramiteLiquidadoError extends ServicioAdicionalTramiteError {
  constructor() { super('Reversa la liquidación para cambiar los servicios'); }
}
/** La asignación no existe o es de otro trámite (404, RN-06). */
export class AsignacionNoEncontradaError extends ServicioAdicionalTramiteError {
  constructor() { super('La asignación no existe en este trámite'); }
}

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Lo que ejecuta una lectura: la conexión suelta o la transacción abierta (RN-03). */
export type Ejecutor = typeof db | Tx;

const SA = flitoTramiteServiciosAdicionales;

/** Fila de la puente con el nombre de quien asignó (LEFT JOIN a users). */
export interface FilaAsignacion {
  id: string; tipoId: string; nombre: string; descripcion: string | null; valor: string;
  asignadoPorId: number | null; asignadoPorNombre: string | null; asignadoEn: Date;
}

const redondear = (n: number): number => Math.round(n * 100) / 100;
const esChoqueDeLlave = (e: unknown): boolean => (e as { code?: string }).code === '23505';

/** La fila en la forma del contrato: `numeric` → `Number()`, fecha → ISO. */
export function aDto(f: FilaAsignacion): TramiteServicioAdicional {
  return {
    id: f.id, tipoId: f.tipoId, nombre: f.nombre, descripcion: f.descripcion ?? null, valor: Number(f.valor),
    asignadoPorId: f.asignadoPorId ?? null, asignadoPorNombre: f.asignadoPorNombre ?? null,
    asignadoEn: f.asignadoEn.toISOString(),
  };
}

const PROYECCION_TRAMITE = { id: flitoTramites.id, idFlit: flitoTramites.idFlit };

/** El trámite, o TramiteNoEncontradoError. Sin bloqueo: para las lecturas. */
async function tramiteDe(ejecutor: Ejecutor, tramiteId: string): Promise<{ id: string; idFlit: string }> {
  const [fila] = await ejecutor.select(PROYECCION_TRAMITE).from(flitoTramites).where(eq(flitoTramites.id, tramiteId)).limit(1);
  if (!fila) throw new TramiteNoEncontradoError();
  return fila;
}

/**
 * Bloquea la fila del trámite (`FOR UPDATE`) hasta el fin de la transacción y la devuelve (RN-03).
 * La liquidación toma el mismo bloqueo, así que asignar/quitar y sellar se serializan por trámite.
 */
export async function bloquearTramite(tx: Tx, tramiteId: string): Promise<{ id: string; idFlit: string }> {
  const [fila] = await tx.select(PROYECCION_TRAMITE).from(flitoTramites)
    .where(eq(flitoTramites.id, tramiteId)).for('update').limit(1);
  if (!fila) throw new TramiteNoEncontradoError();
  return fila;
}

/** true si hay fila en `flito_liquidaciones` (cualquier estado): la reversa la borra (RN-02). */
export async function tramiteLiquidado(ejecutor: Ejecutor, tramiteId: string): Promise<boolean> {
  const [fila] = await ejecutor.select({ id: flitoLiquidaciones.id }).from(flitoLiquidaciones)
    .where(eq(flitoLiquidaciones.tramiteId, tramiteId)).limit(1);
  return fila !== undefined;
}

/**
 * Los asignados de un trámite, `ORDER BY asignado_en ASC, id ASC` (desempate estable). Solo la
 * puente (RN-01) más el nombre del actor. La liquidación lo reutiliza con su `tx` (HU #12546).
 */
export async function serviciosAsignadosDe(ejecutor: Ejecutor, tramiteId: string): Promise<FilaAsignacion[]> {
  return ejecutor.select({
    id: SA.id, tipoId: SA.tipoId, nombre: SA.nombre, descripcion: SA.descripcion, valor: SA.valor,
    asignadoPorId: SA.asignadoPorId, asignadoPorNombre: users.name, asignadoEn: SA.asignadoEn,
  }).from(SA).leftJoin(users, eq(users.id, SA.asignadoPorId))
    .where(eq(SA.tramiteId, tramiteId))
    .orderBy(asc(SA.asignadoEn), asc(SA.id));
}

/** El GET: los asignados, su suma en JS y si el trámite está liquidado. 404 si el trámite no existe. */
export async function listar(tramiteId: string): Promise<ServiciosAdicionalesDeTramite> {
  await tramiteDe(db, tramiteId);
  const [filas, liquidado] = await Promise.all([serviciosAsignadosDe(db, tramiteId), tramiteLiquidado(db, tramiteId)]);
  const items = filas.map(aDto);
  return { items, total: redondear(items.reduce((acc, i) => acc + i.valor, 0)), liquidado };
}

/** Lo que devuelve una mutación: el resultado y el `idFlit` para el `detail` de la auditoría. */
export interface Asignada { asignacion: TramiteServicioAdicional; idFlit: string }
export interface Quitada { tipoId: string; nombre: string; valor: number; idFlit: string }

/**
 * Asignar: bloqueo del trámite → guarda de liquidado → tipo ACTIVO → INSERT con el snapshot, todo en
 * una transacción (RN-01..RN-04). El nombre del actor se lee dentro para devolver la fila completa.
 */
export async function asignar(tramiteId: string, tipoId: string, usuarioId: number | null): Promise<Asignada> {
  return db.transaction(async (tx) => {
    const tramite = await bloquearTramite(tx, tramiteId);
    if (await tramiteLiquidado(tx, tramiteId)) throw new TramiteLiquidadoError();
    const [tipo] = await tx.select({
      id: flitoServiciosAdicionalesTipos.id, nombre: flitoServiciosAdicionalesTipos.nombre,
      descripcion: flitoServiciosAdicionalesTipos.descripcion, valor: flitoServiciosAdicionalesTipos.valor,
    }).from(flitoServiciosAdicionalesTipos)
      .where(and(eq(flitoServiciosAdicionalesTipos.id, tipoId), eq(flitoServiciosAdicionalesTipos.activo, true)))
      .limit(1);
    if (!tipo) throw new TipoNoDisponibleError();
    let fila: typeof SA.$inferSelect | undefined;
    try {
      [fila] = await tx.insert(SA).values({
        tramiteId, tipoId: tipo.id, nombre: tipo.nombre, descripcion: tipo.descripcion ?? null, valor: tipo.valor,
        asignadoPorId: usuarioId,
      }).returning();
    } catch (e) {
      if (esChoqueDeLlave(e)) throw new ServicioYaAsignadoError();
      throw e;
    }
    const [actor] = usuarioId === null
      ? []
      : await tx.select({ name: users.name }).from(users).where(eq(users.id, usuarioId)).limit(1);
    return { asignacion: aDto({ ...fila!, asignadoPorNombre: actor?.name ?? null }), idFlit: tramite.idFlit };
  });
}

/**
 * Quitar: bloqueo del trámite → guarda de liquidado → DELETE por (id, tramite_id) con RETURNING del
 * snapshot para auditar (RN-05). Cero filas = inexistente o de otro trámite (RN-06).
 */
export async function quitar(tramiteId: string, asignacionId: string): Promise<Quitada> {
  return db.transaction(async (tx) => {
    const tramite = await bloquearTramite(tx, tramiteId);
    if (await tramiteLiquidado(tx, tramiteId)) throw new TramiteLiquidadoError();
    const [borrada] = await tx.delete(SA)
      .where(and(eq(SA.id, asignacionId), eq(SA.tramiteId, tramiteId)))
      .returning({ tipoId: SA.tipoId, nombre: SA.nombre, valor: SA.valor });
    if (!borrada) throw new AsignacionNoEncontradaError();
    return { tipoId: borrada.tipoId, nombre: borrada.nombre, valor: Number(borrada.valor), idFlit: tramite.idFlit };
  });
}
