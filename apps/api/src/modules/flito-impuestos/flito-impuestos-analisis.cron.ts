// HU #12825 (AC4): recupera los análisis post-envío de impuestos que quedaron `en_curso` sin job
// (reinicio del proceso, caída a mitad). Primer barrido a los ~5 s del arranque («al arrancar») y
// luego cada 5 min. Activo en producción por defecto; noop si IMPUESTOS_ANALISIS_CRON_ENABLED=0.
import os from 'os';
import { barrerAnalisisHuerfanos } from './flito-impuestos.analisis.service.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('flito-impuestos.analisis-cron');
const HOST_ID = `${os.hostname()}-${process.pid}`;
const INTERVAL_MS = 5 * 60_000;
const ARRANQUE_MS = 5_000;

let timer: NodeJS.Timeout | null = null;
let arranque: NodeJS.Timeout | null = null;

async function tick(): Promise<void> {
  try {
    const r = await barrerAnalisisHuerfanos();
    if (r.reencolados > 0 || r.fallidos > 0) log.info({ host: HOST_ID, ...r }, 'barrido de análisis huérfanos');
  } catch (e) {
    log.error({ err: (e as Error)?.message }, 'barrido de análisis huérfanos falló');
  }
}

export function startImpuestosAnalisisCron(): void {
  if (timer) return;
  if (process.env.IMPUESTOS_ANALISIS_CRON_ENABLED === '0') {
    log.info({ host: HOST_ID }, 'cron de análisis de impuestos DESHABILITADO');
    return;
  }
  log.info({ host: HOST_ID, intervalMin: INTERVAL_MS / 60_000 }, 'cron de análisis de impuestos activo');
  arranque = setTimeout(() => { tick().catch(() => {}); }, ARRANQUE_MS);
  timer = setInterval(() => { tick().catch(() => {}); }, INTERVAL_MS);
}

export function stopImpuestosAnalisisCron(): void {
  if (arranque) { clearTimeout(arranque); arranque = null; }
  if (timer) { clearInterval(timer); timer = null; }
  log.info('cron de análisis de impuestos detenido');
}
