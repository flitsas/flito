// Feature #13978, HU #14100 (ADR-0034 D1, D2) — llaves PII por versión. Sin dobles de la primitiva: la
// llave se cambia de verdad vía `env` y `process.env`, y `scryptSync` solo se espía.
import crypto from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../src/config/env.js';
import {
  decryptPii, decryptPiiBuffer, decryptPiiText, encryptPii, encryptPiiBuffer, encryptPiiText,
  encryptSecret, type AadParts,
} from '../../src/shared/utils/crypto.js';
import {
  derivarLlavePii, salPii, validarLlavesPii, versionesPiiConfiguradas,
} from '../../src/shared/utils/pii-keyring.js';

const envMutable = env as unknown as {
  PII_ENC_KEY: string | undefined;
  PII_ENC_KEY_CURRENT_VERSION: number;
  RNDC_ENC_KEY: string | undefined;
};
const LLAVE_V1 = env.PII_ENC_KEY as string;
const LLAVE_RNDC = env.RNDC_ENC_KEY;
const LLAVE_V2 = 'a7f3c91e5d20b84f6e13d7a9c0428fb5e16d3a7c94f08b2d';
const LLAVE_V3 = '5be2049fd1c76a38e9f04b1d7c62a85310de94fb76c1a2e8';
const AAD: AadParts = { table: 'driver_profile', column: 'cedula', empresaNit: '77', aadNonce: '11111111-2222-4333-8444-555555555555' };
const CTX = { table: 'tramites_validaciones', column: 'foto_rostro', id: 9 };

beforeEach(() => {
  envMutable.PII_ENC_KEY = LLAVE_V1;
  envMutable.PII_ENC_KEY_CURRENT_VERSION = 1;
  envMutable.RNDC_ENC_KEY = LLAVE_RNDC;
  delete process.env.PII_ENC_KEY_V2;
  delete process.env.PII_ENC_KEY_V3;
});

afterEach(() => {
  envMutable.PII_ENC_KEY = LLAVE_V1;
  envMutable.PII_ENC_KEY_CURRENT_VERSION = 1;
  envMutable.RNDC_ENC_KEY = LLAVE_RNDC;
  delete process.env.PII_ENC_KEY_V2;
  delete process.env.PII_ENC_KEY_V3;
  vi.restoreAllMocks();
});

describe('AC1: una derivación por versión, y llaves distintas entre versiones', () => {
  it('cifrar y descifrar muchas veces deriva una sola vez por versión', () => {
    // Pasadas nuevas para esta prueba: el memo es de módulo y otra prueba pudo dejarlo caliente.
    envMutable.PII_ENC_KEY = 'pasada-solo-para-contar-derivaciones-v1';
    process.env.PII_ENC_KEY_V2 = 'pasada-solo-para-contar-derivaciones-v2';
    const espia = vi.spyOn(crypto, 'scryptSync');

    envMutable.PII_ENC_KEY_CURRENT_VERSION = 1;
    for (let i = 0; i < 5; i++) decryptPii(encryptPii('x', AAD), AAD);
    envMutable.PII_ENC_KEY_CURRENT_VERSION = 2;
    for (let i = 0; i < 5; i++) decryptPii(encryptPii('x', AAD), AAD);

    expect(espia).toHaveBeenCalledTimes(2);
    expect(espia.mock.calls.map((c) => c[1])).toEqual(['kyverum-pii-2026', 'flito-pii-v2']);
  });

  it('la misma pasada con versiones distintas da llaves distintas, por la sal', () => {
    expect(salPii(1)).toBe('kyverum-pii-2026');
    expect(salPii(2)).toBe('flito-pii-v2');
    expect(derivarLlavePii(2, LLAVE_V2).equals(derivarLlavePii(3, LLAVE_V2))).toBe(false);
  });

  it('un valor de una versión no descifra con la llave de otra', () => {
    process.env.PII_ENC_KEY_V2 = LLAVE_V2;
    envMutable.PII_ENC_KEY_CURRENT_VERSION = 2;
    const b = encryptPii('1036640908', AAD);
    expect(() => decryptPii({ ...b, keyVersion: 1 }, AAD)).toThrow();
  });

  it('cambiar la variable re-deriva: el memo no sigue con la llave anterior', () => {
    const b = encryptPii('1036640908', AAD);
    envMutable.PII_ENC_KEY = 'otra-llave-otra-llave-otra-llave-otra-1234';
    expect(() => decryptPii(b, AAD)).toThrow();
    envMutable.PII_ENC_KEY = LLAVE_V1;
    expect(decryptPii(b, AAD)).toBe('1036640908');
  });
});

