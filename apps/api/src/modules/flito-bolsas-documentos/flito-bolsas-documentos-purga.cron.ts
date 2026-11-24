// HU #13891 (ADR-0028 §9) — PROGRAMACIÓN de la purga por retención de las versiones reemplazadas del
// expediente de la compañía. El recorrido vive en `flito-bolsas-documentos-purga.service.ts`.
//
// RN-BDP4  Una vez al día, 03:00–03:59 hora de COLOMBIA (`relojBogota`, igual que la retención del
//          SOAT). Puerta POSITIVA: sin `BOLSAS_DOCUMENTOS_PURGA_CRON_ENABLED=1` no arranca y lo dice
//          en el log. `withLock('flito-bolsas-docs-purga', 30 min)`: una sola réplica purga; la que no
//          obtiene el candado lo registra y no lee nada. Un reinicio dentro de la hora puede repetir la
//          corrida y es inocuo (una versión purgada no vuelve a leerse).
//
// Logs: una línea por corrida (`bolsas.documentos.versiones_purgadas`) con conteos y bytes; sin ids
// de compañía, claves ni nombres.

import os from 'os';
import { env } from '../../config/env.js';
import { loggerFor } from '../../shared/logger.js';
import { withLock } from '../../shared/utils/lock.js';
import { relojBogota } from '../flito-soat/flito-soat-retencion.cron.js';
import {
  ANIOS_RETENCION_VERSIONES, LOTE_PURGA, ejecutarPurgaVersiones,
} from './flito-bolsas-documentos-purga.service.js';

const log = loggerFor('flito-bolsas-documentos.purga-cron');
const HOST_ID = `${os.hostname()}-${process.pid}`;

export const HORA_PURGA = 3;
export const LATIDO_PURGA_MS = 10 * 60_000;
/** Cabe en `system_locks.lock_name` (50). */
export const NOMBRE_LOCK_PURGA = 'flito-bolsas-docs-purga';
export const LOCK_TTL_PURGA_MS = 30 * 60_000;

function nombreDeError(e: unknown): string {
  return e instanceof Error && e.name ? e.name : 'error';
}

let ultimoDia: string | null = null;
let enVuelo = false;

/** Solo para tests: olvida el día corrido. */
export function reiniciarEstadoPurga(): void { ultimoDia = null; enVuelo = false; }

export type ResultadoLatidoPurga = 'fuera_de_ventana' | 'ya_corrio_hoy' | 'en_vuelo' | 'otra_instancia' | 'corrida' | 'fallo';

/** Un latido. Exportado para ejercer la programación sin `setInterval`. */
export async function latidoPurgaVersiones(ahora: Date = new Date()): Promise<ResultadoLatidoPurga> {
  const { dia, hora } = relojBogota(ahora);
  if (hora !== HORA_PURGA) return 'fuera_de_ventana';
  if (ultimoDia === dia) return 'ya_corrio_hoy';
  if (enVuelo) return 'en_vuelo';

  enVuelo = true;
  try {
    const r = await withLock(NOMBRE_LOCK_PURGA, LOCK_TTL_PURGA_MS, () => ejecutarPurgaVersiones({ ahora }));
    ultimoDia = dia;
    if (r === null) {
      log.info({ host: HOST_ID, dia, lock: NOMBRE_LOCK_PURGA }, 'otra instancia tiene la purga de versiones de documentos');
      return 'otra_instancia';
    }
    const datos = { evento: 'bolsas.documentos.versiones_purgadas', host: HOST_ID, dia, ...r };
    if (r.objetosPendientes > 0) {
      log.warn(datos, 'purga de versiones de documentos: objetos en borrados pendientes; los reintenta su barrido');
    } else {
      log.info(datos, 'purga de versiones de documentos: corrida completa');
    }
    return 'corrida';
  } catch (e) {
    // Sin marcar el día: el latido siguiente de la misma hora lo reintenta.
    log.error({ host: HOST_ID, dia, err: nombreDeError(e) }, 'purga de versiones de documentos: la corrida falló');
    return 'fallo';
  } finally {
    enVuelo = false;
  }
}

let timer: NodeJS.Timeout | null = null;

export function startBolsasDocumentosPurgaCron(): void {
  if (timer) return;
  if (!env.BOLSAS_DOCUMENTOS_PURGA_CRON_ENABLED) {
    log.info({ host: HOST_ID },
      'purga de versiones de documentos DESHABILITADA (BOLSAS_DOCUMENTOS_PURGA_CRON_ENABLED!=1)');
    return;
  }
  log.info({ host: HOST_ID, hora: HORA_PURGA, anios: ANIOS_RETENCION_VERSIONES, lote: LOTE_PURGA },
    'purga de versiones de documentos ACTIVA');
  timer = setInterval(() => {
    void latidoPurgaVersiones().catch((e) => log.error({ host: HOST_ID, err: nombreDeError(e) }, 'latido de purga de documentos'));
  }, LATIDO_PURGA_MS);
  timer.unref();
}

export function stopBolsasDocumentosPurgaCron(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    log.info({ host: HOST_ID }, 'purga de versiones de documentos detenida');
  }
}
