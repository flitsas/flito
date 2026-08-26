// Siigo — barrido que archiva el PDF y el XML de las facturas aceptadas (HU #11335).
//
// Existe por el AC2: la DIAN no acepta la factura en el mismo instante en que se emite, así que en
// el momento de emitir no hay nada que descargar. Sin un ciclo que vuelva a mirar, archivar exigiría
// que alguien se acordara de pedirlo, y «se archivó lo que alguien se acordó de archivar» no es una
// política de conservación de soportes.
//
// El mismo ciclo cubre el AC5: una factura que quedó a medias —el PDF sí, el XML no— vuelve a salir
// en la selección del siguiente barrido, porque la consulta pregunta por lo que FALTA, no por lo que
// se intentó. No hay cola de reintentos que mantener ni contador que reponer.
//
// Ritmo deliberadamente lento. Cada factura cuesta hasta dos peticiones de la ventana de 100 por
// minuto que comparte con la EMISIÓN, y archivar puede esperar diez minutos; emitir, no.

import os from 'os';
import { env } from '../../config/env.js';
import { archivarFacturasPendientes } from './siigo.archivo-documentos.service.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('siigo.archivo.cron');
const HOST_ID = `${os.hostname()}-${process.pid}`;
const INTERVAL_MS = 10 * 60_000;
/** Arranque diferido: al levantar el proceso hay cosas más urgentes que bajar PDFs. */
const RETRASO_INICIAL_MS = 90_000;

let timer: NodeJS.Timeout | null = null;

async function tick(): Promise<void> {
  try {
    const r = await archivarFacturasPendientes();
    if (r.revisadas > 0) log.info({ host: HOST_ID, ...r }, 'barrido de archivo de facturas');
  } catch (e) {
    log.error({ err: e instanceof Error ? e.message : e }, 'barrido de archivo de facturas falló');
  }
}

export function startSiigoArchivoCron(): void {
  if (timer) return;
  // Bug #11649: apagado por defecto y leído del esquema validado, nunca de `process.env`. La guarda
  // anterior (`SIIGO_ARCHIVO_CRON_ENABLED !== '0'`) dejaba el cron encendido ante cualquier valor
  // que no fuera esa cadena exacta, la variable ausente o mal escrita incluidas.
  if (env.SIIGO_CRONS !== 'on') {
    log.info({ host: HOST_ID, siigoCrons: env.SIIGO_CRONS }, 'cron de archivo de facturas DESHABILITADO');
    return;
  }
  log.info({ host: HOST_ID, intervalMin: INTERVAL_MS / 60_000 }, 'cron de archivo de facturas activo');
  setTimeout(() => { tick().catch(() => {}); }, RETRASO_INICIAL_MS);
  timer = setInterval(() => { tick().catch(() => {}); }, INTERVAL_MS);
}

export function stopSiigoArchivoCron(): void {
  if (timer) { clearInterval(timer); timer = null; }
  log.info('cron de archivo de facturas detenido');
}
