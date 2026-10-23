// HU #13889 (ADR-0028 D5) — cifrado de ARCHIVOS con la clave de PII: ida y vuelta, AAD de otra fila
// y tag alterado. `PII_ENC_KEY` la fija `__tests__/setup.ts`.
import { describe, it, expect } from 'vitest';
import { decryptPiiBuffer, encryptPiiBuffer, type AadParts } from '../../src/shared/utils/crypto.js';

const aad = (id: string): AadParts => ({
  table: 'flito_bolsas_documentos', column: 'archivo', empresaNit: id, aadNonce: '0b6c7f43-6d5e-4d0a-9e3b-5c1f2a7d8e90',
});
const PLANO = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from([0, 1, 2, 255, 254]), Buffer.alloc(4096, 7)]);

describe('encryptPiiBuffer / decryptPiiBuffer', () => {
  it('ida y vuelta: el binario sale idéntico y el texto cifrado no es el original', () => {
    const b = encryptPiiBuffer(PLANO, aad('doc-1'));
    expect(b.cipher.equals(PLANO)).toBe(false);
    expect(b.cipher.includes(Buffer.from('%PDF'))).toBe(false);
    expect(b.iv).toHaveLength(12);
    expect(b.authTag).toHaveLength(16);
    expect(b.keyVersion).toBe(1);
    expect(decryptPiiBuffer(b, aad('doc-1')).equals(PLANO)).toBe(true);
  });

  it('la AAD de otra fila no descifra (no se puede mover el blob a otro documento)', () => {
    const b = encryptPiiBuffer(PLANO, aad('doc-1'));
    expect(() => decryptPiiBuffer(b, aad('doc-2'))).toThrow();
  });

  it('un tag alterado no descifra', () => {
    const b = encryptPiiBuffer(PLANO, aad('doc-1'));
    const tag = Buffer.from(b.authTag);
    tag[0] = tag[0]! ^ 0xff;
    expect(() => decryptPiiBuffer({ ...b, authTag: tag }, aad('doc-1'))).toThrow();
  });

  it('un byte del texto cifrado alterado no descifra', () => {
    const b = encryptPiiBuffer(PLANO, aad('doc-1'));
    const cipher = Buffer.from(b.cipher);
    cipher[10] = cipher[10]! ^ 0x01;
    expect(() => decryptPiiBuffer({ ...b, cipher }, aad('doc-1'))).toThrow();
  });
});
