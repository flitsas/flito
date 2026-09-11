import { describe, it, expect } from 'vitest';
import {
  encryptSecret, decryptSecret,
  encryptPii, decryptPii,
  Redacted, redact,
  newUuid, hashRequest, generateNewKey,
  normalizeDocument, hmacCedula,
  hmacVin, hmacPlaca, tokenPii, PII_HMAC_VERSION_ACTUAL,
  type AadParts, type CipherBundle,
} from '../../src/shared/utils/crypto.js';

const AAD_BASE: AadParts = {
  table: 'manifiestos',
  column: 'titular_pago_cuenta',
  empresaNit: '900123456',
  aadNonce: 'uuid-row-001',
};

describe('crypto — encryptSecret/decryptSecret (RNDC keyspace)', () => {
  it('roundtrip: encrypt → decrypt devuelve plaintext original', () => {
    const plain = 'super-secret-clave-qr-aulapp-2026';
    const bundle = encryptSecret(plain, AAD_BASE);
    expect(bundle.cipher.length).toBeGreaterThan(0);
    expect(bundle.iv.length).toBe(12);
    expect(bundle.authTag.length).toBe(16);
    expect(bundle.keyVersion).toBe(1);

    const decrypted = decryptSecret(bundle, AAD_BASE);
    expect(decrypted).toBe(plain);
  });

  it('IV único: dos ciphers del mismo plaintext + AAD producen IV/cipher distintos', () => {
    const plain = 'mismo-secreto';
    const a = encryptSecret(plain, AAD_BASE);
    const b = encryptSecret(plain, AAD_BASE);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.cipher.equals(b.cipher)).toBe(false);
    // ambos descifran al mismo plaintext
    expect(decryptSecret(a, AAD_BASE)).toBe(plain);
    expect(decryptSecret(b, AAD_BASE)).toBe(plain);
  });

  it('swap protection: cipher de fila A NO descifra con AAD de fila B', () => {
    const plain = 'secreto-fila-A';
    const aadA = { ...AAD_BASE, aadNonce: 'uuid-row-A' };
    const aadB = { ...AAD_BASE, aadNonce: 'uuid-row-B' };
    const bundle = encryptSecret(plain, aadA);
    expect(() => decryptSecret(bundle, aadB)).toThrow();
  });

  it('swap protection: cambiar empresaNit (rowKey) en AAD → falla descifrado', () => {
    const bundle = encryptSecret('x', AAD_BASE);
    expect(() => decryptSecret(bundle, { ...AAD_BASE, empresaNit: '999999999' })).toThrow();
  });

  it('tampering: alterar authTag → falla descifrado', () => {
    const bundle = encryptSecret('x', AAD_BASE);
    const tampered: CipherBundle = {
      ...bundle,
      authTag: Buffer.from(bundle.authTag).map((b, i) => i === 0 ? b ^ 0xff : b) as Buffer,
    };
    expect(() => decryptSecret(tampered, AAD_BASE)).toThrow();
  });

  it('tampering: alterar 1 byte del cipher → falla descifrado', () => {
    const bundle = encryptSecret('payload-largo-para-tener-multiples-bytes', AAD_BASE);
    const corrupt = Buffer.from(bundle.cipher);
    corrupt[0] = corrupt[0]! ^ 0x01;
    expect(() => decryptSecret({ ...bundle, cipher: corrupt }, AAD_BASE)).toThrow();
  });

  it('rechaza keyVersion no configurada', () => {
    const bundle = encryptSecret('x', AAD_BASE);
    expect(() => decryptSecret({ ...bundle, keyVersion: 99 }, AAD_BASE)).toThrow(/versión 99/);
  });
});

describe('crypto — encryptPii/decryptPii (PII keyspace separado)', () => {
  it('roundtrip básico cifra cédula y descifra correctamente', () => {
    const cedula = '1036640908';
    const aad: AadParts = { table: 'users', column: 'cedula', empresaNit: '42', aadNonce: 'uuid-u-42' };
    const bundle = encryptPii(cedula, aad);
    expect(bundle.keyVersion).toBe(1);
    expect(decryptPii(bundle, aad)).toBe(cedula);
  });

  it('keyspaces separados: cipher generado con encryptPii NO descifra con decryptSecret', () => {
    const aad: AadParts = { table: 'users', column: 'cedula', empresaNit: '42', aadNonce: 'uuid-u-42' };
    const bundle = encryptPii('cedula-secreta', aad);
    expect(() => decryptSecret(bundle, aad)).toThrow();
  });

  it('keyspaces separados: cipher generado con encryptSecret NO descifra con decryptPii', () => {
    const bundle = encryptSecret('rndc-claveQR', AAD_BASE);
    expect(() => decryptPii(bundle, AAD_BASE)).toThrow();
  });

  it('PII swap protection: cambiar aadNonce entre filas → throw', () => {
    const aadA: AadParts = { table: 'manifiestos', column: 'titular_pago_cuenta', empresaNit: '5', aadNonce: 'a' };
    const aadB: AadParts = { table: 'manifiestos', column: 'titular_pago_cuenta', empresaNit: '5', aadNonce: 'b' };
    const bundle = encryptPii('cuenta-AA', aadA);
    expect(() => decryptPii(bundle, aadB)).toThrow();
  });

  it('PII soporta strings unicode/largos (>32 bytes)', () => {
    const long = 'á'.repeat(500) + '中文-русский-עברית';
    const aad: AadParts = { table: 'x', column: 'y', empresaNit: 'z', aadNonce: 'q' };
    const bundle = encryptPii(long, aad);
    expect(decryptPii(bundle, aad)).toBe(long);
  });
});

