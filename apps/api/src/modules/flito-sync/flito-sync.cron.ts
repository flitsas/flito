// FLITO — sincronización FLIT. Decisión de integración: la sync es SOLO MANUAL (Operaciones elige la
// fecha inicial), así que ya NO hay corrida automática. Se conservan start/stop (no-op) por compatibilidad
// con server.ts, e `intervalMsFromCron` (utilidad histórica, aún con pruebas).

import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('flito-sync-cron');

const DEFECTO_MS = 5 * 60 * 1000;

// Deriva el intervalo (ms) del campo de minutos con paso (p.ej. cada N minutos) de un cron de 6 campos.
export function intervalMsFromCron(expr: string): number {
  const campos = expr.trim().split(/\s+/);
  const minuto = campos.length >= 6 ? campos[1] : campos[0];
  const match = /^\*\/(\d+)$/.exec(minuto ?? '');
  if (match) {
    const n = parseInt(match[1], 10);
    if (n >= 1 && n <= 60) return n * 60 * 1000;
  }
  return DEFECTO_MS;
}

export function startFlitSync(): void {
  log.info('Sincronización FLIT es manual (integración real): sin cron automático.');
}

export function stopFlitSync(): void {
  // No-op: no hay timer que detener.
}
