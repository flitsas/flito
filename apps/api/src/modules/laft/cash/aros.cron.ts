import os from 'os';
import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import {
  laftReportesUiaf,
  laftParametros,
  notificationOutbox,
  users,
} from '../../../db/schema.js';
import { withLock } from '../../../shared/utils/lock.js';
import { loggerFor } from '../../../shared/logger.js';
import { generarAros } from './aros.service.js';
import { laftComplianceRecipients } from '../../../config/env.js';

const log = loggerFor('laft-aros-cron');

const HOST_ID = `${os.hostname()}-${process.pid}`;
const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const FIRST_RUN_DELAY_MS = 60_000;
const LOCK_TTL_MS = 10 * 60 * 1000;

/**
 * Devuelve el trimestre cuyo cierre fue en el mes inmediato anterior según
 * el cierre de Resolución UIAF 122/2021 (10-Ene cierra Q4 año anterior,
 * 10-Abr cierra Q1, 10-Jul cierra Q2, 10-Oct cierra Q3).
 */
export function calcularTrimestrePrevio(today: Date): { anio: number; trimestre: number } | null {
  // En el día 10 (configurable) de Ene/Abr/Jul/Oct se debe verificar el trimestre que terminó.
  const m = today.getUTCMonth() + 1; // 1-12
  if (m === 1) return { anio: today.getUTCFullYear() - 1, trimestre: 4 };
  if (m === 4) return { anio: today.getUTCFullYear(), trimestre: 1 };
  if (m === 7) return { anio: today.getUTCFullYear(), trimestre: 2 };
  if (m === 10) return { anio: today.getUTCFullYear(), trimestre: 3 };
  return null;
}

async function getDiaCorte(): Promise<number> {
  const [row] = await db.select({ valor: laftParametros.valor }).from(laftParametros)
    .where(eq(laftParametros.clave, 'aros_trimestral_dia_corte'));
  const n = parseInt(row?.valor ?? '10', 10);
  return Number.isFinite(n) && n >= 1 && n <= 28 ? n : 10;
}

async function adminUserId(): Promise<number | null> {
  const [row] = await db.select({ id: users.id }).from(users)
    .where(and(eq(users.role, 'admin'), eq(users.active, true)))
    .limit(1);
  return row?.id ?? null;
}

async function adminEmails(): Promise<string[]> {
  if (laftComplianceRecipients.length) return laftComplianceRecipients;
  const rows = await db.select({ email: users.email }).from(users)
    .where(and(eq(users.role, 'admin'), eq(users.active, true), isNotNull(users.email)));
  return rows.map((r) => r.email!).filter(Boolean);
}

interface RunResult {
  ran: boolean;
  reason: string;
  generated?: { anio: number; trimestre: number; idempotent: boolean };
}

export async function runOnce(now: Date = new Date()): Promise<RunResult> {
  const result = await withLock('laft-aros-cron', LOCK_TTL_MS, async (): Promise<RunResult> => {
    const periodo = calcularTrimestrePrevio(now);
    if (!periodo) return { ran: false, reason: 'mes no es Ene/Abr/Jul/Oct' };
    const diaCorte = await getDiaCorte();
    if (now.getUTCDate() !== diaCorte) {
      return { ran: false, reason: `día ${now.getUTCDate()} != día corte ${diaCorte}` };
    }

    // ¿Ya existe AROS para ese trimestre?
    const [existing] = await db.select({ id: laftReportesUiaf.id }).from(laftReportesUiaf)
      .where(and(
        eq(laftReportesUiaf.tipo, 'AROS'),
        eq(laftReportesUiaf.formato, 'PDF'),
        eq(laftReportesUiaf.periodoAnio, periodo.anio),
        eq(laftReportesUiaf.periodoTrimestre, periodo.trimestre),
      ));
    if (existing) return { ran: false, reason: 'AROS ya existe', generated: { ...periodo, idempotent: true } };

    // Necesitamos un user válido para generado_por (FK NOT NULL).
    const adminId = await adminUserId();
    if (!adminId) {
      log.warn('cron AROS sin admin disponible — saltando');
      return { ran: false, reason: 'sin admin para generado_por' };
    }

    const { reporte, resumen, idempotent } = await generarAros(periodo.anio, periodo.trimestre, adminId);

    // Notificación opt-in por outbox.
    try {
      const dest = await adminEmails();
      if (dest.length) {
        const titulo = `AROS ${periodo.trimestre}T-${periodo.anio} generado automáticamente`;
        const cuerpo = resumen.esAusencia
          ? `Se generó el reporte AROS de AUSENCIA para ${periodo.trimestre}T-${periodo.anio}. No hubo ROS ni operaciones inusuales reportadas en el trimestre. Reporte #${reporte.id}.`
          : `Se generó el reporte AROS para ${periodo.trimestre}T-${periodo.anio} con ${resumen.totalRosEnviados} ROS, ${resumen.totalUnusualReportadas} reportadas y ${resumen.totalCashBreaches} breaches. Reporte #${reporte.id}.`;
        await db.insert(notificationOutbox).values({
          canal: 'email',
          destinatarios: JSON.stringify(dest),
          asunto: titulo,
          cuerpoHtml: `<h3>${titulo}</h3><p>${cuerpo}</p><p>SHA-256: <code>${reporte.sha256}</code></p>`,
          cuerpoTexto: `${titulo}\n\n${cuerpo}\nSHA-256: ${reporte.sha256}`,
          contextoTipo: 'laft_aros',
          contextoId: reporte.id,
        });
      } else {
        log.warn({ reporteId: reporte.id }, 'AROS generado pero sin destinatarios — outbox no encolado');
      }
    } catch (e: any) {
      log.error({ err: e?.message, reporteId: reporte.id }, 'fallo encolar notificación AROS');
    }

    return { ran: true, reason: 'AROS generado', generated: { ...periodo, idempotent } };
  });

  if (result === undefined || result === null) {
    // Otro proceso ganó el lock — semántica idempotente: no es error, simplemente no fue nuestro turno.
    return { ran: false, reason: 'lock no adquirido (otra instancia)' };
  }
  return result;
}

let timer: NodeJS.Timeout | null = null;

export function startArosCron(): void {
  if (timer) return;
  log.info({ host: HOST_ID, intervalH: 24 }, 'Activo');
  setTimeout(async () => {
    try {
      const r = await runOnce();
      if (r.ran) log.info({ ...r.generated }, r.reason);
    } catch (e) { log.error({ err: e }, 'corrida falló'); }
  }, FIRST_RUN_DELAY_MS).unref();

  timer = setInterval(async () => {
    try {
      const r = await runOnce();
      if (r.ran) log.info({ ...r.generated }, r.reason);
    } catch (e) { log.error({ err: e }, 'corrida falló'); }
  }, RUN_INTERVAL_MS);
  timer.unref();
}

export function stopArosCron(): void {
  if (timer) { clearInterval(timer); timer = null; log.info('Detenido'); }
}
