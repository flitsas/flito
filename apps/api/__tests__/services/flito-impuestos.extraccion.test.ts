// HU #12826 — paso «extracción» del análisis post-envío: parser si hay Notas Finales (AC1), OCR si
// no (AC2), `error_analisis` sin factura / con OCR caído, UPDATE solo sobre `en_curso` y registro de
// acceso a datos personales sin valores. FLIT, fetch, pdftotext y el OCR van mockeados; el texto es
// el fixture INVENTADO del parser. Los WHERE se asertan sobre el SQL renderizado.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const selectMock = vi.fn();
const updateMock = vi.fn();
const obtenerUrlFactura = vi.fn();
const textoPdf = vi.fn();
const extraerVehiculoFacturaVenta = vi.fn();
const logPiiAccess = vi.fn();

class OcrNoDisponibleErrorMock extends Error {}

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, update: updateMock, insert: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/modules/flito-sync/flit.adapter.js', () => ({ getFlitAdapter: () => ({ obtenerUrlFactura }) }));
vi.mock('../../src/modules/flito-ocr/flito-ocr-local.js', () => ({ textoPdf }));
vi.mock('../../src/modules/flito-ocr/flito-ocr.service.js', () => ({
  extraerVehiculoFacturaVenta, OcrNoDisponibleError: OcrNoDisponibleErrorMock,
}));
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess }));

const { pasoExtraccion, FacturaNoDisponibleError, TOPE_FACTURA_BYTES } =
  await import('../../src/modules/flito-impuestos/flito-impuestos.extraccion.js');
const { registrarPasosAnalisisImpuestos } = await import('../../src/modules/flito-impuestos/flito-impuestos.analisis.pasos.js');
const { __resetColaAnalisis, ejecutarAnalisis } = await import('../../src/modules/flito-impuestos/flito-impuestos.analisis.service.js');
const { limitadorRunt } = await import('../../src/modules/flito-impuestos/runt-limitador.js');

const FIXTURE = readFileSync(fileURLToPath(new URL('../fixtures/factura-flit-notas-finales.txt', import.meta.url)), 'utf8');
const RAW = '1 ABC000000001 Modelox Turbo Unid 1 $10.000.000,00 $0,00 $0,00 $10.000.000,00';
const PDF = Buffer.from('%PDF-1.7 inventado');
const URL_FIRMADA = 'https://flit.example.invalid/factura.pdf?X-Amz-Signature=secreta';
const A = '00000000-0000-0000-0000-00000000000a';

const render = (w: SQL) => new PgDialect().sqlToQuery(w);
interface Grabacion { set?: Record<string, unknown>; where?: SQL }
function grabador(filas: unknown[] = [], g: Grabacion = {}) {
  const c: Record<string, unknown> = {};
  Object.assign(c, {
    from: () => c, innerJoin: () => c, limit: () => c,
    set: (v: Record<string, unknown>) => { g.set = v; return c; },
    where: (w: SQL) => { g.where = w; return c; },
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(filas).then(res, rej),
  });
  return c;
}
function updates(): Grabacion[] {
  const g: Grabacion[] = [];
  updateMock.mockImplementation(() => { const x: Grabacion = {}; g.push(x); return grabador([], x); });
  return g;
}
const conFactura = () => selectMock.mockReturnValue(grabador([{ facturaId: 'FV-1' }]));
const respuesta = (cuerpo: Buffer, init: ResponseInit = {}) => new Response(new Uint8Array(cuerpo), init);
const fetchMock = vi.fn();
const ocrVacio = () => Object.fromEntries(
  ['vin', 'marca', 'linea', 'anioVehiculo', 'color', 'cilindrada', 'clase', 'direccion', 'municipio', 'departamento']
    .map((c) => [c, { valor: null, confianza: 0, confiable: false }]),
);

