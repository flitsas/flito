// HU #11251 — bitácora inalterable de las operaciones contra Siigo (Feature #11239).
//
// La inmutabilidad la garantizan disparadores en Postgres, así que AC2 se verifica contra la base
// real en el PR (ver descripción) y aquí se cubre lo que sí es lógica de aplicación: qué se escribe,
// qué NUNCA se escribe, cómo se consulta y qué pasa si la escritura falla.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chain, chainReject } from '../helpers/db.js';

const insertMock = vi.fn();
const selectMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { insert: insertMock, select: selectMock, update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));

const { registrarOperacion, consultarBitacora, sanearCuerpo } =
  await import('../../src/modules/siigo/siigo.operaciones.repo.js');

/** Captura los valores del INSERT. */
function espiarInsert() {
  const espia = vi.fn();
  insertMock.mockReturnValue({
    values: (v: Record<string, unknown>) => { espia(v); return Promise.resolve([]); },
  });
  return espia;
}

beforeEach(() => { insertMock.mockReset(); selectMock.mockReset(); });

describe('AC1 — toda operación deja rastro', () => {
  it('registra los campos que permiten reconstruir qué pasó', async () => {
    const espia = espiarInsert();

    await registrarOperacion({
      operacion: 'crear_factura',
      metodo: 'POST',
      ruta: '/v1/invoices',
      entidadTipo: 'tramite',
      entidadId: 'abc-123',
      intento: 2,
      ambiente: 'pruebas',
      modo: 'real',
      requestBody: { date: '2026-08-04' },
      responseBody: { id: 'inv-1' },
      statusHttp: 201,
      resultado: 'ok',
      duracionMs: 842,
      createdBy: 7,
    });

    expect(espia).toHaveBeenCalledTimes(1);
    expect(espia.mock.calls[0]![0]).toMatchObject({
      operacion: 'crear_factura', metodo: 'POST', ruta: '/v1/invoices',
      entidadTipo: 'tramite', entidadId: 'abc-123', intento: 2,
      ambiente: 'pruebas', modo: 'real', statusHttp: 201,
      resultado: 'ok', duracionMs: 842, createdBy: 7,
    });
  });

  it('los campos opcionales quedan en null, no en undefined', async () => {
    const espia = espiarInsert();
    await registrarOperacion({ operacion: 'auth', ambiente: 'pruebas', resultado: 'ok' });

    const fila = espia.mock.calls[0]![0] as Record<string, unknown>;
    expect(fila.metodo).toBeNull();
    expect(fila.entidadId).toBeNull();
    expect(fila.requestBody).toBeNull();
    expect(fila.duracionMs).toBeNull();
  });

  it('el intento y el modo tienen valores por defecto sensatos', async () => {
    const espia = espiarInsert();
    await registrarOperacion({ operacion: 'auth', ambiente: 'pruebas', resultado: 'ok' });

    expect(espia.mock.calls[0]![0]).toMatchObject({ intento: 1, modo: 'real' });
  });

  it('también registra los fallos, no solo los éxitos', async () => {
    const espia = espiarInsert();
    await registrarOperacion({
      operacion: 'crear_factura', ambiente: 'produccion',
      resultado: 'error_negocio', codigo: 'parameter_required',
      mensaje: 'Falta un parámetro obligatorio', statusHttp: 400,
    });

    expect(espia.mock.calls[0]![0]).toMatchObject({
      resultado: 'error_negocio', codigo: 'parameter_required', statusHttp: 400,
    });
  });
});

