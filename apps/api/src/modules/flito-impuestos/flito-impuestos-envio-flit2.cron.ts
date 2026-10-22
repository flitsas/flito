// HU #13268 (ADR-0020): cron del envío del comprobante de pago a FLIT 2. Cada 60 s, primer ciclo a los
// ~30 s del arranque. El cerrojo de ciclo (`withLock`, tabla `system_locks`) vale entre procesos: con
// PM2 en cluster o varias réplicas solo un ciclo corre a la vez, así que el ritmo y la concurrencia
// son globales (RN-04). Noop si IMPUESTOS_ENVIO_FLIT2_CRON_ENABLED=0. Aun activo, el ciclo no toma
// nada con `FLIT2_ADJUNTOS_ENVIO_HABILITADO` apagada o el interruptor `flit2` apagado (RN-05).
import os from 'os';
import { withLock } from '../../shared/utils/lock.js';
import { loggerFor } from '../../shared/logger.js';
import { procesarCicloEnvioFlit2 } from './flito-impuestos.envio-flit2.service.js';

const log = loggerFor('flito-impuestos.envio-flit2-cron');
const HOST_ID = `${os.hostname()}-${process.pid}`;
const INTERVAL_MS = 60_000;
const ARRANQUE_MS = 30_000;
/** TTL del cerrojo de ciclo: holgado frente al plazo de 50 s (un proceso caído lo suelta solo). */
const LOCK_TTL_MS = 5 * 60_000;
export const LOCK_ENVIO_FLIT2 = 'flito-impuestos-envio-flit2';

let timer: NodeJS.Timeout | null = null;
let arranque: NodeJS.Timeout | null = null;

export async function tickEnvioFlit2(): Promise<void> {
  try {
    const r = await withLock(LOCK_ENVIO_FLIT2, LOCK_TTL_MS, () => procesarCicloEnvioFlit2({ tomadoPor: HOST_ID }));
    if (r && r.tomadas > 0) log.info({ host: HOST_ID, ...r }, 'ciclo de envío de comprobantes a FLIT 2');
  } catch (e) {
    log.error({ err: (e as Error)?.name }, 'ciclo de envío de comprobantes a FLIT 2 falló');
  }
}

export function startImpuestosEnvioFlit2Cron(): void {
  if (timer) return;
  if (process.env.IMPUESTOS_ENVIO_FLIT2_CRON_ENABLED === '0') {
    log.info({ host: HOST_ID }, 'cron de envío de comprobantes a FLIT 2 DESHABILITADO');
    return;
  }
  log.info({ host: HOST_ID, intervalS: INTERVAL_MS / 1000 }, 'cron de envío de comprobantes a FLIT 2 activo');
  arranque = setTimeout(() => { tickEnvioFlit2().catch(() => {}); }, ARRANQUE_MS);
  timer = setInterval(() => { tickEnvioFlit2().catch(() => {}); }, INTERVAL_MS);
}

export function stopImpuestosEnvioFlit2Cron(): void {
  if (arranque) { clearTimeout(arranque); arranque = null; }
  if (timer) { clearInterval(timer); timer = null; }
  log.info('cron de envío de comprobantes a FLIT 2 detenido');
}
