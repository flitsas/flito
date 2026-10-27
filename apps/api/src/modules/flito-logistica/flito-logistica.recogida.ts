// FLITO Logística — confirmar la recogida con el acta de ORGANISMO (HU #14110, ADR-0030 §5/§7/§9/§10).
//
// Una sola acta (punto='organismo', sin compañía) y UNA firma del funcionario cubren las LT de varias
// compañías; cada LT queda como línea con su compañía. RN: el acta de organismo NO bloquea nada — apaga el
// indicador `acta_organismo_pendiente` y nada más. La cédula del firmante se guarda CIFRADA (+ últimos 4).
// Nunca se loguea ni se audita nombre, cédula ni firma.

import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { flitoLogisticaActaFirmas, flitoLogisticaActaLineas, flitoLogisticaActas, flitoLogisticaDocumentos, flitoLogisticaEventos } from '../../db/schema.js';
import { uploadEntityDocument } from '../../services/storage.js';
import { LogisticaError, log, type LogisticaCtx } from './flito-logistica.base.js';
import { imagenDesdeDataUrl } from './flito-logistica.imagen.js';
import { limpiarDocumento, protegerDocumento } from './flito-logistica.cifrado.js';

export interface FirmanteOrganismo { nombre: string; documento: string; firma: string }
export interface ConfirmarRecogidaInput {
  organismoCodigo: string; documentoIds: string[]; firmante: FirmanteOrganismo; lat?: string; lng?: string;
}
export interface RecogidaConfirmada { actaId: string; documentos: number; companias: number[] }

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
      }).from(flitoLogisticaDocumentos).where(inArray(flitoLogisticaDocumentos.id, ids))
        .orderBy(flitoLogisticaDocumentos.id).for('update');

      const hallados = new Set(docs.map((d) => d.id));
      const faltan = ids.filter((i) => !hallados.has(i));
      if (faltan.length) throw new LtNoEncontradaError(faltan);
      const otros = docs.filter((d) => d.organismoCodigo !== input.organismoCodigo).map((d) => d.id);
      if (otros.length) throw new LtOtroOrganismoError(otros);

      if (!ctx.operaAjenas) {
        // Propia = la recogió este usuario (primer evento del documento, el del escaneo).
        const propias = await tx.select({ id: flitoLogisticaEventos.documentoId }).from(flitoLogisticaEventos)
          .where(and(inArray(flitoLogisticaEventos.documentoId, ids), eq(flitoLogisticaEventos.actorId, ctx.userId), sql`${flitoLogisticaEventos.estadoAnterior} IS NULL`));
        const mias = new Set(propias.map((p) => p.id));
        if (ids.some((i) => !mias.has(i))) throw new LtAjenaError();
      }

      const yaEn = await tx.select({ id: flitoLogisticaActaLineas.documentoId }).from(flitoLogisticaActaLineas)
        .where(and(inArray(flitoLogisticaActaLineas.documentoId, ids), eq(flitoLogisticaActaLineas.punto, 'organismo')));
      if (yaEn.length) throw new LtYaEnActaOrganismoError(yaEn.map((r) => r.id));

      const ahora = new Date();
      const [acta] = await tx.insert(flitoLogisticaActas).values({
        companiaId: null, punto: 'organismo', organismoCodigo: input.organismoCodigo,
        // Terminal desde el nacimiento: el acta de organismo es una constancia, no entra al despacho.
        estado: 'entregada', mensajeroId: ctx.userId, entregadoEn: ahora,
        entregadoLat: input.lat ?? null, entregadoLng: input.lng ?? null,
      }).returning({ id: flitoLogisticaActas.id });

      const firmaId = randomUUID();
      const firmaKey = await uploadEntityDocument('flito-logistica-firmas-organismo', acta.id, mime === 'image/png' ? 'firma.png' : 'firma.jpg', buf, mime);
      const prot = protegerDocumento(documento, firmaId);
      await tx.insert(flitoLogisticaActaFirmas).values({
        id: firmaId, actaId: acta.id, rol: 'entrega', nombre: nombre.slice(0, 150),
        documentoCifrado: prot.cifrado, documentoUltimos: prot.ultimos, firmaStorageKey: firmaKey,
        usuarioId: null, firmadoEn: ahora, lat: input.lat ?? null, lng: input.lng ?? null,
      });

      await tx.insert(flitoLogisticaActaLineas).values(docs.map((d) => ({
        actaId: acta.id, documentoId: d.id, punto: 'organismo', companiaId: d.companiaId,
      })));
      await tx.update(flitoLogisticaDocumentos)
        .set({ actaOrganismoPendiente: false, updatedAt: ahora }).where(inArray(flitoLogisticaDocumentos.id, ids));
      // Evento sin cambio de estado; el payload solo lleva ids (nunca PII).
      await tx.insert(flitoLogisticaEventos).values(docs.map((d) => ({
        documentoId: d.id, estadoAnterior: d.estado, estadoNuevo: d.estado, actorId: ctx.userId,
        lat: input.lat ?? null, lng: input.lng ?? null, origen: 'usuario',
        tipo: 'acta_organismo', actaId: acta.id, payload: { actaId: acta.id, organismoCodigo: input.organismoCodigo },
      })));

      const companias = [...new Set(docs.map((d) => d.companiaId).filter((c): c is number => c !== null))].sort((a, b) => a - b);
      log.info({ actaId: acta.id, documentos: docs.length, companias: companias.length }, 'recogida confirmada con acta de organismo');
      return { actaId: acta.id, documentos: docs.length, companias };
    });
  } catch (e) {
    // Red de la BD (uq_flito_log_acta_linea_organismo): la carrera perdida también es 409.
    if (esUnicaViolada(e)) throw new LtYaEnActaOrganismoError([]);
    throw e;
  }
}
