// HU #12432 — titular, organismo, periodo y reintegro/servicio en el reporte de costos (Feature #12404).
//
// Reglas de la suite: el CI no levanta Postgres y el mock `chain` devuelve la fila entera e ignora
// columnas, joins, `where` y `orderBy`. Por eso lo que vive en SQL —las columnas nuevas de
// `SELECT_FILA`, el join al catálogo, el predicado del filtro y las sumas de `SELECT_TOTALES`— se
// afirma sobre el SQL RENDERIZADO; lo puro (`bloqueTitular` vía `aFila`, `periodoDe`, `subtotalesDe`,
// `nombreOrganismo`, `aCsv`) se prueba llamándolo. Cada aserto lleva el mutante que lo pone rojo.
//
// Este archivo se ejecuta ADEMÁS bajo `TZ=America/Bogota` (AC13): `periodoDe` con getters locales
// sobrevive en UTC y cae en -05.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken } from '../helpers/auth.js';

const kdb = createKeyedDb();

// `facetas()` usa `selectDistinct`, que el keyed-db no trae. Este mock registra `from`/`leftJoin`/
// `where` de cada llamada y responde por ORDEN de llamada (el `Promise.all` de `facetas` las emite
// en orden síncrono: estados, empresas, tipos, organismos).
interface LlamadaDistinct { from: unknown; leftJoin: unknown[]; where: unknown }
const distinct = { llamadas: [] as LlamadaDistinct[], respuestas: [] as unknown[][] };
const selectDistinct = vi.fn(() => {
  const idx = distinct.llamadas.length;
  const reg: LlamadaDistinct = { from: null, leftJoin: [], where: null };
  distinct.llamadas.push(reg);
  const t: Record<string, unknown> = {};
  t.from = (tbl: unknown) => { reg.from = tbl; return t; };
  t.leftJoin = (tbl: unknown, on: unknown) => { reg.leftJoin.push({ tbl, on }); return t; };
  t.where = (w: unknown) => { reg.where = w; return t; };
  t.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(distinct.respuestas[idx] ?? []).then(res, rej);
  return t;
});

vi.mock('../../src/db/client.js', () => ({
  db: { ...kdb.db, selectDistinct },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: vi.fn().mockResolvedValue(undefined) }));
// Espías que ENVUELVEN al original: las rutas se prueban contra el servicio real y a la vez se puede
// leer qué filtro les llegó (AC5) o cortocircuitar la base (AC11).
vi.mock('../../src/modules/finanzas/finanzas.service.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/modules/finanzas/finanzas.service.js')>();
  return {
    ...orig,
    reporteCostos: vi.fn(orig.reporteCostos),
    filasParaExportar: vi.fn(orig.filasParaExportar),
    resumenFacturacionElectronicaDelReporte: vi.fn(orig.resumenFacturacionElectronicaDelReporte),
  };
});

const servicio = await import('../../src/modules/finanzas/finanzas.service.js');
const {
  aCsv, CABECERAS_CSV, condiciones, conJoins, facetas, filasParaExportar, nombreOrganismo, periodoDe,
  reporteCostos, resumenFacturacionElectronicaDelReporte, SELECT_FILA, SELECT_TOTALES, subtotalesDe,
} = servicio;
const { facetaOrganismos } = await import('../../src/modules/finanzas/finanzas.reporte-columnas.js');
const { flitoTramites, organismosTransitoConfig } = await import('../../src/db/schema.js');
const { getTableName, and } = await import('drizzle-orm');
const { renderizar, ligadosA } = await import('../helpers/sql-ligado.js');
const { logPiiAccess } = await import('../../src/shared/pii-audit.js');

const reporteCostosMock = vi.mocked(reporteCostos);
const filasParaExportarMock = vi.mocked(filasParaExportar);
const resumenFeMock = vi.mocked(resumenFacturacionElectronicaDelReporte);
const logPiiMock = vi.mocked(logPiiAccess);

type Fila = Awaited<ReturnType<typeof filasParaExportar>>[number];

