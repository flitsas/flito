import os from 'os';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { driverDocuments, driverAlertsSent } from '../../db/schema.js';
import { withLock } from '../../shared/utils/lock.js';
import { sendEmail, isSmtpConfigured, escapeHtml } from '../../services/email.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('driver-alerts');

// Cron diario 6:30 AM (15min después del cron de schedule de mantenimiento).
// Misma idempotencia que fleet/documents.cron.ts: UNIQUE (documento_id, dias_anticipacion).

const HOST_ID = `${os.hostname()}-${process.pid}`;
const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LOCK_TTL_MS = 10 * 60 * 1000;
const TARGET_HOUR = 6;
const TARGET_MIN = 30;
const THROTTLE_MS = 200;
const MAX_PER_RUN = 500;

interface AlertRow {
  doc_id: number;
  user_id: number;
  name: string | null;
  email: string | null;
  tipo_nombre: string;
  numero: string | null;
  vigencia_hasta: string;
  destinatarios_default: string[];
  destinatarios_extra: string[];
  [key: string]: unknown;
}

function buildHtml(p: { conductor: string; tipo: string; numero: string; vigencia: string; diasFalta: number; vencido: boolean }): string {
  const headline = p.vencido
    ? `Documento VENCIDO — ${p.conductor}`
    : `Documento por vencer en ${p.diasFalta} días — ${p.conductor}`;
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(headline)}</title></head>
<body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,sans-serif;color:#1f2937;background:#f9fafb;padding:24px;margin:0;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
    <div style="padding:20px 24px;border-bottom:1px solid #e5e7eb;background:${p.vencido ? '#fef2f2' : '#fffbeb'};">
      <h2 style="margin:0;font-size:18px;color:${p.vencido ? '#991b1b' : '#92400e'};">${escapeHtml(headline)}</h2>
    </div>
    <div style="padding:20px 24px;font-size:14px;line-height:1.6;">
      <p style="margin:0 0 12px 0;">${p.vencido ? 'El siguiente documento del conductor ya venció:' : 'El siguiente documento del conductor está próximo a vencer:'}</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr><td style="padding:6px 0;color:#6b7280;width:40%;">Conductor</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(p.conductor)}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;">Tipo de documento</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(p.tipo)}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;">Número</td><td style="padding:6px 0;">${escapeHtml(p.numero || 'No registrado')}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;">Vence</td><td style="padding:6px 0;font-weight:600;color:${p.vencido ? '#dc2626' : '#d97706'};">${escapeHtml(p.vigencia)}</td></tr>
      </table>
      <p style="margin:20px 0 0 0;font-size:12px;color:#6b7280;">Operaciones FLIT — Sistema PESV (Resolución 40595/2022).</p>
    </div>
    <div style="padding:12px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af;">
      Kyverum LLC. Notificación automática del módulo PESV.
    </div>
  </div>
