// FLITO Derechos de trámite — sincronización desde el Drive del organismo (HU #10952).
//
// Lo que importa aquí no es el OCR (ya cubierto en flito-derechos.test.ts) sino las reglas del
// barrido: qué organismos entran, qué archivos se saltan por idempotencia, y que un organismo
// caído no arrastre a los demás.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chain } from '../helpers/db.js';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: insertMock, update: updateMock, delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));

const listFilesMock = vi.fn();
const downloadFileMock = vi.fn();
vi.mock('../../src/services/googleDrive.js', () => ({
  listFiles: listFilesMock,
  downloadFile: downloadFileMock,
  listFolders: vi.fn(),
  searchFiles: vi.fn(),
}));

const cargarDerechosMock = vi.fn();
vi.mock('../../src/modules/flito-derechos/flito-derechos.service.js', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, cargarDerechos: cargarDerechosMock };
});

const { sincronizarDerechosDrive, organismosConDrive } = await import('../../src/modules/flito-derechos/flito-derechos-drive.service.js');

beforeEach(() => {
  selectMock.mockReset(); insertMock.mockReset(); updateMock.mockReset();
  listFilesMock.mockReset(); downloadFileMock.mockReset(); cargarDerechosMock.mockReset();
});

const CTX = { userId: 1, username: 'ops@x.io', role: 'admin' };

const resultadoVacio = () => ({
  registrados: [], enRevision: [], duplicados: [], pendientes: [], omitidas: [], fallidos: [],
});
const resultadoConUno = () => ({ ...resultadoVacio(), registrados: [{ archivo: 'a.pdf' }] });

const archivoDrive = (id: string, name = 'recibos.pdf', modifiedTime = '2026-05-20T10:00:00Z') =>
  ({ id, name, mimeType: 'application/pdf', size: '100', createdTime: modifiedTime, modifiedTime, webViewLink: '', parents: [] });

describe('organismosConDrive — configurar no es lo mismo que activar', () => {
  it('descarta los que tienen la sincronización encendida pero sin carpeta puesta', async () => {
    selectMock.mockReturnValueOnce(chain([
      { codigo: '05001', folderId: 'folder-medellin' },
      { codigo: '05088', folderId: null },
      { codigo: '05360', folderId: '' },
    ]));
    const out = await organismosConDrive();
    expect(out.map((o) => o.codigo)).toEqual(['05001']);
  });
});

