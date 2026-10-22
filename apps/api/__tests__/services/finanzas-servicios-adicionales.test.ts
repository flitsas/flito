// HU #12545 — servicios adicionales de un trámite: el SERVICIO (listar / asignar / quitar).
//
// El mock `chain` devuelve la fila entera e ignora `where`/`orderBy`/`for` (memorias: mock-chain-
// inventa-columnas, mock-orderby-es-passthrough), así que predicados, orden, bloqueo y lo escrito se
// afirman sobre el SQL RENDERIZADO y sobre lo GRABADO (`values()`), nunca sobre la fila devuelta.
// `db.transaction` ejecuta el callback con un `tx` cuyos `select/insert/delete` son mocks DISTINTOS
// de los de `db`: así se ve que la guarda de liquidado y la escritura van dentro de la transacción.
//
// Mutantes nombrados (AC8): M1 quitar `if (await tramiteLiquidado(tx, …))` → rojo en AC5/AC6;
// M2 leer el valor por JOIN al catálogo en vez de copiarlo → rojo en AC4 (values grabado sin valor
// del tipo; el GET con un JOIN a `flito_servicios_adicionales_tipos`); M-06a quitar `tramite_id`
// del WHERE del DELETE → rojo en AC6; «leer la puente/liquidación con db en vez de tx» → rojo en
// «selectMock global no llamado»; quitar `.for('update')` → rojo en el aserto del bloqueo.
process.env.TZ = 'UTC';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { chain, chainReject } from '../helpers/db.js';
import { renderizar } from '../helpers/sql-ligado.js';
import { ordenarComoPostgres, terminosDeOrden } from '../helpers/orden-sql.js';

const selectMock = vi.fn();
const insertMock = vi.fn();
const deleteMock = vi.fn();
const transactionMock = vi.fn();
const txSelect = vi.fn();
const txInsert = vi.fn();
const txDelete = vi.fn();
const tx = { select: txSelect, insert: txInsert, delete: txDelete };

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: insertMock, update: vi.fn(), delete: deleteMock, transaction: transactionMock, execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const {
  listar, asignar, quitar, serviciosAsignadosDe, tramiteLiquidado, aDto,
  TramiteNoEncontradoError, TipoNoDisponibleError, ServicioYaAsignadoError, TramiteLiquidadoError, AsignacionNoEncontradaError,
  AsignacionDeComprobanteError, fijarDesdeComprobante,
} = await import('../../src/modules/finanzas-servicios-adicionales/finanzas-servicios-adicionales.service.js');

interface Espia { where?: SQL; orderBy?: SQL[]; values?: unknown; for?: string; joins: string[] }
const espiaVacio = (): Espia => ({ joins: [] });

/** Un chain que GRABA where/orderBy/values/for y los JOIN (por el nombre de la tabla). */
function espiando(rows: unknown[], sobre: Espia = espiaVacio()) {
  const c = chain(rows) as unknown as Record<string, (...a: unknown[]) => unknown>;
  c.where = (a: unknown) => { sobre.where = a as SQL; return c; };
  c.orderBy = (...a: unknown[]) => { sobre.orderBy = a as SQL[]; return c; };
  c.values = (a: unknown) => { sobre.values = a; return c; };
  c.for = (a: unknown) => { sobre.for = a as string; return c; };
  const join = (t: unknown) => { sobre.joins.push(String((t as { [k: symbol]: unknown })[Symbol.for('drizzle:Name')] ?? '?')); return c; };
  c.leftJoin = join; c.innerJoin = join;
  return c;
}

