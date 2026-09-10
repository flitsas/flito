// HU #12433 — consolidado del reporte de costos por cliente y periodo, con exportación (Feature #12404).
//
// Reglas de la suite: el CI no levanta Postgres y el mock `chain` de keyed-db devuelve la fila entera e
// ignora columnas, joins, `where`, `groupBy` y `orderBy`. Por eso la FORMA de la agregación —las tres
// claves del GROUP BY, el `COUNT(DISTINCT`, las `SUM` de cada expresión, el periodo con `to_char`/
// `EXTRACT(QUARTER` y sin ningún `$n` en el GROUP BY (guarda del 42803)— se afirma sobre el SQL
// RENDERIZADO con `QueryBuilder`, y la igualdad con el detalle (CF-13) comparando byte a byte el
// WHERE y la lista de JOIN. Lo puro (`plegarConsolidado`, `periodoConsolidado`, `aCsvConsolidado`,
// `claveEmpresa`) se prueba llamándolo. Cada aserto lleva el mutante que lo pone rojo.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { QueryBuilder, type PgSelect } from 'drizzle-orm/pg-core';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken, type TestRole } from '../helpers/auth.js';
import type { GrupoConsolidado, PeriodoConsolidado } from '../../src/modules/finanzas/finanzas.consolidado.js';

const kdb = createKeyedDb();

vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: vi.fn().mockResolvedValue(undefined) }));
// Espía que ENVUELVE al original: las rutas se prueban contra el servicio real y a la vez se lee qué
// filtro y qué periodo les llegó (AC2, AC6).
vi.mock('../../src/modules/finanzas/finanzas.consolidado.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/modules/finanzas/finanzas.consolidado.js')>();
  return { ...orig, consolidadoReporte: vi.fn(orig.consolidadoReporte) };
});

const consolidado = await import('../../src/modules/finanzas/finanzas.consolidado.js');
const {
  aCsvConsolidado, CABECERAS_CSV_CONSOLIDADO, consolidadoReporte, ensamblarConsolidado, EXPR_PERIODO,
  periodoConsolidado, plegarConsolidado, selectConsolidado, SIN_APROBAR,
} = consolidado;
const servicio = await import('../../src/modules/finanzas/finanzas.service.js');
const { agruparEmpresas, claveEmpresa, condiciones, conJoins, indiceEmpresas, SELECT_FILA, SELECT_TOTALES } = servicio;
type FiltrosReporte = Parameters<typeof condiciones>[0];
const { flitoTramites } = await import('../../src/db/schema.js');
const { and } = await import('drizzle-orm');
const { renderizar, gruposHuerfanos } = await import('../helpers/sql-ligado.js');
const { logPiiAccess } = await import('../../src/shared/pii-audit.js');

const consolidadoMock = vi.mocked(consolidadoReporte);
const logPiiMock = vi.mocked(logPiiAccess);

async function buildApp() {
  const app = express();
  const { default: router } = await import('../../src/modules/finanzas/finanzas.routes.js');
  app.use('/api/finanzas', router);
  return app;
}
const auth = async (role: TestRole = 'financiera') =>
  `Bearer ${await testToken({ sub: 3, username: `${role}@flit.io`, role })}`;

/** Un select abierto con `QueryBuilder` (sin base): rinde el mismo SQL que el de `db`, pero no ejecuta. */
const abrir = (campos: Record<string, unknown>): PgSelect =>
  new QueryBuilder().select(campos as never).from(flitoTramites).$dynamic() as unknown as PgSelect;
/** La consulta REAL del consolidado, renderizada: `ensamblarConsolidado` sobre un select de `QueryBuilder`. */
const SQL_CONSOLIDADO = (periodo: PeriodoConsolidado, f: FiltrosReporte = {}) =>
  ensamblarConsolidado(abrir(selectConsolidado(periodo)), f, periodo).toSQL();
/** Los joins del detalle, sin más: contra esto se compara la lista de JOIN del consolidado. */
const SQL_JOINS = () => conJoins(abrir({ id: flitoTramites.id })).toSQL();

