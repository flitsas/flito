// FLITO SOAT — retención de los archivos de las solicitudes por validar DESCARTADAS: la
// PROGRAMACIÓN de la corrida diaria (HU #13409, Feature #13408, Épica #13201). El recorrido vive en
// `flito-soat-retencion.service.ts`; la política, también en `docs/privacy/retencion-flito-soat.md`.
//
// ── Reglas de negocio ────────────────────────────────────────────────────────────────────────────
//
// RN-RET1  Retención de 30 días desde el descarte (Ley 1581 de 2012, art. 4 lit. d y art. 11
//          —principio de finalidad y supresión—; Decreto 1377 de 2013 art. 11: los datos se
//          conservan solo el tiempo necesario para la finalidad que justificó su tratamiento).
//
//          Una solicitud de SOAT por validar (`flito_soat_incompletas`) que se DESCARTA no llega a
//          ser un SOAT: su factura de venta y sus documentos adicionales ya no tienen finalidad. Al
//          cumplir 30 × 24 h desde el descarte (`resuelta_en <= ahora − 30 días`, frontera
//          inclusiva), la corrida diaria:
//
//          · BORRA del almacenamiento el objeto de la factura de venta (`factura_storage_key`) y los
//            objetos de sus documentos adicionales (`flito_soportes` con `soat_incompleta_id`,
//            `soat_id` NULL y tipo `documento_adicional_soat`), y las FILAS de esos adicionales;
//          · CONSERVA la fila de la solicitud: estado `descartada`, motivo, cuándo y quién descartó
//            (constancia de la decisión, sin el archivo), y marca `archivos_purgados_en` con el
//            instante de la corrida. `factura_storage_key` queda como dato histórico (NOT NULL);
//          · deja UNA entrada en la Bitácora (`soat.incompleta.archivos_purgados`, usuario sistema)
//            con el id de la solicitud, cuántos archivos y cuántos bytes; sin VIN, nombres, nombres
//            de archivo ni claves de almacenamiento.
//
//          NUNCA toca: solicitudes en estado `incompleta` ni `completada`, ni un documento adicional
//          que cuelgue de un SOAT creado (`soat_id` no nulo). Un fallo del almacenamiento no da nada
//          por borrado: la fila del adicional que no se borró se queda y la marca sigue NULL hasta
//          que la corrida siguiente complete lo que falta. «El objeto no existe» cuenta como borrado.
//
// RN-RET2  Hora de COLOMBIA (03:00–03:59, `America/Bogota` vía `Intl`), no la del contenedor (UTC):
//          mismo mecanismo que `flito-soat-vigencia.cron.ts`. Una vez al día por proceso; un
//          reinicio dentro de la hora puede repetirla, y es inocuo porque la purga es idempotente
//          (una solicitud marcada no vuelve a leerse).
//
// RN-RET3  Puerta POSITIVA: sin `SOAT_RETENCION_CRON_ENABLED=1` no arranca y lo dice en el log, como
//          `PRIVACY_RETENTION_CRON_ENABLED` y `COMPARENDOS_PURGA_CRON_ENABLED`: un job que BORRA no
//          se enciende por desplegarse.
//
// RN-RET4  Un solo servidor: la corrida va entera dentro de `withLock`; la instancia que no obtiene
//          el candado lo registra y termina sin leer nada. Lotes acotados (`LOTE_RETENCION`) por
//          corrida: el atraso de un primer encendido se drena en días, no en una corrida eterna.
//
// Logs: solo conteos, host, día y nombre del error. Ningún identificador de persona ni clave.

import os from 'os';
import { env } from '../../config/env.js';
import { loggerFor } from '../../shared/logger.js';
import { withLock } from '../../shared/utils/lock.js';
import { DIAS_RETENCION, LOTE_RETENCION, ejecutarPurgaRetencion } from './flito-soat-retencion.service.js';

const log = loggerFor('flito-soat-retencion-cron');
const HOST_ID = `${os.hostname()}-${process.pid}`;
const ZONA = 'America/Bogota';