/** Una fila CRUDA como la devuelve el `select` de `SELECT_FILA`, antes de `aFila`. */
function cruda(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tramiteId: 't1', idFlit: 'FLIT-1', placa: 'ABC123', estado: 'Aprobado', empresa: 'ACME',
    vin: 'VIN1', marca: 'CHEVROLET', linea: 'ONIX', tipoTramite: 'Traspaso',
    fechaAprobacion: new Date('2026-09-14T15:30:00.000Z'), fechaCreacion: new Date('2026-09-01T10:00:00.000Z'),
    sellada: false, estadoLiquidacion: null,
    soat: '450000', impuesto: '120000', derechoTramite: '80000', tramiteDigital: '200000',
    logistica: '15000', gmf: '3460', totalFila: '868460',
    soatPendiente: false, impuestoPendiente: false,
    gestionaSoat: true, gestionaImpuesto: true, gestionaLogistica: true,
    soatAutogestionable: false, impuestosAutogestionable: false, logisticaAutogestionable: false,
    estadoFacturacion: 'no_enviado', facturaDatos: null,
    boletaReferencia: null, soatConciliadoEn: null,
    // HU #12432
    titularTipoFlit: 'cc', titularNombresFlit: 'ANA MARÍA', titularApellidosFlit: 'PÉREZ',
    titularDocumento: '1020304050', organismoCodigo: '05266', organismoAlias: 'Envigado',
    // Para `totalesDe` (la misma fila sirve a las cuatro consultas del mock).
    total: '868460', totalReintegro: '668460', totalServicio: '200000', filasIncompletas: 0,
    ...over,
  };
}

/** Pasa una fila cruda por el servicio REAL (`aFila` no se exporta) y devuelve la fila del reporte. */
async function filaDe(over: Record<string, unknown> = {}): Promise<Fila> {
  kdb.when.select('flito_tramites', [cruda(over)]);
  const r = await reporteCostos({});
  return r.items[0];
}

const columna = (csv: string, cabecera: (typeof CABECERAS_CSV)[number]): string =>
  csv.trim().split('\r\n')[1].split(';')[CABECERAS_CSV.indexOf(cabecera)];

async function buildApp() {
  const app = express();
  const { default: router } = await import('../../src/modules/finanzas/finanzas.routes.js');
  app.use('/api/finanzas', router);
  return app;
}
const auth = async () => `Bearer ${await testToken({ sub: 3, username: 'fin@flit.io', role: 'financiera' })}`;

// Drizzle no pone `as "alias"` a los campos `sql`: la proyección se lee por posición. Por eso lo que
// hay que aislar por campo se renderiza campo a campo (`renderizar(SELECT_X.campo)`).
const SQL_FILA = () => conJoins(new QueryBuilder().select(SELECT_FILA).from(flitoTramites).$dynamic()).toSQL();
const SQL_JOINS = () => conJoins(new QueryBuilder().select({ id: flitoTramites.id }).from(flitoTramites).$dynamic()).toSQL();

beforeEach(() => {
  kdb.reset();
  distinct.llamadas.length = 0;
  distinct.respuestas.length = 0;
  reporteCostosMock.mockClear();
  filasParaExportarMock.mockClear();
  resumenFeMock.mockClear();
  logPiiMock.mockReset();
  logPiiMock.mockResolvedValue(undefined);
});

// ───────────────────────────── AC1, AC2, AC3 — el titular ─────────────────────────────

describe('AC1 — titular persona natural (RN-01)', () => {
  it('cc con nombres, apellidos y documento del comprador principal', async () => {
    const f = await filaDe();
    expect(f.titularNombres).toBe('ANA MARÍA');
    expect(f.titularApellidos).toBe('PÉREZ');
    expect(f.titularRazonSocial).toBeNull();
    expect(f.titularTipoDocumento).toBe('CC');
    expect(f.titularDocumento).toBe('1020304050');
  });

  it('SELECT_FILA liga «tipo», «nombres» y «apellidos» como PARÁMETROS de flit_raw', () => {
    const { sql, params } = SQL_FILA();
    for (const clave of ['tipo', 'nombres', 'apellidos']) {
      // La clave viaja ligada, no concatenada; y va dos veces: una para `jsonb_typeof`, otra para `->>`.
      const posiciones = params.map((p, i) => (p === clave ? i + 1 : null)).filter((i): i is number => i !== null);
      expect(posiciones.length, `clave ${clave}`).toBeGreaterThanOrEqual(2);
      for (const n of posiciones) expect(sql).toMatch(new RegExp(`"flito_tramites"\\."flit_raw" ->>? \\$${n}\\b`));
    }
  });

  it('el documento va por SUBCONSULTA correlacionada a flito_compradores, no por join (no multiplica filas)', () => {
    const { sql } = SQL_FILA();
    expect(sql).toMatch(/\(SELECT "flito_compradores"\."numero_documento" FROM "flito_compradores"\s+WHERE "flito_compradores"\."tramite_id" = "flito_tramites"\."id" ORDER BY "flito_compradores"\."id" LIMIT 1\)/);
    expect(renderizar(SELECT_FILA.titularDocumento).sql).toContain('FROM "flito_compradores"');
    // Mutante «leftJoin a compradores»: la tabla NO aparece en la lista de JOIN de `conJoins`.
    expect(SQL_JOINS().sql).not.toMatch(/join "flito_compradores"/i);
  });
});

