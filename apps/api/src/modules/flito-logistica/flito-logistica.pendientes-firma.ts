// FLITO Logística — LT escaneadas que aún esperan la firma del organismo (HU #14147, ADR-0030 §17.1/§17.3).
// Pendiente de firma = LT viva con `acta_organismo_pendiente` true, SIN línea en un acta de organismo, SIN firmante
// capturado (`recogida_firmante_id` NULL: la pendiente de trámite ya firmada no se vuelve a firmar) y en un estado
// confirmable (§17.4). El mensajero solo ve las que escaneó él (autor del primer evento); `operar_ajenas` ve todas.
// Se firman con el mismo `POST /recogidas/confirmar`. La placa es PII: viaja solo en la respuesta, nunca en logs ni en audit.

import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { clients, flitoLogisticaDocumentos, flitoTramites } from '../../db/schema.js';
import { LT, type LogisticaCtx } from './flito-logistica.base.js';
import { ESTADOS_CONFIRMABLES } from './flito-logistica.recogida.js';

const D = flitoLogisticaDocumentos;
const TOPE = 500;

export interface LtPendienteFirmaDto {
  documentoId: string; placa: string | null; numeroLt: string | null; idFlit: string | null;
  companiaId: number | null; companiaNombre: string | null; organismoCodigo: string; pendienteTramite: boolean;
  estado: string; fecha: string;
}

/** Condición de «pendiente de firma» (+ propiedad si el usuario no opera ajenas). Compartida por el listado y el conteo. */
export function condicionPendientesFirma(ctx: LogisticaCtx): SQL {
  const base = and(
    eq(D.tipo, LT), eq(D.actaOrganismoPendiente, true), sql`${D.recogidaFirmanteId} IS NULL`,
    inArray(D.estado, [...ESTADOS_CONFIRMABLES]),
    sql`NOT EXISTS (select 1 from flito_logistica_acta_lineas l where l.documento_id = ${D.id} and l.punto = 'organismo')`,
  )!;
  if (ctx.operaAjenas) return base;
  // Propia = la escaneó este usuario (primer evento del documento, el de la recogida), igual que en confirmarRecogida.
  return and(base, sql`EXISTS (select 1 from flito_logistica_documento_eventos e where e.documento_id = ${D.id} and e.actor_id = ${ctx.userId} and e.estado_anterior IS NULL)`)!;
}

export async function ltPendientesFirma(ctx: LogisticaCtx): Promise<LtPendienteFirmaDto[]> {
  const rows = await db.select({
    documentoId: D.id, placa: D.identificador, numeroLt: D.numeroLt, idFlit: flitoTramites.idFlit,
    companiaId: D.companiaId, companiaNombre: clients.name, organismoCodigo: D.organismoCodigo, tramiteId: D.tramiteId,
    estado: D.estado, fecha: D.createdAt,
  }).from(D)
    .leftJoin(flitoTramites, eq(D.tramiteId, flitoTramites.id))
    .leftJoin(clients, eq(D.companiaId, clients.id))
    .where(condicionPendientesFirma(ctx)).orderBy(desc(D.createdAt)).limit(TOPE);
  return rows.map((r) => ({
    documentoId: r.documentoId, placa: r.placa, numeroLt: r.numeroLt, idFlit: r.idFlit,
    companiaId: r.companiaId, companiaNombre: r.companiaNombre, organismoCodigo: r.organismoCodigo,
    pendienteTramite: r.tramiteId === null, estado: r.estado, fecha: r.fecha.toISOString(),
  }));
}

export async function contarPendientesFirma(ctx: LogisticaCtx): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(D).where(condicionPendientesFirma(ctx));
  return r?.n ?? 0;
}
