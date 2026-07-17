import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import {
  laftCashTxns,
  laftCounterparties,
  laftParametros,
  laftUnusualOperations,
  laftCashIdempotencyKeys,
} from '../../../db/schema.js';
import { loggerFor } from '../../../shared/logger.js';

const log = loggerFor('laft-cash');

// =============================================================================
// Parámetros — leídos de BD con cache TTL corta. El PO los puede ajustar vía UI
// sin redeploy; un valor stale por hasta 60s es aceptable para detección RTE.
// =============================================================================

interface CashParams {
  umbralIndividualCop: number;
  umbralAcumuladoMensualCop: number;
  fetchedAt: number;
}

let _cache: CashParams | null = null;
const PARAMS_TTL_MS = 60_000;

export async function getCashParams(): Promise<CashParams> {
  if (_cache && Date.now() - _cache.fetchedAt < PARAMS_TTL_MS) return _cache;
  const rows = await db.select({ clave: laftParametros.clave, valor: laftParametros.valor })
    .from(laftParametros);
  const map = new Map(rows.map((r) => [r.clave, r.valor]));
  const ind = parseInt(map.get('rte_umbral_individual_cop') ?? '10000000', 10);
  const acum = parseInt(map.get('rte_umbral_acumulado_mensual_cop') ?? '50000000', 10);
  // Defensa: si la BD trae un valor inválido, no hacemos breach falso.
  const safeInd = Number.isFinite(ind) && ind > 0 ? ind : 10_000_000;
  const safeAcum = Number.isFinite(acum) && acum > 0 ? acum : 50_000_000;
  _cache = { umbralIndividualCop: safeInd, umbralAcumuladoMensualCop: safeAcum, fetchedAt: Date.now() };
  return _cache;
}

/** Útil en tests para forzar relectura. */
export function resetCashParamsCache(): void { _cache = null; }

// =============================================================================
// Suma del mes acumulada en efectivo para una contraparte. Usa el índice
// (counterparty_id, fecha DESC). Devuelve número (0 si no hay filas).
// =============================================================================

export async function getCurrentMonthlySum(counterpartyId: number, fecha: Date | string): Promise<number> {
  const d = typeof fecha === 'string' ? new Date(fecha + 'T00:00:00Z') : fecha;
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const desde = `${y}-${String(m + 1).padStart(2, '0')}-01`;
  // último día del mes: día 0 del mes siguiente
  const last = new Date(Date.UTC(y, m + 1, 0));
  const hasta = `${last.getUTCFullYear()}-${String(last.getUTCMonth() + 1).padStart(2, '0')}-${String(last.getUTCDate()).padStart(2, '0')}`;
  const rows = await db.select({
    total: sql<string>`COALESCE(SUM(${laftCashTxns.amount}), 0)::text`,
  }).from(laftCashTxns)
    .where(and(
      eq(laftCashTxns.counterpartyId, counterpartyId),
      eq(laftCashTxns.kind, 'efectivo'),
      gte(laftCashTxns.fecha, desde),
      lte(laftCashTxns.fecha, hasta),
    ));
  return Number(rows[0]?.total ?? '0');
}

// =============================================================================
// Registro atómico de cash txn con detección de breach.
// El advisory lock por (counterparty_id, año, mes) serializa los registros
// concurrentes contra la misma contraparte en el mismo mes — sin esto, dos
// inserts simultáneos podrían leer suma=0 cada uno y no detectar el breach
// acumulado al cruzarse en la misma transacción.
// =============================================================================

export interface CashTxnInput {
  counterpartyId: number;
  amount: number;          // COP, positivo
  currency: string;        // 3 letras
  kind: 'efectivo' | 'cheque' | 'transferencia' | 'otro';
  fecha: string;           // YYYY-MM-DD
  descripcion?: string | null;
  numeroRecibo?: string | null;
}

export interface CashTxnResult {
  txn: typeof laftCashTxns.$inferSelect;
  breachIndividual: boolean;
  breachAcumulado: boolean;
  unusualOperationId: number | null;
  monthlySumAfter: number;
  idempotent: boolean;
}

/**
 * Registra una transacción en efectivo y, si supera umbrales, crea/asocia una
 * `laft_unusual_operations` con `signals: ['efectivo_umbral_individual'|...]`.
 *
 * Idempotency-Key opcional pero recomendada — si se pasa, la 2da llamada con la
 * misma key devuelve la misma fila (no duplica).
 */