describe('sincronizarDerechosDrive', () => {
  it('AC1 — procesa el archivo nuevo con origen drive y lo marca completado', async () => {
    selectMock
      .mockReturnValueOnce(chain([{ codigo: '05001', folderId: 'f1' }]))  // organismos
      .mockReturnValueOnce(chain([]));                                    // yaProcesado → no
    listFilesMock.mockResolvedValueOnce([archivoDrive('file-1')]);
    insertMock.mockReturnValue(chain([{ id: 10 }]));
    updateMock.mockReturnValue(chain([]));
    downloadFileMock.mockResolvedValueOnce({ buffer: Buffer.from('%PDF'), name: 'recibos.pdf', mimeType: 'application/pdf' });
    cargarDerechosMock.mockResolvedValueOnce(resultadoConUno());

    const r = await sincronizarDerechosDrive(CTX);

    expect(r.organismosActivos).toBe(1);
    expect(r.organismos[0]).toMatchObject({ organismoCodigo: '05001', archivosNuevos: 1, registrados: 1 });
    // El origen y el organismo viajan al pipeline: es lo que distingue esta vía de la carga manual.
    expect(cargarDerechosMock).toHaveBeenCalledWith(
      expect.anything(),
      { organismoCodigo: '05001', origen: 'drive' },
      expect.anything(),
    );
  });

  it('AC3 — un archivo ya procesado y sin cambios no se descarga de nuevo', async () => {
    selectMock
      .mockReturnValueOnce(chain([{ codigo: '05001', folderId: 'f1' }]))
      .mockReturnValueOnce(chain([{ modificado: new Date('2026-05-20T10:00:00Z') }]));
    listFilesMock.mockResolvedValueOnce([archivoDrive('file-1')]);

    const r = await sincronizarDerechosDrive(CTX);

    expect(r.organismos[0].archivosNuevos).toBe(0);
    expect(downloadFileMock).not.toHaveBeenCalled();
    expect(cargarDerechosMock).not.toHaveBeenCalled();
  });

  it('AC3 — el mismo id con fecha de modificación posterior SÍ se reprocesa', async () => {
    selectMock
      .mockReturnValueOnce(chain([{ codigo: '05001', folderId: 'f1' }]))
      .mockReturnValueOnce(chain([{ modificado: new Date('2026-05-20T10:00:00Z') }]));
    listFilesMock.mockResolvedValueOnce([archivoDrive('file-1', 'recibos.pdf', '2026-06-01T10:00:00Z')]);
    insertMock.mockReturnValue(chain([{ id: 11 }]));
    updateMock.mockReturnValue(chain([]));
    downloadFileMock.mockResolvedValueOnce({ buffer: Buffer.from('%PDF'), name: 'recibos.pdf', mimeType: 'application/pdf' });
    cargarDerechosMock.mockResolvedValueOnce(resultadoVacio());

    const r = await sincronizarDerechosDrive(CTX);
    expect(r.organismos[0].archivosNuevos).toBe(1);
    expect(downloadFileMock).toHaveBeenCalledOnce();
  });

  it('ignora los archivos de la carpeta que no son procesables', async () => {
    selectMock.mockReturnValueOnce(chain([{ codigo: '05001', folderId: 'f1' }]));
    listFilesMock.mockResolvedValueOnce([archivoDrive('file-1', 'notas.txt'), archivoDrive('file-2', 'hoja.xlsx')]);

    const r = await sincronizarDerechosDrive(CTX);
    expect(r.organismos[0].archivosNuevos).toBe(0);
    expect(downloadFileMock).not.toHaveBeenCalled();
  });

  it('AC5 — sin organismos activos no hace nada y no falla', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const r = await sincronizarDerechosDrive(CTX);
    expect(r).toEqual({ organismos: [], organismosActivos: 0 });
    expect(listFilesMock).not.toHaveBeenCalled();
  });

  it('AC6 — si Drive falla para un organismo, el resto se procesa igual', async () => {
    selectMock
      .mockReturnValueOnce(chain([{ codigo: '05001', folderId: 'f1' }, { codigo: '05088', folderId: 'f2' }]))
      .mockReturnValueOnce(chain([]));  // yaProcesado del segundo organismo
    listFilesMock
      .mockRejectedValueOnce(new Error('Drive no responde'))
      .mockResolvedValueOnce([archivoDrive('file-2')]);
    insertMock.mockReturnValue(chain([{ id: 12 }]));
    updateMock.mockReturnValue(chain([]));
    downloadFileMock.mockResolvedValueOnce({ buffer: Buffer.from('%PDF'), name: 'r.pdf', mimeType: 'application/pdf' });
    cargarDerechosMock.mockResolvedValueOnce(resultadoConUno());

    const r = await sincronizarDerechosDrive(CTX);

    expect(r.organismos).toHaveLength(2);
    expect(r.organismos[0]).toMatchObject({ organismoCodigo: '05001', error: 'Drive no responde' });
    expect(r.organismos[1]).toMatchObject({ organismoCodigo: '05088', registrados: 1 });
  });

  it('AC6 — un archivo que falla queda en error, no en completado, para reintentarlo después', async () => {
    selectMock
      .mockReturnValueOnce(chain([{ codigo: '05001', folderId: 'f1' }]))
      .mockReturnValueOnce(chain([]));
    listFilesMock.mockResolvedValueOnce([archivoDrive('file-1')]);
    insertMock.mockReturnValue(chain([{ id: 13 }]));
    updateMock.mockReturnValue(chain([]));
    downloadFileMock.mockRejectedValueOnce(new Error('descarga interrumpida'));

    const r = await sincronizarDerechosDrive(CTX);

    expect(r.organismos[0].fallidos).toBe(1);
    expect(r.organismos[0].archivosNuevos).toBe(0);
    expect(r.organismos[0].error).toBeUndefined(); // el organismo no falló: falló UN archivo
  });

  it('acota el barrido a un solo organismo cuando se pide (botón sincronizar ahora)', async () => {
    selectMock.mockReturnValueOnce(chain([{ codigo: '05001', folderId: 'f1' }]));
    listFilesMock.mockResolvedValueOnce([]);

    const r = await sincronizarDerechosDrive(CTX, '05001');
    expect(r.organismosActivos).toBe(1);
    expect(listFilesMock).toHaveBeenCalledWith('f1', 200);
  });
});
