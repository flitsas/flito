// FLITO sync — acceso de FLITO a FLIT 2 (Feature #13057, HU #13061). Patrón del token SIMIT
// (`flito-comparendos.token.service.ts`, ADR-0002) aplicado al usuario de servicio de FLIT 2.
// Diseño: `docs/diseno/hu-13061-13063-acceso-flit2.md`. Contrato: `docs/integraciones/flit2-api.md` §2.
//
// ── Reglas de negocio ────────────────────────────────────────────────────────────────────────────
//
// RN-01  Una sola fila `activo = true`. Reemplazar el acceso es desactivar la vigente e insertar otra
//        en la misma transacción; las inactivas son el rastro de quién y cuándo. El índice único
//        parcial de la 0214 lo hace cumplir; dos reemplazos simultáneos → 409.
// RN-02  La contraseña entra una vez y no vuelve a salir. La consulta de metadatos NO selecciona las
//        columnas del cipher (exclusión a nivel de query) y la única lectura que descifra devuelve
//        `Redacted<string>`.
// RN-03  Sin `FLIT2_ENC_KEY` no se guarda: 503 `llave_maestra` ANTES de abrir la transacción, así el
//        acceso vigente no se toca. Consultar sí funciona sin llave (es con lo que se diagnostica).
// RN-04  Un descifrado fallido desactiva la fila y deja el motivo escrito en ella; la falta de llave
//        no desactiva nada (la fila está sana).
// RN-05  (HU #13063) Las marcas de rechazo y de pausa viven en la fila vigente; la fila nueva nace sin
//        ellas, así que guardar otro acceso levanta la pausa. Tras el commit se descarta el pase en
//        memoria (AC10).

import { and, eq } from 'drizzle-orm';
import type { Flit2AccesoEstado, Flit2AccesoMeta } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoSyncFlit2Acceso, users } from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';
import {
  type CipherBundle,
  decryptFlit2Secret,
  encryptFlit2Secret,
  Flit2EncKeyError,
  newUuid,
  Redacted,
} from '../../shared/utils/crypto.js';
import {
  Flit2AccesoDescifradoError,
  Flit2AccesoRotacionConcurrenteError,
  Flit2LlaveMaestraError,
  Flit2SinAccesoError,
  esViolacionDeUnicidad,
  type Flit2MotivoBloqueo,
  type Flit2MotivoRechazo,
} from './flit2.errors.js';
import { invalidarPase } from './flit2-pase.cache.js';

const log = loggerFor('flito-sync-flit2');

// AAD: ata el ciphertext a esta tabla, esta columna y ESTA fila (vía `aadNonce`). `empresaNit` es el
// nombre del tercer discriminante del helper compartido; aquí es un ámbito fijo.
const TABLE = 'flito_sync_flit2_acceso';
const COLUMN = 'secret_cipher';
const AMBITO = 'flit2';

/** Metadatos + id de la fila vigente (el id solo sirve para el `resourceId` de auditoría). */
export interface Flit2AccesoGuardado {
  id: number;
  meta: Flit2AccesoMeta;
}

/** «No hay acceso»: estado normal de la configuración, se responde 200 y no 404. */
export const META_SIN_ACCESO: Flit2AccesoMeta = {
  configurado: false,
  clientId: null,
  actualizadoPor: null,
  actualizadoEn: null,
  estado: null,
  bloqueadoHasta: null,
};

/** Proyección pública: sin `secret_cipher`, `secret_iv` ni `secret_auth_tag` (RN-02). */
const SELECT_META = {
  id: flitoSyncFlit2Acceso.id,
  clientId: flitoSyncFlit2Acceso.clientId,
  actualizadoEn: flitoSyncFlit2Acceso.updatedAt,
  rechazadoEn: flitoSyncFlit2Acceso.rechazadoEn,
  bloqueadoHasta: flitoSyncFlit2Acceso.bloqueadoHasta,
  autorId: users.id,
  autorNombre: users.name,
} as const;

function estadoDe(rechazadoEn: Date | null, bloqueadoHasta: Date | null, ahora: Date): Flit2AccesoEstado {
  if (rechazadoEn) return 'rechazado';
  if (bloqueadoHasta && bloqueadoHasta.getTime() > ahora.getTime()) return 'bloqueado';
  return 'vigente';
}

