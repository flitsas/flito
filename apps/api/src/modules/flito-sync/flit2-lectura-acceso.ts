// FLITO sync — lectura de FLIT 2 tras guardar el acceso (HU #13190, Feature #13059, Épica #12736).
// Sustituye al botón «Sincronizar FLIT 2» (HU #13091, retirado): al guardar un acceso válido, la
// lectura arranca sola en segundo plano, con el mismo candado, tope y registro que la del cron.
//
// ── Reglas de negocio ────────────────────────────────────────────────────────────────────────────
//
// RN-01  Solo con `FLIT2_SYNC_CRON` encendida: la MISMA variable que arma el cron. Apagada, el ambiente
//        no lee FLIT 2 (decisión del PO), tampoco al guardar el acceso. Se lee la variable y no el
//        programa en memoria (`leerPrograma().activa`) porque este depende de que `startFlitSync` haya
//        corrido antes en el proceso; la variable es la decisión del ambiente, sin orden de arranque.
// RN-02  Fuego y olvido: la respuesta del PUT no espera la lectura. `lanzarLecturaTrasAcceso` nunca
//        lanza ni deja una promesa rechazada sin capturar.
// RN-03  Desenlace como el del cron (`correrLecturaFlit2Programada`): el error queda en la fila de lectura
//        (lo anota `leerIncremental`, y el estado lo muestra como problema) y en el log, sin PII. El
//        candado tomado es un aviso de log, no un error. Si termina bien, se audita como la programada,
//        con detalle «tras guardar el acceso».

import { env } from '../../config/env.js';
import { loggerFor } from '../../shared/logger.js';
import { auditarLecturaProgramada, leerConCandado } from './flit2-lectura.service.js';
import {
  Flit2Error, Flit2LecturaEnCursoError, Flit2NoConfiguradoError, Flit2SinAccesoError,
} from './flit2.errors.js';

const log = loggerFor('flito-sync-flit2');

/** La corrida en sí. Nunca rechaza (RN-02, RN-03). Exportada para el test. */
export async function correrLecturaTrasAcceso(): Promise<void> {
  try {
    const r = await leerConCandado('acceso');
    await auditarLecturaProgramada(r, 'acceso');
  } catch (e) {
    if (e instanceof Flit2SinAccesoError || e instanceof Flit2NoConfiguradoError) {
      log.info({ codigo: e.codigo }, 'lectura FLIT 2 tras guardar el acceso: sin acceso utilizable, no corre');
    } else if (e instanceof Flit2LecturaEnCursoError) {
      log.info('lectura FLIT 2 tras guardar el acceso: otra corrida tiene el candado, no se lanza otra');
    } else if (e instanceof Flit2Error) {
      log.warn({ codigo: e.codigo }, 'lectura FLIT 2 tras guardar el acceso interrumpida');
    } else {
      log.error({ err: e instanceof Error ? e.name : typeof e }, 'lectura FLIT 2 tras guardar el acceso falló');
    }
  }
}

/**
 * Tras un PUT del acceso que respondió 200: arranca la lectura sin esperarla (RN-01, RN-02).
 * Devuelve si la lanzó (para el log y el test).
 */
export function lanzarLecturaTrasAcceso(): boolean {
  if (!env.FLIT2_SYNC_CRON) {
    log.debug('lectura FLIT 2 apagada (FLIT2_SYNC_CRON=false): guardar el acceso no lanza lectura');
    return false;
  }
  // `correrLecturaTrasAcceso` no rechaza; el `catch` es el cinturón para que nada quede sin capturar.
  correrLecturaTrasAcceso().catch((e: unknown) => {
    log.error({ err: e instanceof Error ? e.name : typeof e }, 'lectura FLIT 2 tras guardar el acceso falló');
  });
  return true;
}