describe('AC2 — titular persona jurídica (RN-01)', () => {
  it('«n» reparte el campo nombres como razón social y deja nombres/apellidos en null; tipo NIT', async () => {
    // Mutante «tabla copiada con la rama jurídica invertida»: la razón social saldría en nombres.
    const f = await filaDe({ titularTipoFlit: 'n', titularNombresFlit: 'TRANSPORTES ABC SAS', titularApellidosFlit: null, titularDocumento: '900123456' });
    expect(f.titularRazonSocial).toBe('TRANSPORTES ABC SAS');
    expect(f.titularNombres).toBeNull();
    expect(f.titularApellidos).toBeNull();
    expect(f.titularTipoDocumento).toBe('NIT');
    expect(f.titularDocumento).toBe('900123456');
  });
});

describe('AC3 — apellidos en blanco y tipo desconocido (S-05)', () => {
  it('apellidos «␠» → null en la fila y celda vacía EXACTA en el CSV; sigue siendo natural CC', async () => {
    const f = await filaDe({ titularApellidosFlit: ' ' });
    expect(f.titularApellidos).toBeNull();
    expect(f.titularTipoDocumento).toBe('CC');
    expect(columna(aCsv([f]), 'Apellidos')).toBe('');
  });

  it.each([null, 'xx'])('tipo %s: el bloque del titular va vacío pero el documento se muestra igual', async (tipo) => {
    // Mutante «clasificar por apellidos con texto» (la heurística que la HU #11947 borró): con
    // apellidos «PÉREZ» diría persona natural.
    const f = await filaDe({ titularTipoFlit: tipo });
    expect(f.titularNombres).toBeNull();
    expect(f.titularApellidos).toBeNull();
    expect(f.titularRazonSocial).toBeNull();
    expect(f.titularTipoDocumento).toBeNull();
    expect(f.titularDocumento).toBe('1020304050');
  });

  it('cc con apellidos en blanco NO se reclasifica por el nombre: manda el tipo', async () => {
    const f = await filaDe({ titularTipoFlit: 'cc', titularApellidosFlit: ' ' });
    expect(f.titularTipoDocumento).toBe('CC');
    expect(f.titularRazonSocial).toBeNull();
  });

  it('un tipo que llega como objeto no clasifica nada (se usa el ayudante, no un .trim() propio)', async () => {
    const f = await filaDe({ titularTipoFlit: { a: 1 } });
    expect(f.titularTipoDocumento).toBeNull();
    expect(f.titularNombres).toBeNull();
  });
});

// ───────────────────────────── AC4 — el organismo ─────────────────────────────

describe('AC4 — organismo con nombre y sin organismo', () => {
  it('nombreOrganismo: alias manda sobre catálogo, y catálogo sobre código', () => {
    // Mutante «código antes que alias»: el primero daría '05266'.
    expect(nombreOrganismo('05266', 'Envigado')).toBe('Envigado');
    expect(nombreOrganismo('05266', 'Tránsito de Envigado')).toBe('Tránsito de Envigado');
    expect(nombreOrganismo('05266', null)).toBe('Envigado');
    expect(nombreOrganismo('05266', ' ')).toBe('Envigado');
    expect(nombreOrganismo('99999', null)).toBe('99999');
    expect(nombreOrganismo(null, 'Huérfano')).toBeNull();
  });

  it('la fila trae código y nombre, y «OT» del CSV lleva el nombre', async () => {
    const f = await filaDe();
    expect(f.organismoCodigo).toBe('05266');
    expect(f.organismoNombre).toBe('Envigado');
    expect(columna(aCsv([f]), 'OT')).toBe('Envigado');
  });

  it('sin alias configurado sale la ciudad del catálogo compartido', async () => {
    const f = await filaDe({ organismoAlias: null });
    expect(f.organismoNombre).toBe('Envigado');
  });

  it('organismo_codigo null → código y nombre null, celda «OT» vacía; no se inventa uno', async () => {
    const f = await filaDe({ organismoCodigo: null, organismoAlias: null });
    expect(f.organismoCodigo).toBeNull();
    expect(f.organismoNombre).toBeNull();
    expect(columna(aCsv([f]), 'OT')).toBe('');
  });

  it('conJoins: exactamente UN LEFT JOIN a organismos_transito_config por código', () => {
    const { sql } = SQL_JOINS();
    const apariciones = sql.match(/"organismos_transito_config"/g) ?? [];
    // Una en el `left join ... "organismos_transito_config"` y otra en el `on`.
    expect(sql.match(/left join "organismos_transito_config"/g)).toHaveLength(1);
    expect(sql).toMatch(/left join "organismos_transito_config" on "organismos_transito_config"\."codigo" = "flito_tramites"\."organismo_codigo"/);
    // Mutante «INNER»: un trámite sin organismo desaparecería del reporte.
    expect(sql).not.toMatch(/(?<!left )(?<!inner )join "organismos_transito_config"/);
    expect(sql).not.toMatch(/inner join "organismos_transito_config"/);
    expect(apariciones.length).toBeGreaterThanOrEqual(2);
  });
});

