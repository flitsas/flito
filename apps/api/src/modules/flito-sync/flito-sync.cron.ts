// FLITO — sincronización FLIT.
//
// FLIT 1: la sync es SOLO MANUAL (Operaciones elige la fecha inicial); no hay corrida automática.
// `intervalMsFromCron` es utilidad histórica, aún con pruebas.
//
// FLIT 2 (HU #13092, Feature #13059): lectura programada cada 5 min mientras `FLIT2_SYNC_CRON` esté
// encendida (por defecto). Diseño: `docs/diseno/hu-13092-lectura-programada-flit2.md`.
//   - La primera corrida sale a los 5 min del arranque, nunca en el mismo tick del boot: si la migración
//     de la fila de lectura no está aplicada, la corrida lee, falla y se registra, sin tumbar el proceso.
//   - Sin acceso vigente, o con el acceso rechazado/en pausa, la corrida no llama a FLIT 2: lo decide el
//     pase (`verificarAcceso`) antes de fijar posición alguna.
//   - Candado entre procesos (`leerConCandado`); además, dentro del proceso, un tick no se encima con el
//     anterior (`enCurso`), para no reservar una conexión solo para descubrir que el candado está tomado.

import { env } from '../../config/env.js';
import { loggerFor } from '../../shared/logger.js';
import { auditarLecturaProgramada, leerConCandado } from './flit2-lectura.service.js';
import {
  Flit2Error, Flit2LecturaEnCursoError, Flit2NoConfiguradoError, Flit2SinAccesoError,
} from './flit2.errors.js';

const log = loggerFor('flito-sync-cron');

const DEFECTO_MS = 5 * 60 * 1000;
/** Cada cuánto corre la lectura de FLIT 2. El tope de una corrida (4 min) cabe dentro. */
export const INTERVALO_FLIT2_MS = 5 * 60 * 1000;

let timerFlit2: ReturnType<typeof setInterval> | null = null;
let enCurso = false;

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

/**
 * Una corrida programada de FLIT 2. Nunca lanza: el desenlace queda en la fila de lectura y en el log
 * (sin PII: solo códigos y totales). Exportada para el test.
 */
export async function correrLecturaFlit2Programada(): Promise<void> {
  if (enCurso) {
    log.info('lectura FLIT 2 programada: la anterior sigue en curso, se salta este tick');
    return;
  }
  enCurso = true;
  try {
    const r = await leerConCandado('cron');
    await auditarLecturaProgramada(r);
  } catch (e) {
    if (e instanceof Flit2SinAccesoError || e instanceof Flit2NoConfiguradoError) {
      log.debug({ codigo: e.codigo }, 'lectura FLIT 2 programada: sin acceso utilizable, no corre');
    } else if (e instanceof Flit2LecturaEnCursoError) {
      log.info('lectura FLIT 2 programada: otra corrida tiene el candado, se salta este tick');
    } else if (e instanceof Flit2Error) {
      log.warn({ codigo: e.codigo }, 'lectura FLIT 2 programada interrumpida');
    } else {
      log.error({ err: e instanceof Error ? e.name : typeof e }, 'lectura FLIT 2 programada falló');
    }
  } finally {
    enCurso = false;
  }
}

export function startFlitSync(): void {
  log.info('Sincronización FLIT 1 es manual (integración real): sin cron automático.');
  if (!env.FLIT2_SYNC_CRON) {
    log.info('Lectura programada de FLIT 2 apagada (FLIT2_SYNC_CRON=false).');
    return;
  }
  if (timerFlit2) return;
  // setInterval: la primera corrida sale a los 5 min, no en el tick del arranque.
  timerFlit2 = setInterval(() => { void correrLecturaFlit2Programada(); }, INTERVALO_FLIT2_MS);
  timerFlit2.unref?.();
  log.info({ cadaMs: INTERVALO_FLIT2_MS }, 'Lectura programada de FLIT 2 encendida.');
}

export function stopFlitSync(): void {
  if (timerFlit2) clearInterval(timerFlit2);
  timerFlit2 = null;
}
