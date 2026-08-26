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
import { resolverMotivosPendientes } from './siigo.motivo-rechazo.service.js';

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
/**
 * Cuántos motivos de rechazo pendientes se resuelven por ciclo.
 *
 * Menor que el presupuesto del sondeo, y con razón: los rechazos son la excepción, no la norma. Un
 * lote grande aquí le quitaría turnos al seguimiento de las facturas que sí están saliendo bien.
 */
const LOTE_MOTIVOS = 5;

/** Arranque diferido: al levantar el proceso hay cosas más urgentes que preguntar por la DIAN. */
const RETRASO_INICIAL_MS = 120_000;

/**
 * Cuántas facturas mira cada ciclo del sondeo del estado DIAN (HU #11332, AC2).
 *
 * Era `SIIGO_DIAN_SONDEO_LOTE` y dejó de ser variable de entorno en el Bug #11649. La razón del
 * número se traslada aquí literal, porque el número sin ella no se puede tocar con criterio:
 *
 *   El número correcto depende del volumen de cada instalación: la cuota de 100/min es de la
 *   EMPRESA y la comparte con la emisión, así que subirlo se le quita a lo que está saliendo.
 *
 * Que dependa de la instalación no lo convierte en configuración de despliegue: hay UNA
 * instalación, y ajustarlo aquí es un cambio revisable y con historia, en vez de una variable que
 * cada ambiente pudo haber puesto en un número distinto sin que nadie se enterara.
 */
const PRESUPUESTO = PRESUPUESTO_POR_CICLO;

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
    const r = await withLock(NOMBRE_CERROJO, LOCK_TTL_MS, async () => {
      const estados = await sondearEstadosDian(PRESUPUESTO, { plazoMs: PLAZO_DEL_CICLO_MS });
      // Los rechazos que se quedaron sin explicar (HU #11333). Va DENTRO del mismo cerrojo y del
      // mismo ciclo, no en un cron aparte: comparte la cuota de la empresa con el sondeo y con la
      // emisión, así que darle su propio reloj sería darle un presupuesto que nadie coordina.
      //
      // El sondeo ya resuelve el motivo en el momento de detectar el rechazo; esto recoge solo lo
      // que quedó pendiente porque la consulta del detalle falló.
      const motivos = await resolverMotivosPendientes(LOTE_MOTIVOS);
      return { ...estados, motivos };
    });
    // `null` = otra instancia lo está corriendo. No es un fallo y no se registra como tal: en un
    // despliegue de tres instancias, dos de cada tres ciclos terminan así por diseño.
    if (r && (r.consultadas > 0 || r.motivos.revisadas > 0)) {
      log.info({ host: HOST_ID, ...r }, 'ciclo de sondeo del estado DIAN');
    }
  } catch (e) {
    log.error({ err: e instanceof Error ? e.message : e }, 'ciclo de sondeo del estado DIAN falló');
  } finally {
    enCurso = false;
  }
}

let timer: NodeJS.Timeout | null = null;

export function startSiigoDianCron(): void {
  if (timer) return;
  // Bug #11649: apagado por defecto y leído del esquema validado, nunca de `process.env`. La guarda
  // anterior (`SIIGO_DIAN_CRON_ENABLED !== '0'`) dejaba el cron encendido ante cualquier valor que
  // no fuera esa cadena exacta, la variable ausente o mal escrita incluidas.
  if (env.SIIGO_CRONS !== 'on') {
    log.info({ host: HOST_ID, siigoCrons: env.SIIGO_CRONS }, 'cron de sondeo del estado DIAN DESHABILITADO');
    return;
  }
  log.info(
    { host: HOST_ID, intervalMin: INTERVAL_MS / 60_000, lockTtlMin: LOCK_TTL_MS / 60_000, presupuesto: PRESUPUESTO },
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