/** Hora de Colombia de la corrida (RN-RET2). */
export const HORA_RETENCION = 3;
/** Latido: granulado con el que se detecta la ventana, no la frecuencia (una al día). */
export const LATIDO_RETENCION_MS = 10 * 60_000;
/** Candado (RN-RET4). Cabe en `system_locks.lock_name` (50). */
export const NOMBRE_LOCK_RETENCION = 'flito-soat-retencion';
/** TTL del candado: menor que la ventana de una hora, mayor que una corrida de un lote. */
export const LOCK_TTL_RETENCION_MS = 30 * 60_000;

/** Día y hora en Bogotá, sin depender de la zona del proceso. */
export function relojBogota(ahora: Date): { dia: string; hora: number } {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(ahora);
  const v = (t: string) => partes.find((p) => p.type === t)?.value ?? '';
  return { dia: `${v('year')}-${v('month')}-${v('day')}`, hora: Number(v('hour')) % 24 };
}

function nombreDeError(e: unknown): string {
  return e instanceof Error && e.name ? e.name : 'error';
}

let ultimoDia: string | null = null;
let enVuelo = false;

/** Solo para tests: olvida el día corrido. */
export function reiniciarEstadoRetencion(): void { ultimoDia = null; enVuelo = false; }

export type ResultadoLatido = 'fuera_de_ventana' | 'ya_corrio_hoy' | 'en_vuelo' | 'otra_instancia' | 'corrida' | 'fallo';

/**
 * Un latido. Exportado para ejercer la programación sin `setInterval`.
 * @param ahora Instante a evaluar; por defecto, el real.
 */
export async function latidoRetencionSoat(ahora: Date = new Date()): Promise<ResultadoLatido> {
  const { dia, hora } = relojBogota(ahora);
  if (hora !== HORA_RETENCION) return 'fuera_de_ventana';
  if (ultimoDia === dia) return 'ya_corrio_hoy';
  if (enVuelo) return 'en_vuelo';

  enVuelo = true;
  try {
    const r = await withLock(NOMBRE_LOCK_RETENCION, LOCK_TTL_RETENCION_MS, () => ejecutarPurgaRetencion({ ahora }));
    // El día queda corrido también si otra instancia tenía el candado: la corrida de hoy es suya.
    ultimoDia = dia;
    if (r === null) {
      log.info({ host: HOST_ID, dia, lock: NOMBRE_LOCK_RETENCION },
        'otra instancia tiene la retención del SOAT: esta no purga nada');
      return 'otra_instancia';
    }
    const datos = { host: HOST_ID, dia, ...r };
    if (r.conPendientes > 0) {
      log.warn(datos, 'retención del SOAT: quedaron solicitudes con archivos pendientes; se reintentan mañana');
    } else {
      log.info(datos, 'retención del SOAT: corrida completa');
    }
    return 'corrida';
  } catch (e) {
    // Sin marcar el día: el latido siguiente de la misma hora lo reintenta.
    log.error({ host: HOST_ID, dia, err: nombreDeError(e) }, 'retención del SOAT: la corrida falló');
    return 'fallo';
  } finally {
    enVuelo = false;
  }
}

let timer: NodeJS.Timeout | null = null;

/** Arranca el cron. Noop —y lo dice en el log— si la puerta de RN-RET3 está cerrada. */
export function startSoatRetencionCron(): void {
  if (timer) return;
  if (!env.SOAT_RETENCION_CRON_ENABLED) {
    log.info({ host: HOST_ID },
      'retención de archivos del SOAT descartado DESHABILITADA (SOAT_RETENCION_CRON_ENABLED!=1)');
    return;
  }
  log.info({
    host: HOST_ID, zona: ZONA, hora: HORA_RETENCION, dias: DIAS_RETENCION, lote: LOTE_RETENCION,
  }, 'retención de archivos del SOAT descartado ACTIVA');
  timer = setInterval(() => {
    void latidoRetencionSoat().catch((e) => log.error({ host: HOST_ID, err: nombreDeError(e) }, 'latido de retención del SOAT'));
  }, LATIDO_RETENCION_MS);
  timer.unref();
}

export function stopSoatRetencionCron(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    log.info({ host: HOST_ID }, 'retención de archivos del SOAT detenida');
  }
}
