// HU #12619 — viajes adicionales de logística de un trámite: el SERVICIO (listar / registrar / quitar).
//
// El mock `chain` devuelve la fila entera e ignora `where`/`orderBy`/`for` (memorias: mock-chain-
// inventa-columnas, mock-orderby-es-passthrough), así que predicados, orden, bloqueo y lo escrito se
// afirman sobre el SQL RENDERIZADO y sobre lo GRABADO (`values()`), nunca sobre la fila devuelta.
// `db.transaction` ejecuta el callback con un `tx` cuyos `select/insert/delete` son mocks DISTINTOS
// de los de `db`: así se ve que las guardas, el MAX y la escritura van dentro de la transacción.
// `tarifaDe` va mockeado: lo que se afirma es CON QUÉ se llama (AC9) y qué se hace con lo que devuelve.
//
// Mutantes nombrados: AC7 leer la liquidación con `db` en vez de `tx` → «selectMock global no llamado»
// cae; quitar `.for('update')` → cae el aserto del bloqueo. AC8 quitar la excepción del predicado
// (`gestionaLogistica = !auto`) → «autogestionable CON excepción viva → registra» cae. AC9 devolver
// valor 0 en `inicial` sin tarifa → «no inserta y lanza 422» cae. AC4 renumerar al quitar → «cero
// update» cae; traducir el 23505 a 409 → «se relanza tal cual» cae.
process.env.TZ = 'UTC';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { chain, chainReject } from '../helpers/db.js';
import { renderizar } from '../helpers/sql-ligado.js';
import { ordenarComoPostgres, terminosDeOrden } from '../helpers/orden-sql.js';

const selectMock = vi.fn();
const insertMock = vi.fn();
const deleteMock = vi.fn();
const updateMock = vi.fn();
const transactionMock = vi.fn();
const txSelect = vi.fn();
const txInsert = vi.fn();
const txDelete = vi.fn();
const tx = { select: txSelect, insert: txInsert, delete: txDelete };

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: insertMock, update: updateMock, delete: deleteMock, transaction: transactionMock, execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const tarifaDeMock = vi.fn();
vi.mock('../../src/modules/flito-parametrizacion/flito-tarifas.service.js', () => ({ tarifaDe: tarifaDeMock }));

const {
  listar, registrar, quitar, viajesDe, contextoLogisticaDe, aDto,
  TramiteNoEncontradoError, TramiteLiquidadoViajeError, LogisticaAutogestionadaError,
  TarifaLogisticaNoConfiguradaError, ViajeNoEncontradoError, ViajeLogisticaError,
} = await import('../../src/modules/flito-logistica/flito-logistica-viajes.service.js');

interface Join { tabla: string; condicion: string }
interface Espia { where?: SQL; orderBy?: SQL[]; values?: unknown; for?: string; seleccion?: unknown; joins: Join[] }
const espiaVacio = (): Espia => ({ joins: [] });

/** Un chain que GRABA where/orderBy/values/for y los JOIN (tabla + condición renderizada). */
function espiando(rows: unknown[], sobre: Espia = espiaVacio()) {
  const c = chain(rows) as unknown as Record<string, (...a: unknown[]) => unknown>;
  c.where = (a: unknown) => { sobre.where = a as SQL; return c; };
  c.orderBy = (...a: unknown[]) => { sobre.orderBy = a as SQL[]; return c; };
  c.values = (a: unknown) => { sobre.values = a; return c; };
  c.for = (a: unknown) => { sobre.for = a as string; return c; };
  const join = (t: unknown, cond: unknown) => {
    sobre.joins.push({
      tabla: String((t as { [k: symbol]: unknown })[Symbol.for('drizzle:Name')] ?? '?'),
      condicion: renderizar(cond as SQL).sql,
    });
    return c;
  };
  c.leftJoin = join; c.innerJoin = join;
  return c;
}

