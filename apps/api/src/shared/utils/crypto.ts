import crypto from 'crypto';
import { env } from '../../config/env.js';

// ============================================================================
// AES-256-GCM para credenciales sensibles (RNDC, futuros: Mintransporte, RUNT)
// ============================================================================
// - Clave maestra: env.RNDC_ENC_KEY (32 bytes hex). Validada al import.
// - IV: 12 bytes random por operación.
// - AuthTag: 16 bytes generados por GCM, almacenado por separado.
// - AAD: discriminador "tabla|columna|empresaNit|aadNonce|keyVersion"
//   donde aadNonce es UUID generado pre-INSERT y persistido junto al cipher.
//   Esto vincula el ciphertext a la fila exacta y previene swap entre filas.
// - Rotación: campo keyVersion permite tener múltiples claves activas.

const KEY_VERSION_CURRENT = 1;

function loadKey(version: number): Buffer {
  if (version === 1) {
    const keyHex = env.RNDC_ENC_KEY;
    if (!keyHex) {
      // En producción es obligatoria. En desarrollo derivamos de PII_ENC_KEY (no usar en prod).
      if (env.NODE_ENV === 'production') {
        throw new Error('RNDC_ENC_KEY es requerido en producción (32 bytes hex)');
      }
      return crypto.createHash('sha256').update(env.PII_ENC_KEY + 'rndc:dev').digest();
    }
    if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
      throw new Error('RNDC_ENC_KEY debe ser 64 hex chars (32 bytes)');
    }
    const buf = Buffer.from(keyHex, 'hex');
    // Validación de entropía mínima: rechazar claves obviamente débiles.
    assertSufficientEntropy(buf);
    return buf;
  }
  throw new Error(`RNDC_ENC_KEY versión ${version} no configurada`);
}

function assertSufficientEntropy(buf: Buffer): void {
  // Rechazar claves con todos los bytes iguales (000... o FFF...).
  if (buf.every((b) => b === buf[0])) {
    throw new Error('RNDC_ENC_KEY rechazada: bytes uniformes (entropía insuficiente)');
  }
  // Calcular Shannon entropy. Una clave random tiene ~7.9 bits/byte.
  const counts = new Array(256).fill(0);
  for (const b of buf) counts[b]++;
  let entropy = 0;
  for (const c of counts) {
    if (c === 0) continue;
    const p = c / buf.length;
    entropy -= p * Math.log2(p);
  }
  if (entropy < 3.5) {
    throw new Error(`RNDC_ENC_KEY rechazada: entropía Shannon ${entropy.toFixed(2)} bits/byte < 3.5`);
  }
}

export interface CipherBundle {
  cipher: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: number;
}

export interface AadParts {
  table: string;
  column: string;
  empresaNit: string;
  aadNonce: string; // UUID
}

function buildAad(parts: AadParts, keyVersion: number): Buffer {
  return Buffer.from(`${parts.table}|${parts.column}|${parts.empresaNit}|${parts.aadNonce}|${keyVersion}`, 'utf8');
}

export function encryptSecret(plaintext: string, aadParts: AadParts): CipherBundle {
  const keyVersion = KEY_VERSION_CURRENT;
  const key = loadKey(keyVersion);
  const iv = crypto.randomBytes(12);
  const aad = buildAad(aadParts, keyVersion);

  const cipherObj = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipherObj.setAAD(aad);
  const cipher = Buffer.concat([cipherObj.update(plaintext, 'utf8'), cipherObj.final()]);
  const authTag = cipherObj.getAuthTag();

  return { cipher, iv, authTag, keyVersion };
}

export function decryptSecret(bundle: CipherBundle, aadParts: AadParts): string {
  const key = loadKey(bundle.keyVersion);
  const aad = buildAad(aadParts, bundle.keyVersion);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, bundle.iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(bundle.authTag);
  return Buffer.concat([decipher.update(bundle.cipher), decipher.final()]).toString('utf8');
}

// ============================================================================
// Tipo Redacted<T>: previene serialización accidental en logs/JSON.stringify
// ============================================================================
// Uso:
//   const claveQR = redact('SECRETO123');
//   logger.info({ payload: { claveQR } });  // → { claveQR: '[REDACTED]' }
//   claveQR.unwrap();                       // → 'SECRETO123' (acceso explícito)

