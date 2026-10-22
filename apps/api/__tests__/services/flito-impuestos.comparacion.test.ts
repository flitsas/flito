// HU #12827 — paso «comparacion» del análisis post-envío: una consulta RUNT por análisis (queda en
// `job.consultaRunt`), rojo `runt_sin_respuesta` (AC2, traspaso incluido), factura ilegible → rojo
// `error_lectura_factura` + `error_analisis` sin consultar el RUNT, UPDATE solo sobre `en_curso`
// (SQL renderizado), logs sin PII y la valla del AC4. El RUNT y los datos del vehículo van mockeados;
// valores INVENTADOS.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const selectMock = vi.fn();
const updateMock = vi.fn();
const consultarVehiculoRunt = vi.fn();
const datosDelVehiculo = vi.fn();
const logPiiAccess = vi.fn();
const logInfo = vi.fn();
const logWarn = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, update: updateMock, insert: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/modules/runt/runt.service.js', () => ({ consultarVehiculoRunt }));
vi.mock('../../src/modules/flito-impuestos/certificacion.service.js', () => ({ datosDelVehiculo }));
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess }));
vi.mock('../../src/shared/logger.js', () => ({
  loggerFor: () => ({ info: logInfo, warn: logWarn, error: vi.fn(), debug: vi.fn() }),
}));

const { pasoComparacion, FacturaIlegibleError } = await import('../../src/modules/flito-impuestos/flito-impuestos.comparacion.js');
const { __resetColaAnalisis, ejecutarAnalisis, registrarPasoAnalisis } =
  await import('../../src/modules/flito-impuestos/flito-impuestos.analisis.service.js');
type Ctx = Parameters<typeof pasoComparacion>[0];

