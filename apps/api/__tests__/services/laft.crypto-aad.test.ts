import { describe, it, expect } from 'vitest';
import {
  encryptCounterpartyField,
  decryptCounterpartyField,
  counterpartyDocHash,
} from '../../src/modules/laft/employees/counterparty-pii.js';

// Tests de cifrado/descifrado AES-256-GCM con AAD para columnas PII de
// laft_counterparties. Verifica que:
//  - El bundle JSONB serializa/deserializa correctamente.
//  - El AAD vincula el ciphertext a (table|column|rowId|aadNonce|keyVersion):
//    si cambia rowId o column, decryptPii lanza InvalidTag → devolvemos null.
//  - El HMAC del documento es determinístico y normaliza puntuación.

describe('laft/counterparty-pii — encrypt/decrypt con AAD', () => {
  it('encryptCounterpartyField + decryptCounterpartyField roundtrip', () => {
    const enc = encryptCounterpartyField('1.036.640.908', 'doc_number', 42);
    expect(enc).toBeTruthy();
    expect(enc!.cipher).toMatch(/^[A-Za-z0-9+/=]+$/); // base64
    expect(enc!.iv).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(enc!.authTag).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(enc!.aadNonce).toMatch(/^[0-9a-f-]{36}$/i);
    expect(enc!.keyVersion).toBe(1);

    const back = decryptCounterpartyField(enc, 'doc_number', 42);
    expect(back).toBe('1.036.640.908');
  });

  it('plain null/empty → encryptCounterpartyField devuelve null', () => {
    expect(encryptCounterpartyField(null, 'email', 1)).toBeNull();
    expect(encryptCounterpartyField('', 'email', 1)).toBeNull();
    expect(encryptCounterpartyField(undefined, 'email', 1)).toBeNull();
  });

  it('AAD swap entre filas falla (rowId distinto) → decrypt devuelve null', () => {
    const enc = encryptCounterpartyField('claveSecreta', 'phone', 100);
    expect(enc).toBeTruthy();
    // Mismo bundle pero deciphered con rowId distinto → AAD no matchea.
    const back = decryptCounterpartyField(enc, 'phone', 999);
    expect(back).toBeNull();
  });

  it('AAD swap entre columnas falla (column distinto) → decrypt devuelve null', () => {
    const enc = encryptCounterpartyField('test@kyverum.com', 'email', 5);
    const back = decryptCounterpartyField(enc, 'phone', 5);
    expect(back).toBeNull();
  });

  it('counterpartyDocHash es determinístico y normaliza puntuación', () => {
    const a = counterpartyDocHash('1.036.640.908');
    const b = counterpartyDocHash(' 1036640908 ');
    const c = counterpartyDocHash('CC 1036640908');
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/); // hex 32 bytes
  });

  it('counterpartyDocHash de string vacío → null', () => {
    expect(counterpartyDocHash(null)).toBeNull();
    expect(counterpartyDocHash('')).toBeNull();
    expect(counterpartyDocHash('  ')).toBeNull();
  });

  it('cifrar 2 veces el mismo plaintext genera bundles distintos (IV random)', () => {
    const a = encryptCounterpartyField('mismoTexto', 'doc_number', 7);
    const b = encryptCounterpartyField('mismoTexto', 'doc_number', 7);
    expect(a!.cipher).not.toBe(b!.cipher);
    expect(a!.iv).not.toBe(b!.iv);
    expect(a!.aadNonce).not.toBe(b!.aadNonce);
    // Pero ambos descifran al mismo plaintext.
    expect(decryptCounterpartyField(a, 'doc_number', 7)).toBe('mismoTexto');
    expect(decryptCounterpartyField(b, 'doc_number', 7)).toBe('mismoTexto');
  });
});
