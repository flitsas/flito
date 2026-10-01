// FLITO sync — interruptor por fuente de la sincronización FLIT (HU #13237, Feature #13236, Épica #12736).
// Diseño: `docs/diseno/hu-13237-interruptor-sincronizacion.md`. Tabla `flito_sync_interruptor` (0217).
//
// ── Reglas de negocio ────────────────────────────────────────────────────────────────────────────
//
// RN-01  Una fila por fuente (`flit1`, `flit2`), sembrada encendida. Propia de cada ambiente: vive en la
//        base, así que sobrevive a reinicios y despliegues (AC2).
// RN-02  Fila ausente = encendida (fail-open, coherente con la siembra) y se registra un `warn` sin PII.
//        Un ERROR de base al leer no se traga: se propaga (la corrida o la petición fallan como tales).
// RN-03  Sin caché: se lee por PK en cada guarda. Una caché alargaría la ventana del apagado a mitad de
//        lectura (AC7) y con PM2 en cluster no se invalidaría entre procesos.
// RN-04  FLIT 2 tiene además el maestro del ambiente (`FLIT2_SYNC_CRON`). Con el maestro en false la
//        fuente está deshabilitada por `maestro`, que gana sobre `interruptor` (AC8, AC9). El maestro no
//        se escribe aquí: es una variable de despliegue.
// RN-05  Guardar (PUT) lee el valor anterior con `FOR UPDATE` y escribe en la misma transacción: dos PUT
//        a la vez se serializan y cada uno conoce su par anterior/nuevo para la auditoría (AC10).
//        Guardar el mismo valor también escribe (quién y cuándo) y también se audita.

import { eq } from 'drizzle-orm';
import type {
  EstadoHabilitacionFuente, FuenteSincronizacion, InterruptorFuente, InterruptoresSincronizacion,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoSyncInterruptor, users } from '../../db/schema.js';
import { env } from '../../config/env.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('flito-sync-interruptor');

/** Orden fijo de la respuesta del GET. */
export const FUENTES_SINCRONIZACION: readonly FuenteSincronizacion[] = ['flit1', 'flit2'];

export const esFuenteSincronizacion = (v: unknown): v is FuenteSincronizacion =>
  typeof v === 'string' && (FUENTES_SINCRONIZACION as readonly string[]).includes(v);

const NOMBRE_FUENTE: Record<FuenteSincronizacion, string> = { flit1: 'FLIT 1', flit2: 'FLIT 2' };

/** La fuente está apagada en este ambiente (AC5, AC6). 409 con `codigo: 'FUENTE_APAGADA'` (literal del AC5). */
export class FuenteApagadaError extends Error {
  readonly codigo = 'FUENTE_APAGADA' as const;
  readonly status = 409;
  constructor(readonly fuente: FuenteSincronizacion) {
    super(`La sincronización con ${NOMBRE_FUENTE[fuente]} está apagada en este ambiente.`);
    this.name = 'FuenteApagadaError';
  }
}

/** ¿Está encendido el interruptor de la fuente? (RN-02, RN-03). No mira el maestro. */
export async function fuenteHabilitada(fuente: FuenteSincronizacion): Promise<boolean> {
  const [fila] = await db.select({ encendido: flitoSyncInterruptor.encendido })
    .from(flitoSyncInterruptor).where(eq(flitoSyncInterruptor.fuente, fuente)).limit(1);
  if (!fila) {
    log.warn({ fuente }, 'interruptor de sincronización sin fila: se trata como encendido');
    return true;
  }
  return fila.encendido;
}

/** Lanza `FuenteApagadaError` si el interruptor de la fuente está apagado. */
export async function exigirFuenteHabilitada(fuente: FuenteSincronizacion): Promise<void> {
  if (!(await fuenteHabilitada(fuente))) throw new FuenteApagadaError(fuente);
}