const render = (w: SQL) => new PgDialect().sqlToQuery(w);
interface Grabacion { set?: Record<string, unknown>; where?: SQL }
function grabador(filas: unknown[] = [], g: Grabacion = {}) {
  const c: Record<string, unknown> = {};
  Object.assign(c, {
    from: () => c, limit: () => c,
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

const A = '00000000-0000-0000-0000-00000000000a';
const VIN = '9ZZTEST0000000001';
const PLACA = 'ZZZ999';
const DOC = '9999999999';
const ok = (valor: string | null) => ({ valor, confianza: 0.99, confiable: true });
const dudoso = (valor: string | null) => ({ valor, confianza: 0.2, confiable: false });
const EXTRACCION = {
  vin: ok(VIN), marca: ok('KIA'), linea: ok('K3 CROSS'), anioVehiculo: ok('2026'), color: ok('BLANCO'), cilindrada: ok('1598'),
  clase: ok('AUTOMOVIL'), direccion: ok('CALLE FALSA 1'), municipio: ok('BOGOTA'), departamento: ok('CUNDINAMARCA'),
  fuente: 'notas_finales',
};
const ILEGIBLE = {
  ...EXTRACCION, vin: dudoso(null), marca: dudoso(null), linea: dudoso('X'), anioVehiculo: dudoso(null), color: dudoso(null), cilindrada: dudoso(null),
};
const DATA_RUNT = {
  vehiculo: { placa: PLACA, vin: VIN, marca: 'KIA', linea: 'K3 CROSS', modelo: '2026', color: 'BLANCO', cilindraje: '1600', clase: 'CAMIONETA' },
};

const conExtraccion = (e: unknown = EXTRACCION) => selectMock.mockReturnValue(grabador([{ extraccion: e }]));
const vehiculo = (over: Record<string, unknown> = {}) =>
  datosDelVehiculo.mockResolvedValue({ vehiculoId: 1, placa: PLACA, vin: VIN, ownerDocument: DOC, ownerName: 'X', ...over });
const runtFake = () => ({ ejecutar: vi.fn(async <T>(f: () => Promise<T>) => f()) });
const ctx = (job: Ctx['job'] = {}) => ({ impuestoId: A, runt: runtFake() as unknown as Ctx['runt'], job });

beforeEach(() => {
  __resetColaAnalisis();
  for (const m of [selectMock, updateMock, consultarVehiculoRunt, datosDelVehiculo, logPiiAccess, logInfo, logWarn]) m.mockReset();
});

describe('AC1 — con extracción y RUNT válido', () => {
  it('UNA consulta RUNT (por documento), queda en job.consultaRunt y persiste verde campo a campo', async () => {
    conExtraccion(); vehiculo();
    consultarVehiculoRunt.mockResolvedValue({ ok: true, data: DATA_RUNT });
    const g = updates();
    const c = ctx();

    await pasoComparacion(c);

    expect(c.runt.ejecutar).toHaveBeenCalledTimes(1);
    expect(consultarVehiculoRunt).toHaveBeenCalledTimes(1);
    expect(consultarVehiculoRunt).toHaveBeenCalledWith(PLACA, undefined, DOC);
    expect(c.job.consultaRunt).toMatchObject({ estado: 'ok', via: 'documento', data: DATA_RUNT });
    expect(g).toHaveLength(1);
    expect(g[0].set!.semaforo).toBe('verde');
    const comp = g[0].set!.comparacionFacturaRunt as { motivo: unknown; campos: Array<{ campo: string; resultado: string }> };
    expect(comp.motivo).toBeNull();
    expect(comp.campos.map((x) => [x.campo, x.resultado])).toEqual([
      ['vin', 'coincide'], ['marca', 'coincide'], ['linea', 'coincide'], ['anio', 'coincide'], ['color', 'coincide'], ['cilindrada', 'coincide'],
    ]);
  });

  it('sin documento consulta por VIN', async () => {
    conExtraccion(); vehiculo({ ownerDocument: null });
    consultarVehiculoRunt.mockResolvedValue({ ok: true, data: DATA_RUNT });
    updates();
    const c = ctx();
    await pasoComparacion(c);
    expect(consultarVehiculoRunt).toHaveBeenCalledWith(PLACA, VIN, undefined);
    expect(c.job.consultaRunt).toMatchObject({ estado: 'ok', via: 'vin' });
  });

  it('el UPDATE solo aplica si el análisis sigue en_curso (condición renderizada)', async () => {
    conExtraccion(); vehiculo();
    consultarVehiculoRunt.mockResolvedValue({ ok: true, data: DATA_RUNT });
    const g = updates();
    await pasoComparacion(ctx());
    const w = render(g[0].where!);
    expect(w.sql).toMatch(/"id" = \$1 and "flito_impuestos"\."analisis_estado" = \$2/);
    expect(w.params).toEqual([A, 'en_curso']);
  });

  it('una diferencia en el RUNT → naranja', async () => {
    conExtraccion(); vehiculo();
    consultarVehiculoRunt.mockResolvedValue({ ok: true, data: { vehiculo: { ...DATA_RUNT.vehiculo, color: 'NEGRO' } } });
    const g = updates();
    await pasoComparacion(ctx());
    expect(g[0].set!.semaforo).toBe('naranja');
  });

  it('deja constancia de acceso a PII de sistema y el log no lleva placa, documento ni VIN', async () => {
    conExtraccion(); vehiculo();
    consultarVehiculoRunt.mockResolvedValue({ ok: true, data: DATA_RUNT });
    updates();
    await pasoComparacion(ctx());
    expect(logPiiAccess).toHaveBeenCalledTimes(1);
    const [, entrada] = logPiiAccess.mock.calls[0];
    expect(entrada).toMatchObject({ camposAccedidos: ['placa', 'documento_propietario', 'vin'], resourceId: null });
    expect(entrada.motivo).toContain('comparación factura vs RUNT');
    const logs = JSON.stringify([...logInfo.mock.calls, ...logWarn.mock.calls, entrada]);
    for (const pii of [PLACA, DOC, VIN]) expect(logs).not.toContain(pii);
    expect(logInfo).toHaveBeenCalledWith(expect.objectContaining({ impuestoId: A, semaforo: 'verde', motivo: null }), expect.any(String));
  });
});

describe('AC2 — rojo runt_sin_respuesta, análisis completado', () => {
  const casos: Array<[string, () => void, string]> = [
    ['ok:false', () => consultarVehiculoRunt.mockResolvedValue({ ok: false, message: 'Servicio caído' }), 'sin_respuesta'],
    ['lanza', () => consultarVehiculoRunt.mockRejectedValue(new Error('circuit open')), 'sin_respuesta'],
    ['sin registro', () => consultarVehiculoRunt.mockResolvedValue({ ok: true, data: { vehiculo: { placa: PLACA } } }), 'sin_registro'],
    ['traspaso en sincronización', () => consultarVehiculoRunt.mockResolvedValue({
      ok: false, message: 'El propietario no coincide con el registrado en el RUNT',
    }), 'traspaso'],
  ];
  it.each(casos)('%s → rojo runt_sin_respuesta (detalle %s)', async (_n, preparar, detalle) => {
    conExtraccion(); vehiculo(); preparar();
    const g = updates();
    const c = ctx();
    await expect(pasoComparacion(c)).resolves.toBeUndefined();
    expect(g[0].set!.semaforo).toBe('rojo');
    expect(g[0].set!.comparacionFacturaRunt).toMatchObject({ motivo: 'runt_sin_respuesta', detalleRunt: detalle, campos: [] });
    expect(c.job.consultaRunt).toEqual({ estado: detalle });
  });

  it.each([
    ['sin placa', { placa: null }],
    ['sin documento ni VIN', { ownerDocument: null, vin: null }],
  ])('%s → rojo runt_sin_respuesta SIN consultar', async (_n, over) => {
    conExtraccion(); vehiculo(over);
    const g = updates();
    const c = ctx();
    await pasoComparacion(c);
    expect(consultarVehiculoRunt).not.toHaveBeenCalled();
    expect(c.runt.ejecutar).not.toHaveBeenCalled();
    expect(g[0].set).toMatchObject({ semaforo: 'rojo', comparacionFacturaRunt: { motivo: 'runt_sin_respuesta', detalleRunt: 'sin_identificador' } });
  });

  it('en la cola: el rojo por RUNT deja completado + analizado_en', async () => {
    registrarPasoAnalisis('comparacion', pasoComparacion);
    selectMock
      .mockReturnValueOnce(grabador([{ analisisEstado: 'en_curso', analisisEncoladoEn: new Date(), analizadoEn: null }]))
      .mockReturnValue(grabador([{ extraccion: EXTRACCION }]));
    vehiculo();
    consultarVehiculoRunt.mockResolvedValue({ ok: false, message: 'caído' });
    const g = updates();
    expect(await ejecutarAnalisis(A)).toBe('completado');
    expect(g[0].set!.semaforo).toBe('rojo');
    expect(g[1].set).toMatchObject({ analisisEstado: 'completado', analizadoEn: expect.any(Date) });
  });
});

describe('AC2 — factura ilegible', () => {
  it('rojo error_lectura_factura, sin consultar el RUNT, y el paso lanza', async () => {
    conExtraccion(ILEGIBLE);
    const g = updates();
    const c = ctx();
    await expect(pasoComparacion(c)).rejects.toBeInstanceOf(FacturaIlegibleError);
    expect(datosDelVehiculo).not.toHaveBeenCalled();
    expect(c.runt.ejecutar).not.toHaveBeenCalled();
    expect(c.job.consultaRunt).toBeUndefined();
    expect(g[0].set).toMatchObject({ semaforo: 'rojo', comparacionFacturaRunt: { motivo: 'error_lectura_factura', campos: [] } });
    expect(render(g[0].where!).params).toEqual([A, 'en_curso']);
  });

  it('en la cola: rojo persistido y análisis error_analisis', async () => {
    registrarPasoAnalisis('comparacion', pasoComparacion);
    selectMock
      .mockReturnValueOnce(grabador([{ analisisEstado: 'en_curso', analisisEncoladoEn: new Date(), analizadoEn: null }]))
      .mockReturnValue(grabador([{ extraccion: ILEGIBLE }]));
    const g = updates();
    expect(await ejecutarAnalisis(A)).toBe('error_analisis');
    expect(g[0].set!.semaforo).toBe('rojo');
    expect(g[1].set).toMatchObject({ analisisEstado: 'error_analisis' });
  });

  it('sin extracción persistida → lanza sin escribir', async () => {
    conExtraccion(null);
    const g = updates();
    await expect(pasoComparacion(ctx())).rejects.toThrow(/extracción/);
    expect(g).toHaveLength(0);
  });
});

describe('AC4 — el semáforo no bloquea el pago', () => {
  it('ni la conciliación de recibos ni el recibo de caja leen el semáforo', () => {
    for (const f of ['flito-recibos.service.ts', 'flito-recibos.fase.ts']) {
      const fuente = readFileSync(fileURLToPath(new URL(`../../src/modules/flito-impuestos/${f}`, import.meta.url)), 'utf8');
      expect(fuente).not.toMatch(/semaforo|comparacionFacturaRunt|comparacion_factura_runt/i);
    }
  });
});
