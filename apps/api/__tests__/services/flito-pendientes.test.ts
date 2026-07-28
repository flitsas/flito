// HU #10982 — bandeja de recibos que no cruzan, compartida por derechos, SOAT e impuestos.
//
// Lo que se prueba aquí es la FORMA de lo que se persiste: en qué carpeta cae el archivo y qué
// campos lleva cada fila. El comportamiento de las consultas se verificó contra Postgres real,
// porque el helper `chain()` descarta los argumentos de `where()` y no distingue un filtro por
// concepto de uno que no filtra nada.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chain } from '../helpers/db.js';

const insertMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: insertMock, update: vi.fn(), delete: vi.fn(), transaction: transactionMock, execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const uploadMock = vi.fn().mockResolvedValue('_pendientes-sin-cruce/soat/k.pdf');
vi.mock('../../src/services/storage.js', () => ({
  uploadEntityDocument: uploadMock,
  firmarDescargaEntidad: vi.fn(),
  presignedGetEntityDocument: vi.fn(),
}));

const {
  archivarSinCruce, esConceptoPendiente, CONCEPTO_PENDIENTE,
} = await import('../../src/modules/flito-pendientes/flito-pendientes.service.js');

const archivo = {
  originalname: 'recibo.pdf', mimetype: 'application/pdf',
  buffer: Buffer.from('x'), size: 1,
};
const ctx = { userId: 7, username: 'gestor@flit' };

/** Captura los `values()` de cada insert de la transacción, en orden: soporte y luego pendiente. */
function capturarInserts(): Record<string, unknown>[] {
  const capturados: Record<string, unknown>[] = [];
  const tx = {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        capturados.push(v);
        return chain([{ id: `id-${capturados.length}` }]);
      },
    }),
  };
  transactionMock.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(tx));
  return capturados;
}

beforeEach(() => {
  insertMock.mockReset(); transactionMock.mockReset(); uploadMock.mockClear();
});

describe('esConceptoPendiente — guarda de entrada del filtro', () => {
  it('acepta los tres conceptos', () => {
    for (const c of ['derecho', 'soat', 'impuesto']) expect(esConceptoPendiente(c)).toBe(true);
  });

  it('rechaza cualquier otra cosa en vez de dejarla llegar al SQL', () => {
    for (const v of ['', 'SOAT', 'logistica', "'; DROP TABLE", null, undefined, 7, {}]) {
      expect(esConceptoPendiente(v)).toBe(false);
    }
  });
});

describe('archivarSinCruce — el archivo se guarda aunque no haya con qué cruzarlo', () => {
  it('separa por concepto y organismo en el almacenamiento', async () => {
    capturarInserts();
    await archivarSinCruce({
      concepto: CONCEPTO_PENDIENTE.SOAT, placa: 'ABC123', archivo, hash: 'h1',
      tipoSoporte: 'factura_soat', extraccion: {}, organismoCodigo: '05001', origen: 'carga_masiva',
    }, ctx);

    const [carpeta] = uploadMock.mock.calls[0];
    expect(carpeta).toBe('_pendientes-sin-cruce/soat/05001');
  });

  it('el soporte queda SIN dueño: es el reintento quien lo ata', async () => {
    const inserts = capturarInserts();
    await archivarSinCruce({
      concepto: CONCEPTO_PENDIENTE.SOAT, placa: 'ABC123', archivo, hash: 'h1',
      tipoSoporte: 'factura_soat', extraccion: {}, organismoCodigo: null, origen: 'carga_masiva',
    }, ctx);

    const soporte = inserts[0];
    expect(soporte.soatId).toBeUndefined();
    expect(soporte.impuestoId).toBeUndefined();
    expect(soporte.nombreArchivo).toBe('recibo.pdf');
    expect(soporte.subidoPorId).toBe(7);
  });

  it('la fila de la bandeja lleva el concepto, que es lo que decide qué reintento la barre', async () => {
    const inserts = capturarInserts();
    await archivarSinCruce({
      concepto: CONCEPTO_PENDIENTE.IMPUESTO, placa: 'XYZ789', archivo, hash: 'h2',
      tipoSoporte: 'recibo_impuesto', extraccion: { a: 1 }, organismoCodigo: '11001', origen: 'carga_masiva',
    }, ctx);

    const pendiente = inserts[1];
    expect(pendiente.concepto).toBe('impuesto');
    expect(pendiente.placa).toBe('XYZ789');
    expect(pendiente.organismoCodigo).toBe('11001');
    expect(pendiente.extraccion).toEqual({ a: 1 });
  });

  it('sin placa también se archiva: es cuando más caro sale perder el recibo', async () => {
    // Sin placa nadie lo puede volver a buscar, así que descartarlo es la peor opción posible.
    const inserts = capturarInserts();
    await archivarSinCruce({
      concepto: CONCEPTO_PENDIENTE.IMPUESTO, placa: null, archivo, hash: 'h3',
      tipoSoporte: 'recibo_impuesto', extraccion: {}, organismoCodigo: null, origen: 'carga_masiva',
    }, ctx);

    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(uploadMock.mock.calls[0][1]).toBe('sin-placa');
    expect(inserts[1].placa).toBeNull();
  });
});
