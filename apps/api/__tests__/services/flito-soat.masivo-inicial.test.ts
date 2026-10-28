// HU #14135 (Feature #14014) — carga masiva INICIAL (solo VIN): plantilla, lectura del XLSX, decisión pura y
// orquestación fila a fila con colaboradores inyectados (sin base ni RUNT). La base real: ver el .pg.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ExcelJS from 'exceljs';

const { registro } = vi.hoisted(() => ({ registro: [] as string[] }));
vi.mock('../../src/shared/logger.js', () => {
  const mk = () => {
    const f = (...a: unknown[]) => { registro.push(JSON.stringify(a)); };
    const l: Record<string, unknown> = { info: f, warn: f, error: f, debug: f, trace: f, fatal: f };
    l.child = () => l;
    return l;
  };
  return { loggerFor: () => mk(), logger: mk() };
});
vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), execute: vi.fn(), transaction: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

import { SolicitudSoatError } from '../../src/modules/flito-soat/flito-soat-cliente.service.js';
import { CodigoErrorSolicitudSoat } from '@operaciones/shared-types';
import type { DesenlaceRunt } from '../../src/modules/flito-soat/flito-soat-cliente-runt.js';
import { generarPlantilla, ENCABEZADOS_INICIAL, ENCABEZADOS_RENOVACION } from '../../src/modules/flito-soat/flito-soat-masivo-plantilla.js';
import { parsearXlsxRenovacion } from '../../src/modules/flito-soat/flito-soat-masivo-parse.js';
import { parsearXlsxInicial } from '../../src/modules/flito-soat/flito-soat-masivo-parse-inicial.js';
import { decidirInicial } from '../../src/modules/flito-soat/flito-soat-masivo-inicial.js';
import { textoMotivo } from '../../src/modules/flito-soat/flito-soat-masivo-motivos.js';
import { procesarFila, type DepsFila } from '../../src/modules/flito-soat/flito-soat-masivo-procesar-fila.js';
import type { FilaReclamada } from '../../src/modules/flito-soat/flito-soat-masivo-reclamo.js';

const VIN = '9BWZZZ377VT004251';
const VIN2 = '3N1AB7AP5HY123456';
async function xlsx(encabezados: string[], filas: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Hoja');
  ws.addRow(encabezados);
  for (const f of filas) ws.addRow(f);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('plantilla Inicial', () => {
  it('trae solo el encabezado VIN', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await generarPlantilla('inicial')) as unknown as ExcelJS.Buffer);
    const ws = wb.worksheets[0]!;
    expect(ws.getRow(1).values).toEqual([undefined, 'VIN']);
    expect(ws.rowCount).toBe(1);
    expect([...ENCABEZADOS_INICIAL]).toEqual(['VIN']);
  });
});

describe('AC3/AC4/AC8 — lectura del XLSX Inicial', () => {
  it('acepta VIN en cualquier mayúscula/tilde del encabezado y una «Motivo» final (archivo de rechazadas)', async () => {
    const { filas } = await parsearXlsxInicial(await xlsx(['vin', 'Motivo'], [[VIN.toLowerCase(), 'VIN inválido']]));
    expect(filas).toEqual([{ nFila: 2, vin: VIN, motivoRechazo: null }]);
  });
  it('AC4: el primer VIN pasa y los repetidos nacen rechazados', async () => {
    const { filas } = await parsearXlsxInicial(await xlsx(['VIN'], [[VIN], [VIN2], [` ${VIN} `]]));
    expect(filas.map((f) => f.motivoRechazo)).toEqual([null, null, 'fila_duplicada']);
  });
  it('AC8: VIN inválido y fila vacía intermedia nacen rechazados; las vacías del final se ignoran', async () => {
    const { filas } = await parsearXlsxInicial(await xlsx(['VIN'], [[VIN], ['ABC'], [null], ['9BWZZZ377VT00425O'], [VIN2], [null], [null]]));
    expect(filas.map((f) => [f.nFila, f.motivoRechazo])).toEqual([
      [2, null], [3, 'vin_invalido'], [4, 'vin_invalido'], [5, 'vin_invalido'], [6, null],
    ]);
  });
  it('un archivo sin filas de datos se rechaza completo', async () => {
    await expect(parsearXlsxInicial(await xlsx(['VIN'], [[null]]))).rejects.toMatchObject({ codigo: 'archivo_vacio' });
  });
  it('AC9: plantilla de Renovación al elegir Inicial → rechazo completo que lo explica', async () => {
    const buf = await xlsx([...ENCABEZADOS_RENOVACION], [['ABC123', '123456789', 'Ana Perez', 'a@b.co', '3101234567']]);
    const e = await parsearXlsxInicial(buf).catch((x) => x);
    expect(e).toMatchObject({ status: 400, codigo: 'plantilla_equivocada' });
    expect(e.message).toMatch(/Renovación/);
    expect(e.message).not.toContain('ABC123');
  });
  it('AC9: plantilla Inicial al elegir Renovación → rechazo completo que lo explica', async () => {
    const e = await parsearXlsxRenovacion(await xlsx(['VIN'], [[VIN]])).catch((x) => x);
    expect(e).toMatchObject({ status: 400, codigo: 'plantilla_equivocada' });
    expect(e.message).toMatch(/SOAT inicial/);
  });
  it('encabezados desconocidos en Inicial → encabezados_invalidos (sin devolver lo tecleado)', async () => {
    const e = await parsearXlsxInicial(await xlsx(['VIN', 'Otra'], [[VIN, 'x']])).catch((x) => x);
    expect(e).toMatchObject({ codigo: 'encabezados_invalidos' });
  });
});

