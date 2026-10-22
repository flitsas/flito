// HU #12833 — paso `direccion` del análisis (AC1/AC3), precedencia de lectura (AC2), guarda de la
// corrección manual y bloque del detalle (AC8). Diseño: docs/diseno-hu-12833-direccion-comprador.md.
//
// El mock devuelve lo que se le diga: los asertos van sobre la TABLA que recibió `db.update`, lo que
// se pasó a `.set()` y el SQL RENDERIZADO del `.where()` (memoria: mock-chain-inventa-columnas).
// AC1 «no escribe en flito_compradores» se afirma sobre el espía por tabla, no sobre el resultado.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableName, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const selectMock = vi.fn();
const updateMock = vi.fn();
const insertMock = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, update: updateMock, insert: insertMock, delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
const piiMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: (...a: unknown[]) => piiMock(...a) }));
const logs: unknown[] = [];
vi.mock('../../src/shared/logger.js', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const capt = (...a: unknown[]) => { logs.push(a); };
  const fake = { info: capt, warn: capt, error: capt, debug: capt, child: () => fake };
  return { ...real, loggerFor: () => fake, logger: fake };
});
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const {
  pasoDireccion, direccionEfectiva, direccionConfirmableDe, bloqueDireccionDetalle, direccionFlitDe,
  PENDIENTE_SI_SIN_DIRECCION,
} = await import('../../src/modules/flito-impuestos/flito-impuestos.direccion.js');
const { limitadorRunt } = await import('../../src/modules/flito-impuestos/runt-limitador.js');

const dialect = new PgDialect();
const render = (w: SQL) => dialect.sqlToQuery(w);

interface Grabacion { tabla?: string; set?: Record<string, unknown>; where?: SQL; orderBy?: unknown[] }
function grabador(filas: unknown[], g: Grabacion = {}) {
  const c: Record<string, unknown> = {};
  Object.assign(c, {
    from: (t: Parameters<typeof getTableName>[0]) => { g.tabla = getTableName(t); return c; },
    limit: () => c, returning: () => c,
    orderBy: (...o: unknown[]) => { g.orderBy = o; return c; },
    set: (v: Record<string, unknown>) => { g.set = v; return c; },
    where: (w: SQL) => { g.where = w; return c; },
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(filas).then(res, rej),
  });
  return c;
}
function updates(): Grabacion[] {
  const g: Grabacion[] = [];
  updateMock.mockImplementation((t: Parameters<typeof getTableName>[0]) => { const x: Grabacion = { tabla: getTableName(t) }; g.push(x); return grabador([], x); });
  return g;
}

const ID = '00000000-0000-0000-0000-0000000000d1';
const DIR = 'CALLE 45 # 12-30 CENTINELA';
const campo = (valor: string | null, confiable: boolean) => ({ valor, confianza: confiable ? 0.95 : 0.4, confiable });
const extraccion = (over: Record<string, unknown> = {}) => ({
  direccion: campo(`  ${DIR} `, true), municipio: campo('MEDELLIN', true), departamento: campo('ANTIOQUIA', true),
  vin: campo('9ZZTEST0000000001', true), fuente: 'notas_finales', ...over,
});
const ctx = { impuestoId: ID, runt: limitadorRunt, job: {} };

beforeEach(() => {
  selectMock.mockReset(); updateMock.mockReset(); insertMock.mockReset(); piiMock.mockClear(); logs.length = 0;
});

