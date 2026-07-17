import os from 'os';
import { eq, and, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { vehicles, vehicleDocuments, documentTypes, alertsSent } from '../../db/schema.js';
import { withLock } from '../../shared/utils/lock.js';
import { sendEmail, isSmtpConfigured, escapeHtml } from '../../services/email.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('fleet-alerts');

// Cron diario que detecta documentos por vencer y dispara emails de alerta.
// Idempotencia: alerts_sent UNIQUE(documento_id, dias_anticipacion). Si el cron corre dos
// veces el mismo día (por reinicio de PM2), el INSERT con ON CONFLICT no envía dos veces.

const HOST_ID = `${os.hostname()}-${process.pid}`;
const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LOCK_TTL_MS = 10 * 60 * 1000;
const TARGET_HOUR = 6; // 6 AM hora local del servidor (Bogotá, UTC-5)
const THROTTLE_MS = 200;
const MAX_PER_RUN = 500;

type AlertRow = {
  doc_id: number;
  vehicle_id: number;
  plate: string | null;
  alias: string | null;
  tipo_nombre: string;
  numero: string | null;
  vigencia_hasta: string;
  dias_alerta: number[];
  destinatarios_default: string[];
  destinatarios_extra: string[];
  [key: string]: unknown;
};

function buildHtml(p: { plate: string; tipo: string; numero: string; vigencia: string; diasFalta: number; vencido: boolean }): string {
  const headline = p.vencido
    ? `Documento VENCIDO — Placa ${p.plate}`
    : `Documento por vencer en ${p.diasFalta} días — Placa ${p.plate}`;
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(headline)}</title></head>
<body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,sans-serif;color:#1f2937;background:#f9fafb;padding:24px;margin:0;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
    <div style="padding:20px 24px;border-bottom:1px solid #e5e7eb;background:${p.vencido ? '#fef2f2' : '#fffbeb'};">
      <h2 style="margin:0;font-size:18px;color:${p.vencido ? '#991b1b' : '#92400e'};">${escapeHtml(headline)}</h2>
    </div>
    <div style="padding:20px 24px;font-size:14px;line-height:1.6;">
      <p style="margin:0 0 12px 0;">${p.vencido ? 'El siguiente documento ya venció:' : 'El siguiente documento está próximo a vencer:'}</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr><td style="padding:6px 0;color:#6b7280;width:40%;">Placa</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(p.plate)}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;">Tipo de documento</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(p.tipo)}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;">Número</td><td style="padding:6px 0;">${escapeHtml(p.numero || 'No registrado')}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;">Vence</td><td style="padding:6px 0;font-weight:600;color:${p.vencido ? '#dc2626' : '#d97706'};">${escapeHtml(p.vigencia)}</td></tr>
      </table>
      <p style="margin:20px 0 0 0;font-size:12px;color:#6b7280;">Operaciones FLIT — Sistema de gestión de flota.</p>
    </div>
    <div style="padding:12px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af;">
      Kyverum LLC. Notificación automática del módulo de Flota.
    </div>
  </div>
</body></html>`;
}

async function runOnce(): Promise<{ candidatos: number; enviados: number; saltados: number }> {
  const result = await withLock('fleet-doc-alerts', LOCK_TTL_MS, async () => {
    const stats = { candidatos: 0, enviados: 0, saltados: 0 };
    const today = new Date().toISOString().slice(0, 10);

    // Trae documentos cuya vigencia_hasta cae dentro de los días de alerta del tipo.
    // Filtra solo flota propia y estados activos.
    const candidatos = await db.execute<AlertRow>(sql`
      SELECT
        vd.id AS doc_id,
        vd.vehicle_id,
        v.plate,
        v.alias,
        dt.nombre AS tipo_nombre,
        vd.numero,
        vd.vigencia_hasta::text AS vigencia_hasta,
        dt.dias_alerta,
        dt.destinatarios_default,
        vd.destinatarios_extra
      FROM vehicle_documents vd
      JOIN vehicles v ON v.id = vd.vehicle_id
      JOIN document_types dt ON dt.id = vd.tipo_id
      WHERE v.es_flota_propia = true
        AND vd.estado IN ('vigente','por_vencer','vencido')
        AND vd.vigencia_hasta IS NOT NULL
        AND (vd.vigencia_hasta - ${today}::date) = ANY(dt.dias_alerta || ARRAY[0])
    `);

    const rows = (candidatos as any).rows ?? candidatos as any[];
    stats.candidatos = rows.length;

    for (const c of rows.slice(0, MAX_PER_RUN)) {
      const venceDate = new Date(c.vigencia_hasta);
      const todayDate = new Date(today);
      const diasFalta = Math.round((venceDate.getTime() - todayDate.getTime()) / 86_400_000);
      const vencido = diasFalta <= 0;
      const diasAnticipacion = vencido ? 0 : diasFalta;

      // INSERT con ON CONFLICT — la fila se crea como "pendiente" para reservar el slot.
      const reserved = await db.execute(sql`
        INSERT INTO alerts_sent (documento_id, dias_anticipacion, destinatarios, resultado)
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
      ])).filter(Boolean);

      if (destinatarios.length === 0) {
        await db.update(alertsSent)
          .set({ resultado: 'sin_destinatarios', destinatarios: [] })
          .where(eq(alertsSent.id, alertId));
        stats.saltados++;
        continue;
      }

      const subject = vencido
        ? `Documento VENCIDO — ${c.plate ?? 'sin placa'} — ${c.tipo_nombre}`
        : `Documento por vencer (${diasFalta}d) — ${c.plate ?? 'sin placa'} — ${c.tipo_nombre}`;

      const html = buildHtml({
        plate: c.plate ?? c.alias ?? `Vehículo ${c.vehicle_id}`,
        tipo: c.tipo_nombre,
        numero: c.numero ?? '',
        vigencia: c.vigencia_hasta,
        diasFalta,
        vencido,
      });

      const result = await sendEmail({ to: destinatarios, subject, html });

      await db.update(alertsSent)
        .set({
          destinatarios,
          resultado: result.ok ? 'enviado' : 'error',
          emailMessageId: result.messageId ?? null,
          errorMsg: result.error ?? null,
        })
        .where(eq(alertsSent.id, alertId));

      if (result.ok) stats.enviados++;

      // Actualiza el estado del documento para que el frontend muestre el color correcto.
      const nuevoEstado = vencido ? 'vencido' : (diasFalta <= 30 ? 'por_vencer' : 'vigente');
      await db.update(vehicleDocuments).set({ estado: nuevoEstado as any }).where(eq(vehicleDocuments.id, c.doc_id));

      await new Promise((resolve) => setTimeout(resolve, THROTTLE_MS));
    }

    return stats;
  });
  return result ?? { candidatos: 0, enviados: 0, saltados: 0 };
}

function msUntilNext6AM(): number {
  const now = new Date();
  const next = new Date();
  next.setHours(TARGET_HOUR, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

let firstTimer: NodeJS.Timeout | null = null;
let intervalTimer: NodeJS.Timeout | null = null;

export function startDocumentAlertsCron(): void {
  if (firstTimer || intervalTimer) return;
  if (!isSmtpConfigured()) {
    log.warn({ host: HOST_ID }, 'SMTP no configurado — cron no se inicia');
    return;
  }
  const delay = msUntilNext6AM();
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

export function stopDocumentAlertsCron(): void {
  if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
  if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null; }
  log.info('Detenido');
}

// Exportado para tests / disparo manual desde un endpoint admin.
export { runOnce as runFleetAlertsOnce };
