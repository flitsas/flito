import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chain } from '../helpers/db.js';

const selectMock = vi.fn();
const insertMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock,
    insert: insertMock,
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

describe('operaciones.repo — logOperacion (WORM insert)', () => {
  beforeEach(() => {
    selectMock.mockReset();
    insertMock.mockReset();
  });

  it('inserta operación con todos los campos', async () => {
    let captured: any = null;
    insertMock.mockReturnValueOnce({
      values: (v: any) => { captured = v; return chain([]); },
    });

    const { logOperacion } = await import('../../src/modules/rndc/operaciones.repo.js');
    await logOperacion({
      tipoOp: 'ingresarManifiesto',
      entidadTipo: 'manifiesto',
      entidadId: 10,
      intento: 3,
      modo: 'real',
      requestXml: '<req/>',
      responseXml: '<resp/>',
      resultado: 'ok',
      codigoResultado: '00',
      consecutivoRndc: 'CR-123',
      mensaje: 'OK',
      duracionMs: 250,
      ipOrigen: '10.0.0.1',
      createdBy: 7,
    });

    expect(captured).toMatchObject({
      tipoOp: 'ingresarManifiesto',
      entidadTipo: 'manifiesto',
      entidadId: 10,
      intento: 3,
      modo: 'real',
      requestXml: '<req/>',
      responseXml: '<resp/>',
      resultado: 'ok',
      codigoResultado: '00',
      consecutivoRndc: 'CR-123',
      duracionMs: 250,
      ipOrigen: '10.0.0.1',
      createdBy: 7,
    });
  });

  it('aplica defaults: intento=1, requestXml/responseXml/codigo/consecutivo/mensaje/ip/createdBy = null', async () => {
    let captured: any = null;
    insertMock.mockReturnValueOnce({
      values: (v: any) => { captured = v; return chain([]); },
    });

    const { logOperacion } = await import('../../src/modules/rndc/operaciones.repo.js');
    await logOperacion({
      tipoOp: 'consultarEstadoIngreso',
      entidadTipo: 'manifiesto',
      entidadId: 5,
      modo: 'mock',
      resultado: 'timeout',
    });

    expect(captured.intento).toBe(1);
    expect(captured.requestXml).toBeNull();
    expect(captured.responseXml).toBeNull();
    expect(captured.codigoResultado).toBeNull();
    expect(captured.consecutivoRndc).toBeNull();
    expect(captured.mensaje).toBeNull();
    expect(captured.ipOrigen).toBeNull();
    expect(captured.createdBy).toBeNull();
  });

  it('soporta resultado=error_negocio sin codigoResultado', async () => {
    let captured: any = null;
    insertMock.mockReturnValueOnce({
      values: (v: any) => { captured = v; return chain([]); },
    });

    const { logOperacion } = await import('../../src/modules/rndc/operaciones.repo.js');
    await logOperacion({
      tipoOp: 'ingresarRemesa',
      entidadTipo: 'remesa',
      entidadId: 1,
      modo: 'mock',
      resultado: 'error_negocio',
    });

    expect(captured.resultado).toBe('error_negocio');
  });
});

describe('operaciones.repo — listOperaciones', () => {
  beforeEach(() => {
    selectMock.mockReset();
  });

  it('default sin XML → no incluye requestXml/responseXml en el SELECT', async () => {
    let capturedCols: any = null;
    selectMock.mockImplementationOnce((cols: any) => {
      capturedCols = cols;
      return chain([
        { id: 1, tipoOp: 'ingresarManifiesto', resultado: 'ok' },
      ]);
    });

    const { listOperaciones } = await import('../../src/modules/rndc/operaciones.repo.js');
    const rows = await listOperaciones({ entidadTipo: 'manifiesto', entidadId: 10 });
    expect(rows).toHaveLength(1);
    expect(capturedCols).not.toHaveProperty('requestXml');
    expect(capturedCols).not.toHaveProperty('responseXml');
    expect(capturedCols).toHaveProperty('id');
    expect(capturedCols).toHaveProperty('tipoOp');
  });

  it('con incluirXml=true → SELECT incluye XML', async () => {
    let capturedCols: any = null;
    selectMock.mockImplementationOnce((cols: any) => {
      capturedCols = cols;
      return chain([]);
    });

    const { listOperaciones } = await import('../../src/modules/rndc/operaciones.repo.js');
    await listOperaciones({ entidadTipo: 'manifiesto', entidadId: 10, incluirXml: true });
    expect(capturedCols).toHaveProperty('requestXml');
    expect(capturedCols).toHaveProperty('responseXml');
  });

  it('limit cap a 200 (defensa contra ataques de exfiltración)', async () => {
    let capturedLimit: any = null;
    selectMock.mockImplementationOnce(() => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: (n: number) => { capturedLimit = n; return Promise.resolve([]); },
          }),
        }),
      }),
    }));

    const { listOperaciones } = await import('../../src/modules/rndc/operaciones.repo.js');
    await listOperaciones({ entidadTipo: 'manifiesto', entidadId: 10, limit: 999 });
    expect(capturedLimit).toBe(200); // capeado, no 999
  });

  it('limit por defecto = 50', async () => {
    let capturedLimit: any = null;
    selectMock.mockImplementationOnce(() => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: (n: number) => { capturedLimit = n; return Promise.resolve([]); },
          }),
        }),
      }),
    }));

    const { listOperaciones } = await import('../../src/modules/rndc/operaciones.repo.js');
    await listOperaciones({ entidadTipo: 'remesa', entidadId: 5 });
    expect(capturedLimit).toBe(50);
  });

  it('limit válido (< 200) se respeta', async () => {
    let capturedLimit: any = null;
    selectMock.mockImplementationOnce(() => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: (n: number) => { capturedLimit = n; return Promise.resolve([]); },
          }),
        }),
      }),
    }));

    const { listOperaciones } = await import('../../src/modules/rndc/operaciones.repo.js');
    await listOperaciones({ entidadTipo: 'manifiesto', entidadId: 10, limit: 30 });
    expect(capturedLimit).toBe(30);
  });
});
