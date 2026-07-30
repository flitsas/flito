// FLITO Derechos de trámite — el Drive de la secretaría desde el módulo (HU #11010).
//
// Sustituye a los tests del barrido por organismo de la HU #10952, que se retiró: aquel recorría
// todas las secretarías con carpeta configurada y ninguna la tenía. Ahora hay una carpeta, la de
// Medellín, y el disparo es manual. Lo que hay que fijar es distinto: qué se lista, a qué organismo
// se atribuye lo procesado, y que un archivo roto quede anotado como error en vez de en «procesando».
//
// El OCR y el cruce por placa no se prueban aquí: ya viven en flito-derechos.test.ts y este servicio
// los reusa tal cual.

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
vi.mock('../../src/services/googleDrive.js', () => ({
  listFiles: listFilesMock,
  downloadFile: vi.fn(),
  listFolders: vi.fn(),
  searchFiles: vi.fn(),
}));

const analizarPdfDeDriveMock = vi.fn();
const separarPorPlacaMock = vi.fn();
vi.mock('../../src/modules/drive/procesador.service.js', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, analizarPdfDeDrive: analizarPdfDeDriveMock, separarPorPlaca: separarPorPlacaMock };
});

const registrarDesdeExtraccionMock = vi.fn();
vi.mock('../../src/modules/flito-derechos/flito-derechos.service.js', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, registrarDesdeExtraccion: registrarDesdeExtraccionMock };
});

const { archivosDelDrive, procesarArchivoDrive, ORGANISMO_DRIVE } =
  await import('../../src/modules/flito-derechos/flito-derechos-drive.service.js');

beforeEach(() => {
  selectMock.mockReset(); insertMock.mockReset(); updateMock.mockReset();
  listFilesMock.mockReset(); analizarPdfDeDriveMock.mockReset(); separarPorPlacaMock.mockReset();
  registrarDesdeExtraccionMock.mockReset();
});

const CTX = { userId: 1, username: 'ops@x.io', role: 'admin' };

const archivoDrive = (id: string, name: string, modifiedTime = '2026-07-18T10:00:00Z') => ({
  id, name, mimeType: 'application/pdf', size: '2048', createdTime: modifiedTime, modifiedTime,
  webViewLink: '', parents: [],
  lastModifyingUser: { displayName: 'carteraitsmedellin', emailAddress: 'cartera@its.gov.co' },
});

/** El alta del registro de auditoría, que toda llamada a `procesarArchivoDrive` hace primero. */
const altaAuditoria = () => insertMock.mockReturnValueOnce({
  values: () => ({ returning: () => Promise.resolve([{ id: 77 }]) }),
});

/** Captura lo que se escribe al cerrar el registro de auditoría. */
const cierreAuditoria = () => {
  const escrito: Record<string, unknown>[] = [];
  updateMock.mockReturnValue({
    set: (v: Record<string, unknown>) => { escrito.push(v); return { where: () => Promise.resolve(undefined) }; },
  });
  return escrito;
};

const resultadoVacio = () => ({
  registrados: [], enRevision: [], duplicados: [], pendientes: [], omitidas: [], fallidos: [],
});