async function leerMetaVigente(): Promise<Flit2AccesoGuardado | null> {
  const [fila] = await db.select(SELECT_META)
    .from(flitoSyncFlit2Acceso)
    // `leftJoin`: un acceso sin autor (`updated_by` nulo) no debe desaparecer como «no configurado».
    .leftJoin(users, eq(users.id, flitoSyncFlit2Acceso.updatedBy))
    .where(eq(flitoSyncFlit2Acceso.activo, true))
    .limit(1);
  if (!fila) return null;

  const estado = estadoDe(fila.rechazadoEn ?? null, fila.bloqueadoHasta ?? null, new Date());
  return {
    id: fila.id,
    meta: {
      configurado: true,
      clientId: fila.clientId,
      actualizadoPor: fila.autorId !== null && fila.autorNombre !== null
        ? { id: fila.autorId, nombre: fila.autorNombre }
        : null,
      actualizadoEn: fila.actualizadoEn?.toISOString() ?? null,
      estado,
      bloqueadoHasta: estado === 'bloqueado' ? fila.bloqueadoHasta!.toISOString() : null,
    },
  };
}

/** `GET /acceso`: qué acceso hay, de quién y desde cuándo. No exige llave maestra (RN-03). */
export async function obtenerMetaAcceso(): Promise<Flit2AccesoMeta> {
  const vigente = await leerMetaVigente();
  return vigente?.meta ?? META_SIN_ACCESO;
}

/**
 * `PUT /acceso`: cifra la contraseña y deja el acceso como el único vigente (RN-01).
 *
 * Cifra ANTES de abrir la transacción: sin llave revienta sin haber tocado la base ni desactivado
 * el acceso que ya funcionaba (RN-03).
 */
export async function guardarAcceso(
  clientId: string, clientSecret: string, actorId: number | null,
): Promise<Flit2AccesoGuardado> {
  const aadNonce = newUuid();
  const bundle = cifrar(clientSecret, aadNonce);

  const ahora = new Date();
  let filaId: number | null;
  try {
    filaId = await db.transaction(async (tx) => {
      // La vigente se desactiva, no se borra: es el rastro. Su `updated_by` pasa a ser quien la apagó;
      // quien la puso sigue en `created_by`.
      await tx.update(flitoSyncFlit2Acceso)
        .set({ activo: false, updatedAt: ahora, updatedBy: actorId })
        .where(eq(flitoSyncFlit2Acceso.activo, true));

      const [creada] = await tx.insert(flitoSyncFlit2Acceso).values({
        clientId,
        secretCipher: bundle.cipher,
        secretIv: bundle.iv,
        secretAuthTag: bundle.authTag,
        aadNonce,
        keyVersion: bundle.keyVersion,
        activo: true,
        createdAt: ahora,
        createdBy: actorId,
        updatedAt: ahora,
        updatedBy: actorId,
      }).returning({ id: flitoSyncFlit2Acceso.id });

      return creada?.id ?? null;
    });
  } catch (e) {
    if (esViolacionDeUnicidad(e)) throw new Flit2AccesoRotacionConcurrenteError();
    throw e;
  }

  // AC10 (HU #13063): el pase del acceso anterior no se reutiliza. Después del commit, no antes: si
  // la transacción falla, el acceso que funcionaba sigue siendo el vigente y su pase sigue valiendo.
  invalidarPase();

  // Se relee para responder con la MISMA forma que el GET (el nombre del autor vive en `users`).
  const vigente = await leerMetaVigente();
  if (vigente) return vigente;
  throw new Error(`El acceso a FLIT 2 se guardó (id=${filaId ?? '?'}) pero no volvió a leerse como vigente`);
}

/**
 * USO RESTRINGIDO: solo el pase de FLIT 2 (HU #13063). Devuelve el `client_id` y la contraseña
 * envuelta en `Redacted`; `.unwrap()` lo más tarde posible, al armar la petición de token.
 */
export interface Flit2AccesoVigente {
  id: number;
  clientId: string;
  secreto: Redacted<string>;
  rechazadoEn: Date | null;
  rechazoMotivo: Flit2MotivoRechazo | null;
  bloqueadoHasta: Date | null;
  bloqueoMotivo: Flit2MotivoBloqueo | null;
}

