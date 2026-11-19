// Contrato `ia-consumo` v1 (ADR-0047) — retención del detalle (prompt + respuesta) del consumo de IA.
// Molde: `flito-dr-flit/dr-flit.cron.ts`.
//
// RN-IAC1  Diaria, en la hora 04 de COLOMBIA (`relojBogota`), latido de 10 min y una corrida por día y proceso.
// RN-IAC2  Borra `ia_consumo_detalle` con `fecha_inicio < now() - IA_CONSUMO_DETALLE_DIAS`, por lotes de 5 000.
//          `ia_consumo_log` NO se toca: el contrato v1 no le fija retención (son metadatos sin contenido).
// RN-IAC3  Siempre activa, sin puerta positiva (a diferencia de RN-DRF3): el detalle es justo el dato que la
//          retención protege, y apagar `IA_CONSUMO_DETALLE` no debe dejar vivo lo ya escrito. Si no hay
//          detalle, la corrida no borra nada.
// RN-IAC4  Una sola instancia borra (`withLock`). Logs: solo conteos, corte y host.
import os from 'os';
import { inArray, lt } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { iaConsumoDetalle } from '../../db/schema/ia-consumo.js';
import { env } from '../../config/env.js';
import { loggerFor } from '../../shared/logger.js';
import { withLock } from '../../shared/utils/lock.js';
import { relojBogota } from '../flito-soat/flito-soat-retencion.cron.js';

const log = loggerFor('ia-consumo-retencion-cron');
const HOST_ID = `${os.hostname()}-${process.pid}`;

export const HORA_RETENCION_IA = 4;
export const LATIDO_RETENCION_IA_MS = 10 * 60_000;
export const LOTE_RETENCION_IA = 5000;
export const MAX_LOTES_RETENCION_IA = 200;
/** Cabe en `system_locks.lock_name` (50). */
export const NOMBRE_LOCK_RETENCION_IA = 'ia-consumo-retencion';
const LOCK_TTL_MS = 30 * 60_000;

export type ConexionRetencionIa = Pick<typeof db, 'select' | 'delete'>;

/** Borra el detalle más viejo que `dias`. Idempotente. Devuelve cuántas filas borró y el corte. */
export async function purgarDetalleIa(
  { ahora = new Date(), dias = env.IA_CONSUMO_DETALLE_DIAS, conexion = db as ConexionRetencionIa }: {
    ahora?: Date; dias?: number; conexion?: ConexionRetencionIa;
  } = {},
): Promise<{ borrados: number; corte: Date }> {
  const corte = new Date(ahora.getTime() - dias * 86_400_000);
  const t = iaConsumoDetalle;
  let borrados = 0;
  for (let lotes = 0; lotes < MAX_LOTES_RETENCION_IA; lotes++) {
    const candidatos = (await conexion.select({ id: t.consumoId }).from(t).where(lt(t.fechaInicio, corte)).limit(LOTE_RETENCION_IA))
      .map((f) => f.id);
    if (candidatos.length === 0) break;
    const filas = await conexion.delete(t).where(inArray(t.consumoId, candidatos)).returning({ id: t.consumoId });
    borrados += filas.length;
    if (candidatos.length < LOTE_RETENCION_IA) break;
  }
  return { borrados, corte };
}

let ultimoDia: string | null = null;
let enVuelo = false;

/** Solo para tests. */
export function reiniciarEstadoRetencionIa(): void { ultimoDia = null; enVuelo = false; }

export type ResultadoLatidoRetencionIa = 'fuera_de_ventana' | 'ya_corrio_hoy' | 'en_vuelo' | 'otra_instancia' | 'corrida' | 'fallo';

export async function latidoRetencionIa(ahora: Date = new Date()): Promise<ResultadoLatidoRetencionIa> {
  const { dia, hora } = relojBogota(ahora);
  if (hora !== HORA_RETENCION_IA) return 'fuera_de_ventana';
  if (ultimoDia === dia) return 'ya_corrio_hoy';
  if (enVuelo) return 'en_vuelo';
  enVuelo = true;
  try {
    const r = await withLock(NOMBRE_LOCK_RETENCION_IA, LOCK_TTL_MS, () => purgarDetalleIa({ ahora }));
    ultimoDia = dia;
    if (r === null) return 'otra_instancia';
    log.info({ host: HOST_ID, dia, borrados: r.borrados, corte: r.corte.toISOString(), dias: env.IA_CONSUMO_DETALLE_DIAS },
      'retención del detalle de consumo de IA: corrida completa');
    return 'corrida';
  } catch (e) {
    log.error({ host: HOST_ID, dia, err: e instanceof Error ? e.name : 'error' }, 'retención del detalle de consumo de IA: falló');
    return 'fallo';
  } finally {
    enVuelo = false;
  }
}

let timer: NodeJS.Timeout | null = null;

export function startIaConsumoRetencionCron(): void {
  if (timer) return;
  log.info({ host: HOST_ID, hora: HORA_RETENCION_IA, dias: env.IA_CONSUMO_DETALLE_DIAS }, 'retención del detalle de consumo de IA ACTIVA');
  timer = setInterval(() => {
    void latidoRetencionIa().catch(() => undefined);
  }, LATIDO_RETENCION_IA_MS);
  timer.unref();
}

export function stopIaConsumoRetencionCron(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
