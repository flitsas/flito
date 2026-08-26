// HU #11247 · AC4 — sin llave maestra no se opera.
//
// Archivo aparte porque `config/env.ts` valida con zod EN EL IMPORT: el objeto `env` es una foto de
// `process.env` tomada al arrancar, así que borrar la variable en caliente no cambia el
// comportamiento. Para ejercer la ausencia de la llave hay que mockear el módulo de entorno antes
// de importar crypto y el servicio.
//
// Lo que se demuestra aquí es que no hay derivación de respaldo: a diferencia de RNDC, que en
// desarrollo deriva una clave de PII_ENC_KEY, Siigo falla. Derivar en silencio dejaría credenciales
// cifradas con una clave distinta según el entorno, y al configurar la real dejarían de descifrar.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const envMock: { SIIGO_ENC_KEY: string | undefined; NODE_ENV: string; PII_ENC_KEY: string } = {
  SIIGO_ENC_KEY: undefined,
  NODE_ENV: 'development',
  PII_ENC_KEY: 'test-pii-enc-key-test-pii-enc-key-1234',
};

vi.mock('../../src/config/env.js', () => ({ env: envMock }));

const selectMock = vi.fn();
const updateMock = vi.fn();
const insertMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock, update: updateMock, insert: insertMock,
    transaction: transactionMock, delete: vi.fn(), execute: vi.fn(),
  },
  getPoolStats: vi.fn(),
}));

const { guardarCredencial, obtenerCredencialActiva } =
  await import('../../src/modules/siigo/credenciales.service.js');
const { siigoEncKeyDisponible } = await import('../../src/shared/utils/crypto.js');
const { chain } = await import('../helpers/db.js');

const LLAVE_VALIDA = 'b71d3f9a20c845e6f8319ad4c7be5026a19d3f84c60be27159ad83f4c2e70b91';

beforeEach(() => {
  selectMock.mockReset(); updateMock.mockReset();
  insertMock.mockReset(); transactionMock.mockReset();
  envMock.SIIGO_ENC_KEY = undefined;
});

describe('guardar sin llave maestra', () => {
  it('falla con un error explícito que nombra la variable que falta', async () => {
    await expect(guardarCredencial({
      ambiente: 'pruebas', username: 'u', accessKey: 'clave-de-acceso', userId: 1,
    })).rejects.toThrow(/SIIGO_ENC_KEY no está configurada/);
  });

  it('NO toca la base de datos: nada queda a medio cifrar', async () => {
    await expect(guardarCredencial({
      ambiente: 'pruebas', username: 'u', accessKey: 'clave-de-acceso', userId: 1,
    })).rejects.toThrow();

    expect(transactionMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });
});

describe('llave maestra con formato inválido', () => {
  it('rechaza una llave más corta que 32 bytes', async () => {
    envMock.SIIGO_ENC_KEY = 'demasiado-corta';
    await expect(guardarCredencial({
      ambiente: 'pruebas', username: 'u', accessKey: 'clave-de-acceso', userId: 1,
    })).rejects.toThrow(/64 hex chars/);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('rechaza una llave de bytes uniformes (entropía insuficiente)', async () => {
    envMock.SIIGO_ENC_KEY = '0'.repeat(64);
    await expect(guardarCredencial({
      ambiente: 'pruebas', username: 'u', accessKey: 'clave-de-acceso', userId: 1,
    })).rejects.toThrow(/entropía|uniformes/i);
  });
});

describe('leer sin llave maestra', () => {
  it('devuelve codigo llave_maestra, distinguible de una credencial ausente', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 1, ambiente: 'pruebas', username: 'u',
      accessKeyCipher: Buffer.from('x'), accessKeyIv: Buffer.from('y'),
      accessKeyAuthTag: Buffer.from('z'), aadNonce: 'nonce', keyVersion: 1,
      activo: true, notas: null, descifradoFallidoEn: null, descifradoFallidoMotivo: null,
      createdAt: new Date(), updatedAt: new Date(), createdBy: 1, updatedBy: 1,
    }]));

    await expect(obtenerCredencialActiva('pruebas')).rejects.toMatchObject({
      codigo: 'llave_maestra',
    });
  });

  it('NO desactiva la credencial: la fila está sana, lo que está mal es el entorno', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 1, ambiente: 'pruebas', username: 'u',
      accessKeyCipher: Buffer.from('x'), accessKeyIv: Buffer.from('y'),
      accessKeyAuthTag: Buffer.from('z'), aadNonce: 'nonce', keyVersion: 1,
      activo: true, notas: null, descifradoFallidoEn: null, descifradoFallidoMotivo: null,
      createdAt: new Date(), updatedAt: new Date(), createdBy: 1, updatedBy: 1,
    }]));

    await expect(obtenerCredencialActiva('pruebas')).rejects.toThrow();
    // Desactivarla borraría una credencial buena por un fallo de configuración.
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('siigoEncKeyDisponible — diagnóstico sin lanzar', () => {
  it('false cuando falta la llave', () => {
    envMock.SIIGO_ENC_KEY = undefined;
    expect(siigoEncKeyDisponible()).toBe(false);
  });

  it('false cuando la llave es inválida', () => {
    envMock.SIIGO_ENC_KEY = 'no-es-hex';
    expect(siigoEncKeyDisponible()).toBe(false);
  });

  it('true cuando la llave es válida', () => {
    envMock.SIIGO_ENC_KEY = LLAVE_VALIDA;
    expect(siigoEncKeyDisponible()).toBe(true);
  });
});
