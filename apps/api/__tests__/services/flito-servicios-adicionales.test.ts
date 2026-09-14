// HU #12541 — catálogo de tipos de servicio adicional: el SERVICIO.
//
// El mock `chain` devuelve la fila entera e ignora `where`/`orderBy` (memoria: mock-chain-inventa-
// columnas, mock-orderby-es-passthrough), así que los predicados y el orden se afirman sobre el SQL
// RENDERIZADO de lo que el servicio pasó (`espiando` + `renderizar`), como en flito-tarifas.test.ts.
// TZ=UTC + fake timers para que `actualizadoEn`/`dadoDeBajaEn` sean el instante fijado y no el reloj.
process.env.TZ = 'UTC';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { chain, chainReject } from '../helpers/db.js';
import { renderizar } from '../helpers/sql-ligado.js';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const deleteMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: insertMock, update: updateMock, delete: deleteMock, transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const {
  nombrePlegado, aDto, listarTipos, crearTipo, editarTipo, darDeBajaTipo,
  ServicioAdicionalConflictoError, ServicioAdicionalNoEncontradoError,
} = await import('../../src/modules/flito-parametrizacion/flito-servicios-adicionales.service.js');
const { flitoServiciosAdicionalesTipos } = await import('../../src/db/schema.js');

/** Un chain que además GRABA lo que recibió `values()` / `set()`. */
function grabando(rows: unknown[], sobre: { values?: unknown; set?: unknown; where?: SQL }) {
  const c = chain(rows) as unknown as Record<string, (a: unknown) => unknown>;
  c.values = (a: unknown) => { sobre.values = a; return c; };
  c.set = (a: unknown) => { sobre.set = a; return c; };
  c.where = (a: unknown) => { sobre.where = a as SQL; return c; };
  return c;
}

/** Un chain que GRABA los argumentos de `where()` y `orderBy()`. */
function espiando(rows: unknown[], sobre: { where?: SQL; orderBy?: SQL[] }) {
  const c = chain(rows) as unknown as Record<string, (...a: unknown[]) => unknown>;
  c.where = (a: unknown) => { sobre.where = a as SQL; return c; };
  c.orderBy = (...a: unknown[]) => { sobre.orderBy = a as SQL[]; return c; };
  return c;
}

const AHORA = new Date('2026-09-14T15:00:00.000Z');
const ANTES = new Date('2026-09-01T10:00:00.000Z');
const ID = '3f1c2b7e-9d4a-4c8e-8f0b-1a2b3c4d5e6f';
const FILA = (over: Record<string, unknown> = {}) => ({
  id: ID, nombre: 'Peritaje', descripcion: 'Avalúo técnico', valor: '85000.00', activo: true,
  dadoDeBajaEn: null, dadoDeBajaPorId: null, creadoPorId: 5, creadoEn: ANTES, actualizadoPorId: 5, actualizadoEn: ANTES,
  ...over,
});
const T = '"flito_servicios_adicionales_tipos"';
const PLEGADO_COL = `lower(translate(${T}."nombre", 'áéíóúÁÉÍÓÚñÑüÜ', 'aeiouAEIOUnNuU'))`;

beforeEach(() => {
  selectMock.mockReset(); insertMock.mockReset(); updateMock.mockReset(); deleteMock.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(AHORA);
});
afterEach(() => { vi.useRealTimers(); });

describe('nombrePlegado — UNA expresión, la misma del índice de la 0191', () => {
  it('sobre la columna: lower(translate(col, tildes, sin tildes)) sin parámetros', () => {
    const { sql, params } = renderizar(nombrePlegado(flitoServiciosAdicionalesTipos.nombre));
    expect(sql).toBe(PLEGADO_COL);
    expect(params).toEqual([]);
  });

  it('sobre un texto: el texto viaja como parámetro dentro de la misma expresión', () => {
    const { sql, params } = renderizar(nombrePlegado('Diagnóstico'));
    expect(sql).toBe("lower(translate($1, 'áéíóúÁÉÍÓÚñÑüÜ', 'aeiouAEIOUnNuU'))");
    expect(params).toEqual(['Diagnóstico']);
  });
});