describe('AC3 — la bitácora no guarda secretos', () => {
  it('el access_key del cuerpo de autenticación se sustituye', async () => {
    const espia = espiarInsert();
    await registrarOperacion({
      operacion: 'auth', ambiente: 'pruebas', resultado: 'ok',
      requestBody: { username: 'usuario@flitsas.com', access_key: 'SECRETO-REAL' },
    });

    const fila = espia.mock.calls[0]![0] as Record<string, unknown>;
    expect(JSON.stringify(fila)).not.toContain('SECRETO-REAL');
    expect((fila.requestBody as Record<string, unknown>).access_key).toBe('[REDACTED]');
    // El resto sí se conserva: sin username no se puede diagnosticar nada.
    expect((fila.requestBody as Record<string, unknown>).username).toBe('usuario@flitsas.com');
  });

  it.each(['Authorization', 'authorization', 'AUTHORIZATION', 'Access_Key', 'token'])(
    'la clave %s se redacta sin importar cómo esté escrita', (clave) => {
      const saneado = sanearCuerpo({ [clave]: 'valor-secreto' }) as Record<string, unknown>;
      expect(saneado[clave]).toBe('[REDACTED]');
    },
  );

  it('sanea también en objetos anidados', () => {
    const saneado = sanearCuerpo({
      headers: { Authorization: 'Bearer tok-123' },
      datos: { cliente: { access_key: 'x' }, nombre: 'ACME' },
    }) as Record<string, Record<string, unknown>>;

    expect(JSON.stringify(saneado)).not.toContain('tok-123');
    expect(saneado.headers.Authorization).toBe('[REDACTED]');
    expect((saneado.datos.cliente as Record<string, unknown>).access_key).toBe('[REDACTED]');
    expect(saneado.datos.nombre).toBe('ACME');
  });

  it('sanea dentro de arreglos', () => {
    const saneado = sanearCuerpo({ items: [{ token: 'a' }, { token: 'b' }] }) as Record<string, unknown[]>;
    expect(JSON.stringify(saneado)).not.toMatch(/"a"|"b"/);
  });

  it('no muta el objeto original', () => {
    const original = { access_key: 'SECRETO' };
    sanearCuerpo(original);
    expect(original.access_key).toBe('SECRETO');
  });

  it('una estructura circular no cuelga el saneamiento', () => {
    const circular: Record<string, unknown> = { nombre: 'x' };
    circular.self = circular;
    expect(() => sanearCuerpo(circular)).not.toThrow();
  });

  it('los valores primitivos pasan tal cual', () => {
    expect(sanearCuerpo('texto')).toBe('texto');
    expect(sanearCuerpo(42)).toBe(42);
    expect(sanearCuerpo(null)).toBeNull();
  });
});

describe('AC4 — consulta para auditoría', () => {
  it('consulta por entidad', async () => {
    selectMock.mockReturnValue(chain([{ id: 1 }]));
    const filas = await consultarBitacora({ entidadTipo: 'tramite', entidadId: 'abc' });
    expect(filas).toHaveLength(1);
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('consulta por rango de fechas', async () => {
    selectMock.mockReturnValue(chain([{ id: 1 }, { id: 2 }]));
    const filas = await consultarBitacora({
      desde: new Date('2026-08-01'), hasta: new Date('2026-08-31'),
    });
    expect(filas).toHaveLength(2);
  });

  it('sin filtros también funciona', async () => {
    selectMock.mockReturnValue(chain([]));
    await expect(consultarBitacora()).resolves.toEqual([]);
  });

  it('permite filtrar solo los fallos', async () => {
    selectMock.mockReturnValue(chain([{ id: 3, resultado: 'error_negocio' }]));
    const filas = await consultarBitacora({ resultado: 'error_negocio' });
    expect(filas[0]).toMatchObject({ resultado: 'error_negocio' });
  });
});

describe('AC5 — un fallo al registrar no tumba la operación', () => {
  it('un error de base de datos no se propaga', async () => {
    insertMock.mockReturnValue({ values: () => chainReject(new Error('BD caída')) });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // La factura ya se emitió: que la bitácora falle no puede deshacerla.
    await expect(registrarOperacion({
      operacion: 'crear_factura', ambiente: 'pruebas', resultado: 'ok',
    })).resolves.toBeUndefined();

    errSpy.mockRestore();
  });

  it('el fallo queda reportado en el registro de la aplicación', async () => {
    insertMock.mockReturnValue({ values: () => chainReject(new Error('BD caída')) });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await registrarOperacion({ operacion: 'crear_factura', ambiente: 'pruebas', resultado: 'ok' });

    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]![0]).toMatch(/no se pudo registrar la operación/);
    errSpy.mockRestore();
  });

  it('una excepción síncrona tampoco escapa', async () => {
    insertMock.mockImplementation(() => { throw new Error('cliente sin inicializar'); });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(registrarOperacion({
      operacion: 'auth', ambiente: 'pruebas', resultado: 'ok',
    })).resolves.toBeUndefined();

    errSpy.mockRestore();
  });
});

describe('el módulo no ofrece forma de alterar la bitácora', () => {
  it('solo exporta inserción, consulta y saneamiento', async () => {
    const modulo = await import('../../src/modules/siigo/siigo.operaciones.repo.js');
    const exportados = Object.keys(modulo).sort();

    expect(exportados).toEqual(['consultarBitacora', 'registrarOperacion', 'sanearCuerpo']);
    // Ni actualizar ni borrar: la base los prohíbe, y ofrecerlos aquí solo daría un error peor.
    expect(exportados).not.toContain('actualizarOperacion');
    expect(exportados).not.toContain('borrarOperacion');
  });
});