const TRAMITE = '7d2f4a10-0b1c-4d2e-9f30-a1b2c3d4e5f6';
const VIAJE = 'c0ffee00-1111-4222-8333-444455556666';
const T0 = new Date('2026-09-16T15:00:00.000Z');
const FILA_TRAMITE = { id: TRAMITE, idFlit: 'FLIT-0001' };
/** Lo que devuelve el SELECT del contexto: compañía que NO autogestiona, sin excepción. */
const CTX_GESTIONA = { id: TRAMITE, idFlit: 'FLIT-0001', companiaId: 12, logisticaAutogestionable: false, excepcionViva: false };
const CTX_AUTOGESTIONA = { ...CTX_GESTIONA, logisticaAutogestionable: true };
const CTX_CON_EXCEPCION = { ...CTX_GESTIONA, logisticaAutogestionable: true, excepcionViva: true };
const TARIFA_45 = { valor: 45000, origen: 'generica' as const };
const SIN_TARIFA = { valor: null, origen: 'no_configurada' as const };
const viaje = (over: Record<string, unknown> = {}) => ({
  id: VIAJE, numero: 2, modo: 'inicial', valor: '45000.00', tarifaVigente: '45000.00', motivo: 'devolucion',
  motivoDetalle: null, registradoPorId: 5, registradoPorNombre: 'Ana Pérez', registradoEn: T0, ...over,
});
const V = '"flito_tramite_viajes_logistica"';
const CLAVES_DTO = ['id', 'modo', 'motivo', 'motivoDetalle', 'numero', 'registradoEn', 'registradoPorId', 'registradoPorNombre', 'tarifaVigente', 'valor'];

beforeEach(() => {
  for (const m of [selectMock, insertMock, deleteMock, updateMock, transactionMock, txSelect, txInsert, txDelete, tarifaDeMock]) m.mockReset();
  transactionMock.mockImplementation(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx));
  tarifaDeMock.mockResolvedValue(TARIFA_45);
});

/** tx.select del registrar: trámite (FOR UPDATE), liquidación, contexto, MAX(numero). */
function armarRegistrar(o: { liquidacion?: unknown[]; ctx?: unknown; max?: number; espias?: { lock?: Espia; liq?: Espia; ctx?: Espia; max?: Espia } } = {}) {
  const e = o.espias ?? {};
  txSelect
    .mockReturnValueOnce(espiando([FILA_TRAMITE], e.lock ?? espiaVacio()))
    .mockReturnValueOnce(espiando(o.liquidacion ?? [], e.liq ?? espiaVacio()))
    .mockReturnValueOnce(espiando([o.ctx ?? CTX_GESTIONA], e.ctx ?? espiaVacio()))
    .mockReturnValueOnce(espiando([{ siguiente: o.max ?? 2 }], e.max ?? espiaVacio()))
    .mockReturnValueOnce(chain([{ name: 'Ana Pérez' }]));
}

describe('aDto — numeric a número, fecha a ISO, nulos explícitos', () => {
  it('convierte la fila del contrato con las 10 claves', () => {
    const dto = aDto(viaje({ modo: 'manual', valor: '62000.00', tarifaVigente: null, motivo: 'otro', motivoDetalle: 'Portería cerrada', registradoPorId: null, registradoPorNombre: null }));
    expect(dto).toEqual({
      id: VIAJE, numero: 2, modo: 'manual', valor: 62000, tarifaVigente: null, motivo: 'otro', motivoDetalle: 'Portería cerrada',
      registradoPorId: null, registradoPorNombre: null, registradoEn: '2026-09-16T15:00:00.000Z',
    });
    expect(Object.keys(dto).sort()).toEqual(CLAVES_DTO);
  });
});

describe('contextoLogisticaDe — el predicado de la liquidación: compañía + excepción viva (AC8)', () => {
  it('lee trámite ⟕ clients ⟕ excepción (concepto logistica, revocado_en IS NULL) por id del trámite', async () => {
    const espia = espiaVacio();
    const ctx = await contextoLogisticaDe({ select: () => espiando([CTX_GESTIONA], espia) } as never, TRAMITE);
    expect(ctx).toEqual({ id: TRAMITE, idFlit: 'FLIT-0001', companiaId: 12, gestiona: true });
    expect(renderizar(espia.where!)).toEqual({ sql: '"flito_tramites"."id" = $1', params: [TRAMITE] });
    expect(espia.joins.map((j) => j.tabla)).toEqual(['clients', 'flito_excepciones_autogestion']);
    const exc = espia.joins[1]!.condicion;
    expect(exc).toContain('"flito_excepciones_autogestion"."tramite_id" = "flito_tramites"."id"');
    expect(exc).toContain('"flito_excepciones_autogestion"."concepto" = $1');
    expect(exc).toContain('"flito_excepciones_autogestion"."revocado_en" is null');
  });

  it.each([
    ['no autogestiona, sin excepción', CTX_GESTIONA, true],
    ['autogestiona, sin excepción', CTX_AUTOGESTIONA, false],
    ['autogestiona, CON excepción viva → la excepción gana', CTX_CON_EXCEPCION, true],
    ['sin compañía (clients NULL) → gestiona', { ...CTX_GESTIONA, companiaId: null, logisticaAutogestionable: null }, true],
  ])('%s', async (_n, fila, esperado) => {
    const ctx = await contextoLogisticaDe({ select: () => chain([fila]) } as never, TRAMITE);
    expect(ctx.gestiona).toBe(esperado);
  });

  it('sin fila → TramiteNoEncontradoError', async () => {
    await expect(contextoLogisticaDe({ select: () => chain([]) } as never, TRAMITE)).rejects.toBeInstanceOf(TramiteNoEncontradoError);
  });
});