/** Trozos de la consulta renderizada, por sus cláusulas de primer nivel. */
function trozos(sql: string) {
  const iFrom = sql.indexOf(' from "flito_tramites"');
  const iWhere = sql.indexOf(' where ');
  const iGroup = sql.indexOf(' group by ');
  if (iFrom < 0 || iGroup < 0) throw new Error(`Sin FROM o sin GROUP BY:\n${sql}`);
  return {
    select: sql.slice(0, iFrom),
    joins: sql.slice(iFrom, iWhere >= 0 ? iWhere : iGroup),
    where: iWhere >= 0 ? sql.slice(iWhere + ' where '.length, iGroup) : null,
    groupBy: sql.slice(iGroup + ' group by '.length),
  };
}

/** Una fila de grupo como la devuelve el select agregado (sumas como texto de `numeric`). */
function grupo(over: Partial<GrupoConsolidado> = {}): GrupoConsolidado {
  return {
    companiaId: 7, companiaNit: '811011779', periodo: '2026-09', tramites: 2,
    soat: '900000', impuesto: '240000', derechoTramite: '160000', gmf: '6920', logistica: '30000',
    tramiteDigital: '400000', totalReintegro: '1336920', totalServicio: '400000', total: '1736920',
    filasIncompletas: 0,
    ...over,
  };
}
const MAESTRO = [
  { id: 7, nombre: 'ACME', documento: '811.011.779-5' },
  { id: 9, nombre: 'BETA', documento: '900555111' },
];

beforeEach(() => {
  kdb.reset();
  consolidadoMock.mockClear();
  logPiiMock.mockClear();
});

// ───────────────────────────── AC1 — cliente × mes, en SQL ─────────────────────────────

describe('AC1 — consolidado por cliente y mes (CF-12, RN-02, RN-06)', () => {
  it('agrupa por compania_id, compania_nit y la expresión de periodo; la del SELECT es la MISMA', () => {
    const { sql } = SQL_CONSOLIDADO('mes', { estados: ['Aprobado'] });
    const t = trozos(sql);
    // Mutante «GROUP BY sin el periodo» / «sin el NIT»: la cláusula perdería una de las tres claves.
    expect(t.groupBy).toBe(
      '"flito_tramites"."compania_id", "flito_tramites"."compania_nit", '
      + 'to_char(("flito_tramites"."fecha_aprobacion" AT TIME ZONE \'UTC\'), \'YYYY-MM\')',
    );
    expect(t.select).toContain('to_char(("flito_tramites"."fecha_aprobacion" AT TIME ZONE \'UTC\'), \'YYYY-MM\')');
    // La guarda del 42803: nada del GROUP BY queda fuera de la proyección (misma instancia, sin `$n`).
    expect(gruposHuerfanos({ sql, params: [] })).toEqual([]);
  });

  it('cuenta con COUNT(DISTINCT flito_tramites.id) y suma cada expresión de valor (SELECT_TOTALES tal cual)', () => {
    const sel = selectConsolidado('mes');
    // Mutante «COUNT(*)»: un trámite con dos filas en un join contaría dos veces.
    expect(renderizar(sel.tramites).sql).toBe('COUNT(DISTINCT "flito_tramites"."id")::int');
    // Mutante «copia de las sumas»: cada clave es la MISMA instancia que totaliza el detalle.
    for (const k of Object.keys(SELECT_TOTALES) as Array<keyof typeof SELECT_TOTALES>) {
      expect(sel[k], k).toBe(SELECT_TOTALES[k]);
    }
    const { select } = trozos(SQL_CONSOLIDADO('mes').sql);
    expect(select.match(/SUM\(/g)!.length).toBeGreaterThanOrEqual(9);
    expect(select).toContain('COUNT(*) FILTER (WHERE');
  });

  it('totalServicio es la SUM de la expresión td.valor y no lg.valor; totalReintegro lleva las cinco con COALESCE', () => {
    const sel = selectConsolidado('mes');
    const servicio = renderizar(sel.totalServicio).sql;
    // Mutante «la logística se suma dentro del servicio».
    expect(servicio).toContain('"td"."valor"');
    expect(servicio).not.toContain('"lg"."valor"');
    // El reintegro suma los cinco sellados (SOAT, impuesto, derecho, GMF, logística) y no el digital
    // como sumando propio; el `td.valor` que aparece dentro es la BASE del GMF, que sí lo incluye.
    const reintegro = renderizar(sel.totalReintegro).sql;
    for (const col of ['valor_soat', 'valor_impuesto', 'valor_derecho', 'valor_gmf', 'valor_logistica']) {
      expect(reintegro, col).toContain(`"flito_liquidaciones"."${col}"`);
    }
    expect(reintegro).toContain('"lg"."valor"');
    expect(reintegro).not.toMatch(/\+ COALESCE\(CASE WHEN "flito_liquidaciones"\."id" IS NOT NULL THEN "flito_liquidaciones"\."valor_tramite_digital"\s+ELSE "td"\."valor" END, 0\)\), 0\)$/);
    expect(renderizar(sel.totalServicio).sql).not.toContain('valor_logistica');
  });

  it('en cada fila plegada reintegro = soat+impuesto+derecho+gmf+logística, servicio = digital, y suman el total sin incompletas', () => {
    const { items } = plegarConsolidado([grupo()], MAESTRO);
    expect(items).toHaveLength(1);
    const f = items[0]!;
    expect(f).toMatchObject({ clienteNombre: 'ACME', periodo: '2026-09', tramites: 2, filasIncompletas: 0 });
    expect(f.totalReintegro).toBe(f.soat + f.impuesto + f.derechoTramite + f.gmf + f.logistica);
    expect(f.totalServicio).toBe(f.tramiteDigital);
    expect(f.totalReintegro + f.totalServicio).toBe(f.total);
  });

  it('el servicio devuelve periodo «mes» y proyecta la expresión de mes hacia la base', async () => {
    kdb.when.select('flito_tramites', [grupo()]).select('clients', MAESTRO);
    const r = await consolidadoReporte({ estados: ['Aprobado'] }, 'mes');
    expect(r.periodo).toBe('mes');
    expect(r.items.map((i) => [i.clienteNombre, i.periodo])).toEqual([['ACME', '2026-09']]);
    // Mutante «el servicio ignora el periodo pedido»: el select que llegó a la base llevaría otra expresión.
    const proyeccion = kdb.select.mock.calls[0]![0] as ReturnType<typeof selectConsolidado>;
    expect(proyeccion.periodo).toBe(EXPR_PERIODO.mes);
  });
});

