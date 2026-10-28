// FLITO Logística — resolver el trámite de una LT pendiente (HU #14143, ADR-0030 §17.3).
//
// Una LT pendiente (`tramite_id` NULL, sin compañía) se escaneó por vehículo sin saber a qué trámite pertenecía.
// Quien tiene `logistica.documento.resolver_tramite` elige entre los CANDIDATOS: trámites APROBADOS del mismo
// vehículo y organismo, de una compañía gestionable, que aún no tienen LT. Al resolver, la LT toma el trámite y
// su compañía; si ya tenía firma del organismo, entra al acta de organismo DE ESA COMPAÑÍA con la MISMA firma
// (se crea o se reutiliza por `UNIQUE (firmante_id, compania_id)`) y se apaga `acta_organismo_pendiente`.
// Nunca se loguea placa, VIN ni cédula: solo ids y conteos.

import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  clients, flitoLogisticaActaLineas, flitoLogisticaActas, flitoLogisticaDocumentos, flitoLogisticaEventos,
  flitoLogisticaRecogidaFirmantes, flitoTramites, users, vehicles,
} from '../../db/schema.js';
import { LT, LogisticaError, aprobadoSql, log, type DbOrTx, type LogisticaCtx } from './flito-logistica.base.js';

export interface CandidatoPendiente {
  tramiteId: string; idFlit: string; companiaId: number; companiaNombre: string | null; organismoCodigo: string | null;
  /** ISO de `flito_tramites.fecha_aprobacion`; null si el trámite no la trae. */
  fechaAprobacion: string | null;
  /** `flito_tramites.tipo_tramite` tal cual (texto de FLIT); null si falta. */
  tipoTramite: string | null;
}
export interface PendienteTramite {
  documentoId: string; placa: string | null; organismoCodigo: string; estado: string; firmada: boolean;
  recogidoEn: string; recogidoPorNombre: string | null; antiguedadDias: number; candidatos: CandidatoPendiente[];
}
export interface TramiteResuelto { documentoId: string; tramiteId: string; companiaId: number; actaId: string | null }

class LtNoPendienteError extends LogisticaError {
  constructor() { super('La LT ya no está pendiente de trámite', 409, undefined, 'LT_NO_PENDIENTE'); }
}
class TramiteNoCandidatoError extends LogisticaError {
  constructor() { super('El trámite no es candidato para esta LT', 422, undefined, 'TRAMITE_NO_CANDIDATO'); }
}
class TramiteYaTieneLtError extends LogisticaError {
  constructor() { super('El trámite ya tiene una LT', 409, undefined, 'TRAMITE_YA_TIENE_LT'); }
}
class LtNoEncontradaError extends LogisticaError {
  constructor() { super('La LT no existe', 404, undefined, 'LT_NO_ENCONTRADA'); }
}

const esUnica = (e: unknown): boolean => {
  const x = e as { code?: string; cause?: { code?: string } } | null;
  return x?.code === '23505' || x?.cause?.code === '23505';
};

/** Trámites candidatos (aprobados, sin LT, compañía gestionable) de unos vehículos; agrupados por vehículo. */
async function candidatosPorVehiculo(exec: DbOrTx, vehiculoIds: number[]): Promise<Map<number, Array<CandidatoPendiente & { organismo: string | null }>>> {
  const mapa = new Map<number, Array<CandidatoPendiente & { organismo: string | null }>>();
  if (!vehiculoIds.length) return mapa;
  const filas = await exec.select({
    vehiculoId: flitoTramites.vehiculoId, tramiteId: flitoTramites.id, idFlit: flitoTramites.idFlit,
    companiaId: flitoTramites.companiaId, companiaNombre: clients.name, organismoCodigo: flitoTramites.organismoCodigo,
    fechaAprobacion: flitoTramites.fechaAprobacion, tipoTramite: flitoTramites.tipoTramite,
  }).from(flitoTramites)
    .innerJoin(clients, eq(flitoTramites.companiaId, clients.id))
    .leftJoin(flitoLogisticaDocumentos, and(eq(flitoLogisticaDocumentos.tramiteId, flitoTramites.id), eq(flitoLogisticaDocumentos.tipo, LT)))
    .where(and(aprobadoSql, inArray(flitoTramites.vehiculoId, vehiculoIds), isNull(flitoLogisticaDocumentos.id),
      sql`NOT coalesce(${clients.logisticaAutogestionable}, false)`))
    .orderBy(sql`${desc(flitoTramites.fechaAprobacion)} NULLS LAST`, asc(flitoTramites.id));
  // Orden determinista también en memoria: fecha de aprobación DESC (sin fecha al final), desempate por tramiteId.
  filas.sort((a, b) => {
    const fa = a.fechaAprobacion?.getTime() ?? null, fb = b.fechaAprobacion?.getTime() ?? null;
    if (fa !== fb) return fa === null ? 1 : fb === null ? -1 : fb - fa;
    return a.tramiteId < b.tramiteId ? -1 : a.tramiteId > b.tramiteId ? 1 : 0;
  });
  for (const f of filas) {
    if (f.companiaId === null) continue;
    const lista = mapa.get(f.vehiculoId) ?? [];
    lista.push({ tramiteId: f.tramiteId, idFlit: f.idFlit, companiaId: f.companiaId, companiaNombre: f.companiaNombre, organismoCodigo: f.organismoCodigo,
      fechaAprobacion: f.fechaAprobacion?.toISOString() ?? null, tipoTramite: f.tipoTramite ?? null, organismo: f.organismoCodigo });
    mapa.set(f.vehiculoId, lista);
  }
  return mapa;
}