// ───────────────────────────── AC5 — el filtro ─────────────────────────────

describe('AC5 — filtro por organismos, combinable', () => {
  const ORG = '"flito_tramites"."organismo_codigo"';

  it('organismos=05266,05001 renderiza IN con los dos códigos como parámetros, sin sustituir a los demás', () => {
    const q = renderizar(and(...condiciones({
      organismos: ['05266', '05001'], empresas: ['811011779'],
      aprobadoDesde: '2026-09-01', aprobadoHasta: '2026-09-30',
    }))!);
    // Mutante «se quita el inArray»: `ligadosA` lanza porque la columna no aparece comparada.
    expect(ligadosA(q, ORG)).toEqual(['05266', '05001']);
    expect(ligadosA(q, '"flito_tramites"."compania_nit"')).toEqual(['811011779']);
    expect(q.sql).toContain('"flito_tramites"."fecha_aprobacion" >= $');
    expect(q.sql).toContain('"flito_tramites"."fecha_aprobacion" < ($');
    expect(q.params).toEqual(expect.arrayContaining(['2026-09-01', '2026-09-30']));
  });

  it('sin el parámetro, el predicado no menciona organismo_codigo', () => {
    const q = renderizar(and(...condiciones({ empresas: ['811011779'] }))!);
    expect(q.sql).not.toContain('organismo_codigo');
  });

  it('una lista vacía tampoco filtra', () => {
    expect(condiciones({ organismos: [] })).toHaveLength(0);
  });

  it('filtrosDe() lo entrega a /reporte-costos, /export y /facturacion-electronica (espías)', async () => {
    const app = await buildApp();
    reporteCostosMock.mockResolvedValueOnce({ items: [], total: 0, page: 1, pageSize: 50 } as never);
    filasParaExportarMock.mockResolvedValueOnce([]);
    resumenFeMock.mockResolvedValueOnce({ total: 0 } as never);
    const q = '?organismos=05266,%2005001&empresas=811011779';

    expect((await request(app).get(`/api/finanzas/reporte-costos${q}`).set('Authorization', await auth())).status).toBe(200);
    expect((await request(app).get(`/api/finanzas/reporte-costos/export${q}`).set('Authorization', await auth())).status).toBe(200);
    expect((await request(app).get(`/api/finanzas/reporte-costos/facturacion-electronica${q}`).set('Authorization', await auth())).status).toBe(200);

    // Mutante «filtrosDe olvida el parámetro»: llegaría undefined.
    for (const spy of [reporteCostosMock, filasParaExportarMock, resumenFeMock]) {
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toMatchObject({ organismos: ['05266', '05001'], empresas: ['811011779'] });
    }
  });
});

// ───────────────────────────── AC6 — la faceta ─────────────────────────────

