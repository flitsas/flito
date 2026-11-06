import crypto from 'crypto';
import { env } from '../../config/env.js';
import type { ParAadPii } from './pii-columnas.js';
import { llavePiiMemoizada, pasadaPii } from './pii-keyring.js';

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
      // `PII_ENC_KEY` es opcional desde ADR-0034: concatenar `undefined` daría una llave fija y pública.
      if (!env.PII_ENC_KEY) throw new Error('RNDC_ENC_KEY no está configurada y falta PII_ENC_KEY para derivar el respaldo de desarrollo');
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

/** AAD de los `encrypt*` de PII: tabla y columna del catálogo (ADR-0034 D5, capa 4). */
export type AadPii = Omit<AadParts, 'table' | 'column'> & ParAadPii;

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
// Clave maestra: env.PII_ENC_KEY y `PII_ENC_KEY_V<n>` (passphrases, derivadas con scrypt en `pii-keyring.ts`).
// Justificación de keyspace separado: principio de mínimo privilegio (ISO A.9.4).
// Si PII_ENC_KEY se compromete, RNDC sigue protegido y viceversa.

/** Versión con la que se escribe (ADR-0034 D1). El `?? 1` cubre las suites que mockean `env` entero. */
export function versionVigentePii(): number {
  return env.PII_ENC_KEY_CURRENT_VERSION ?? 1;
}

function loadPiiKey(version: number): Buffer {
  const pasada = pasadaPii(version, env.PII_ENC_KEY);
  if (!pasada) throw new Error(`PII_ENC_KEY versión ${version} no configurada`);
  return llavePiiMemoizada(version, pasada);
}

/**
 * Cifra una cadena PII corta o larga con AES-256-GCM.
 * `aadParts.empresaNit` se reutiliza como `rowKey` (identificador de la fila):
 * para drivers usar `String(userId)`, para manifiestos usar `numero`.
 * Esto previene swap entre filas (un cipher de fila A no descifra en fila B).
 */
export function encryptPii(plaintext: string, aadParts: AadPii): CipherBundle {
  const keyVersion = versionVigentePii();
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
 * HU #13889 (ADR-0028 D5) — Variante BINARIA de `encryptPii` para archivos (documentos de vinculación
 * de la compañía). Misma clave (`PII_ENC_KEY`), misma AAD ligada a la fila y mismo AES-256-GCM; solo
 * cambia que el texto en claro es un `Buffer` y no una cadena utf8.
 */
export function encryptPiiBuffer(plain: Buffer, aadParts: AadPii): CipherBundle {
  const keyVersion = versionVigentePii();
  const key = loadPiiKey(keyVersion);
  const iv = crypto.randomBytes(12);
  const cipherObj = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipherObj.setAAD(buildAad(aadParts, keyVersion));
  const cipher = Buffer.concat([cipherObj.update(plain), cipherObj.final()]);
  return { cipher, iv, authTag: cipherObj.getAuthTag(), keyVersion };
}

/** Inversa de `encryptPiiBuffer`. Lanza si la AAD no es la de la fila o el tag no cuadra. */
export function decryptPiiBuffer(bundle: CipherBundle, aadParts: AadParts): Buffer {
  const key = loadPiiKey(bundle.keyVersion);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, bundle.iv);
  decipher.setAAD(buildAad(aadParts, bundle.keyVersion));
  decipher.setAuthTag(bundle.authTag);
  return Buffer.concat([decipher.update(bundle.cipher), decipher.final()]);
}

// ============================================================================
// PII en una sola columna de texto (Feature #14097, HU #14098 y #14099)
// ============================================================================
// Para columnas `text` donde no caben iv/tag/keyVersion por separado. Formato:
//   v<keyVersion>:<iv 24 hex>:<tag 32 hex>:<data base64>
// AAD exacta `tabla|columna|id`: un valor copiado a otra fila o a otra columna no descifra.