const sinOrganismo = ({ organismo: _o, ...c }: CandidatoPendiente & { organismo: string | null }): CandidatoPendiente => c;

/** Bandeja «Pendientes de trámite»: LT sin trámite, más antiguas primero, con sus candidatos. */
export async function listarPendientes(): Promise<PendienteTramite[]> {
  const D = flitoLogisticaDocumentos;
  const docs = await db.select({
    id: D.id, vehiculoId: D.vehiculoId, placa: vehicles.plate, organismoCodigo: D.organismoCodigo, estado: D.estado,
    firmanteId: D.recogidaFirmanteId, createdAt: D.createdAt,
  }).from(D).innerJoin(vehicles, eq(D.vehiculoId, vehicles.id))
    .where(and(isNull(D.tramiteId), eq(D.tipo, LT))).orderBy(asc(D.createdAt)).limit(500);
  if (!docs.length) return [];
  const quienes = await db.select({ documentoId: flitoLogisticaEventos.documentoId, nombre: users.name, en: flitoLogisticaEventos.createdAt })
    .from(flitoLogisticaEventos).leftJoin(users, eq(flitoLogisticaEventos.actorId, users.id))
    .where(and(inArray(flitoLogisticaEventos.documentoId, docs.map((d) => d.id)), isNull(flitoLogisticaEventos.estadoAnterior)));
  const recogida = new Map(quienes.map((q) => [q.documentoId, q]));
  const cands = await candidatosPorVehiculo(db, [...new Set(docs.map((d) => d.vehiculoId))]);
  const ahora = Date.now();
  return docs.map((d) => ({
    documentoId: d.id, placa: d.placa, organismoCodigo: d.organismoCodigo, estado: d.estado, firmada: d.firmanteId !== null,
    recogidoEn: (recogida.get(d.id)?.en ?? d.createdAt).toISOString(), recogidoPorNombre: recogida.get(d.id)?.nombre ?? null,
    antiguedadDias: Math.max(0, Math.floor((ahora - d.createdAt.getTime()) / 86_400_000)),
    candidatos: (cands.get(d.vehiculoId) ?? []).filter((c) => c.organismo === d.organismoCodigo).map(sinOrganismo),
  }));
}

/** Candidatos de UNA LT pendiente (mismo vehículo y organismo). 404 si no existe, 409 si ya no es pendiente. */
export async function candidatosDe(documentoId: string): Promise<CandidatoPendiente[]> {
  const [d] = await db.select({ vehiculoId: flitoLogisticaDocumentos.vehiculoId, organismoCodigo: flitoLogisticaDocumentos.organismoCodigo, tramiteId: flitoLogisticaDocumentos.tramiteId })
    .from(flitoLogisticaDocumentos).where(and(eq(flitoLogisticaDocumentos.id, documentoId), eq(flitoLogisticaDocumentos.tipo, LT))).limit(1);
  if (!d) throw new LtNoEncontradaError();
  if (d.tramiteId !== null) throw new LtNoPendienteError();
  const c = await candidatosPorVehiculo(db, [d.vehiculoId]);
  return (c.get(d.vehiculoId) ?? []).filter((x) => x.organismo === d.organismoCodigo).map(sinOrganismo);
}

