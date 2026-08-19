// Siigo — lo último que se usó al facturarle a cada cliente (A2). Migración 0147.
//
// **RECUERDA, no parametriza.** No hay pantalla que mantenga esto: se escribe sola cuando alguien
// envía trámites a facturación, y solo sirve para precargar el diálogo del siguiente envío. Si un
// cliente no tiene fila, el diálogo precarga la configuración global — que con A2 pasa a ser una
// semilla y no la fuente.
//
// Y por eso mismo NO es el historial. Con qué configuración salió cada factura vive en el lote, que
// es inmutable; esta tabla se pisa a sí misma en cada envío y solo responde «¿qué usamos la última
// vez con esta empresa?».

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { siigoEmisionCliente } from '../../db/schema.js';
import type { EmisionElegida } from './facturacion.armado.js';
import type { SiigoAmbiente } from './credenciales.service.js';

export interface EmisionRecordada extends EmisionElegida {
  clienteId: number;
  actualizadoEn: string;
}

/**
 * Lo recordado para estos clientes. Los que no tengan fila simplemente no salen.
 *
 * Se consulta en bloque y no uno por uno: el diálogo de envío abre con cuatro o cinco empresas
 * distintas y una consulta por empresa serían cinco viajes para pintar un formulario.
 */
export async function emisionRecordada(
  ambiente: SiigoAmbiente, clienteIds: number[],
): Promise<EmisionRecordada[]> {
  const ids = [...new Set(clienteIds)].filter((n) => Number.isInteger(n));
  if (ids.length === 0) return [];

  const filas = await db.select({
    clienteId: siigoEmisionCliente.clientId,
    documentoTipoCodigo: siigoEmisionCliente.documentoTipoCodigo,
    vendedorCodigo: siigoEmisionCliente.vendedorCodigo,
    formaPagoCodigo: siigoEmisionCliente.formaPagoCodigo,
    centroCostoCodigo: siigoEmisionCliente.centroCostoCodigo,
    updatedAt: siigoEmisionCliente.updatedAt,
  })
    .from(siigoEmisionCliente)
    .where(and(
      eq(siigoEmisionCliente.ambiente, ambiente),
      inArray(siigoEmisionCliente.clientId, ids),
    ));

  return filas.map((f) => ({
    clienteId: Number(f.clienteId),
    documentoTipoCodigo: f.documentoTipoCodigo ?? null,
    vendedorCodigo: f.vendedorCodigo ?? null,
    formaPagoCodigo: f.formaPagoCodigo ?? null,
    centroCostoCodigo: f.centroCostoCodigo ?? null,
    actualizadoEn: f.updatedAt.toISOString(),
  }));
}

/**
 * Deja constancia de lo que se acaba de usar con un cliente.
 *
 * **No lanza.** Es memoria de conveniencia, no un dato del que dependa la factura: si esta escritura
 * falla, el envío ya está encolado con su snapshot en el lote y lo único que se pierde es que el
 * próximo diálogo salga precargado. Convertir eso en un error abortaría un envío correcto por no
 * poder recordar una preferencia.
 */
export async function recordarEmision(
  ambiente: SiigoAmbiente, clienteId: number, emision: EmisionElegida, usuarioId: number | null,
): Promise<void> {
  try {
    await db.insert(siigoEmisionCliente)
      .values({
        clientId: clienteId,
        ambiente,
        documentoTipoCodigo: emision.documentoTipoCodigo,
        vendedorCodigo: emision.vendedorCodigo,
        formaPagoCodigo: emision.formaPagoCodigo,
        centroCostoCodigo: emision.centroCostoCodigo,
        actualizadoPor: usuarioId,
      })
      .onConflictDoUpdate({
        target: [siigoEmisionCliente.clientId, siigoEmisionCliente.ambiente],
        set: {
          documentoTipoCodigo: emision.documentoTipoCodigo,
          vendedorCodigo: emision.vendedorCodigo,
          formaPagoCodigo: emision.formaPagoCodigo,
          centroCostoCodigo: emision.centroCostoCodigo,
          actualizadoPor: usuarioId,
          updatedAt: new Date(),
        },
      });
  } catch {
    // Deliberadamente en silencio: ver la nota de arriba. El envío no depende de esto.
  }
}
