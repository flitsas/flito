// FLITO Logística — confirmar la recogida con el acta de ORGANISMO (HU #14110, ADR-0030 §5/§7/§9/§10).
//
// ADR-0030 §17.1: UNA acta de organismo POR COMPAÑÍA, y la firma del funcionario se pide UNA vez: vive en una sola
// fila de `flito_logistica_recogida_firmantes` (cédula CIFRADA + últimos 4) que referencian todas las actas
// (`actas.firmante_id`). La LT pendiente de trámite (`tramite_id` NULL) lleva la firma (`recogida_firmante_id`)
// pero NO acta. RN: el acta de organismo NO bloquea nada — apaga `acta_organismo_pendiente` y nada más.
// Nunca se loguea ni se audita nombre, cédula ni firma.

import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { flitoLogisticaActaLineas, flitoLogisticaActas, flitoLogisticaDocumentos, flitoLogisticaEventos, flitoLogisticaRecogidaFirmantes } from '../../db/schema.js';
import { uploadEntityDocument } from '../../services/storage.js';
import { LogisticaError, log, type LogisticaCtx } from './flito-logistica.base.js';
import { imagenDesdeDataUrl } from './flito-logistica.imagen.js';
import { limpiarDocumento, protegerDocumento } from './flito-logistica.cifrado.js';

export interface FirmanteOrganismo { nombre: string; documento: string; firma: string }
export interface ConfirmarRecogidaInput {
  organismoCodigo: string; documentoIds: string[]; firmante: FirmanteOrganismo; lat?: string; lng?: string;
}
export interface RecogidaConfirmada {
  firmanteId: string; actas: Array<{ actaId: string; companiaId: number; documentos: number }>; pendientesTramite: number;
}

/** Estados en los que aún tiene sentido firmar la recogida (ADR-0030 §17.4). */
export const ESTADOS_CONFIRMABLES = ['recogido', 'clasificado', 'en_acta', 'despachado', 'en_flit'] as const;

export class LtYaEnActaOrganismoError extends LogisticaError {
  constructor(documentoIds: string[]) { super('Una o más LT ya están en un acta de organismo', 409, { documentoIds }, 'LT_YA_EN_ACTA_ORGANISMO'); }
}
export class FirmanteIncompletoError extends LogisticaError {
  constructor() { super('El nombre, la cédula y la firma del funcionario son obligatorios', 422, undefined, 'FIRMANTE_INCOMPLETO'); }
}
class LtNoEncontradaError extends LogisticaError {
  constructor(faltan: string[]) { super('Una o más LT no existen', 422, { documentoIds: faltan }, 'LT_NO_ENCONTRADA'); }
}
class LtOtroOrganismoError extends LogisticaError {
  constructor(ids: string[]) { super('Una o más LT no pertenecen al organismo indicado', 422, { documentoIds: ids }, 'LT_DE_OTRO_ORGANISMO'); }
}
class LtEstadoNoConfirmableError extends LogisticaError {
  constructor(ids: string[]) { super('Una o más LT no están en un estado en el que se pueda confirmar la recogida', 409, { documentoIds: ids }, 'LT_ESTADO_NO_CONFIRMABLE'); }
}
class LtAjenaError extends LogisticaError {
  constructor() { super('Solo puedes confirmar la recogida de las LT que recogiste tú', 403, undefined, 'LT_AJENA'); }
}

const esUnicaViolada = (e: unknown): boolean => {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code === '23505' || err?.cause?.code === '23505';
};