describe('AC6 — faceta de organismos', () => {
  it('solo los códigos presentes en flito_tramites, sin el null, con nombre y ordenados por nombre', async () => {
    // Cuatro selectDistinct en orden: estados, empresas, tipos, organismos.
    distinct.respuestas.push([], [], [], [
      { codigo: '05001', alias: null }, { codigo: '05266', alias: 'Envigado' }, { codigo: '05266', alias: 'Envigado' },
    ]);
    const r = await facetas();
    expect(r.organismos).toEqual([
      { valor: '05266', nombre: 'Envigado' },
      { valor: '05001', nombre: 'Medellín' },
    ]);

    // Mutante «leer el catálogo entero»: la consulta saldría de otra tabla y sin el `IS NOT NULL`.
    const consulta = distinct.llamadas[3];
    expect(getTableName(consulta.from as never)).toBe('flito_tramites');
    expect(consulta.leftJoin).toHaveLength(1);
    expect(consulta.leftJoin[0]).toMatchObject({ tbl: organismosTransitoConfig });
    expect(renderizar(consulta.where as never).sql).toBe('"flito_tramites"."organismo_codigo" is not null');
  });

  it('el nombre de la faceta es el MISMO que enseña la columna para ese código', async () => {
    distinct.respuestas.push([], [], [], [{ codigo: '05266', alias: null }]);
    const [faceta, fila] = await Promise.all([facetas(), filaDe({ organismoAlias: null })]);
    // Mutante «otra función de nombre en la faceta»: dejarían de coincidir.
    expect(faceta.organismos[0].nombre).toBe(fila.organismoNombre);
    expect(faceta.organismos[0].valor).toBe(fila.organismoCodigo);
  });

  it('facetaOrganismos (pura): el null no genera entrada, deduplica y ordena', () => {
    expect(facetaOrganismos([
      { codigo: null, alias: null }, { codigo: '05001', alias: null },
      { codigo: '05266', alias: 'Envigado' }, { codigo: '05266', alias: 'Envigado' },
      { codigo: '99999', alias: null },
    ])).toEqual([
      { valor: '99999', nombre: '99999' },
      { valor: '05266', nombre: 'Envigado' },
      { valor: '05001', nombre: 'Medellín' },
    ]);
  });
});

// ───────────────────────────── AC7 — mes y trimestre ─────────────────────────────

describe('AC7 — mes y trimestre desde la fecha de aprobación, en UTC', () => {
  it('2026-09-14T15:30Z → 2026-09 / 2026-T3, y el CSV los pone en «Mes» y «Trimestre»', async () => {
    expect(periodoDe('2026-09-14T15:30:00.000Z')).toEqual({ mes: '2026-09', trimestre: '2026-T3' });
    const f = await filaDe();
    expect(f.mes).toBe('2026-09');
    expect(f.trimestre).toBe('2026-T3');
    const csv = aCsv([f]);
    expect(columna(csv, 'Mes')).toBe('2026-09');
    expect(columna(csv, 'Trimestre')).toBe('2026-T3');
  });

  it('2026-10-01T04:30Z (23:30 del 30-sep en Colombia) → 2026-10 / 2026-T4: se deriva en UTC', () => {
    // Mutante «getMonth()/getFullYear() locales»: bajo TZ=America/Bogota daría 2026-09 / 2026-T3.
    expect(periodoDe('2026-10-01T04:30:00.000Z')).toEqual({ mes: '2026-10', trimestre: '2026-T4' });
  });

  it('sin fecha de aprobación → null, y las celdas van vacías', async () => {
    expect(periodoDe(null)).toEqual({ mes: null, trimestre: null });
    expect(periodoDe('no es fecha')).toEqual({ mes: null, trimestre: null });
    const f = await filaDe({ fechaAprobacion: null });
    expect(f.mes).toBeNull();
    expect(f.trimestre).toBeNull();
    const csv = aCsv([f]);
    expect(columna(csv, 'Mes')).toBe('');
    expect(columna(csv, 'Trimestre')).toBe('');
  });

  it.each([
    ['2026-01-15T12:00:00.000Z', '2026-01', '2026-T1'], ['2026-03-31T23:59:59.000Z', '2026-03', '2026-T1'],
    ['2026-04-01T00:00:00.000Z', '2026-04', '2026-T2'], ['2026-06-30T12:00:00.000Z', '2026-06', '2026-T2'],
    ['2026-07-01T00:00:00.000Z', '2026-07', '2026-T3'], ['2026-09-30T12:00:00.000Z', '2026-09', '2026-T3'],
    ['2026-10-01T00:00:00.000Z', '2026-10', '2026-T4'], ['2026-12-31T23:59:59.000Z', '2026-12', '2026-T4'],
  ])('límites: %s → %s / %s', (iso, mes, trimestre) => {
    expect(periodoDe(iso)).toEqual({ mes, trimestre });
  });
});

// ───────────────────────────── AC8 — reintegro y servicio por fila ─────────────────────────────