export class Redacted<T> {
  private readonly value: T;
  constructor(value: T) { this.value = value; }
  unwrap(): T { return this.value; }
  toJSON(): string { return '[REDACTED]'; }
  toString(): string { return '[REDACTED]'; }
  // Symbol.for('nodejs.util.inspect.custom') para que `console.log` también lo redacte.
  [Symbol.for('nodejs.util.inspect.custom')](): string { return '[REDACTED]'; }
}

export function redact<T>(value: T): Redacted<T> {
  return new Redacted(value);
}

// Helper para generar UUID v4 (aadNonce y similares).
export function newUuid(): string {
  return crypto.randomUUID();
}

// Helper para hashear request payload (idempotencia).
export function hashRequest(payload: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

// Helper para generar clave de 32 bytes hex (uso: scripts CI o documentación).
// node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
export function generateNewKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

// ============================================================================
// PII (Personally Identifiable Information) — keyspace separado de RNDC
// ============================================================================
// Cifra cédula de conductores, licencia, runtPayload, cuentas bancarias.
// Clave maestra: env.PII_ENC_KEY (passphrase, derivada con scrypt).
// Justificación de keyspace separado: principio de mínimo privilegio (ISO A.9.4).
// Si PII_ENC_KEY se compromete, RNDC sigue protegido y viceversa.

const PII_KEY_VERSION_CURRENT = 1;
const PII_SCRYPT_SALT = 'kyverum-pii-2026';

function loadPiiKey(version: number): Buffer {
  if (version === 1) {
    if (!env.PII_ENC_KEY) throw new Error('PII_ENC_KEY es requerido');
    // scryptSync deriva 32 bytes determinísticamente de la passphrase.
    return crypto.scryptSync(env.PII_ENC_KEY, PII_SCRYPT_SALT, 32);
  }
  throw new Error(`PII_ENC_KEY versión ${version} no configurada`);
}

/**
 * Cifra una cadena PII corta o larga con AES-256-GCM.
 * `aadParts.empresaNit` se reutiliza como `rowKey` (identificador de la fila):
 * para drivers usar `String(userId)`, para manifiestos usar `String(manifiestoId)`.
 * Esto previene swap entre filas (un cipher de fila A no descifra en fila B).
 */
export function encryptPii(plaintext: string, aadParts: AadParts): CipherBundle {
  const keyVersion = PII_KEY_VERSION_CURRENT;
  const key = loadPiiKey(keyVersion);
  const iv = crypto.randomBytes(12);
  const aad = buildAad(aadParts, keyVersion);

  const cipherObj = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipherObj.setAAD(aad);
  const cipher = Buffer.concat([cipherObj.update(plaintext, 'utf8'), cipherObj.final()]);
  const authTag = cipherObj.getAuthTag();

  return { cipher, iv, authTag, keyVersion };
}

export function decryptPii(bundle: CipherBundle, aadParts: AadParts): string {
  const key = loadPiiKey(bundle.keyVersion);
  const aad = buildAad(aadParts, bundle.keyVersion);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, bundle.iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(bundle.authTag);
  return Buffer.concat([decipher.update(bundle.cipher), decipher.final()]).toString('utf8');
}

/**
 * Normaliza un documento (cédula/NIT) eliminando todo lo que no sea dígito.
 * Acepta inputs como "1.036.640.908", " 1036640908 ", "CC 1036640908".
 */
export function normalizeDocument(doc: string): string {
  return String(doc ?? '').trim().replace(/\D/g, '');
}

/**
 * HMAC-SHA256 determinístico para búsqueda exacta de cédula.
 * Clave separada (`PII_HMAC_KEY`) por separación de propósitos:
 * si HMAC_KEY se compromete, no compromete confidencialidad del cipher.
 * Devuelve Buffer de 32 bytes; persistir en columna bytea.
 */
export function hmacCedula(cedula: string): Buffer {
  if (!env.PII_HMAC_KEY) throw new Error('PII_HMAC_KEY es requerido');
  const key = Buffer.from(env.PII_HMAC_KEY, 'hex');
  return crypto.createHmac('sha256', key).update(normalizeDocument(cedula)).digest();
}