describe('versión vigente: se escribe con ella y se lee con la de cada valor', () => {
  it('vigente 1 con V2 configurada cifra con 1', () => {
    process.env.PII_ENC_KEY_V2 = LLAVE_V2;
    expect(encryptPii('x', AAD).keyVersion).toBe(1);
    expect(encryptPiiBuffer(Buffer.from('x'), AAD).keyVersion).toBe(1);
    expect(encryptPiiText('x', CTX).startsWith('v1:')).toBe(true);
  });

  it('vigente 2 cifra con 2 y sigue leyendo lo de la 1', () => {
    process.env.PII_ENC_KEY_V2 = LLAVE_V2;
    const enV1 = encryptPii('en-uno', AAD);
    const textoV1 = encryptPiiText('texto-en-uno', CTX);
    const bufferV1 = encryptPiiBuffer(Buffer.from('bytes-en-uno'), AAD);

    envMutable.PII_ENC_KEY_CURRENT_VERSION = 2;
    const enV2 = encryptPii('en-dos', AAD);
    const textoV2 = encryptPiiText('texto-en-dos', CTX);

    expect(enV2.keyVersion).toBe(2);
    expect(encryptPiiBuffer(Buffer.from('x'), AAD).keyVersion).toBe(2);
    expect(textoV2.startsWith('v2:')).toBe(true);
    expect(decryptPii(enV2, AAD)).toBe('en-dos');
    expect(decryptPiiText(textoV2, CTX)).toBe('texto-en-dos');
    expect(decryptPii(enV1, AAD)).toBe('en-uno');
    expect(decryptPiiText(textoV1, CTX)).toBe('texto-en-uno');
    expect(decryptPiiBuffer(bufferV1, AAD).toString()).toBe('bytes-en-uno');
  });

  it('una versión sin llave falla al leer, y V1 retirada también', () => {
    const enV1 = encryptPii('en-uno', AAD);
    expect(() => decryptPii({ ...enV1, keyVersion: 7 }, AAD)).toThrow('versión 7 no configurada');
    process.env.PII_ENC_KEY_V2 = LLAVE_V2;
    envMutable.PII_ENC_KEY_CURRENT_VERSION = 2;
    envMutable.PII_ENC_KEY = undefined;
    expect(encryptPii('x', AAD).keyVersion).toBe(2);
    expect(() => decryptPii(enV1, AAD)).toThrow('versión 1 no configurada');
  });

  it('versiones inválidas de una fila no se resuelven contra una variable', () => {
    const b = encryptPii('x', AAD);
    for (const keyVersion of [0, -1, 1.5, Number.NaN]) {
      expect(() => decryptPii({ ...b, keyVersion }, AAD)).toThrow('no configurada');
    }
  });
});

describe('AC2: lo cifrado antes del cambio descifra idéntico', () => {
  // Vectores fijos, calculados con la derivación de siempre en un script aparte:
  // scrypt(LLAVE_V1, 'kyverum-pii-2026', 32), iv fijo, AAD de cada formato. Si alguien cambia la sal o
  // la AAD de la versión 1, estos valores dejan de descifrar.
  const IV = Buffer.from('000102030405060708090a0b', 'hex');

  it('paquete binario de `encryptPii`', () => {
    expect(decryptPii({
      cipher: Buffer.from('824d8ea86021b30a1a97', 'hex'),
      iv: IV,
      authTag: Buffer.from('046def5a10192462f29b7befa29a9333', 'hex'),
      keyVersion: 1,
    }, AAD)).toBe('1036640908');
  });

  it('texto `v1:` de `encryptPiiText`', () => {
    expect(decryptPiiText('v1:000102030405060708090a0b:ce723ccfea49aa8a8584b2ed166558e9:1RLJ8Xtx5h5a3a106aY=', CTX))
      .toBe('foto-de-prueba');
  });

  it('el vector sigue descifrando con la vigente en 2', () => {
    process.env.PII_ENC_KEY_V2 = LLAVE_V2;
    envMutable.PII_ENC_KEY_CURRENT_VERSION = 2;
    expect(decryptPiiText('v1:000102030405060708090a0b:ce723ccfea49aa8a8584b2ed166558e9:1RLJ8Xtx5h5a3a106aY=', CTX))
      .toBe('foto-de-prueba');
  });
});