const soatActivo = {} as never;
const ok = { clase: 'ok', vinEfectivo: VIN, organismoCodigo: null, datos: { placa: 'ABC123' } } as unknown as DesenlaceRunt;
const anticipada = { clase: 'renovacion_anticipada', venceEl: '2026-11-10', soatActivo, vinEfectivo: VIN, organismoCodigo: null, datos: { placa: 'abc-123' } } as unknown as DesenlaceRunt;

describe('decisión pura de la fila Inicial', () => {
  it('AC1: VIN sin SOAT (ok) → pendiente «Falta factura de venta», tipo inicial', () => {
    expect(decidirInicial(ok)).toMatchObject({ tipo: 'pendiente', motivoPendiente: 'falta_factura_venta', tipoSoat: 'inicial', placa: null });
  });
  it('AC2: vence dentro de la ventana → Renovación pendiente «Faltan datos del propietario» con la placa del RUNT', () => {
    expect(decidirInicial(anticipada)).toMatchObject({ tipo: 'pendiente', motivoPendiente: 'faltan_datos_propietario', tipoSoat: 'renovacion', placa: 'ABC123' });
  });
  it('AC7: vence en más de 30 días → rechazo con la fecha', () => {
    const d = decidirInicial({ clase: 'vigente', fechaVencimiento: '2027-03-05', soatActivo } as unknown as DesenlaceRunt);
    expect(d).toEqual({ tipo: 'rechazar', motivo: 'soat_vigente', vigenteHasta: '2027-03-05' });
    expect(textoMotivo('soat_vigente', '2027-03-05', 'inicial')).toContain('05/03/2027');
  });
  it('AC6: RUNT no reconoce el VIN → rechazo que pide revisar el VIN', () => {
    for (const codigo of ['runt_no_cuadra', 'runt_sin_registro'] as const) {
      const d = decidirInicial({ clase: 'revise', codigo });
      expect(d).toEqual({ tipo: 'rechazar', motivo: codigo });
      expect(textoMotivo(codigo, null, 'inicial')).toMatch(/revíselo/);
    }
  });
  it('RUNT caído por VIN (decisión del humano) → nace «Falta factura de venta»; el 429 sigue siendo límite', () => {
    expect(decidirInicial({ clase: 'caido', causa: 'timeout' })).toMatchObject({ tipo: 'pendiente', motivoPendiente: 'falta_factura_venta' });
    expect(decidirInicial({ clase: 'caido', httpStatus: 429 })).toEqual({ tipo: 'limite' });
  });
  it('textos Inicial: AC4 «VIN repetido en el archivo», AC5 «ya tiene un SOAT en gestión»', () => {
    expect(textoMotivo('fila_duplicada', null, 'inicial')).toBe('VIN repetido en el archivo');
    expect(textoMotivo('fila_duplicada')).toBe('Placa repetida en el archivo');
    expect(textoMotivo('solicitud_existente', null, 'inicial')).toBe('Esta placa ya tiene un SOAT en gestión');
  });
});

const RESERVADO = '33333333-3333-4333-8333-333333333333';
const fila = (o: Partial<FilaReclamada> = {}): FilaReclamada => ({
  id: 'f1', loteId: 'l1', nFila: 2, companiaId: 7, creadoPorId: 9, creadoPorNombre: 'Ana',
  soatIdReservado: RESERVADO, intentos: 0, placa: null, documento: null, nombre: null, correo: null, celular: null,
  tipoSoat: 'inicial', vin: VIN, ...o,
});
function deps(desenlace: DesenlaceRunt, extra: Partial<DepsFila> = {}) {
  const d = {
    yaCreado: vi.fn().mockResolvedValue(null),
    contexto: vi.fn().mockResolvedValue({ ctx: { userId: 9, username: 'Ana' }, canal: { companiaId: 7 } }),
    incompletaAbierta: vi.fn(),
    consultar: vi.fn().mockResolvedValue(desenlace),
    crear: vi.fn(), aparcar: vi.fn(),
    guardaVin: vi.fn().mockResolvedValue(undefined),
    aparcarInicial: vi.fn().mockResolvedValue('aparcada'),
    marcar: vi.fn().mockResolvedValue(true),
    ...extra,
  };
  return d as unknown as DepsFila & typeof d;
}

