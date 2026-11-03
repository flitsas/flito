// Feature #13978, HU #14100 (ADR-0033 D2, D4) — etapa de arranque de las llaves PII.
//
// RN-LL1  Una llave bien formada pero equivocada no se detecta sin datos: cifrar y descifrar con ella
//         siempre cuadra. Por eso cada versión ancla un canario en `pii_key_registry`.
// RN-LL2  La API registra; el Job de rotación solo lee. Así una llave distinta en el Job se detecta.
// RN-LL3  El primer registro de la versión 1 exige que una muestra de datos reales descifre: si no, se
//         anclaría la llave equivocada. Sin datos, registra. No toca objetos de MinIO.
// RN-LL4  El primer registro de n ≥ 2 rechaza una llave retirada reutilizada.
// RN-LL5  De dos réplicas con llaves distintas para la misma versión, la segunda no arranca
//         (`ON CONFLICT DO NOTHING` y relectura).
// RN-LL6  Fallo = `log.fatal` + salida 1, a diferencia de `verificarCatalogoAlArrancar`: arrancar con la
//         llave equivocada corrompe datos. El rollout se detiene y los pods anteriores siguen sirviendo.
//
// Ningún log, error o métrica de este archivo lleva llaves ni valores descifrados.

import { and, eq, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { env } from '../../../config/env.js';
import { db } from '../../../db/client.js';
import {
  driverProfile, flitoLogisticaActaFirmas, flitoLogisticaRecogidaFirmantes, laftCounterparties, manifiestos,
  piiKeyRegistry, tramitesValidaciones,
} from '../../../db/schema.js';
import { loggerFor } from '../../../shared/logger.js';
import {
  decryptLegacyBiometric, decryptPii, decryptPiiText, decryptPiiTextConLlave, encryptPiiTextConVersion,
  PII_TEXT_PREFIJO, versionVigentePii, type PiiTextContext,
} from '../../../shared/utils/crypto.js';
import {
  derivarLlavePii, llavePiiMemoizada, pasadaPii, versionesPiiConfiguradas,
} from '../../../shared/utils/pii-keyring.js';
import { descifrarCounterpartyEstricto, type CounterpartyEncColumn, type EncBundleJsonb } from '../../laft/employees/counterparty-pii.js';
import { revelarDocumento } from '../../flito-logistica/flito-logistica.cifrado.js';

const log = loggerFor('pii-llaves');

const CANARIO_PLANO = 'flito-pii-canario';
const MUESTRA_POR_COLUMNA = 5;

export type MotivoLlavePii = 'canario_no_descifra' | 'muestra_no_descifra' | 'llave_retirada' | 'divergencia_entre_replicas';

const MENSAJES: Record<MotivoLlavePii, string> = {
  canario_no_descifra: 'La llave de esta versión no es la que se registró en esta base de datos',
  muestra_no_descifra: 'La llave no descifra ningún dato de la muestra: no corresponde a esta base de datos',
  llave_retirada: 'La llave ya se usó en otra versión: una llave retirada no se reutiliza',
  divergencia_entre_replicas: 'Otra réplica registró esta versión con una llave distinta',
};

export class LlavePiiError extends Error {
  constructor(readonly motivo: MotivoLlavePii, readonly version: number) {
    super(MENSAJES[motivo]);
    this.name = 'LlavePiiError';
  }
}

export interface ResumenLlavesPii {
  versionVigente: number;
  versionesConfiguradas: number[];
  versionesRegistradas: number[];
}

const ctxCanario = (version: number): PiiTextContext => ({ table: 'pii_key_registry', column: 'canario', id: version });

/** El prefijo se exige aparte: el valor elige su llave, y debe ser la de la fila. */
function canarioValido(version: number, canario: string): boolean {
  try {
    return PII_TEXT_PREFIJO.exec(canario)?.[1] === String(version)
      && decryptPiiText(canario, ctxCanario(version)) === CANARIO_PLANO;
  } catch {
    return false;
  }
}

function pasadaDeOtraVersion(pasada: string, versionFila: number, canario: string): boolean {
  try {
    return decryptPiiTextConLlave(canario, ctxCanario(versionFila), derivarLlavePii(versionFila, pasada)) === CANARIO_PLANO;
  } catch {
    return false;
  }
}

// ── Muestra de datos reales (solo versión 1) ───────────────────────────────────────────────────────

/** Cada intento lanza si el valor no descifra. Lo descifrado se descarta aquí mismo. */
type Intento = () => unknown;

interface ColumnaBundle {
  cipher: AnyPgColumn; iv: AnyPgColumn; authTag: AnyPgColumn; aadNonce: AnyPgColumn; keyVersion: AnyPgColumn;
}

const versionUno = (col: ColumnaBundle): SQL | undefined => and(
  isNotNull(col.cipher), isNotNull(col.iv), isNotNull(col.authTag), isNotNull(col.aadNonce),
  // `key_version` NULL se lee como 1 en las rutas.
  or(isNull(col.keyVersion), eq(col.keyVersion, 1)),
);

interface FilaBundle {
  cipher: Buffer; iv: Buffer; authTag: Buffer; aadNonce: string; keyVersion: number | null;
}

const intentoBundle = (f: FilaBundle, table: string, column: string, rowKey: string): Intento => () => decryptPii(
  { cipher: f.cipher, iv: f.iv, authTag: f.authTag, keyVersion: f.keyVersion ?? 1 },
  { table, column, empresaNit: rowKey, aadNonce: f.aadNonce },
);

function columnaConductor(column: string, col: ColumnaBundle): () => Promise<Intento[]> {
  return async () => {
    const filas = await db.select({ userId: driverProfile.userId, ...col })
      .from(driverProfile).where(versionUno(col)).limit(MUESTRA_POR_COLUMNA) as unknown as (FilaBundle & { userId: number })[];
    return filas.map((f) => intentoBundle(f, 'driver_profile', column, String(f.userId)));
  };
}

function columnaManifiesto(): () => Promise<Intento[]> {
  const col = {
    cipher: manifiestos.titularPagoCuentaCipher,
    iv: manifiestos.titularPagoCuentaIv,
    authTag: manifiestos.titularPagoCuentaAuthTag,
    aadNonce: manifiestos.titularPagoCuentaAadNonce,
    keyVersion: manifiestos.titularPagoCuentaKeyVersion,
  };
  return async () => {
    const filas = await db.select({ numero: manifiestos.numero, ...col })
      .from(manifiestos).where(versionUno(col)).limit(MUESTRA_POR_COLUMNA) as (FilaBundle & { numero: string })[];
    // La clave de fila de la AAD es `numero`, no `id`.
    return filas.map((f) => intentoBundle(f, 'manifiestos', 'titular_pago_cuenta', f.numero));
  };
}

function columnaContraparte(column: CounterpartyEncColumn, col: AnyPgColumn): () => Promise<Intento[]> {
  return async () => {
    const filas = await db.select({ id: laftCounterparties.id, enc: col }).from(laftCounterparties)
      .where(sql`${col}->>'keyVersion' = '1'`).limit(MUESTRA_POR_COLUMNA);
    return filas.map((f) => () => descifrarCounterpartyEstricto(f.enc as EncBundleJsonb, column, f.id));
  };
}

function columnaCedulaLogistica(
  tabla: typeof flitoLogisticaActaFirmas | typeof flitoLogisticaRecogidaFirmantes,
): () => Promise<Intento[]> {
  return async () => {
    // `v1` es la versión del formato; el segundo campo, la de la llave.
    const filas = await db.select({ id: tabla.id, cifrado: tabla.documentoCifrado }).from(tabla)
      .where(sql`${tabla.documentoCifrado} LIKE 'v1:1:%'`).limit(MUESTRA_POR_COLUMNA);
    return filas.map((f) => () => revelarDocumento(f.cifrado as string, f.id));
  };
}

function columnaFoto(columna: string, col: AnyPgColumn): () => Promise<Intento[]> {
  return async () => {
    // El formato anterior `iv:tag:data` usa la misma pasada V1 con otra sal: también prueba la llave.
    const filas = await db.select({ id: tramitesValidaciones.id, valor: col }).from(tramitesValidaciones)
      .where(sql`left(${col}, 70) ~ '^(v1:[0-9a-f]{24}:[0-9a-f]{32}:|[0-9a-fA-F]{32}:[0-9a-fA-F]{32}:)'`)
      .limit(MUESTRA_POR_COLUMNA);
    return filas.map((f) => () => {
      const ctx = { table: 'tramites_validaciones', column: columna, id: f.id };
      const valor = f.valor as string;
      return PII_TEXT_PREFIJO.test(valor) ? decryptPiiText(valor, ctx) : decryptLegacyBiometric(valor, ctx);
    });
  };
}

/** Las fotos van al final: son las más pesadas, y casi siempre otra columna ya resolvió la duda. */
const COLUMNAS_MUESTRA: (() => Promise<Intento[]>)[] = [
  columnaConductor('cedula', {
    cipher: driverProfile.cedulaCipher, iv: driverProfile.cedulaIv, authTag: driverProfile.cedulaAuthTag,
    aadNonce: driverProfile.cedulaAadNonce, keyVersion: driverProfile.cedulaKeyVersion,
  }),
  columnaConductor('licencia_numero', {
    cipher: driverProfile.licenciaNumeroCipher, iv: driverProfile.licenciaNumeroIv, authTag: driverProfile.licenciaNumeroAuthTag,
    aadNonce: driverProfile.licenciaNumeroAadNonce, keyVersion: driverProfile.licenciaNumeroKeyVersion,
  }),
  columnaConductor('runt_payload', {
    cipher: driverProfile.runtPayloadCipher, iv: driverProfile.runtPayloadIv, authTag: driverProfile.runtPayloadAuthTag,
    aadNonce: driverProfile.runtPayloadAadNonce, keyVersion: driverProfile.runtPayloadKeyVersion,
  }),
  columnaManifiesto(),
  columnaContraparte('doc_number', laftCounterparties.docNumberEnc),
  columnaContraparte('email', laftCounterparties.emailEnc),
  columnaContraparte('phone', laftCounterparties.phoneEnc),
  columnaCedulaLogistica(flitoLogisticaActaFirmas),
  columnaCedulaLogistica(flitoLogisticaRecogidaFirmantes),
  columnaFoto('foto_rostro', tramitesValidaciones.fotoRostro),
  columnaFoto('foto_cedula_frontal', tramitesValidaciones.fotoCedulaFrontal),
  columnaFoto('foto_cedula_reverso', tramitesValidaciones.fotoCedulaReverso),
];

/** Una fila corrupta suelta no frena el arranque: basta un éxito. Sin datos, pasa. */
async function muestraDescifra(): Promise<boolean> {
  let hayDatos = false;
  for (const leer of COLUMNAS_MUESTRA) {
    for (const intento of await leer()) {
      hayDatos = true;
      try {
        intento();
        return true;
      } catch {
        // Sigue: el veredicto es sobre el conjunto.
      }
    }
  }
  return !hayDatos;
}

// ── Comprobación ───────────────────────────────────────────────────────────────────────────────────

/** Lanza `LlavePiiError` si una llave no corresponde a esta base de datos. Registra las nuevas. */
export async function verificarLlavesPii(): Promise<ResumenLlavesPii> {
  const versiones = versionesPiiConfiguradas(env.PII_ENC_KEY);
  // Se deriva todo aquí para que la primera petición no pague scrypt.
  for (const v of versiones) llavePiiMemoizada(v, pasadaPii(v, env.PII_ENC_KEY) as string);

  const registro = new Map((await db.select({ version: piiKeyRegistry.version, canario: piiKeyRegistry.canario })
    .from(piiKeyRegistry)).map((f) => [f.version, f.canario]));

  // De menor a mayor: V1 queda registrada antes de la comprobación cruzada de las demás.
  for (const version of versiones) {
    const canario = registro.get(version);
    if (canario !== undefined) {
      if (!canarioValido(version, canario)) throw new LlavePiiError('canario_no_descifra', version);
      continue;
    }
    if (version === 1) {
      if (!await muestraDescifra()) throw new LlavePiiError('muestra_no_descifra', version);
    } else {
      const pasada = pasadaPii(version, env.PII_ENC_KEY) as string;
      for (const [otra, canarioOtra] of registro) {
        if (pasadaDeOtraVersion(pasada, otra, canarioOtra)) throw new LlavePiiError('llave_retirada', version);
      }
    }
    await db.insert(piiKeyRegistry)
      .values({ version, canario: encryptPiiTextConVersion(CANARIO_PLANO, ctxCanario(version), version) })
      .onConflictDoNothing();
    const [fila] = await db.select({ canario: piiKeyRegistry.canario }).from(piiKeyRegistry)
      .where(eq(piiKeyRegistry.version, version)).limit(1);
    if (!fila || !canarioValido(version, fila.canario)) throw new LlavePiiError('divergencia_entre_replicas', version);
    registro.set(version, fila.canario);
  }

  return {
    versionVigente: versionVigentePii(),
    versionesConfiguradas: versiones,
    versionesRegistradas: [...registro.keys()].sort((a, b) => a - b),
  };
}

/** Punto de entrada de `server.ts`. No va en `crypto.ts` ni en `app.ts`: tests y scripts no la ejecutan. */
export async function comprobarLlavesPiiAlArrancar(): Promise<void> {
  try {
    const resumen = await verificarLlavesPii();
    log.info(resumen, 'llaves PII comprobadas');
  } catch (e) {
    if (e instanceof LlavePiiError) {
      log.fatal({ motivo: e.motivo, version: e.version }, `Llaves PII: ${e.message}. La API no arranca`);
    } else {
      // Sin el mensaje del ORM, que incluye los parámetros de la consulta.
      const causa = (e as { cause?: { message?: string } }).cause?.message;
      log.fatal({ motivo: 'error_de_comprobacion', causa }, 'Llaves PII: no se pudo comprobar el registro. La API no arranca');
    }
    process.exit(1);
  }
}
