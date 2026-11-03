// Feature #14097 (HU #14098 AC1/AC2, #14099 AC1) — helper común de PII en columna de texto.
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
import {
  decryptLegacyBiometric,
  decryptPiiText,
  encryptPiiText,
  PiiDecryptError,
} from '../../src/shared/utils/crypto.js';

const CTX = { table: 'tramites_validaciones', column: 'foto_rostro', id: 7 };
const FOTO = 'data:image/jpeg;base64,QUJDREVGRw==';
const envMutable = env as { PII_ENC_KEY: string };
const LLAVE_ORIGINAL = env.PII_ENC_KEY;

/** Réplica del `encryptPII` retirado de identidad.routes: el formato que sigue en las filas viejas. */
function cifrarFormatoViejo(plano: string, passphrase: string): string {
  const key = crypto.scryptSync(passphrase, 'kyverum-pii-salt', 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plano, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${data.toString('base64')}`;
}

function errorDe(fn: () => unknown): unknown {
  try { fn(); } catch (e) { return e; }
  throw new Error('se esperaba que lanzara');
}

beforeEach(() => { envMutable.PII_ENC_KEY = LLAVE_ORIGINAL; });
afterEach(() => { envMutable.PII_ENC_KEY = LLAVE_ORIGINAL; });

describe('encryptPiiText / decryptPiiText', () => {
  it('ida y vuelta con el formato v<version>:<iv>:<tag>:<base64>', () => {
    const cifrado = encryptPiiText(FOTO, CTX);
    expect(cifrado).toMatch(/^v1:[0-9a-f]{24}:[0-9a-f]{32}:[A-Za-z0-9+/]+={0,2}$/);
    expect(cifrado).not.toContain('QUJDREVGRw');
    expect(decryptPiiText(cifrado, CTX)).toBe(FOTO);
  });

  it('dos cifrados del mismo texto son distintos (IV aleatorio)', () => {
    expect(encryptPiiText(FOTO, CTX)).not.toBe(encryptPiiText(FOTO, CTX));
  });

  it.each([
    ['otra fila', { ...CTX, id: 8 }],
    ['otra columna', { ...CTX, column: 'foto_cedula_frontal' }],
    ['otra tabla', { ...CTX, table: 'otra_tabla' }],
  ])('el AAD de %s no descifra', (_nombre, otro) => {
    expect(() => decryptPiiText(encryptPiiText(FOTO, CTX), otro)).toThrow(PiiDecryptError);
  });

  it('el id entra al AAD tal cual: 7 y "7" son la misma celda', () => {
    expect(decryptPiiText(encryptPiiText(FOTO, CTX), { ...CTX, id: '7' })).toBe(FOTO);
  });

  it('con otra llave falla, y al volver a la llave original descifra (el memo no se queda pegado)', () => {
    const cifrado = encryptPiiText(FOTO, CTX);
    envMutable.PII_ENC_KEY = 'otra-llave-otra-llave-otra-llave-otra-1234';
    expect(() => decryptPiiText(cifrado, CTX)).toThrow(PiiDecryptError);
    envMutable.PII_ENC_KEY = LLAVE_ORIGINAL;
    expect(decryptPiiText(cifrado, CTX)).toBe(FOTO);
  });

  it('versión de llave desconocida → PiiDecryptError', () => {
    const cifrado = encryptPiiText(FOTO, CTX).replace(/^v1:/, 'v9:');
    expect(() => decryptPiiText(cifrado, CTX)).toThrow(PiiDecryptError);
  });

  it('cola base64 inválida → PiiDecryptError', () => {
    const cifrado = encryptPiiText(FOTO, CTX);
    expect(() => decryptPiiText(`${cifrado}!!`, CTX)).toThrow(PiiDecryptError);
  });

  it('valor sin el formato → PiiDecryptError', () => {
    expect(() => decryptPiiText('v1: hola', CTX)).toThrow(PiiDecryptError);
  });
});

describe('PiiDecryptError no expone el dato', () => {
  it('mensaje constante, sin cause, solo con el dónde', () => {
    const cifrado = encryptPiiText(FOTO, CTX);
    const a = errorDe(() => decryptPiiText(cifrado, { ...CTX, id: 8 })) as PiiDecryptError;
    const b = errorDe(() => decryptPiiText('v9:x', CTX)) as PiiDecryptError;

    expect(a).toBeInstanceOf(PiiDecryptError);
    expect(a.message).toBe(b.message);
    expect(a.message).not.toContain(cifrado);
    expect(a.cause).toBeUndefined();
    expect(a.stack).not.toContain(cifrado);
    expect({ table: a.table, column: a.column, id: a.id }).toEqual({ ...CTX, id: 8 });
    expect(JSON.stringify(a)).not.toContain(cifrado);
  });
});

describe('decryptLegacyBiometric (formato viejo, @deprecated)', () => {
  it('sigue leyendo iv:tag:data con la sal kyverum-pii-salt', () => {
    expect(decryptLegacyBiometric(cifrarFormatoViejo(FOTO, LLAVE_ORIGINAL), CTX)).toBe(FOTO);
  });

  it('con otra llave → PiiDecryptError que no contiene el valor', () => {
    const viejo = cifrarFormatoViejo(FOTO, 'otra-llave-otra-llave-otra-llave-otra-1234');
    const e = errorDe(() => decryptLegacyBiometric(viejo, CTX)) as PiiDecryptError;
    expect(e).toBeInstanceOf(PiiDecryptError);
    expect(e.message).not.toContain(viejo);
  });

  it('un valor del formato nuevo no se lee como viejo', () => {
    expect(() => decryptLegacyBiometric(encryptPiiText(FOTO, CTX), CTX)).toThrow(PiiDecryptError);
  });
});
