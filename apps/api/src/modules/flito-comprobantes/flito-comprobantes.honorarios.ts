// Comprobantes universales (Épica #12245, Feature #12606, ADR-0018 §4) — HU #12631: la FILA DOCUMENTAL
// de los honorarios (trámite digital, logística, servicios adicionales).
//
// Estos conceptos no tienen dueño aparte (a diferencia de SOAT / impuesto / derecho, HU #12630): el
// pago vive en la propia fila del comprobante —`valor`, `fecha_documento`, `numero_documento`— con la
// tarifa de referencia y la diferencia calculadas al aplicar, para que F3 (#12607) las lleve al reporte
// y a la liquidación sin releer el documento (`flito-comprobantes.expr.ts`).
//
//   · tarifa_referencia: `tarifaDe(companiaId, concepto, tipoTramite, fechaAprobacion)` (trámite
//     digital / logística) o `SUM(valor)` de los servicios adicionales asignados al trámite.
//   · diferencia_tarifa = valor − (tarifa_referencia ?? 0); tolerancia 0 (D10).
//   · marcado_por_diferencia = tarifa_referencia IS NULL OR diferencia_tarifa ≠ 0 (mutante AC1: sin
//     tarifa se marca aunque la «diferencia» no sea cero por sí sola).
//   · servicios adicionales: la fila se escribe igual pero su valor NO manda (el sellado y Siigo siguen
//     leyendo el catálogo); solo aporta la diferencia (cierre (a)).
//
// Guardas (AC2), DENTRO de la tx y tras los `FOR UPDATE` (ADR-0017 §2): trámite con fila en
// `flito_liquidaciones` → 409 `tramite_liquidado`, nada se escribe; el 23505 del índice único parcial
// `idx_flito_comprobantes_valor_documental` → 409 `valor_ya_documentado { comprobanteAnteriorId }`.
// Autogestión (D8): se aplica igual; que el reporte no lo cobre es F3.
//
// Ningún log lleva contenido leído (Habeas Data).

import { and, eq, sql } from 'drizzle-orm';
import { CodigoErrorComprobante, ConceptoCosto, EstadoComprobante } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoComprobantes, flitoTramites, flitoTramiteServiciosAdicionales } from '../../db/schema.js';
import { tarifaDe } from '../flito-parametrizacion/flito-tarifas.service.js';
import { tramiteLiquidado, type Tx } from '../finanzas-servicios-adicionales/finanzas-servicios-adicionales.service.js';
import { ComprobanteError } from './flito-comprobantes.service.js';
import type { ConceptoHonorario } from './flito-comprobantes.expr.js';

/** Nombre del índice único parcial (0198) que impide dos pagos documentados del mismo (trámite, concepto). */
export const INDICE_VALOR_DOCUMENTAL = 'idx_flito_comprobantes_valor_documental';

/** Lo que la fila `aplicado` de un honorario lleva además del valor copiado. */
export interface ValorDocumental {
  tarifaReferencia: string | null;
  diferenciaTarifa: string;
  marcadoPorDiferencia: boolean;
}

// ─────────────────────────── Errores ─────────────────────────────────────────

export const valorRequerido = () =>
  new ComprobanteError(400, CodigoErrorComprobante.VALOR_REQUERIDO, 'Aplicar como pago exige el valor total del documento');
const tramiteSellado = () =>
  new ComprobanteError(409, CodigoErrorComprobante.TRAMITE_LIQUIDADO, 'El trámite ya está liquidado', { detalle: 'Liquidación sellada' });
const valorYaDocumentado = (comprobanteAnteriorId: string | undefined) =>
  new ComprobanteError(409, CodigoErrorComprobante.VALOR_YA_DOCUMENTADO, 'Ese trámite ya tiene un comprobante de pago aplicado para este concepto',
    comprobanteAnteriorId ? { comprobanteAnteriorId } : {});

// ─────────────────────────── Tarifa de referencia y diferencia (AC1) ─────────

const dosDecimales = (n: number): string => n.toFixed(2);

