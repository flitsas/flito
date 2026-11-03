// FLITO Logística — cifrado de la cédula del firmante (HU #14110, ADR-0030 §9, Ley 1581).
// Reutiliza el helper de campo de `shared/utils/crypto.ts` (AES-256-GCM, `PII_ENC_KEY`): el mismo que cifra
// la cédula de los conductores. Una sola columna TEXT guarda el paquete serializado; la AAD liga el cifrado
// a la fila (`firmaId`), así que un valor copiado a otra firma no descifra.

import { decryptPii, encryptPii, newUuid, type CipherBundle } from '../../shared/utils/crypto.js';

const TABLA = 'flito_logistica_acta_firmas';
const COLUMNA = 'documento_cifrado';
const VERSION = 'v1';

/** Documento sin separadores (puntos, espacios, guiones); vacío si no queda nada. */
export const limpiarDocumento = (s: string): string => s.replace(/[^0-9A-Za-z]/g, '');

export interface DocumentoProtegido { cifrado: string; ultimos: string }

/** `cifrado` va a `documento_cifrado`; `ultimos` (4 caracteres) a `documento_ultimos`. */
export function protegerDocumento(documento: string, firmaId: string): DocumentoProtegido {
  const limpio = limpiarDocumento(documento);
  const aadNonce = newUuid();
  const b = encryptPii(limpio, { table: TABLA, column: COLUMNA, empresaNit: firmaId, aadNonce });
  const cifrado = [VERSION, b.keyVersion, aadNonce, b.iv.toString('base64'), b.authTag.toString('base64'), b.cipher.toString('base64')].join(':');
  return { cifrado, ultimos: limpio.slice(-4) };
}

/** Inversa de `protegerDocumento`. Lanza si el valor está corrupto o pertenece a otra firma. */
export function revelarDocumento(cifrado: string, firmaId: string): string {
  const [v, kv, aadNonce, iv, tag, cipher] = cifrado.split(':');
  if (v !== VERSION || !kv || !aadNonce || !iv || !tag || !cipher) throw new Error('documento cifrado con formato desconocido');
  const bundle: CipherBundle = {
    keyVersion: Number(kv), iv: Buffer.from(iv, 'base64'), authTag: Buffer.from(tag, 'base64'), cipher: Buffer.from(cipher, 'base64'),
  };
  return decryptPii(bundle, { table: TABLA, column: COLUMNA, empresaNit: firmaId, aadNonce });
}

/** Máscara de lectura: nunca el valor completo. */
export const enmascarar = (ultimos: string | null): string | null => (ultimos ? `••••${ultimos}` : null);
