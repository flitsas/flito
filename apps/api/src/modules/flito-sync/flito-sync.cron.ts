// FLITO — sincronización FLIT.
//
// FLIT 1 (HU #13629, Feature #13612): lectura automática con ventana móvil y nocturna. Timer fijo de 60 s
// (`TICK_FLIT1_MS`, `unref`) armado solo si `SYNC_HABILITADO` (maestro de entorno, encendido por defecto).
// Cada tick: si el anterior sigue en curso se salta (log `debug`); el resto (interruptor `flit1`, candado,
// «¿toca?» con la frecuencia leída de la base) vive en `flit1-lectura-automatica.service.ts`.
// La ruta manual `POST /flito/sync/sincronizar` se retiró en la HU #13631: FLIT 1 solo se lee aquí.
// `intervalMsFromCron` / `SYNC_CRON` son utilidad histórica, aún con pruebas (P-5: no se tocan aquí).
//
// FLIT 2 (HU #13092, Feature #13059): lectura programada (respaldo) cada `FLIT2_RESPALDO_MIN` minutos
// (HU #13633; 5 por defecto, 60 en DEV) mientras `FLIT2_SYNC_CRON` esté encendida (por defecto).
// Diseño: `docs/diseno/hu-13092-lectura-programada-flit2.md` y `docs/diseno/hu-13633-respaldo-alerta-flit2.md`.
//   - El intervalo se lee del env al armar el timer (`intervaloFlit2Ms()`), no al importar el módulo; el
//     mismo valor va al `setInterval`, al pulso (`marcarProgramaEncendido`) y al log.
//   - La primera corrida sale a un intervalo del arranque, nunca en el mismo tick del boot: si la migración
//     de la fila de lectura no está aplicada, la corrida lee, falla y se registra, sin tumbar el proceso.
//   - Sin acceso vigente, o con el acceso rechazado/en pausa, la corrida no llama a FLIT 2: lo decide el
//     pase (`verificarAcceso`) antes de fijar posición alguna.
//   - Candado entre procesos (`leerConCandado`); además, dentro del proceso, un tick no se encima con el
//     anterior (`enCurso`), para no reservar una conexión solo para descubrir que el candado está tomado.
//
// HU #13188 (pulso en el estado): el programa se publica en `flit2-programa.ts`. Encendido al armar el
// timer, apagado con `FLIT2_SYNC_CRON=false` y en `stopFlitSync`; cada tick adelanta `proximaEn` ANTES de
// decidir si lee o se salta (el `enCurso` local es la guarda anti-encimado, no el que se publica).
//
// HU #13237: con el interruptor de FLIT 2 apagado (`flito_sync_interruptor`) el timer sigue armado, pero
// la corrida no lee (`FuenteApagadaError`, log en debug). El maestro sigue siendo `FLIT2_SYNC_CRON`.

import { env } from '../../config/env.js';
import { loggerFor } from '../../shared/logger.js';
import { leerConCandado } from './flit2-lectura.service.js';
import {
  Flit2Error, Flit2LecturaEnCursoError, Flit2NoConfiguradoError, Flit2SinAccesoError,
} from './flit2.errors.js';
import { FuenteApagadaError } from './flito-sync-interruptor.service.js';
import { marcarProgramaApagado, marcarProgramaEncendido, registrarTick } from './flit2-programa.js';
import { correrLecturaFlit1Programada } from './flit1-lectura-automatica.service.js';
import { detenerAvisosFlit2 } from './flit2-avisos.service.js';

const log = loggerFor('flito-sync-cron');

const DEFECTO_MS = 5 * 60 * 1000;
/** Intervalo por defecto de la lectura de FLIT 2 (sin `FLIT2_RESPALDO_MIN`). El tope de una corrida (4 min) cabe dentro. */
export const INTERVALO_FLIT2_MS = 5 * 60 * 1000;

/** HU #13633 (AC1/AC2): intervalo del respaldo de FLIT 2 según `FLIT2_RESPALDO_MIN`, leído en cada llamada. */
export function intervaloFlit2Ms(): number {
  return env.FLIT2_RESPALDO_MIN * 60_000;
}

/** Tick de la lectura automática de FLIT 1: la frecuencia real (2–60 min) se decide en la base. */
export const TICK_FLIT1_MS = 60_000;

let timerFlit2: ReturnType<typeof setInterval> | null = null;
let enCurso = false;
let timerFlit1: ReturnType<typeof setInterval> | null = null;
let enCursoFlit1 = false;

/** Un tick de FLIT 1 (HU #13629). No se encima con el anterior del mismo proceso. Nunca lanza. */
export async function tickLecturaFlit1(ahora: Date = new Date()): Promise<void> {
  if (enCursoFlit1) {
    log.debug('lectura FLIT 1 automática: la anterior sigue en curso, se salta este tick');
    return;
  }
  enCursoFlit1 = true;
  try {
    await correrLecturaFlit1Programada(ahora);
  } finally {
    enCursoFlit1 = false;
  }
}

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
    // HU #13626: la corrida no se audita; cada trámite creado o cambiado deja su entrada en la Bitácora.
    await leerConCandado('cron');
  } catch (e) {
    if (e instanceof FuenteApagadaError) {
      // HU #13237: apagado intencional, no es falla (cada tick no debe ensuciar el log en warn).
      log.debug('lectura FLIT 2 programada: la fuente está apagada en este ambiente, no corre');
    } else if (e instanceof Flit2SinAccesoError || e instanceof Flit2NoConfiguradoError) {
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

function startFlit1(): void {
  if (!env.SYNC_HABILITADO) {
    log.info('Lectura automática de FLIT 1 apagada (SYNC_HABILITADO=false).');
    return;
  }
  if (timerFlit1) return;
  timerFlit1 = setInterval(() => { void tickLecturaFlit1(); }, TICK_FLIT1_MS);
  timerFlit1.unref?.();
  log.info({ tickMs: TICK_FLIT1_MS }, 'Lectura automática de FLIT 1 encendida.');
}

export function startFlitSync(): void {
  startFlit1();
  if (!env.FLIT2_SYNC_CRON) {
    log.info('Lectura programada de FLIT 2 apagada (FLIT2_SYNC_CRON=false).');
    marcarProgramaApagado();
    return;
  }
  if (timerFlit2) return;
  const intervaloMs = intervaloFlit2Ms();
  // setInterval: la primera corrida sale a un intervalo del arranque, no en el tick del arranque.
  timerFlit2 = setInterval(() => {
    registrarTick(new Date());
    void correrLecturaFlit2Programada();
  }, intervaloMs);
  timerFlit2.unref?.();
  marcarProgramaEncendido(intervaloMs, new Date());
  log.info({ cadaMs: intervaloMs }, 'Lectura programada de FLIT 2 encendida.');
}

export function stopFlitSync(): void {
  if (timerFlit1) clearInterval(timerFlit1);
  timerFlit1 = null;
  if (timerFlit2) clearInterval(timerFlit2);
  timerFlit2 = null;
  marcarProgramaApagado();
  // HU #13632: la agenda de avisos de FLIT 2 tiene sus propios timers (ventana, reintentos, volcado).
  detenerAvisosFlit2();
}
