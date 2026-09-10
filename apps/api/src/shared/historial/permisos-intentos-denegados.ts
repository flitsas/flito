// HU #12082 / ADR-0016 — La bitácora de intentos denegados: un CONTADOR por (usuario, función, hora).
//
// No es un registro de eventos ni evidencia inmutable: es la señal operativa que responde «¿quién
// está chocando con qué?» —un rol mal configurado o un usuario sondeando— sin poder llenar el disco
// (CF-20). Por eso es una tabla propia y no `siigo_operaciones` (WORM: no admite un contador) ni
// `audit_logs` (copia el correo, no tiene clave con la que deduplicar y su enum no tiene «denegado»).
//
// ── Sin datos personales, por construcción ──────────────────────────────────────────────────────
//
// Recibe CAMPOS ya recortados, nunca `req`: el id numérico del usuario y su rol (del JWT verificado),
// el código que la ruta pidió, el motivo, el método y la ruta SIN query string. No hay columna de
// texto libre en la tabla, así que no hay dónde escribir un correo aunque alguien quiera.
//
// ── Nunca lanza, nunca se espera ────────────────────────────────────────────────────────────────
//
// `exigirFuncion` la dispara sin `await` y con `.catch` antes de responder el 403: quien es rechazado
// no espera a la bitácora, y una bitácora rota no convierte un 403 en un 500. Aquí el `try/catch`
// hace `log.warn` con el `userId` y el mensaje del error, y resuelve.
//
// Vive en `shared/historial/` junto a `estado-historial.ts` porque la escriben todos los módulos a
// través de la guarda, no uno.
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { permisosIntentosDenegados } from '../../db/schema.js';
import { loggerFor } from '../logger.js';

const log = loggerFor('permisos');

/** Los cuatro motivos del 403 de `exigirFuncion`. El CHECK de la tabla los acota igual. */
export type MotivoDenegacion = 'sin_funcion' | 'sin_modulo' | 'no_reconocida' | 'no_resuelto';

/**
 * La ventana de deduplicación: UNA HORA. Cota dura: por cada par (usuario, función) hay como máximo
 * 24 filas al día, haga lo que haga el usuario; 10.000 reintentos en la misma hora son una fila con
 * `veces = 10000`. Retención declarada: 2 años, `purgar` (ADR-0016 §5; mecanismo en la HU #12215).
 */
export const VENTANA_DEDUP_MS = 3_600_000;

export interface IntentoDenegado {
  userId: number;
  rol: string;
  codigo: string;
  motivo: MotivoDenegacion;
  metodo: string;
  /** Ya sin query string; aquí se recorta a los 300 de la columna por si acaso. */
  ruta: string;
}

/** El inicio de la ventana a la que pertenece AHORA. En la aplicación, no en SQL: obedece al reloj. */
export function ventanaActual(): Date {
  return new Date(Math.floor(Date.now() / VENTANA_DEDUP_MS) * VENTANA_DEDUP_MS);
}

/**
 * UN `INSERT … ON CONFLICT DO UPDATE`: la deduplicación es atómica en la base, sin estado en memoria
 * ni lecturas previas. `primera_vez` se fija al crear la fila y no se toca; `ultima_vez`, `veces`,
 * `motivo`, `metodo` y `ruta` quedan con lo ÚLTIMO que pasó.
 */
export async function registrarIntentoDenegado(intento: IntentoDenegado): Promise<void> {
  // Bandera leída EN CALIENTE (patrón `AUTH_SKIP_SESSION_INVAL_CHECK` de auth.ts): la suite la pone en
  // `__tests__/setup.ts` para que el `insert` de la bitácora no consuma el mock de base de los specs
  // que afirman un 403 y un `insert…not.toHaveBeenCalled` en el mismo caso. Los specs que SÍ prueban
  // la bitácora la borran en su `beforeAll`. En producción no existe.
  if (process.env.PERMISOS_SKIP_BITACORA_INTENTOS === '1') return;
  const t = permisosIntentosDenegados;
  const fila = {
    userId: intento.userId,
    rolCodigo: intento.rol.slice(0, 40),
    funcionCodigo: intento.codigo.slice(0, 80),
    motivo: intento.motivo,
    metodo: intento.metodo.slice(0, 10),
    ruta: intento.ruta.slice(0, 300),
    ventanaInicio: ventanaActual(),
  };
  try {
    await db.insert(t).values(fila).onConflictDoUpdate({
      target: [t.userId, t.funcionCodigo, t.ventanaInicio],
      set: {
        veces: sql`${t.veces} + 1`,
        ultimaVez: sql`now()`,
        motivo: fila.motivo,
        metodo: fila.metodo,
        ruta: fila.ruta,
      },
    });
  } catch (err) {
    log.warn(
      { userId: intento.userId, err: (err as Error)?.message },
      'permisos_intentos_denegados: no se pudo registrar el intento',
    );
  }
}
