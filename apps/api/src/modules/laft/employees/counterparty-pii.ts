import { encryptPii, decryptPii, newUuid, hmacCedula, normalizeDocument } from '../../../shared/utils/crypto.js';
import type { CipherBundle } from '../../../shared/utils/crypto.js';

// Helpers para cifrar/descifrar columnas PII de laft_counterparties (mig 0063).
// Convención: las columnas *_enc almacenan un JSONB con la siguiente forma:
//   { cipher: <base64>, iv: <base64>, authTag: <base64>, aadNonce: <uuid>, keyVersion: <int> }
// y se serializan/deserializan vía estos helpers.
//
// AAD: "laft_counterparties|<column>|<empresaNit=row_id>|<aadNonce>|<keyVersion>"
// donde `empresaNit` se reusa como rowKey (id de la fila) — mismo patrón que
// driver_profile (mig 0051).

export interface EncBundleJsonb {
  cipher: string;     // base64
  iv: string;         // base64
  authTag: string;    // base64
  aadNonce: string;   // uuid
  keyVersion: number;
}

function bundleToJsonb(b: CipherBundle, aadNonce: string): EncBundleJsonb {
  return {
    cipher: b.cipher.toString('base64'),
    iv: b.iv.toString('base64'),
    authTag: b.authTag.toString('base64'),
    aadNonce,
    keyVersion: b.keyVersion,
  };
}

function jsonbToBundle(j: EncBundleJsonb): CipherBundle {
  return {
    cipher: Buffer.from(j.cipher, 'base64'),
    iv: Buffer.from(j.iv, 'base64'),
    authTag: Buffer.from(j.authTag, 'base64'),
    keyVersion: j.keyVersion,
  };
}

export type CounterpartyEncColumn = 'doc_number' | 'email' | 'phone';

export function encryptCounterpartyField(
  plain: string | null | undefined,
  column: CounterpartyEncColumn,
  rowId: number,
): EncBundleJsonb | null {
  if (plain == null || plain === '') return null;
  const aadNonce = newUuid();
  const bundle = encryptPii(plain, {
    table: 'laft_counterparties',
    column,
    empresaNit: String(rowId),
    aadNonce,
  });
  return bundleToJsonb(bundle, aadNonce);
}

export function decryptCounterpartyField(
  enc: EncBundleJsonb | null | undefined,
  column: CounterpartyEncColumn,
  rowId: number,
): string | null {
  if (!enc) return null;
  try {
    return decryptPii(jsonbToBundle(enc), {
      table: 'laft_counterparties',
      column,
      empresaNit: String(rowId),
      aadNonce: enc.aadNonce,
    });
  } catch {
    return null;
  }
}

/**
 * Hash HMAC del documento normalizado (sólo dígitos en mayúsculas), almacenado
 * como hex en doc_number_hash para búsqueda exacta sin descifrar.
 *
 * Reusa hmacCedula() (PII_HMAC_KEY) para no inventar otra key.
 * Devuelve hex string (64 chars) listo para varchar(64).
 */
export function counterpartyDocHash(doc: string | null | undefined): string | null {
  const norm = normalizeDocument(String(doc ?? ''));
  if (!norm) return null;
  return hmacCedula(norm).toString('hex');
}
