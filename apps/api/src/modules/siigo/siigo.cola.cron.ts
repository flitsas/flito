// Siigo — ciclo periódico que vacía la cola de emisión (HU #11327, Feature #11242).
//
// Todo lo que decide qué se emite, qué se reintenta y qué se da por perdido vive en
// `facturacion.trabajador.service.ts`. Aquí solo está lo que un proceso periódico tiene que
// resolver: cada cuánto corre, quién lo corre cuando hay varias instancias, y qué pasa si muere a
// medias.
//
// **HAY DOS EXCLUSIONES Y NO SOBRA NINGUNA.** El cerrojo protege el CICLO: impide que tres
// instancias hagan a la vez el barrido de huérfanas y la medición del freno, que son trabajo
// compartido y no reparten nada. El arrendamiento de la cola protege la FILA, y esa es la del AC6:
// sin él, dos instancias que corrieran a la vez —porque el cerrojo venció, porque el reloj de una va
// atrasado— tomarían las mismas filas. El cerrojo no puede garantizarlo, porque un cerrojo con TTL
// siempre se puede perder; el `FOR UPDATE SKIP LOCKED` de la sentencia que toma y marca, sí.

import os from 'os';
import { env } from '../../config/env.js';
import { SIIGO_COLA_LOTE_DEFECTO } from '@operaciones/shared-types';
import { withLock } from '../../shared/utils/lock.js';
import { loggerFor } from '../../shared/logger.js';
import { procesarCicloEmision } from './facturacion.trabajador.service.js';

const log = loggerFor('siigo.cola.cron');
const HOST_ID = `${os.hostname()}-${process.pid}`;

/** Nombre del cerrojo. Uno para todo el despliegue: lo que se protege es la cuota compartida. */
export const NOMBRE_CERROJO = 'siigo-cola-emision-cron';

/**
 * Cada dos minutos. Mayor que `VENTANA_MS` (60 s) a propósito: así el ciclo entero cabe dentro de una
 * ventana del limitador y el siguiente arranca con la ventana ya vacía, sin heredar la cuota gastada.
 */
const INTERVAL_MS = 2 * 60_000;

/** TTL por debajo del intervalo: un ciclo caído lo pierde por vencimiento y el siguiente puede correr. */
const LOCK_TTL_MS = 5 * 60_000;

/**
 * Hasta cuándo puede trabajar un ciclo. **El TTL corto solo protege si el ciclo termina antes.**
 *
 * El ciclo no dura lo que dura el TTL: dura lo que tarden las peticiones. Con reintentos, un timeout
 * de emisión de 120 s y un limitador que DUERME cuando la ventana está llena, una sola factura puede
 * costar minutos. Al vencer el cerrojo, el tick siguiente lo readquiere y arranca un segundo ciclo
 * mientras el primero sigue vivo — y aunque el arrendamiento de la cola impide que se pisen las
 * filas, serían dos ciclos gastando la misma cuota. Así que el ciclo se rinde antes de perderlo. Lo
 * que no le dio tiempo a mirar se libera y sale primero en el siguiente.
 */
const PLAZO_DEL_CICLO_MS = Math.floor(LOCK_TTL_MS * 0.5);

/** Arranque diferido: al levantar el proceso hay cosas más urgentes que emitir facturas. */
const RETRASO_INICIAL_MS = 60_000;

/**
 * Cuántas filas de la cola procesa cada ciclo del trabajador de emisión (HU #11327).
 *
 * Era `SIIGO_COLA_LOTE` y dejó de ser variable de entorno en el Bug #11649: el número no depende
 * del despliegue, depende de la cuota de Siigo, que es la misma en todos los ambientes. Su
 * justificación viaja con él, literal, porque sin ella nadie puede cambiarlo con criterio:
 *
 *   El defecto (15) sale de una cuenta, no de un gusto: peor caso ≈ 6 peticiones por fila (los 4
 *   intentos de `ejecutarConResiliencia` más el margen del tercero) ≈ 90 < las 100 por minuto que
 *   permite Siigo, y el ciclo corre cada 2 min > la ventana de 60 s. El tope de 60 es el punto en
 *   que un ciclo empezaría a hacer dormir al limitador y a comerse la cuota del sondeo DIAN.
 *
 * Ese «tope de 60» era el `max(60)` del esquema zod, que ya no hace falta: no queda ningún valor
 * de fuera que validar. Sigue siendo el techo que no se debe cruzar al editar esta línea.
 */
