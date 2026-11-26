// Comprobantes — liberación por descarte (Épica #14707, ADR-0049 §5, D11). La llama el orquestador del sync
// (`flito-sync/descarte-tramite-muerto.ts`) DENTRO de la transacción en que el trámite pasó de vivo a muerto.
//
//   · Qué se libera: los comprobantes APLICADOS de concepto SOAT o impuesto de los trámites que recibe. El orquestador
//     decide a quién: el trámite muerto solo si es anulado/abortado (un revocado conserva lo cobrado, D8/D11) y,
//     siempre, los vivos desligados de un SOAT pagado descartado (D3a: pagaban un SOAT que ya no existe).
//   · Cómo: el núcleo de `desaplicar` con el dueño `conservar` (`liberarAplicadoEnTx`): devuelve la bolsa
//     (`revertirDescuentoComprobante`, libera la llave `salida:soat:<soatId>`) y el comprobante vuelve a `pendiente`
//     sin trámite, de vuelta a la cola.
//   · `FOR UPDATE SKIP LOCKED`: un comprobante bloqueado lo está desaplicando o aplicando otra persona. No se espera
//     (evita el bloqueo cruzado con el orden comprobante → trámite de `desaplicar`); la aplicación terminará en el
//     guard del trámite. Se cuenta como no liberado.
//   · Periodo de la bolsa cerrado → NO se libera, la tx sigue, queda en `audit_logs` y en el contador (decisión
//     cerrada 3: Finanzas lo corrige a mano). Las salidas de bolsa que no vienen de un comprobante (conciliación,
//     sellado) tampoco se revierten: se dejan auditadas.
//   · Logs y auditoría: ids y conceptos. Nunca VIN, placa ni PII.
import { and, eq, inArray } from 'drizzle-orm';
import { CodigoErrorComprobante, ConceptoCosto, EstadoComprobante } from '@operaciones/shared-types';
import { auditLogs, flitoComprobantes } from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';
import { movimientoPorLlave } from '../flito-bolsas/flito-bolsas.libro.js';
import type { Tx } from '../finanzas-servicios-adicionales/finanzas-servicios-adicionales.service.js';
import { ComprobanteError } from './flito-comprobantes.service.js';
import { liberarAplicadoEnTx } from './flito-comprobantes.desaplicar.js';

const log = loggerFor('flito-comprobantes-liberar-descarte');

export interface ResultadoLiberacion { liberados: number; noLiberados: number }

export interface PedidoLiberacion {
  /** Trámites cuyos comprobantes aplicados (SOAT / impuesto) se liberan. */
  tramiteIds: string[];
  /** Conceptos a liberar (el orquestador pasa SOAT y/o impuesto). */
  conceptos: ConceptoCosto[];
  /** Radicado del trámite muerto, para el motivo y la auditoría (no es PII). */
  radicado: string;
  /** SOAT descartado cuyo cobro por la llave `salida:soat:<id>` se revisa (conciliación / sellado). */
  soatDescartadoId?: string | null;
}

async function auditar(tx: Tx, resourceId: string, detail: string): Promise<void> {
  await tx.insert(auditLogs).values({ userId: null, userEmail: 'sistema', action: 'update', resource: 'flito_comprobante', resourceId, detail });
}

export async function liberarComprobantesDeDescarte(tx: Tx, p: PedidoLiberacion): Promise<ResultadoLiberacion> {
  const r: ResultadoLiberacion = { liberados: 0, noLiberados: 0 };
  if (p.tramiteIds.length > 0 && p.conceptos.length > 0) {
    const aplicados = and(
      inArray(flitoComprobantes.tramiteId, p.tramiteIds),
      eq(flitoComprobantes.estado, EstadoComprobante.APLICADO),
      inArray(flitoComprobantes.concepto, p.conceptos),
    );
    const todos = await tx.select({ id: flitoComprobantes.id }).from(flitoComprobantes).where(aplicados);
    const candidatos = await tx.select({ id: flitoComprobantes.id }).from(flitoComprobantes).where(aplicados)
      .orderBy(flitoComprobantes.id).for('update', { skipLocked: true });
    // Los que estaban aplicados pero no salieron (bloqueados por otra sesión) se cuentan como no liberados.
    const bloqueados = todos.length - candidatos.length;
    if (bloqueados > 0) {
      r.noLiberados += bloqueados;
      log.warn({ radicado: p.radicado, bloqueados }, 'comprobantes en uso por otra sesión: no se liberan en el descarte');
    }
    for (const c of candidatos) {
      try {
        await liberarAplicadoEnTx(tx, c.id, `trámite ${p.radicado} ya no existe en FLITO (Épica 14707)`);
        r.liberados += 1;
      } catch (e) {
        if (!(e instanceof ComprobanteError) || e.codigo !== CodigoErrorComprobante.PERIODO_CERRADO) throw e;
        r.noLiberados += 1;
        await auditar(tx, c.id, `Descarte del trámite ${p.radicado}: el comprobante no se liberó porque el periodo de la bolsa está cerrado (D11). Corregir a mano en Finanzas.`);
      }
    }
  }
  if (p.soatDescartadoId) {
    // Un cobro de la llave del SOAT que NO vino de un comprobante (conciliación, sellado) no se revierte solo.
    const vivo = await movimientoPorLlave(tx, `salida:soat:${p.soatDescartadoId}`);
    if (vivo && vivo.origen !== 'comprobante') {
      r.noLiberados += 1;
      await auditar(tx, p.soatDescartadoId, `Descarte del trámite ${p.radicado}: la salida de bolsa del SOAT (origen ${vivo.origen}) no se revierte automáticamente (D11). Corregir a mano en Finanzas.`);
    }
  }
  return r;
}