/** Contexto que liga el valor a su celda. Es la AAD y, si falla, lo único que dice el error. */
export interface PiiTextContext {
  table: string;
  column: string;
  id: string | number;
}

/** Prefijo del formato vigente. Es el contrato con el clasificador de fotos: una sola definición. */
export const PII_TEXT_PREFIJO = /^v(\d+):([0-9a-f]{24}):([0-9a-f]{32}):/;

/**
 * Forma del formato anterior `iv:tag:data`, retirado en la HU #14273. Ya no hay con qué descifrarlo: se
 * conserva solo para reconocer un valor restaurado de un dump y tratarlo como fallo, no como dato legado.
 */
export const PII_BIOMETRICO_VIEJO_PREFIJO = /^([0-9a-fA-F]{32}):([0-9a-fA-F]{32}):/;

/**
 * Fallo al descifrar. El mensaje es constante y no lleva `cause` a propósito: lo que se serializa
 * de este error termina en logs y el detalle de la primitiva no aporta nada que justifique el riesgo.
 */
export class PiiDecryptError extends Error {
  readonly table: string;
  readonly column: string;
  readonly id: string | number;

  constructor(ctx: PiiTextContext) {
    super('No se pudo descifrar el dato protegido');
    this.name = 'PiiDecryptError';
    this.table = ctx.table;
    this.column = ctx.column;
    this.id = ctx.id;
  }
}

function aadPiiText(ctx: PiiTextContext): Buffer {
  return Buffer.from(`${ctx.table}|${ctx.column}|${ctx.id}`, 'utf8');
}

/**
 * `Buffer.from(x, 'base64')` ignora en silencio lo que no entiende, y una cola corrupta llegaría a
 * GCM como otro texto. Se exige la forma canónica; sin regex porque la cola puede medir varios MB.
 */
function base64Estricto(cola: string): Buffer {
  const datos = Buffer.from(cola, 'base64');
  if (datos.toString('base64') !== cola) throw new Error('base64 inválido');
  return datos;
}

/**
 * Cifra texto con una versión elegida por quien llama. Solo para el canario del registro de llaves
 * (ADR-0034 D2), que ancla cada versión aunque no sea la vigente. Los datos van por `encryptPiiText`.
 */
