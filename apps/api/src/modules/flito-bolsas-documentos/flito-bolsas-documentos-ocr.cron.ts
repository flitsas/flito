// HU #13890 (ADR-0028 D3/§8) — rescate del OCR del expediente de la compañía: retoma los documentos que
// llevan más de 3 min en `validando` (reinicio del proceso a mitad, motor caído o con 429). Primer barrido
// a los ~5 s del arranque y luego cada 5 min, con lock distribuido para que una sola réplica barra.
// Activo por defecto; `BOLSAS_DOCUMENTOS_OCR_CRON_ENABLED=0` lo apaga (no borra nada).
import os from 'os';
import { and, asc, eq, lt } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { flitoBolsasDocumentos } from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';
import { withLock } from '../../shared/utils/lock.js';
import { procesarOcr, type ResultadoOcr } from './flito-bolsas-documentos.ocr.js';

const log = loggerFor('flito-bolsas-documentos.ocr-cron');
const HOST_ID = `${os.hostname()}-${process.pid}`;
const INTERVAL_MS = 5 * 60_000;
const ARRANQUE_MS = 5_000;
const LOCK = 'flito-bolsas-docs-ocr';
const LOCK_TTL_MS = 4 * 60_000;
export const ANTIGUEDAD_RESCATE_MS = 3 * 60_000;
export const LOTE_RESCATE = 20;

const t = flitoBolsasDocumentos;
let timer: NodeJS.Timeout | null = null;
let arranque: NodeJS.Timeout | null = null;

export type ResumenRescate = Record<ResultadoOcr, number>;

/** Un barrido: hasta 20 documentos en `validando` de más de 3 min, de a uno (el limitador acota igual). */
export async function rescatarOcrPendientes(ahora: Date = new Date()): Promise<ResumenRescate> {
  const resumen: ResumenRescate = { leido: 0, sin_fecha: 0, reintentar: 0, fallido: 0, omitido: 0 };
  const corte = new Date(ahora.getTime() - ANTIGUEDAD_RESCATE_MS);
  const pendientes = await db.select({ id: t.id }).from(t)
    .where(and(eq(t.ocrEstado, 'validando'), lt(t.ocrActualizadoEn, corte)))
    .orderBy(asc(t.ocrActualizadoEn))
    .limit(LOTE_RESCATE);
  for (const { id } of pendientes) resumen[await procesarOcr(id)]++;
  return resumen;
}

async function tick(): Promise<void> {
  try {
    const r = await withLock(LOCK, LOCK_TTL_MS, () => rescatarOcrPendientes());
    if (r && Object.values(r).some((n) => n > 0)) log.info({ host: HOST_ID, ...r }, 'rescate de OCR de documentos');
  } catch (e) {
    log.error({ err: (e as Error)?.name }, 'rescate de OCR de documentos falló');
  }
}

export function startBolsasDocumentosOcrCron(): void {
  if (timer) return;
  if (process.env.BOLSAS_DOCUMENTOS_OCR_CRON_ENABLED === '0') {
    log.info({ host: HOST_ID }, 'cron de rescate de OCR de documentos DESHABILITADO');
    return;
  }
  log.info({ host: HOST_ID, intervalMin: INTERVAL_MS / 60_000 }, 'cron de rescate de OCR de documentos activo');
  arranque = setTimeout(() => { tick().catch(() => {}); }, ARRANQUE_MS);
  timer = setInterval(() => { tick().catch(() => {}); }, INTERVAL_MS);
}

export function stopBolsasDocumentosOcrCron(): void {
  if (arranque) { clearTimeout(arranque); arranque = null; }
  if (timer) { clearInterval(timer); timer = null; }
  log.info('cron de rescate de OCR de documentos detenido');
}