const TRAMITE = '7d2f4a10-0b1c-4d2e-9f30-a1b2c3d4e5f6';
const TIPO = '3f1c2b7e-9d4a-4c8e-8f0b-1a2b3c4d5e6f';
const TIPO_2 = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const ASIGNACION = 'c0ffee00-1111-4222-8333-444455556666';
const T0 = new Date('2026-09-14T15:00:00.000Z');
const T1 = new Date('2026-09-14T15:05:00.000Z');
const FILA_TRAMITE = { id: TRAMITE, idFlit: 'FLIT-0001' };
const FILA_TIPO = { id: TIPO, nombre: 'Diagnóstico', descripcion: 'Revisión técnica', valor: '85000.00' };
const asignacion = (over: Record<string, unknown> = {}) => ({
  id: ASIGNACION, tipoId: TIPO, nombre: 'Diagnóstico', descripcion: 'Revisión técnica', valor: '85000.00',
  asignadoPorId: 5, asignadoPorNombre: 'Ana Pérez', asignadoEn: T0, ...over,
});
const SA = '"flito_tramite_servicios_adicionales"';

beforeEach(() => {
  for (const m of [selectMock, insertMock, deleteMock, transactionMock, txSelect, txInsert, txDelete]) m.mockReset();
  transactionMock.mockImplementation(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx));
});

describe('aDto — numeric a número, fecha a ISO, nulos explícitos', () => {
  it('convierte la fila del contrato', () => {
    expect(aDto(asignacion({ descripcion: null, asignadoPorId: null, asignadoPorNombre: null }))).toEqual({
      id: ASIGNACION, tipoId: TIPO, nombre: 'Diagnóstico', descripcion: null, valor: 85000,
      asignadoPorId: null, asignadoPorNombre: null, asignadoEn: '2026-09-14T15:00:00.000Z', origen: 'manual',
    });
    // Bug #12913: `origen` sale del EXISTS del comprobante aplicado (`deComprobante`).
    expect(aDto(asignacion({ deComprobante: true })).origen).toBe('comprobante');
    expect(aDto(asignacion({ deComprobante: false })).origen).toBe('manual');
  });
});

