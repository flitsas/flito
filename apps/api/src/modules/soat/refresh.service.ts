import { eq, and } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { soatRequests, soatRefreshAttempts, vehicles } from '../../db/schema.js';
import { consultarVehiculoRunt } from '../runt/runt.service.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('soat-refresh');

export type RefreshResult =
  | { result: 'ok'; policyNumber: string; insurer: string | null; purchaseDate: string | null; expiryDate: string | null; soatHolder: string | null }
  | { result: 'not_indexed_yet'; message: string }
  | { result: 'owner_sync_pending'; message: string; runtMessage?: string }
  | { result: 'invalid_status'; message: string }
  | { result: 'not_found'; message: string }
  | { result: 'runt_error'; message: string; runtMessage?: string }
  | { result: 'concurrent_update'; message: string }
  | { result: 'internal_error'; message: string };

const POLICY_PLACEHOLDERS = new Set(['Pendiente', 'Pendiente verificación RUNT', 'Pendiente verificacion RUNT']);
const isPolicyPlaceholder = (p: string | null | undefined) => !p || POLICY_PLACEHOLDERS.has(p);

export async function refreshSoatFromRunt(
  soatRequestId: number,
  opts: { triggeredBy: 'manual' | 'cron'; triggeredByUser?: number | null } = { triggeredBy: 'manual' }
): Promise<RefreshResult> {
  const startedAt = Date.now();

  const logAttempt = async (r: RefreshResult, runtMessage?: string) => {
    try {
      await db.insert(soatRefreshAttempts).values({
        soatRequestId,
        triggeredBy: opts.triggeredBy,
        triggeredByUser: opts.triggeredByUser ?? null,
        result: r.result,
        message: 'message' in r ? r.message : null,
        durationMs: Date.now() - startedAt,
        runtMessage: runtMessage ?? null,
      });
    } catch (e) {
      log.error({ err: e, soatRequestId }, 'audit write failed');
    }
  };

  const [row] = await db.select({
    id: soatRequests.id,
    status: soatRequests.status,
    vin: vehicles.vin,
    plate: vehicles.plate,
    ownerDocument: vehicles.ownerDocument,
    vehicleId: soatRequests.vehicleId,
  })
    .from(soatRequests)
    .innerJoin(vehicles, eq(soatRequests.vehicleId, vehicles.id))
    .where(eq(soatRequests.id, soatRequestId))
    .limit(1);

  if (!row) {
    const r: RefreshResult = { result: 'not_found', message: 'Solicitud no encontrada' };
    await logAttempt(r);
    return r;
  }

  if (row.status !== 'comprado') {
    const r: RefreshResult = { result: 'invalid_status', message: `Solo aplica a SOAT en estado comprado. Estado actual: ${row.status}` };
    await logAttempt(r);
    return r;
  }

  try {
    // VIN-first: evita validación de propietario cuando hay traspaso reciente
    let runt = row.vin
      ? await consultarVehiculoRunt(undefined, row.vin)
      : await consultarVehiculoRunt(row.plate || undefined, undefined, row.ownerDocument || undefined);

    // Fallback placa+doc si VIN-first falló con mensaje de propietario
    if (row.vin && (!runt?.ok || /propietari/i.test(runt?.message || ''))) {
      const alt = await consultarVehiculoRunt(row.plate || undefined, undefined, row.ownerDocument || undefined);
      if (alt?.ok && alt?.data) runt = alt;
    }

    if (!runt?.ok || !runt?.data) {
      if (/propietari/i.test(runt?.message || '')) {
        const r: RefreshResult = {
          result: 'owner_sync_pending',
          message: 'Traspaso reciente en sincronización con RUNT (24-72 horas hábiles). El SOAT puede estar vigente; reintenta más tarde.',
          runtMessage: runt?.message,
        };
        await logAttempt(r, runt?.message);
        return r;
      }
      const r: RefreshResult = { result: 'runt_error', message: runt?.message || 'RUNT no respondió', runtMessage: runt?.message };
      await logAttempt(r, runt?.message);
      return r;
    }

    const soat = Array.isArray(runt.data.soat) ? runt.data.soat[0] : runt.data.soat;
    if (!soat) {
      const r: RefreshResult = {
        result: 'not_indexed_yet',
        message: 'El RUNT aún no indexa este SOAT. Los SOAT recién comprados tardan 24-72 horas hábiles en aparecer.',
      };
      await logAttempt(r);
      return r;
    }

    const policyNumber: string | null = soat.numSoat || soat.noPoliza || null;
    const insurer: string | null = soat.razonSocialAsegur || soat.aseguradora || null;
    const purchaseDate: string | null = soat.fechaInicioPoliza ? String(soat.fechaInicioPoliza).split('T')[0] : null;
    const expiryDate: string | null = soat.fechaVencimSoat ? String(soat.fechaVencimSoat).split('T')[0] : null;
    const soatHolder: string | null =
      soat.nombreTomador || soat.razonSocialTomador || soat.nombreTitular || runt.data?.vehiculo?.nombrePropietario || null;

    if (!policyNumber || isPolicyPlaceholder(policyNumber)) {
      const r: RefreshResult = { result: 'runt_error', message: 'El RUNT devolvió un registro sin número de póliza válido' };
      await logAttempt(r);
      return r;
    }

    const [updated] = await db.update(soatRequests).set({
      policyNumber, insurer, purchaseDate, expiryDate, soatHolder, updatedAt: new Date(),
    }).where(and(eq(soatRequests.id, soatRequestId), eq(soatRequests.status, 'comprado'))).returning();

    if (!updated) {
      const r: RefreshResult = { result: 'concurrent_update', message: 'El estado cambió durante la consulta. Recarga e intenta de nuevo.' };
      await logAttempt(r);
      return r;
    }

    const r: RefreshResult = { result: 'ok', policyNumber, insurer, purchaseDate, expiryDate, soatHolder };
    await logAttempt(r);
    return r;
  } catch (e: any) {
    const r: RefreshResult = { result: 'internal_error', message: e?.message || 'Error consultando RUNT' };
    await logAttempt(r);
    return r;
  }
}

export function refreshResultToHttp(r: RefreshResult): { status: number; body: any } {
  switch (r.result) {
    case 'ok':
      return { status: 200, body: { ok: true, policyNumber: r.policyNumber, insurer: r.insurer, purchaseDate: r.purchaseDate, expiryDate: r.expiryDate, soatHolder: r.soatHolder } };
    case 'not_found':
      return { status: 404, body: { error: r.message } };
    case 'invalid_status':
      return { status: 409, body: { error: r.message } };
    case 'not_indexed_yet':
      return { status: 404, body: { error: r.message, reason: 'SOAT_NOT_INDEXED_YET' } };
    case 'owner_sync_pending':
      return { status: 409, body: { error: r.message, reason: 'OWNER_SYNC_PENDING' } };
    case 'concurrent_update':
      return { status: 409, body: { error: r.message } };
    case 'runt_error':
      return { status: 502, body: { error: r.message } };
    case 'internal_error':
    default:
      return { status: 500, body: { error: r.message } };
  }
}
