// Bug #14414 — Lo que corre en CI (sin Postgres): las condiciones de `arrancarTramiteGuardado` y que
// `crearEmpresaDesdeTramite` arranca dentro de su transacción. El SQL real se ejerce en
// `db/flito-tramites.vincular-empresa-arranque.pg.test.ts`.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { arrancarMock, transactionMock } = vi.hoisted(() => ({ arrancarMock: vi.fn(), transactionMock: vi.fn() }));

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: transactionMock, execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn() }));
vi.mock('../../src/modules/flito-sync/flito-sync.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/modules/flito-sync/flito-sync.service.js')>()),
  arrancarSoatEImpuesto: arrancarMock,
}));

const { arrancarTramiteGuardado } = await import('../../src/modules/flito-sync/arrancar-tramite-guardado.js');
const { crearEmpresaDesdeTramite } = await import('../../src/modules/flito-tramites/flito-tramites.service.js');

/** Cadena de Drizzle que resuelve, consulta a consulta, lo que diga la cola. */
function txCon(resultados: unknown[][]) {
  const cola = [...resultados];
  const cadena = (): unknown => {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'limit', 'orderBy', 'for', 'set', 'values', 'returning']) c[m] = () => c;
    c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(cola.shift() ?? []).then(res, rej);
    return c;
  };
  return { select: vi.fn(cadena), insert: vi.fn(cadena), update: vi.fn(cadena) };
}

const COMPANIA = { id: 7, active: true } as never;
const base = {
  id: 'tramite-1', idFlit: 'RAD-1', flitEstado: 'Asignado', organismoCodigo: '11001', vehiculoId: 3, soatId: null,
  valorImpuestoLiquidado: '150000.00', fuente: 'flit2', flit2PiiEnmascarada: false,
};
const contadores = () => ({ soatCreados: 0, soatBloqueadosPorVin: 0, impuestosCreados: 0, impuestosBloqueadosPorVehiculo: 0 });

beforeEach(() => { arrancarMock.mockReset(); transactionMock.mockReset(); });

describe('Bug #14414 — condiciones de arrancarTramiteGuardado', () => {
  it('FLIT 2 Asignado con comprador principal y VIN → arranca con los datos del trámite', async () => {
    const tx = txCon([[{ id: 'comprador' }], [{ vin: 'VIN1' }]]);
    await arrancarTramiteGuardado(tx as never, base, COMPANIA, contadores());
    expect(arrancarMock).toHaveBeenCalledTimes(1);
    expect(arrancarMock.mock.calls[0]![1]).toEqual({ vin: 'VIN1', idFlit: 'RAD-1', valorImpuestoLiquidado: 150000 });
    expect(arrancarMock.mock.calls[0]![2]).toEqual({ tramiteId: 'tramite-1', soatId: null, vehiculoId: 3, compania: COMPANIA, organismoCodigo: '11001' });
  });

  it('FLIT 1 no exige comprador ni mira el enmascarado', async () => {
    const tx = txCon([[{ vin: 'VIN1' }]]);
    await arrancarTramiteGuardado(tx as never, { ...base, fuente: 'flit', flit2PiiEnmascarada: true }, COMPANIA, contadores());
    expect(arrancarMock).toHaveBeenCalledTimes(1);
  });

  it('el estado FLIT se normaliza (`esAsignado`)', async () => {
    const tx = txCon([[{ id: 'comprador' }], [{ vin: 'VIN1' }]]);
    await arrancarTramiteGuardado(tx as never, { ...base, flitEstado: '  ASIGNADO ' }, COMPANIA, contadores());
    expect(arrancarMock).toHaveBeenCalledTimes(1);
  });

  it.each<[string, Partial<typeof base> | Record<string, unknown>, unknown[][]]>([
    ['no Asignado', { flitEstado: 'Aprobado' }, []],
    ['sin estado FLIT', { flitEstado: null }, []],
    ['sin organismo emparejado', { organismoCodigo: null }, []],
    ['FLIT 2 enmascarado', { flit2PiiEnmascarada: true }, []],
    ['FLIT 2 sin comprador principal', {}, [[]]],
    ['vehículo sin VIN', {}, [[{ id: 'comprador' }], [{ vin: null }]]],
  ])('%s → no arranca', async (_n, cambio, cola) => {
    await arrancarTramiteGuardado(txCon(cola) as never, { ...base, ...cambio } as never, COMPANIA, contadores());
    expect(arrancarMock).not.toHaveBeenCalled();
  });
});

describe('Bug #14414 — crearEmpresaDesdeTramite', () => {
  const COMPANIA_FILA = { id: 7, active: true, soatAutogestionable: false, impuestosAutogestionable: false };
  const ctx = { userId: 1 } as never;
  const AUTO = { soat: false, impuestos: false, logistica: false };
  const conTx = (tx: unknown) => transactionMock.mockImplementation((fn: (t: unknown) => unknown) => fn(tx));
  /** existente, pendientes, update, historial, compañía, comprador principal, vehículo. */
  const cola = (existente: unknown[]) => [existente, [base], [], [], [COMPANIA_FILA], [{ id: 'comprador' }], [{ vin: 'VIN1' }]];

  it('empresa existente: re-vincula y arranca, todo en la transacción', async () => {
    const tx = txCon(cola([{ id: 7 }]));
    conTx(tx);
    const r = await crearEmpresaDesdeTramite('Empresa', '900123', AUTO, ctx);
    expect(r).toEqual({ companiaId: 7, yaExistia: true, revinculados: 1 });
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(tx.update).toHaveBeenCalledTimes(1);
    expect(tx.insert).toHaveBeenCalledTimes(1);
    expect(arrancarMock).toHaveBeenCalledTimes(1);
    expect(arrancarMock.mock.calls[0]![0]).toBe(tx);
  });

  it('empresa nueva: también arranca', async () => {
    const tx = txCon([[], [{ id: 7 }], [base], [], [], [COMPANIA_FILA], [{ id: 'comprador' }], [{ vin: 'VIN1' }]]);
    conTx(tx);
    const r = await crearEmpresaDesdeTramite('Empresa', '900123', AUTO, ctx);
    expect(r).toEqual({ companiaId: 7, yaExistia: false, revinculados: 1 });
    expect(arrancarMock).toHaveBeenCalledTimes(1);
  });

  it('un fallo del arranque se propaga (la transacción se revierte)', async () => {
    conTx(txCon(cola([{ id: 7 }])));
    arrancarMock.mockRejectedValueOnce(new Error('fallo del arranque'));
    await expect(crearEmpresaDesdeTramite('Empresa', '900123', AUTO, ctx)).rejects.toThrow('fallo del arranque');
  });

  it('sin trámites pendientes no arranca nada', async () => {
    conTx(txCon([[{ id: 7 }], []]));
    const r = await crearEmpresaDesdeTramite('Empresa', '900123', AUTO, ctx);
    expect(r).toEqual({ companiaId: 7, yaExistia: true, revinculados: 0 });
    expect(arrancarMock).not.toHaveBeenCalled();
  });
});
