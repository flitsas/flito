// HU #14132 (Feature #14013, ADR-0032) — el WORKER de la carga masiva: un `tick` reclama filas (concurrencia 2 por
// proceso, tope 2 por compañía en el reclamo), las procesa con el RUNT y, si el RUNT contesta 429, pausa el proceso
// con backoff 5 s → 60 s (el 429 no gasta intento de la fila). El mantenimiento (huérfanas, lotes vacíos, vigilante
// de 2 h) corre bajo candado para no repetirse en cada réplica.
//
// RN-MAS1  Un lote activo por compañía (índice de A1); el reclamo bloquea el lote con SKIP LOCKED: dos réplicas
//          con el worker encendido no duplican trabajo, se reparten el cupo.
// RN-MAS2  La llamada al RUNT va fuera de toda transacción.
// RN-MAS3  Al terminar el lote se anonimiza la PII de aceptadas y por validar (misma transacción).

import { loggerFor } from '../../shared/logger.js';
import { withLock } from '../../shared/utils/lock.js';
import {
  cerrarLoteSiTermino, cerrarLotesSinAvance, cerrarLotesSinPendientes, reclamarFilas, recuperarHuerfanas,
  type FilaReclamada,
} from './flito-soat-masivo-reclamo.js';
import { procesarFila, depsReales, type DepsFila, type ResultadoFila } from './flito-soat-masivo-procesar-fila.js';
import { siguienteBackoff } from './flito-soat-masivo-motivos.js';

const log = loggerFor('flito-soat-masivo-worker');

/** Filas simultáneas por proceso contra el RUNT. */
export const CONCURRENCIA_LOCAL = 2;
export const NOMBRE_LOCK_MANTENIMIENTO = 'soat-masivo-mant';
export const LOCK_TTL_MANTENIMIENTO_MS = 60_000;
/** El mantenimiento no necesita correr en cada tick. */
export const CADA_MANTENIMIENTO_MS = 30_000;

let backoffMs = 0;
let pausadoHasta = 0;
let enTick: Promise<void> | null = null;
let ultimoMantenimiento = 0;

/** Solo para tests. */
export function reiniciarEstadoWorker(): void { backoffMs = 0; pausadoHasta = 0; enTick = null; ultimoMantenimiento = 0; }
export const estadoBackoff = () => ({ backoffMs, pausadoHasta });

export async function mantenimientoMasivo(ahora: Date = new Date()): Promise<void> {
  const r = await withLock(NOMBRE_LOCK_MANTENIMIENTO, LOCK_TTL_MANTENIMIENTO_MS, async () => ({
    huerfanas: await recuperarHuerfanas(ahora),
    vacios: await cerrarLotesSinPendientes(ahora),
    vigilante: await cerrarLotesSinAvance(ahora),
  }));
  if (r && (r.huerfanas || r.vacios || r.vigilante)) log.info(r, 'carga masiva SOAT: mantenimiento');
}

/** Un ciclo: mantenimiento (si toca), reclamo, proceso de las filas reclamadas y cierre de los lotes tocados. */
export async function tickMasivo(deps: DepsFila = depsReales, ahora: Date = new Date()): Promise<ResultadoFila[]> {
  if (ahora.getTime() - ultimoMantenimiento >= CADA_MANTENIMIENTO_MS) {
    ultimoMantenimiento = ahora.getTime();
    await mantenimientoMasivo(ahora);
  }
  if (ahora.getTime() < pausadoHasta) return [];
  const filas: FilaReclamada[] = await reclamarFilas(CONCURRENCIA_LOCAL, ahora);
  if (filas.length === 0) return [];
  const resultados = await Promise.all(filas.map(async (f) => {
    const r = await procesarFila(f, deps);
    if (r === 'limite') {
      backoffMs = siguienteBackoff(backoffMs);
      pausadoHasta = Date.now() + backoffMs;
      log.warn({ loteId: f.loteId, pausaMs: backoffMs }, 'carga masiva SOAT: la pasarela contestó 429, el worker se pausa');
    } else if (backoffMs > 0) {
      backoffMs = 0; // el RUNT volvió a contestar
    }
    return r;
  }));
  for (const loteId of new Set(filas.map((f) => f.loteId))) await cerrarLoteSiTermino(loteId, new Date());
  return resultados;
}

/** Un solo tick a la vez por proceso. Devuelve la promesa en vuelo para poder drenar al apagar. */
export function correrTick(): Promise<void> {
  if (enTick) return enTick;
  enTick = tickMasivo().then(() => undefined).finally(() => { enTick = null; });
  return enTick;
}

/** SIGTERM: espera a que terminen las filas en vuelo (cada una es una llamada RUNT acotada). */
export async function drenarWorkerMasivo(): Promise<void> {
  if (enTick) await enTick.catch(() => undefined);
}

