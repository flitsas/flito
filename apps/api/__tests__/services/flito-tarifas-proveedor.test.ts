// Épica #13763 (ADR-0041) — servicio de tarifas de proveedor con la BD doble (patrón de `flito-tarifas.test.ts`): el doble de
// `transaction` ejecuta el callback contra un `txMock` DISTINTO de `dbMock`, así que una escritura fuera de la transacción
// cae en `dbMock` y el test la ve. Cada caso nombra la regla del ADR/HU que cubre (R1..R7). Las restricciones y la
// concurrencia real se miden contra PostgreSQL en `db/flito-tarifas-proveedor.pg.test.ts`.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chain, chainReject } from '../helpers/db.js';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const transactionMock = vi.fn();
const txSelect = vi.fn();
const txInsert = vi.fn();
const txUpdate = vi.fn();
const txMock = { select: txSelect, insert: txInsert, update: txUpdate };

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: insertMock, update: updateMock, delete: vi.fn(), transaction: transactionMock, execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const svc = await import('../../src/modules/flito-parametrizacion/flito-tarifas-proveedor.service.js');

/** Orden de bloqueos y escrituras, en el orden en que el servicio los pidió. */
let bitacora: string[] = [];
function grabando(rows: unknown[], nombre: string, sobre: { values?: unknown; set?: unknown } = {}) {
  const c = chain(rows) as unknown as Record<string, (a?: unknown) => unknown>;
  c.for = (modo?: unknown) => { bitacora.push(`${nombre}:${String(modo)}`); return c; };
  c.values = (a?: unknown) => { sobre.values = a; bitacora.push(`${nombre}:insert`); return c; };
  c.set = (a?: unknown) => { sobre.set = a; bitacora.push(`${nombre}:update`); return c; };
  return c;
}

const P = '11111111-1111-4111-8111-111111111111';
const AHORA = new Date('2026-11-11T15:00:00.000Z');
const FILA = (over: Record<string, unknown> = {}) => ({
  id: 'v-1', proveedorId: P, servicio: 'logistica', concepto: 'logistica', valor: '120000.00', vigenteDesde: AHORA,
  vigenteHasta: null, fijadoPorId: 7, fijadoPorNombre: 'Ana', fijadoEn: AHORA, cerradoPorId: null, cerradoPorNombre: null,
  cerradoEn: null, ...over,
});
const PADRE = (over: Record<string, unknown> = {}) => ({ id: P, nombre: 'Mensajería Sur', activo: true, deletedAt: null, ...over });

beforeEach(() => {
  bitacora = [];
  for (const m of [selectMock, insertMock, updateMock, transactionMock, txSelect, txInsert, txUpdate]) m.mockReset();
  transactionMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(txMock));
});

describe('R5 — lista: solo proveedores activos y vivos, con «Faltan n»', () => {
  it('cuenta los conceptos de sus servicios vigentes y los que no tienen abierta (el $0 cuenta como configurado, R4)', async () => {
    const Q = '22222222-2222-4222-8222-222222222222';
    selectMock
      .mockReturnValueOnce(chain([{ id: P, nombre: 'A' }, { id: Q, nombre: 'B' }]))
      .mockReturnValueOnce(chain([{ id: P }]))          // perfiles SOAT vivos
      .mockReturnValueOnce(chain([{ id: P }, { id: Q }])) // perfiles Logística vivos
      .mockReturnValueOnce(chain([{ proveedorId: P, concepto: 'soat_con_tramite' }, { proveedorId: Q, concepto: 'logistica' }]));
    const r = await svc.listarProveedoresConCostos();
    expect(r).toEqual([
      { id: P, nombre: 'A', servicios: ['soat', 'logistica'], conceptos: 3, faltan: 2 },
      { id: Q, nombre: 'B', servicios: ['logistica'], conceptos: 1, faltan: 0 },
    ]);
  });

  it('sin proveedores activos no consulta perfiles ni vigencias', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    expect(await svc.listarProveedoresConCostos()).toEqual([]);
    expect(selectMock).toHaveBeenCalledTimes(1);
  });
});

