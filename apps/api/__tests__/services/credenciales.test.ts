import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chain } from '../helpers/db.js';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock,
    insert: insertMock,
    update: updateMock,
    transaction: transactionMock,
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const VALID_INPUT = {
  empresaNit: '900123456',
  habilitadorNit: '900654321',
  numNit: '900123456-1',
  claveQR: 'super-secret-clave-qr',
  ambiente: 'sandbox' as const,
  notas: 'cred test',
  userId: 1,
};

const ROW_FROM_DB = {
  id: 42,
  empresaNit: '900123456',
  habilitadorNit: '900654321',
  numNit: '900123456-1',
  ambiente: 'sandbox',
  activo: true,
  notas: 'cred test',
  keyVersion: 1,
  createdAt: new Date('2026-05-06T00:00:00Z'),
  updatedAt: new Date('2026-05-06T00:00:00Z'),
};

describe('credenciales.service — setCredenciales', () => {
  beforeEach(() => {
    selectMock.mockReset();
    insertMock.mockReset();
    updateMock.mockReset();
    transactionMock.mockReset();
  });

  it('cifra claveQR, desactiva previa y crea nueva activa', async () => {
    const updateInTx = vi.fn().mockReturnValueOnce(chain([]));
    const insertInTx = vi.fn().mockReturnValueOnce(chain([ROW_FROM_DB]));

    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = { update: updateInTx, insert: insertInTx };
      return cb(tx);
    });

    const { setCredenciales } = await import('../../src/modules/rndc/credenciales.service.js');
    const r = await setCredenciales(VALID_INPUT);

    expect(r.id).toBe(42);
    expect(r.empresaNit).toBe('900123456');
    expect(r.activo).toBe(true);
    expect(r.keyVersion).toBe(1);
    // Devuelve solo la versión pública: NO debe exponer cipher/iv/authTag
    expect(r).not.toHaveProperty('claveQrCipher');
    expect(r).not.toHaveProperty('claveQrIv');
    expect(r).not.toHaveProperty('aadNonce');

    // Desactivó la previa antes de insertar
    expect(updateInTx).toHaveBeenCalledTimes(1);
    expect(insertInTx).toHaveBeenCalledTimes(1);
  });

  it('inserta el cipher generado por encryptSecret (no el plaintext)', async () => {
    let capturedValues: any = null;
    const insertInTx = vi.fn(() => ({
      values: vi.fn((v: any) => {
        capturedValues = v;
        return chain([ROW_FROM_DB]);
      }),
    }));

    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        update: vi.fn().mockReturnValueOnce(chain([])),
        insert: insertInTx,
      };
      return cb(tx);
    });

    const { setCredenciales } = await import('../../src/modules/rndc/credenciales.service.js');
    await setCredenciales(VALID_INPUT);

    expect(capturedValues).toBeTruthy();
    // El plaintext NO está en el insert
    expect(JSON.stringify(capturedValues)).not.toContain(VALID_INPUT.claveQR);
    // Sí están los campos cifrados
    expect(capturedValues.claveQrCipher).toBeInstanceOf(Buffer);
    expect(capturedValues.claveQrIv).toBeInstanceOf(Buffer);
    expect(capturedValues.claveQrAuthTag).toBeInstanceOf(Buffer);
    expect(capturedValues.aadNonce).toMatch(/^[0-9a-f-]{36}$/);
    expect(capturedValues.keyVersion).toBe(1);
  });
});

describe('credenciales.service — listCredencialesPublic', () => {
  beforeEach(() => {
    selectMock.mockReset();
  });

  it('devuelve la lista sin columnas cifradas (PII protection)', async () => {
    selectMock.mockReturnValueOnce(chain([
      { id: 1, empresaNit: '900123456', ambiente: 'sandbox', activo: true, keyVersion: 1 },
      { id: 2, empresaNit: '900654321', ambiente: 'produccion', activo: false, keyVersion: 1 },
    ]));

    const { listCredencialesPublic } = await import('../../src/modules/rndc/credenciales.service.js');
    const rows = await listCredencialesPublic();

    expect(rows).toHaveLength(2);
    expect(rows[0]).not.toHaveProperty('claveQrCipher');
    expect(rows[0]).not.toHaveProperty('claveQrIv');
    expect(rows[0]).not.toHaveProperty('aadNonce');
  });

  it('lista vacía → array vacío (no throw)', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const { listCredencialesPublic } = await import('../../src/modules/rndc/credenciales.service.js');
    const rows = await listCredencialesPublic();
    expect(rows).toEqual([]);
  });
});

describe('credenciales.service — deactivateCredencial', () => {
  beforeEach(() => {
    updateMock.mockReset();
  });

  it('cuando update afecta una fila → true', async () => {
    updateMock.mockReturnValueOnce(chain([{ id: 42 }]));
    const { deactivateCredencial } = await import('../../src/modules/rndc/credenciales.service.js');
    const ok = await deactivateCredencial(42, 1);
    expect(ok).toBe(true);
  });

  it('cuando update no afecta filas → false', async () => {
    updateMock.mockReturnValueOnce(chain([]));
    const { deactivateCredencial } = await import('../../src/modules/rndc/credenciales.service.js');
    const ok = await deactivateCredencial(999, 1);
    expect(ok).toBe(false);
  });
});

describe('credenciales.service — getActiveCredenciales (descifrado roundtrip)', () => {
  beforeEach(() => {
    selectMock.mockReset();
    insertMock.mockReset();
    updateMock.mockReset();
    transactionMock.mockReset();
  });

  it('cifra → guarda → descifra: roundtrip end-to-end con AAD real', async () => {
    // Paso 1: setCredenciales cifra el claveQR y captura los buffers + aadNonce reales.
    let captured: any = null;
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        update: vi.fn().mockReturnValueOnce(chain([])),
        insert: vi.fn(() => ({
          values: (v: any) => {
            captured = v;
            return chain([{ ...ROW_FROM_DB, ...v }]);
          },
        })),
      };
      return cb(tx);
    });

    const { setCredenciales, getActiveCredenciales } = await import('../../src/modules/rndc/credenciales.service.js');
    await setCredenciales(VALID_INPUT);
    expect(captured).toBeTruthy();

    // Paso 2: getActiveCredenciales lee la fila simulada y descifra.
    selectMock.mockReturnValueOnce(chain([{
      ...captured,
      // Drizzle devuelve los buffers tal cual
    }]));

    const r = await getActiveCredenciales(VALID_INPUT.empresaNit, VALID_INPUT.ambiente);
    expect(r).not.toBeNull();
    expect(r!.creds.claveQR).toBe(VALID_INPUT.claveQR); // roundtrip exitoso
    expect(r!.creds.empresaNit).toBe(VALID_INPUT.empresaNit);
    // redactedClave protege contra leaks accidentales
    expect(JSON.stringify({ pwd: r!.redactedClave })).toBe('{"pwd":"[REDACTED]"}');
    expect(r!.redactedClave.unwrap()).toBe(VALID_INPUT.claveQR);
  });

  it('sin credenciales activas → null', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const { getActiveCredenciales } = await import('../../src/modules/rndc/credenciales.service.js');
    const r = await getActiveCredenciales('900123456', 'sandbox');
    expect(r).toBeNull();
  });
});