describe('listar — el GET: forma exacta, ORDER BY numero, LEFT JOIN users, totales (AC5, AC8)', () => {
  it('404 si el trámite no existe, sin leer nada más', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    await expect(listar(TRAMITE)).rejects.toBeInstanceOf(TramiteNoEncontradoError);
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(tarifaDeMock).not.toHaveBeenCalled();
  });

  it('forma exacta: 8 claves; items con 10; totalViajes = 1 + adicionales; totalAdicionales = Σ valor; tarifaVigente de hoy', async () => {
    const espia = espiaVacio();
    selectMock
      .mockReturnValueOnce(chain([CTX_GESTIONA]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(espiando([viaje(), viaje({ id: 'b', numero: 3, modo: 'manual', valor: '62000.50', motivo: 'otro', motivoDetalle: 'x' })], espia));
    tarifaDeMock.mockResolvedValue({ valor: 50000, origen: 'generica' });
    const r = await listar(TRAMITE);
    expect(Object.keys(r).sort()).toEqual(['gestionaLogistica', 'idFlit', 'items', 'liquidado', 'tarifaVigente', 'totalAdicionales', 'totalViajes', 'tramiteId']);
    expect(r).toMatchObject({ tramiteId: TRAMITE, idFlit: 'FLIT-0001', gestionaLogistica: true, liquidado: false, tarifaVigente: 50000, totalViajes: 3, totalAdicionales: 107000.5 });
    expect(r.items).toHaveLength(2);
    expect(Object.keys(r.items[0]!).sort()).toEqual(CLAVES_DTO);
    // El snapshot manda (AC2): la tarifa de hoy es 50000 pero el viaje conserva 45000.
    expect(r.items[0]).toMatchObject({ numero: 2, valor: 45000, tarifaVigente: 45000, registradoPorNombre: 'Ana Pérez', registradoEn: T0.toISOString() });
    expect(tarifaDeMock).toHaveBeenCalledWith(12, 'logistica', null, null);
    // Predicado por trámite, orden por numero y el LEFT JOIN a users, sobre el SQL renderizado.
    expect(renderizar(espia.where!)).toEqual({ sql: `${V}."tramite_id" = $1`, params: [TRAMITE] });
    expect(espia.orderBy!.map((o) => renderizar(o).sql)).toEqual([`${V}."numero" asc`]);
    expect(espia.joins.map((j) => j.tabla)).toEqual(['users']);
    expect(espia.joins[0]!.condicion).toBe(`"users"."id" = ${V}."registrado_por_id"`);
  });

  it('cero viajes → items [], totalViajes 1, totalAdicionales 0; sin tarifa → tarifaVigente null (nunca 0); liquidado según flito_liquidaciones', async () => {
    const espiaLiq = espiaVacio();
    selectMock
      .mockReturnValueOnce(chain([CTX_GESTIONA]))
      .mockReturnValueOnce(espiando([{ id: 'liq-1' }], espiaLiq))
      .mockReturnValueOnce(chain([]));
    tarifaDeMock.mockResolvedValue(SIN_TARIFA);
    const r = await listar(TRAMITE);
    expect(r).toEqual({ tramiteId: TRAMITE, idFlit: 'FLIT-0001', gestionaLogistica: true, liquidado: true, tarifaVigente: null, items: [], totalViajes: 1, totalAdicionales: 0 });
    expect(renderizar(espiaLiq.where!)).toEqual({ sql: '"flito_liquidaciones"."tramite_id" = $1', params: [TRAMITE] });
  });

  it('compañía que autogestiona sin excepción → gestionaLogistica false, items [], totalViajes 0, y NO lee la tabla de viajes', async () => {
    selectMock.mockReturnValueOnce(chain([CTX_AUTOGESTIONA])).mockReturnValueOnce(chain([]));
    const r = await listar(TRAMITE);
    expect(r).toMatchObject({ gestionaLogistica: false, items: [], totalViajes: 0, totalAdicionales: 0, tarifaVigente: 45000 });
    expect(selectMock).toHaveBeenCalledTimes(2);
  });

  it('autogestiona CON excepción viva → gestionaLogistica true y lee los viajes', async () => {
    selectMock.mockReturnValueOnce(chain([CTX_CON_EXCEPCION])).mockReturnValueOnce(chain([])).mockReturnValueOnce(chain([viaje()]));
    const r = await listar(TRAMITE);
    expect(r).toMatchObject({ gestionaLogistica: true, totalViajes: 2, totalAdicionales: 45000 });
    expect(selectMock).toHaveBeenCalledTimes(3);
  });

  it('el orden es numero ASC: tres filas desordenadas salen como las ordenaría Postgres (huecos incluidos: 2, 4, 7)', async () => {
    const espia = espiaVacio();
    const filas = [viaje({ id: 'c', numero: 7 }), viaje({ id: 'a', numero: 2 }), viaje({ id: 'b', numero: 4 })];
    await viajesDe({ select: () => espiando(filas, espia) } as never, TRAMITE);
    const ordenadas = ordenarComoPostgres(filas, terminosDeOrden(espia.orderBy!), (f, col) => (col === 'numero' ? f.numero : undefined));
    expect(ordenadas.map((f) => f.numero)).toEqual([2, 4, 7]);
  });
});

describe('registrar — todo bajo el FOR UPDATE del trámite (AC2, AC3, AC4, AC7, AC8, AC9)', () => {
  const INICIAL = { modo: 'inicial', motivo: 'devolucion' } as const;

  it('inicial: bloqueo → liquidado → contexto → tarifa → MAX+1 → INSERT con valor = tarifa (snapshot); todo con tx, nada con db', async () => {
    const espias = { lock: espiaVacio(), liq: espiaVacio(), ctx: espiaVacio(), max: espiaVacio() };
    armarRegistrar({ espias });
    const grabado = espiaVacio();
    txInsert.mockReturnValueOnce(espiando([viaje({ registradoPorNombre: undefined })], grabado));

    const r = await registrar(TRAMITE, INICIAL, 5);
    expect(r.idFlit).toBe('FLIT-0001');
    expect(r.viaje).toMatchObject({ numero: 2, modo: 'inicial', valor: 45000, tarifaVigente: 45000, registradoPorNombre: 'Ana Pérez' });
    expect(Object.keys(r.viaje).sort()).toEqual(CLAVES_DTO);
    // El bloqueo: FOR UPDATE sobre flito_tramites por id.
    expect(espias.lock.for).toBe('update');
    expect(renderizar(espias.lock.where!)).toEqual({ sql: '"flito_tramites"."id" = $1', params: [TRAMITE] });
    expect(renderizar(espias.liq.where!).sql).toBe('"flito_liquidaciones"."tramite_id" = $1');
    expect(espias.ctx.joins.map((j) => j.tabla)).toEqual(['clients', 'flito_excepciones_autogestion']);
    // MAX(numero) del trámite, +1, con 1 de piso (el incluido).
    expect(renderizar(espias.max.where!)).toEqual({ sql: `${V}."tramite_id" = $1`, params: [TRAMITE] });
    expect(renderizar((txSelect.mock.calls[3]![0] as { siguiente: SQL }).siguiente).sql).toBe(`COALESCE(MAX(${V}."numero"), 1) + 1`);
    expect(tarifaDeMock).toHaveBeenCalledWith(12, 'logistica', null, null);
    expect(grabado.values).toEqual({
      tramiteId: TRAMITE, numero: 2, modo: 'inicial', valor: '45000.00', tarifaVigente: '45000.00',
      motivo: 'devolucion', motivoDetalle: null, registradoPorId: 5,
    });
    // AC7: ninguna lectura por fuera de la transacción.
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(selectMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
    expect(txSelect).toHaveBeenCalledTimes(5);
  });

  it('la numeración es MAX+1 persistido: con viajes 2 y 3 (MAX 3) el siguiente es 4; con hueco (2 y 4) es 5, nunca rellena', async () => {
    armarRegistrar({ max: 4 });
    const grabado = espiaVacio();
    txInsert.mockReturnValueOnce(espiando([viaje({ numero: 4 })], grabado));
    expect((await registrar(TRAMITE, INICIAL, 5)).viaje.numero).toBe(4);
    expect((grabado.values as { numero: number }).numero).toBe(4);

    // Segunda llamada: MAX es 4 (quedó el hueco del 3) → 5. El servicio no rellena huecos.
    armarRegistrar({ max: 5 });
    const grabado2 = espiaVacio();
    txInsert.mockReturnValueOnce(espiando([viaje({ numero: 5 })], grabado2));
    expect((await registrar(TRAMITE, INICIAL, 5)).viaje.numero).toBe(5);
    expect((grabado2.values as { numero: number }).numero).toBe(5);
  });

  it.each([
    ['62000 con motivo otro + detalle', 62000, '62000.00'],
    ['valor 0', 0, '0.00'],
    ['valor 1e9', 1e9, '1000000000.00'],
  ])('manual %s → INSERT con ese valor y tarifaVigente 45000 como referencia (AC3)', async (_n, valor, numeric) => {
    armarRegistrar();
    const grabado = espiaVacio();
    txInsert.mockReturnValueOnce(espiando([viaje({ modo: 'manual', valor: numeric, motivo: 'otro', motivoDetalle: 'Portería cerrada' })], grabado));
    const r = await registrar(TRAMITE, { modo: 'manual', valor, motivo: 'otro', motivoDetalle: 'Portería cerrada' }, 5);
    expect(grabado.values).toMatchObject({ modo: 'manual', valor: numeric, tarifaVigente: '45000.00', motivo: 'otro', motivoDetalle: 'Portería cerrada' });
    expect(r.viaje).toMatchObject({ modo: 'manual', valor, tarifaVigente: 45000 });
  });

  it('manual SIN tarifa configurada → registra con tarifaVigente null (AC9)', async () => {
    tarifaDeMock.mockResolvedValue(SIN_TARIFA);
    armarRegistrar();
    const grabado = espiaVacio();
    txInsert.mockReturnValueOnce(espiando([viaje({ modo: 'manual', valor: '30000.00', tarifaVigente: null })], grabado));
    const r = await registrar(TRAMITE, { modo: 'manual', valor: 30000, motivo: 'segunda_entrega' }, 5);
    expect(grabado.values).toMatchObject({ modo: 'manual', valor: '30000.00', tarifaVigente: null });
    expect(r.viaje.tarifaVigente).toBeNull();
  });

  it('inicial SIN tarifa → TarifaLogisticaNoConfiguradaError (422) y NO inserta (mutante: devolver valor 0)', async () => {
    tarifaDeMock.mockResolvedValue(SIN_TARIFA);
    armarRegistrar();
    const e = await registrar(TRAMITE, INICIAL, 5).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TarifaLogisticaNoConfiguradaError);
    expect(e).toMatchObject({ status: 422, codigo: 'TARIFA_LOGISTICA_NO_CONFIGURADA' });
    expect(txInsert).not.toHaveBeenCalled();
    expect(tarifaDeMock).toHaveBeenCalledWith(12, 'logistica', null, null);
  });

  it('trámite liquidado → TramiteLiquidadoViajeError (409) leída con tx, sin tarifa ni INSERT (AC7)', async () => {
    armarRegistrar({ liquidacion: [{ id: 'liq-1' }] });
    const e = await registrar(TRAMITE, INICIAL, 5).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TramiteLiquidadoViajeError);
    expect(e).toMatchObject({ status: 409, codigo: 'TRAMITE_LIQUIDADO', message: 'Reversa la liquidación para cambiar los viajes' });
    expect(txSelect).toHaveBeenCalledTimes(2);
    expect(selectMock).not.toHaveBeenCalled();
    expect(tarifaDeMock).not.toHaveBeenCalled();
    expect(txInsert).not.toHaveBeenCalled();
  });

  it('compañía que autogestiona sin excepción → LogisticaAutogestionadaError (409), sin INSERT (AC8)', async () => {
    armarRegistrar({ ctx: CTX_AUTOGESTIONA });
    const e = await registrar(TRAMITE, INICIAL, 5).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(LogisticaAutogestionadaError);
    expect(e).toMatchObject({ status: 409, codigo: 'LOGISTICA_AUTOGESTIONADA' });
    expect(txInsert).not.toHaveBeenCalled();
  });

  it('autogestiona CON excepción viva → registra (mutante: quitar la excepción del predicado)', async () => {
    armarRegistrar({ ctx: CTX_CON_EXCEPCION });
    txInsert.mockReturnValueOnce(chain([viaje()]));
    expect((await registrar(TRAMITE, INICIAL, 5)).viaje.numero).toBe(2);
  });

  it('trámite inexistente → TramiteNoEncontradoError desde el bloqueo, sin más lecturas', async () => {
    txSelect.mockReturnValueOnce(chain([]));
    await expect(registrar(TRAMITE, INICIAL, 5)).rejects.toBeInstanceOf(TramiteNoEncontradoError);
    expect(txSelect).toHaveBeenCalledTimes(1);
  });

  it('un 23505 del UNIQUE (tramite_id, numero) se RELANZA tal cual: no es un ViajeLogisticaError (AC4)', async () => {
    armarRegistrar();
    const choque = Object.assign(new Error('duplicate key'), { code: '23505' });
    txInsert.mockReturnValueOnce(chainReject(choque));
    const e = await registrar(TRAMITE, INICIAL, 5).catch((x: unknown) => x);
    expect(e).toBe(choque);
    expect(e).not.toBeInstanceOf(ViajeLogisticaError);
  });

  it('sin actor (usuarioId null) graba registradoPorId null y no busca el nombre', async () => {
    txSelect
      .mockReturnValueOnce(chain([FILA_TRAMITE])).mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([CTX_GESTIONA])).mockReturnValueOnce(chain([{ siguiente: 2 }]));
    const grabado = espiaVacio();
    txInsert.mockReturnValueOnce(espiando([viaje({ registradoPorId: null })], grabado));
    const r = await registrar(TRAMITE, INICIAL, null);
    expect(grabado.values).toMatchObject({ registradoPorId: null });
    expect(r.viaje.registradoPorNombre).toBeNull();
    expect(txSelect).toHaveBeenCalledTimes(4);
  });
});

