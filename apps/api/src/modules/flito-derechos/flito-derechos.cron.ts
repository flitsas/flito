// FLITO Derechos de trámite — cron de sincronización con el Drive de los organismos (HU #10952).
//
// Sigue el patrón de los demás crons del repo: setInterval propio (no hay librería de cron) y
// `withLock` sobre la tabla de locks para que dos instancias de la API no barran a la vez. El lock
// es la misma llave que usa el botón «sincronizar ahora», así que un disparo manual y el ciclo
// programado nunca procesan los mismos archivos en paralelo (AC7).

import os from 'os';
import { env } from '../../config/env.js';
import { withLock } from '../../shared/utils/lock.js';
import { loggerFor } from '../../shared/logger.js';
import { sincronizarDerechosDrive } from './flito-derechos-drive.service.js';
import { reintentarPendientes } from './flito-derechos.service.js';

const log = loggerFor('flito-derechos-cron');

const HOST_ID = `${os.hostname()}-${process.pid}`;

/** Llave compartida con el disparo manual: los dos caminos compiten por el mismo lock (AC7). */
export const LOCK_SYNC_DERECHOS = 'flito-derechos-drive-sync';

/**
 * TTL del lock. Generoso a propósito: una carpeta con varios consolidados grandes son cientos de
 * llamadas de OCR. Si el proceso muere, el lock expira solo y el siguiente ciclo retoma.
 */
export const LOCK_TTL_MS = 30 * 60 * 1000;

const INTERVALO_MS = 60 * 60 * 1000; // cada hora
const RETRASO_INICIAL_MS = 5 * 60 * 1000; // no competir con el arranque de la API

/** Contexto del cron: no hay usuario humano detrás, pero la auditoría exige un actor con nombre. */
const CTX_CRON = { userId: 0, username: 'cron:flito-derechos-drive', role: 'admin' } as const;

async function correr(): Promise<void> {
  const resultado = await withLock(LOCK_SYNC_DERECHOS, LOCK_TTL_MS, async () => {
    const sync = await sincronizarDerechosDrive({ ...CTX_CRON });
    // El trámite que faltaba pudo llegar desde FLIT entre un barrido y otro: se reintenta el cruce
    // de los recibos que quedaron esperando.
    const pendientes = await reintentarPendientes({ ...CTX_CRON });
    return { sync, pendientes };
  });

  if (!resultado) { log.debug('otra instancia tiene el lock; se omite este ciclo'); return; }

  const { sync, pendientes } = resultado;
  const nuevos = sync.organismos.reduce((s, o) => s + o.archivosNuevos, 0);
  const registrados = sync.organismos.reduce((s, o) => s + o.registrados, 0);
  const conError = sync.organismos.filter((o) => o.error).map((o) => o.organismoCodigo);

  if (nuevos > 0 || registrados > 0 || pendientes.asociados > 0 || conError.length > 0) {
    log.info({
      organismosActivos: sync.organismosActivos, archivosNuevos: nuevos, registrados,
      pendientesAsociados: pendientes.asociados, organismosConError: conError,
    }, 'sincronización de derechos desde Drive');
  }
}

let timer: NodeJS.Timeout | null = null;

export function startDerechosDriveCron(): void {
  if (timer) return;
  // Sin credenciales de Drive el barrido solo generaría ruido de error cada hora.
  if (!env.GOOGLE_DRIVE_KEY_PATH) {
    log.info('GOOGLE_DRIVE_KEY_PATH no configurado: cron de derechos desde Drive inactivo');
    return;
  }
  log.info({ host: HOST_ID, intervaloMin: INTERVALO_MS / 60000 }, 'Activo');

  setTimeout(() => { correr().catch((e) => log.error({ err: e }, 'corrida inicial falló')); }, RETRASO_INICIAL_MS).unref();

  timer = setInterval(() => {
    correr().catch((e) => log.error({ err: e }, 'corrida falló'));
  }, INTERVALO_MS);
  timer.unref();
}

export function stopDerechosDriveCron(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