/** Composición pura de la habilitación (RN-04): el maestro gana sobre el interruptor. */
export function habilitacionDe(maestro: boolean, encendido: boolean): EstadoHabilitacionFuente {
  if (!maestro) return { habilitada: false, motivoDeshabilitada: 'maestro' };
  if (!encendido) return { habilitada: false, motivoDeshabilitada: 'interruptor' };
  return { habilitada: true, motivoDeshabilitada: null };
}

/** Estado de FLIT 1 para `GET /estado` (AC9). FLIT 1 no tiene maestro. */
export async function estadoHabilitacionFlit1(): Promise<EstadoHabilitacionFuente> {
  return habilitacionDe(true, await fuenteHabilitada('flit1'));
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** Proyección explícita: fuente, valor y autor. Nada de credenciales (AC1). */
async function leerFilas(fuente?: FuenteSincronizacion) {
  const q = db.select({
    fuente: flitoSyncInterruptor.fuente,
    encendido: flitoSyncInterruptor.encendido,
    updatedAt: flitoSyncInterruptor.updatedAt,
    autorId: users.id,
    autorNombre: users.name,
  }).from(flitoSyncInterruptor)
    .leftJoin(users, eq(users.id, flitoSyncInterruptor.updatedBy));
  return fuente ? q.where(eq(flitoSyncInterruptor.fuente, fuente)) : q;
}

type FilaInterruptor = Awaited<ReturnType<typeof leerFilas>>[number];

function aInterruptor(fuente: FuenteSincronizacion, fila: FilaInterruptor | undefined): InterruptorFuente {
  if (!fila) {
    log.warn({ fuente }, 'interruptor de sincronización sin fila: se informa encendido');
    return { fuente, encendido: true, actualizadoEn: null, actualizadoPor: null };
  }
  return {
    fuente,
    encendido: fila.encendido,
    actualizadoEn: iso(fila.updatedAt),
    actualizadoPor: fila.autorId !== null && fila.autorNombre !== null
      ? { id: fila.autorId, nombre: fila.autorNombre }
      : null,
  };
}

/** `GET /interruptores` (AC1): siempre las dos fuentes, en orden, más el maestro de FLIT 2. */
export async function listarInterruptores(): Promise<InterruptoresSincronizacion> {
  const filas = await leerFilas();
  return {
    fuentes: FUENTES_SINCRONIZACION.map((f) => aInterruptor(f, filas.find((x) => x.fuente === f))),
    maestroFlit2: Boolean(env.FLIT2_SYNC_CRON),
  };
}

/** `PUT /interruptores/:fuente` (AC2, RN-05). Devuelve el valor anterior y el interruptor ya persistido. */
export async function guardarInterruptor(
  fuente: FuenteSincronizacion, encendido: boolean, userId: number | null,
): Promise<{ anterior: boolean; actual: InterruptorFuente }> {
  const anterior = await db.transaction(async (tx) => {
    const [previa] = await tx.select({ encendido: flitoSyncInterruptor.encendido })
      .from(flitoSyncInterruptor).where(eq(flitoSyncInterruptor.fuente, fuente)).for('update');
    const ahora = new Date();
    // Fila ausente (alguien la borró a mano): se recrea; el anterior es el default sembrado (encendida).
    await tx.insert(flitoSyncInterruptor)
      .values({ fuente, encendido, updatedAt: ahora, updatedBy: userId })
      .onConflictDoUpdate({
        target: flitoSyncInterruptor.fuente,
        set: { encendido, updatedAt: ahora, updatedBy: userId },
      });
    return previa?.encendido ?? true;
  });
  const [fila] = await leerFilas(fuente);
  return { anterior, actual: aInterruptor(fuente, fila) };
}

/** Detalle de auditoría (AC10): fuente y par anterior → nuevo. Sin nombres ni datos de persona. */
export function detalleAuditoriaInterruptor(fuente: FuenteSincronizacion, anterior: boolean, nuevo: boolean): string {
  const txt = (v: boolean) => (v ? 'encendido' : 'apagado');
  return `Interruptor de sincronización ${fuente}: ${txt(anterior)} → ${txt(nuevo)}${anterior === nuevo ? ' (sin cambio)' : ''}`;
}
