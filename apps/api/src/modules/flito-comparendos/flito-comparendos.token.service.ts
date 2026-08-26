// FLITO comparendos — token SIMIT cifrado en reposo (Feature #11492 17a, HU #11498, ADR-0002).
//
// El token de Verifik/SIMIT nunca se guarda ni se devuelve en claro. Se cifra con AES-256-GCM bajo
// una llave maestra propia (`COMPARENDOS_ENC_KEY`), separada de la de Siigo, la de RNDC y la de PII.
// Archivo aparte de `flito-comparendos.service.ts` —que son los tres catálogos— por la misma razón
// por la que Siigo separa `credenciales.service.ts`: lo que toca material criptográfico se lee, se
// revisa y se audita solo, sin tener que atravesar 300 líneas de CRUD.
//
// ── Reglas de negocio ────────────────────────────────────────────────────────────────────────────
//
// RN-07  Una sola fila `activo=true`. Rotar el token NO es un UPDATE del cipher: es desactivar la
//        anterior e insertar una nueva. Un UPDATE dejaría «quién y cuándo» solo del último cambio y
//        borraría el rastro de los anteriores, que es justo lo que CF-03 pide conservar. El índice
//        único parcial de la 0150 es quien lo hace cumplir de verdad.
//
// RN-08  El plaintext entra una vez y no vuelve a salir. `guardarTokenSimit` lo recibe, lo cifra y
//        lo suelta; `obtenerMetaTokenSimit` consulta SIN traer las columnas del cipher —exclusión a
//        nivel de query, no de mapeo, para que no exista ni la posibilidad de un `res.json(fila)`
//        descuidado—; y la única lectura que descifra devuelve `Redacted<string>`.
//
// RN-09  Sin llave maestra no se opera, ni al cifrar ni al descifrar, y el fallo es explícito
//        (`llave_maestra`, 503). No hay derivación de respaldo en desarrollo: ver el porqué en la
//        cabecera del keyspace de comparendos en `shared/utils/crypto.ts`.
//
// RN-10  Un descifrado fallido desactiva la fila y deja el motivo escrito en ella. Si el ciphertext
//        no autentica, o está corrupto o fue manipulado: reintentarlo en cada corrida del sync solo
//        produce ruido. La excepción es la falta de llave —ahí la fila está sana y lo que está mal
//        es el entorno—, que no desactiva nada.

import { and, eq } from 'drizzle-orm';
import type { ComparendosTokenSimitMeta } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { env } from '../../config/env.js';
import { flitoComparendosTokenSimit, users } from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';
import {
  type CipherBundle,
  ComparendosEncKeyError,
  decryptComparendosSecret,
  encryptComparendosSecret,
  newUuid,
  Redacted,
} from '../../shared/utils/crypto.js';
import {
  ComparendosLlaveMaestraError,
  ComparendosTokenDescifradoError,
  ComparendosTokenNoConfiguradoError,
  ComparendosTokenRotacionConcurrenteError,
  esViolacionDeUnicidad,
} from './flito-comparendos.errors.js';

const log = loggerFor('flito-comparendos');

// Partes del AAD. Atan el ciphertext a esta tabla, a esta columna y a ESTA fila (vía `aadNonce`,
// que se genera antes del INSERT y se guarda al lado): un cipher copiado a otra fila o a otra tabla
// deja de autenticar. `empresaNit` es el nombre que le puso el helper compartido al tercer
// discriminante; aquí no hay empresa —el token es uno para toda la instalación— y se usa como
// ámbito fijo, igual que `encryptPii` lo usa como `rowKey`.
const TABLE = 'flito_comparendos_token_simit';
const COLUMN = 'token_cipher';
const AMBITO = 'simit';

/**
 * Metadatos + el id de la fila activa.
 *
 * El id no está en el contrato público (`ComparendosTokenSimitMeta` no lo lleva y no debe llevarlo:
 * a la pantalla no le sirve de nada), pero la ruta lo necesita para escribir un `resourceId` de
 * auditoría que apunte a la fila exacta y no a un literal. Por eso viaja aparte.
 */
export interface TokenSimitGuardado {
  id: number;
  meta: ComparendosTokenSimitMeta;
}

/** Metadatos de «no hay nada configurado». Se responde tal cual, no como 404: la ausencia de token
 *  es un estado normal de la configuración, no un recurso que falte. */
const META_VACIA: ComparendosTokenSimitMeta = {
  configurado: false,
  actualizadoEn: null,
  actualizadoPor: null,
  keyVersion: null,
};

/**
 * Consulta de metadatos: NO trae `token_cipher`, `token_iv` ni `token_auth_tag`.
 *
 * La exclusión es a nivel de query a propósito (RN-08). Si el cipher no está en el objeto que se
 * pasea por el servicio, ningún `res.json(...)` futuro puede filtrarlo por descuido, ni siquiera el
 * de alguien que no haya leído esta cabecera.
 */
