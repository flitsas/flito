// FLITO Impuestos — reemplazo del comprobante de pago de un impuesto pagado y reenvío a FLIT 2
// (HU #13269, Feature #13267, Épica #12741, ADR-0020; diseño `docs/diseno/feature-13267-…` §12).
//
// RN-R1 Solo sobre un impuesto `pagado` con comprobante de pago (`recibo_impuesto`) VIGENTE. Sin él →
//   409 `sin_comprobante_vigente`: se usa la carga normal (AC4). El recibo de caja no se reemplaza aquí.
// RN-R2 Mismas validaciones que la carga desde el impuesto (HU #13208): MIME real y tamaño en la ruta
//   (helpers compartidos con flito-impuestos.recibo-fase.routes.ts), y hash, OCR, placa, sello y
//   número de recibo con `hashReciboYaCargado` + `validarComprobantePorId`. Un rechazo no escribe nada
//   (salvo la auditoría del rechazo): el comprobante anterior sigue vigente y no se envía nada (AC3).
// RN-R3 UNA transacción, con el impuesto bloqueado (`FOR UPDATE`) y los vigentes releídos dentro:
//   descarta los vigentes → inserta el nuevo → audita (usuario, impuesto, ids; sin PII) →
//   `reprogramarEnvioFlit2` con ESA tx (RN-10 del envío). Si entre la lectura y el bloqueo otro
//   reemplazo se llevó los vigentes, o el impuesto dejó de estar pagado, → 409 sin escribir.
// RN-R4 Solo cambia el documento: `extraccion`, `valor_pagado` y `pagado_en` del impuesto no se tocan.

import { createHash } from 'crypto';
import { and, eq, inArray } from 'drizzle-orm';
import {
  CodigoErrorReemplazoComprobante, EstadoImpuesto, FaseRecibo, TipoSoporte, type RespuestaReemplazoComprobante,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoImpuestos, flitoSoportes } from '../../db/schema.js';
import { buscarConAcceso } from './flito-impuestos.service.js';
import { reprogramarEnvioFlit2 } from './flito-impuestos.envio-flit2.service.js';
import {
  DETALLE_CARGA_POR_FASE, archivar, auditEnTx, candidatoPorImpuestoId, hashReciboYaCargado, insertarSoporte,
  validarComprobantePorId,
} from './flito-recibos.service.js';
import type { ArchivoSubido, ImpuestoCtx } from './flito-factura-venta.service.js';

/** Error de negocio del reemplazo: lleva `codigo` porque la pantalla decide por él. */
export class ReemplazoComprobanteError extends Error {
  constructor(public status: number, public codigo: CodigoErrorReemplazoComprobante, message: string) { super(message); }
}

export const MENSAJE_SIN_COMPROBANTE_VIGENTE =
  'Este impuesto no tiene un comprobante de pago cargado que reemplazar. Usa la carga normal del comprobante.';

/** Entre la comprobación y el bloqueo, el impuesto dejó de estar pagado o se quedó sin vigentes. */
class PagoCambiadoError extends Error {}

/** Ids de los comprobantes de pago vigentes (no descartados) del impuesto. */
async function pagosVigentes(escritor: Pick<typeof db, 'select'>, impuestoId: string): Promise<string[]> {
  const filas = await escritor.select({ id: flitoSoportes.id }).from(flitoSoportes).where(and(
    eq(flitoSoportes.impuestoId, impuestoId),
    eq(flitoSoportes.tipo, TipoSoporte.RECIBO_IMPUESTO),
    eq(flitoSoportes.descartado, false),
  ));
  return filas.map((f) => f.id);
}

/**
 * Reemplaza el comprobante de pago del impuesto `impuestoId` por `archivo` (MIME y tamaño ya validados
 * por la ruta). Orden de decisión —cada paso corta—:
 *   404 no_encontrado → id inexistente o fuera de la frontera (`buscarConAcceso`)
 *   409 estado_no_permitido → el impuesto no está `pagado`
 *   409 sin_comprobante_vigente → no hay comprobante de pago vigente (AC4)
 *   duplicado → archivo idéntico a uno ya cargado (hash del original)
 *   503 / placa_no_coincide / fase_no_coincide / duplicado → `validarComprobantePorId` (AC3)
 *   reemplazado → RN-R3 (AC1, AC5, AC6)
 */
export async function reemplazarComprobantePago(
  impuestoId: string, archivo: ArchivoSubido, ctx: ImpuestoCtx,
): Promise<RespuestaReemplazoComprobante> {
  const imp = await buscarConAcceso(impuestoId, ctx);
  if (!imp) throw new ReemplazoComprobanteError(404, CodigoErrorReemplazoComprobante.NO_ENCONTRADO, 'El impuesto no existe');
  if (imp.estado !== EstadoImpuesto.PAGADO) {
    throw new ReemplazoComprobanteError(409, CodigoErrorReemplazoComprobante.ESTADO_NO_PERMITIDO,
      'El comprobante de pago solo se reemplaza en un impuesto pagado.');
  }
  if ((await pagosVigentes(db, impuestoId)).length === 0) {
    throw new ReemplazoComprobanteError(409, CodigoErrorReemplazoComprobante.SIN_COMPROBANTE_VIGENTE, MENSAJE_SIN_COMPROBANTE_VIGENTE);
  }
  const hash = createHash('sha256').update(archivo.buffer).digest('hex');
  if (await hashReciboYaCargado(hash)) return { resultado: 'duplicado', detalle: DETALLE_CARGA_POR_FASE.ARCHIVO_REPETIDO };
  const cand = await candidatoPorImpuestoId(impuestoId);
  if (!cand) throw new ReemplazoComprobanteError(404, CodigoErrorReemplazoComprobante.NO_ENCONTRADO, 'El impuesto no existe');

  const validado = await validarComprobantePorId(cand, FaseRecibo.PAGO, archivo, ctx);
  if (validado.rechazo) return validado.rechazo;

  // Archiva ANTES de abrir la transacción, como la carga por fase (si la tx falla, queda huérfano en storage).
  const guardado = await archivar(cand, archivo);
  try {
    return await db.transaction(async (tx): Promise<RespuestaReemplazoComprobante> => {
      const [fila] = await tx.select({ estado: flitoImpuestos.estado }).from(flitoImpuestos)
        .where(eq(flitoImpuestos.id, impuestoId)).for('update');
      const descartados = await pagosVigentes(tx, impuestoId);
      if (!fila || fila.estado !== EstadoImpuesto.PAGADO || descartados.length === 0) throw new PagoCambiadoError();
      await tx.update(flitoSoportes).set({ descartado: true }).where(inArray(flitoSoportes.id, descartados));
      const soporteId = await insertarSoporte(tx, impuestoId, archivo, TipoSoporte.RECIBO_IMPUESTO, ctx, guardado, hash);
      await auditEnTx(tx, ctx, impuestoId,
        `Comprobante de pago reemplazado. Descartado(s): ${descartados.join(', ')}. Nuevo soporte ${soporteId}. Trámite ${cand.tramiteIdFlit}.`);
      const envioFlit2 = await reprogramarEnvioFlit2(tx, impuestoId, soporteId, ctx);
      return { resultado: 'reemplazado', soporteId, soportesDescartados: descartados, envioFlit2 };
    });
  } catch (e) {
    if (e instanceof PagoCambiadoError) {
      throw new ReemplazoComprobanteError(409, CodigoErrorReemplazoComprobante.SIN_COMPROBANTE_VIGENTE, MENSAJE_SIN_COMPROBANTE_VIGENTE);
    }
    throw e;
  }
}