/** Resuelve el trámite de la LT pendiente (transaccional, con `FOR UPDATE` del documento). */
export async function resolverTramite(documentoId: string, tramiteId: string, ctx: LogisticaCtx): Promise<TramiteResuelto> {
  const D = flitoLogisticaDocumentos;
  try {
    return await db.transaction(async (tx) => {
      const [doc] = await tx.select({
        id: D.id, estado: D.estado, vehiculoId: D.vehiculoId, organismoCodigo: D.organismoCodigo,
        tramiteId: D.tramiteId, firmanteId: D.recogidaFirmanteId,
      }).from(D).where(and(eq(D.id, documentoId), eq(D.tipo, LT))).for('update');
      if (!doc) throw new LtNoEncontradaError();
      if (doc.tramiteId !== null) throw new LtNoPendienteError();

      const [t] = await tx.select({
        id: flitoTramites.id, vehiculoId: flitoTramites.vehiculoId, organismoCodigo: flitoTramites.organismoCodigo,
        companiaId: flitoTramites.companiaId, companiaNit: flitoTramites.companiaNit,
        aprobado: sql<boolean>`(${aprobadoSql})`, autogestionable: clients.logisticaAutogestionable,
      }).from(flitoTramites).leftJoin(clients, eq(flitoTramites.companiaId, clients.id)).where(eq(flitoTramites.id, tramiteId));
      if (!t || t.vehiculoId !== doc.vehiculoId || !t.aprobado || t.companiaId === null
        || t.organismoCodigo !== doc.organismoCodigo || t.autogestionable) throw new TramiteNoCandidatoError();
      const [yaLt] = await tx.select({ id: D.id }).from(D).where(and(eq(D.tramiteId, tramiteId), eq(D.tipo, LT))).limit(1);
      if (yaLt) throw new TramiteYaTieneLtError();

      const ahora = new Date();
      const companiaId = t.companiaId;
      let actaId: string | null = null;
      const set: Partial<typeof D.$inferInsert> = { tramiteId, companiaId, companiaNit: t.companiaNit, updatedAt: ahora };

      if (doc.firmanteId) {
        const [existente] = await tx.select({ id: flitoLogisticaActas.id }).from(flitoLogisticaActas)
          .where(and(eq(flitoLogisticaActas.firmanteId, doc.firmanteId), eq(flitoLogisticaActas.companiaId, companiaId), eq(flitoLogisticaActas.punto, 'organismo'))).limit(1);
        if (existente) actaId = existente.id;
        else {
          const [f] = await tx.select({ por: flitoLogisticaRecogidaFirmantes.registradoPorId, en: flitoLogisticaRecogidaFirmantes.firmadoEn, lat: flitoLogisticaRecogidaFirmantes.lat, lng: flitoLogisticaRecogidaFirmantes.lng })
            .from(flitoLogisticaRecogidaFirmantes).where(eq(flitoLogisticaRecogidaFirmantes.id, doc.firmanteId));
          const [acta] = await tx.insert(flitoLogisticaActas).values({
            companiaId, punto: 'organismo', organismoCodigo: doc.organismoCodigo, firmanteId: doc.firmanteId,
            estado: 'entregada', mensajeroId: f?.por ?? ctx.userId, entregadoEn: f?.en ?? ahora, entregadoLat: f?.lat ?? null, entregadoLng: f?.lng ?? null,
          }).returning({ id: flitoLogisticaActas.id });
          actaId = acta.id;
        }
        await tx.insert(flitoLogisticaActaLineas).values({ actaId, documentoId: doc.id, punto: 'organismo', companiaId });
        set.actaOrganismoPendiente = false;
      }
      await tx.update(D).set(set).where(eq(D.id, doc.id));
      await tx.insert(flitoLogisticaEventos).values({
        documentoId: doc.id, estadoAnterior: doc.estado, estadoNuevo: doc.estado, actorId: ctx.userId, origen: 'usuario',
        tipo: 'tramite_resuelto', actaId, payload: { tramiteId, companiaId, ...(actaId ? { actaId } : {}) },
      });
      log.info({ documentoId: doc.id, tramiteId, companiaId, conActa: actaId !== null }, 'trámite de LT pendiente resuelto');
      return { documentoId: doc.id, tramiteId, companiaId, actaId };
    });
  } catch (e) {
    // Red de la BD: la carrera por el mismo trámite (uq tramite+tipo) o por la línea de acta también es 409.
    if (esUnica(e)) throw new TramiteYaTieneLtError();
    throw e;
  }
}