const LOTE = SIIGO_COLA_LOTE_DEFECTO;

/**
 * Guarda de reentrada dentro del proceso.
 *
 * `setInterval` no espera a que la ejecución anterior termine: si un ciclo se alarga, el siguiente
 * arranca encima. El cerrojo distribuido no lo ve —es el MISMO proceso, y `withLock` daría el
 * cerrojo por ajeno o vencido—, así que esta bandera es la única que cubre ese caso.
 */
let enCurso = false;

/**
 * Apagado limpio (AC7). Se levanta en `stop` y el trabajador la consulta antes de cada fila.
 *
 * Lo que ya está tomado se libera en vez de quedarse arrendado veinte minutos, así que la instancia
 * que quede viva puede seguir con esas filas de inmediato. Un ciclo que se corta no pierde trabajo:
 * las citas están escritas en la tabla.
 */
let detenido = false;

async function tick(): Promise<void> {
  if (enCurso) {
    log.debug({ host: HOST_ID }, 'ciclo anterior todavía en curso; se salta este');
    return;
  }
  enCurso = true;
  try {
    const r = await withLock(NOMBRE_CERROJO, LOCK_TTL_MS, () => procesarCicloEmision({
      ambiente: env.SIIGO_AMBIENTE,
      plazoMs: PLAZO_DEL_CICLO_MS,
      lote: LOTE,
      debeDetenerse: () => detenido,
    }));
    // `null` = otra instancia lo está corriendo. No es un fallo y no se registra como tal: en un
    // despliegue de tres instancias, dos de cada tres ciclos terminan así por diseño.
    if (r && (r.tomadas > 0 || r.reconciliadas > 0 || r.frenada || r.circuitoAbierto)) {
      log.info({ host: HOST_ID, ...r }, 'ciclo de emisión de la cola');
    }
  } catch (e) {
    log.error({ err: e instanceof Error ? e.message : e }, 'ciclo de emisión de la cola falló');
  } finally {
    enCurso = false;
  }
}

let timer: NodeJS.Timeout | null = null;

export function startSiigoColaCron(): void {
  if (timer) return;
  // Bug #11649: apagado por defecto y leído del esquema validado, nunca de `process.env`. La guarda
  // anterior (`SIIGO_COLA_CRON_ENABLED !== '0'`) dejaba el cron encendido ante cualquier valor que
  // no fuera esa cadena exacta, la variable ausente incluida — y este ciclo emite ante la DIAN.
  if (env.SIIGO_CRONS !== 'on') {
    log.info({ host: HOST_ID, siigoCrons: env.SIIGO_CRONS }, 'cron de emisión de la cola DESHABILITADO');
    return;
  }
  detenido = false;
  log.info(
    {
      host: HOST_ID,
      intervalMin: INTERVAL_MS / 60_000,
      lockTtlMin: LOCK_TTL_MS / 60_000,
      lote: LOTE,
      ambiente: env.SIIGO_AMBIENTE,
    },
    'cron de emisión de la cola activo',
  );
  setTimeout(() => { tick().catch(() => {}); }, RETRASO_INICIAL_MS).unref();
  timer = setInterval(() => { tick().catch(() => {}); }, INTERVAL_MS);
  timer.unref();
}

export function stopSiigoColaCron(): void {
  // La bandera ANTES de parar el temporizador: si hay un ciclo en vuelo, lo que se necesita es que
  // se entere ya, no que no vuelva a arrancar dentro de dos minutos.
  detenido = true;
  if (timer) { clearInterval(timer); timer = null; }
  log.info('cron de emisión de la cola detenido');
}
