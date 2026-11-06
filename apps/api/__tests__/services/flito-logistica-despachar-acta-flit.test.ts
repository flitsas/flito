// Bug de validación épica #13758: «Firmar y despachar» sobre el acta de un viaje a FLIT no movía el traslado.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chain } from '../helpers/db.js';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: insertMock, update: updateMock, delete: vi.fn(), transaction: transactionMock, execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/services/storage.js', () => ({
  uploadEntityDocument: vi.fn().mockResolvedValue('storage/firma.png'),
  presignedGetEntityDocument: vi.fn(), getEntityDocumentStream: vi.fn(),
}));
vi.mock('../../src/modules/flito-logistica/flito-logistica.acta-pdf.js', () => ({
  generarActaPdf: vi.fn().mockResolvedValue('pdf-key'),
}));

const { despachar } = await import('../../src/modules/flito-logistica/flito-logistica.service.js');
const { firmarLlegadaFlit } = await import('../../src/modules/flito-logistica/flito-logistica-traslados-ciclo.service.js');
const {
  flitoLogisticaActas, flitoLogisticaDocumentos, flitoLogisticaTrasladoLts, flitoLogisticaTraslados,
} = await import('../../src/db/schema.js');

const TR = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ACTA = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const DOC = '00000001-1111-4111-8111-111111111111';
const ctx = { userId: 1, username: 'op', role: 'admin', operaAjenas: true };

type SetOp = { tabla: unknown; valores: Record<string, unknown> };
let sets: SetOp[];

function cola(...filas: unknown[][]) {
  for (const f of filas) selectMock.mockReturnValueOnce(chain(f));
}
const setDe = (tabla: unknown) => sets.find((s) => s.tabla === tabla)?.valores;

beforeEach(() => {
  sets = [];
  selectMock.mockReset();
  insertMock.mockReset().mockImplementation(() => ({ values: () => chain([]) }));
  updateMock.mockReset().mockImplementation((tabla: unknown) => ({
    set: (valores: Record<string, unknown>) => { sets.push({ tabla, valores }); return chain([]); },
  }));
  transactionMock.mockReset().mockImplementation(async (fn: (t: unknown) => unknown) => fn({
    select: selectMock, insert: insertMock, update: updateMock,
  }));
});

/** Selects del ciclo sobre el traslado: traslado, acta, líneas, documentos. */
function colaCiclo(destino: string) {
  cola(
    [{ id: TR, destino, origen: 'organismo', estado: 'registrado', mensajeroId: null }],
    [{ id: ACTA, estado: 'generada', mensajeroId: null }],
    [{ id: 'lin-1', documentoId: DOC, estado: 'registrado', precio: '18500.00', motivoLlegadaId: null }],
    [{ id: DOC, estado: 'clasificado' }],
  );
}

describe('despachar el acta de un viaje a FLIT', () => {
  it('pasa traslado y LT a en_ruta, acta a despachada y documentos a despachado', async () => {
    cola([{ id: ACTA, punto: 'flit', trasladoId: TR }]);
    colaCiclo('flit');
    const r = await despachar(ACTA, { mensajeroId: 7 }, ctx);
    expect(r).toMatchObject({ documentos: 1, trasladoId: TR, estado: 'en_ruta' });
    expect(setDe(flitoLogisticaTraslados)).toMatchObject({ estado: 'en_ruta', mensajeroId: 7 });
    expect(setDe(flitoLogisticaTrasladoLts)).toMatchObject({ estado: 'en_ruta' });
    expect(setDe(flitoLogisticaActas)).toMatchObject({ estado: 'despachada' });
    expect(setDe(flitoLogisticaDocumentos)?.estado).toBe('despachado');
  });

  it('después de despachar, la llegada a FLIT es admisible (traslado en_ruta)', async () => {
    cola(
      [{ id: TR, companiaId: 5, destino: 'flit', origen: 'organismo', estado: 'en_ruta', mensajeroId: 7 }],
      [{ proveedorId: null }], // HU #14346: compañía antes que licencias
      [{ id: ACTA, estado: 'despachada', mensajeroId: 7 }],
      [{ id: 'lin-1', documentoId: DOC, estado: 'en_ruta', precio: '18500.00', motivoLlegadaId: 'm1' }],
      [{ id: DOC, estado: 'despachado' }],
      [], // compañías de las licencias al pasar al proveedor vigente
    );
    const r = await firmarLlegadaFlit(TR, { firma: 'iVBORw0KGgo=' }, ctx);
    expect(r).toMatchObject({ estado: 'entregado', entregados: 1 });
  });
});

describe('sin cambio de comportamiento', () => {
  it('acta de cliente con traslado sigue despachando el traslado', async () => {
    cola([{ id: ACTA, punto: 'cliente', trasladoId: TR }]);
    colaCiclo('cliente');
    const r = await despachar(ACTA, { mensajeroId: 7 }, ctx);
    expect(r).toMatchObject({ trasladoId: TR, estado: 'en_ruta' });
    expect(setDe(flitoLogisticaTraslados)).toMatchObject({ estado: 'en_ruta' });
  });

  it('acta de organismo sin traslado conserva el camino legado (no toca traslados)', async () => {
    cola(
      [{ id: ACTA, punto: 'organismo', trasladoId: null }],
      [{ id: ACTA, estado: 'generada', mensajeroId: null }],
      [{ id: ACTA, estado: 'generada', mensajeroId: null }],
      [],
    );
    const r = await despachar(ACTA, { mensajeroId: 7 }, ctx);
    expect(r).toEqual({ documentos: 0 });
    expect(setDe(flitoLogisticaTraslados)).toBeUndefined();
    expect(setDe(flitoLogisticaActas)).toMatchObject({ estado: 'despachada', mensajeroId: 7 });
  });
});
