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
import { clients, flitoExcepcionesAutogestion, flitoTramiteViajesLogistica, flitoTramites, users, vehicles } from '../../db/schema.js';
import { aprobadoSql, normPlaca } from './flito-logistica.aprobado.js';
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
 * RN-03 y RN-01 del estado PROPIO del trámite (liquidado / logística autogestionada): el error de
 * dominio que `registrar` lanzaría, o null si es elegible. Fuente única: `registrar` y el masivo.
 */
export async function motivoNoElegible(
  ejecutor: Ejecutor, tramiteId: string,
): Promise<{ error: ViajeLogisticaError | null; ctx: ContextoLogistica | null }> {
  if (await tramiteLiquidado(ejecutor, tramiteId)) return { error: new TramiteLiquidadoViajeError(), ctx: null };
  const ctx = await contextoLogisticaDe(ejecutor, tramiteId);
  return { error: ctx.gestiona ? null : new LogisticaAutogestionadaError(), ctx };
}

/**
 * Registrar: bloqueo del trámite → guarda de liquidado → guarda de quién gestiona → tarifa de hoy →
 * MAX(numero)+1 → INSERT, todo en una transacción (RN-01..RN-05). El nombre del actor se lee dentro
 * para devolver la fila completa.
 */
export async function registrar(tramiteId: string, entrada: EntradaViaje, usuarioId: number | null): Promise<Registrado> {
  return db.transaction(async (tx: Tx) => {
    const tramite = await bloquearTramite(tx, tramiteId);
    const { error, ctx } = await motivoNoElegible(tx, tramiteId);
    if (error || !ctx) throw error!;
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

// ── Registro masivo (HU #14127, ADR-0030 §17.2) ───────────────────────────────
// Varias LT en una operación, cada una con su valor libre (modo `manual`, mismo motivo para todas).
// La LT pertenece a un VEHÍCULO: cada ítem trae la placa y se resuelve el TRÁMITE APROBADO del vehículo
// (mismo `aprobadoSql` que el escaneo). 1 aprobado → se usa; 0 o vehículo inexistente → rechazo
// NO_ENCONTRADO; varios → VARIOS_TRAMITES_APROBADOS con los candidatos (ids opacos + idFlit, sin PII).
// El masivo NUNCA crea LT pendientes. NO es todo-o-nada: cada LT corre por `registrar` (RN-01..RN-05,
// su propia transacción y bloqueo), así que una liquidada o autogestionada se rechaza sola. La placa es
// PII cuasi-identificante: llega en el body, se devuelve solo a quien la envió y nunca se loguea.

/** Tope de LT por operación masiva (AC4; a confirmar con el PO). */
export const MAX_LT_POR_OPERACION = 200;

export interface ItemMasivo { placa: string; valor: number }
export interface CandidatoMasivo { tramiteId: string; idFlit: string }
export interface RechazoMasivo { placa: string; motivo: string; codigo: string; candidatos?: CandidatoMasivo[] }
export interface CreadoMasivo { placa: string; tramiteId: string; idFlit: string; viaje: ViajeLogistica }
export interface ResultadoMasivo { creados: CreadoMasivo[]; rechazados: RechazoMasivo[] }

/** Trámites aprobados del vehículo con esa placa (normalizada). */
async function aprobadosDePlaca(placaNorm: string): Promise<CandidatoMasivo[]> {
  if (placaNorm === '') return [];
  const filas = await db.select({ tramiteId: flitoTramites.id, idFlit: flitoTramites.idFlit })
    .from(flitoTramites)
    .innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
    .where(and(aprobadoSql, sql`upper(replace(${vehicles.plate}, '-', '')) = ${placaNorm}`))
    .orderBy(asc(flitoTramites.idFlit));
  return filas;
}

/**
 * Registra cada item en orden. `permitido` deja a la ruta aplicar el alcance por compañía: un trámite
 * ajeno ni se usa ni se lista como candidato (sin oráculo). Un error que no sea de dominio se relanza.
 */
export async function registrarMasivo(
  items: ItemMasivo[],
  comun: { motivo: MotivoViajeLogistica; motivoDetalle?: string },
  usuarioId: number | null,
  permitido: (tramiteId: string) => Promise<boolean> = async () => true,
): Promise<ResultadoMasivo> {
  const resultado: ResultadoMasivo = { creados: [], rechazados: [] };
  for (const { placa: bruta, valor } of items) {
    const placa = normPlaca(bruta);
    try {
      // Solo cuentan los aprobados ELEGIBLES (mismo predicado que `registrar`: no liquidado y logística
      // gestionada por FLITO). 0 elegibles: con un único aprobado se rechaza con el motivo de su RN; con
      // varios aprobados y ninguno elegible, NO_ENCONTRADO (no hay a cuál apuntar; lo más simple).
      const candidatos: CandidatoMasivo[] = [];
      const permitidos: CandidatoMasivo[] = [];
      let unicoError: ViajeLogisticaError | null = null;
      for (const c of await aprobadosDePlaca(placa)) {
        if (!(await permitido(c.tramiteId))) continue;
        permitidos.push(c);
        const { error } = await motivoNoElegible(db, c.tramiteId);
        if (error) unicoError = error; else candidatos.push(c);
      }
      if (candidatos.length === 0) {
        if (permitidos.length === 1 && unicoError) {
          resultado.rechazados.push({ placa, motivo: unicoError.message, codigo: unicoError.codigo });
        } else {
          resultado.rechazados.push({ placa, motivo: 'No encontrado: el vehículo no existe o no tiene un trámite aprobado elegible', codigo: 'NO_ENCONTRADO' });
        }
        continue;
      }
      if (candidatos.length > 1) {
        resultado.rechazados.push({
          placa, codigo: 'VARIOS_TRAMITES_APROBADOS', candidatos,
          motivo: 'El vehículo tiene varios trámites aprobados; registra el viaje desde el trámite correspondiente',
        });
        continue;
      }
      const { tramiteId } = candidatos[0]!;
      const { viaje, idFlit } = await registrar(tramiteId, { modo: 'manual', valor, ...comun }, usuarioId);
      resultado.creados.push({ placa, tramiteId, idFlit, viaje });
    } catch (e) {
      if (e instanceof TramiteNoEncontradoError) {
        resultado.rechazados.push({ placa, motivo: 'No encontrado: el trámite ya no existe', codigo: 'NO_ENCONTRADO' });
      } else if (e instanceof ViajeLogisticaError) {
        resultado.rechazados.push({ placa, motivo: e.message, codigo: e.codigo });
      } else throw e;
    }
  }
  return resultado;
}