describe('AC8 — Total reintegro y Servicio por fila (RN-02)', () => {
  const completa = {
    soat: 450000, impuesto: 120000, derechoTramite: 80000, logistica: 15000, tramiteDigital: 200000, gmf: 3460,
    noConfigurados: [] as string[], sinRecibo: [] as string[], pendientesPago: [] as string[],
  };

  it('668460 con logística 15000, y servicio 200000; reintegro + servicio = total', async () => {
    // Mutante «sin logística»: 653460. Mutante «trámite digital dentro del reintegro»: 868460.
    expect(subtotalesDe(completa)).toEqual({ totalReintegro: 668460, totalServicio: 200000 });
    const f = await filaDe();
    expect(f.totalReintegro).toBe(668460);
    expect(f.totalServicio).toBe(200000);
    expect(Math.round((f.totalReintegro! + f.totalServicio!) * 100) / 100).toBe(f.total);
  });

  it('SOAT autogestionado (null, en autogestionados) cuenta 0', () => {
    expect(subtotalesDe({ ...completa, soat: null }).totalReintegro).toBe(218460);
  });

  it('sin tarifa de trámite digital → servicio null, no 0; la fila sigue incompleta', async () => {
    expect(subtotalesDe({ ...completa, tramiteDigital: null, noConfigurados: ['Trámite digital'] }).totalServicio).toBeNull();
    const f = await filaDe({ tramiteDigital: null });
    expect(f.totalServicio).toBeNull();
    expect(f.noConfigurados).toContain('Trámite digital');
    expect(f.totalReintegro).toBe(668460);
  });

  it('impuesto pendiente de pago → reintegro null: un sumando que falta no se disfraza de cero', async () => {
    // Mutante «null pendiente = 0»: daría 548460.
    expect(subtotalesDe({ ...completa, impuesto: null, pendientesPago: ['Impuesto'] }).totalReintegro).toBeNull();
    const f = await filaDe({ impuesto: null, impuestoPendiente: true });
    expect(f.pendientesPago).toContain('Impuesto');
    expect(f.totalReintegro).toBeNull();
    expect(f.totalServicio).toBe(200000);
  });

  it.each([
    ['SOAT', { soat: null, pendientesPago: ['SOAT'] }],
    ['Derecho de tránsito', { derechoTramite: null, sinRecibo: ['Derecho de tránsito'] }],
    ['Logística', { logistica: null, noConfigurados: ['Logística'] }],
  ])('%s pendiente también deja el reintegro en null', (_c, over) => {
    expect(subtotalesDe({ ...completa, ...over }).totalReintegro).toBeNull();
  });

  it('una fila sellada con conceptos que no aplican (null sin pendiente) los cuenta 0', () => {
    expect(subtotalesDe({ ...completa, soat: null, impuesto: null, logistica: null, tramiteDigital: null }))
      .toEqual({ totalReintegro: 83460, totalServicio: 0 });
  });

  it('redondea a dos decimales', () => {
    expect(subtotalesDe({ ...completa, soat: 0.1, impuesto: 0.2, derechoTramite: 0, logistica: 0, gmf: 0 }).totalReintegro).toBe(0.3);
  });
});

// ───────────────────────────── AC9 — totales del universo ─────────────────────────────