export async function confirmarRecogida(input: ConfirmarRecogidaInput, ctx: LogisticaCtx): Promise<RecogidaConfirmada> {
  const nombre = input.firmante.nombre?.trim();
  const documento = limpiarDocumento(input.firmante.documento ?? '');
  if (!nombre || documento.length < 4 || !input.firmante.firma?.trim()) throw new FirmanteIncompletoError();
  const { buf, mime } = imagenDesdeDataUrl(input.firmante.firma); // 422 antes de abrir transacción ni tocar el storage
  const ids = [...new Set(input.documentoIds)].sort(); // orden estable de bloqueo (sin deadlocks)

  try {
    return await db.transaction(async (tx) => {
      // Bloqueo ordenado por id y relectura del estado dentro de la tx (carrera → el perdedor ve la línea).
      const docs = await tx.select({
        id: flitoLogisticaDocumentos.id, estado: flitoLogisticaDocumentos.estado,
        organismoCodigo: flitoLogisticaDocumentos.organismoCodigo, companiaId: flitoLogisticaDocumentos.companiaId,
        tramiteId: flitoLogisticaDocumentos.tramiteId, firmanteId: flitoLogisticaDocumentos.recogidaFirmanteId,
      }).from(flitoLogisticaDocumentos).where(inArray(flitoLogisticaDocumentos.id, ids))
        .orderBy(flitoLogisticaDocumentos.id).for('update');

      const hallados = new Set(docs.map((d) => d.id));
      const faltan = ids.filter((i) => !hallados.has(i));
      if (faltan.length) throw new LtNoEncontradaError(faltan);
      const otros = docs.filter((d) => d.organismoCodigo !== input.organismoCodigo).map((d) => d.id);
      if (otros.length) throw new LtOtroOrganismoError(otros);
      const admitidos: readonly string[] = ESTADOS_CONFIRMABLES;
      const fueraDeEstado = docs.filter((d) => !admitidos.includes(d.estado)).map((d) => d.id);
      if (fueraDeEstado.length) throw new LtEstadoNoConfirmableError(fueraDeEstado);

      if (!ctx.operaAjenas) {
        // Propia = la recogió este usuario (primer evento del documento, el del escaneo).
        const propias = await tx.select({ id: flitoLogisticaEventos.documentoId }).from(flitoLogisticaEventos)
          .where(and(inArray(flitoLogisticaEventos.documentoId, ids), eq(flitoLogisticaEventos.actorId, ctx.userId), sql`${flitoLogisticaEventos.estadoAnterior} IS NULL`));
        const mias = new Set(propias.map((p) => p.id));
        if (ids.some((i) => !mias.has(i))) throw new LtAjenaError();
      }

      const yaEn = await tx.select({ id: flitoLogisticaActaLineas.documentoId }).from(flitoLogisticaActaLineas)
        .where(and(inArray(flitoLogisticaActaLineas.documentoId, ids), eq(flitoLogisticaActaLineas.punto, 'organismo')));
      // Una LT ya firmada (también la pendiente de trámite, que aún no tiene línea) no se vuelve a confirmar.
      const yaFirmadas = docs.filter((d) => d.firmanteId !== null).map((d) => d.id);
      const repetidas = [...new Set([...yaEn.map((r) => r.id), ...yaFirmadas])];
      if (repetidas.length) throw new LtYaEnActaOrganismoError(repetidas);

      // LT sin trámite (o sin compañía): llevan la firma, no acta.
      const conActa = docs.filter((d) => d.tramiteId !== null && d.companiaId !== null);
      const pendientes = docs.filter((d) => d.tramiteId === null || d.companiaId === null);

      const ahora = new Date();
      const firmanteId = randomUUID(); // AAD del cifrado: se necesita ANTES del INSERT
      const firmaKey = await uploadEntityDocument('flito-logistica-firmas-organismo', firmanteId, mime === 'image/png' ? 'firma.png' : 'firma.jpg', buf, mime);
      const prot = protegerDocumento(documento, firmanteId);
      await tx.insert(flitoLogisticaRecogidaFirmantes).values({
        id: firmanteId, organismoCodigo: input.organismoCodigo, nombre: nombre.slice(0, 150),
        documentoCifrado: prot.cifrado, documentoUltimos: prot.ultimos, firmaStorageKey: firmaKey,
        registradoPorId: ctx.userId, firmadoEn: ahora, lat: input.lat ?? null, lng: input.lng ?? null,
      });

      const porCompania = new Map<number, typeof conActa>();
      for (const d of conActa) porCompania.set(d.companiaId!, [...(porCompania.get(d.companiaId!) ?? []), d]);
      const actas: RecogidaConfirmada['actas'] = [];
      for (const companiaId of [...porCompania.keys()].sort((a, b) => a - b)) {
        const grupo = porCompania.get(companiaId)!;
        const [acta] = await tx.insert(flitoLogisticaActas).values({
          companiaId, punto: 'organismo', organismoCodigo: input.organismoCodigo, firmanteId,
          // Terminal desde el nacimiento: el acta de organismo es una constancia, no entra al despacho.
          estado: 'entregada', mensajeroId: ctx.userId, entregadoEn: ahora,
          entregadoLat: input.lat ?? null, entregadoLng: input.lng ?? null,
        }).returning({ id: flitoLogisticaActas.id });
        await tx.insert(flitoLogisticaActaLineas).values(grupo.map((d) => ({ actaId: acta.id, documentoId: d.id, punto: 'organismo', companiaId })));
        // Evento sin cambio de estado; el payload solo lleva ids (nunca PII).
        await tx.insert(flitoLogisticaEventos).values(grupo.map((d) => ({
          documentoId: d.id, estadoAnterior: d.estado, estadoNuevo: d.estado, actorId: ctx.userId,
          lat: input.lat ?? null, lng: input.lng ?? null, origen: 'usuario',
          tipo: 'acta_organismo', actaId: acta.id, payload: { actaId: acta.id, firmanteId, organismoCodigo: input.organismoCodigo },
        })));
        actas.push({ actaId: acta.id, companiaId, documentos: grupo.length });
      }
      if (conActa.length) {
        await tx.update(flitoLogisticaDocumentos).set({ actaOrganismoPendiente: false, recogidaFirmanteId: firmanteId, updatedAt: ahora })
          .where(inArray(flitoLogisticaDocumentos.id, conActa.map((d) => d.id)));
      }
      if (pendientes.length) {
        // La firma queda capturada; el acta nace cuando se resuelva el trámite (`acta_organismo_pendiente` sigue en true).
        await tx.update(flitoLogisticaDocumentos).set({ recogidaFirmanteId: firmanteId, updatedAt: ahora })
          .where(inArray(flitoLogisticaDocumentos.id, pendientes.map((d) => d.id)));
        await tx.insert(flitoLogisticaEventos).values(pendientes.map((d) => ({
          documentoId: d.id, estadoAnterior: d.estado, estadoNuevo: d.estado, actorId: ctx.userId,
          lat: input.lat ?? null, lng: input.lng ?? null, origen: 'usuario',
          tipo: 'acta_organismo', payload: { firmanteId, organismoCodigo: input.organismoCodigo, pendienteTramite: true },
        })));
      }

      log.info({ firmanteId, actas: actas.length, documentos: docs.length, pendientesTramite: pendientes.length }, 'recogida confirmada con acta de organismo por compañía');
      return { firmanteId, actas, pendientesTramite: pendientes.length };
    });
  } catch (e) {
    // Red de la BD (uq_flito_log_actas_firmante_compania / uq_flito_log_acta_linea_organismo): la carrera perdida también es 409.
    if (esUnicaViolada(e)) throw new LtYaEnActaOrganismoError([]);
    throw e;
  }
}