describe('paso `direccion` — AC1: dirección confiable → confirmada en flito_impuestos', () => {
  it('escribe la dirección recortada, fuente factura, pendiente=false; UN solo UPDATE y solo en flito_impuestos', async () => {
    selectMock.mockReturnValueOnce(grabador([{ extraccion: extraccion() }]));
    const g = updates();
    await pasoDireccion(ctx);

    expect(g).toHaveLength(1);
    expect(g[0]!.tabla).toBe('flito_impuestos');
    expect(insertMock).not.toHaveBeenCalled(); // ni flito_compradores ni nada
    expect(g[0]!.set).toMatchObject({
      direccionFactura: DIR, municipioFactura: 'MEDELLIN', departamentoFactura: 'ANTIOQUIA',
      direccionFuente: 'factura', direccionPendienteRevision: false,
      direccionConfirmadaPorId: null, direccionConfirmadaPorNombre: null,
    });
    expect(g[0]!.set!.direccionConfirmadaEn).toBeInstanceOf(Date);
  });

  it('municipio/departamento NO confiables → NULL (el lector cae a FLIT), la dirección igual se confirma', async () => {
    selectMock.mockReturnValueOnce(grabador([{ extraccion: extraccion({ municipio: campo('MEDELIN?', false), departamento: campo('ANT', false) }) }]));
    const g = updates();
    await pasoDireccion(ctx);
    expect(g[0]!.set).toMatchObject({ direccionFactura: DIR, municipioFactura: null, departamentoFactura: null, direccionFuente: 'factura' });
  });

  it('guarda: solo `en_curso` y NUNCA sobre una corrección manual (IS DISTINCT FROM manual)', async () => {
    selectMock.mockReturnValueOnce(grabador([{ extraccion: extraccion() }]));
    const g = updates();
    await pasoDireccion(ctx);
    const w = render(g[0]!.where!);
    expect(w.sql).toContain('"flito_impuestos"."direccion_fuente" IS DISTINCT FROM \'manual\'');
    expect(w.sql).toMatch(/"analisis_estado" = \$\d/);
    expect(w.params).toEqual([ID, 'en_curso']);
  });

  it('registra el acceso del sistema a la dirección y el log NO lleva la dirección', async () => {
    selectMock.mockReturnValueOnce(grabador([{ extraccion: extraccion() }]));
    updates();
    await pasoDireccion(ctx);
    expect(piiMock).toHaveBeenCalledTimes(1);
    expect(piiMock.mock.calls[0]![1]).toMatchObject({ camposAccedidos: ['direccion', 'municipio', 'departamento'], accion: 'read' });
    expect(JSON.stringify([logs, piiMock.mock.calls.map((c) => c[1])])).not.toContain('CENTINELA');
    expect(JSON.stringify(logs)).toContain('confirmada');
  });
});

describe('paso `direccion` — AC3: bajo umbral o ausente → pendiente, sin confirmar nada', () => {
  it.each([
    ['dirección no confiable', extraccion({ direccion: campo(DIR, false) })],
    ['dirección ausente', extraccion({ direccion: undefined })],
    ['dirección vacía aunque «confiable»', extraccion({ direccion: campo('   ', true) })],
    ['sin extracción', null],
  ])('%s → solo `direccion_pendiente_revision = true`, con la misma guarda', async (_n, e) => {
    selectMock.mockReturnValueOnce(grabador([{ extraccion: e }]));
    const g = updates();
    await pasoDireccion(ctx);
    expect(g).toHaveLength(1);
    expect(g[0]!.tabla).toBe('flito_impuestos');
    expect(g[0]!.set).toEqual({ direccionPendienteRevision: true });
    expect(render(g[0]!.where!).sql).toContain('IS DISTINCT FROM \'manual\'');
    expect(JSON.stringify(logs)).toContain('pendiente');
  });

  it('fallo técnico: el valor de pendiente en los UPDATE de ERROR es `direccion_fuente IS NULL`', () => {
    expect(render(PENDIENTE_SI_SIN_DIRECCION).sql).toBe('"flito_impuestos"."direccion_fuente" IS NULL');
  });
});