export function encryptPiiTextConVersion(plain: string, ctx: PiiTextContext, version: number): string {
  const key = loadPiiKey(version);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aadPiiText(ctx));
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v${version}:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${data.toString('base64')}`;
}

/** Cifra texto ligado a su celda con la versión vigente. Lo escribe el script de recifrado, no las rutas. */
export function encryptPiiText(plain: string, ctx: Omit<PiiTextContext, 'table' | 'column'> & ParAadPii): string {
  return encryptPiiTextConVersion(plain, ctx, versionVigentePii());
}

/** Cualquier fallo sale como `PiiDecryptError`, nunca con el valor. */
function abrirPiiText(value: string, ctx: PiiTextContext, llaveDe: (version: number) => Buffer): string {
  try {
    const m = PII_TEXT_PREFIJO.exec(value);
    if (!m) throw new Error('formato');
    const key = llaveDe(Number(m[1]));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(m[2], 'hex'), { authTagLength: 16 });
    decipher.setAAD(aadPiiText(ctx));
    decipher.setAuthTag(Buffer.from(m[3], 'hex'));
    const data = base64Estricto(value.slice(m[0].length));
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    throw new PiiDecryptError(ctx);
  }
}

/** Inversa de `encryptPiiText`. */
export function decryptPiiText(value: string, ctx: PiiTextContext): string {
  return abrirPiiText(value, ctx, loadPiiKey);
}

/** Descifra con una llave dada y no con la de la versión del valor: detecta una llave retirada reutilizada. */
export function decryptPiiTextConLlave(value: string, ctx: PiiTextContext, llave: Buffer): string {
  return abrirPiiText(value, ctx, () => llave);
}

// ============================================================================
// Siigo — keyspace separado de RNDC y de PII (HU #11247)
// ============================================================================
// Cifra el `access_key` de la credencial de Siigo API. Keyspace propio por el mismo
// principio de mínimo privilegio que separa RNDC de PII: si SIIGO_ENC_KEY se compromete,
// ni RNDC ni la PII de conductores quedan expuestos.
//
// A DIFERENCIA de loadKey() (RNDC), aquí NO hay derivación de respaldo en desarrollo.
// Es deliberado: la HU exige que sin llave maestra la operación falle con un error de
// configuración explícito. Una derivación silenciosa dejaría credenciales cifradas con una
// clave distinta según el entorno, y al configurar la real dejarían de descifrar.

const SIIGO_KEY_VERSION_CURRENT = 1;

/** Error de configuración: distingue «falta configurar» de «falló el cifrado». */
export class SiigoEncKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SiigoEncKeyError';
  }
}

function loadSiigoKey(version: number): Buffer {
  if (version !== SIIGO_KEY_VERSION_CURRENT) {
    throw new SiigoEncKeyError(`SIIGO_ENC_KEY versión ${version} no configurada`);
  }
  const keyHex = env.SIIGO_ENC_KEY;
  if (!keyHex) {
    throw new SiigoEncKeyError(
      'SIIGO_ENC_KEY no está configurada: la integración con Siigo no puede cifrar ni descifrar credenciales. '
      + 'Defínela con 64 caracteres hexadecimales (32 bytes).',
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new SiigoEncKeyError('SIIGO_ENC_KEY debe ser 64 hex chars (32 bytes)');
  }
  const buf = Buffer.from(keyHex, 'hex');
  assertSufficientEntropy(buf);
  return buf;
}

/** true si la llave maestra de Siigo está presente y es válida. No lanza. */
export function siigoEncKeyDisponible(): boolean {
  try {
    loadSiigoKey(SIIGO_KEY_VERSION_CURRENT);
    return true;
  } catch {
    return false;
  }
}

export function encryptSiigoSecret(plaintext: string, aadParts: AadParts): CipherBundle {
  const keyVersion = SIIGO_KEY_VERSION_CURRENT;
  const key = loadSiigoKey(keyVersion);
  const iv = crypto.randomBytes(12);
  const aad = buildAad(aadParts, keyVersion);

  const cipherObj = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipherObj.setAAD(aad);
  const cipher = Buffer.concat([cipherObj.update(plaintext, 'utf8'), cipherObj.final()]);
  const authTag = cipherObj.getAuthTag();

  return { cipher, iv, authTag, keyVersion };
}

export function decryptSiigoSecret(bundle: CipherBundle, aadParts: AadParts): string {
  const key = loadSiigoKey(bundle.keyVersion);
  const aad = buildAad(aadParts, bundle.keyVersion);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, bundle.iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(bundle.authTag);
  return Buffer.concat([decipher.update(bundle.cipher), decipher.final()]).toString('utf8');
}

// ============================================================================
// Comparendos — keyspace propio del token SIMIT (Feature #11492 17a, HU #11498)
// ============================================================================
// Cifra el token de Verifik/SIMIT que vive en `flito_comparendos_token_simit`. Llave dedicada
// `COMPARENDOS_ENC_KEY` (ADR-0002), NO derivada de SIIGO_ENC_KEY ni de RNDC_ENC_KEY: por mínimo
// privilegio, comprometer una integración no debe comprometer las otras, y cada dominio rota su
// llave a su ritmo.
//
// Igual que Siigo —y a diferencia de RNDC— aquí NO hay derivación de respaldo en desarrollo. Es
// deliberado: derivar en silencio dejaría el token cifrado con una clave distinta según el entorno
// y, el día que se provisionara la real, dejaría de descifrar. El síntoma (el sync falla contra
// Verifik) no se parecería en nada a la causa (la llave del entorno).

const COMPARENDOS_KEY_VERSION_CURRENT = 1;

/** Error de configuración del entorno: distingue «falta la llave» de «falló el cifrado». */
export class ComparendosEncKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComparendosEncKeyError';
  }
}

function loadComparendosKey(version: number): Buffer {
  if (version !== COMPARENDOS_KEY_VERSION_CURRENT) {
    throw new ComparendosEncKeyError(`COMPARENDOS_ENC_KEY versión ${version} no configurada`);
  }
  const keyHex = env.COMPARENDOS_ENC_KEY;
  if (!keyHex) {
    throw new ComparendosEncKeyError(
      'COMPARENDOS_ENC_KEY no está configurada: el token SIMIT no puede cifrarse ni descifrarse. '
      + 'Defínela con 64 caracteres hexadecimales (32 bytes).',
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new ComparendosEncKeyError('COMPARENDOS_ENC_KEY debe ser 64 hex chars (32 bytes)');
  }
  const buf = Buffer.from(keyHex, 'hex');
  // Mismo filtro de entropía que RNDC y Siigo: una llave de bytes uniformes («000…», «fff…») pasa el
  // regex y cifra sin quejarse, y eso es exactamente lo que hay que rechazar antes de guardar nada.
  //
  // Se envuelve por dos motivos: el helper es compartido y sus mensajes nombran a RNDC_ENC_KEY
  // —decirle a quien opera que revise la variable equivocada es peor que no decir nada—, y lanza un
  // `Error` pelado, que la ruta no sabría distinguir de un fallo interno y saldría como 500 en vez
  // del 503 de configuración que es.
  try {
    assertSufficientEntropy(buf);
  } catch (e) {
    const detalle = e instanceof Error ? e.message.replace(/^RNDC_ENC_KEY rechazada: /, '') : String(e);
    throw new ComparendosEncKeyError(`COMPARENDOS_ENC_KEY rechazada: ${detalle}`);
  }
  return buf;
}

export function encryptComparendosSecret(plaintext: string, aadParts: AadParts): CipherBundle {
  const keyVersion = COMPARENDOS_KEY_VERSION_CURRENT;
  const key = loadComparendosKey(keyVersion);
  const iv = crypto.randomBytes(12);
  const aad = buildAad(aadParts, keyVersion);

  const cipherObj = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipherObj.setAAD(aad);
  const cipher = Buffer.concat([cipherObj.update(plaintext, 'utf8'), cipherObj.final()]);
  const authTag = cipherObj.getAuthTag();

  return { cipher, iv, authTag, keyVersion };
}

export function decryptComparendosSecret(bundle: CipherBundle, aadParts: AadParts): string {
  const key = loadComparendosKey(bundle.keyVersion);
  const aad = buildAad(aadParts, bundle.keyVersion);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, bundle.iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(bundle.authTag);
  return Buffer.concat([decipher.update(bundle.cipher), decipher.final()]).toString('utf8');
}

// ============================================================================
// FLIT 2 — keyspace propio de la contraseña del usuario de servicio (Feature #13057, HU #13061)
// ============================================================================
// Cifra `secret_cipher` de `flito_sync_flit2_acceso` con la llave dedicada `FLIT2_ENC_KEY`. Mismo
// criterio que Comparendos (ADR-0002): mínimo privilegio y SIN derivación de respaldo en desarrollo.

const FLIT2_KEY_VERSION_CURRENT = 1;

/** Error de configuración del entorno: distingue «falta la llave» de «falló el cifrado». */
export class Flit2EncKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Flit2EncKeyError';
  }
}

function loadFlit2Key(version: number): Buffer {
  if (version !== FLIT2_KEY_VERSION_CURRENT) {
    throw new Flit2EncKeyError(`FLIT2_ENC_KEY versión ${version} no configurada`);
  }
  const hexLlave = env.FLIT2_ENC_KEY;
  if (!hexLlave) {
    throw new Flit2EncKeyError(
      'FLIT2_ENC_KEY no está configurada: el acceso a FLIT 2 no puede cifrarse ni descifrarse. '
      + 'Defínela con 64 caracteres hexadecimales (32 bytes).',
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hexLlave)) {
    throw new Flit2EncKeyError('FLIT2_ENC_KEY debe ser 64 hex chars (32 bytes)');
  }
  const buf = Buffer.from(hexLlave, 'hex');
  // Mismo filtro de entropía que Comparendos, envuelto para no nombrar RNDC_ENC_KEY en el mensaje.
  try {
    assertSufficientEntropy(buf);
  } catch (e) {
    const detalle = e instanceof Error ? e.message.replace(/^RNDC_ENC_KEY rechazada: /, '') : String(e);
    throw new Flit2EncKeyError(`FLIT2_ENC_KEY rechazada: ${detalle}`);
  }
  return buf;
}

export function encryptFlit2Secret(plaintext: string, aadParts: AadParts): CipherBundle {
  const keyVersion = FLIT2_KEY_VERSION_CURRENT;
  const key = loadFlit2Key(keyVersion);
  const iv = crypto.randomBytes(12);
  const cipherObj = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipherObj.setAAD(buildAad(aadParts, keyVersion));
  const cipher = Buffer.concat([cipherObj.update(plaintext, 'utf8'), cipherObj.final()]);
  return { cipher, iv, authTag: cipherObj.getAuthTag(), keyVersion };
}

export function decryptFlit2Secret(bundle: CipherBundle, aadParts: AadParts): string {
  const key = loadFlit2Key(bundle.keyVersion);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, bundle.iv);
  decipher.setAAD(buildAad(aadParts, bundle.keyVersion));
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

// ── Identificadores de VEHÍCULO seudonimizados (ADR-0012, HU #12090) ────────────────────────────
//
// El canal Cliente de SOAT consulta el RUNT **solo por VIN**, y el registro del artículo 17
// (`pii_access_log`) tenía que poder responder «¿qué líneas afectan a este vehículo?» sin guardar el
// VIN. Se guarda un HMAC en `motivo`. El porqué entero está en
// `docs/adr/ADR-0012-flito-soat-hmac-vin-en-pii-access-log.md`; aquí vive la primitiva.

/**
 * **`hmacCedula` NO SIRVE para un VIN ni para una placa, y por eso existe todo este bloque.**
 *
 * Aplica `normalizeDocument()` por dentro, que es `replace(/\D/g,'')` — **solo dígitos**—, así que
 * sobre un identificador de vehículo borra todas las letras. Medido con la clave real de la suite:
 *
 *     normalizeDocument('9FKRG2222T2042405') → '922222042405'
 *     normalizeDocument('9FKRG2222X2042405') → '922222042405'
 *     hmacCedula(A) === hmacCedula(B)        →  true
 *
 * Dos VIN distintos, el MISMO hash. Y no es un caso de laboratorio: son los VIN consecutivos de una
 * flota, que es justo lo que este rastro existe para poder distinguir. Un registro de acceso que
 * empareja el vehículo de un titular con el de otro es PEOR que no tener correlación, porque nadie
 * sabe que hay que desconfiar de él.
 *
 * De ahí las dos diferencias de `hmacIdentificadorVehiculo`:
 *
 *   1. **Normalización ALFANUMÉRICA** (`toUpperCase()` + `[^A-Z0-9]`), la misma regla que
 *      `normalizarId` del canal — la que decide lo que sale hacia Kyverum y lo que se persiste—, de
 *      modo que `'9FKRG-2222-T2042405'` y `'9fkrg2222t2042405'` den el MISMO token. Si el HMAC se
 *      calculara sobre una forma y se buscara sobre otra, el registro sería inútil sin que nadie lo
 *      notara.
 *   2. **Etiqueta de dominio** (`'vin:'` / `'placa:'`) delante del valor. Sin ella, un VIN compuesto
 *      solo de dígitos podría colisionar con la cédula de esos mismos dígitos —comparten clave— y
 *      una placa con un VIN que se normalizara igual. Es una garantía estructural y barata que no
 *      depende de que los valores reales lleven letras.
 *
 * Comparte `PII_HMAC_KEY` con `hmacCedula` y no inventa una variable de entorno nueva: es el criterio
 * que ya sentó `counterpartyDocHash` («reusa `hmacCedula()` para no inventar otra key»), y la
 * separación entre dominios la da la etiqueta, no la clave.
 */
function hmacIdentificadorVehiculo(dominio: 'vin' | 'placa', valor: string): string {
  if (!env.PII_HMAC_KEY) throw new Error('PII_HMAC_KEY es requerido');
  const key = Buffer.from(env.PII_HMAC_KEY, 'hex');
  const normalizado = String(valor ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return crypto.createHmac('sha256', key).update(`${dominio}:${normalizado}`).digest('hex');
}

/** HMAC-SHA256 del VIN normalizado, en hex. Ver {@link hmacIdentificadorVehiculo}. */
export function hmacVin(vin: string): string {
  return hmacIdentificadorVehiculo('vin', vin);
}

/** HMAC-SHA256 de la placa normalizada, en hex. Dominio distinto del VIN: nunca colisionan. */
export function hmacPlaca(placa: string): string {
  return hmacIdentificadorVehiculo('placa', placa);
}

/**
 * Versión de la clave con la que se escribió un token, EN BANDA (ADR-0012 §4).
 *
 * Cuesta tres caracteres y es lo único que separa «rotar `PII_HMAC_KEY`» de «perder retroactivamente
 * seis años de correlación» (esa es la retención declarada de `pii_access_log`). Con la versión
 * escrita en la fila, una búsqueda posterior calcula el token con cada clave conocida y hace `OR` de
 * los prefijos; sin ella, las filas viejas quedan mudas para siempre.
 *
 * Es una constante de CÓDIGO y no una variable de entorno, igual que `COMPARENDOS_KEY_VERSION_CURRENT`:
 * estrenar una `v2` tiene que ser un cambio de código con su ADR, no un despiste de despliegue.
 *
 * **No existe hoy una política de rotación de `PII_HMAC_KEY`** y este bloque no la inventa: queda
 * como deuda con dueño humano (ADR-0012 §8.4). Rotarla hoy ya rompe `driver_profile.cedula_hash`,
 * `laft_counterparties.doc_number_hash` y el emparejamiento de `POST /privacy/forget` (art. 15), que
 * son problemas mayores y anteriores a este ADR.
 */
export const PII_HMAC_VERSION_ACTUAL = 1;

/**
 * Cuántos caracteres hex del HMAC se guardan. **128 bits**, no los 256 completos.
 *
 * `pii_access_log.motivo` es `varchar(200)` y ahí conviven DOS tokens (VIN y placa) más la prosa que
 * ya estaba. Medido: con los dos a 64 hex el motivo mide 227 y NO cabe; a 32 hex mide 163 y sobran
 * 37. 128 bits son de sobra para un token de búsqueda cuyo espacio de entrada son los VIN de un
 * país, y el repo ya trunca un sha256 a 64 bits en `privacy.routes.ts`. El truncado vive AQUÍ y en un
 * solo sitio: quien escribe y quien busca tienen que recortar igual o no se encuentran.
 */
const PII_HMAC_HEX_TOKEN = 32;

/**
 * El token tal como se GUARDA: `v<version>:<hex truncado>`.
 *
 * Se exporta la forma final y no solo el hash porque la forma final ES el contrato: el buscador
 * recompone el token con esta misma función y compara por prefijo. Si el truncado o el prefijo
 * vivieran en el llamador, escritor y lector podrían discrepar sin que nada se pusiera rojo — el
 * mismo argumento por el que el piso del VIN y la consulta a Kyverum comparten `normalizarId`.
 */
export function tokenPii(hmacHex: string): string {
  return `v${PII_HMAC_VERSION_ACTUAL}:${hmacHex.slice(0, PII_HMAC_HEX_TOKEN)}`;
}