describe('R2 — vista: filas por concepto de los servicios vigentes', () => {
  const vista = (soat: boolean, logistica: boolean, abiertas: unknown[] = [], padre = PADRE()) => {
    selectMock
      .mockReturnValueOnce(chain([padre]))
      .mockReturnValueOnce(chain(soat ? [{ id: P }] : []))
      .mockReturnValueOnce(chain(logistica ? [{ id: P }] : []))
      .mockReturnValueOnce(chain(abiertas));
    return svc.vistaCostosProveedor(P);
  };

  it('solo Logística → 1 fila; solo SOAT → 2; los dos → 3, sin vigencia = «Sin configurar»', async () => {
    expect((await vista(false, true)).filas.map((f) => f.concepto)).toEqual(['logistica']);
    expect((await vista(true, false)).filas.map((f) => f.concepto)).toEqual(['soat_con_tramite', 'soat_sin_tramite']);
    const tres = await vista(true, true);
    expect(tres.filas).toHaveLength(3);
    expect(tres.filas.every((f) => f.vigencia === null)).toBe(true);
  });

  it('R4 — $0 se muestra como vigencia con valor 0, distinto de «Sin configurar»; numeric → number', async () => {
    const r = await vista(true, true, [FILA({ valor: '0.00' }), FILA({ id: 'v-2', servicio: 'soat', concepto: 'soat_sin_tramite', valor: '45000.50' })]);
    const por = Object.fromEntries(r.filas.map((f) => [f.concepto, f.vigencia]));
    expect(por.logistica).toMatchObject({ valor: 0, vigenteHasta: null, fijadoPor: { id: 7, nombre: 'Ana' }, servicioAsignado: true });
    expect(por.soat_sin_tramite?.valor).toBe(45000.5);
    expect(por.soat_con_tramite).toBeNull();
  });

  it('R5 — servicio retirado: su vigencia abierta queda latente y NO sale como fila', async () => {
    const r = await vista(false, true, [FILA(), FILA({ id: 'v-3', servicio: 'soat', concepto: 'soat_con_tramite' })]);
    expect(r.filas.map((f) => f.concepto)).toEqual(['logistica']);
  });

  it('R5 — inactivo: se consulta con activo=false; eliminado: activo=false y eliminado=true', async () => {
    expect((await vista(false, true, [], PADRE({ activo: false }))).proveedor).toEqual({ id: P, nombre: 'Mensajería Sur', activo: false, eliminado: false });
    expect((await vista(false, false, [], PADRE({ deletedAt: AHORA }))).proveedor).toMatchObject({ activo: false, eliminado: true });
  });

  it('proveedor inexistente → TarifaProveedorProveedorNoEncontradoError', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    await expect(svc.vistaCostosProveedor(P)).rejects.toBeInstanceOf(svc.TarifaProveedorProveedorNoEncontradoError);
  });
});

describe('R5 — historial: conserva todo y marca la vigencia de un servicio ya no asignado', () => {
  it('servicioAsignado=false en las vigencias del servicio retirado; true en las del vigente', async () => {
    selectMock
      .mockReturnValueOnce(chain([PADRE({ activo: false })]))
      .mockReturnValueOnce(chain([]))           // SOAT retirado
      .mockReturnValueOnce(chain([{ id: P }]))   // Logística vigente
      .mockReturnValueOnce(chain([
        FILA(), FILA({ id: 'v-0', vigenteHasta: AHORA, cerradoPorId: 8, cerradoPorNombre: 'Luis', cerradoEn: AHORA }),
        FILA({ id: 'v-s', servicio: 'soat', concepto: 'soat_con_tramite' }),
      ]));
    const h = await svc.historialCostosProveedor(P);
    expect(h.map((v) => [v.id, v.servicioAsignado])).toEqual([['v-1', true], ['v-0', true], ['v-s', false]]);
    expect(h[1]).toMatchObject({ cerradoPor: { id: 8, nombre: 'Luis' }, vigenteHasta: AHORA.toISOString(), cerradoEn: AHORA.toISOString() });
  });
});

