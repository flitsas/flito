// FLITO — cron de sincronización FLIT. Sigue la convención del repo (setInterval, arranca
// solo en producción desde server.ts). Gated por SYNC_HABILITADO. El intervalo se deriva de
// SYNC_CRON (patrón `S */N * * * *` → cada N minutos); cualquier otra forma cae a 5 min con warn.

import { env } from '../../config/env.js';
import { loggerFor } from '../../shared/logger.js';
import { sincronizar } from './flito-sync.service.js';

const log = loggerFor('flito-sync-cron');

let timer: NodeJS.Timeout | null = null;
let corriendo = false;

const DEFECTO_MS = 5 * 60 * 1000;

// Deriva el intervalo (ms) del campo de minutos con paso (p.ej. cada N minutos) de un cron
// de 6 campos. Comentario de línea a propósito: el patrón de paso contiene la secuencia que
// cerraría un comentario de bloque.
export function intervalMsFromCron(expr: string): number {
  const campos = expr.trim().split(/\s+/);
  // 6 campos (con segundos): [seg, min, hora, dom, mes, dow]; el minuto es el índice 1.
  const minuto = campos.length >= 6 ? campos[1] : campos[0];
  const match = /^\*\/(\d+)$/.exec(minuto ?? '');
  if (match) {
    const n = parseInt(match[1], 10);
    if (n >= 1 && n <= 60) return n * 60 * 1000;
  }
  log.warn({ expr }, `SYNC_CRON no es del tipo "*/N min"; usando 5 min por defecto`);
  return DEFECTO_MS;
}

async function correr(): Promise<void> {
  if (corriendo) { log.warn('sincronización previa aún en curso; se omite este tick'); return; }
  corriendo = true;
  try {
    await sincronizar();
  } catch (error) {
    log.error({ err: (error as Error).message }, 'sincronización programada falló');
  } finally {
    corriendo = false;
  }
}

export function startFlitSync(): void {
  if (timer) return;
  if (!env.SYNC_HABILITADO) {
    log.info('SYNC_HABILITADO=false — cron de sincronización FLIT desactivado');
    return;
  }
  const intervalMs = intervalMsFromCron(env.SYNC_CRON);
  log.info({ intervalMinutos: intervalMs / 60000, adapter: env.FLIT_ADAPTER }, 'cron de sincronización FLIT activo');

  // Primera corrida diferida (deja que el server termine de arrancar).
  setTimeout(() => { void correr(); }, 30_000).unref();

  timer = setInterval(() => { void correr(); }, intervalMs);
  timer.unref();
}

export function stopFlitSync(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