beforeEach(() => {
  __resetColaAnalisis();
  for (const m of [selectMock, updateMock, obtenerUrlFactura, textoPdf, extraerVehiculoFacturaVenta, logPiiAccess, fetchMock]) m.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  obtenerUrlFactura.mockResolvedValue(URL_FIRMADA);
  fetchMock.mockResolvedValue(respuesta(PDF));
  textoPdf.mockImplementation(async (_b: Buffer, modo = '-layout') => (modo === '-raw' ? RAW : FIXTURE));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('AC1 — factura con Notas Finales', () => {
  it('persiste los 10 campos con fuente notas_finales y NO llama al OCR', async () => {
    conFactura();
    const g = updates();
    await pasoExtraccion({ impuestoId: A, runt: limitadorRunt });

    expect(extraerVehiculoFacturaVenta).not.toHaveBeenCalled();
    const e = g[0].set!.extraccionFacturaVenta as Record<string, { valor: string | null; confiable: boolean }> & { fuente: string };
    expect(e.fuente).toBe('notas_finales');
    expect(e.vin).toMatchObject({ valor: '9ABCD1234EF567890', confiable: true });
    expect(e.anioVehiculo).toMatchObject({ valor: '2026', confiable: true });
    expect(e.linea).toMatchObject({ valor: 'Modelox Turbo', confiable: true });
    expect(e.direccion).toMatchObject({ valor: 'CL 1 # 2-3 OF 4', confiable: true });
    expect(Object.keys(e).sort()).toEqual([
      'anioVehiculo', 'cilindrada', 'clase', 'color', 'departamento', 'direccion', 'fuente', 'linea', 'marca', 'municipio', 'vin',
    ]);
  });

  it('el UPDATE solo toca la fila si sigue en_curso (condición renderizada, no la fila del mock)', async () => {
    conFactura();
    const g = updates();
    await pasoExtraccion({ impuestoId: A, runt: limitadorRunt });
    const q = render(g[0].where!);
    expect(q.sql).toMatch(/"analisis_estado" = \$\d/);
    expect(q.params).toEqual(expect.arrayContaining([A, 'en_curso']));
  });

  it('registra el acceso a datos personales con los campos y SIN valores', async () => {
    conFactura();
    updates();
    await pasoExtraccion({ impuestoId: A, runt: limitadorRunt });
    expect(logPiiAccess).toHaveBeenCalledTimes(1);
    const [req, opts] = logPiiAccess.mock.calls[0];
    expect(req.user).toBeUndefined(); // actor sistema: user_id/user_role NULL, no un usuario inventado
    expect(opts).toMatchObject({ resourceTipo: 'flito_impuesto', accion: 'read', camposAccedidos: ['direccion', 'municipio', 'departamento', 'vin'] });
    expect(JSON.stringify(opts)).not.toMatch(/9ABCD1234EF567890|CL 1 # 2-3|CIUDADX|X-Amz-Signature/);
  });
});

describe('AC2 — fallback OCR', () => {
  it('sin Notas Finales llama al OCR con el PDF y persiste fuente ocr', async () => {
    conFactura();
    const g = updates();
    textoPdf.mockResolvedValue('PDF escaneado sin capa de texto útil');
    extraerVehiculoFacturaVenta.mockResolvedValue({ ...ocrVacio(), vin: { valor: '9ABCD1234EF567890', confianza: 0.95, confiable: true } });
    await pasoExtraccion({ impuestoId: A, runt: limitadorRunt });

    expect(extraerVehiculoFacturaVenta).toHaveBeenCalledTimes(1);
    expect(extraerVehiculoFacturaVenta.mock.calls[0][0]).toMatchObject({ contentType: 'application/pdf', contenido: PDF });
    const e = g[0].set!.extraccionFacturaVenta as Record<string, unknown>;
    expect(e.fuente).toBe('ocr');
    expect(e.vin).toMatchObject({ confiable: true });
  });

  it('una imagen va directo al OCR sin pdftotext', async () => {
    conFactura();
    updates();
    fetchMock.mockResolvedValue(respuesta(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])));
    extraerVehiculoFacturaVenta.mockResolvedValue(ocrVacio());
    await pasoExtraccion({ impuestoId: A, runt: limitadorRunt });
    expect(textoPdf).not.toHaveBeenCalled();
    expect(extraerVehiculoFacturaVenta.mock.calls[0][0]).toMatchObject({ contentType: 'image/jpeg' });
  });

  it('OCR no disponible: el paso lanza y no persiste nada', async () => {
    conFactura();
    const g = updates();
    textoPdf.mockResolvedValue('');
    extraerVehiculoFacturaVenta.mockRejectedValue(new OcrNoDisponibleErrorMock('caído'));
    await expect(pasoExtraccion({ impuestoId: A, runt: limitadorRunt })).rejects.toBeInstanceOf(OcrNoDisponibleErrorMock);
    expect(g).toHaveLength(0);
  });
});

describe('factura no disponible → lanza (error_analisis)', () => {
  it.each([
    ['sin_factura', () => selectMock.mockReturnValue(grabador([{ facturaId: null }]))],
    ['url_nula', () => { conFactura(); obtenerUrlFactura.mockResolvedValue(null); }],
    ['http_404', () => { conFactura(); fetchMock.mockResolvedValue(respuesta(Buffer.from('x'), { status: 404 })); }],
    ['descarga', () => { conFactura(); fetchMock.mockRejectedValue(new Error('timeout')); }],
    ['tope', () => { conFactura(); fetchMock.mockResolvedValue(respuesta(Buffer.alloc(TOPE_FACTURA_BYTES + 1))); }],
  ])('%s', async (motivo, preparar) => {
    preparar();
    const g = updates();
    const err = await pasoExtraccion({ impuestoId: A, runt: limitadorRunt }).catch((e) => e);
    expect(err).toBeInstanceOf(FacturaNoDisponibleError);
    expect(err.motivo).toBe(motivo);
    expect(g).toHaveLength(0);
    expect(logPiiAccess).not.toHaveBeenCalled();
  });

  it('en la cola, un impuesto sin factura queda error_analisis', async () => {
    registrarPasosAnalisisImpuestos();
    selectMock
      .mockReturnValueOnce(grabador([{ analisisEstado: 'en_curso', analisisEncoladoEn: new Date(), analizadoEn: null }]))
      .mockReturnValueOnce(grabador([{ facturaId: null }]));
    const g = updates();
    expect(await ejecutarAnalisis(A)).toBe('error_analisis');
    expect(g).toHaveLength(1);
    expect(g[0].set).toMatchObject({ analisisEstado: 'error_analisis' });
  });
});
