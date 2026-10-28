// HU #14132 (Feature #14013, ADR-0032) — PROGRAMACIÓN del worker de la carga masiva de SOAT: un `setInterval` de
// 2,5 s. La lógica vive en `flito-soat-masivo.worker.ts`.
//
// RN-MASC1  Puerta POSITIVA: sin `SOAT_MASIVO_WORKER_ENABLED=1` no arranca NADA (ni worker, ni mantenimiento, ni
//           vigilante). Por eso el alta del lote (POST /cliente/masivo) responde 503 `carga_masiva_no_disponible`
//           con el flag apagado: de lo contrario el lote quedaría `en_cola` para siempre y bloquearía a su compañía.
// RN-MASC2  Sin `withLock` en el tick: el reclamo (SKIP LOCKED) ya serializa entre réplicas.
// Logs: solo host y nombre del error; ningún dato de persona.

import os from 'os';
import { env } from '../../config/env.js';
import { loggerFor } from '../../shared/logger.js';
import { correrTick, drenarWorkerMasivo, CONCURRENCIA_LOCAL } from './flito-soat-masivo.worker.js';

const log = loggerFor('flito-soat-masivo-cron');
const HOST_ID = `${os.hostname()}-${process.pid}`;
/** Polling de la cola (2–3 s, decisión del diseño). */
export const LATIDO_MASIVO_MS = 2_500;

let timer: NodeJS.Timeout | null = null;

export function startSoatMasivoCron(): void {
  if (timer) return;
  if (!env.SOAT_MASIVO_WORKER_ENABLED) {
    log.info({ host: HOST_ID }, 'worker de la carga masiva de SOAT DESHABILITADO (SOAT_MASIVO_WORKER_ENABLED!=1)');
    return;
  }
  log.info({ host: HOST_ID, concurrencia: CONCURRENCIA_LOCAL, latidoMs: LATIDO_MASIVO_MS }, 'worker de la carga masiva de SOAT ACTIVO');
  timer = setInterval(() => {
    void correrTick().catch((e) => log.error({ host: HOST_ID, err: e instanceof Error ? e.name : 'error' }, 'tick de la carga masiva de SOAT'));
  }, LATIDO_MASIVO_MS);
  timer.unref();
}

/** Deja de reclamar y espera (en segundo plano) las filas en vuelo. */
export function stopSoatMasivoCron(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    log.info({ host: HOST_ID }, 'worker de la carga masiva de SOAT detenido; se drenan las filas en vuelo');
    void drenarWorkerMasivo();
  }
}
