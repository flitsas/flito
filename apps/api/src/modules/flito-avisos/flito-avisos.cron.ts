// FLITO avisos — PROGRAMACIÓN de la purga diaria (Épica #14707, ADR-0049 §7; RN-AV4 en `flito-avisos.service.ts`).
// Patrón de `flito-soat/flito-soat-retencion.cron.ts`:
//
//   · Hora de COLOMBIA (04:00–04:59, `America/Bogota` vía `Intl`), no la del contenedor; una vez al día por proceso.
//     Un reinicio dentro de la hora puede repetirla y es inocuo: la purga es idempotente.
//   · Un solo servidor: la corrida va dentro de `withLock`; la instancia sin candado lo registra y no borra nada.
//   · Sin puerta por variable de entorno (a diferencia de la retención de archivos del SOAT): el aviso solo guarda
//     referencias, la política 90/180 días es la del ADR y no hay archivo ni dato del titular que perder.
//
// Logs: conteos, host, día y nombre del error. Ningún identificador de persona ni placa.
import os from 'os';
import { loggerFor } from '../../shared/logger.js';
import { withLock } from '../../shared/utils/lock.js';
import { DIAS_PURGA_NO_VISTOS, DIAS_PURGA_VISTOS, purgarAvisos } from './flito-avisos.service.js';

const log = loggerFor('flito-avisos-purga-cron');
const HOST_ID = `${os.hostname()}-${process.pid}`;

export const HORA_PURGA_AVISOS = 4;
export const LATIDO_PURGA_AVISOS_MS = 10 * 60_000;
export const NOMBRE_LOCK_PURGA_AVISOS = 'flito-avisos-purga';
export const LOCK_TTL_PURGA_AVISOS_MS = 30 * 60_000;

const ZONA = 'America/Bogota';

/** Día y hora en Bogotá, sin depender de la zona del proceso (mismo cálculo que la retención del SOAT). */
export function relojBogota(ahora: Date): { dia: string; hora: number } {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(ahora);
  const v = (t: string) => partes.find((p) => p.type === t)?.value ?? '';
  return { dia: `${v('year')}-${v('month')}-${v('day')}`, hora: Number(v('hour')) % 24 };
}

const nombreDeError = (e: unknown): string => (e instanceof Error && e.name ? e.name : 'error');

let ultimoDia: string | null = null;
let enVuelo = false;

/** Solo para tests: olvida el día corrido. */
export function reiniciarEstadoPurgaAvisos(): void { ultimoDia = null; enVuelo = false; }

export type ResultadoLatidoAvisos = 'fuera_de_ventana' | 'ya_corrio_hoy' | 'en_vuelo' | 'otra_instancia' | 'corrida' | 'fallo';

/** Un latido. Exportado para ejercer la programación sin `setInterval`. */
export async function latidoPurgaAvisos(ahora: Date = new Date()): Promise<ResultadoLatidoAvisos> {
  const { dia, hora } = relojBogota(ahora);
  if (hora !== HORA_PURGA_AVISOS) return 'fuera_de_ventana';
  if (ultimoDia === dia) return 'ya_corrio_hoy';
  if (enVuelo) return 'en_vuelo';

  enVuelo = true;
  try {
    const r = await withLock(NOMBRE_LOCK_PURGA_AVISOS, LOCK_TTL_PURGA_AVISOS_MS, () => purgarAvisos({ ahora }));
    ultimoDia = dia;
    if (r === null) {
      log.info({ host: HOST_ID, dia, lock: NOMBRE_LOCK_PURGA_AVISOS }, 'otra instancia tiene la purga de avisos: esta no borra nada');
      return 'otra_instancia';
    }
    log.info({ host: HOST_ID, dia, ...r }, 'purga de avisos: corrida completa');
    return 'corrida';
  } catch (e) {
    // Sin marcar el día: el latido siguiente de la misma hora lo reintenta.
    log.error({ host: HOST_ID, dia, err: nombreDeError(e) }, 'purga de avisos: la corrida falló');
    return 'fallo';
  } finally {
    enVuelo = false;
  }
}

let timer: NodeJS.Timeout | null = null;

export function startAvisosPurgaCron(): void {
  if (timer) return;
  log.info({ host: HOST_ID, hora: HORA_PURGA_AVISOS, vistos: DIAS_PURGA_VISTOS, noVistos: DIAS_PURGA_NO_VISTOS },
    'purga de avisos por usuario ACTIVA');
  timer = setInterval(() => {
    void latidoPurgaAvisos().catch((e) => log.error({ host: HOST_ID, err: nombreDeError(e) }, 'latido de la purga de avisos'));
  }, LATIDO_PURGA_AVISOS_MS);
  timer.unref();
}

export function stopAvisosPurgaCron(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    log.info({ host: HOST_ID }, 'purga de avisos detenida');
  }
}
