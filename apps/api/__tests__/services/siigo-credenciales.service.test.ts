// HU #11247 — credenciales de Siigo cifradas (Feature #11239).
//
// El cifrado va SIN mockear a propósito: lo que hay que demostrar es que el ciphertext real
// verifica, y que deja de verificar en cuanto se toca la fila. Un mock del cifrado probaría que
// sabemos llamar a una función, no que el secreto está protegido.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chain } from '../helpers/db.js';

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
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const {
  guardarCredencial, listarCredenciales, obtenerCredencialActiva, desactivarCredencial,
  SiigoCredencialError,
} = await import('../../src/modules/siigo/credenciales.service.js');
const { encryptSiigoSecret, newUuid } = await import('../../src/shared/utils/crypto.js');

const AMBIENTE = 'pruebas';
const ACCESS_KEY = 'clave-de-acceso-siigo-super-secreta';

/** Fila válida, cifrada de verdad, tal como quedaría en la base. */
function filaCifrada(overrides: Record<string, unknown> = {}) {
  const aadNonce = newUuid();
  const bundle = encryptSiigoSecret(ACCESS_KEY, {
    table: 'siigo_credenciales', column: 'access_key', empresaNit: AMBIENTE, aadNonce,
  });
  return {
    id: 1,
    ambiente: AMBIENTE,
    username: 'usuario@flitsas.com',
    accessKeyCipher: bundle.cipher,
    accessKeyIv: bundle.iv,
    accessKeyAuthTag: bundle.authTag,
    aadNonce,
    keyVersion: bundle.keyVersion,
    activo: true,
    notas: null,
    descifradoFallidoEn: null,
    descifradoFallidoMotivo: null,
    createdAt: new Date(),
    createdBy: 1,
    updatedAt: new Date(),
    updatedBy: 1,
    ...overrides,
  };
}

beforeEach(() => {
  selectMock.mockReset(); updateMock.mockReset();
  insertMock.mockReset(); transactionMock.mockReset();
});

describe('AC1 — las credenciales se guardan cifradas', () => {
  it('lo que se inserta es ciphertext, no el access_key', async () => {
    const valuesEspia = vi.fn();
    transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => cb({
      update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          valuesEspia(v);
          return { returning: () => Promise.resolve([{ ...filaCifrada(), ...v, id: 7 }]) };
        },
      }),
    }));

    const creada = await guardarCredencial({
      ambiente: AMBIENTE, username: 'usuario@flitsas.com',
      accessKey: ACCESS_KEY, userId: 1,
    });

    const insertado = valuesEspia.mock.calls[0]![0] as Record<string, Buffer | string>;
    // El secreto no aparece en NINGÚN campo del insert, ni siquiera dentro del cipher.
    const serializado = JSON.stringify(insertado);
    expect(serializado).not.toContain(ACCESS_KEY);
    expect(insertado.accessKeyCipher).toBeInstanceOf(Buffer);
    expect((insertado.accessKeyCipher as Buffer).toString('utf8')).not.toBe(ACCESS_KEY);
    // IV, authTag y nonce viajan con la fila: sin ellos el ciphertext es irrecuperable.
    expect(insertado.accessKeyIv).toBeInstanceOf(Buffer);
    expect(insertado.accessKeyAuthTag).toBeInstanceOf(Buffer);
    expect(insertado.aadNonce).toBeTruthy();
    expect(creada.id).toBe(7);
  });

  it('dos cifrados del mismo secreto producen ciphertext distinto (IV aleatorio por operación)', () => {
    const nonceA = newUuid();
    const nonceB = newUuid();
    const a = encryptSiigoSecret(ACCESS_KEY, { table: 't', column: 'c', empresaNit: AMBIENTE, aadNonce: nonceA });
    const b = encryptSiigoSecret(ACCESS_KEY, { table: 't', column: 'c', empresaNit: AMBIENTE, aadNonce: nonceB });
    expect(a.cipher.equals(b.cipher)).toBe(false);
    expect(a.iv.equals(b.iv)).toBe(false);
  });

  it('desactiva la credencial activa previa antes de insertar la nueva', async () => {
    const orden: string[] = [];
    transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => cb({
      update: () => ({ set: () => ({ where: () => { orden.push('desactiva'); return Promise.resolve([]); } }) }),
      insert: () => ({ values: () => ({ returning: () => { orden.push('inserta'); return Promise.resolve([filaCifrada()]); } }) }),
    }));

    await guardarCredencial({ ambiente: AMBIENTE, username: 'u', accessKey: ACCESS_KEY, userId: 1 });
    expect(orden).toEqual(['desactiva', 'inserta']);
  });
});

describe('AC2 — la clave nunca se devuelve en claro', () => {
  it('guardarCredencial devuelve el access_key enmascarado', async () => {
    transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => cb({
      update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
      insert: () => ({ values: () => ({ returning: () => Promise.resolve([filaCifrada()]) }) }),
    }));

    const creada = await guardarCredencial({
      ambiente: AMBIENTE, username: 'u', accessKey: ACCESS_KEY, userId: 1,
    });
    expect(creada.accessKey).not.toBe(ACCESS_KEY);
    expect(JSON.stringify(creada)).not.toContain(ACCESS_KEY);
    expect(creada).not.toHaveProperty('accessKeyCipher');
  });

  it('el listado no expone secreto ni material criptográfico', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 1, ambiente: AMBIENTE, username: 'u', activo: true, keyVersion: 1, notas: null,
      descifradoFallidoEn: null, descifradoFallidoMotivo: null,
      createdAt: new Date(), updatedAt: new Date(),
    }]));

    const filas = await listarCredenciales();
    expect(filas).toHaveLength(1);
    expect(filas[0]!.accessKey).not.toBe(ACCESS_KEY);
    expect(filas[0]).not.toHaveProperty('accessKeyCipher');
    expect(filas[0]).not.toHaveProperty('aadNonce');
  });

  it('obtenerCredencialActiva envuelve el secreto para que un log no lo imprima', async () => {
    selectMock.mockReturnValueOnce(chain([filaCifrada()]));

    const cred = await obtenerCredencialActiva(AMBIENTE);
    // Descifra de verdad…
    expect(cred.accessKey.unwrap()).toBe(ACCESS_KEY);
    // …pero serializarlo por accidente no filtra nada.
    expect(JSON.stringify({ cred })).not.toContain(ACCESS_KEY);
    expect(String(cred.accessKey)).toBe('[REDACTED]');
  });
});