describe('validación estática (ADR-0034 D2)', () => {
  const variables = (p: { variable: string }[]) => p.map((x) => x.variable);

  it('configuración de hoy: solo PII_ENC_KEY y vigente 1, sin problemas', () => {
    expect(validarLlavesPii(LLAVE_V1, 1, {})).toEqual([]);
  });

  it('rechaza PII_ENC_KEY_V1', () => {
    expect(variables(validarLlavesPii(LLAVE_V1, 1, { PII_ENC_KEY_V1: LLAVE_V2 }))).toEqual(['PII_ENC_KEY_V1']);
  });

  it('la vigente necesita llave, también si es la 1 y no hay PII_ENC_KEY', () => {
    expect(variables(validarLlavesPii(LLAVE_V1, 2, {}))).toEqual(['PII_ENC_KEY_CURRENT_VERSION']);
    expect(variables(validarLlavesPii(undefined, 1, {}))).toEqual(['PII_ENC_KEY_CURRENT_VERSION']);
    expect(validarLlavesPii(undefined, 2, { PII_ENC_KEY_V2: LLAVE_V2 })).toEqual([]);
  });

  it('B == A no pasa: se comparan pasadas, no llaves derivadas', () => {
    const problemas = validarLlavesPii(LLAVE_V1, 1, { PII_ENC_KEY_V2: LLAVE_V1 });
    expect(variables(problemas)).toEqual(['PII_ENC_KEY_V2']);
    expect(variables(validarLlavesPii(LLAVE_V1, 1, { PII_ENC_KEY_V2: LLAVE_V2, PII_ENC_KEY_V3: LLAVE_V2 })))
      .toEqual(['PII_ENC_KEY_V3']);
  });

  it('largo y entropía se exigen a n ≥ 2, y a la versión 1 no se le añade la regla', () => {
    expect(variables(validarLlavesPii(LLAVE_V1, 1, { PII_ENC_KEY_V2: 'corta' }))).toEqual(['PII_ENC_KEY_V2']);
    expect(variables(validarLlavesPii(LLAVE_V1, 1, { PII_ENC_KEY_V2: 'a'.repeat(64) }))).toEqual(['PII_ENC_KEY_V2']);
    expect(variables(validarLlavesPii(LLAVE_V1, 1, { PII_ENC_KEY_V2: 'abc'.repeat(20) }))).toEqual(['PII_ENC_KEY_V2']);
    expect(validarLlavesPii('a'.repeat(64), 1, {})).toEqual([]);
  });

  it('la salida de `openssl rand -hex 32` pasa siempre', () => {
    for (let i = 0; i < 200; i++) {
      const fuente = { PII_ENC_KEY_V2: crypto.randomBytes(32).toString('hex') };
      expect(validarLlavesPii(LLAVE_V1, 1, fuente)).toEqual([]);
    }
  });

  it('rechaza nombres que no son una versión válida', () => {
    for (const nombre of ['PII_ENC_KEY_V0', 'PII_ENC_KEY_V02', 'PII_ENC_KEY_V2_', 'PII_ENC_KEY_VDOS', 'PII_ENC_KEY_V40000']) {
      expect(variables(validarLlavesPii(LLAVE_V1, 1, { [nombre]: LLAVE_V2 }))).toEqual([nombre]);
    }
  });

  it('una variable en blanco cuenta como ausente', () => {
    expect(validarLlavesPii(LLAVE_V1, 1, { PII_ENC_KEY_V1: '', PII_ENC_KEY_V2: '' })).toEqual([]);
    expect(versionesPiiConfiguradas(LLAVE_V1, { PII_ENC_KEY_V2: '' })).toEqual([1]);
  });

  it('los mensajes nunca llevan valores', () => {
    const problemas = validarLlavesPii(LLAVE_V1, 5, {
      PII_ENC_KEY_V1: LLAVE_V2, PII_ENC_KEY_V2: LLAVE_V1, PII_ENC_KEY_V3: 'corta-secreta', PII_ENC_KEY_V04: LLAVE_V3,
    });
    const texto = JSON.stringify(problemas);
    expect(problemas.length).toBeGreaterThanOrEqual(4);
    for (const valor of [LLAVE_V1, LLAVE_V2, LLAVE_V3, 'corta-secreta']) expect(texto).not.toContain(valor);
  });

  it('versiones configuradas: ordenadas y sin nombres inválidos', () => {
    expect(versionesPiiConfiguradas(LLAVE_V1, { PII_ENC_KEY_V3: LLAVE_V3, PII_ENC_KEY_V2: LLAVE_V2, PII_ENC_KEY_V02: 'x', PII_ENC_KEY_V1: 'x' }))
      .toEqual([1, 2, 3]);
    expect(versionesPiiConfiguradas(undefined, { PII_ENC_KEY_V2: LLAVE_V2 })).toEqual([2]);
  });
});