describe('AC9 — totales del universo filtrado, en SQL', () => {
  const SQL_TOTALES = () => conJoins(new QueryBuilder().select(SELECT_TOTALES).from(flitoTramites).$dynamic()).toSQL().sql;

  it('la clave totalReintegro aparece en la proyección SQL de totalesDe, como SUM de las cinco expresiones', () => {
    // Mutante «reduce sobre la página»: la clave no estaría en la proyección SQL.
    expect(SELECT_TOTALES).toHaveProperty('totalReintegro');
    expect(SELECT_TOTALES).toHaveProperty('totalServicio');
    const reintegro = renderizar(SELECT_TOTALES.totalReintegro).sql;
    expect(reintegro).toMatch(/^\s*COALESCE\(SUM\(COALESCE\(CASE WHEN/);
    // Y la consulta completa la lleva: la forma `SUM(COALESCE(CASE` solo la tiene el reintegro.
    expect(SQL_TOTALES()).toContain('COALESCE(SUM(COALESCE(CASE WHEN');
    for (const col of ['"flito_liquidaciones"."valor_soat"', '"flito_liquidaciones"."valor_impuesto"',
      '"flito_liquidaciones"."valor_derecho"', '"flito_liquidaciones"."valor_gmf"', '"flito_liquidaciones"."valor_logistica"',
      '"flito_soat"."valor_pagado"', '"flito_impuestos"."valor_pagado"', '"flito_derechos_tramite"."valor"', '"lg"."valor"']) {
      expect(reintegro, col).toContain(col);
    }
    // El trámite digital NO se suma al reintegro (solo aparece dentro de la base del GMF).
    expect(reintegro).not.toContain('"flito_liquidaciones"."valor_tramite_digital" ELSE "td"."valor" END, 0) + COALESCE(CASE');
  });

  it('la SUM del servicio contiene la expresión de td.valor y no la de lg.valor', () => {
    // Mutante «servicio = logística»: contendría lg.valor.
    const servicio = renderizar(SELECT_TOTALES.totalServicio).sql;
    expect(servicio).toContain('"flito_liquidaciones"."valor_tramite_digital"');
    expect(servicio).toContain('"td"."valor"');
    expect(servicio).not.toContain('"lg"."valor"');
    expect(servicio).not.toContain('valor_logistica');
  });

  it('totales trae totalReintegro y totalServicio numéricos, y suman el total sin filas incompletas', async () => {
    kdb.when.select('flito_tramites', [cruda()]);
    const { totales } = await reporteCostos({});
    expect(totales.totalReintegro).toBe(668460);
    expect(totales.totalServicio).toBe(200000);
    expect(totales.totalReintegro + totales.totalServicio).toBe(totales.total);
  });
});

// ───────────────────────────── AC10 — el CSV ─────────────────────────────

describe('AC10 — CSV en tres secciones con nombres canónicos (RN-08)', () => {
  const CABECERA = 'Empresa;Flit;Placa;VIN;Nombres;Apellidos;Razón social;Tipo;Documento;Tipo trámite;Marca;Línea;OT;Estado;Creado;Aprobado;Mes;Trimestre;Estado factura;Factura;SOAT;Impuesto;Trámite;GMF;Logística;Total reintegro;Trámite digital;Servicio;Total;Liquidación;Qué falta para liquidar;SOAT conciliado';

  it('la primera línea es exactamente la cabecera canónica (como un solo array, no «contiene»)', async () => {
    const csv = aCsv([await filaDe()]);
    expect(csv.split('\r\n')[0].replace(/^\uFEFF/, '').split(';')).toEqual(CABECERA.split(';'));
    expect([...CABECERAS_CSV]).toEqual(CABECERA.split(';'));
  });

  it('cada celda por su ÍNDICE en la cabecera', async () => {
    const f = await filaDe({
      facturaDatos: { numero: 'FV-1-123', requiereRevision: false }, estadoFacturacion: 'emitido',
      sellada: true, estadoLiquidacion: 'facturado',
    });
    const csv = aCsv([f]);
    const esperado: Record<(typeof CABECERAS_CSV)[number], string> = {
      Empresa: 'ACME', Flit: 'FLIT-1', Placa: 'ABC123', VIN: 'VIN1', Nombres: 'ANA MARÍA', Apellidos: 'PÉREZ',
      'Razón social': '', Tipo: 'CC', Documento: '1020304050',
      'Tipo trámite': 'Traspaso', Marca: 'CHEVROLET', Línea: 'ONIX', OT: 'Envigado', Estado: 'Aprobado',
      Creado: '2026-09-01', Aprobado: '2026-09-14', Mes: '2026-09', Trimestre: '2026-T3',
      'Estado factura': 'emitido', Factura: 'FV-1-123',
      SOAT: '450000', Impuesto: '120000', Trámite: '80000', GMF: '3460', Logística: '15000',
      'Total reintegro': '668460', 'Trámite digital': '200000', Servicio: '200000', Total: '868460',
      Liquidación: 'Facturado', 'Qué falta para liquidar': '', 'SOAT conciliado': 'No',
    };
    for (const cab of CABECERAS_CSV) expect(columna(csv, cab), cab).toBe(esperado[cab]);
  });

  it('«Tipo» es el documento del titular y «Trámite» los pesos del derecho; «Flit» el identificador', async () => {
    const csv = aCsv([await filaDe({ titularTipoFlit: 'n', titularNombresFlit: 'ABC SAS', derechoTramite: '81000' })]);
    expect(columna(csv, 'Tipo')).toBe('NIT');
    expect(columna(csv, 'Tipo trámite')).toBe('Traspaso');
    expect(columna(csv, 'Trámite')).toBe('81000');
    expect(columna(csv, 'Flit')).toBe('FLIT-1');
    expect(columna(csv, 'Razón social')).toBe('ABC SAS');
  });

  it('formato intacto: punto y coma, BOM, CRLF y comillas solo cuando hacen falta', async () => {
    const csv = aCsv([await filaDe({ empresa: 'GÓMEZ; HIJOS', placa: 'A"B' })]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv).toContain('"GÓMEZ; HIJOS"');
    expect(csv).toContain('"A""B"');
    expect(csv.split('\r\n')[1].startsWith('"GÓMEZ; HIJOS";FLIT-1;"A""B";VIN1;')).toBe(true);
  });
});

// ───────────────────────────── AC11 — Habeas Data ─────────────────────────────

describe('AC11 — el acceso al titular queda registrado (Ley 1581)', () => {
  const CAMPOS = ['nombres', 'apellidos', 'razon_social', 'numero_documento', 'tipo_documento', 'placa', 'vin'];

  it('/export registra accion «export» con los siete campos', async () => {
    const app = await buildApp();
    kdb.when.select('flito_tramites', [cruda()]);
    const r = await request(app).get('/api/finanzas/reporte-costos/export').set('Authorization', await auth());
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');

    // Mutante «se quita la llamada en export»: cero llamadas.
    expect(logPiiMock).toHaveBeenCalledTimes(1);
    const [, opts] = logPiiMock.mock.calls[0];
    expect(opts).toMatchObject({ resourceTipo: 'finanzas_reporte_costos', accion: 'export' });
    expect(opts.camposAccedidos).toEqual(expect.arrayContaining(CAMPOS));
  });

  it('/reporte-costos registra accion «read» con los mismos campos', async () => {
    const app = await buildApp();
    kdb.when.select('flito_tramites', [cruda()]);
    const r = await request(app).get('/api/finanzas/reporte-costos').set('Authorization', await auth());
    expect(r.status).toBe(200);
    expect(r.body.items[0].titularNombres).toBe('ANA MARÍA');

    expect(logPiiMock).toHaveBeenCalledTimes(1);
    const [, opts] = logPiiMock.mock.calls[0];
    expect(opts).toMatchObject({ resourceTipo: 'finanzas_reporte_costos', accion: 'read' });
    expect(opts.camposAccedidos).toEqual(expect.arrayContaining(CAMPOS));
  });

  it('si el registro falla, la exportación se entrega igual (best-effort, con el logPiiAccess REAL)', async () => {
    const real = await vi.importActual<typeof import('../../src/shared/pii-audit.js')>('../../src/shared/pii-audit.js');
    logPiiMock.mockImplementationOnce(real.logPiiAccess);
    kdb.when.insert('pii_access_log', () => { throw new Error('pii_access_log caída'); });
    kdb.when.select('flito_tramites', [cruda()]);

    const app = await buildApp();
    const r = await request(app).get('/api/finanzas/reporte-costos/export').set('Authorization', await auth());
    expect(r.status).toBe(200);
    expect(kdb.insert).toHaveBeenCalled();
    expect(r.text).toContain('ANA MARÍA');
  });

  it('las facetas y los contadores no registran: no exponen titulares', async () => {
    const app = await buildApp();
    distinct.respuestas.push([], [], [], []);
    resumenFeMock.mockResolvedValueOnce({ total: 0 } as never);
    await request(app).get('/api/finanzas/reporte-costos/facetas').set('Authorization', await auth());
    await request(app).get('/api/finanzas/reporte-costos/facturacion-electronica').set('Authorization', await auth());
    expect(logPiiMock).not.toHaveBeenCalled();
  });
});

// ───────────────────────────── AC12 — la guarda no cambia ─────────────────────────────

describe('AC12 — sin permisos nuevos', () => {
  it('las cuatro rutas siguen bajo requireRole(financiera, admin, auditor)', async () => {
    const { readFileSync } = await import('node:fs');
    const fuente = readFileSync(new URL('../../src/modules/finanzas/finanzas.routes.js', import.meta.url).pathname.replace(/\.js$/, '.ts'), 'utf8');
    expect(fuente).toContain("const LECTURA = requireRole('financiera', 'admin', 'auditor');");
    expect(fuente).not.toContain('exigirFuncion');
    expect(fuente.match(/router\.get\('\/reporte-costos[^']*', LECTURA,/g)).toHaveLength(4);
  });
});
