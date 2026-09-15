// HU #12432 — titular, organismo, periodo y reintegro/servicio en el reporte de costos (Feature #12404).
//
// Reglas de la suite: el CI no levanta Postgres y el mock `chain` devuelve la fila entera e ignora
// columnas, joins, `where` y `orderBy`. Por eso lo que vive en SQL —las columnas nuevas de
// `SELECT_FILA`, el join al catálogo, el predicado del filtro y las sumas de `SELECT_TOTALES`— se
// afirma sobre el SQL RENDERIZADO; lo puro (`bloqueTitular` vía `aFila`, `periodoDe`, `subtotalesDe`,
// `nombreOrganismo`, `filasExcelDetalle`) se prueba llamándolo. Cada aserto lleva el mutante que lo pone rojo.
//
// HU #12531: el CSV se sustituyó por `.xlsx`. Lo que aquí se afirma del archivo es la FILA serializada
// por clave (`filasExcelDetalle`); el libro real, sus tipos de celda y las rutas POST viven en
// `finanzas.export-excel.test.ts`.
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
  condiciones, conJoins, facetas, filasParaExportar, nombreOrganismo, periodoDe,
  reporteCostos, resumenFacturacionElectronicaDelReporte, SELECT_FILA, SELECT_TOTALES, subtotalesDe,
} = servicio;
const { COLUMNAS_EXPORT_DETALLE, filasExcelDetalle } = await import('../../src/modules/finanzas/finanzas.export-excel.js');
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
    // HU #12546 — la proyección SIEMPRE trae la clave (null = el trámite no lleva servicios). Sin
    // ella, `aFila` haría `Number(undefined)` = NaN y el subtotal de servicio saldría NaN, que es
    // justo el fallo que `build:api` no ve: el tsconfig de la API no typechequea `__tests__`.
    // La misma clave sirve a `SELECT_TOTALES` (`Number(null)` = 0).
    serviciosAdicionales: null, serviciosAdicionalesCantidad: 0,
    soatPendiente: false, impuestoPendiente: false,
    gestionaSoat: true, gestionaImpuesto: true, gestionaLogistica: true,
    soatAutogestionable: false, impuestosAutogestionable: false, logisticaAutogestionable: false,
    estadoFacturacion: 'no_enviado', facturaDatos: null,
    boletaReferencia: null, soatConciliadoEn: null,
    // HU #12432
    titularTipoFlit: 'cc', titularNombresFlit: 'ANA MARÍA', titularApellidosFlit: 'PÉREZ',
    titularDocumento: '1020304050', organismoCodigo: '05266', organismoAlias: 'Envigado',
    // HU #12531 — contacto del primer comprador, por la misma subconsulta que el documento.
    titularCorreo: 'ana@correo.co', titularTelefono: '3001234567', titularDireccion: 'CL 10 # 20-30',
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

