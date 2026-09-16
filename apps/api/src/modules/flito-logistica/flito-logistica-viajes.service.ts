// FLITO — viajes ADICIONALES de logística de un trámite (HU #12619, Feature #12617, épica #12244).
//
// El viaje 1 va incluido en la tarifa de logística; aquí viven los que se cobran aparte, en
// `flito_tramite_viajes_logistica`. Fichero hermano de flito-logistica.service.ts (que está contra
// su techo de max-lines y además su guarda de `escanear` ignora la excepción de autogestión).
//
// RN-01 — QUIÉN GESTIONA: solo se registran viajes si FLITO gestiona la logística del trámite
//         (`gestiona-logistica.ts`, el mismo predicado de la liquidación: la compañía no autogestiona
//         o hay excepción viva). Si no: 409 LOGISTICA_AUTOGESTIONADA; el GET responde
//         `gestionaLogistica: false` con cero viajes (ni el incluido).
// RN-02 — PRECIO: `inicial` copia la tarifa de logística vigente HOY de la compañía (snapshot en
//         `tarifa_vigente`, valor = tarifa; sin tarifa → 422 y no se inserta). `manual` fija el precio
//         a mano y guarda la tarifa como referencia (NULL si no hay).
// RN-03 — Solo un trámite NO liquidado cambia de viajes: con fila en `flito_liquidaciones` (cualquier
//         estado; la reversa la borra) registrar y quitar son 409 TRAMITE_LIQUIDADO.
// RN-04 — La comprobación de RN-03, la de RN-01, el MAX(numero) y la escritura van en la MISMA
//         transacción, serializadas con `SELECT … FOR UPDATE` sobre `flito_tramites` (ADR-0017): la
//         liquidación toma el mismo bloqueo. Leer con `db` en vez de `tx` rompe la serialización
//         (mutante nombrado).
// RN-05 — NUMERACIÓN: `COALESCE(MAX(numero), 1) + 1` bajo el bloqueo; sin tope; no se renumera al
//         quitar (el 4 puede quedar sin 3). El UNIQUE (tramite_id, numero) es la red: un 23505 NO se
//         traduce a 409, se relanza (bajo el FOR UPDATE no debería ocurrir; si ocurre es un bug).
// RN-06 — Quitar es DELETE físico por (id, tramite_id); cero filas = inexistente, de otro trámite o
//         id que no es uuid, todos el mismo 404 VIAJE_NO_ENCONTRADO. El rastro queda en `audit`.
// RN-07 — Nada de esto sale en las actas ni en su PDF: es información de cobro, no de entrega.