describe('procesarFila — lote Inicial', () => {
  beforeEach(() => { registro.length = 0; });
  it('AC1/AC2: consulta el RUNT POR VIN y deja la pendiente (no crea SOAT)', async () => {
    const d = deps(ok);
    expect(await procesarFila(fila(), d)).toBe('por_validar');
    expect(d.consultar).toHaveBeenCalledWith({ modalidad: 'vin', vin: VIN });
    expect(d.aparcarInicial).toHaveBeenCalledWith(expect.objectContaining({ vin: VIN, decision: expect.objectContaining({ motivoPendiente: 'falta_factura_venta' }) }));
    expect(d.crear).not.toHaveBeenCalled();
    const d2 = deps(anticipada);
    expect(await procesarFila(fila(), d2)).toBe('por_validar');
    expect(d2.aparcarInicial).toHaveBeenCalledWith(expect.objectContaining({ decision: expect.objectContaining({ motivoPendiente: 'faltan_datos_propietario', placa: 'ABC123' }) }));
  });
  it('RUNT caído: igual nace «Falta factura» y no hay reintento', async () => {
    const d = deps({ clase: 'caido', causa: 'red' });
    expect(await procesarFila(fila(), d)).toBe('por_validar');
    expect(d.marcar).not.toHaveBeenCalled();
  });
  it('AC5: solicitud abierta/pendiente del VIN → rechazo sin consultar el RUNT', async () => {
    const e = new SolicitudSoatError(409, CodigoErrorSolicitudSoat.SOLICITUD_INCOMPLETA_EXISTENTE, 'x');
    const d = deps(ok, { guardaVin: vi.fn().mockRejectedValue(e) });
    expect(await procesarFila(fila(), d)).toBe('rechazada');
    expect(d.consultar).not.toHaveBeenCalled();
    expect(d.marcar).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ estado: 'rechazada', motivoRechazo: 'solicitud_existente' }), true);
  });
  it('carrera: el índice único salta al insertar la pendiente → rechazo solicitud_existente', async () => {
    const d = deps(ok, { aparcarInicial: vi.fn().mockResolvedValue('ocupada') });
    expect(await procesarFila(fila(), d)).toBe('rechazada');
    expect(d.marcar).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ motivoRechazo: 'solicitud_existente' }), true);
  });
  it('AC6/AC7: RUNT no reconoce el VIN / SOAT vigente lejano → rechazo (con fecha)', async () => {
    const d = deps({ clase: 'revise', codigo: 'runt_sin_registro' });
    expect(await procesarFila(fila(), d)).toBe('rechazada');
    expect(d.marcar).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ motivoRechazo: 'runt_sin_registro' }), true);
    const v = deps({ clase: 'vigente', fechaVencimiento: '2027-03-05', soatActivo } as unknown as DesenlaceRunt);
    await procesarFila(fila(), v);
    expect(v.marcar).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ motivoRechazo: 'soat_vigente', vigenteHasta: '2027-03-05' }), true);
  });
  it('AC8: VIN inválido en la fila → rechazo sin consultar el RUNT', async () => {
    const d = deps(ok);
    expect(await procesarFila(fila({ vin: 'ABC' }), d)).toBe('rechazada');
    expect(d.consultar).not.toHaveBeenCalled();
    expect(d.guardaVin).not.toHaveBeenCalled();
  });
  it('429: vuelve a pendiente sin gastar intento', async () => {
    const d = deps({ clase: 'caido', httpStatus: 429 });
    expect(await procesarFila(fila(), d)).toBe('limite');
    expect(d.marcar).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ estado: 'pendiente' }), false);
  });
  it('idempotencia: la pendiente ya existía → solo se marca la fila', async () => {
    const d = deps(ok, { yaCreado: vi.fn().mockResolvedValue({ incompletaId: 'i1' }) });
    expect(await procesarFila(fila(), d)).toBe('por_validar');
    expect(d.consultar).not.toHaveBeenCalled();
  });
  it('ningún log lleva el VIN ni la placa', async () => {
    await procesarFila(fila(), deps(anticipada));
    await procesarFila(fila(), deps({ clase: 'revise', codigo: 'runt_sin_registro' }));
    const todo = registro.join('\n');
    expect(todo).not.toContain(VIN);
    expect(todo).not.toContain('ABC123');
  });
});