describe('`env.ts` aplica la validación al importar', () => {
  const originales = { ...process.env };
  const cargarEnv = async () => {
    vi.resetModules();
    return import('../../src/config/env.js');
  };

  afterEach(() => {
    for (const nombre of ['PII_ENC_KEY', 'PII_ENC_KEY_V1', 'PII_ENC_KEY_V2', 'PII_ENC_KEY_CURRENT_VERSION']) {
      if (originales[nombre] === undefined) delete process.env[nombre];
      else process.env[nombre] = originales[nombre];
    }
    vi.resetModules();
  });

  it('PII_ENC_KEY_V1 no carga, sin el valor en el error', async () => {
    process.env.PII_ENC_KEY_V1 = LLAVE_V2;
    const error = await cargarEnv().then(() => null, (e: Error) => e);
    expect(error?.message).toContain('PII_ENC_KEY_V1 no se admite');
    expect(error?.message).not.toContain(LLAVE_V2);
  });

  it('B == A no carga', async () => {
    process.env.PII_ENC_KEY_V2 = LLAVE_V1;
    await expect(cargarEnv()).rejects.toThrow('misma llave');
  });

  it('vigente sin llave no carga', async () => {
    process.env.PII_ENC_KEY_CURRENT_VERSION = '2';
    await expect(cargarEnv()).rejects.toThrow('falta PII_ENC_KEY_V2');
  });

  it('sin PII_ENC_KEY y sin nada más no carga: el defecto sigue fallando', async () => {
    process.env.PII_ENC_KEY = '';
    await expect(cargarEnv()).rejects.toThrow('falta PII_ENC_KEY');
  });

  it('con V1 retirada y V2 vigente carga', async () => {
    process.env.PII_ENC_KEY = '';
    process.env.PII_ENC_KEY_V2 = LLAVE_V2;
    process.env.PII_ENC_KEY_CURRENT_VERSION = '2';
    const { env: cargado } = await cargarEnv();
    expect(cargado.PII_ENC_KEY).toBeUndefined();
    expect(cargado.PII_ENC_KEY_CURRENT_VERSION).toBe(2);
  });

  it('la configuración de hoy carga con vigente 1 por defecto', async () => {
    const { env: cargado } = await cargarEnv();
    expect(cargado.PII_ENC_KEY_CURRENT_VERSION).toBe(1);
    expect(cargado.PII_ENC_KEY).toBe(LLAVE_V1);
  });
});

describe('guarda de las derivaciones que usaban `env.PII_ENC_KEY`', () => {
  const PARTES: AadParts = { table: 'rndc_credenciales', column: 'clave_qr', empresaNit: '900', aadNonce: 'n' };

  it('RNDC sin su llave y sin PII_ENC_KEY lanza en lugar de concatenar `undefined`', () => {
    envMutable.RNDC_ENC_KEY = undefined;
    envMutable.PII_ENC_KEY = undefined;
    expect(() => encryptSecret('x', PARTES)).toThrow('falta PII_ENC_KEY');
  });

  it('RNDC sin su llave y con PII_ENC_KEY mantiene el respaldo de desarrollo', () => {
    envMutable.RNDC_ENC_KEY = undefined;
    expect(encryptSecret('x', PARTES).keyVersion).toBe(1);
  });
});
