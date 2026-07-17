// Cron SLA ROS — corre cada 15 min y dispara alarmas escalonadas (warn_12h, warn_4h, breach)
// para borradores ROS clasificados pero aún sin radicado SIREL registrado.
//
// SLA = 24h desde clasificado_at (Resolución UIAF 122/2021).
// El email es opt-in: si LAFT_COMPLIANCE_RECIPIENTS está vacío, registramos la alarma
// con destinatarios=null y emitimos log warn — política PO: no setear emails por defecto.
//
// Idempotencia: la tabla laft_ros_sla_alarmas tiene UNIQUE(ros_draft_id, tipo) — un mismo
// borrador no recibe la misma alerta dos veces aunque el cron corra en bucle.
//
// Coordinación cross-instancia: withLock('laft-ros-sla', 14min) — solo una instancia
// PM2/cluster levanta el cron por ciclo.

import os from 'os';
import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { laftRosDrafts, laftRosSlaAlarmas, laftAuditLog, notificationOutbox } from '../../../db/schema.js';
import { withLock } from '../../../shared/utils/lock.js';
import { laftComplianceRecipients } from '../../../config/env.js';
import { loggerFor } from '../../../shared/logger.js';

const log = loggerFor('laft-ros-sla');

const HOST_ID = `${os.hostname()}-${process.pid}`;
const RUN_INTERVAL_MS = 15 * 60 * 1000; // 15min
const LOCK_TTL_MS = 14 * 60 * 1000;     // 14min: menor que el intervalo para evitar superposición.

type AlarmaTipo = 'warn_12h' | 'warn_4h' | 'breach';

interface RosRow {
  id: number;
  operationId: number;
  clasificadoAt: Date | null;
  slaDueAt: Date | null;
  slaBreached: boolean;
}

interface RunResult {
  scanned: number;
  warn12: number;
  warn4: number;
  breach: number;
  withoutRecipients: number;
}

function buildEmailSubject(tipo: AlarmaTipo, rosId: number): string {
  switch (tipo) {
    case 'breach': return `[URGENTE] ROS #${rosId} - SLA UIAF VENCIDO`;
    case 'warn_4h': return `[ALERTA] ROS #${rosId} - SLA UIAF vence en menos de 4h`;
    case 'warn_12h': return `[Aviso] ROS #${rosId} - SLA UIAF vence en menos de 12h`;
  }
}

function buildEmailBody(tipo: AlarmaTipo, ros: RosRow): { html: string; text: string } {
  const horasRestantes = ros.slaDueAt
    ? Math.max(0, Math.floor((ros.slaDueAt.getTime() - Date.now()) / 3600000))
    : 0;
  const titulo = buildEmailSubject(tipo, ros.id);
  const accion = tipo === 'breach'
    ? 'El plazo de 24h fijado por la Resolucion UIAF 122/2021 ha expirado. Cargar el reporte en https://www.uiaf.gov.co/sirel de inmediato y registrar el radicado en la app.'
    : `Realizar data-entry del borrador en https://www.uiaf.gov.co/sirel y registrar el radicado en la app antes de ${ros.slaDueAt?.toISOString() ?? 'el vencimiento'} (~${horasRestantes}h restantes).`;
  const html = `<h3>${titulo}</h3>
<p>Borrador ROS #${ros.id} (operacion #${ros.operationId})</p>
<ul>
  <li>Clasificado: ${ros.clasificadoAt?.toISOString() ?? '-'}</li>
  <li>SLA vence: ${ros.slaDueAt?.toISOString() ?? '-'}</li>
  <li>Estado: ${ros.slaBreached || tipo === 'breach' ? 'VENCIDO' : 'POR VENCER'}</li>
</ul>
<p>${accion}</p>`;
  const text = `${titulo}\nROS #${ros.id} - operacion #${ros.operationId}\nSLA: ${ros.slaDueAt?.toISOString() ?? '-'}\n\n${accion}`;
  return { html, text };
}