// ───────────────────────────── AC2 — trimestre y default ─────────────────────────────

describe('AC2 — consolidado por trimestre (S-03, RN-05)', () => {
  it('el trimestre es EXTRACT(QUARTER FROM …) calendario concatenado como YYYY-Tn, misma instancia en SELECT y GROUP BY', () => {
    const { sql } = SQL_CONSOLIDADO('trimestre');
    const t = trozos(sql);
    const esperado = '(to_char(("flito_tramites"."fecha_aprobacion" AT TIME ZONE \'UTC\'), \'YYYY\') || \'-T\' '
      + '|| EXTRACT(QUARTER FROM ("flito_tramites"."fecha_aprobacion" AT TIME ZONE \'UTC\')))';
    // Mutante «mes/4»: desaparecería `EXTRACT(QUARTER FROM`.
    expect(t.groupBy).toContain('EXTRACT(QUARTER FROM');
    expect(t.groupBy).toBe(`"flito_tramites"."compania_id", "flito_tramites"."compania_nit", ${esperado}`);
    expect(t.select).toContain(esperado);
    expect(gruposHuerfanos({ sql, params: [] })).toEqual([]);
  });

  it('periodoConsolidado: «trimestre» se respeta; ausente o desconocido → «mes»', () => {
    expect(periodoConsolidado('trimestre')).toBe('trimestre');
    expect(periodoConsolidado('mes')).toBe('mes');
    expect(periodoConsolidado(undefined)).toBe('mes');
    expect(periodoConsolidado('semana')).toBe('mes');
    expect(periodoConsolidado(['trimestre'])).toBe('mes');
  });

  it('ruta: periodo=semana responde 200 y agrupa por mes; periodo=trimestre llega al servicio', async () => {
    const app = await buildApp();
    // Mutante «400 ante un periodo desconocido».
    const r = await request(app).get('/api/finanzas/reporte-costos/consolidado?periodo=semana').set('Authorization', await auth());
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ periodo: 'mes', items: [], totales: expect.objectContaining({ total: 0, filasIncompletas: 0 }) });
    expect(consolidadoMock.mock.calls[0]![1]).toBe('mes');

    const r2 = await request(app).get('/api/finanzas/reporte-costos/consolidado?periodo=trimestre').set('Authorization', await auth());
    expect(r2.status).toBe(200);
    expect(r2.body.periodo).toBe('trimestre');
    expect(consolidadoMock.mock.calls[1]![1]).toBe('trimestre');
  });
});