describe('aDto — numeric → Number, fechas → ISO, nulls explícitos', () => {
  it('fila activa', () => {
    expect(aDto(FILA())).toEqual({
      id: ID, nombre: 'Peritaje', descripcion: 'Avalúo técnico', valor: 85000, activo: true,
      dadoDeBajaEn: null, dadoDeBajaPorId: null, creadoEn: ANTES.toISOString(), creadoPorId: 5,
      actualizadoEn: ANTES.toISOString(), actualizadoPorId: 5,
    });
  });

  it('fila de baja y fila sembrada (sin autor, sin descripción)', () => {
    const baja = aDto(FILA({ activo: false, dadoDeBajaEn: AHORA, dadoDeBajaPorId: 9 }));
    expect(baja.activo).toBe(false);
    expect(baja.dadoDeBajaEn).toBe(AHORA.toISOString());
    expect(baja.dadoDeBajaPorId).toBe(9);
    const sembrada = aDto(FILA({ descripcion: null, creadoPorId: null, actualizadoPorId: null, valor: '0.00' }));
    expect(sembrada).toMatchObject({ descripcion: null, creadoPorId: null, actualizadoPorId: null, valor: 0 });
  });
});

describe('listarTipos — activos por defecto, bajas bajo demanda, orden por nombre plegado (AC4)', () => {
  it('sin incluirBajas: WHERE activo = true y ORDER BY plegado ASC, id ASC', async () => {
    const espia: { where?: SQL; orderBy?: SQL[] } = {};
    selectMock.mockReturnValueOnce(espiando([FILA()], espia));
    const r = await listarTipos();
    expect(r).toHaveLength(1);
    expect(r[0]!.valor).toBe(85000);
    const w = renderizar(espia.where!);
    expect(w.sql).toBe(`${T}."activo" = $1`);
    expect(w.params).toEqual([true]);
    expect(espia.orderBy!.map((o) => renderizar(o).sql)).toEqual([`${PLEGADO_COL} asc`, `${T}."id" asc`]);
  });

  it('con incluirBajas: sin WHERE (undefined), mismo orden', async () => {
    const espia: { where?: SQL; orderBy?: SQL[] } = {};
    selectMock.mockReturnValueOnce(espiando([FILA(), FILA({ id: 'b', activo: false, dadoDeBajaEn: AHORA, dadoDeBajaPorId: 1 })], espia));
    const r = await listarTipos(true);
    expect(r.map((x) => x.activo)).toEqual([true, false]);
    expect(r[1]!.dadoDeBajaEn).toBe(AHORA.toISOString());
    expect(espia.where).toBeUndefined();
    expect(espia.orderBy!.map((o) => renderizar(o).sql)).toEqual([`${PLEGADO_COL} asc`, `${T}."id" asc`]);
  });
});

