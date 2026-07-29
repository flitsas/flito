// Barrido diario del Drive de la secretaría.
//
// DESHABILITADO salvo `DRIVE_DERECHOS_CRON_ENABLED=1`. La puerta es positiva a propósito, no un
// `NODE_ENV !== 'production'`: esto gasta OCR de pago, y con la lógica invertida basta un contenedor
// mal configurado o un script con `NODE_ENV=production` para disparar llamadas reales que nadie pidió.
// Que encenderlo cueste una línea explícita en el `.env` de producción es la fricción que se quiere.
// Mismo patrón que `privacy/retention.cron.ts`.
//
// El PRIMER barrido no procesa: da por visto lo que ya estaba en la carpeta. La razón está en
// `barrerDrive`.

import os from 'os';
import { env } from '../../config/env.js';
import { loggerFor } from '../../shared/logger.js';
import { barrerDrive } from './flito-derechos-drive.service.js';

const log = loggerFor('flito-derechos-drive-cron');
const HOST_ID = `${os.hostname()}-${process.pid}`;

/**
 * Cada cuánto se mira el reloj. No es la frecuencia del barrido: el barrido es UNA vez al día, a la
 * hora configurada. Diez minutos da margen de sobra para no perder la ventana si el proceso estaba
 * ocupado, sin consultar la hora cada segundo.
 */
const LATIDO_MS = 10 * 60_000;

/** Zona del negocio. Se resuelve con Intl y no con la del contenedor, que en Docker es UTC. */
const ZONA = 'America/Bogota';

/**
 * Quién ejecuta el barrido. No hay usuario humano detrás, así que se firma como el sistema: los
 * derechos que registre quedarán con este `usuarioId` en la auditoría, y `origen: 'drive'` ya
 * distingue la vía.
 */
const CTX_CRON = { userId: null as unknown as number, username: 'cron:drive-derechos', role: 'admin' };

let timer: NodeJS.Timeout | null = null;
/** Último día (en Bogotá) en que ya se barrió, para no repetir dentro de la misma ventana. */
let ultimoDia: string | null = null;

/** Fecha y hora en Bogotá, sin depender de la zona del proceso. */
function ahoraEnBogota(): { dia: string; hora: number } {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const v = (t: string) => partes.find((p) => p.type === t)?.value ?? '';
  return { dia: `${v('year')}-${v('month')}-${v('day')}`, hora: Number(v('hour')) };
}

async function latido(horaObjetivo: number): Promise<void> {
  const { dia, hora } = ahoraEnBogota();
  if (hora !== horaObjetivo || ultimoDia === dia) return;

  // Se marca ANTES de barrer: si el barrido tarda más que el latido, no se solapa consigo mismo.
  ultimoDia = dia;
  try {
    const r = await barrerDrive(CTX_CRON as never);
    log.info({ host: HOST_ID, dia, ...r, procesados: r.procesados.length }, 'barrido diario del Drive');
  } catch (e) {
    log.error({ host: HOST_ID, dia, err: (e as Error)?.message }, 'barrido diario del Drive falló');
  }
}

export function startDerechosDriveCron(): void {
  if (timer) return;

  if (!env.DRIVE_DERECHOS_CRON_ENABLED) {
    log.info({ host: HOST_ID }, 'barrido del Drive DESHABILITADO (DRIVE_DERECHOS_CRON_ENABLED!=1)');
    return;
  }
  if (!env.GOOGLE_DRIVE_KEY_PATH || !env.GOOGLE_DRIVE_FOLDER_ID) {
    log.warn({ host: HOST_ID }, 'barrido del Drive encendido pero sin credencial o carpeta: no arranca');
    return;
  }

  const horaObjetivo = env.DRIVE_DERECHOS_CRON_HORA;
  log.info({ host: HOST_ID, horaObjetivo, zona: ZONA }, 'barrido del Drive ACTIVO');

  // Nota para cuando haya más de una instancia de API: hoy no hay lock. Dos contenedores mirarían el
  // reloj a la vez y barrerían el mismo archivo; el hash del recibo evita registrar duplicados, pero
  // el OCR se pagaría dos veces. Si se escala, esto necesita un lock en Redis.
  timer = setInterval(() => { latido(horaObjetivo).catch(() => { /* ya se registra dentro */ }); }, LATIDO_MS);
}

export function stopDerechosDriveCron(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