// ───────────────────────────── AC3 — mismo predicado y mismos joins (CF-13) ─────────────────────────────

describe('AC3 — mismo predicado que el detalle (CF-13)', () => {
  const FILTRO: FiltrosReporte = {
    buscar: 'abc-123', estados: ['Aprobado', 'Asignado'], empresas: ['811011779'], tipos: ['Traspaso'],
    etapa: 'incompleto', documentacionCompleta: true, desde: '2026-01-01', hasta: '2026-12-31',
    aprobadoDesde: '2026-09-01', aprobadoHasta: '2026-10-31', estadoFacturacion: 'rechazado',
    organismos: ['05266', '05001'],
  };

  /** Renumera `$n` restando `desplazamiento`, para comparar un WHERE incrustado con uno renderizado solo. */
  const renumerar = (sql: string, desplazamiento: number) =>
    sql.replace(/\$(\d+)/g, (_, n: string) => `$${Number(n) - desplazamiento}`);

  it.each(['mes', 'trimestre'] as const)('WHERE del consolidado (%s) === WHERE del detalle, byte a byte, con los mismos parámetros', (periodo) => {
    const detalle = renderizar(and(...condiciones(FILTRO))!);
    const q = SQL_CONSOLIDADO(periodo, FILTRO);
    const t = trozos(q.sql);
    expect(t.where).not.toBeNull();
    // Cuántos `$n` consume el SELECT (la tasa del GMF) antes de que empiece el WHERE.
    const antes = (q.sql.slice(0, q.sql.indexOf(' where ')).match(/\$\d+/g) ?? []).length;
    // Mutante «predicado propio» (p. ej. filtrar por fecha de creación en vez de aprobación).
    expect(renumerar(t.where!, antes)).toBe(detalle.sql);
    expect(q.params.slice(antes, antes + detalle.params.length)).toEqual(detalle.params);
    expect(q.params.length).toBe(antes + detalle.params.length);
    // Y esos parámetros son los del filtro de verdad, no un eco.
    expect(detalle.params).toEqual(expect.arrayContaining(['05266', '05001', '811011779', 'Traspaso', 'rechazado']));
  });

  it('sin filtro no hay WHERE: el universo entero, como el detalle', () => {
    const t = trozos(SQL_CONSOLIDADO('mes').sql);
    expect(t.where).toBeNull();
  });

  it('la lista de JOIN renderizada es la de conJoins, byte a byte', () => {
    const detalle = SQL_JOINS();
    const joinsDetalle = detalle.sql.slice(detalle.sql.indexOf(' from "flito_tramites"'));
    const q = SQL_CONSOLIDADO('mes', FILTRO);
    const t = trozos(q.sql);
    // El `'logistica'` del join de excepciones viaja como parámetro; en el consolidado va detrás de
    // los del SELECT, así que se renumera antes de comparar.
    const antes = (t.select.match(/\$\d+/g) ?? []).length;
    const joins = renumerar(t.joins, antes);
    // Mutante «un join menos» o «join propio».
    expect(joins).toBe(joinsDetalle);
    expect(q.params.slice(antes, antes + detalle.params.length)).toEqual(detalle.params);
    expect(joins.match(/ join /g)!.length).toBe(joinsDetalle.match(/ join /g)!.length);
    expect(joins).toContain('left join "organismos_transito_config"');
  });

  it('el SELECT del consolidado no proyecta nada del detalle: solo claves, conteo y sumas', () => {
    const { select } = trozos(SQL_CONSOLIDADO('mes').sql);
    expect(select).not.toContain(renderizar(SELECT_FILA.fechaCreacion).sql);
    expect(select).not.toContain('"vehicles"."plate"');
  });
});

// ───────────────────────────── AC4 — sin ceros y «Sin aprobar» ─────────────────────────────