describe('AC3 — un ambiente por vez', () => {
  it('sin credencial activa falla con codigo no_configurada', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    await expect(obtenerCredencialActiva('produccion')).rejects.toMatchObject({
      name: 'SiigoCredencialError', codigo: 'no_configurada',
    });
  });

  it('con dos activas del mismo ambiente se rechaza en vez de elegir una al azar', async () => {
    selectMock.mockReturnValueOnce(chain([filaCifrada({ id: 1 }), filaCifrada({ id: 2 })]));
    await expect(obtenerCredencialActiva(AMBIENTE)).rejects.toMatchObject({
      codigo: 'ambiente_ambiguo',
    });
    // No se usó ninguna de las dos.
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('resuelve la credencial del ambiente pedido', async () => {
    selectMock.mockReturnValueOnce(chain([filaCifrada({ id: 9, username: 'prod@flitsas.com' })]));
    const cred = await obtenerCredencialActiva(AMBIENTE);
    expect(cred.id).toBe(9);
    expect(cred.username).toBe('prod@flitsas.com');
  });
});

// AC4 (ausencia de la llave maestra) vive en siigo-credenciales.llave.test.ts: `config/env.ts`
// valida con zod al importarse, así que borrar `process.env` en caliente no cambia nada — hay que
// mockear el módulo de entorno antes de importar, y eso exige un archivo aparte.

describe('AC5 — una fila manipulada no descifra', () => {
  it('alterar el aad_nonce hace fallar la verificación de integridad', async () => {
    const fila = filaCifrada({ aadNonce: newUuid() }); // nonce distinto al usado al cifrar
    selectMock.mockReturnValueOnce(chain([fila]));
    updateMock.mockReturnValue(chain([]));

    await expect(obtenerCredencialActiva(AMBIENTE)).rejects.toMatchObject({
      codigo: 'descifrado',
    });
  });

  it('alterar el ciphertext también falla', async () => {
    const fila = filaCifrada();
    fila.accessKeyCipher = Buffer.concat([fila.accessKeyCipher, Buffer.from([0x00])]);
    selectMock.mockReturnValueOnce(chain([fila]));
    updateMock.mockReturnValue(chain([]));

    await expect(obtenerCredencialActiva(AMBIENTE)).rejects.toThrow();
  });

  it('tras el fallo la credencial queda desactivada con el motivo escrito', async () => {
    const fila = filaCifrada({ aadNonce: newUuid() });
    selectMock.mockReturnValueOnce(chain([fila]));
    const setEspia = vi.fn().mockReturnValue({ where: () => Promise.resolve([]) });
    updateMock.mockReturnValue({ set: setEspia });

    await expect(obtenerCredencialActiva(AMBIENTE)).rejects.toThrow();

    expect(setEspia).toHaveBeenCalledTimes(1);
    const cambios = setEspia.mock.calls[0]![0] as Record<string, unknown>;
    expect(cambios.activo).toBe(false);
    expect(cambios.descifradoFallidoEn).toBeInstanceOf(Date);
    expect(cambios.descifradoFallidoMotivo).toBeTruthy();
  });

  it('el error que ve quien llama pide reconfigurar, no expone la traza criptográfica', async () => {
    const fila = filaCifrada({ aadNonce: newUuid() });
    selectMock.mockReturnValueOnce(chain([fila]));
    updateMock.mockReturnValue({ set: () => ({ where: () => Promise.resolve([]) }) });

    await expect(obtenerCredencialActiva(AMBIENTE)).rejects.toThrow(/Regístrala de nuevo/);
  });

  it('si marcar el fallo revienta, el error propagado sigue siendo el del descifrado', async () => {
    const fila = filaCifrada({ aadNonce: newUuid() });
    selectMock.mockReturnValueOnce(chain([fila]));
    updateMock.mockImplementation(() => { throw new Error('BD caída'); });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(obtenerCredencialActiva(AMBIENTE)).rejects.toMatchObject({ codigo: 'descifrado' });
    errSpy.mockRestore();
  });
});

describe('desactivación manual', () => {
  it('devuelve true cuando la fila existía', async () => {
    updateMock.mockReturnValue({ set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 3 }]) }) }) });
    await expect(desactivarCredencial(3, 1)).resolves.toBe(true);
  });

  it('devuelve false cuando no existía', async () => {
    updateMock.mockReturnValue({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) });
    await expect(desactivarCredencial(999, 1)).resolves.toBe(false);
  });
});

describe('SiigoCredencialError', () => {
  it('conserva el código para que quien llama pueda ramificar', () => {
    const e = new SiigoCredencialError('no_configurada', 'x');
    expect(e).toBeInstanceOf(Error);
    expect(e.codigo).toBe('no_configurada');
  });
});