/** La celda de la fila serializada por su CLAVE de `COLUMNAS_EXPORT_DETALLE` (HU #12531). */
const celda = (f: Fila, clave: string): unknown => filasExcelDetalle([f])[0]![clave];

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/finanzas/finanzas.routes.js');
  app.use('/api/finanzas', router);
  return app;
}
const auth = async () => `Bearer ${await testToken({ sub: 3, username: 'fin@flit.io', role: 'financiera' })}`;
/** El export pasa por `exportColaLimiter` (5/min y usuario): `sub` nuevo por llamada para no agotar la bolsa. */
let subExport = 4100;
const authExport = async () => `Bearer ${await testToken({ sub: subExport++, username: 'fin@flit.io', role: 'financiera' })}`;

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

  it('HU #12531: correo, celular y dirección van por la MISMA subconsulta (ORDER BY id LIMIT 1), sin join', async () => {
    const { sql } = SQL_FILA();
    for (const col of ['correo', 'celular', 'direccion']) {
      // Mutante «join a compradores para el contacto» o «subconsulta sin ORDER BY/LIMIT»: no casaría.
      expect(sql, col).toMatch(new RegExp(`\\(SELECT "flito_compradores"\\."${col}" FROM "flito_compradores"\\s+WHERE "flito_compradores"\\."tramite_id" = "flito_tramites"\\."id" ORDER BY "flito_compradores"\\."id" LIMIT 1\\)`));
    }
    expect(renderizar(SELECT_FILA.titularCorreo).sql).toContain('"flito_compradores"."correo"');
    expect(renderizar(SELECT_FILA.titularTelefono).sql).toContain('"flito_compradores"."celular"');
    expect(renderizar(SELECT_FILA.titularDireccion).sql).toContain('"flito_compradores"."direccion"');
    expect(SQL_JOINS().sql).not.toMatch(/join "flito_compradores"/i);
    // Y la fila los expone normalizados: «␠» y '' son null, como el documento.
    const f = await filaDe({ titularDireccion: ' ' });
    expect(f.titularCorreo).toBe('ana@correo.co');
    expect(f.titularTelefono).toBe('3001234567');
    expect(f.titularDireccion).toBeNull();
    expect(celda(f, 'correo')).toBe('ana@correo.co');
    expect(celda(f, 'telefono')).toBe('3001234567');
    expect(celda(f, 'direccion')).toBeNull();
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
  it('apellidos «␠» → null en la fila y celda VACÍA (null) en el archivo; el nombre completo no arrastra el espacio', async () => {
    const f = await filaDe({ titularApellidosFlit: ' ' });
    expect(f.titularApellidos).toBeNull();
    expect(f.titularTipoDocumento).toBe('CC');
    // Mutante «'' en vez de null»: Excel escribiría una celda con cadena vacía.
    expect(celda(f, 'apellidos')).toBeNull();
    expect(celda(f, 'nombreCompleto')).toBe('ANA MARÍA');
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
    expect(celda(f, 'ot')).toBe('Envigado');
  });

  it('sin alias configurado sale la ciudad del catálogo compartido', async () => {
    const f = await filaDe({ organismoAlias: null });
    expect(f.organismoNombre).toBe('Envigado');
  });

  it('organismo_codigo null → código y nombre null, celda «OT» vacía; no se inventa uno', async () => {
    const f = await filaDe({ organismoCodigo: null, organismoAlias: null });
    expect(f.organismoCodigo).toBeNull();
    expect(f.organismoNombre).toBeNull();
    expect(celda(f, 'ot')).toBeNull();
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

  it('filtrosDe() lo entrega a /reporte-costos y /facturacion-electronica; el POST /export lo recibe del cuerpo (espías)', async () => {
    const app = await buildApp();
    reporteCostosMock.mockResolvedValueOnce({ items: [], total: 0, page: 1, pageSize: 50 } as never);
    filasParaExportarMock.mockResolvedValueOnce([]);
    resumenFeMock.mockResolvedValueOnce({ total: 0 } as never);
    const q = '?organismos=05266,%2005001&empresas=811011779';

    expect((await request(app).get(`/api/finanzas/reporte-costos${q}`).set('Authorization', await auth())).status).toBe(200);
    // HU #12531: el export es POST con arrays en el cuerpo (no hay GET).
    expect((await request(app).post('/api/finanzas/reporte-costos/export').set('Authorization', await authExport())
      .send({ organismos: ['05266', '05001'], empresas: ['811011779'] })).status).toBe(200);
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
  it('2026-09-14T15:30Z → 2026-09 / 2026-T3, y el archivo los pone en «Filtromes» y «Mes/Trimestre» como texto (HU #12536)', async () => {
    expect(periodoDe('2026-09-14T15:30:00.000Z')).toEqual({ mes: '2026-09', trimestre: '2026-T3' });
    const f = await filaDe();
    expect(f.mes).toBe('2026-09');
    expect(f.trimestre).toBe('2026-T3');
    // Mutante «Filtromes con el trimestre» / «Mes/Trimestre con el mes»: se cruzarían.
    expect(celda(f, 'filtromes')).toBe('2026-09');
    expect(celda(f, 'mesTrimestre')).toBe('2026-T3');
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
    expect(celda(f, 'filtromes')).toBeNull();
    expect(celda(f, 'mesTrimestre')).toBeNull();
    expect(celda(f, 'fechaAprobacion')).toBeNull();
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
    serviciosAdicionales: null as number | null,
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

  it('los servicios adicionales entran en el SERVICIO, no en el reintegro (HU #12546)', async () => {
    // Mutante «servicios dentro del reintegro»: reintegro 753460 y servicio 200000.
    // Mutante «subtotalesDe se queda con el trámite digital»: servicio 200000 y la identidad de
    // abajo (reintegro + servicio = total) se rompe en toda fila con servicios.
    expect(subtotalesDe({ ...completa, serviciosAdicionales: 85000 }))
      .toEqual({ totalReintegro: 668460, totalServicio: 285000 });

    // Y de punta a punta: la fila trae el total CON servicios (base 950.000 + 3.800 de gravamen).
    const f = await filaDe({ serviciosAdicionales: '85000', serviciosAdicionalesCantidad: 2, gmf: '3800', totalFila: '953800' });
    expect(f.serviciosAdicionales).toBe(85000);
    expect(f.serviciosAdicionalesCantidad).toBe(2);
    expect(f.totalServicio).toBe(285000);
    expect(f.totalReintegro).toBe(668800);
    expect(Math.round((f.totalReintegro! + f.totalServicio!) * 100) / 100).toBe(f.total);
  });

  it('un servicio adicional NUNCA deja el servicio en null: no hay tarifa que configurar ni recibo que esperar', () => {
    // Solo el trámite digital pendiente anula el subtotal; los servicios son su propio valor.
    expect(subtotalesDe({ ...completa, tramiteDigital: null, serviciosAdicionales: 85000, noConfigurados: ['Trámite digital'] }).totalServicio).toBeNull();
    expect(subtotalesDe({ ...completa, serviciosAdicionales: 0 }).totalServicio).toBe(200000);
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

// ────────────── HU #12546 — la expresión de servicios adicionales ──────────────

describe('HU #12546 — `serviciosAdicionales` en el SQL del reporte (AC5, AC6)', () => {
  const SQL_SERVICIOS = () => renderizar(SELECT_FILA.serviciosAdicionales);
  const SQL_CANTIDAD = () => renderizar(SELECT_FILA.serviciosAdicionalesCantidad);

  it('sellada manda: la columna `valor_servicios_adicionales`; sin sellar, la SUMA de la puente', () => {
    const { sql } = SQL_SERVICIOS();
    // Mutante «COALESCE(sellado, estimado)»: en una sellada, NULL significa «no aplica» y el
    // COALESCE resucitaría servicios que se decidió no cobrar.
    expect(sql).toContain('CASE WHEN "flito_liquidaciones"."id" IS NOT NULL THEN "flito_liquidaciones"."valor_servicios_adicionales"');
    expect(sql).not.toContain('COALESCE("flito_liquidaciones"."valor_servicios_adicionales"');
    expect(sql).toContain('SELECT SUM("flito_tramite_servicios_adicionales"."valor")');
  });

  it('es una SUBCONSULTA CORRELACIONADA, no un join: la fila del trámite no se multiplica', () => {
    // Un `leftJoin` en `conJoins` multiplicaría la fila por cada servicio del trámite, y con ella el
    // dinero de los totales, el `count(distinct)` de la paginación y el Excel. Y en el consolidado,
    // que agrupa, la expresión tendría que entrar en el GROUP BY → 42803 en toda llamada.
    expect(SQL_SERVICIOS().sql).toContain('"flito_tramite_servicios_adicionales"."tramite_id" = "flito_tramites"."id"');
    expect(SQL_JOINS().sql).not.toContain('flito_tramite_servicios_adicionales');
  });

  it('la expresión NO liga ni un parámetro: los literales van como texto del template', () => {
    // Drizzle no deduplica literales: el mismo literal interpolado dos veces son DOS parámetros, y
    // en el GROUP BY del consolidado eso es un 42803 (Bug #12058). La forma de que no pueda pasar es
    // que la expresión no tenga parámetros en absoluto.
    expect(SQL_SERVICIOS().params).toEqual([]);
    expect(SQL_CANTIDAD().params).toEqual([]);
    expect(renderizar(SELECT_TOTALES.serviciosAdicionales).params).toEqual([]);
    expect(renderizar(SELECT_TOTALES.totalServicio).params).toEqual([]);
  });

  it('la CANTIDAD sale del array del detalle en lo sellado y de la puente en lo estimado', () => {
    const { sql } = SQL_CANTIDAD();
    expect(sql).toContain("jsonb_array_length(\"flito_liquidaciones\".\"detalle\" -> 'serviciosAdicionales' -> 'items')");
    // La guarda de tipo no es adorno: `jsonb_array_length` de un escalar lanza 22023 y tumbaría el
    // reporte entero, no una celda.
    expect(sql).toContain("jsonb_typeof(\"flito_liquidaciones\".\"detalle\" -> 'serviciosAdicionales' -> 'items') = 'array'");
    expect(sql).toContain('SELECT COUNT(*)::int FROM "flito_tramite_servicios_adicionales"');
  });

  it('la base del GMF y el total incluyen los servicios con COALESCE(…, 0) (AC5)', () => {
    const total = renderizar(SELECT_FILA.totalFila).sql;
    const gmf = renderizar(SELECT_FILA.gmf).sql;
    // Mutante «servicios fuera de la base»: el gravamen del estimado no crecería con ellos y el
    // total estimado dejaría de coincidir con el que sella `calcular()`.
    expect(total).toContain('COALESCE(CASE WHEN "flito_liquidaciones"."id" IS NOT NULL THEN "flito_liquidaciones"."valor_servicios_adicionales"');
    expect(gmf).toContain('"valor_servicios_adicionales"');
  });

  it('el reintegro NO suma los servicios: solo los ve a través del GMF de la fila estimada', () => {
    // Un servicio adicional es un HONORARIO de FLIT, no un desembolso que se reintegre; va en
    // `totalServicio`. Lo que sí crece es el gravamen —el 4x1000 se cobra sobre el total—, y por eso
    // la expresión aparece UNA vez en el reintegro: dentro del `ROUND(base × tasa)` del GMF
    // estimado. Mutante «servicios como sexto sumando del reintegro»: aparecería dos veces, y
    // `totalReintegro + totalServicio` pasaría a sumar más que el total.
    const reintegro = renderizar(SELECT_TOTALES.totalReintegro).sql;
    expect(reintegro.match(/valor_servicios_adicionales/g)).toHaveLength(1);
    const [antes] = reintegro.split('valor_servicios_adicionales');
    expect(antes).toContain('ROUND(');
  });

  it('`totalServicio` suma trámite digital Y servicios adicionales, con COALESCE por término (AC6)', () => {
    const servicio = renderizar(SELECT_TOTALES.totalServicio).sql;
    // Mutante «se queda con el trámite digital»: no contendría la puente, y reintegro + servicio
    // dejaría de dar el total en toda fila con servicios.
    expect(servicio).toContain('"flito_liquidaciones"."valor_tramite_digital"');
    expect(servicio).toContain('"flito_tramite_servicios_adicionales"."valor"');
    expect(servicio).toContain('COALESCE(');
    expect(servicio).not.toContain('"lg"."valor"');
  });

  it('`filasIncompletas` NO cambia: un servicio adicional nunca deja la fila incompleta (AC5)', () => {
    // No hay tarifa que configurar ni recibo que esperar: lo asignado ES su valor.
    expect(renderizar(SELECT_TOTALES.filasIncompletas).sql).not.toContain('flito_tramite_servicios_adicionales');
  });
});

// ───────────────────────────── AC10 — el archivo ─────────────────────────────

describe('AC10 — el archivo con las 32 columnas literales del Excel de Financiero (HU #12536; .xlsx desde la HU #12531; «Servicios adicionales» desde la #12546)', () => {
  // Las 32 cabeceras tal cual las tiene Financiero: «cliente» en minúscula, «Tramite» sin tilde, «Vin».
  // «Servicios adicionales» va inmediatamente después de «Modelo» (CF-10 de la HU #12546).
  const CABECERA = 'cliente;Mes/Trimestre;FLIT;Placa;Tipo;CC-NIT;Nombres;Apellidos;Nombre completo;Modelo;Servicios adicionales;Estado;Correo;OT;Tipo Trámite;Teléfono/Celular;Dirección;SOAT;Trámite;Impuesto;Columna1;Columna2;GMF;Total Reintegro;Servicio;Factura;Factura Terceros;Vin;Placa2;Tramite;fecha_aprobacion;Filtromes';

  it('las 32 cabeceras son exactamente las literales y en ese orden (como un solo array, no «contiene»)', () => {
    // Mutante «cabecera 'Cliente' con mayúscula», «Vin como VIN», «Tramite con tilde»: el `toEqual` cae.
    expect(COLUMNAS_EXPORT_DETALLE.map((c) => c.header)).toEqual(CABECERA.split(';'));
    expect(COLUMNAS_EXPORT_DETALLE).toHaveLength(32);
    // Cada clave es única: dos columnas con la misma clave se pisarían en `addRow` (Placa/Placa2, Tipo Trámite/Tramite).
    expect(new Set(COLUMNAS_EXPORT_DETALLE.map((c) => c.key)).size).toBe(32);
    // Y va PEGADA a «Modelo», no al final: el archivo se pega sobre el de Financiero (CF-10).
    const cabeceras = COLUMNAS_EXPORT_DETALLE.map((c) => c.header);
    expect(cabeceras[cabeceras.indexOf('Modelo') + 1]).toBe('Servicios adicionales');
  });

  it('cada celda por su CLAVE, con su tipo: texto, número y Date de día', async () => {
    const f = await filaDe({
      facturaDatos: { numero: 'FV-1-123', requiereRevision: false }, estadoFacturacion: 'emitido',
      sellada: true, estadoLiquidacion: 'facturado',
    });
    const fila = filasExcelDetalle([f])[0]!;
    // Mutante «Modelo ← marca» (CHEVROLET), «Placa2 ← vin» (VIN1), «Tramite ← tipo de documento» (CC),
    // «Columna1 ← tramiteDigital» (200000), «Filtromes con el trimestre» (2026-T3): el `toEqual` cae.
    expect(fila).toEqual({
      cliente: 'ACME', mesTrimestre: '2026-T3', flit: 'FLIT-1', placa: 'ABC123', tipo: 'CC', ccNit: '1020304050',
      nombres: 'ANA MARÍA', apellidos: 'PÉREZ', nombreCompleto: 'ANA MARÍA PÉREZ', modelo: 'ONIX',
      // Sin servicios la celda va VACÍA (`null`), no en cero: un 0 diría «se le cobraron $0».
      serviciosAdicionales: null,
      estado: 'Aprobado', correo: 'ana@correo.co', ot: 'Envigado', tipoTramite: 'Traspaso',
      telefono: '3001234567', direccion: 'CL 10 # 20-30',
      soat: 450000, tramite: 80000, impuesto: 120000, columna1: 15000, columna2: null, gmf: 3460,
      totalReintegro: 668460, servicio: 200000, factura: 'FV-1-123', facturaTerceros: null,
      vin: 'VIN1', placa2: 'ABC123', tramiteCategoria: 'Traspaso',
      fechaAprobacion: new Date('2026-09-14T00:00:00.000Z'), filtromes: '2026-09',
    });
    // Mutante «String(soat)»: el `toEqual` de arriba ya cae; esto deja el tipo explícito.
    expect(typeof fila.soat).toBe('number');
    // Mutante «Number(titularDocumento)»: el documento es texto, con sus ceros a la izquierda.
    expect(typeof fila.ccNit).toBe('string');
    // Mutante «fecha_aprobacion como texto ISO».
    expect(fila.fechaAprobacion).toBeInstanceOf(Date);
    // Y todas las claves de la fila existen en las columnas, y viceversa.
    expect(Object.keys(fila).sort()).toEqual(COLUMNAS_EXPORT_DETALLE.map((c) => c.key).sort());
  });

  it('«Tipo» es el documento del titular y «Trámite» los pesos del derecho; «FLIT» el identificador; la razón social va en Nombre completo', async () => {
    const f = await filaDe({ titularTipoFlit: 'n', titularNombresFlit: 'ABC SAS', derechoTramite: '81000' });
    expect(celda(f, 'tipo')).toBe('NIT');
    expect(celda(f, 'tipoTramite')).toBe('Traspaso');
    // Mutante «Tramite ← derechoTramite»: la categoría duplicada sería un número.
    expect(celda(f, 'tramiteCategoria')).toBe('Traspaso');
    expect(celda(f, 'tramite')).toBe(81000);
    expect(celda(f, 'flit')).toBe('FLIT-1');
    // HU #12536: «Razón social» ya no es columna; la jurídica se lee en Nombre completo con Nombres vacío.
    expect(celda(f, 'nombreCompleto')).toBe('ABC SAS');
    expect(celda(f, 'nombres')).toBeNull();
    expect(COLUMNAS_EXPORT_DETALLE.map((c) => c.key)).not.toContain('razonSocial');
  });

  it('un texto con «;» o comillas va tal cual: en xlsx no hay separador que escapar', async () => {
    const f = await filaDe({ empresa: 'GÓMEZ; HIJOS', placa: 'A"B' });
    expect(celda(f, 'cliente')).toBe('GÓMEZ; HIJOS');
    expect(celda(f, 'placa')).toBe('A"B');
  });
});

// ───────────────────────────── AC11 — Habeas Data ─────────────────────────────

describe('AC11 — el acceso al titular queda registrado (Ley 1581)', () => {
  // HU #12531: el contacto del primer comprador también sale, y se declara.
  const CAMPOS = [
    'nombres', 'apellidos', 'razon_social', 'numero_documento', 'tipo_documento', 'placa', 'vin',
    'correo', 'celular', 'direccion',
  ];

  it('POST /export registra accion «export» con los diez campos', async () => {
    const app = await buildApp();
    kdb.when.select('flito_tramites', [cruda()]);
    const r = await request(app).post('/api/finanzas/reporte-costos/export').set('Authorization', await authExport())
      .responseType('blob').send({});
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('spreadsheetml');

    // Mutante «se quita la llamada en export»: cero llamadas.
    expect(logPiiMock).toHaveBeenCalledTimes(1);
    const [, opts] = logPiiMock.mock.calls[0];
    expect(opts).toMatchObject({ resourceTipo: 'finanzas_reporte_costos', accion: 'export' });
    expect([...opts.camposAccedidos].sort()).toEqual([...CAMPOS].sort());
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
    const r = await request(app).post('/api/finanzas/reporte-costos/export').set('Authorization', await authExport())
      .responseType('blob').send({});
    expect(r.status).toBe(200);
    expect(kdb.insert).toHaveBeenCalled();
    expect(r.headers['content-type']).toContain('spreadsheetml');
    expect((r.body as Buffer).length).toBeGreaterThan(0);
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
  it('todas las rutas /reporte-costos* siguen bajo requireRole(financiera, admin, auditor)', async () => {
    const { readFileSync } = await import('node:fs');
    const fuente = readFileSync(new URL('../../src/modules/finanzas/finanzas.routes.js', import.meta.url).pathname.replace(/\.js$/, '.ts'), 'utf8');
    expect(fuente).toContain("const LECTURA = requireRole('financiera', 'admin', 'auditor');");
    expect(fuente).not.toContain('exigirFuncion');
    // No se congela el número (la HU #12433 sumó el consolidado y la #12531 pasó los exports a POST
    // bajo la MISMA guarda): lo que se afirma es que ninguna ruta del reporte —GET o POST— se
    // registra con otra guarda o sin ella.
    const rutas = fuente.match(/router\.(get|post)\('\/reporte-costos[^']*',/g) ?? [];
    const bajoLectura = fuente.match(/router\.(get|post)\('\/reporte-costos[^']*', LECTURA,/g) ?? [];
    expect(rutas.length).toBeGreaterThanOrEqual(6);
    expect(bajoLectura).toHaveLength(rutas.length);
    expect(fuente.match(/requireRole\(/g)).toHaveLength(1);
  });
});