describe('AC4 — sin filas en cero y sin fecha de aprobación (CF-15)', () => {
  it('un cliente con trámites solo en septiembre no tiene fila de octubre (no hay producto cartesiano)', () => {
    const { items } = plegarConsolidado([
      grupo({ companiaId: 7, companiaNit: '811011779', periodo: '2026-09' }),
      grupo({ companiaId: 9, companiaNit: '900555111', periodo: '2026-10', tramites: 1 }),
    ], MAESTRO);
    expect(items.map((i) => [i.clienteNombre, i.periodo])).toEqual([['ACME', '2026-09'], ['BETA', '2026-10']]);
    expect(items.every((i) => i.tramites > 0)).toBe(true);
  });

  it('la suma de totales del consolidado incluye el grupo Sin aprobar (periodo null), y va al final del cliente', () => {
    const { items, totales } = plegarConsolidado([
      grupo({ periodo: '2026-10', tramites: 1, total: '100', totalReintegro: '100', totalServicio: '0', soat: '100', impuesto: '0', derechoTramite: '0', gmf: '0', logistica: '0', tramiteDigital: '0' }),
      grupo({ periodo: null, tramites: 3, total: '250.5', totalReintegro: '50.5', totalServicio: '200', soat: '50.5', impuesto: '0', derechoTramite: '0', gmf: '0', logistica: '0', tramiteDigital: '200', filasIncompletas: 2 }),
      grupo({ periodo: '2026-09', tramites: 1, total: '1000', totalReintegro: '1000', totalServicio: '0', soat: '1000', impuesto: '0', derechoTramite: '0', gmf: '0', logistica: '0', tramiteDigital: '0' }),
    ], MAESTRO);
    // Mutante «descartar periodo null»: faltarían 250,5 y 3 trámites.
    expect(items.map((i) => i.periodo)).toEqual(['2026-09', '2026-10', null]);
    expect(totales).toEqual({
      soat: 1150.5, impuesto: 0, derechoTramite: 0, gmf: 0, logistica: 0, tramiteDigital: 200,
      totalReintegro: 1150.5, totalServicio: 200, total: 1350.5, filasIncompletas: 2,
    });
    expect(items.reduce((s, i) => s + i.tramites, 0)).toBe(5);
    expect(items[2]).toMatchObject({ periodo: null, tramites: 3, filasIncompletas: 2 });
  });

  it('el CSV rotula el periodo null como «Sin aprobar»', () => {
    const { items, totales } = plegarConsolidado([grupo({ periodo: null })], MAESTRO);
    const csv = aCsvConsolidado({ periodo: 'mes', items, totales });
    expect(csv.split('\r\n')[1]!.split(';')[1]).toBe(SIN_APROBAR);
    expect(SIN_APROBAR).toBe('Sin aprobar');
  });
});

// ───────────────────────────── AC5 — identidad por NIT ─────────────────────────────