describe('quitar — DELETE físico por (id, tramite_id) bajo el bloqueo, sin renumerar (AC4, AC6, AC7)', () => {
  it('devuelve numero/modo/valor/idFlit para la auditoría; WHERE lleva id Y tramite_id; cero UPDATE', async () => {
    const lock = espiaVacio();
    txSelect.mockReturnValueOnce(espiando([FILA_TRAMITE], lock)).mockReturnValueOnce(chain([]));
    const espia = espiaVacio();
    txDelete.mockReturnValueOnce(espiando([{ numero: 3, modo: 'manual', valor: '62000.00' }], espia));
    const r = await quitar(TRAMITE, VIAJE);
    expect(r).toEqual({ numero: 3, modo: 'manual', valor: 62000, idFlit: 'FLIT-0001' });
    expect(lock.for).toBe('update');
    expect(renderizar(espia.where!)).toEqual({ sql: `(${V}."id" = $1 and ${V}."tramite_id" = $2)`, params: [VIAJE, TRAMITE] });
    expect(updateMock).not.toHaveBeenCalled();
    expect(txInsert).not.toHaveBeenCalled();
    expect(selectMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('cero filas (inexistente o de otro trámite) → ViajeNoEncontradoError (404 VIAJE_NO_ENCONTRADO)', async () => {
    txSelect.mockReturnValueOnce(chain([FILA_TRAMITE])).mockReturnValueOnce(chain([]));
    txDelete.mockReturnValueOnce(chain([]));
    const e = await quitar(TRAMITE, VIAJE).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ViajeNoEncontradoError);
    expect(e).toMatchObject({ status: 404, codigo: 'VIAJE_NO_ENCONTRADO' });
  });

  it('trámite liquidado → 409 sin DELETE (AC7)', async () => {
    txSelect.mockReturnValueOnce(chain([FILA_TRAMITE])).mockReturnValueOnce(chain([{ id: 'liq-1' }]));
    await expect(quitar(TRAMITE, VIAJE)).rejects.toBeInstanceOf(TramiteLiquidadoViajeError);
    expect(txDelete).not.toHaveBeenCalled();
  });

  it('trámite inexistente → TramiteNoEncontradoError', async () => {
    txSelect.mockReturnValueOnce(chain([]));
    await expect(quitar(TRAMITE, VIAJE)).rejects.toBeInstanceOf(TramiteNoEncontradoError);
  });
});