import { asc, and, eq, sql } from 'drizzle-orm';
import type {
  ModoPrecioViaje, MotivoViajeLogistica, ViajeLogistica, ViajesLogisticaDeTramite,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { clients, flitoExcepcionesAutogestion, flitoTramiteViajesLogistica, flitoTramites, users } from '../../db/schema.js';
import {
  bloquearTramite, tramiteLiquidado, TramiteNoEncontradoError, type Ejecutor, type Tx,
} from '../finanzas-servicios-adicionales/finanzas-servicios-adicionales.service.js';
import { excepcionLogisticaViva, gestionaLogistica } from '../flito-liquidacion/gestiona-logistica.js';
import { tarifaDe } from '../flito-parametrizacion/flito-tarifas.service.js';

export { TramiteNoEncontradoError };

/** Error de dominio de los viajes; cada subclase fija el HTTP y el `codigo` del cuerpo. */
export class ViajeLogisticaError extends Error {
  constructor(mensaje: string, readonly status: number, readonly codigo: string) { super(mensaje); }
}
/** El trámite tiene liquidación (409, RN-03). */
export class TramiteLiquidadoViajeError extends ViajeLogisticaError {
  constructor() { super('Reversa la liquidación para cambiar los viajes', 409, 'TRAMITE_LIQUIDADO'); }
}
/** La compañía autogestiona la logística y el trámite no tiene excepción viva (409, RN-01). */
export class LogisticaAutogestionadaError extends ViajeLogisticaError {
  constructor() { super('La logística de esta compañía la gestiona el cliente; FLITO no registra viajes', 409, 'LOGISTICA_AUTOGESTIONADA'); }
}
/** `inicial` sin tarifa de logística vigente (422, RN-02). */
export class TarifaLogisticaNoConfiguradaError extends ViajeLogisticaError {
  constructor() { super('La compañía no tiene tarifa de logística vigente; fija el precio a mano o configura la tarifa', 422, 'TARIFA_LOGISTICA_NO_CONFIGURADA'); }
}
/** El viaje no existe en este trámite (404, RN-06). */
export class ViajeNoEncontradoError extends ViajeLogisticaError {
  constructor() { super('El viaje no existe en este trámite', 404, 'VIAJE_NO_ENCONTRADO'); }
}

const V = flitoTramiteViajesLogistica;

/** Fila de la tabla con el nombre de quien registró (LEFT JOIN a users). */
export interface FilaViaje {
  id: string; numero: number; modo: string; valor: string; tarifaVigente: string | null;
  motivo: string; motivoDetalle: string | null; registradoPorId: number | null;
  registradoPorNombre: string | null; registradoEn: Date;
}

/** Lo que pide la ruta para registrar: el precio ya validado por Zod. */
export type EntradaViaje =
  | { modo: 'inicial'; motivo: MotivoViajeLogistica; motivoDetalle?: string }
  | { modo: 'manual'; valor: number; motivo: MotivoViajeLogistica; motivoDetalle?: string };

const redondear = (n: number): number => Math.round(n * 100) / 100;
const aNumeric = (n: number): string => n.toFixed(2);

/** La fila en la forma del contrato: `numeric` → `Number()`, fecha → ISO, nulos explícitos. */
export function aDto(f: FilaViaje): ViajeLogistica {
  return {
    id: f.id, numero: f.numero, modo: f.modo as ModoPrecioViaje, valor: Number(f.valor),
    tarifaVigente: f.tarifaVigente === null ? null : Number(f.tarifaVigente),
    motivo: f.motivo as MotivoViajeLogistica, motivoDetalle: f.motivoDetalle ?? null,
    registradoPorId: f.registradoPorId ?? null, registradoPorNombre: f.registradoPorNombre ?? null,
    registradoEn: f.registradoEn.toISOString(),
  };
}

/** El trámite con lo que decide RN-01: su compañía, si autogestiona y si hay excepción viva. */
export interface ContextoLogistica { id: string; idFlit: string; companiaId: number | null; gestiona: boolean }

/**
 * Lee el trámite con su compañía y la excepción viva de logística (el mismo LEFT JOIN de la
 * liquidación), o TramiteNoEncontradoError. Sin bloqueo: en las mutaciones va DESPUÉS de
 * `bloquearTramite(tx)`, así que corre ya serializada.
 */
export async function contextoLogisticaDe(ejecutor: Ejecutor, tramiteId: string): Promise<ContextoLogistica> {
  const [f] = await ejecutor.select({
    id: flitoTramites.id, idFlit: flitoTramites.idFlit, companiaId: flitoTramites.companiaId,
    logisticaAutogestionable: clients.logisticaAutogestionable,
    excepcionViva: sql<boolean>`${flitoExcepcionesAutogestion.id} IS NOT NULL`,
  }).from(flitoTramites)
    .leftJoin(clients, eq(flitoTramites.companiaId, clients.id))
    .leftJoin(flitoExcepcionesAutogestion, excepcionLogisticaViva())
    .where(eq(flitoTramites.id, tramiteId))
    .limit(1);
  if (!f) throw new TramiteNoEncontradoError();
  return {
    id: f.id, idFlit: f.idFlit, companiaId: f.companiaId ?? null,
    gestiona: gestionaLogistica(f.logisticaAutogestionable ?? null, Boolean(f.excepcionViva)),
  };
}

/** La tarifa de logística vigente HOY para la compañía (RN-02); null si no está configurada. */
async function tarifaLogisticaHoy(companiaId: number | null): Promise<number | null> {
  return (await tarifaDe(companiaId, 'logistica', null, null)).valor;
}

/**
 * Los viajes adicionales de un trámite, `ORDER BY numero ASC`, con el nombre del actor. La
 * liquidación lo reutilizará con su `tx` (HU #12618).
 */
export async function viajesDe(ejecutor: Ejecutor, tramiteId: string): Promise<FilaViaje[]> {
  return ejecutor.select({
    id: V.id, numero: V.numero, modo: V.modo, valor: V.valor, tarifaVigente: V.tarifaVigente,
    motivo: V.motivo, motivoDetalle: V.motivoDetalle, registradoPorId: V.registradoPorId,
    registradoPorNombre: users.name, registradoEn: V.registradoEn,
  }).from(V).leftJoin(users, eq(users.id, V.registradoPorId))
    .where(eq(V.tramiteId, tramiteId))
    .orderBy(asc(V.numero));
}

/** El GET: contexto, viajes, liquidación y tarifa de hoy. 404 si el trámite no existe. */
export async function listar(tramiteId: string): Promise<ViajesLogisticaDeTramite> {
  const ctx = await contextoLogisticaDe(db, tramiteId);
  const [liquidado, tarifaVigente] = await Promise.all([tramiteLiquidado(db, tramiteId), tarifaLogisticaHoy(ctx.companiaId)]);
  const base = { tramiteId: ctx.id, idFlit: ctx.idFlit, gestionaLogistica: ctx.gestiona, liquidado, tarifaVigente };
  // Sin gestión no hay viajes, ni siquiera el incluido: la logística la hace el cliente.
  if (!ctx.gestiona) return { ...base, items: [], totalViajes: 0, totalAdicionales: 0 };
  const items = (await viajesDe(db, tramiteId)).map(aDto);
  return {
    ...base, items, totalViajes: 1 + items.length,
    totalAdicionales: redondear(items.reduce((acc, i) => acc + i.valor, 0)),
  };
}

/** Lo que devuelve una mutación: el resultado y el `idFlit` para el `detail` de la auditoría. */
export interface Registrado { viaje: ViajeLogistica; idFlit: string }
export interface Quitado { numero: number; modo: string; valor: number; idFlit: string }

/**
 * Registrar: bloqueo del trámite → guarda de liquidado → guarda de quién gestiona → tarifa de hoy →
 * MAX(numero)+1 → INSERT, todo en una transacción (RN-01..RN-05). El nombre del actor se lee dentro
 * para devolver la fila completa.
 */
export async function registrar(tramiteId: string, entrada: EntradaViaje, usuarioId: number | null): Promise<Registrado> {
  return db.transaction(async (tx: Tx) => {
    const tramite = await bloquearTramite(tx, tramiteId);
    if (await tramiteLiquidado(tx, tramiteId)) throw new TramiteLiquidadoViajeError();
    const ctx = await contextoLogisticaDe(tx, tramiteId);
    if (!ctx.gestiona) throw new LogisticaAutogestionadaError();
    const tarifa = await tarifaLogisticaHoy(ctx.companiaId);
    let valor: number;
    if (entrada.modo === 'inicial') {
      if (tarifa === null) throw new TarifaLogisticaNoConfiguradaError();
      valor = tarifa;
    } else {
      valor = entrada.valor;
    }
    const [{ siguiente }] = await tx.select({ siguiente: sql<number>`COALESCE(MAX(${V.numero}), 1) + 1` })
      .from(V).where(eq(V.tramiteId, tramiteId));
    // Un 23505 del UNIQUE (tramite_id, numero) se RELANZA (RN-05): bajo el bloqueo no debería darse.
    const [fila] = await tx.insert(V).values({
      tramiteId, numero: Number(siguiente), modo: entrada.modo, valor: aNumeric(valor),
      tarifaVigente: tarifa === null ? null : aNumeric(tarifa),
      motivo: entrada.motivo, motivoDetalle: entrada.motivoDetalle ?? null, registradoPorId: usuarioId,
    }).returning();
    const [actor] = usuarioId === null
      ? []
      : await tx.select({ name: users.name }).from(users).where(eq(users.id, usuarioId)).limit(1);
    return { viaje: aDto({ ...fila!, registradoPorNombre: actor?.name ?? null }), idFlit: tramite.idFlit };
  });
}

/**
 * Quitar: bloqueo del trámite → guarda de liquidado → DELETE por (id, tramite_id) con RETURNING para
 * auditar (RN-06). Cero filas = inexistente o de otro trámite. No renumera (RN-05).
 */
export async function quitar(tramiteId: string, viajeId: string): Promise<Quitado> {
  return db.transaction(async (tx: Tx) => {
    const tramite = await bloquearTramite(tx, tramiteId);
    if (await tramiteLiquidado(tx, tramiteId)) throw new TramiteLiquidadoViajeError();
    const [borrado] = await tx.delete(V)
      .where(and(eq(V.id, viajeId), eq(V.tramiteId, tramiteId)))
      .returning({ numero: V.numero, modo: V.modo, valor: V.valor });
    if (!borrado) throw new ViajeNoEncontradoError();
    return { numero: borrado.numero, modo: borrado.modo, valor: Number(borrado.valor), idFlit: tramite.idFlit };
  });
}
