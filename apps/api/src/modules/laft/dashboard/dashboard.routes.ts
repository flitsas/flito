// LAFT/SARLAFT v2 · F5 — Dashboard consolidado.
//
// KPIs requeridos por la Resolución 4607/2026 + UIAF + supervisión interna:
//   - Oficial cumplimiento OK (principal vigente con ISO 17024).
//   - Manual SARLAFT vigente (publicado).
//   - Contrapartes (totales, alto riesgo, pendientes).
//   - Empleados KYC vencidos (next_review_at < hoy).
//   - ROS abiertos + breach SLA.
//   - Cash breach último mes (F3 — tabla puede no existir aún; defensa con try/catch).
//   - Auditorías año actual: planeadas vs cerradas.
//   - Capacitaciones año actual + % asistencia.
//   - RTE último mes generado (F3 — defensa similar).
//
// Acceso: admin, compliance, auditor (read-only).

import { Router, Response } from 'express';
import { and, count, eq, gte, isNull, lt, lte, sql } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import {
  laftCounterparties, laftRosDrafts, laftEmployeesKyc, laftAuditPlans,
  laftTrainings, laftTrainingAttendees, laftManualVersions, laftComplianceOfficers,
} from '../../../db/schema.js';
import { authMiddleware, requireRole } from '../../../shared/middleware/auth.js';
import { requirePage } from '../../../shared/permissions.js';
import { loggerFor } from '../../../shared/logger.js';

const slog = loggerFor('laft-dashboard');

const router = Router();
router.use(authMiddleware, requirePage('laft_dashboard'), requireRole('admin', 'compliance', 'auditor'));