const SELECT_META = {
  id: flitoComparendosTokenSimit.id,
  keyVersion: flitoComparendosTokenSimit.keyVersion,
  actualizadoEn: flitoComparendosTokenSimit.updatedAt,
  autorId: users.id,
  autorNombre: users.name,
} as const;

/** Lee la fila activa en su forma pública. `null` si todavía no hay token. */
async function leerMetaActiva(): Promise<TokenSimitGuardado | null> {
  const [fila] = await db.select(SELECT_META)
    .from(flitoComparendosTokenSimit)
    // `leftJoin` y no `innerJoin`: si el token se sembró sin autor (`updated_by` nulo), un join
    // interno haría desaparecer la fila y el API respondería «no configurado» teniendo token.
    .leftJoin(users, eq(users.id, flitoComparendosTokenSimit.updatedBy))
    .where(eq(flitoComparendosTokenSimit.activo, true))
    .limit(1);

  if (!fila) return null;

  return {
    id: fila.id,
    meta: {
      configurado: true,
      actualizadoEn: fila.actualizadoEn?.toISOString() ?? null,
      actualizadoPor: fila.autorId !== null && fila.autorNombre !== null
        ? { id: fila.autorId, nombre: fila.autorNombre }
        : null,
      keyVersion: fila.keyVersion,
    },
  };
}

/**
 * `GET /config/token-simit`: qué se sabe del token sin decir cuál es (CF-03).
 *
 * No exige llave maestra. Es deliberado: si `COMPARENDOS_ENC_KEY` falta, quien administra debe
 * poder seguir viendo que hay un token guardado y de cuándo es —esa es justamente la información
 * con la que se diagnostica el problema—. Lo que falla sin llave es usarlo, no mirarlo.
 */
export async function obtenerMetaTokenSimit(): Promise<ComparendosTokenSimitMeta> {
  const activa = await leerMetaActiva();
  return activa?.meta ?? META_VACIA;
}

/**
 * `PUT /config/token-simit`: cifra el token y lo deja como la única fila activa (RN-07).
 *
 * Se cifra ANTES de abrir la transacción a propósito: si falta la llave maestra, esto revienta sin
 * haber tocado la base de datos y sin haber desactivado el token que ya estaba funcionando. Al
 * revés —desactivar primero y fallar al cifrar— dejaría la integración sin token por un error de
 * configuración del entorno.
 */
export async function guardarTokenSimit(
  token: string, actorId: number | null,
): Promise<TokenSimitGuardado> {
  const aadNonce = newUuid();
  const bundle = cifrar(token, aadNonce);

  const ahora = new Date();
  let filaId: number | null;
  try {
    filaId = await db.transaction(async (tx) => {
      // La anterior se desactiva, no se borra: el historial de rotaciones ES la trazabilidad que
      // pide CF-03. `updated_by` de la fila vieja pasa a ser quien la apagó; quien la puso sigue
      // en su `created_by`, así que no se pierde nada. Sin este UPDATE, además, el índice único
      // parcial rechazaría el INSERT.
      await tx.update(flitoComparendosTokenSimit)
        .set({ activo: false, updatedAt: ahora, updatedBy: actorId })
        .where(eq(flitoComparendosTokenSimit.activo, true));

      const [creada] = await tx.insert(flitoComparendosTokenSimit).values({
        tokenCipher: bundle.cipher,
        tokenIv: bundle.iv,
        tokenAuthTag: bundle.authTag,
        aadNonce,
        keyVersion: bundle.keyVersion,
        activo: true,
        createdAt: ahora,
        createdBy: actorId,
        updatedAt: ahora,
        updatedBy: actorId,
      }).returning({ id: flitoComparendosTokenSimit.id });

      return creada?.id ?? null;
    });
  } catch (e) {
    // Dos PUT a la vez: el segundo desactiva una fila que la otra transacción ya apagó, inserta y
    // choca contra `uq_flito_comparendos_token_activo`. Es una carrera real —el índice está para
    // ganarla— y sale como 409 «reintenta», no como un 500 que parece un bug.
    if (esViolacionDeUnicidad(e)) throw new ComparendosTokenRotacionConcurrenteError();
    throw e;
  }

  // Se relee en vez de componer la respuesta con lo que se acaba de escribir: el nombre del autor
  // vive en `users` y el JWT solo trae el `username`. Releer da la MISMA forma que el GET —una sola
  // proyección que mantener— y de paso confirma que la fila quedó activa.
  const activa = await leerMetaActiva();
  if (activa) return activa;

  // Sin fila activa después de insertar solo puede pasar si la base no está donde creemos. No se
  // inventa una respuesta: `configurado: false` tras un PUT correcto sería una mentira.
  throw new Error(`El token SIMIT se guardó (id=${filaId ?? '?'}) pero no volvió a leerse como activo`);
}

