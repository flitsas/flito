import { createApp } from './app.js';
import { env } from './config/env.js';
import { startReconciler, stopReconciler } from './modules/soat/reconciler.js';
import { startPurger, stopPurger } from './modules/soat/purge.js';
import { startReviewCron, stopReviewCron } from './modules/laft/review.cron.js';
import { startLaftSyncCron, stopLaftSyncCron } from './modules/laft/sync/sync.cron.js';
import { startEmployeesRekycCron, stopEmployeesRekycCron } from './modules/laft/employees/employees-rekyc.cron.js';
import { startRosSlaCron, stopRosSlaCron } from './modules/laft/sirel/ros-sla.cron.js';
import { startDocumentAlertsCron, stopDocumentAlertsCron } from './modules/fleet/documents.cron.js';
import { startScheduleCron, stopScheduleCron } from './modules/maintenance/schedule.cron.js';
import { startDriverAlertsCron, stopDriverAlertsCron } from './modules/drivers/documents.cron.js';
import { startRndcRetryCron, stopRndcRetryCron } from './modules/rndc/retry.cron.js';
import { startRetentionCron, stopRetentionCron } from './modules/privacy/retention.cron.js';
import { startJornadaAutocloseCron, stopJornadaAutocloseCron } from './modules/jornadas/autoclose.cron.js';
import { startPesvRecordatoriosCron, stopPesvRecordatoriosCron } from './modules/pesv/recordatorios.cron.js';
import { startRetencionCron as startPesvRetencionCron, stopRetencionCron as stopPesvRetencionCron } from './modules/pesv/retencion.cron.js';
import { startArosCron, stopArosCron } from './modules/laft/cash/aros.cron.js';
import { startRumPurgeCron, stopRumPurgeCron } from './modules/rum/purge.cron.js';
import { startAnthropicHealthCron, stopAnthropicHealthCron } from './modules/ai/anthropic-health.cron.js';
import { startPortalReminderCron, stopPortalReminderCron } from './modules/tramites/portal-reminder.cron.js';
import { startValidacionStaleCron, stopValidacionStaleCron } from './modules/tramites/validacion-stale.cron.js';
import { closeRedis } from './shared/redis.js';
import { loggerFor } from './shared/logger.js';

const log = loggerFor('server');
const app = createApp();

const server = app.listen(env.PORT, () => {
  log.info({ port: env.PORT, env: env.NODE_ENV }, 'Operaciones API running');
  if (env.NODE_ENV === 'production') {
    startReconciler();
    startPurger();
    startReviewCron();
    startLaftSyncCron();
    startEmployeesRekycCron();
    startRosSlaCron();
    startDocumentAlertsCron();
    startScheduleCron();
    startDriverAlertsCron();
    startRndcRetryCron();
    // Cron de retención PII: noop si PRIVACY_RETENTION_CRON_ENABLED!=1.
    // Encender solo después de Ola D (privacy/forget completo + cifrado PII estables).
    startRetentionCron();
    startJornadaAutocloseCron();
    startPesvRecordatoriosCron();
    startPesvRetencionCron();
    // LAFT v2 F3: cron AROS trimestral (10-Ene/Abr/Jul/Oct, configurable vía laft_parametros).
    startArosCron();
    startRumPurgeCron();
    startAnthropicHealthCron();
    // TRAM-COMMS-02: recordatorios portal (noop si TRAM_PORTAL_REMINDER_CRON_ENABLED!=1).
    startPortalReminderCron();
    startValidacionStaleCron();
  }
});

// Graceful shutdown: frenar reconciliador, cerrar conexiones HTTP y BD antes de salir.
// Biométrica (Anthropic ~60–90s) requiere grace ≥120s para no cortar validaciones en curso.
const GRACE_MS = 120_000;
let shuttingDown = false;

function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal, graceMs: GRACE_MS }, 'shutdown signal recibido');

  stopReconciler();
  stopPurger();
  stopReviewCron();
  stopLaftSyncCron();
  stopEmployeesRekycCron();
  stopRosSlaCron();
  stopDocumentAlertsCron();
  stopScheduleCron();
  stopDriverAlertsCron();
  stopRndcRetryCron();
  stopRetentionCron();
  stopJornadaAutocloseCron();
  stopPesvRecordatoriosCron();
  stopPesvRetencionCron();
  stopArosCron();
  stopRumPurgeCron();
  stopAnthropicHealthCron();
  stopPortalReminderCron();
  stopValidacionStaleCron();

  const forceExitTimer = setTimeout(() => {
    log.error('grace expirado — forzando salida');
    process.exit(1);
  }, GRACE_MS);
  forceExitTimer.unref();

  // Primero cerrar HTTP (esperar requests en curso), luego Redis.
  server.close(async (err) => {
    if (err) {
      log.error({ err: err.message }, 'server.close error');
      process.exit(1);
    }
    log.info('HTTP cerrado');
    try { await closeRedis(); } catch (e) { log.warn({ err: (e as Error).message }, 'redis close error'); }
    log.info('saliendo');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