router.get('/', async (_req, res: Response) => {
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  const anioActual = today.getUTCFullYear();
  const haceUnMes = new Date(today);
  haceUnMes.setUTCMonth(haceUnMes.getUTCMonth() - 1);

  // Promise.all para paralelismo. Cada query es defensiva con try/catch
  // y devuelve fallback null/0 si la tabla aún no existe (F3 paralelo).
  const [
    officerInfo,
    manualVigente,
    contrapartesAgg,
    empleadosVencidos,
    rosAgg,
    auditoriasAgg,
    capacitacionesAgg,
  ] = await Promise.all([
    safeQuery(async () => {
      const rows = await db.select({
        rol: laftComplianceOfficers.rol,
        iso: laftComplianceOfficers.certificacionIso17024,
      }).from(laftComplianceOfficers)
        .where(and(isNull(laftComplianceOfficers.validTo), isNull(laftComplianceOfficers.revocadoAt)));
      const principal = rows.find((r) => r.rol === 'principal');
      const suplente = rows.find((r) => r.rol === 'suplente');
      return {
        principal: Boolean(principal),
        suplente: Boolean(suplente),
        principalIso17024: Boolean(principal?.iso),
        ok: Boolean(principal?.iso),
      };
    }, { principal: false, suplente: false, principalIso17024: false, ok: false }),

    safeQuery(async () => {
      const [row] = await db.select({
        version: laftManualVersions.version,
        publicadoAt: laftManualVersions.publicadoAt,
        sha256: laftManualVersions.sha256,
      }).from(laftManualVersions).where(eq(laftManualVersions.publicado, true))
        .orderBy(sql`version DESC`).limit(1);
      return row ?? null;
    }, null),

    safeQuery(async () => {
      const [agg] = await db.select({
        total: count(),
        alto: sql<number>`SUM(CASE WHEN risk_level = 'alto' THEN 1 ELSE 0 END)::int`,
        pendientes: sql<number>`SUM(CASE WHEN status = 'pendiente' THEN 1 ELSE 0 END)::int`,
        bloqueadas: sql<number>`SUM(CASE WHEN status = 'bloqueada' THEN 1 ELSE 0 END)::int`,
      }).from(laftCounterparties);
      return {
        total: Number(agg?.total ?? 0),
        alto: Number(agg?.alto ?? 0),
        pendientes: Number(agg?.pendientes ?? 0),
        bloqueadas: Number(agg?.bloqueadas ?? 0),
      };
    }, { total: 0, alto: 0, pendientes: 0, bloqueadas: 0 }),

    safeQuery(async () => {
      const [agg] = await db.select({ n: count() }).from(laftEmployeesKyc)
        .where(lt(laftEmployeesKyc.nextReviewAt, todayIso));
      return Number(agg?.n ?? 0);
    }, 0),

    safeQuery(async () => {
      const [agg] = await db.select({
        abiertos: sql<number>`SUM(CASE WHEN sirel_acuse_at IS NULL THEN 1 ELSE 0 END)::int`,
        breach: sql<number>`SUM(CASE WHEN sla_breached = true THEN 1 ELSE 0 END)::int`,
      }).from(laftRosDrafts);
      return {
        abiertos: Number(agg?.abiertos ?? 0),
        slaBreach: Number(agg?.breach ?? 0),
      };
    }, { abiertos: 0, slaBreach: 0 }),

    safeQuery(async () => {
      const [agg] = await db.select({
        planeadas: sql<number>`SUM(CASE WHEN estado IN ('planeada','en_ejecucion') THEN 1 ELSE 0 END)::int`,
        cerradas: sql<number>`SUM(CASE WHEN estado = 'cerrada' THEN 1 ELSE 0 END)::int`,
        canceladas: sql<number>`SUM(CASE WHEN estado = 'cancelada' THEN 1 ELSE 0 END)::int`,
      }).from(laftAuditPlans).where(eq(laftAuditPlans.anio, anioActual));
      return {
        anio: anioActual,
        planeadas: Number(agg?.planeadas ?? 0),
        cerradas: Number(agg?.cerradas ?? 0),
        canceladas: Number(agg?.canceladas ?? 0),
      };
    }, { anio: anioActual, planeadas: 0, cerradas: 0, canceladas: 0 }),

    safeQuery(async () => {
      // Capacitaciones agendadas en el año actual + % asistencia agregada.
      const start = `${anioActual}-01-01`;
      const end = `${anioActual}-12-31T23:59:59.999Z`;
      const [trAgg] = await db.select({ n: count() }).from(laftTrainings)
        .where(and(gte(laftTrainings.scheduledAt, new Date(start)), lte(laftTrainings.scheduledAt, new Date(end))));
      const [attAgg] = await db.select({
        total: count(),
        attended: sql<number>`SUM(CASE WHEN attended = true THEN 1 ELSE 0 END)::int`,
      }).from(laftTrainingAttendees).innerJoin(
        laftTrainings, eq(laftTrainings.id, laftTrainingAttendees.trainingId),
      ).where(and(gte(laftTrainings.scheduledAt, new Date(start)), lte(laftTrainings.scheduledAt, new Date(end))));
      const total = Number(attAgg?.total ?? 0);
      const attended = Number(attAgg?.attended ?? 0);
      return {
        anio: anioActual,
        sesiones: Number(trAgg?.n ?? 0),
        totalAsistentes: total,
        atendidos: attended,
        porcentajeAsistencia: total > 0 ? Math.round((attended / total) * 100) : 0,
      };
    }, { anio: anioActual, sesiones: 0, totalAsistentes: 0, atendidos: 0, porcentajeAsistencia: 0 }),
  ]);

  // F3 (mig 0064) corre en paralelo: tablas laft_cash_txn y laft_rte_reportes
  // pueden no existir aún. Probamos con SQL crudo + try/catch (catch incluye 42P01).
  const cashBreachUltimoMes = await safeQuery<number>(async () => {
    const cutoff = haceUnMes.toISOString();
    const result: any = await db.execute(
      sql.raw(`SELECT COUNT(*)::int AS n FROM laft_cash_txn
                WHERE threshold_breached = true
                  AND created_at >= '${cutoff.replace(/'/g, '')}'`),
    );
    const rows = (Array.isArray(result) ? result : result?.rows ?? []) as Array<{ n: number }>;
    return Number(rows[0]?.n ?? 0);
  }, 0);

  const rteUltimoMesGenerado = await safeQuery<{ anio: number; mes: number } | null>(async () => {
    const result: any = await db.execute(sql.raw(
      `SELECT anio, mes FROM laft_rte_reportes ORDER BY anio DESC, mes DESC LIMIT 1`,
    ));
    const rows = (Array.isArray(result) ? result : result?.rows ?? []) as Array<{ anio: number; mes: number }>;
    return rows[0] ?? null;
  }, null);

  res.json({
    generadoAt: today.toISOString(),
    oficialCumplimiento: officerInfo,
    oficialCumplimientoOk: officerInfo.ok,
    manualVigente,
    contrapartesActivas: contrapartesAgg.total,
    contrapartesAlto: contrapartesAgg.alto,
    contrapartesPendientes: contrapartesAgg.pendientes,
    contrapartesBloqueadas: contrapartesAgg.bloqueadas,
    empleadosKycVencidos: empleadosVencidos,
    rosAbiertos: rosAgg.abiertos,
    rosSlaBreach: rosAgg.slaBreach,
    cashBreachUltimoMes,
    auditoriaProgreso: auditoriasAgg,
    capacitacionesAnioActual: capacitacionesAgg,
    rteUltimoMesGenerado,
  });
});

// Wrapper que no propaga errores de query individual al endpoint global.
async function safeQuery<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); } catch (e: any) {
    slog.warn({ err: e?.message }, 'safeQuery fallback');
    return fallback;
  }
}

export default router;