/**
 * USO RESTRINGIDO: solo los clientes de Verifik/SIMIT (HUs #11499 y #11500). Devuelve el token en
 * claro envuelto en `Redacted` para que un log accidental imprima `[REDACTED]` y no la credencial.
 *
 * Quien lo consuma debe llamar a `.unwrap()` lo más tarde posible —idealmente al construir la
 * cabecera `Authorization`— y no guardarlo desenvuelto en ninguna variable de larga vida.
 *
 * Lanza `ComparendosError` en los tres modos de fallo que hay que poder distinguir:
 *   - `token_no_configurado` — no hay fila activa ni bootstrap de entorno.
 *   - `llave_maestra`        — falta `COMPARENDOS_ENC_KEY` o es inválida (la fila está sana).
 *   - `token_descifrado`     — el ciphertext no autentica; la fila queda desactivada (RN-10).
 */
export async function obtenerTokenSimit(): Promise<Redacted<string>> {
  const [fila] = await db.select().from(flitoComparendosTokenSimit)
    .where(eq(flitoComparendosTokenSimit.activo, true))
    .limit(1);

  if (!fila) {
    // Bootstrap de desarrollo (ADR-0002 §6). Solo cuando NO hay fila: la fila cifrada es la fuente
    // de verdad y el entorno no la pisa nunca. Se avisa en el log —sin el valor— porque operar con
    // un token que no tiene autor ni fecha es exactamente lo que CF-03 quiere que no pase en PDN.
    //
    // Y por eso el guard de entorno no es adorno: llamarlo «de desarrollo» no lo impedía en
    // producción. El escenario que lo abre es la propia RN-10 — si un descifrado falla, la fila se
    // desactiva, y a partir de ahí NO hay fila activa. Con la variable puesta en PDN, el sync
    // seguiría corriendo con un token sin autor ni fecha mientras la pantalla dice
    // `configurado: false`: runtime y UI divergiendo justo en el punto que CF-03 vigila.
    const bootstrap = env.NODE_ENV === 'production' ? undefined : env.VERIFIK_SIMIT_TOKEN;
    if (bootstrap) {
      log.warn('token SIMIT tomado de VERIFIK_SIMIT_TOKEN (bootstrap de entorno): sin trazabilidad de quién ni cuándo. Regístralo cifrado para PDN.');
      return new Redacted(bootstrap);
    }
    throw new ComparendosTokenNoConfiguradoError();
  }

  try {
    return new Redacted(decryptComparendosSecret({
      cipher: fila.tokenCipher,
      iv: fila.tokenIv,
      authTag: fila.tokenAuthTag,
      keyVersion: fila.keyVersion,
    }, {
      table: TABLE, column: COLUMN, empresaNit: AMBITO, aadNonce: fila.aadNonce,
    }));
  } catch (e) {
    // Falta la llave: la fila no tiene nada de malo y desactivarla tiraría un token bueno por un
    // fallo de configuración del entorno.
    if (e instanceof ComparendosEncKeyError) throw new ComparendosLlaveMaestraError(e.message);
    await marcarDescifradoFallido(fila.id, e instanceof Error ? e.message : String(e));
    throw new ComparendosTokenDescifradoError();
  }
}

/**
 * Deja el fallo escrito en la fila y la desactiva (RN-10).
 *
 * Si esta escritura falla no se propaga: el error que importa es el del descifrado, y taparlo con
 * uno de base de datos solo confunde a quien lea la respuesta.
 */
async function marcarDescifradoFallido(id: number, motivo: string): Promise<void> {
  try {
    await db.update(flitoComparendosTokenSimit)
      .set({
        activo: false,
        descifradoFallidoEn: new Date(),
        // La columna es VARCHAR(200): recortar aquí evita que el propio registro del fallo falle.
        descifradoFallidoMotivo: motivo.slice(0, 200),
        updatedAt: new Date(),
      })
      .where(and(
        eq(flitoComparendosTokenSimit.id, id),
        // Idempotente ante dos peticiones simultáneas que descubran la corrupción a la vez.
        eq(flitoComparendosTokenSimit.activo, true),
      ));
  } catch (e) {
    // Sin el token ni el motivo: solo que la marca no se pudo escribir.
    log.error({ err: e instanceof Error ? e.message : String(e), id }, 'no se pudo marcar el descifrado fallido del token SIMIT');
  }
}

/**
 * Cifra traduciendo el error de configuración de la capa cripto al error de dominio del módulo.
 *
 * Envolverlo aquí es lo que permite que la ruta responda 503 `llave_maestra` sin conocer
 * `shared/utils/crypto.js`, y que cualquier OTRO fallo del cifrado siga siendo un 500 de verdad en
 * vez de disfrazarse de problema de configuración.
 *
 * El plaintext no aparece en el mensaje de ningún error de esta función, ni recortado: nada de lo
 * que se lanza desde aquí puede acabar en un log con material de la credencial dentro.
 */
function cifrar(token: string, aadNonce: string): CipherBundle {
  try {
    return encryptComparendosSecret(token, {
      table: TABLE, column: COLUMN, empresaNit: AMBITO, aadNonce,
    });
  } catch (e) {
    if (e instanceof ComparendosEncKeyError) throw new ComparendosLlaveMaestraError(e.message);
    throw e;
  }
}