</body></html>`;
}

async function runOnce(): Promise<{ candidatos: number; enviados: number; saltados: number }> {
  const result = await withLock('driver-doc-alerts', LOCK_TTL_MS, async () => {
    const stats = { candidatos: 0, enviados: 0, saltados: 0 };
    const today = new Date().toISOString().slice(0, 10);

    const candidatos = await db.execute<AlertRow>(sql`
      SELECT
        dd.id AS doc_id,
        dd.user_id,
        u.name,
        u.email,
        dt.nombre AS tipo_nombre,
        dd.numero,
        dd.vigencia_hasta::text AS vigencia_hasta,
        dt.destinatarios_default,
        dd.destinatarios_extra
      FROM driver_documents dd
      JOIN users u ON u.id = dd.user_id
      JOIN driver_document_types dt ON dt.id = dd.tipo_id
      WHERE u.es_conductor = true
        AND dd.estado IN ('vigente','por_vencer','vencido')
        AND dd.vigencia_hasta IS NOT NULL
        AND (dd.vigencia_hasta - ${today}::date) = ANY(dt.dias_alerta || ARRAY[0])
    `);

    const rows = (candidatos as any).rows ?? candidatos as any[];
    stats.candidatos = rows.length;

    for (const c of rows.slice(0, MAX_PER_RUN)) {
      const venceDate = new Date(c.vigencia_hasta);
      const todayDate = new Date(today);
      const diasFalta = Math.round((venceDate.getTime() - todayDate.getTime()) / 86_400_000);
      const vencido = diasFalta <= 0;
      const diasAnticipacion = vencido ? 0 : diasFalta;

      const reserved = await db.execute(sql`
        INSERT INTO driver_alerts_sent (documento_id, dias_anticipacion, destinatarios, resultado)
        VALUES (${c.doc_id}, ${diasAnticipacion}, ARRAY[]::text[], 'pendiente')
        ON CONFLICT (documento_id, dias_anticipacion) DO NOTHING
        RETURNING id
      `);
      const reservedRows = (reserved as any).rows ?? reserved as any[];
      if (reservedRows.length === 0) {
        stats.saltados++;
        continue;
      }
      const alertId = reservedRows[0].id;

      const destinatarios = Array.from(new Set([
        ...(c.destinatarios_default ?? []),
        ...(c.destinatarios_extra ?? []),
        ...(c.email ? [c.email] : []),
      ])).filter(Boolean);

      if (destinatarios.length === 0) {
        await db.update(driverAlertsSent)
          .set({ resultado: 'sin_destinatarios', destinatarios: [] })
          .where(eq(driverAlertsSent.id, alertId));
        stats.saltados++;
        continue;
      }

      const subject = vencido
        ? `Documento conductor VENCIDO — ${c.name ?? `#${c.user_id}`} — ${c.tipo_nombre}`
        : `Documento conductor por vencer (${diasFalta}d) — ${c.name ?? `#${c.user_id}`} — ${c.tipo_nombre}`;

      const html = buildHtml({
        conductor: c.name ?? `Conductor #${c.user_id}`,
        tipo: c.tipo_nombre,
        numero: c.numero ?? '',
        vigencia: c.vigencia_hasta,
        diasFalta, vencido,
      });

      const result = await sendEmail({ to: destinatarios, subject, html });

      await db.update(driverAlertsSent)
        .set({
          destinatarios,
          resultado: result.ok ? 'enviado' : 'error',
          emailMessageId: result.messageId ?? null,
          errorMsg: result.error ?? null,
        })
        .where(eq(driverAlertsSent.id, alertId));

      if (result.ok) stats.enviados++;

      const nuevoEstado = vencido ? 'vencido' : (diasFalta <= 30 ? 'por_vencer' : 'vigente');
      await db.update(driverDocuments).set({ estado: nuevoEstado as any }).where(eq(driverDocuments.id, c.doc_id));

      await new Promise((resolve) => setTimeout(resolve, THROTTLE_MS));
    }

    return stats;
  });
  return result ?? { candidatos: 0, enviados: 0, saltados: 0 };
}

function msUntilTarget(): number {
  const now = new Date();
  const next = new Date();
  next.setHours(TARGET_HOUR, TARGET_MIN, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

let firstTimer: NodeJS.Timeout | null = null;
let intervalTimer: NodeJS.Timeout | null = null;

export function startDriverAlertsCron(): void {
  if (firstTimer || intervalTimer) return;
  if (!isSmtpConfigured()) {
    log.warn({ host: HOST_ID }, 'SMTP no configurado — cron no se inicia');
    return;
  }
  const delay = msUntilTarget();
  log.info({ host: HOST_ID, firstRunMin: Math.round(delay / 60_000), intervalH: 24 }, 'Activo');

  firstTimer = setTimeout(async () => {
    try {
      const r = await runOnce();
      log.info({ candidatos: r.candidatos, enviados: r.enviados, saltados: r.saltados }, 'corrida completada');
    } catch (e) { log.error({ err: e }, 'corrida falló'); }
    intervalTimer = setInterval(async () => {
      try {
        const r = await runOnce();
        log.info({ candidatos: r.candidatos, enviados: r.enviados, saltados: r.saltados }, 'corrida completada');
      } catch (e) { log.error({ err: e }, 'corrida falló'); }
    }, RUN_INTERVAL_MS);
    intervalTimer.unref();
  }, delay);
  firstTimer.unref();
}

export function stopDriverAlertsCron(): void {
  if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
  if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null; }
  log.info('Detenido');
}

export { runOnce as runDriverAlertsOnce };
