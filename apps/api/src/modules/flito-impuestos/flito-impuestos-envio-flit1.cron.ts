// HU #13310 (ADR-0021): cron del envío del comprobante de pago a FLIT 1. Calco del de FLIT 2: cada 60 s,
// primer ciclo a los ~45 s del arranque (desfasado del de FLIT 2). El cerrojo de ciclo (`withLock`, tabla
// `system_locks`) vale entre procesos. Noop si IMPUESTOS_ENVIO_FLIT1_CRON_ENABLED=0. Aun activo, el ciclo
// no toma nada con `FLIT1_ADJUNTOS_ENVIO_HABILITADO` apagada, sin las dos bases o con el interruptor
// `flit1` apagado (RN-F1-01).
import os from 'os';
import { withLock } from '../../shared/utils/lock.js';
import { loggerFor } from '../../shared/logger.js';
import { procesarCicloEnvioFlit1 } from './flito-impuestos.envio-flit1.service.js';

const log = loggerFor('flito-impuestos.envio-flit1-cron');
const HOST_ID = `${os.hostname()}-${process.pid}`;
const INTERVAL_MS = 60_000;
const ARRANQUE_MS = 45_000;
/** TTL del cerrojo de ciclo: holgado frente al plazo de 50 s + un paso 2 en vuelo (≤ 60 s). */
const LOCK_TTL_MS = 5 * 60_000;
export const LOCK_ENVIO_FLIT1 = 'flito-impuestos-envio-flit1';

let timer: NodeJS.Timeout | null = null;
let arranque: NodeJS.Timeout | null = null;

export async function tickEnvioFlit1(): Promise<void> {
  try {
    const r = await withLock(LOCK_ENVIO_FLIT1, LOCK_TTL_MS, () => procesarCicloEnvioFlit1({ tomadoPor: HOST_ID }));
    if (r && r.tomadas > 0) log.info({ host: HOST_ID, ...r }, 'ciclo de envío de comprobantes a FLIT 1');
  } catch (e) {
    log.error({ err: (e as Error)?.name }, 'ciclo de envío de comprobantes a FLIT 1 falló');
  }
}

export function startImpuestosEnvioFlit1Cron(): void {
  if (timer) return;
  if (process.env.IMPUESTOS_ENVIO_FLIT1_CRON_ENABLED === '0') {
    log.info({ host: HOST_ID }, 'cron de envío de comprobantes a FLIT 1 DESHABILITADO');
    return;
  }
  log.info({ host: HOST_ID, intervalS: INTERVAL_MS / 1000 }, 'cron de envío de comprobantes a FLIT 1 activo');
  arranque = setTimeout(() => { tickEnvioFlit1().catch(() => {}); }, ARRANQUE_MS);
  timer = setInterval(() => { tickEnvioFlit1().catch(() => {}); }, INTERVAL_MS);
}

export function stopImpuestosEnvioFlit1Cron(): void {
  if (arranque) { clearTimeout(arranque); arranque = null; }
  if (timer) { clearInterval(timer); timer = null; }
  log.info('cron de envío de comprobantes a FLIT 1 detenido');
}
