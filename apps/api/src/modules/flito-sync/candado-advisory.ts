// FLITO sync — advisory lock de sesión no bloqueante, común a las lecturas programadas.
// Origen: HU #13092 (FLIT 2, `flit2-candado.ts`); extraído en la HU #13629 para que la lectura automática
// de FLIT 1 use el mismo mecanismo con su propia clave. Diseño: `docs/diseno/hu-13629-lectura-automatica-flit1.md` §D1.
//
// `pg_try_advisory_lock` de SESIÓN: vale entre procesos (PM2 en cluster, varias réplicas) porque vive en el
// servidor de base. Se toma sobre una conexión RESERVADA del pool (`reserve()` de postgres-js): un advisory
// lock de sesión pertenece a la conexión que lo pidió, y con el pool normal el `unlock` podría salir por otra
// conexión y no soltar nada. La conexión reservada solo sostiene el candado; el trabajo usa el pool.
// Si el proceso muere, Postgres cierra la sesión y suelta el candado solo: no hay candados huérfanos.
//
// Claves: siempre la forma de DOS enteros (`objsubid = 2`), que no choca con los
// `pg_advisory_xact_lock(hashtext(...))` del repo (forma de una clave). Pares en uso:
//   [13_092, 2] lectura de FLIT 2 · [13_629, 1] lectura de FLIT 1 (automática y manual).

import { db } from '../../db/client.js';
import { loggerFor } from '../../shared/logger.js';

export type ClaveCandado = readonly [number, number];

export type ResultadoCandado<T> = { tomado: true; valor: T } | { tomado: false };

/**
 * Ejecuta `fn` solo si nadie más tiene el candado `clave` (en este u otro proceso). No espera: si está
 * tomado, devuelve `{ tomado: false }` sin ejecutar nada. Se suelta en `finally`, también si `fn` lanza.
 * `etiqueta` solo nombra la fuente en el log de «no se pudo soltar».
 */
export async function conCandado<T>(
  clave: ClaveCandado, fn: () => Promise<T>, etiqueta: string, logger = loggerFor('flito-sync-candado'),
): Promise<ResultadoCandado<T>> {
  const [k1, k2] = clave;
  const conexion = await db.$client.reserve();
  try {
    const [fila] = await conexion<{ tomado: boolean }[]>`SELECT pg_try_advisory_lock(${k1}::int4, ${k2}::int4) AS tomado`;
    if (fila?.tomado !== true) return { tomado: false };
    try {
      return { tomado: true, valor: await fn() };
    } finally {
      try {
        await conexion`SELECT pg_advisory_unlock(${k1}::int4, ${k2}::int4)`;
      } catch (e) {
        // Conexión caída: Postgres ya soltó el candado al cerrar la sesión. No tapa el desenlace de `fn`.
        logger.warn({ causa: e instanceof Error ? e.name : typeof e }, `no se pudo soltar el candado de la ${etiqueta}`);
      }
    }
  } finally {
    conexion.release();
  }
}