/**
 * La tarifa contra la que se compara el valor leído: la vigente en la fecha de aprobación del trámite
 * para su compañía (trámite digital por tipo; logística genérica), o la suma de los servicios
 * adicionales asignados. `null` = «no configurada» / sin servicios: se marca (AC1).
 */
export async function tarifaReferenciaDe(tx: Tx, tramiteId: string, concepto: ConceptoHonorario): Promise<number | null> {
  if (concepto === ConceptoCosto.SERVICIOS_ADICIONALES) {
    const [s] = await tx.select({ total: sql<string | null>`sum(${flitoTramiteServiciosAdicionales.valor})` })
      .from(flitoTramiteServiciosAdicionales).where(eq(flitoTramiteServiciosAdicionales.tramiteId, tramiteId));
    return s?.total == null ? null : Number(s.total);
  }
  const [t] = await tx.select({ companiaId: flitoTramites.companiaId, tipoTramite: flitoTramites.tipoTramite, fechaAprobacion: flitoTramites.fechaAprobacion })
    .from(flitoTramites).where(eq(flitoTramites.id, tramiteId)).limit(1);
  if (!t) return null;
  return (await tarifaDe(t.companiaId ?? null, concepto, t.tipoTramite ?? null, t.fechaAprobacion ?? null)).valor;
}

/** `diferencia = valor − (tarifa ?? 0)`; marcado si no hay tarifa o la diferencia no es cero (tolerancia 0, D10). */
export function calcularDiferencia(valor: string, tarifaReferencia: number | null): ValorDocumental {
  const diferencia = Number(valor) - (tarifaReferencia ?? 0);
  return {
    tarifaReferencia: tarifaReferencia === null ? null : dosDecimales(tarifaReferencia),
    diferenciaTarifa: dosDecimales(diferencia),
    marcadoPorDiferencia: tarifaReferencia === null || diferencia !== 0,
  };
}

/** Tarifa + diferencia de un honorario, dentro de la tx (tras los `FOR UPDATE`). */
export async function valorDocumentalDe(tx: Tx, tramiteId: string, concepto: ConceptoHonorario, valor: string): Promise<ValorDocumental> {
  return calcularDiferencia(valor, await tarifaReferenciaDe(tx, tramiteId, concepto));
}

// ─────────────────────────── Guardas (AC2) ───────────────────────────────────

/** Bajo el bloqueo del trámite: con liquidación (cualquier estado) el honorario no se aplica (409, nada escrito). */
export async function exigirNoLiquidado(tx: Tx, tramiteId: string): Promise<void> {
  if (await tramiteLiquidado(tx, tramiteId)) throw tramiteSellado();
}

/** ¿Es el 23505 del índice único parcial de la fila documental? (crudo de `pg`, o envuelto por Drizzle en `cause`). */
export function esDuplicadoDocumental(e: unknown): boolean {
  const candidatos = [e, (e as { cause?: unknown })?.cause];
  return candidatos.some((c) => {
    const err = c as { code?: string; constraint?: string; message?: string } | undefined;
    return err?.code === '23505' && (err.constraint === INDICE_VALOR_DOCUMENTAL || (err.message ?? '').includes(INDICE_VALOR_DOCUMENTAL));
  });
}

/**
 * Traduce el 23505 (la tx ya abortó: se busca FUERA de ella) a 409 `valor_ya_documentado` con el id del
 * comprobante que ya documenta ese (trámite, concepto). Cualquier otro error se devuelve tal cual.
 */
export async function traducirDuplicado(e: unknown, tramiteId: string, concepto: ConceptoHonorario): Promise<unknown> {
  if (!esDuplicadoDocumental(e)) return e;
  const [anterior] = await db.select({ id: flitoComprobantes.id }).from(flitoComprobantes)
    .where(and(eq(flitoComprobantes.tramiteId, tramiteId), eq(flitoComprobantes.concepto, concepto), eq(flitoComprobantes.estado, EstadoComprobante.APLICADO), eq(flitoComprobantes.esPago, true)))
    .limit(1);
  return valorYaDocumentado(anterior?.id);
}