describe('crypto — Redacted<T> y redact()', () => {
  it('toJSON devuelve [REDACTED]', () => {
    const r = redact('topsecret');
    expect(JSON.stringify({ pwd: r })).toBe('{"pwd":"[REDACTED]"}');
  });

  it('toString devuelve [REDACTED]', () => {
    const r = redact('topsecret');
    expect(String(r)).toBe('[REDACTED]');
    expect(`${r}`).toBe('[REDACTED]');
  });

  it('util.inspect.custom devuelve [REDACTED]', () => {
    const r = redact('topsecret');
    const customSym = Symbol.for('nodejs.util.inspect.custom');
    expect((r as any)[customSym]()).toBe('[REDACTED]');
  });

  it('unwrap() devuelve el valor original (acceso explícito requerido)', () => {
    const r = redact('topsecret');
    expect(r.unwrap()).toBe('topsecret');
  });

  it('Redacted soporta tipos no-string', () => {
    const r = redact({ key: 'k', token: 't' });
    expect(JSON.stringify(r)).toBe('"[REDACTED]"');
    expect(r.unwrap()).toEqual({ key: 'k', token: 't' });
  });

  it('Redacted nuevo via constructor también redacta', () => {
    const r = new Redacted(42);
    expect(JSON.stringify(r)).toBe('"[REDACTED]"');
    expect(r.unwrap()).toBe(42);
  });
});

