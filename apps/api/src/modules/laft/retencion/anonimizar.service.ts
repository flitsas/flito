// LAFT/SARLAFT v2 · F5 — Anonimización de PII tras 10 años (Ley 1121 + UIAF).
//
// La anonimización NO borra el registro: preserva id, riskLevel, status, factores,
// timestamps. Sólo nulifica/redacta nombres, documentos, emails, teléfonos y los
// campos cifrados. Esto preserva integridad referencial (FKs) y permite reportería
// agregada estadística sin exponer PII de personas que ya no son contraparte activa.
//
// Idempotente: si el registro ya está anonimizado (fullName == 'ANONIMIZADO'), el
// UPDATE es no-op. El cron y endpoint manual lo invocan con el mismo cutoff sin
// efectos secundarios extra.

import { lt, sql, eq, ne, and } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { laftCounterparties, pesvRetencionLog, pesvRetencionPoliticas } from '../../../db/schema.js';
import { loggerFor } from '../../../shared/logger.js';

const slog = loggerFor('laft-anonimizar');

const ANONIMIZADO = 'ANONIMIZADO';

export interface AnonimizarResult {
  tipoDocumento: string;
  cutoffDate: string;
  cantidadAfectada: number;
  modoSimulacion: boolean;
}

export async function anonimizarLaftCounterparties(
  cutoffDate: Date,
  options: { simulacion?: boolean; userId?: number | null } = {},
): Promise<AnonimizarResult> {
  const cutoffIso = cutoffDate.toISOString().slice(0, 10);
  const simulacion = options.simulacion ?? true;

  // Idempotencia: solo afectamos filas que NO estén ya anonimizadas.
  const where = and(
    lt(laftCounterparties.createdAt, cutoffDate),
    ne(laftCounterparties.fullName, ANONIMIZADO),
  );

  if (simulacion) {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` })
      .from(laftCounterparties).where(where);
    return {
      tipoDocumento: 'laft_counterparty',
      cutoffDate: cutoffIso,
      cantidadAfectada: Number(n ?? 0),
      modoSimulacion: true,
    };
  }

  // Modo real: UPDATE + log dentro de TX para garantizar atomicidad.
  const result = await db.transaction(async (tx) => {
    const updated = await tx.update(laftCounterparties).set({
      fullName: ANONIMIZADO,
      docNumber: ANONIMIZADO,
      email: null,
      phone: null,
      address: null,
      city: null,
      pepRole: null,
      pepKinship: null,
      docNumberEnc: null,
      docNumberHash: null,
      emailEnc: null,
      phoneEnc: null,
      blockReason: null,
      updatedAt: new Date(),
    }).where(where).returning({ id: laftCounterparties.id });

    // Buscar policy para registrar el log con politicaId.
    const [pol] = await tx.select({ id: pesvRetencionPoliticas.id })
      .from(pesvRetencionPoliticas)
      .where(eq(pesvRetencionPoliticas.tipoDocumento, 'laft_counterparty'))
      .limit(1);

    await tx.insert(pesvRetencionLog).values({
      politicaId: pol?.id ?? null,
      tipoDocumento: 'laft_counterparty',
      cantidadAfectada: updated.length,
      cutoffDate: cutoffIso,
      accion: 'anonimizar',
      ejecutadoPorCron: options.userId == null,
      ejecutadoPorUser: options.userId ?? null,
      detalleMd: `LAFT counterparties anonimizadas (cutoff ${cutoffIso}). Total: ${updated.length}.`,
    });
    return updated.length;
  });

  slog.info({ cutoffIso, cantidad: result, userId: options.userId }, 'anonimización LAFT counterparties ejecutada');

  return {
    tipoDocumento: 'laft_counterparty',
    cutoffDate: cutoffIso,
    cantidadAfectada: result,
    modoSimulacion: false,
  };
}