describe('crearTipo — alta con actor; el choque lo dice el índice (AC5, AC6)', () => {
  it('inserta nombre/descripcion/valor como string, creado y actualizado por el usuario en el MISMO instante', async () => {
    const grabado: { values?: unknown } = {};
    insertMock.mockReturnValueOnce(grabando([FILA({ creadoEn: AHORA, actualizadoEn: AHORA })], grabado));
    const r = await crearTipo({ nombre: 'Peritaje', descripcion: 'Avalúo técnico', valor: 85000 }, 5);
    expect(grabado.values).toEqual({
      nombre: 'Peritaje', descripcion: 'Avalúo técnico', valor: '85000',
      creadoPorId: 5, creadoEn: AHORA, actualizadoPorId: 5, actualizadoEn: AHORA,
    });
    expect(r).toMatchObject({ id: ID, activo: true, creadoPorId: 5, valor: 85000 });
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('descripcion ausente → null en la fila', async () => {
    const grabado: { values?: unknown } = {};
    insertMock.mockReturnValueOnce(grabando([FILA({ descripcion: null })], grabado));
    await crearTipo({ nombre: 'X', valor: 0 }, null);
    expect(grabado.values).toMatchObject({ descripcion: null, creadoPorId: null, valor: '0' });
  });

  it('23505 → ConflictoError con el activo que choca, buscado por nombre PLEGADO y activo = true', async () => {
    insertMock.mockReturnValueOnce(chainReject(Object.assign(new Error('dup'), { code: '23505' })));
    const espia: { where?: SQL } = {};
    selectMock.mockReturnValueOnce(espiando([{ id: 'd-1', nombre: 'Diagnóstico' }], espia));
    const p = crearTipo({ nombre: 'DIAGNOSTICO', valor: 1 }, 5);
    await expect(p).rejects.toBeInstanceOf(ServicioAdicionalConflictoError);
    await expect(p).rejects.toMatchObject({ choca: { id: 'd-1', nombre: 'Diagnóstico' } });
    const w = renderizar(espia.where!);
    expect(w.sql).toBe(`(${T}."activo" = $1 and ${PLEGADO_COL} = lower(translate($2, 'áéíóúÁÉÍÓÚñÑüÜ', 'aeiouAEIOUnNuU')))`);
    expect(w.params).toEqual([true, 'DIAGNOSTICO']);
  });

  it('cualquier otro error de la base sube tal cual (no se disfraza de 409)', async () => {
    insertMock.mockReturnValueOnce(chainReject(Object.assign(new Error('caída'), { code: '57P01' })));
    await expect(crearTipo({ nombre: 'X', valor: 1 }, 5)).rejects.toThrow('caída');
    expect(selectMock).not.toHaveBeenCalled();
  });
});

describe('editarTipo — solo sobre un ACTIVO; siempre refresca actualizado_* (AC7)', () => {
  it('subconjunto {valor}: set solo valor + actor + ahora; WHERE id = $ AND activo = true', async () => {
    const grabado: { set?: unknown; where?: SQL } = {};
    updateMock.mockReturnValueOnce(grabando([FILA({ valor: '90000.00', actualizadoPorId: 7, actualizadoEn: AHORA })], grabado));
    const r = await editarTipo(ID, { valor: 90000 }, 7);
    expect(grabado.set).toEqual({ valor: '90000', actualizadoPorId: 7, actualizadoEn: AHORA });
    const w = renderizar(grabado.where!);
    expect(w.sql).toBe(`(${T}."id" = $1 and ${T}."activo" = $2)`);
    expect(w.params).toEqual([ID, true]);
    expect(r).toMatchObject({ valor: 90000, actualizadoPorId: 7, actualizadoEn: AHORA.toISOString() });
  });

  it('subconjunto {nombre, descripcion: null}: se escriben los dos; valor no se toca', async () => {
    const grabado: { set?: unknown } = {};
    updateMock.mockReturnValueOnce(grabando([FILA({ nombre: 'Peritaje técnico', descripcion: null })], grabado));
    await editarTipo(ID, { nombre: 'Peritaje técnico', descripcion: null }, 7);
    expect(grabado.set).toEqual({ nombre: 'Peritaje técnico', descripcion: null, actualizadoPorId: 7, actualizadoEn: AHORA });
  });

  it('cero filas (inexistente o dado de baja) → NoEncontradoError, sin segunda consulta', async () => {
    updateMock.mockReturnValueOnce(chain([]));
    await expect(editarTipo(ID, { valor: 1 }, 7)).rejects.toBeInstanceOf(ServicioAdicionalNoEncontradoError);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('23505 al renombrar → ConflictoError con el activo que ya usa ese nombre', async () => {
    updateMock.mockReturnValueOnce(chainReject(Object.assign(new Error('dup'), { code: '23505' })));
    const espia: { where?: SQL } = {};
    selectMock.mockReturnValueOnce(espiando([{ id: 'd-1', nombre: 'Diagnóstico' }], espia));
    const p = editarTipo(ID, { nombre: 'diagnóstico' }, 7);
    await expect(p).rejects.toBeInstanceOf(ServicioAdicionalConflictoError);
    await expect(p).rejects.toMatchObject({ choca: { id: 'd-1', nombre: 'Diagnóstico' } });
    expect(renderizar(espia.where!).params).toEqual([true, 'diagnóstico']);
  });
});

describe('darDeBajaTipo — baja LÓGICA, nunca delete (AC8)', () => {
  it('set activo=false + dadoDeBajaEn/PorId + actualizado_*; WHERE id AND activo = true; devuelve la fila', async () => {
    const grabado: { set?: unknown; where?: SQL } = {};
    updateMock.mockReturnValueOnce(grabando([FILA({ activo: false, dadoDeBajaEn: AHORA, dadoDeBajaPorId: 7, actualizadoPorId: 7, actualizadoEn: AHORA })], grabado));
    const r = await darDeBajaTipo(ID, 7);
    expect(grabado.set).toEqual({ activo: false, dadoDeBajaEn: AHORA, dadoDeBajaPorId: 7, actualizadoPorId: 7, actualizadoEn: AHORA });
    const w = renderizar(grabado.where!);
    expect(w.sql).toBe(`(${T}."id" = $1 and ${T}."activo" = $2)`);
    expect(w.params).toEqual([ID, true]);
    expect(r).toMatchObject({ activo: false, dadoDeBajaEn: AHORA.toISOString(), dadoDeBajaPorId: 7 });
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('segunda baja o id inexistente: cero filas → NoEncontradoError', async () => {
    updateMock.mockReturnValueOnce(chain([]));
    await expect(darDeBajaTipo(ID, 7)).rejects.toBeInstanceOf(ServicioAdicionalNoEncontradoError);
    expect(deleteMock).not.toHaveBeenCalled();
  });
});
