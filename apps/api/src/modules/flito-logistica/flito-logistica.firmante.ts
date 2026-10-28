// FLITO Logística — lectura del firmante del organismo y revelado de su cédula (HU #14110, ADR-0030 §17.1).
// La firma del organismo vive en UNA fila (`flito_logistica_recogida_firmantes`) que referencian las actas de
// organismo de cada compañía. La lectura normal SOLO expone los últimos 4 dígitos; el valor completo sale por
// `revelarDocumentoFirmante`, que la ruta protege con función propia, rateLimiter y logPiiAccess.

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { clients, flitoLogisticaActaLineas, flitoLogisticaActas, flitoLogisticaDocumentos, flitoLogisticaRecogidaFirmantes } from '../../db/schema.js';
import { LogisticaError, type LogisticaCtx } from './flito-logistica.base.js';
import { enmascarar, revelarDocumento } from './flito-logistica.cifrado.js';

const F = flitoLogisticaRecogidaFirmantes;

export interface RecogidaResumenDto {
  firmanteId: string; organismoCodigo: string; nombre: string; documentoEnmascarado: string | null; firmadoEn: string;
  actas: number; pendientesTramite: number;
}
export interface RecogidaDetalleDto extends Omit<RecogidaResumenDto, 'actas' | 'pendientesTramite'> {
  actas: Array<{ actaId: string; companiaId: number; companiaNombre: string | null; documentoIds: string[] }>;
  pendientesTramite: string[];
}

const noEncontrada = () => new LogisticaError('La recogida no existe', 404, undefined, 'RECOGIDA_NO_ENCONTRADA');

/** Mis recogidas confirmadas (las que firmé yo), más recientes primero. Sin PII más que la cédula enmascarada. */
export async function misRecogidas(ctx: LogisticaCtx): Promise<RecogidaResumenDto[]> {
  const rows = await db.select({
    firmanteId: F.id, organismoCodigo: F.organismoCodigo, nombre: F.nombre, ultimos: F.documentoUltimos, firmadoEn: F.firmadoEn,
    actas: sql<number>`(select count(*)::int from flito_logistica_actas a where a.firmante_id = ${F.id})`,
    pendientes: sql<number>`(select count(*)::int from flito_logistica_documentos d where d.recogida_firmante_id = ${F.id} and d.tramite_id is null)`,
  }).from(F).where(eq(F.registradoPorId, ctx.userId)).orderBy(desc(F.firmadoEn)).limit(100);
  return rows.map((r) => ({
    firmanteId: r.firmanteId, organismoCodigo: r.organismoCodigo, nombre: r.nombre, documentoEnmascarado: enmascarar(r.ultimos),
    firmadoEn: r.firmadoEn.toISOString(), actas: r.actas, pendientesTramite: r.pendientes,
  }));
}

/** Detalle de una recogida: firmante enmascarado, actas por compañía con sus LT y LT pendientes de trámite. */
export async function recogidaDetalle(firmanteId: string, ctx: LogisticaCtx): Promise<RecogidaDetalleDto> {
  const [f] = await db.select({
    id: F.id, organismoCodigo: F.organismoCodigo, nombre: F.nombre, ultimos: F.documentoUltimos, firmadoEn: F.firmadoEn, registradoPorId: F.registradoPorId,
  }).from(F).where(eq(F.id, firmanteId)).limit(1);
  // Un mensajero solo ve las que firmó él; una ajena responde igual que una inexistente.
  if (!f || (!ctx.operaAjenas && f.registradoPorId !== ctx.userId)) throw noEncontrada();
  const actas = await db.select({ actaId: flitoLogisticaActas.id, companiaId: flitoLogisticaActas.companiaId, companiaNombre: clients.name })
    .from(flitoLogisticaActas).leftJoin(clients, eq(flitoLogisticaActas.companiaId, clients.id))
    .where(eq(flitoLogisticaActas.firmanteId, firmanteId)).orderBy(flitoLogisticaActas.companiaId);
  const lineas = actas.length
    ? await db.select({ actaId: flitoLogisticaActaLineas.actaId, documentoId: flitoLogisticaActaLineas.documentoId })
      .from(flitoLogisticaActaLineas).where(inArray(flitoLogisticaActaLineas.actaId, actas.map((a) => a.actaId)))
    : [];
  const pend = await db.select({ id: flitoLogisticaDocumentos.id }).from(flitoLogisticaDocumentos)
    .where(and(eq(flitoLogisticaDocumentos.recogidaFirmanteId, firmanteId), isNull(flitoLogisticaDocumentos.tramiteId)));
  return {
    firmanteId: f.id, organismoCodigo: f.organismoCodigo, nombre: f.nombre, documentoEnmascarado: enmascarar(f.ultimos),
    firmadoEn: f.firmadoEn.toISOString(),
    actas: actas.map((a) => ({
      actaId: a.actaId, companiaId: a.companiaId as number, companiaNombre: a.companiaNombre,
      documentoIds: lineas.filter((l) => l.actaId === a.actaId).map((l) => l.documentoId),
    })),
    pendientesTramite: pend.map((p) => p.id),
  };
}

/** Cédula completa del firmante. 404 si no existe o ya fue purgada. */
export async function revelarDocumentoFirmante(firmanteId: string): Promise<string> {
  const [f] = await db.select({ id: F.id, cifrado: F.documentoCifrado }).from(F).where(eq(F.id, firmanteId)).limit(1);
  if (!f || !f.cifrado) throw new LogisticaError('El documento del firmante no está disponible', 404, undefined, 'DOCUMENTO_NO_DISPONIBLE');
  return revelarDocumento(f.cifrado, f.id);
}
