import os from 'os';
import { runAnthropicHealthCheckOnce } from './anthropic-health.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('anthropic-health-cron');
const HOST_ID = `${os.hostname()}-${process.pid}`;
const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;

export function startAnthropicHealthCron(): void {
  if (timer) return;
  log.info({ host: HOST_ID, intervalHours: 24 }, 'anthropic health cron activo');

  setTimeout(async () => {
    try {
      const r = await runAnthropicHealthCheckOnce();
      if (r.status === 'degraded') log.error({ models: r.models }, 'anthropic health DEGRADED — revisar ANTHROPIC_MODEL_* en .env');
    } catch (e) { log.error({ err: e }, 'anthropic health primera corrida'); }
  }, 5 * 60 * 1000).unref();

  timer = setInterval(async () => {
    try {
      const r = await runAnthropicHealthCheckOnce();
      if (r.status === 'degraded') log.error({ models: r.models }, 'anthropic health DEGRADED');
    } catch (e) { log.error({ err: e }, 'anthropic health corrida'); }
  }, RUN_INTERVAL_MS);
  timer.unref();
}

export function stopAnthropicHealthCron(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