export async function registrarCashTxn(
  input: CashTxnInput,
  userId: number,
  idempKey: string | null,
): Promise<CashTxnResult> {
  // Validar contraparte existe + no archivada
  const [cp] = await db.select({
    id: laftCounterparties.id,
    fullName: laftCounterparties.fullName,
    docNumber: laftCounterparties.docNumber,
    status: laftCounterparties.status,
  }).from(laftCounterparties).where(eq(laftCounterparties.id, input.counterpartyId));
  if (!cp) throw Object.assign(new Error('Contraparte no existe'), { httpStatus: 400 });
  if (cp.status === 'bloqueada') {
    // Permitimos registrar (auditoría) pero el caller debe saberlo.
    log.warn({ counterpartyId: cp.id }, 'cash txn sobre contraparte bloqueada — se registra para trazabilidad');
  }

  const params = await getCashParams();

  // Lock por (counterparty, año*100+mes) — serializa breach detection.
  const fechaDate = new Date(input.fecha + 'T00:00:00Z');
  const periodKey = fechaDate.getUTCFullYear() * 100 + (fechaDate.getUTCMonth() + 1);

  return await db.transaction(async (tx) => {
    // Idempotency check — 2da llamada con misma key devuelve fila previa.
    if (idempKey) {
      const [prev] = await tx.select().from(laftCashIdempotencyKeys)
        .where(and(eq(laftCashIdempotencyKeys.key, idempKey), eq(laftCashIdempotencyKeys.scope, 'cash_txn')))
        .limit(1);
      if (prev?.cashTxnId) {
        const [existing] = await tx.select().from(laftCashTxns).where(eq(laftCashTxns.id, prev.cashTxnId));
        if (existing) {
          return {
            txn: existing,
            breachIndividual: existing.thresholdIndividualBreached,
            breachAcumulado: existing.thresholdAcumuladoBreached,
            unusualOperationId: existing.unusualOperationId,
            monthlySumAfter: 0, // no recalculamos en idempotent return
            idempotent: true,
          };
        }
      }
    }

    // Advisory lock — pg_advisory_xact_lock libera al COMMIT.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`laft-cash-${input.counterpartyId}-${periodKey}`}))`);

    // Suma actual del mes (antes del insert)
    const [sumRow] = await tx.select({
      total: sql<string>`COALESCE(SUM(${laftCashTxns.amount}), 0)::text`,
    }).from(laftCashTxns)
      .where(and(
        eq(laftCashTxns.counterpartyId, input.counterpartyId),
        eq(laftCashTxns.kind, 'efectivo'),
        sql`EXTRACT(YEAR FROM ${laftCashTxns.fecha}) = ${fechaDate.getUTCFullYear()}`,
        sql`EXTRACT(MONTH FROM ${laftCashTxns.fecha}) = ${fechaDate.getUTCMonth() + 1}`,
      ));
    const monthlyBefore = Number(sumRow?.total ?? '0');
    const monthlyAfter = input.kind === 'efectivo' ? monthlyBefore + input.amount : monthlyBefore;

    const breachIndividual = input.kind === 'efectivo' && input.amount > params.umbralIndividualCop;
    // Breach acumulado: cruzamos el umbral al sumar este registro (no antes).
    const breachAcumulado = input.kind === 'efectivo'
      && monthlyBefore <= params.umbralAcumuladoMensualCop
      && monthlyAfter > params.umbralAcumuladoMensualCop;

    // INSERT cash txn. amount como string para precision NUMERIC.
    const [txn] = await tx.insert(laftCashTxns).values({
      counterpartyId: input.counterpartyId,
      amount: String(input.amount),
      currency: input.currency.toUpperCase(),
      kind: input.kind,
      fecha: input.fecha,
      descripcion: input.descripcion ?? null,
      numeroRecibo: input.numeroRecibo ?? null,
      thresholdIndividualBreached: breachIndividual,
      thresholdAcumuladoBreached: breachAcumulado,
      registradoPor: userId,
    }).returning();

    let unusualOperationId: number | null = null;
    if (breachIndividual || breachAcumulado) {
      const signals: string[] = [];
      if (breachIndividual) signals.push('efectivo_umbral_individual');
      if (breachAcumulado) signals.push('efectivo_umbral_acumulado_mensual');
      const description = breachIndividual && breachAcumulado
        ? `Transacción en efectivo de $${input.amount.toLocaleString('es-CO')} COP supera umbral individual ($${params.umbralIndividualCop.toLocaleString('es-CO')}) y al sumarla, supera el acumulado mensual ($${params.umbralAcumuladoMensualCop.toLocaleString('es-CO')}) para la contraparte ${cp.fullName} (${cp.docNumber}).`
        : breachIndividual
          ? `Transacción en efectivo de $${input.amount.toLocaleString('es-CO')} COP supera el umbral individual ($${params.umbralIndividualCop.toLocaleString('es-CO')}) para la contraparte ${cp.fullName} (${cp.docNumber}).`
          : `Acumulado mensual en efectivo cruzó el umbral ($${params.umbralAcumuladoMensualCop.toLocaleString('es-CO')}) — registro #${txn.id} sumó $${input.amount.toLocaleString('es-CO')} COP, total mes: $${monthlyAfter.toLocaleString('es-CO')} para ${cp.fullName} (${cp.docNumber}).`;

      const [op] = await tx.insert(laftUnusualOperations).values({
        counterpartyId: input.counterpartyId,
        detectedBy: userId,
        source: 'rte_breach',
        signals,
        amount: String(input.amount),
        currency: input.currency.toUpperCase(),
        description,
      }).returning({ id: laftUnusualOperations.id });
      unusualOperationId = op?.id ?? null;
      if (unusualOperationId) {
        await tx.update(laftCashTxns)
          .set({ unusualOperationId })
          .where(eq(laftCashTxns.id, txn.id));
      }
    }

    if (idempKey) {
      // Idempotency record. Como (key, scope) es PK, un INSERT duplicado devuelve 23505;
      // pero ya filtramos arriba, así que aquí no debería colisionar.
      await tx.insert(laftCashIdempotencyKeys).values({
        key: idempKey, scope: 'cash_txn', cashTxnId: txn.id, userId,
      }).onConflictDoNothing();
    }

    return {
      txn: { ...txn, unusualOperationId },
      breachIndividual,
      breachAcumulado,
      unusualOperationId,
      monthlySumAfter: monthlyAfter,
      idempotent: false,
    };
  });
}
