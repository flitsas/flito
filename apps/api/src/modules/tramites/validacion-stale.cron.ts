// Cron de higiene: libera locks biométricos `en_proceso` huérfanos.
// Activo en producción por defecto; noop si VALIDACION_STALE_CRON_ENABLED=0.
import os from 'os';
import { recoverAllStaleLocks } from './validacion-recovery.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('tramite.validacion-stale');
const HOST_ID = `${os.hostname()}-${process.pid}`;
const INTERVAL_MS = 5 * 60_000;

let timer: NodeJS.Timeout | null = null;

async function tick(): Promise<void> {
  try {
    const n = await recoverAllStaleLocks();
    if (n > 0) log.info({ host: HOST_ID, recovered: n }, 'sweep stale validaciones');
  } catch (e: any) {
    log.error({ err: e?.message }, 'sweep stale validaciones falló');
  }
}

export function startValidacionStaleCron(): void {
  if (timer) return;
  if (process.env.VALIDACION_STALE_CRON_ENABLED === '0') {
    log.info({ host: HOST_ID }, 'cron stale validaciones DESHABILITADO');
    return;
  }
  log.info({ host: HOST_ID, intervalMin: INTERVAL_MS / 60_000 }, 'cron stale validaciones activo');
  setTimeout(() => { tick().catch(() => {}); }, 30_000);
  timer = setInterval(() => { tick().catch(() => {}); }, INTERVAL_MS);
}

export function stopValidacionStaleCron(): void {
  if (timer) { clearInterval(timer); timer = null; }
  log.info('cron stale validaciones detenido');
}