describe('AC5 — identidad del cliente por NIT (RN-06)', () => {
  it('dos escrituras del NIT (811011779 y 8110117795), con y sin compania_id → UNA fila por periodo con el nombre registrado', () => {
    const { items } = plegarConsolidado([
      grupo({ companiaId: 7, companiaNit: '8110117795', periodo: '2026-09', tramites: 2, total: '200', soat: '200', impuesto: '0', derechoTramite: '0', gmf: '0', logistica: '0', tramiteDigital: '0', totalReintegro: '200', totalServicio: '0' }),
      grupo({ companiaId: null, companiaNit: '811011779', periodo: '2026-09', tramites: 1, total: '50', soat: '50', impuesto: '0', derechoTramite: '0', gmf: '0', logistica: '0', tramiteDigital: '0', totalReintegro: '50', totalServicio: '0' }),
      grupo({ companiaId: null, companiaNit: '811.011.779-5', periodo: '2026-10', tramites: 1 }),
    ], MAESTRO);
    // Mutante «agrupar por compania_nit crudo»: saldrían tres filas.
    expect(items.map((i) => [i.clienteClave, i.clienteNombre, i.periodo, i.tramites, i.total])).toEqual([
      ['c7', 'ACME', '2026-09', 3, 250],
      ['c7', 'ACME', '2026-10', 1, 1736920],
    ]);
  });

  it('un NIT sin empresa registrada se rotula «NIT 900123456 (sin empresa registrada)», nunca vacío', () => {
    const { items } = plegarConsolidado([grupo({ companiaId: null, companiaNit: '900123456' })], MAESTRO);
    expect(items[0]!.clienteNombre).toBe('NIT 900123456 (sin empresa registrada)');
    expect(items[0]!.clienteClave).toBe('n900123456');
  });

  it('la clave del consolidado es la de agruparEmpresas para el mismo par (nit, companiaId): una función, no una copia', () => {
    const indice = indiceEmpresas(MAESTRO);
    const pares = [
      { nit: '811011779', companiaId: null }, { nit: '8110117795', companiaId: 7 },
      { nit: '900123456', companiaId: null }, { nit: '900555111', companiaId: null },
    ];
    // La faceta pliega los cuatro pares a tres empresas; el consolidado tiene que plegarlos igual.
    const faceta = agruparEmpresas(pares, MAESTRO);
    const filas = plegarConsolidado(pares.map((p) => grupo({ companiaId: p.companiaId, companiaNit: p.nit })), MAESTRO).items;
    expect(faceta.map((e) => e.nombre)).toEqual(filas.map((f) => f.clienteNombre));
    expect(faceta).toHaveLength(3);
    // Y la clave que usa el plegado es literalmente la de `claveEmpresa`.
    for (const p of pares) {
      const { clave, nombre } = claveEmpresa(p, indice);
      expect(filas.find((f) => f.clienteClave === clave)?.clienteNombre).toBe(nombre);
    }
    expect(claveEmpresa({ nit: '811011779', companiaId: null }, indice)).toEqual({ clave: 'c7', nombre: 'ACME' });
    expect(claveEmpresa({ nit: '8110117795', companiaId: 7 }, indice)).toEqual({ clave: 'c7', nombre: 'ACME' });
  });

  it('orden: cliente por nombre (localeCompare es) y dentro periodo ascendente', () => {
    const { items } = plegarConsolidado([
      grupo({ companiaId: 9, companiaNit: '900555111', periodo: '2026-10' }),
      grupo({ companiaId: null, companiaNit: '900123456', periodo: '2026-09' }),
      grupo({ companiaId: 7, companiaNit: '811011779', periodo: '2026-10' }),
      grupo({ companiaId: 7, companiaNit: '811011779', periodo: '2026-09' }),
      grupo({ companiaId: 9, companiaNit: '900555111', periodo: '2026-09' }),
    ], MAESTRO);
    expect(items.map((i) => `${i.clienteNombre}|${i.periodo}`)).toEqual([
      'ACME|2026-09', 'ACME|2026-10', 'BETA|2026-09', 'BETA|2026-10', 'NIT 900123456 (sin empresa registrada)|2026-09',
    ]);
  });
});

// ───────────────────────────── AC6 — exportación ─────────────────────────────

