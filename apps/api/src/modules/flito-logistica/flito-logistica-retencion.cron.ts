// FLITO Logística — retención de la cédula a 10 años: la PROGRAMACIÓN de la corrida diaria
// (HU #14113, Feature #14091, Épica #13758, ADR-0030 C8b / Q6 / N6). El recorrido vive en
// `flito-logistica-retencion.service.ts`; la política, también en
// `docs/privacy/retencion-flito-logistica.md`.
//
// ── Reglas de negocio ────────────────────────────────────────────────────────────────────────────
//
// RN-RET1  Retención de 10 años desde la entrega (Ley 1581 de 2012, art. 4 lit. d y art. 11
//          —principio de finalidad y supresión—; Decreto 1377 de 2013 art. 11: los datos se
//          conservan solo el tiempo necesario para la finalidad que justificó su tratamiento).
//
//          La cédula del firmante (receptor, contacto de entrega u organismo de tránsito) se trata
//          para identificar a quien firma el acta. Al cumplir 10 años desde la entrega
//          (`firmado_en <= ahora − 10 años`, frontera inclusiva), la corrida diaria:
//
//          · BORRA solo la cédula: `documento_cifrado` y `documento_ultimos` → NULL, en
//            `flito_logistica_acta_firmas` y en `flito_logistica_recogida_firmantes`;
//          · CONSERVA la fila, `nombre` y `firma_storage_key` (constancia de que el acta se firmó).
//            El PDF del acta ya pinta «—» cuando la cédula no está (C1.5).
//
//          NUNCA toca una firma con menos de 10 años ni una fila cuya cédula ya está en NULL.
//
// RN-RET2  Hora de COLOMBIA (03:00–03:59, `America/Bogota` vía `Intl`), no la del contenedor (UTC):
//          mismo mecanismo que `flito-soat-retencion.cron.ts`. Una vez al día por proceso; un
//          reinicio dentro de la hora puede repetirla, y es inocuo porque la purga es idempotente
//          (una fila sin cédula no vuelve a actualizarse).
//
// RN-RET3  Puerta POSITIVA: sin `LOGISTICA_RETENCION_CRON_ENABLED=1` no arranca y lo dice en el log,
//          como `SOAT_RETENCION_CRON_ENABLED` y `PRIVACY_RETENTION_CRON_ENABLED`: un job que BORRA
//          no se enciende por desplegarse.
//
// RN-RET4  Un solo servidor: la corrida va entera dentro de `withLock`; la instancia que no obtiene
//          el candado lo registra y termina sin leer nada.
//
// Logs: solo conteos, host, día y cutoff. Ninguna cédula ni nombre.

import os from 'os';
import { env } from '../../config/env.js';
import { loggerFor } from '../../shared/logger.js';
import { withLock } from '../../shared/utils/lock.js';
import {
  ANIOS_RETENCION, corteRetencion, ejecutarPurgaRetencionLogistica,
} from './flito-logistica-retencion.service.js';

const log = loggerFor('flito-logistica-retencion-cron');
const HOST_ID = `${os.hostname()}-${process.pid}`;
const ZONA = 'America/Bogota';

/** Hora de Colombia de la corrida (RN-RET2). */
export const HORA_RETENCION = 3;
/** Latido: granulado con el que se detecta la ventana, no la frecuencia (una al día). */
export const LATIDO_RETENCION_MS = 10 * 60_000;
/** Candado (RN-RET4). Cabe en `system_locks.lock_name` (50). */
export const NOMBRE_LOCK_RETENCION = 'flito-logistica-retencion';
/** TTL del candado: menor que la ventana de una hora, mayor que una corrida. */
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
export async function latidoRetencionLogistica(ahora: Date = new Date()): Promise<ResultadoLatido> {
  const { dia, hora } = relojBogota(ahora);
  if (hora !== HORA_RETENCION) return 'fuera_de_ventana';
  if (ultimoDia === dia) return 'ya_corrio_hoy';
  if (enVuelo) return 'en_vuelo';

  enVuelo = true;
  try {
    const r = await withLock(NOMBRE_LOCK_RETENCION, LOCK_TTL_RETENCION_MS, () =>
      ejecutarPurgaRetencionLogistica({ ahora }));
    // El día queda corrido también si otra instancia tenía el candado: la corrida de hoy es suya.
    ultimoDia = dia;
    if (r === null) {
      log.info({ host: HOST_ID, dia, lock: NOMBRE_LOCK_RETENCION },
        'otra instancia tiene la retención de logística: esta no purga nada');
      return 'otra_instancia';
    }
    log.info({
      host: HOST_ID, dia, cutoff: corteRetencion(ahora).toISOString(), ...r,
    }, 'retención de cédula de logística: corrida completa');
    return 'corrida';
  } catch (e) {
    // Sin marcar el día: el latido siguiente de la misma hora lo reintenta.
    log.error({ host: HOST_ID, dia, err: nombreDeError(e) }, 'retención de logística: la corrida falló');
    return 'fallo';
  } finally {
    enVuelo = false;
  }
}

let timer: NodeJS.Timeout | null = null;

/** Arranca el cron. Noop —y lo dice en el log— si la puerta de RN-RET3 está cerrada. */
export function startLogisticaRetencionCron(): void {
  if (timer) return;
  if (!env.LOGISTICA_RETENCION_CRON_ENABLED) {
    log.info({ host: HOST_ID },
      'retención de cédula de logística DESHABILITADA (LOGISTICA_RETENCION_CRON_ENABLED!=1)');
    return;
  }
  log.info({
    host: HOST_ID, zona: ZONA, hora: HORA_RETENCION, anios: ANIOS_RETENCION,
  }, 'retención de cédula de logística ACTIVA');
  timer = setInterval(() => {
    void latidoRetencionLogistica().catch((e) =>
      log.error({ host: HOST_ID, err: nombreDeError(e) }, 'latido de retención de logística'));
  }, LATIDO_RETENCION_MS);
  timer.unref();
}

export function stopLogisticaRetencionCron(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    log.info({ host: HOST_ID }, 'retención de cédula de logística detenida');
  }
}
