// FLITO SOAT — borrados PENDIENTES del almacenamiento: la PROGRAMACIÓN de la corrida horaria
// (HU #13410, Feature #13408, Épica #13201). El recorrido y las reglas RN-BP1…RN-BP3 viven en
// `flito-soat-borrados-pendientes.service.ts`; la política, en `docs/privacy/retencion-flito-soat.md`.
//
// RN-BP4  Puerta POSITIVA: sin `SOAT_BORRADOS_PENDIENTES_CRON_ENABLED=1` no arranca y lo dice en el
//         log (un job que BORRA no se enciende por desplegarse). Una corrida cada hora, sin ventana
//         horaria, entera dentro de `withLock`: la instancia que no obtiene el candado lo registra y
//         termina sin leer nada. Guarda `enVuelo` por proceso. Lote de `LOTE_BORRADOS` por corrida.
//
// Logs: solo host, conteos y nombre del error. Ninguna clave de almacenamiento.

import os from 'os';
import { env } from '../../config/env.js';
import { loggerFor } from '../../shared/logger.js';
import { withLock } from '../../shared/utils/lock.js';
import { LOTE_BORRADOS, ejecutarBorradosPendientes } from './flito-soat-borrados-pendientes.service.js';

const log = loggerFor('flito-soat-borrados-pendientes-cron');
const HOST_ID = `${os.hostname()}-${process.pid}`;

/** Cadencia de la corrida (RN-BP4). */
export const INTERVALO_BORRADOS_MS = 60 * 60_000;
/** Candado (RN-BP4). Cabe en `system_locks.lock_name` (50). */
export const NOMBRE_LOCK_BORRADOS = 'flito-storage-borrados-pendientes';
/** TTL del candado: menor que el intervalo, mayor que una corrida de un lote. */
export const LOCK_TTL_BORRADOS_MS = 15 * 60_000;

function nombreDeError(e: unknown): string {
  return e instanceof Error && e.name ? e.name : 'error';
}

let enVuelo = false;

/** Solo para tests. */
export function reiniciarEstadoBorrados(): void { enVuelo = false; }

export type ResultadoLatidoBorrados = 'en_vuelo' | 'otra_instancia' | 'corrida' | 'fallo';

/**
 * Un latido. Exportado para ejercer la programación sin `setInterval`.
 * @param ahora Instante de la corrida; por defecto, el real.
 */
export async function latidoBorradosPendientes(ahora: Date = new Date()): Promise<ResultadoLatidoBorrados> {
  if (enVuelo) return 'en_vuelo';
  enVuelo = true;
  try {
    const r = await withLock(NOMBRE_LOCK_BORRADOS, LOCK_TTL_BORRADOS_MS, () => ejecutarBorradosPendientes({ ahora }));
    if (r === null) {
      log.info({ host: HOST_ID, lock: NOMBRE_LOCK_BORRADOS },
        'otra instancia tiene los borrados pendientes del almacenamiento: esta no hace nada');
      return 'otra_instancia';
    }
    const datos = { host: HOST_ID, ...r };
    if (r.fallidos > 0) log.warn(datos, 'borrados pendientes: quedaron objetos sin borrar; se reintentan en una hora');
    else log.info(datos, 'borrados pendientes: corrida completa');
    return 'corrida';
  } catch (e) {
    log.error({ host: HOST_ID, err: nombreDeError(e) }, 'borrados pendientes: la corrida falló');
    return 'fallo';
  } finally {
    enVuelo = false;
  }
}

let timer: NodeJS.Timeout | null = null;

/** Arranca el cron. Noop —y lo dice en el log— si la puerta de RN-BP4 está cerrada. */
export function startSoatBorradosPendientesCron(): void {
  if (timer) return;
  if (!env.SOAT_BORRADOS_PENDIENTES_CRON_ENABLED) {
    log.info({ host: HOST_ID },
      'borrados pendientes del almacenamiento DESHABILITADO (SOAT_BORRADOS_PENDIENTES_CRON_ENABLED!=1)');
    return;
  }
  log.info({ host: HOST_ID, intervaloMs: INTERVALO_BORRADOS_MS, lote: LOTE_BORRADOS },
    'borrados pendientes del almacenamiento ACTIVO');
  timer = setInterval(() => {
    void latidoBorradosPendientes().catch((e) => log.error({ host: HOST_ID, err: nombreDeError(e) }, 'latido de borrados pendientes'));
  }, INTERVALO_BORRADOS_MS);
  timer.unref();
}

export function stopSoatBorradosPendientesCron(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    log.info({ host: HOST_ID }, 'borrados pendientes del almacenamiento detenido');
  }
}
