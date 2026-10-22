// Dr. Flit — PROGRAMACIÓN de la purga de intentos de radicación (HU #13804, D6). El borrado vive en
// `dr-flit-purga.service.ts` (RN-DRF1); la política, en `docs/privacy/retencion-flito-dr-flit.md`.
// Molde: `flito-soat/flito-soat-retencion.cron.ts`.
//
// RN-DRF2  Hora de COLOMBIA (03:00–03:59, `America/Bogota` vía `Intl`), no la del contenedor. Latido de
//          10 min; una corrida al día por proceso. Repetirla es inocuo (el borrado es idempotente).
// RN-DRF3  Puerta POSITIVA: sin `DRFLIT_PURGA_CRON_ENABLED=1` no arranca y lo dice en el log: un job
//          que BORRA no se enciende por desplegarse.
// RN-DRF4  Un solo servidor: la corrida va dentro de `withLock`; la instancia sin candado no borra.
//
// Logs: solo conteos, corte, día y host. Ningún identificador de persona.
import os from 'os';
import { env } from '../../config/env.js';
import { loggerFor } from '../../shared/logger.js';
import { withLock } from '../../shared/utils/lock.js';
import { relojBogota } from '../flito-soat/flito-soat-retencion.cron.js';
import { LOTE_PURGA_DRFLIT, MESES_RETENCION_DRFLIT, ejecutarPurgaDrFlit } from './dr-flit-purga.service.js';

const log = loggerFor('flito-dr-flit-purga-cron');
const HOST_ID = `${os.hostname()}-${process.pid}`;

export const HORA_PURGA_DRFLIT = 3;
export const LATIDO_PURGA_DRFLIT_MS = 10 * 60_000;
/** Cabe en `system_locks.lock_name` (50). */
export const NOMBRE_LOCK_PURGA_DRFLIT = 'flito-drflit-purga';
export const LOCK_TTL_PURGA_DRFLIT_MS = 30 * 60_000;

const nombreDeError = (e: unknown): string => (e instanceof Error && e.name ? e.name : 'error');

let ultimoDia: string | null = null;
let enVuelo = false;

/** Solo para tests: olvida el día corrido. */
export function reiniciarEstadoPurgaDrFlit(): void { ultimoDia = null; enVuelo = false; }

export type ResultadoLatidoPurga = 'fuera_de_ventana' | 'ya_corrio_hoy' | 'en_vuelo' | 'otra_instancia' | 'corrida' | 'fallo';

/** Un latido. Exportado para ejercer la programación sin `setInterval`. */
export async function latidoPurgaDrFlit(ahora: Date = new Date()): Promise<ResultadoLatidoPurga> {
  const { dia, hora } = relojBogota(ahora);
  if (hora !== HORA_PURGA_DRFLIT) return 'fuera_de_ventana';
  if (ultimoDia === dia) return 'ya_corrio_hoy';
  if (enVuelo) return 'en_vuelo';
  enVuelo = true;
  try {
    const r = await withLock(NOMBRE_LOCK_PURGA_DRFLIT, LOCK_TTL_PURGA_DRFLIT_MS, () => ejecutarPurgaDrFlit({ ahora }));
    ultimoDia = dia;
    if (r === null) {
      log.info({ host: HOST_ID, dia, lock: NOMBRE_LOCK_PURGA_DRFLIT }, 'otra instancia tiene la purga de Dr. Flit');
      return 'otra_instancia';
    }
    log.info({ host: HOST_ID, dia, ...r }, 'purga de intentos de Dr. Flit: corrida completa');
    return 'corrida';
  } catch (e) {
    // Sin marcar el día: el latido siguiente de la misma hora lo reintenta.
    log.error({ host: HOST_ID, dia, err: nombreDeError(e) }, 'purga de intentos de Dr. Flit: la corrida falló');
    return 'fallo';
  } finally {
    enVuelo = false;
  }
}

let timer: NodeJS.Timeout | null = null;

/** Arranca el cron. Noop —y lo dice en el log— si la puerta de RN-DRF3 está cerrada. */
export function startDrflitPurgaCron(): void {
  if (timer) return;
  if (!env.DRFLIT_PURGA_CRON_ENABLED) {
    log.info({ host: HOST_ID }, 'purga de intentos de Dr. Flit DESHABILITADA (DRFLIT_PURGA_CRON_ENABLED!=1)');
    return;
  }
  log.info({ host: HOST_ID, hora: HORA_PURGA_DRFLIT, meses: MESES_RETENCION_DRFLIT, lote: LOTE_PURGA_DRFLIT },
    'purga de intentos de Dr. Flit ACTIVA');
  timer = setInterval(() => {
    void latidoPurgaDrFlit().catch((e) => log.error({ host: HOST_ID, err: nombreDeError(e) }, 'latido de purga de Dr. Flit'));
  }, LATIDO_PURGA_DRFLIT_MS);
  timer.unref();
}

export function stopDrflitPurgaCron(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    log.info({ host: HOST_ID }, 'purga de intentos de Dr. Flit detenida');
  }
}