describe('AC2 — `direccionEfectiva`: una sola precedencia para detalle y Excel', () => {
  const flit = { direccion: 'CRA 7 FLIT', municipio: 'MOSQUERA', departamento: 'CUNDINAMARCA' };

  it('sin fuente → FLIT tal cual (aunque haya valores guardados)', () => {
    expect(direccionEfectiva({ fuente: null, direccion: 'X', municipio: 'Y', departamento: 'Z' }, flit)).toEqual({ ...flit, origen: 'flit' });
  });
  it('factura con municipio/departamento NULL → dirección de la factura, el resto de FLIT campo a campo', () => {
    expect(direccionEfectiva({ fuente: 'factura', direccion: DIR, municipio: null, departamento: 'ANTIOQUIA' }, flit))
      .toEqual({ direccion: DIR, municipio: 'MOSQUERA', departamento: 'ANTIOQUIA', origen: 'factura' });
  });
  it('manual → los tres de la corrección', () => {
    expect(direccionEfectiva({ fuente: 'manual', direccion: 'M', municipio: 'CHIA', departamento: 'BOY' }, flit))
      .toEqual({ direccion: 'M', municipio: 'CHIA', departamento: 'BOY', origen: 'manual' });
  });
  it('la regla de confirmación es la misma del backfill: confiable + no vacía', () => {
    expect(direccionConfirmableDe(extraccion() as never)).toEqual({ direccion: DIR, municipio: 'MEDELLIN', departamento: 'ANTIOQUIA' });
    expect(direccionConfirmableDe(extraccion({ direccion: campo(DIR, false) }) as never)).toBeNull();
  });
  it('una nueva sincronización con FLIT no pisa la dirección: el sync no escribe ninguna columna de dirección de flito_impuestos', () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(path.resolve(dir, '../../src/modules/flito-sync/flito-sync.service.ts'), 'utf8');
    expect(src).not.toMatch(/direccionFactura|municipioFactura|departamentoFactura|direccionFuente|direccionPendienteRevision|direccionConfirmada/);
    // El único UPDATE del sync sobre el impuesto toca el valor liquidado.
    expect(src.match(/update\(flitoImpuestos\)\.set\(\{[^}]*\}/g)).toEqual([
      'update(flitoImpuestos).set({ valorLiquidado: numOrNull(tf.valorImpuestoLiquidado), updatedAt: new Date() }',
    ]);
  });
});

describe('bloque `direccionComprador` del detalle', () => {
  const flit = { direccion: 'CRA 7 FLIT', municipio: 'MOSQUERA', departamento: 'CUNDINAMARCA' };
  const fila = (over: Record<string, unknown> = {}) => ({
    direccionFuente: null, direccionFactura: null, municipioFactura: null, departamentoFactura: null,
    direccionPendienteRevision: false, direccionConfirmadaPorNombre: null, direccionConfirmadaEn: null,
    analisisEstado: 'completado', extraccionFacturaVenta: extraccion({ direccion: campo('CL 9 DUDOSA', false) }),
    ...over,
  }) as never;

  it('pendiente con análisis terminado → marca y propuesta (lo leído), dato efectivo de FLIT', () => {
    const b = bloqueDireccionDetalle(fila({ direccionPendienteRevision: true, analisisEstado: 'error_analisis' }), flit);
    expect(b).toMatchObject({ ...flit, origen: 'flit', pendienteRevision: true, confirmadaPor: null, confirmadaEn: null });
    expect(b.propuesta).toEqual({ direccion: 'CL 9 DUDOSA', municipio: 'MEDELLIN', departamento: 'ANTIOQUIA' });
  });

  it('AC8: nunca analizado o en curso → sin marca ni propuesta', () => {
    for (const analisisEstado of [null, 'en_curso']) {
      const b = bloqueDireccionDetalle(fila({ direccionPendienteRevision: true, analisisEstado }), flit);
      expect(b.pendienteRevision, String(analisisEstado)).toBe(false);
      expect(b.propuesta).toBeNull();
    }
  });

  it('confirmada por la factura → dirección de la factura, sin propuesta, con fecha ISO', () => {
    const b = bloqueDireccionDetalle(fila({
      direccionFuente: 'factura', direccionFactura: DIR, direccionConfirmadaEn: new Date('2026-09-24T12:00:00Z'),
    }), flit);
    expect(b).toEqual({
      direccion: DIR, municipio: 'MOSQUERA', departamento: 'CUNDINAMARCA', origen: 'factura',
      pendienteRevision: false, propuesta: null, confirmadaPor: null, confirmadaEn: '2026-09-24T12:00:00.000Z',
    });
  });

  it('`direccionFlitDe`: comprador principal por `orden, id` y ciudad/departamento del trámite', async () => {
    const t: Grabacion = {}; const c: Grabacion = {};
    selectMock
      .mockReturnValueOnce(grabador([{ municipio: ' MOSQUERA ', departamento: 'CUNDINAMARCA' }], t))
      .mockReturnValueOnce(grabador([{ direccion: 'CRA 7 FLIT' }], c));
    expect(await direccionFlitDe('tr-1')).toEqual(flit);
    expect(t.tabla).toBe('flito_tramites');
    expect(c.tabla).toBe('flito_compradores');
    expect(c.orderBy!.map((o) => render(o as SQL).sql)).toEqual(['"flito_compradores"."orden" asc', '"flito_compradores"."id" asc']);
  });
});
