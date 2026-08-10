// Siigo — ciclo periódico que consulta el estado ante la DIAN (HU #11332, Feature #11243).
//
// Todo lo que decide a quién consultar y cómo interpretarlo vive en `siigo.sondeo-dian.service.ts`.
// Aquí solo está lo que un proceso periódico tiene que resolver: cada cuánto corre, quién lo corre
// cuando hay varias instancias, y qué pasa si muere a medias.
//
// **El cerrojo es el AC5 y no es opcional.** En producción hay más de una instancia del servidor, y
// las dos levantan este cron. Sin `withLock`, las dos consultarían las mismas facturas en el mismo
// minuto: el doble de peticiones contra una cuota que ya se comparte con la emisión, para obtener
// exactamente la misma información. El TTL es menor que el intervalo a propósito — así un ciclo que
// muere sin liberar el cerrojo lo pierde por vencimiento y el siguiente puede correr, en vez de
// dejar el sondeo parado hasta que alguien reinicie.

import os from 'os';
import { env } from '../../config/env.js';
import { withLock } from '../../shared/utils/lock.js';
import { loggerFor } from '../../shared/logger.js';
import { PRESUPUESTO_POR_CICLO, sondearEstadosDian } from './siigo.sondeo-dian.service.js';

const log = loggerFor('siigo.dian.cron');
const HOST_ID = `${os.hostname()}-${process.pid}`;

/** Nombre del cerrojo. Uno solo para todo el despliegue: es la cuota lo que se protege. */
export const NOMBRE_CERROJO = 'siigo-dian-sondeo-cron';

const INTERVAL_MS = 5 * 60_000;
/**
 * TTL por debajo del intervalo. Si fuera mayor, un ciclo caído bloquearía también al siguiente y el
 * seguimiento se pararía en silencio — que es la peor forma de pararse.
 */
const LOCK_TTL_MS = 4 * 60_000;

/**
 * Hasta cuándo puede trabajar un ciclo. **El TTL corto solo protege si el ciclo termina antes.**
 *
 * Un TTL de cuatro minutos no impide nada por sí solo: el ciclo no dura lo que dura el TTL, dura lo
 * que tarden las peticiones. Con reintentos, timeout de 15 s y un limitador que DUERME cuando la
 * ventana está llena, una sola factura puede costar minutos y el presupuesto entero mucho más. Al
 * vencer el cerrojo, el tick siguiente lo readquiere y arranca un SEGUNDO ciclo sobre las mismas
 * facturas —el ancla de cadencia aún no ha avanzado—, duplicando peticiones contra la cuota
 * compartida justo durante la degradación, que es cuando menos sobra.
 *
 * Así que el ciclo se rinde antes de perder el cerrojo. Lo que no le dio tiempo a mirar no se
 * pierde: sale primero en el siguiente, porque el orden es por antigüedad de la última consulta.
 */
const PLAZO_DEL_CICLO_MS = Math.floor(LOCK_TTL_MS * 0.5);
/** Arranque diferido: al levantar el proceso hay cosas más urgentes que preguntar por la DIAN. */
const RETRASO_INICIAL_MS = 120_000;

function presupuesto(): number {
  return env.SIIGO_DIAN_SONDEO_LOTE ?? PRESUPUESTO_POR_CICLO;
}

/**
 * Guarda de reentrada dentro del proceso.
 *
 * `setInterval` no espera a que la ejecución anterior termine: si un ciclo se alarga, el siguiente
 * arranca encima. El cerrojo distribuido no lo ve —es el MISMO proceso, y `withLock` daría el
 * cerrojo por ajeno o vencido—, así que esta bandera es la que impide que una instancia se solape
 * consigo misma. Es barata y es la única que cubre ese caso concreto.
 */
let enCurso = false;

async function tick(): Promise<void> {
  if (enCurso) {
    log.debug({ host: HOST_ID }, 'ciclo anterior todavía en curso; se salta este');
    return;
  }
  enCurso = true;
  try {
    const r = await withLock(NOMBRE_CERROJO, LOCK_TTL_MS,
      () => sondearEstadosDian(presupuesto(), { plazoMs: PLAZO_DEL_CICLO_MS }));
    // `null` = otra instancia lo está corriendo. No es un fallo y no se registra como tal: en un
    // despliegue de tres instancias, dos de cada tres ciclos terminan así por diseño.
    if (r && r.consultadas > 0) log.info({ host: HOST_ID, ...r }, 'ciclo de sondeo del estado DIAN');
  } catch (e) {
    log.error({ err: e instanceof Error ? e.message : e }, 'ciclo de sondeo del estado DIAN falló');
  } finally {
    enCurso = false;
  }
}

let timer: NodeJS.Timeout | null = null;

export function startSiigoDianCron(): void {
  if (timer) return;
  if (process.env.SIIGO_DIAN_CRON_ENABLED === '0') {
    log.info({ host: HOST_ID }, 'cron de sondeo del estado DIAN DESHABILITADO');
    return;
  }
  log.info(
    { host: HOST_ID, intervalMin: INTERVAL_MS / 60_000, lockTtlMin: LOCK_TTL_MS / 60_000, presupuesto: presupuesto() },
    'cron de sondeo del estado DIAN activo',
  );
  setTimeout(() => { tick().catch(() => {}); }, RETRASO_INICIAL_MS).unref();
  timer = setInterval(() => { tick().catch(() => {}); }, INTERVAL_MS);
  timer.unref();
}

export function stopSiigoDianCron(): void {
  if (timer) { clearInterval(timer); timer = null; }
  log.info('cron de sondeo del estado DIAN detenido');
}