async function emitirAlarma(ros: RosRow, tipo: AlarmaTipo): Promise<boolean> {
  // INSERT con UNIQUE(ros_draft_id, tipo): si ya existe, captura 23505 → no duplica.
  const dest = laftComplianceRecipients;
  const destinatariosStr = dest.length ? JSON.stringify(dest) : null;

  try {
    await db.insert(laftRosSlaAlarmas).values({
      rosDraftId: ros.id,
      tipo,
      destinatarios: destinatariosStr,
    });
  } catch (e: unknown) {
    const code = (e as { code?: string }).code;
    if (code === '23505') return false; // ya emitida
    throw e;
  }

  if (dest.length) {
    const { html, text } = buildEmailBody(tipo, ros);
    try {
      await db.insert(notificationOutbox).values({
        canal: 'email',
        destinatarios: JSON.stringify(dest),
        asunto: buildEmailSubject(tipo, ros.id),
        cuerpoHtml: html,
        cuerpoTexto: text,
        contextoTipo: 'laft_ros_sla',
        contextoId: ros.id,
      });
    } catch (err) {
      log.error({ err, rosId: ros.id, tipo }, 'fallo encolar email outbox');
      // No re-lanzamos: la alarma quedó registrada en la BD aunque el email falle.
    }
  } else {
    log.warn({ rosId: ros.id, tipo }, 'alarma SLA registrada sin destinatarios (LAFT_COMPLIANCE_RECIPIENTS vacío)');
  }

  // Audit log inmutable.
  try {
    await db.insert(laftAuditLog).values({
      userId: null,
      userUsername: 'cron-laft-ros-sla',
      action: `ros_sla_${tipo}`,
      resource: 'document',
      resourceId: String(ros.id),
      afterState: { slaDueAt: ros.slaDueAt, destinatarios: dest, tipo },
    });
  } catch (err) {
    log.error({ err, rosId: ros.id }, 'fallo audit alarma');
  }
  return true;
}

async function runOnce(): Promise<RunResult | null> {
  return await withLock('laft-ros-sla', LOCK_TTL_MS, async (): Promise<RunResult> => {
    const now = new Date();
    const stat: RunResult = { scanned: 0, warn12: 0, warn4: 0, breach: 0, withoutRecipients: 0 };

    // Solo borradores clasificados, sin radicar y sin breach declarado todavía.
    const candidatos = await db.select({
      id: laftRosDrafts.id,
      operationId: laftRosDrafts.operationId,
      clasificadoAt: laftRosDrafts.clasificadoAt,
      slaDueAt: laftRosDrafts.slaDueAt,
      slaBreached: laftRosDrafts.slaBreached,
    }).from(laftRosDrafts)
      .where(and(
        sql`${laftRosDrafts.clasificadoAt} IS NOT NULL`,
        isNull(laftRosDrafts.sirelAcuseAt),
        eq(laftRosDrafts.slaBreached, false),
      ))
      .limit(2000);

    stat.scanned = candidatos.length;
    if (!laftComplianceRecipients.length) stat.withoutRecipients = candidatos.length;

    for (const c of candidatos) {
      const ros: RosRow = {
        id: c.id,
        operationId: c.operationId,
        clasificadoAt: c.clasificadoAt ? new Date(c.clasificadoAt) : null,
        slaDueAt: c.slaDueAt ? new Date(c.slaDueAt) : null,
        slaBreached: c.slaBreached,
      };
      if (!ros.slaDueAt) continue;
      const msLeft = ros.slaDueAt.getTime() - now.getTime();

      if (msLeft <= 0) {
        // Breach: marcar y alarmar. UPDATE atómico WHERE sla_breached=false evita doble disparo.
        const updated = await db.update(laftRosDrafts).set({
          slaBreached: true,
        }).where(and(eq(laftRosDrafts.id, ros.id), eq(laftRosDrafts.slaBreached, false))).returning({ id: laftRosDrafts.id });
        if (updated.length) {
          if (await emitirAlarma({ ...ros, slaBreached: true }, 'breach')) stat.breach++;
        }
        continue;
      }
      if (msLeft <= 4 * 3600 * 1000) {
        if (await emitirAlarma(ros, 'warn_4h')) stat.warn4++;
        // No `continue` — un mismo borrador puede tener pendientes warn_12h también si recién entró.
      }
      if (msLeft <= 12 * 3600 * 1000) {
        if (await emitirAlarma(ros, 'warn_12h')) stat.warn12++;
      }
    }

    return stat;
  });
}

let timer: NodeJS.Timeout | null = null;

export function startRosSlaCron(): void {
  if (timer) return;
  log.info({ host: HOST_ID, intervalMin: 15 }, 'Activo');
  // Primera corrida ~60s después del boot para que la app termine de levantarse.
  setTimeout(() => { runOnce().then((r) => { if (r) log.info(r, 'corrida inicial'); }).catch((e) => log.error({ err: e }, 'corrida inicial fallo')); }, 60_000).unref();

  timer = setInterval(() => {
    runOnce().then((r) => { if (r && (r.warn12 + r.warn4 + r.breach) > 0) log.info(r, 'alarmas emitidas'); })
      .catch((e) => log.error({ err: e }, 'corrida fallo'));
  }, RUN_INTERVAL_MS);
  timer.unref();
}

export function stopRosSlaCron(): void {
  if (timer) { clearInterval(timer); timer = null; log.info('Detenido'); }
}

// Export interno solo para tests.
export const _internal = { runOnce };
