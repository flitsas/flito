// FLITO sync — candado de la lectura de FLIT 2 (HU #13092, Feature #13059).
// Diseño: `docs/diseno/hu-13092-lectura-programada-flit2.md` §Candado.
//
// Advisory lock de PostgreSQL de SESIÓN (`pg_try_advisory_lock`), sin migración: vale entre procesos
// (PM2 en cluster, varias réplicas) porque vive en el servidor de base, no en la memoria del proceso.
// Se toma sobre una conexión RESERVADA del pool (`reserve()` de postgres-js): un advisory lock de sesión
// pertenece a la conexión que lo pidió, y con el pool normal el `unlock` podría salir por otra conexión
// y no soltar nada. La conexión reservada solo sostiene el candado; la lectura usa el pool como siempre.
// Si el proceso muere, Postgres cierra la sesión y suelta el candado solo: no hay candados huérfanos.
//
// La guarda optimista del cursor (#13091, RN-02 de `flit2-lectura.service.ts`) queda como segunda
// defensa: si alguien corre una lectura sin pasar por aquí, el cursor tampoco retrocede.

import { db } from '../../db/client.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('flito-sync-flit2');

/**
 * Clave fija del candado, en la forma de DOS enteros `(13092, 2)`: la HU y «FLIT 2». Se usa la forma de
 * dos claves a propósito: Postgres la guarda en otro espacio (`objsubid = 2`) que la de una clave
 * (`objsubid = 1`), así que no puede chocar con los `pg_advisory_xact_lock(hashtext(...))` del repo
 * (LAFT, PESV, RNDC), cuyo hash cae en cualquier int4. Ningún otro candado debe reutilizar este par.
 */
export const CLAVE_CANDADO_LECTURA_FLIT2 = [13_092, 2] as const;
const [K1, K2] = CLAVE_CANDADO_LECTURA_FLIT2;

export type ResultadoCandado<T> = { tomado: true; valor: T } | { tomado: false };

/**
 * Ejecuta `fn` solo si nadie más tiene el candado (en este u otro proceso). No espera: si está tomado,
 * devuelve `{ tomado: false }` sin ejecutar nada. El candado se suelta en `finally`, también si `fn` lanza.
 */
export async function conCandadoLectura<T>(fn: () => Promise<T>): Promise<ResultadoCandado<T>> {
  const conexion = await db.$client.reserve();
  try {
    const [fila] = await conexion<{ tomado: boolean }[]>`SELECT pg_try_advisory_lock(${K1}::int4, ${K2}::int4) AS tomado`;
    if (fila?.tomado !== true) return { tomado: false };
    try {
      return { tomado: true, valor: await fn() };
    } finally {
      try {
        await conexion`SELECT pg_advisory_unlock(${K1}::int4, ${K2}::int4)`;
      } catch (e) {
        // Conexión caída: Postgres ya soltó el candado al cerrar la sesión. No tapa el desenlace de `fn`.
        log.warn({ causa: e instanceof Error ? e.name : typeof e }, 'no se pudo soltar el candado de la lectura FLIT 2');
      }
    }
  } finally {
    conexion.release();
  }
}