describe('archivosDelDrive — qué se ofrece para procesar', () => {
  it('deja fuera lo que no es PDF: la carpeta también tiene hojas de cálculo', async () => {
    listFilesMock.mockResolvedValueOnce([
      archivoDrive('f1', 'FLIT 18-07-2026.pdf'),
      archivoDrive('f2', 'control interno.xlsx'),
      archivoDrive('f3', 'notas.txt'),
    ]);
    selectMock.mockReturnValueOnce(chain([]));

    const out = await archivosDelDrive();

    expect(out.map((a) => a.nombre)).toEqual(['FLIT 18-07-2026.pdf']);
  });

  it('no consulta la base si la carpeta no trae ningún PDF', async () => {
    listFilesMock.mockResolvedValueOnce([archivoDrive('f2', 'control interno.xlsx')]);

    expect(await archivosDelDrive()).toEqual([]);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('marca el ya procesado con su fecha, y el resto en null', async () => {
    listFilesMock.mockResolvedValueOnce([
      archivoDrive('f1', 'FLIT 18-07-2026.pdf'),
      archivoDrive('f2', 'FLIT 19-07-2026.pdf'),
    ]);
    selectMock.mockReturnValueOnce(chain([
      { fileId: 'f1', createdAt: new Date('2026-07-18T15:00:00Z') },
    ]));

    const out = await archivosDelDrive();

    expect(out.find((a) => a.fileId === 'f1')?.procesadoEn).toBe('2026-07-18T15:00:00.000Z');
    expect(out.find((a) => a.fileId === 'f2')?.procesadoEn).toBeNull();
  });

  it('haber procesado dos veces el mismo archivo muestra la vez más reciente', async () => {
    listFilesMock.mockResolvedValueOnce([archivoDrive('f1', 'FLIT 18-07-2026.pdf')]);
    // La consulta viene ordenada por fecha descendente: la primera fila es la buena.
    selectMock.mockReturnValueOnce(chain([
      { fileId: 'f1', createdAt: new Date('2026-07-20T09:00:00Z') },
      { fileId: 'f1', createdAt: new Date('2026-07-18T15:00:00Z') },
    ]));

    const out = await archivosDelDrive();

    expect(out[0].procesadoEn).toBe('2026-07-20T09:00:00.000Z');
  });
});

describe('archivosDelDrive — quién modificó', () => {
  it('nombra a quien tocó el archivo, no solo cuándo', async () => {
    // En una carpeta compartida la fecha sola no es accionable: hace falta saber a quién preguntar.
    listFilesMock.mockResolvedValueOnce([archivoDrive('f1', 'FLIT 18-07-2026.pdf')]);
    selectMock.mockReturnValueOnce(chain([]));

    const [a] = await archivosDelDrive();

    expect(a.modificadoPor).toBe('carteraitsmedellin');
  });

  it('cae al correo si Google no expone el nombre', async () => {
    listFilesMock.mockResolvedValueOnce([{
      ...archivoDrive('f1', 'FLIT 18-07-2026.pdf'),
      lastModifyingUser: { emailAddress: 'cartera@its.gov.co' },
    }]);
    selectMock.mockReturnValueOnce(chain([]));

    expect((await archivosDelDrive())[0].modificadoPor).toBe('cartera@its.gov.co');
  });

  it('sin autor no inventa nada', async () => {
    listFilesMock.mockResolvedValueOnce([{ ...archivoDrive('f1', 'a.pdf'), lastModifyingUser: undefined }]);
    selectMock.mockReturnValueOnce(chain([]));

    expect((await archivosDelDrive())[0].modificadoPor).toBeNull();
  });

  it('distingue el dado por visto del nunca mirado', async () => {
    // «Omitido» lo escribe el arranque del barrido: es distinto de no tener registro.
    listFilesMock.mockResolvedValueOnce([archivoDrive('f1', 'visto.pdf'), archivoDrive('f2', 'nuevo.pdf')]);
    selectMock.mockReturnValueOnce(chain([
      { fileId: 'f1', estado: 'omitido', createdAt: new Date('2026-07-29T14:00:00Z') },
    ]));

    const out = await archivosDelDrive();
    const visto = out.find((a) => a.fileId === 'f1')!;
    const nuevo = out.find((a) => a.fileId === 'f2')!;

    expect(visto.omitidoEn).toBe('2026-07-29T14:00:00.000Z');
    expect(visto.procesadoEn).toBeNull();
    expect(nuevo.omitidoEn).toBeNull();
    expect(nuevo.procesadoEn).toBeNull();
  });
});

describe('procesarArchivoDrive — el consolidado del día', () => {
  const analizado = () => ({
    name: 'FLIT 18-07-2026.pdf',
    srcDoc: {} as never,
    totalPaginas: 3,
    cuentas: [
      { placa: 'QYS441', valorTotal: 120_000 },
      { placa: 'NOP111', valorTotal: 80_000 },
    ],
    paginasPorPlaca: new Map([['QYS441', [0, 1]], ['NOP111', [2]]]),
  });

  it('atribuye cada recibo a la secretaría del Drive, no a «sin organismo»', async () => {
    altaAuditoria();
    cierreAuditoria();
    analizarPdfDeDriveMock.mockResolvedValueOnce(analizado());
    separarPorPlacaMock.mockResolvedValueOnce(new Map([
      ['QYS441', Buffer.from('%PDF-1')],
      ['NOP111', Buffer.from('%PDF-2')],
    ]));
    registrarDesdeExtraccionMock.mockResolvedValue(resultadoVacio());

    await procesarArchivoDrive('f1', CTX);

    expect(registrarDesdeExtraccionMock).toHaveBeenCalledTimes(2);
    for (const llamada of registrarDesdeExtraccionMock.mock.calls) {
      expect(llamada[2]).toEqual({ origen: 'drive', organismoCodigo: ORGANISMO_DRIVE });
    }
  });

  it('varias páginas de una misma placa son un solo recibo, no dos pagos', async () => {
    altaAuditoria();
    cierreAuditoria();
    analizarPdfDeDriveMock.mockResolvedValueOnce({
      ...analizado(),
      // El OCR devuelve una lectura por página: la placa se repite.
      cuentas: [
        { placa: 'QYS441', valorTotal: 120_000 },
        { placa: 'QYS441', valorTotal: 120_000 },
        { placa: 'NOP111', valorTotal: 80_000 },
      ],
    });
    separarPorPlacaMock.mockResolvedValueOnce(new Map([
      ['QYS441', Buffer.from('%PDF-1')],
      ['NOP111', Buffer.from('%PDF-2')],
    ]));
    registrarDesdeExtraccionMock.mockResolvedValue(resultadoVacio());

    const out = await procesarArchivoDrive('f1', CTX);

    expect(registrarDesdeExtraccionMock).toHaveBeenCalledTimes(2);
    expect(out.placasUnicas).toBe(2);
    expect(out.cuentasDetectadas).toBe(3);
  });

  it('una placa que falla no tumba el día: el resto se registra igual', async () => {
    altaAuditoria();
    cierreAuditoria();
    analizarPdfDeDriveMock.mockResolvedValueOnce(analizado());
    separarPorPlacaMock.mockResolvedValueOnce(new Map([
      ['QYS441', Buffer.from('%PDF-1')],
      ['NOP111', Buffer.from('%PDF-2')],
    ]));
    registrarDesdeExtraccionMock
      .mockRejectedValueOnce(new Error('MinIO no responde'))
      .mockResolvedValueOnce({ ...resultadoVacio(), registrados: [{ archivo: 'NOP111.pdf' }] });

    const out = await procesarArchivoDrive('f1', CTX);

    expect(out.registrados).toHaveLength(1);
    expect(out.fallidos).toEqual([expect.objectContaining({ placa: 'QYS441', detalle: 'MinIO no responde' })]);
  });

  it('cierra el registro de auditoría con el resumen del consolidado', async () => {
    altaAuditoria();
    const escrito = cierreAuditoria();
    analizarPdfDeDriveMock.mockResolvedValueOnce(analizado());
    separarPorPlacaMock.mockResolvedValueOnce(new Map([['QYS441', Buffer.from('%PDF-1')]]));
    registrarDesdeExtraccionMock.mockResolvedValue(resultadoVacio());

    await procesarArchivoDrive('f1', CTX);

    expect(escrito).toEqual([expect.objectContaining({
      estado: 'completado',
      nombreArchivo: 'FLIT 18-07-2026.pdf',
      totalPaginas: 3,
      cuentasDetectadas: 2,
      placasUnicas: 1,
      valorTotal: '200000',
      organismoCodigo: ORGANISMO_DRIVE,
    })]);
  });

  it('un PDF ilegible deja el registro en error, no colgado en «procesando»', async () => {
    altaAuditoria();
    const escrito = cierreAuditoria();
    analizarPdfDeDriveMock.mockRejectedValueOnce(new Error('El archivo debe ser PDF'));

    await expect(procesarArchivoDrive('f1', CTX)).rejects.toThrow('El archivo debe ser PDF');
    expect(escrito).toEqual([{ estado: 'error', error: 'El archivo debe ser PDF' }]);
  });

  it('si tampoco se puede anotar el error, se propaga el error original y no el del apunte', async () => {
    altaAuditoria();
    updateMock.mockImplementation(() => { throw new Error('la conexión se cayó'); });
    analizarPdfDeDriveMock.mockRejectedValueOnce(new Error('El archivo debe ser PDF'));

    await expect(procesarArchivoDrive('f1', CTX)).rejects.toThrow('El archivo debe ser PDF');
  });
});