describe('fijarCosto — primera fijación o volver a cobrar (R4, R6, R2, R5)', () => {
  const preparar = (o: { padre?: unknown[]; perfil?: unknown[]; abierta?: unknown[]; insert?: ReturnType<typeof chain> } = {}) => {
    const sobre: { values?: Record<string, unknown> } = {};
    txSelect
      .mockReturnValueOnce(grabando(o.padre ?? [PADRE()], 'padre'))
      .mockReturnValueOnce(grabando(o.perfil ?? [{ id: P }], 'perfil'))
      .mockReturnValueOnce(grabando(o.abierta ?? [], 'vigencia'))
      .mockReturnValueOnce(chain([FILA({ id: 'v-n', valor: '0.00' })]));
    txInsert.mockReturnValueOnce(o.insert ?? grabando([{ id: 'v-n' }], 'vigencia', sobre));
    return sobre;
  };

  it('R4 — $0 se guarda sin confirmación, en la transacción, con now() de la tx; bloquea padre → perfil → vigencia', async () => {
    const sobre = preparar();
    const r = await svc.fijarCosto({ proveedorId: P, concepto: 'logistica', valor: 0 }, 7);
    expect(r.resultado).toMatchObject({ id: 'v-n', valor: 0, vigenteHasta: null });
    expect(r.proveedorNombre).toBe('Mensajería Sur');
    expect(bitacora).toEqual(['padre:share', 'perfil:share', 'vigencia:update', 'vigencia:insert']);
    expect(sobre.values).toMatchObject({ proveedorId: P, servicio: 'logistica', concepto: 'logistica', valor: '0', fijadoPorId: 7 });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('R2 — el servicio se deriva del concepto: soat_con_tramite → soat', async () => {
    const sobre = preparar();
    await svc.fijarCosto({ proveedorId: P, concepto: 'soat_con_tramite', valor: 10 }, 7);
    expect(sobre.values).toMatchObject({ servicio: 'soat', concepto: 'soat_con_tramite', valor: '10' });
  });

  it('R6 — ya hay una abierta para ese concepto → TarifaProveedorCambiadaError, sin insertar', async () => {
    preparar({ abierta: [{ id: 'v-1' }] });
    await expect(svc.fijarCosto({ proveedorId: P, concepto: 'logistica', valor: 5 }, 7)).rejects.toBeInstanceOf(svc.TarifaProveedorCambiadaError);
    expect(txInsert).not.toHaveBeenCalled();
  });

  it.each([['23505', 'uq_flito_tarifas_prov_abierta'], ['23P01', 'flito_tarifas_prov_sin_solape']])(
    'R6 — dos primeras fijaciones simultáneas: %s (%s) envuelto por Drizzle → TarifaProveedorCambiadaError', async (code, constraint_name) => {
      preparar({ insert: chainReject({ message: 'Failed query', cause: { code, constraint_name } }) });
      await expect(svc.fijarCosto({ proveedorId: P, concepto: 'logistica', valor: 5 }, 7)).rejects.toBeInstanceOf(svc.TarifaProveedorCambiadaError);
    },
  );

  it('R6 — un 23505 de OTRA restricción no se disfraza de conflicto', () => {
    expect(svc.esChoqueDeLlaveCosto({ cause: { code: '23505', constraint_name: 'otra_uq' } })).toBe(false);
    expect(svc.esChoqueDeLlaveCosto({ code: '23514' })).toBe(false);
  });

  it('R5 — proveedor inactivo → ProveedorNoActivoError; eliminado o inexistente → 404; sin perfil vivo → 422 (R2)', async () => {
    preparar({ padre: [PADRE({ activo: false })] });
    await expect(svc.fijarCosto({ proveedorId: P, concepto: 'logistica', valor: 5 }, 7)).rejects.toBeInstanceOf(svc.ProveedorNoActivoError);
    txSelect.mockReset();
    preparar({ padre: [PADRE({ deletedAt: AHORA, activo: false })] });
    await expect(svc.fijarCosto({ proveedorId: P, concepto: 'logistica', valor: 5 }, 7))
      .rejects.toBeInstanceOf(svc.TarifaProveedorProveedorNoEncontradoError);
    txSelect.mockReset();
    preparar({ padre: [] });
    await expect(svc.fijarCosto({ proveedorId: P, concepto: 'logistica', valor: 5 }, 7))
      .rejects.toBeInstanceOf(svc.TarifaProveedorProveedorNoEncontradoError);
    txSelect.mockReset();
    preparar({ perfil: [] });
    await expect(svc.fijarCosto({ proveedorId: P, concepto: 'soat_sin_tramite', valor: 5 }, 7)).rejects.toBeInstanceOf(svc.ServicioCostoNoPrestadoError);
    expect(txInsert).not.toHaveBeenCalled();
  });
});

describe('cambiarOCerrarCosto — R4 (nunca se pisa), R6 (concurrencia), R5', () => {
  const ABIERTA = { id: 'v-1', proveedorId: P, servicio: 'logistica', concepto: 'logistica', valor: '120000.00', vigenteHasta: null };
  const preparar = (o: { padre?: unknown[]; perfil?: unknown[]; vigencia?: unknown[]; ref?: unknown[] } = {}) => {
    const cierre: { set?: Record<string, unknown> } = {};
    const apertura: { values?: Record<string, unknown> } = {};
    selectMock.mockReturnValueOnce(chain(o.ref ?? [{ proveedorId: P, servicio: 'logistica' }]));
    txSelect
      .mockReturnValueOnce(grabando(o.padre ?? [PADRE()], 'padre'))
      .mockReturnValueOnce(grabando(o.perfil ?? [{ id: P }], 'perfil'))
      .mockReturnValueOnce(grabando(o.vigencia ?? [ABIERTA], 'vigencia'))
      .mockReturnValueOnce(chain([FILA({ id: 'v-2', valor: '130000.00' })]));
    txUpdate.mockReturnValueOnce(grabando([], 'vigencia', cierre));
    txInsert.mockReturnValueOnce(grabando([{ id: 'v-2' }], 'vigencia', apertura));
    return { cierre, apertura };
  };

  it('cambiar: cierra la abierta y abre otra en la MISMA transacción; valor anterior leído en la tx, no del body', async () => {
    const { cierre, apertura } = preparar();
    const r = await svc.cambiarOCerrarCosto('v-1', { valor: 130000 }, 9);
    expect(r.resultado).toMatchObject({ accion: 'cambiada', valorAnterior: 120000, valorNuevo: 130000, vigencia: { id: 'v-2' } });
    expect(bitacora).toEqual(['padre:share', 'perfil:share', 'vigencia:update', 'vigencia:update', 'vigencia:insert']);
    expect(cierre.set).toMatchObject({ cerradoPorId: 9 });
    expect(apertura.values).toMatchObject({ proveedorId: P, servicio: 'logistica', concepto: 'logistica', valor: '130000', fijadoPorId: 9 });
    // Mismo instante: los dos lados son el `now()` de la transacción, no un reloj del proceso.
    const ahoraSql = (x: unknown) => JSON.stringify((x as { queryChunks?: unknown }).queryChunks);
    expect(ahoraSql(cierre.set!.vigenteHasta)).toBe(ahoraSql(apertura.values!.vigenteDesde));
    expect(ahoraSql(apertura.values!.vigenteDesde)).toContain('now()');
    expect(updateMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('cerrar (dejar de cobrar): cierra sin abrir; valorNuevo null', async () => {
    preparar();
    const r = await svc.cambiarOCerrarCosto('v-1', { cerrar: true }, 9);
    expect(r.resultado).toMatchObject({ accion: 'cerrada', valorAnterior: 120000, valorNuevo: null });
    expect(txUpdate).toHaveBeenCalledTimes(1);
    expect(txInsert).not.toHaveBeenCalled();
  });

  it('mismo valor → sin_cambio, sin escrituras', async () => {
    preparar();
    const r = await svc.cambiarOCerrarCosto('v-1', { valor: 120000 }, 9);
    expect(r.resultado.accion).toBe('sin_cambio');
    expect(txUpdate).not.toHaveBeenCalled();
    expect(txInsert).not.toHaveBeenCalled();
  });

  it('R6 — la vigencia del path ya está cerrada (otro se adelantó) → TarifaProveedorCambiadaError', async () => {
    preparar({ vigencia: [{ ...ABIERTA, vigenteHasta: AHORA }] });
    await expect(svc.cambiarOCerrarCosto('v-1', { valor: 1 }, 9)).rejects.toBeInstanceOf(svc.TarifaProveedorCambiadaError);
    expect(txUpdate).not.toHaveBeenCalled();
  });

  it('R6 — 23P01 al abrir la nueva → TarifaProveedorCambiadaError', async () => {
    preparar();
    txInsert.mockReset().mockReturnValueOnce(chainReject({ cause: { code: '23P01', constraint_name: 'flito_tarifas_prov_sin_solape' } }));
    await expect(svc.cambiarOCerrarCosto('v-1', { valor: 1 }, 9)).rejects.toBeInstanceOf(svc.TarifaProveedorCambiadaError);
  });

  it('vigencia inexistente → VigenciaCostoNoEncontradaError, sin abrir transacción', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    await expect(svc.cambiarOCerrarCosto('v-x', { valor: 1 }, 9)).rejects.toBeInstanceOf(svc.VigenciaCostoNoEncontradaError);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('R5 — inactivo: no se cambia ni se cierra (ProveedorNoActivoError); servicio retirado: 422 sobre la latente', async () => {
    preparar({ padre: [PADRE({ activo: false })] });
    await expect(svc.cambiarOCerrarCosto('v-1', { cerrar: true }, 9)).rejects.toBeInstanceOf(svc.ProveedorNoActivoError);
    txSelect.mockReset(); selectMock.mockReset();
    preparar({ perfil: [] });
    await expect(svc.cambiarOCerrarCosto('v-1', { valor: 1 }, 9)).rejects.toBeInstanceOf(svc.ServicioCostoNoPrestadoError);
    expect(txUpdate).not.toHaveBeenCalled();
  });
});

describe('R1 — no se mezcla con la tarifa al cliente', () => {
  it('el servicio no importa la tabla de la tarifa al cliente (`flitoTarifasVigencias`)', async () => {
    const { readFileSync } = await import('node:fs');
    const fuente = readFileSync(new URL('../../src/modules/flito-parametrizacion/flito-tarifas-proveedor.service.ts', import.meta.url), 'utf8');
    expect(fuente).not.toMatch(/flitoTarifasVigencias\b/);
    expect(fuente).toMatch(/flitoTarifasProveedorVigencias/);
  });
});