describe('listar — el GET lee la puente (nunca el catálogo), ordena por asignado_en e id, suma en JS (AC3, AC4)', () => {
  it('404 si el trámite no existe, sin leer la puente', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    await expect(listar(TRAMITE)).rejects.toBeInstanceOf(TramiteNoEncontradoError);
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('items con las 8 claves, total = suma de los valor de la puente (125000), liquidado según flito_liquidaciones', async () => {
    const espia = espiaVacio();
    selectMock
      .mockReturnValueOnce(chain([FILA_TRAMITE]))
      .mockReturnValueOnce(espiando([asignacion(), asignacion({ id: 'b', tipoId: TIPO_2, nombre: 'Derecho de petición', valor: '40000.00', asignadoEn: T1 })], espia))
      .mockReturnValueOnce(chain([]));
    const r = await listar(TRAMITE);
    expect(r.liquidado).toBe(false);
    expect(r.total).toBe(125000);
    expect(r.items).toHaveLength(2);
    expect(Object.keys(r.items[0]!).sort()).toEqual(['asignadoEn', 'asignadoPorId', 'asignadoPorNombre', 'descripcion', 'id', 'nombre', 'origen', 'tipoId', 'valor']);
    expect(r.items[0]).toMatchObject({ nombre: 'Diagnóstico', valor: 85000, asignadoPorNombre: 'Ana Pérez', asignadoEn: T0.toISOString() });
    // Predicado por trámite y orden estable, sobre el SQL renderizado (M2 por el lado del GET: sin JOIN al catálogo).
    const w = renderizar(espia.where!);
    expect(w.sql).toBe(`${SA}."tramite_id" = $1`);
    expect(w.params).toEqual([TRAMITE]);
    expect(espia.orderBy!.map((o) => renderizar(o).sql)).toEqual([`${SA}."asignado_en" asc`, `${SA}."id" asc`]);
    expect(espia.joins).toEqual(['users']);
    expect(espia.joins).not.toContain('flito_servicios_adicionales_tipos');
  });

  it('Bug #12913 — `origen` en el GET: comprobante si el EXISTS del comprobante aplicado da true, manual si no; la proyección lo calcula sin parámetros', async () => {
    const proyecciones: unknown[] = [];
    selectMock
      .mockReturnValueOnce(chain([FILA_TRAMITE]))
      .mockImplementationOnce((p: unknown) => { proyecciones.push(p); return chain([asignacion({ deComprobante: true }), asignacion({ id: 'b', tipoId: TIPO_2, deComprobante: false })]); })
      .mockReturnValueOnce(chain([]));
    const r = await listar(TRAMITE);
    expect(r.items.map((i) => i.origen)).toEqual(['comprobante', 'manual']);
    const existe = renderizar((proyecciones[0] as { deComprobante: SQL }).deComprobante);
    expect(existe.params).toEqual([]);
    expect(existe.sql).toContain('"flito_comprobantes"."servicio_tipo_id" = "flito_tramite_servicios_adicionales"."tipo_id"');
  });

  it('liquidado: true cuando hay fila en flito_liquidaciones, y el predicado es por tramite_id', async () => {
    const espiaLiq = espiaVacio();
    selectMock
      .mockReturnValueOnce(chain([FILA_TRAMITE]))
      .mockReturnValueOnce(espiando([], espiaVacio()))
      .mockReturnValueOnce(espiando([{ id: 'liq-1' }], espiaLiq));
    const r = await listar(TRAMITE);
    expect(r).toEqual({ items: [], total: 0, liquidado: true });
    expect(renderizar(espiaLiq.where!).sql).toBe('"flito_liquidaciones"."tramite_id" = $1');
    expect(renderizar(espiaLiq.where!).params).toEqual([TRAMITE]);
  });

  it('el orden es asignado_en ASC con desempate por id ASC: tres filas con ids desalineados salen como las ordenaría Postgres', async () => {
    const espia = espiaVacio();
    const filas = [
      asignacion({ id: 'c', asignadoEn: T1 }),
      asignacion({ id: 'b', asignadoEn: T0 }),
      asignacion({ id: 'a', asignadoEn: T1 }),
    ];
    const terminos = await (async () => {
      await serviciosAsignadosDe({ select: () => espiando(filas, espia) } as never, TRAMITE);
      return terminosDeOrden(espia.orderBy!);
    })();
    const ordenadas = ordenarComoPostgres(filas, terminos, (f, col) => (col === 'asignado_en' ? f.asignadoEn : col === 'id' ? f.id : undefined));
    expect(ordenadas.map((f) => f.id)).toEqual(['b', 'a', 'c']);
  });

  it('el snapshot manda: aunque el catálogo diga 90000 (o el tipo esté de baja), el GET devuelve lo que hay en la puente (AC4)', async () => {
    // El mock del catálogo devolvería 90000 si alguien lo consultara; nadie lo consulta.
    selectMock
      .mockReturnValueOnce(chain([FILA_TRAMITE]))
      .mockReturnValueOnce(espiando([asignacion()]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValue(chain([{ ...FILA_TIPO, valor: '90000.00', activo: false }]));
    const r = await listar(TRAMITE);
    expect(r.items[0]!.valor).toBe(85000);
    expect(r.total).toBe(85000);
    expect(selectMock).toHaveBeenCalledTimes(3);
  });
});

describe('tramiteLiquidado — con el ejecutor que le pasen', () => {
  it('true con fila, false sin fila', async () => {
    txSelect.mockReturnValueOnce(chain([{ id: 'x' }])).mockReturnValueOnce(chain([]));
    expect(await tramiteLiquidado(tx as never, TRAMITE)).toBe(true);
    expect(await tramiteLiquidado(tx as never, TRAMITE)).toBe(false);
    expect(selectMock).not.toHaveBeenCalled();
  });
});

describe('asignar — bloqueo del trámite, guarda de liquidado, tipo activo e INSERT del snapshot en UNA transacción (AC4, AC5)', () => {
  /** tx.select en orden: trámite (FOR UPDATE), liquidación, tipo, actor. */
  function armarTx(o: { tramite?: unknown[]; liquidacion?: unknown[]; tipo?: unknown[]; actor?: unknown[] } = {}, espias: { tramite?: Espia; tipo?: Espia } = {}) {
    txSelect
      .mockReturnValueOnce(espiando(o.tramite ?? [FILA_TRAMITE], espias.tramite ?? espiaVacio()))
      .mockReturnValueOnce(chain(o.liquidacion ?? []))
      .mockReturnValueOnce(espiando(o.tipo ?? [FILA_TIPO], espias.tipo ?? espiaVacio()))
      .mockReturnValueOnce(chain(o.actor ?? [{ name: 'Ana Pérez' }]));
  }

  it('copia nombre, descripción y valor del tipo en values() (no lo que el mock devuelve), con asignadoPorId; devuelve la fila e idFlit', async () => {
    const espiaTramite = espiaVacio();
    const espiaTipo = espiaVacio();
    const grabado = espiaVacio();
    armarTx({}, { tramite: espiaTramite, tipo: espiaTipo });
    txInsert.mockReturnValueOnce(espiando([asignacion({ asignadoPorId: 7, asignadoPorNombre: undefined })], grabado));
    const r = await asignar(TRAMITE, TIPO, 7);
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(grabado.values).toEqual({
      tramiteId: TRAMITE, tipoId: TIPO, nombre: 'Diagnóstico', descripcion: 'Revisión técnica', valor: '85000.00', asignadoPorId: 7,
    });
    expect(r.idFlit).toBe('FLIT-0001');
    expect(r.asignacion).toMatchObject({ id: ASIGNACION, nombre: 'Diagnóstico', valor: 85000, asignadoPorId: 7, asignadoPorNombre: 'Ana Pérez', asignadoEn: T0.toISOString() });
    // Bloqueo: SELECT … FOR UPDATE sobre flito_tramites por id (RN-03).
    expect(espiaTramite.for).toBe('update');
    expect(renderizar(espiaTramite.where!).sql).toBe('"flito_tramites"."id" = $1');
    // El tipo se lee ACTIVO: id y activo = true en el mismo WHERE (M-05b).
    const wTipo = renderizar(espiaTipo.where!);
    expect(wTipo.sql).toBe('("flito_servicios_adicionales_tipos"."id" = $1 and "flito_servicios_adicionales_tipos"."activo" = $2)');
    expect(wTipo.params).toEqual([TIPO, true]);
    // Todo dentro de la transacción: la conexión suelta no se toca (M-05f).
    expect(selectMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
    expect(txSelect).toHaveBeenCalledTimes(4);
  });

  it('sin actor (usuarioId null): asignadoPorId null, asignadoPorNombre null y no se consulta users', async () => {
    const grabado = espiaVacio();
    armarTx();
    txInsert.mockReturnValueOnce(espiando([asignacion({ asignadoPorId: null })], grabado));
    const r = await asignar(TRAMITE, TIPO, null);
    expect((grabado.values as { asignadoPorId: unknown }).asignadoPorId).toBeNull();
    expect(r.asignacion.asignadoPorNombre).toBeNull();
    expect(txSelect).toHaveBeenCalledTimes(3);
  });

  it('404 TramiteNoEncontradoError si el trámite no existe: nada más se lee ni se escribe', async () => {
    txSelect.mockReturnValueOnce(chain([]));
    await expect(asignar(TRAMITE, TIPO, 7)).rejects.toBeInstanceOf(TramiteNoEncontradoError);
    expect(txSelect).toHaveBeenCalledTimes(1);
    expect(txInsert).not.toHaveBeenCalled();
  });

  it('409 TramiteLiquidadoError con el mensaje literal si hay liquidación; sin leer el tipo ni insertar (M1)', async () => {
    armarTx({ liquidacion: [{ id: 'liq-1' }] });
    const e = await asignar(TRAMITE, TIPO, 7).then(() => null, (err: unknown) => err);
    expect(e).toBeInstanceOf(TramiteLiquidadoError);
    expect((e as Error).message).toBe('Reversa la liquidación para cambiar los servicios');
    expect(txInsert).not.toHaveBeenCalled();
    expect(txSelect).toHaveBeenCalledTimes(2); // trámite + liquidación; el tipo ya no se lee
  });

  it('404 TipoNoDisponibleError si el tipo no existe o está de baja (el WHERE lleva activo = true); sin insertar', async () => {
    armarTx({ tipo: [] });
    await expect(asignar(TRAMITE, TIPO, 7)).rejects.toBeInstanceOf(TipoNoDisponibleError);
    expect(txInsert).not.toHaveBeenCalled();
  });

  it('el 23505 del UNIQUE se traduce a ServicioYaAsignadoError (la carrera de dos POST la resuelve la base, no una prelectura)', async () => {
    armarTx();
    txInsert.mockReturnValueOnce(chainReject(Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'flito_tramite_serv_adic_tramite_tipo_uq' })));
    await expect(asignar(TRAMITE, TIPO, 7)).rejects.toBeInstanceOf(ServicioYaAsignadoError);
  });

  it('cualquier otro error del INSERT se propaga tal cual (no se enmascara como 409)', async () => {
    armarTx();
    const caida = Object.assign(new Error('connection reset'), { code: '57P01' });
    txInsert.mockReturnValueOnce(chainReject(caida));
    await expect(asignar(TRAMITE, TIPO, 7)).rejects.toBe(caida);
  });
});

describe('quitar — bloqueo, guarda de liquidado y DELETE por (id, tramite_id) con RETURNING del snapshot (AC6)', () => {
  it('204: el DELETE liga asignacionId Y tramiteId; devuelve tipoId, nombre y valor (número) para auditar, e idFlit', async () => {
    const espiaTramite = espiaVacio();
    const espiaDelete = espiaVacio();
    txSelect.mockReturnValueOnce(espiando([FILA_TRAMITE], espiaTramite)).mockReturnValueOnce(chain([])).mockReturnValueOnce(chain([{ deComprobante: false }]));
    txDelete.mockReturnValueOnce(espiando([{ tipoId: TIPO, nombre: 'Diagnóstico', valor: '85000.00' }], espiaDelete));
    const r = await quitar(TRAMITE, ASIGNACION);
    expect(r).toEqual({ tipoId: TIPO, nombre: 'Diagnóstico', valor: 85000, idFlit: 'FLIT-0001' });
    expect(espiaTramite.for).toBe('update');
    const w = renderizar(espiaDelete.where!);
    expect(w.sql).toBe(`(${SA}."id" = $1 and ${SA}."tramite_id" = $2)`);
    expect(w.params).toEqual([ASIGNACION, TRAMITE]);
    expect(txDelete).toHaveBeenCalledTimes(1);
    expect(deleteMock).not.toHaveBeenCalled();
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('0 filas borradas (id inexistente o de OTRO trámite) → AsignacionNoEncontradaError', async () => {
    txSelect.mockReturnValueOnce(chain([FILA_TRAMITE])).mockReturnValueOnce(chain([])).mockReturnValueOnce(chain([]));
    txDelete.mockReturnValueOnce(chain([]));
    await expect(quitar(TRAMITE, ASIGNACION)).rejects.toBeInstanceOf(AsignacionNoEncontradaError);
  });

  // Bug #12913 (mutante M4: quitar sin la guarda). La guarda va en la tx, tras el bloqueo y la de liquidado, ANTES del DELETE.
  it('Bug #12913 — 409 AsignacionDeComprobanteError si la asignación viene de un comprobante de pago aplicado: no se borra; el EXISTS liga (tramite, tipo) de ESA asignación contra el comprobante aplicado, es_pago, SA', async () => {
    const espiaOrigen = espiaVacio();
    const proyecciones: unknown[] = [];
    txSelect.mockReturnValueOnce(chain([FILA_TRAMITE])).mockReturnValueOnce(chain([]))
      .mockImplementationOnce((p: unknown) => { proyecciones.push(p); return espiando([{ deComprobante: true }], espiaOrigen); });
    await expect(quitar(TRAMITE, ASIGNACION)).rejects.toBeInstanceOf(AsignacionDeComprobanteError);
    expect(txDelete).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
    const w = renderizar(espiaOrigen.where!);
    expect(w.sql).toBe(`(${SA}."id" = $1 and ${SA}."tramite_id" = $2)`);
    expect(w.params).toEqual([ASIGNACION, TRAMITE]);
    const existe = renderizar((proyecciones[0] as { deComprobante: SQL }).deComprobante);
    expect(existe.params).toEqual([]);
    expect(existe.sql.replace(/\s+/g, ' ')).toBe(`exists (select 1 from "flito_comprobantes" where "flito_comprobantes"."tramite_id" = ${SA}."tramite_id" and "flito_comprobantes"."servicio_tipo_id" = ${SA}."tipo_id" and "flito_comprobantes"."estado" = 'aplicado' and "flito_comprobantes"."es_pago" = true and "flito_comprobantes"."concepto" = 'servicios_adicionales')`);
    expect(new AsignacionDeComprobanteError().message).toBe('Este servicio viene de un comprobante de pago aplicado; no se puede quitar desde el panel');
  });

  it('Bug #12913 — asignación MANUAL (sin comprobante) se sigue quitando', async () => {
    txSelect.mockReturnValueOnce(chain([FILA_TRAMITE])).mockReturnValueOnce(chain([])).mockReturnValueOnce(chain([{ deComprobante: false }]));
    txDelete.mockReturnValueOnce(chain([{ tipoId: TIPO, nombre: 'Diagnóstico', valor: '85000.00' }]));
    await expect(quitar(TRAMITE, ASIGNACION)).resolves.toMatchObject({ tipoId: TIPO, valor: 85000 });
    expect(txDelete).toHaveBeenCalledTimes(1);
  });

  it('409 TramiteLiquidadoError si hay liquidación: no se borra nada (M1 por el lado del DELETE)', async () => {
    txSelect.mockReturnValueOnce(chain([FILA_TRAMITE])).mockReturnValueOnce(chain([{ id: 'liq-1' }]));
    await expect(quitar(TRAMITE, ASIGNACION)).rejects.toBeInstanceOf(TramiteLiquidadoError);
    expect(txDelete).not.toHaveBeenCalled();
  });

  it('404 si el trámite no existe, sin borrar', async () => {
    txSelect.mockReturnValueOnce(chain([]));
    await expect(quitar(TRAMITE, ASIGNACION)).rejects.toBeInstanceOf(TramiteNoEncontradoError);
    expect(txDelete).not.toHaveBeenCalled();
  });
});

describe('Bug #12913 — fijarDesdeComprobante: upsert por (tramite_id, tipo_id) con el valor del COMPROBANTE', () => {
  it('values con el snapshot del tipo y el valor recibido; ON CONFLICT (tramite_id, tipo_id) DO UPDATE SET valor = excluded.valor (nunca el del catálogo: mutante M1)', async () => {
    const grabado: { values?: unknown; conflicto?: { target: unknown[]; set: Record<string, unknown> } } = {};
    const c = chain([]) as unknown as Record<string, (...a: unknown[]) => unknown>;
    c.values = (v: unknown) => { grabado.values = v; return c; };
    c.onConflictDoUpdate = (cfg: unknown) => { grabado.conflicto = cfg as never; return c; };
    txInsert.mockReturnValueOnce(c);
    await fijarDesdeComprobante(tx as never, TRAMITE, FILA_TIPO, '120000', 7);
    expect(grabado.values).toEqual({ tramiteId: TRAMITE, tipoId: TIPO, nombre: 'Diagnóstico', descripcion: 'Revisión técnica', valor: '120000', asignadoPorId: 7 });
    expect(Object.keys(grabado.conflicto!.set)).toEqual(['valor']);
    const set = renderizar(grabado.conflicto!.set.valor as SQL);
    expect(set).toEqual({ sql: 'excluded.valor', params: [] });
    const { flitoTramiteServiciosAdicionales: P } = await import('../../src/db/schema.js');
    expect(grabado.conflicto!.target).toEqual([P.tramiteId, P.tipoId]);
    expect(insertMock).not.toHaveBeenCalled();
  });
});