export async function leerSecretoVigente(): Promise<Flit2AccesoVigente> {
  const [fila] = await db.select().from(flitoSyncFlit2Acceso)
    .where(eq(flitoSyncFlit2Acceso.activo, true))
    .limit(1);
  if (!fila) throw new Flit2SinAccesoError();

  try {
    const secreto = new Redacted(decryptFlit2Secret({
      cipher: fila.secretCipher,
      iv: fila.secretIv,
      authTag: fila.secretAuthTag,
      keyVersion: fila.keyVersion,
    }, { table: TABLE, column: COLUMN, empresaNit: AMBITO, aadNonce: fila.aadNonce }));
    return {
      id: fila.id,
      clientId: fila.clientId,
      secreto,
      rechazadoEn: fila.rechazadoEn ?? null,
      rechazoMotivo: (fila.rechazoMotivo ?? null) as Flit2MotivoRechazo | null,
      bloqueadoHasta: fila.bloqueadoHasta ?? null,
      bloqueoMotivo: (fila.bloqueoMotivo ?? null) as Flit2MotivoBloqueo | null,
    };
  } catch (e) {
    if (e instanceof Flit2EncKeyError) throw new Flit2LlaveMaestraError(e.message);
    await marcarDescifradoFallido(fila.id, e instanceof Error ? e.message : String(e));
    throw new Flit2AccesoDescifradoError();
  }
}

/** RN-05. FLIT 2 rechazó el acceso: los procesos automáticos dejan de llamar hasta otro acceso o una prueba sana. */
export async function marcarRechazo(id: number, motivo: Flit2MotivoRechazo): Promise<void> {
  const ahora = new Date();
  await db.update(flitoSyncFlit2Acceso)
    .set({ rechazadoEn: ahora, rechazoMotivo: motivo, updatedAt: ahora })
    .where(and(eq(flitoSyncFlit2Acceso.id, id), eq(flitoSyncFlit2Acceso.activo, true)));
}

/** RN-05. Pausa por 423 (15 min) o 429 (`Retry-After`): nadie llama a FLIT 2 hasta `hasta`. */
export async function marcarBloqueo(id: number, hasta: Date, motivo: Flit2MotivoBloqueo): Promise<void> {
  await db.update(flitoSyncFlit2Acceso)
    .set({ bloqueadoHasta: hasta, bloqueoMotivo: motivo, updatedAt: new Date() })
    .where(and(eq(flitoSyncFlit2Acceso.id, id), eq(flitoSyncFlit2Acceso.activo, true)));
}

/** RN-05. Una prueba manual sana limpia las marcas de la fila vigente. */
export async function limpiarMarcas(id: number): Promise<void> {
  await db.update(flitoSyncFlit2Acceso)
    .set({ rechazadoEn: null, rechazoMotivo: null, bloqueadoHasta: null, bloqueoMotivo: null, updatedAt: new Date() })
    .where(and(eq(flitoSyncFlit2Acceso.id, id), eq(flitoSyncFlit2Acceso.activo, true)));
}

/** RN-04. Si esta escritura falla no se propaga: el error que importa es el del descifrado. */
async function marcarDescifradoFallido(id: number, motivo: string): Promise<void> {
  try {
    await db.update(flitoSyncFlit2Acceso)
      .set({
        activo: false,
        descifradoFallidoEn: new Date(),
        descifradoFallidoMotivo: motivo.slice(0, 200),
        updatedAt: new Date(),
      })
      .where(and(eq(flitoSyncFlit2Acceso.id, id), eq(flitoSyncFlit2Acceso.activo, true)));
  } catch (e) {
    log.error({ err: e instanceof Error ? e.message : String(e), id }, 'no se pudo marcar el descifrado fallido del acceso a FLIT 2');
  }
}

/** Traduce la falta de llave al error de dominio (503); cualquier otro fallo sigue siendo un 500. */
function cifrar(secreto: string, aadNonce: string): CipherBundle {
  try {
    return encryptFlit2Secret(secreto, { table: TABLE, column: COLUMN, empresaNit: AMBITO, aadNonce });
  } catch (e) {
    if (e instanceof Flit2EncKeyError) throw new Flit2LlaveMaestraError(e.message);
    throw e;
  }
}
