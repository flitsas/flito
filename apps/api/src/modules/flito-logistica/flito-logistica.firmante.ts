// FLITO Logística — lectura de las firmas de un acta y revelado de la cédula del firmante
// (HU #14110, ADR-0030 §5/§9). La lectura normal SOLO expone los últimos 4 dígitos; el valor completo
// sale por `revelarDocumentoFirmante`, que la ruta protege con función propia, rateLimiter y logPiiAccess.

import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { flitoLogisticaActaFirmas, flitoLogisticaActaLineas, flitoLogisticaActas } from '../../db/schema.js';
import { LogisticaError } from './flito-logistica.base.js';
import { enmascarar, revelarDocumento } from './flito-logistica.cifrado.js';

export interface FirmaActaDto { id: string; rol: string; nombre: string; documentoEnmascarado: string | null; firmadoEn: string }
export interface ExtrasActaDto {
  punto: string; organismoCodigo: string | null; firmas: FirmaActaDto[];
  lineas: Array<{ documentoId: string; companiaId: number | null }>;
}

/** Firmas (cédula enmascarada) y líneas del acta; sirve el detalle del acta de organismo. */
export async function extrasDeActa(actaId: string): Promise<ExtrasActaDto> {
  const [acta] = await db.select({ punto: flitoLogisticaActas.punto, organismoCodigo: flitoLogisticaActas.organismoCodigo })
    .from(flitoLogisticaActas).where(eq(flitoLogisticaActas.id, actaId)).limit(1);
  if (!acta) throw new LogisticaError('Acta no encontrada', 404);
  const firmas = await db.select({
    id: flitoLogisticaActaFirmas.id, rol: flitoLogisticaActaFirmas.rol, nombre: flitoLogisticaActaFirmas.nombre,
    ultimos: flitoLogisticaActaFirmas.documentoUltimos, firmadoEn: flitoLogisticaActaFirmas.firmadoEn,
  }).from(flitoLogisticaActaFirmas).where(eq(flitoLogisticaActaFirmas.actaId, actaId));
  const lineas = await db.select({ documentoId: flitoLogisticaActaLineas.documentoId, companiaId: flitoLogisticaActaLineas.companiaId })
    .from(flitoLogisticaActaLineas).where(eq(flitoLogisticaActaLineas.actaId, actaId));
  return {
    punto: acta.punto, organismoCodigo: acta.organismoCodigo, lineas,
    firmas: firmas.map((f) => ({ id: f.id, rol: f.rol, nombre: f.nombre, documentoEnmascarado: enmascarar(f.ultimos), firmadoEn: f.firmadoEn.toISOString() })),
  };
}

/** Cédula completa de una firma de ESE acta. 404 si no existe, no pertenece al acta o ya fue purgada. */
export async function revelarDocumentoFirmante(actaId: string, firmaId: string): Promise<string> {
  const [f] = await db.select({ id: flitoLogisticaActaFirmas.id, cifrado: flitoLogisticaActaFirmas.documentoCifrado })
    .from(flitoLogisticaActaFirmas)
    .where(and(eq(flitoLogisticaActaFirmas.id, firmaId), eq(flitoLogisticaActaFirmas.actaId, actaId))).limit(1);
  if (!f || !f.cifrado) throw new LogisticaError('El documento del firmante no está disponible', 404, undefined, 'DOCUMENTO_NO_DISPONIBLE');
  return revelarDocumento(f.cifrado, f.id);
}