describe('AC6 — exportación del consolidado (CF-14)', () => {
  it('cabecera exacta como array, BOM, «;» y CRLF; cada fila del CSV es una fila del consolidado en el mismo orden', () => {
    expect([...CABECERAS_CSV_CONSOLIDADO]).toEqual([
      'Cliente', 'Periodo', 'Trámites', 'SOAT', 'Impuesto', 'Trámite', 'GMF', 'Logística',
      'Total reintegro', 'Trámite digital', 'Servicio', 'Total', 'Incompletos',
    ]);
    const { items, totales } = plegarConsolidado([
      grupo({ companiaId: 9, companiaNit: '900555111', periodo: '2026-10', tramites: 1, filasIncompletas: 1 }),
      grupo({ periodo: '2026-09' }),
    ], MAESTRO);
    const csv = aCsvConsolidado({ periodo: 'mes', items, totales });
    expect(csv.charCodeAt(0)).toBe(0xFEFF);
    expect(csv.endsWith('\r\n')).toBe(true);
    const lineas = csv.slice(1).split('\r\n').filter(Boolean);
    expect(lineas[0]).toBe('Cliente;Periodo;Trámites;SOAT;Impuesto;Trámite;GMF;Logística;Total reintegro;Trámite digital;Servicio;Total;Incompletos');
    expect(lineas).toHaveLength(1 + items.length);
    expect(lineas[1]!.split(';')).toEqual(['ACME', '2026-09', '2', '900000', '240000', '160000', '6920', '30000', '1336920', '400000', '400000', '1736920', '0']);
    expect(lineas[2]!.split(';')).toEqual(['BETA', '2026-10', '1', '900000', '240000', '160000', '6920', '30000', '1336920', '400000', '400000', '1736920', '1']);
  });

  it('un nombre con «;» va entrecomillado: el mismo celda() del detalle', () => {
    const { items, totales } = plegarConsolidado([grupo()], [{ id: 7, nombre: 'ACME; S.A.S.', documento: null }]);
    const csv = aCsvConsolidado({ periodo: 'mes', items, totales });
    expect(csv.split('\r\n')[1]!.startsWith('"ACME; S.A.S.";2026-09;')).toBe(true);
  });

  it('ruta /consolidado/export: text/csv, consolidado-costos.csv, y recibe organismos y periodo por filtrosDe (espía)', async () => {
    const app = await buildApp();
    kdb.when.select('flito_tramites', [grupo()]).select('clients', MAESTRO);
    const r = await request(app)
      .get('/api/finanzas/reporte-costos/consolidado/export?organismos=05266,%2005001&empresas=811011779&periodo=trimestre')
      .set('Authorization', await auth());
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/csv/);
    expect(r.headers['content-disposition']).toBe('attachment; filename="consolidado-costos.csv"');
    // Mutante «otro parser de filtros» o «periodo perdido».
    expect(consolidadoMock).toHaveBeenCalledTimes(1);
    expect(consolidadoMock.mock.calls[0]![0]).toMatchObject({ organismos: ['05266', '05001'], empresas: ['811011779'] });
    expect(consolidadoMock.mock.calls[0]![1]).toBe('trimestre');
    expect(r.text.split('\r\n')[0]).toBe(`\uFEFF${CABECERAS_CSV_CONSOLIDADO.join(';')}`);
    expect(r.text.split('\r\n')[1]).toContain('ACME;2026-09;2;');
    // Sin titular no hay PII que registrar.
    expect(logPiiMock).not.toHaveBeenCalled();
  });

  it('ruta /consolidado (JSON) también recibe organismos por filtrosDe', async () => {
    const app = await buildApp();
    const r = await request(app)
      .get('/api/finanzas/reporte-costos/consolidado?organismos=05266&aprobadoDesde=2026-09-01')
      .set('Authorization', await auth());
    expect(r.status).toBe(200);
    expect(consolidadoMock.mock.calls[0]![0]).toMatchObject({ organismos: ['05266'], aprobadoDesde: '2026-09-01' });
    expect(logPiiMock).not.toHaveBeenCalled();
  });
});

// ───────────────────────────── AC7 — misma guarda de lectura ─────────────────────────────

describe('AC7 — misma guarda de lectura (CF-19)', () => {
  const RUTAS = ['/api/finanzas/reporte-costos/consolidado', '/api/finanzas/reporte-costos/consolidado/export'];
  const ROLES_SIN_LECTURA: TestRole[] = [
    'proveedor', 'transito', 'compliance', 'lider_pesv', 'supervisor_flota', 'conductor', 'gestor_impuestos', 'mensajero',
  ];

  it.each(RUTAS)('%s sin token → 401', async (ruta) => {
    const app = await buildApp();
    expect((await request(app).get(ruta)).status).toBe(401);
  });

  it.each(ROLES_SIN_LECTURA)('%s → 403 en las dos rutas', async (role) => {
    const app = await buildApp();
    for (const ruta of RUTAS) {
      expect((await request(app).get(ruta).set('Authorization', await auth(role))).status, ruta).toBe(403);
    }
    expect(consolidadoMock).not.toHaveBeenCalled();
  });

  it.each(['admin', 'financiera', 'auditor'] as TestRole[])('%s lee las dos rutas', async (role) => {
    const app = await buildApp();
    for (const ruta of RUTAS) {
      expect((await request(app).get(ruta).set('Authorization', await auth(role))).status, ruta).toBe(200);
    }
  });

  it('las dos rutas se registran bajo LECTURA y el archivo no añade otro requireRole( ni exigirFuncion', () => {
    const fuente = readFileSync(new URL('../../src/modules/finanzas/finanzas.routes.ts', import.meta.url), 'utf8');
    expect(fuente).toMatch(/router\.get\('\/reporte-costos\/consolidado', LECTURA,/);
    expect(fuente).toMatch(/router\.get\('\/reporte-costos\/consolidado\/export', LECTURA,/);
    expect(fuente.match(/requireRole\(/g)).toHaveLength(1);
    expect(fuente).not.toContain('exigirFuncion');
    expect(fuente).not.toContain('exigir-funcion');
  });
});