describe('crypto — newUuid', () => {
  it('genera UUID v4 con formato correcto', () => {
    const u = newUuid();
    expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('100 UUIDs son únicos', () => {
    const set = new Set(Array.from({ length: 100 }, () => newUuid()));
    expect(set.size).toBe(100);
  });
});

describe('crypto — hashRequest', () => {
  it('hash estable para mismo payload', () => {
    const a = hashRequest({ x: 1, y: 'a' });
    const b = hashRequest({ x: 1, y: 'a' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hash distinto para payload distinto', () => {
    const a = hashRequest({ x: 1 });
    const b = hashRequest({ x: 2 });
    expect(a).not.toBe(b);
  });

  it('NOTA: el orden de keys cambia el hash (limitación documentada de JSON.stringify)', () => {
    // Esto NO es estrictamente correcto si quieres idempotencia robusta — el caller
    // debería normalizar el payload antes. Documentamos el comportamiento actual:
    const a = hashRequest({ a: 1, b: 2 });
    const b = hashRequest({ b: 2, a: 1 });
    expect(a).not.toBe(b); // <- limitación
  });
});

describe('crypto — generateNewKey', () => {
  it('devuelve 64 hex chars (32 bytes)', () => {
    const k = generateNewKey();
    expect(k).toMatch(/^[0-9a-f]{64}$/);
  });

  it('claves consecutivas son distintas', () => {
    expect(generateNewKey()).not.toBe(generateNewKey());
  });
});

describe('crypto — normalizeDocument', () => {
  it('limpia puntos y espacios', () => {
    expect(normalizeDocument('1.036.640.908')).toBe('1036640908');
    expect(normalizeDocument(' 1036640908 ')).toBe('1036640908');
  });

  it('quita prefijos como "CC "', () => {
    expect(normalizeDocument('CC 1036640908')).toBe('1036640908');
    expect(normalizeDocument('NIT 900.123.456-1')).toBe('9001234561');
  });

  it('null/undefined safety', () => {
    expect(normalizeDocument(null as any)).toBe('');
    expect(normalizeDocument(undefined as any)).toBe('');
    expect(normalizeDocument('')).toBe('');
  });

  it('inputs sin dígitos → string vacío', () => {
    expect(normalizeDocument('abc-xyz')).toBe('');
  });
});

describe('crypto — hmacCedula', () => {
  it('determinístico: misma cédula → mismo HMAC', () => {
    const a = hmacCedula('1036640908');
    const b = hmacCedula('1036640908');
    expect(a.equals(b)).toBe(true);
    expect(a.length).toBe(32); // SHA-256 = 32 bytes
  });

  it('cédulas distintas → HMACs distintos', () => {
    const a = hmacCedula('1036640908');
    const b = hmacCedula('1036640909');
    expect(a.equals(b)).toBe(false);
  });

  it('aplica normalizeDocument antes de hashear (mismo HMAC para "CC 1.036.640.908" y "1036640908")', () => {
    const noisy = hmacCedula('CC 1.036.640.908');
    const clean = hmacCedula('1036640908');
    expect(noisy.equals(clean)).toBe(true);
  });

  it('cédula vacía produce HMAC válido (no throw, normaliza a "")', () => {
    const h = hmacCedula('');
    expect(h.length).toBe(32);
  });
});

// ── Identificadores de VEHÍCULO seudonimizados (ADR-0012, HU #12090) ────────────────────────────

describe('crypto — hmacVin / hmacPlaca: por qué NO se reutiliza hmacCedula', () => {
  const VIN = '9FKRG2222T2042405';
  /** El mismo VIN con UNA letra distinta: el vecino de flota. */
  const VIN_VECINO = '9FKRG2222X2042405';

  it('**dos VIN que difieren SOLO en una letra dan HMAC distintos**', () => {
    // El caso que existe todo este bloque para cerrar. `hmacCedula` normaliza con
    // `replace(/\D/g,'')` —solo dígitos—, así que sobre un VIN borra las letras y estos dos
    // colisionan. Un registro de acceso que empareja el vehículo de un titular con el de otro es
    // peor que no tener correlación. El mutante que mata: cambiar `hmacVin` por `hmacCedula`.
    expect(hmacVin(VIN)).not.toBe(hmacVin(VIN_VECINO));
  });

  it('y se demuestra que la primitiva vieja SÍ los confunde: la diferencia no es teórica', () => {
    // Se afirma sobre `hmacCedula` a propósito. Sin este caso, el de arriba podría pasar por una
    // precaución de manual; con él queda escrito que el fallo era real y medido.
    expect(normalizeDocument(VIN)).toBe(normalizeDocument(VIN_VECINO));
    expect(hmacCedula(VIN).equals(hmacCedula(VIN_VECINO))).toBe(true);
  });

  it('determinístico y en hex de 64 caracteres', () => {
    expect(hmacVin(VIN)).toBe(hmacVin(VIN));
    expect(hmacVin(VIN)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('**normaliza ALFANUMÉRICAMENTE: separadores y minúsculas dan el MISMO token**', () => {
    // La regla de `normalizarId` del canal, que es la que decide lo que sale hacia Kyverum. Si el
    // HMAC se calculara sobre una forma y se buscara sobre otra, el registro sería inútil sin que
    // nadie lo notara. El mutante que mata: quitar la normalización antes del HMAC.
    expect(hmacVin('9FKRG-2222-T2042405')).toBe(hmacVin(VIN));
    expect(hmacVin('9fkrg2222t2042405')).toBe(hmacVin(VIN));
    expect(hmacVin('  9fkrg-2222 t2042405 ')).toBe(hmacVin(VIN));
  });

  it('**separación de dominio: el mismo valor como VIN, como placa y como cédula da tres HMAC**', () => {
    // Los tres comparten `PII_HMAC_KEY`; lo que los separa es la etiqueta. Sin ella, un VIN de solo
    // dígitos colisionaría con la cédula de esos mismos dígitos.
    const soloDigitos = '1036640908';
    expect(hmacVin(soloDigitos)).not.toBe(hmacPlaca(soloDigitos));
    expect(hmacVin(soloDigitos)).not.toBe(hmacCedula(soloDigitos).toString('hex'));
    expect(hmacPlaca(soloDigitos)).not.toBe(hmacCedula(soloDigitos).toString('hex'));
  });

  it('`tokenPii` versiona en banda y trunca a 32 hex, en un solo sitio', () => {
    // El truncado es el contrato: quien escribe y quien busca tienen que recortar igual. Que la
    // versión viaje en la fila es lo que hace sobrevivible una rotación de clave con seis años de
    // retención por delante.
    const token = tokenPii(hmacVin(VIN));
    expect(token).toMatch(/^v1:[0-9a-f]{32}$/);
    expect(token.startsWith(`v${PII_HMAC_VERSION_ACTUAL}:`)).toBe(true);
    expect(token).toHaveLength(35);
    // Y sigue distinguiendo al vecino de flota después de truncar: 128 bits son de sobra.
    expect(tokenPii(hmacVin(VIN))).not.toBe(tokenPii(hmacVin(VIN_VECINO)));
  });
});
