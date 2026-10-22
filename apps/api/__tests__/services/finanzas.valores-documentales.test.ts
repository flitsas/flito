// HU #12653 (Feature #12607, Épica #12245) — el valor documental en el reporte de costos: origen y
// diferencia por concepto, filtro «Con diferencias».
//
// Todo aserto de SQL va contra el SQL RENDERIZADO en el contexto real del reporte (`conJoins`): el
// mock `chain` inventa columnas y `orderBy` es passthrough, así que un mock no prueba ni orden ni
// forma. Los valores de los AC (85.000 / 155.000 / 175.000 / 50.000) se afirman en dos mitades: la
// FORMA de la expresión que los produce (COALESCE documental-primero, Σ viajes fuera) y el paso de la
// fila cruda al DTO por la ruta real.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { QueryBuilder, type PgSelect } from 'drizzle-orm/pg-core';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';
import { testToken } from '../helpers/auth.js';

const kdb = createKeyedDb();
const espia = crearEspia(kdb);
vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: vi.fn().mockResolvedValue(undefined) }));

const servicio = await import('../../src/modules/finanzas/finanzas.service.js');
const {
  EXPR_DIGITAL, EXPR_LOGISTICA, EXPR_LOGISTICA_ESTIMADA, EXPR_SERVICIOS_ADICIONALES, EXPR_INCOMPLETA,
  SELECT_FILA, SELECT_TOTALES, condiciones, conJoins,
} = servicio;
const {
  EXPR_CON_DIFERENCIAS, SELECT_VALORES_DOCUMENTALES, valoresDocumentalesDeFila,
} = await import('../../src/modules/finanzas/finanzas.valores-documentales.js');
const { ensamblarConsolidado, selectConsolidado } = await import('../../src/modules/finanzas/finanzas.consolidado.js');
const { EXPR_DOC_TD, EXPR_DOC_LG } = await import('../../src/modules/flito-comprobantes/flito-comprobantes.expr.js');
const { flitoTramites } = await import('../../src/db/schema.js');
const { and } = await import('drizzle-orm');
const { renderizar, gruposHuerfanos } = await import('../helpers/sql-ligado.js');

beforeEach(() => { kdb.reset(); espia.reiniciar(); });

// ── Utilidades ──────────────────────────────────────────────────────────────

const abrir = (campos: Record<string, unknown>) =>
  new QueryBuilder().select(campos as never).from(flitoTramites).$dynamic() as PgSelect;

/** Una expresión renderizada EN EL CONTEXTO del reporte (con `conJoins`), sin el `select ` ni el `from`. */
const enReporte = (expr: unknown): string =>
  conJoins(abrir({ x: expr })).toSQL().sql.replace(/^select /, '').split(' from "flito_tramites"')[0]!;

const DOC_TD = renderizar(EXPR_DOC_TD).sql;
const DOC_LG = renderizar(EXPR_DOC_LG).sql;
const SUMA_VIAJES = 'COALESCE((SELECT SUM("flito_tramite_viajes_logistica"."valor") FROM "flito_tramite_viajes_logistica" WHERE "flito_tramite_viajes_logistica"."tramite_id" = "flito_tramites"."id"), 0)';
const NO_GESTIONA = 'WHEN NOT (NOT COALESCE("clients"."logistica_autogestionable", false) OR ("flito_excepciones_autogestion"."id" IS NOT NULL)) THEN NULL';

/** Un `sub` distinto por llamada en las exportaciones: el limitador de exportación es por usuario. */
const auth = async (sub = 3) => `Bearer ${await testToken({ sub, username: 'financiera@flit.io', role: 'financiera' })}`;

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/finanzas/finanzas.routes.js');
  app.use('/api/finanzas', router);
  return app;
}

const ID_TD = '11111111-1111-4111-8111-111111111111';
const ID_LG = '22222222-2222-4222-8222-222222222222';
const ID_SA = '33333333-3333-4333-8333-333333333333';

/** La fila CRUDA como la proyecta `SELECT_FILA` (valores ya resueltos por el COALESCE en SQL). */
function filaCruda(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tramiteId: 'aaaa1111-2222-4333-8444-555566667777', idFlit: 'FLIT-1',
    placa: 'ABC123', estado: 'Aprobado', empresa: 'ACME', tipoTramite: 'Traspaso',
    vin: 'VIN1', marca: 'RENAULT', linea: 'LOGAN',
    fechaAprobacion: new Date('2026-07-14T15:30:00.000Z'), fechaCreacion: new Date('2026-07-01T00:00:00.000Z'),
    sellada: false, estadoLiquidacion: null,
    soat: '450000.00', impuesto: null, derechoTramite: '80000.00',
    tramiteDigital: '80000.00', logistica: '120000.00', gmf: '2920.00', totalFila: '732920.00',
    serviciosAdicionales: null, serviciosAdicionalesCantidad: 0, logisticaViajesCantidad: 1,
    soatPendiente: false, impuestoPendiente: false,
    gestionaSoat: true, gestionaImpuesto: false, gestionaLogistica: true,
    soatAutogestionable: false, impuestosAutogestionable: false, logisticaAutogestionable: false,
    estadoFacturacion: 'no_enviado', facturaDatos: null, boletaReferencia: null, boletaConciliadaEn: null,
    // Sin comprobantes: las 29 columnas documentales en NULL y el origen 'tarifa' (lo que da el CASE).
    origenTd: 'tarifa', origenLg: 'tarifa',
    ...Object.fromEntries(['td', 'lg', 'sa'].flatMap((p) => [
      'ComprobanteId', 'ComprobanteNumero', 'ComprobanteFecha', 'TarifaReferencia', 'Diferencia',
      'AceptadaPorId', 'AceptadaEn', 'AceptadaMotivo', 'AceptadaPorNombre',
    ].map((k) => [`${p}${k}`, null]))),
    saAceptada: null,
    ...over,
  };
}

/** Las columnas crudas de un comprobante aplicado de un concepto, con prefijo. */
const documental = (p: 'td' | 'lg' | 'sa', id: string, tarifa: string | null, diferencia: string, aceptada = false) => ({
  [`${p}ComprobanteId`]: id, [`${p}ComprobanteNumero`]: `REC-${p.toUpperCase()}-9`, [`${p}ComprobanteFecha`]: '2026-07-10',
  [`${p}TarifaReferencia`]: tarifa, [`${p}Diferencia`]: diferencia,
  [`${p}AceptadaPorId`]: aceptada ? 7 : null,
  [`${p}AceptadaEn`]: aceptada ? new Date('2026-07-12T10:00:00.000Z') : null,
  [`${p}AceptadaMotivo`]: aceptada ? 'Pactado con el cliente' : null,
  [`${p}AceptadaPorNombre`]: aceptada ? 'contadora' : null,
  // Bug #12913: en SA la aceptación de la celda es `saAceptada` (todas las marcadas aceptadas).
  ...(p === 'sa' ? { saAceptada: aceptada } : {}),
});

async function filaServida(cruda: Record<string, unknown>, query = '') {
  kdb.when.select('flito_tramites', [cruda]);
  const app = await buildApp();
  const r = await request(app).get(`/api/finanzas/reporte-costos${query}`).set('Authorization', await auth());
  expect(r.status).toBe(200);
  return r.body.items[0] as Record<string, any>;
}

// ── AC1 — Trámite digital: el documental manda (tolerancia 0) ───────────────

describe('AC1 — trámite digital: el documental manda sobre la tarifa (mutante 4)', () => {
  it('EXPR_DIGITAL renderiza ELSE COALESCE(documental, "td"."valor") — el documental PRIMERO', () => {
    expect(enReporte(EXPR_DIGITAL)).toBe(
      `CASE WHEN "flito_liquidaciones"."id" IS NOT NULL THEN "flito_liquidaciones"."valor_tramite_digital"
  ELSE COALESCE(${DOC_TD}, "td"."valor") END`,
    );
    expect(DOC_TD).toContain("\"flito_comprobantes\".\"concepto\" = 'tramite_digital'");
    expect(DOC_TD).toContain("\"flito_comprobantes\".\"estado\" = 'aplicado' and \"flito_comprobantes\".\"es_pago\" = true limit 1)");
  });

  it('SELECT_FILA.tramiteDigital, SELECT_TOTALES.tramiteDigital y el consolidado usan ESA expresión (85.000 en la celda, el total y el consolidado)', () => {
    const celda = enReporte(SELECT_FILA.tramiteDigital);
    expect(celda).toBe(enReporte(EXPR_DIGITAL));
    expect(enReporte(SELECT_TOTALES.tramiteDigital)).toBe(`COALESCE(SUM(${celda}), 0)`);
    const consolidado = ensamblarConsolidado(abrir(selectConsolidado('mes')), {}, 'mes').toSQL().sql;
    expect(consolidado).toContain(`COALESCE(SUM(${celda}), 0)`);
  });

  it('con comprobante aplicado ($85.000 sobre tarifa $80.000): 85.000, origen documental y la diferencia de 5.000 sin aceptar', async () => {
    const fila = await filaServida(filaCruda({
      tramiteDigital: '85000.00', origenTd: 'documental', ...documental('td', ID_TD, '80000.00', '5000.00'),
    }));
    expect(fila.tramiteDigital).toBe(85000);
    expect(fila.origenes).toEqual({ tramiteDigital: 'documental', logistica: 'tarifa' });
    expect(fila.valorDocumental.tramiteDigital).toEqual({
      comprobanteId: ID_TD, numero: 'REC-TD-9', fecha: '2026-07-10', tarifaReferencia: 80000, diferencia: 5000,
      aceptada: false, aceptadaPorNombre: null, aceptadaEn: null, aceptadaMotivo: null,
    });
    expect(fila.valorDocumental.logistica).toBeNull();
    expect(fila.valorDocumental.serviciosAdicionales).toBeNull();
    expect(fila.noConfigurados).toEqual([]);
  });

  it('sin comprobante: la tarifa (80.000), origen tarifa y valorDocumental.tramiteDigital = null', async () => {
    const fila = await filaServida(filaCruda());
    expect(fila.tramiteDigital).toBe(80000);
    expect(fila.origenes.tramiteDigital).toBe('tarifa');
    expect(fila.valorDocumental.tramiteDigital).toBeNull();
  });

  it('tarifa NO configurada + comprobante aplicado: BLOQUEA_DIGITAL usa el COALESCE (la fila no está incompleta) y la diferencia es el valor entero', async () => {
    // Forma: EXPR_INCOMPLETA bloquea por `COALESCE(documental, td.valor) IS NULL`, no por `td.valor IS NULL`.
    const incompleta = enReporte(EXPR_INCOMPLETA);
    expect(incompleta).toContain(`OR COALESCE(${DOC_TD}, "td"."valor") IS NULL`);
    expect(incompleta).not.toMatch(/OR "td"\."valor" IS NULL/);
    // Y la logística, el mismo COALESCE dentro de GESTIONA_LOGISTICA.
    expect(incompleta).toContain(`AND COALESCE(${DOC_LG}, "lg"."valor") IS NULL)`);
    expect(incompleta).not.toMatch(/AND "lg"\."valor" IS NULL/);

    const fila = await filaServida(filaCruda({
      tramiteDigital: '85000.00', origenTd: 'documental', ...documental('td', ID_TD, null, '85000.00'),
    }));
    expect(fila.tramiteDigital).toBe(85000);
    expect(fila.noConfigurados).toEqual([]);
    expect(fila.valorDocumental.tramiteDigital.tarifaReferencia).toBeNull();
    expect(fila.valorDocumental.tramiteDigital.diferencia).toBe(85000);
  });
});

// ── AC2 — Logística: el documental reemplaza SOLO el viaje 1 ────────────────

describe('AC2 — logística: COALESCE solo en el viaje 1, Σ viajes adicionales fuera', () => {
  const RAMA_ESTIMADA = `${NO_GESTIONA}
  ELSE COALESCE(${DOC_LG}, "lg"."valor") + ${SUMA_VIAJES} END`;

  it('EXPR_LOGISTICA: sellada manda; si no, WHEN NOT gestiona THEN NULL ELSE COALESCE(doc, lg.valor) + Σ viajes', () => {
    expect(enReporte(EXPR_LOGISTICA)).toBe(
      `CASE WHEN "flito_liquidaciones"."id" IS NOT NULL THEN "flito_liquidaciones"."valor_logistica"
  ${RAMA_ESTIMADA}`,
    );
    // Mutante «COALESCE(documental, tarifa + Σ viajes)»: el COALESCE envolvería la suma entera.
    expect(enReporte(EXPR_LOGISTICA)).not.toContain(`"lg"."valor" + ${SUMA_VIAJES})`);
  });

  it('EXPR_LOGISTICA_ESTIMADA (gastos diarios) es la MISMA rama, byte a byte', () => {
    expect(enReporte(EXPR_LOGISTICA_ESTIMADA)).toBe(`CASE ${RAMA_ESTIMADA}`);
    expect(enReporte(EXPR_LOGISTICA)).toContain(RAMA_ESTIMADA);
  });

  it('documental $100.000 + viajes de $30.000 y $25.000 = 155.000, origen documental, diferencia −20.000, 3 viajes', async () => {
    const fila = await filaServida(filaCruda({
      logistica: '155000.00', logisticaViajesCantidad: 3, origenLg: 'documental',
      ...documental('lg', ID_LG, '120000.00', '-20000.00'),
    }));
    expect(fila.logistica).toBe(155000);
    expect(fila.logisticaViajesCantidad).toBe(3);
    expect(fila.origenes.logistica).toBe('documental');
    expect(fila.valorDocumental.logistica).toMatchObject({ comprobanteId: ID_LG, tarifaReferencia: 120000, diferencia: -20000, aceptada: false });
  });

  it('sin comprobante: tarifa + viajes = 175.000 y origen tarifa', async () => {
    const fila = await filaServida(filaCruda({ logistica: '175000.00', logisticaViajesCantidad: 3 }));
    expect(fila.logistica).toBe(175000);
    expect(fila.origenes.logistica).toBe('tarifa');
    expect(fila.valorDocumental.logistica).toBeNull();
  });
});

// ── AC3 — Autogestión (mutante 9) ───────────────────────────────────────────

describe('AC3 — la logística autogestionada sigue en blanco aunque exista comprobante (mutante 9)', () => {
  it('el WHEN NOT GESTIONA_LOGISTICA THEN NULL va ANTES del ELSE COALESCE(…) en la rama estimada', () => {
    const sql = enReporte(EXPR_LOGISTICA_ESTIMADA);
    const iNull = sql.indexOf(NO_GESTIONA);
    const iCoalesce = sql.indexOf(`ELSE COALESCE(${DOC_LG}`);
    expect(iNull).toBeGreaterThan(-1);
    expect(iCoalesce).toBeGreaterThan(iNull);
    // Y el COALESCE del documental NO aparece fuera de esa rama (p. ej. envolviendo el CASE entero).
    expect(sql.startsWith('CASE WHEN NOT')).toBe(true);
    expect(sql.match(/COALESCE\(\(select "flito_comprobantes"."valor"/g)).toHaveLength(1);
  });

  it('autogestionada SIN excepción + comprobante aplicado: logistica = null, origen null, «Logística» en autogestionados y no en noConfigurados; el soporte sigue viajando', async () => {
    const fila = await filaServida(filaCruda({
      logistica: null, logisticaViajesCantidad: 0, gestionaLogistica: false, logisticaAutogestionable: true,
      origenLg: 'tarifa', ...documental('lg', ID_LG, null, '100000.00'),
    }));
    expect(fila.logistica).toBeNull();
    expect(fila.origenes.logistica).toBeNull();
    expect(fila.autogestionados).toContain('Logística');
    expect(fila.noConfigurados).not.toContain('Logística');
    expect(fila.valorDocumental.logistica).toMatchObject({ comprobanteId: ID_LG, diferencia: 100000 });
  });

  it('CON excepción vigente: documental + Σ viajes y origen documental', async () => {
    const fila = await filaServida(filaCruda({
      logistica: '130000.00', logisticaViajesCantidad: 2, gestionaLogistica: true, logisticaAutogestionable: true,
      origenLg: 'documental', ...documental('lg', ID_LG, '120000.00', '-20000.00'),
    }));
    expect(fila.logistica).toBe(130000);
    expect(fila.origenes.logistica).toBe('documental');
    expect(fila.autogestionados).not.toContain('Logística');
  });
});

// ── AC4 — Servicios adicionales: el catálogo manda (mutante 10) ─────────────

describe('AC4 — servicios adicionales: el catálogo manda; el comprobante solo marca (mutante 10)', () => {
  it('EXPR_SERVICIOS_ADICIONALES es byte a byte la de hoy: sin subconsulta a flito_comprobantes', () => {
    expect(enReporte(EXPR_SERVICIOS_ADICIONALES)).toBe(
      `CASE WHEN "flito_liquidaciones"."id" IS NOT NULL THEN "flito_liquidaciones"."valor_servicios_adicionales"
  ELSE (SELECT SUM("flito_tramite_servicios_adicionales"."valor") FROM "flito_tramite_servicios_adicionales" WHERE "flito_tramite_servicios_adicionales"."tramite_id" = "flito_tramites"."id") END`,
    );
    expect(enReporte(SELECT_FILA.serviciosAdicionales)).not.toContain('flito_comprobantes');
    expect(enReporte(SELECT_TOTALES.serviciosAdicionales)).not.toContain('flito_comprobantes');
  });

  it('no existe EXPR_DOC_SA en finanzas/ ni en el leaf', () => {
    const raiz = resolve(import.meta.dirname, '../../src/modules');
    for (const f of readdirSync(resolve(raiz, 'finanzas'))) {
      expect(readFileSync(resolve(raiz, 'finanzas', f), 'utf8'), f).not.toContain('EXPR_DOC_SA');
    }
    expect(readFileSync(resolve(raiz, 'flito-comprobantes/flito-comprobantes.expr.ts'), 'utf8')).not.toContain('EXPR_DOC_SA');
  });

  it('Σ catálogo 50.000 con comprobante de 55.000: serviciosAdicionales = 50.000, sin clave de origen, y la diferencia de 5.000 en valorDocumental', async () => {
    const fila = await filaServida(filaCruda({
      serviciosAdicionales: '50000.00', serviciosAdicionalesCantidad: 2,
      ...documental('sa', ID_SA, '50000.00', '5000.00'),
    }));
    expect(fila.serviciosAdicionales).toBe(50000);
    expect(fila.serviciosAdicionalesCantidad).toBe(2);
    expect(Object.keys(fila.origenes).sort()).toEqual(['logistica', 'tramiteDigital']);
    expect(fila.valorDocumental.serviciosAdicionales).toMatchObject({ comprobanteId: ID_SA, tarifaReferencia: 50000, diferencia: 5000, aceptada: false });
  });
});

// ── AC5 — Filtro «Con diferencias» ──────────────────────────────────────────

describe('AC5 — conDiferencias: EXISTS sin parámetros, compuesto con los demás filtros, en las tres rutas', () => {
  const EXISTS = `EXISTS (SELECT 1 FROM "flito_comprobantes"
  WHERE "flito_comprobantes"."tramite_id" = "flito_tramites"."id"
    AND "flito_comprobantes"."estado" = 'aplicado' AND "flito_comprobantes"."es_pago" = true
    AND "flito_comprobantes"."marcado_por_diferencia" = true
    AND "flito_comprobantes"."diferencia_aceptada_por_id" IS NULL)`;

  it('EXPR_CON_DIFERENCIAS renderiza el EXISTS con marcado_por_diferencia = true AND diferencia_aceptada_por_id IS NULL, sin parámetros', () => {
    const q = renderizar(EXPR_CON_DIFERENCIAS);
    expect(q.sql).toBe(EXISTS);
    expect(q.params).toEqual([]);
  });

  it('condiciones({ conDiferencias: true }) lo añade y se compone con etapa, fechas y empresas; ausente o false no lo añade', () => {
    const solo = condiciones({ conDiferencias: true });
    expect(solo.map((c) => renderizar(c).sql)).toEqual([EXISTS]);

    const compuesto = renderizar(and(...condiciones({
      conDiferencias: true, etapa: 'listo', empresas: ['811011779'], aprobadoDesde: '2026-07-01',
    }))!);
    expect(compuesto.sql).toContain(EXISTS);
    expect(compuesto.sql).toContain('"flito_tramites"."compania_nit" in ($1)');
    expect(compuesto.sql).toContain('"flito_tramites"."fecha_aprobacion" >= $2::date');
    expect(compuesto.params).toEqual(['811011779', '2026-07-01']);

    expect(condiciones({})).toEqual([]);
    expect(condiciones({ conDiferencias: false })).toEqual([]);
  });

  it('el consolidado con conDiferencias: mismo WHERE que el detalle, sin parámetro nuevo y sin GROUP BY huérfano (Bug #12058)', () => {
    const sin = ensamblarConsolidado(abrir(selectConsolidado('mes')), {}, 'mes').toSQL();
    const con = ensamblarConsolidado(abrir(selectConsolidado('mes')), { conDiferencias: true }, 'mes').toSQL();
    expect(con.sql).toContain(EXISTS);
    expect(sin.sql).not.toContain('flito_comprobantes"."marcado_por_diferencia');
    // Los únicos parámetros son los que ya había (la tasa del GMF y el 'logistica' del join): el filtro no liga ninguno.
    expect(con.params).toEqual(sin.params);
    expect(gruposHuerfanos({ sql: con.sql, params: con.params })).toEqual([]);
  });

  /** Los WHERE que el reporte mandó al mock, renderizados. */
  const wheresLeidos = () => espia.condicionesLeidas().filter(Boolean).map((c) => renderizar(c as never).sql);

  it('GET ?conDiferencias=si → el EXISTS llega al WHERE de la página, el conteo, los totales y el resumen', async () => {
    kdb.when.select('flito_tramites', [filaCruda()]);
    const app = await buildApp();
    const r = await request(app).get('/api/finanzas/reporte-costos?conDiferencias=si').set('Authorization', await auth());
    expect(r.status).toBe(200);
    const wheres = wheresLeidos();
    expect(wheres.length).toBeGreaterThanOrEqual(4);
    for (const w of wheres) expect(w).toContain(EXISTS);
  });

  it('GET con conDiferencias ausente o distinto de «si» → ningún WHERE (mismo SQL que hoy)', async () => {
    kdb.when.select('flito_tramites', [filaCruda()]);
    const app = await buildApp();
    for (const q of ['', '?conDiferencias=true', '?conDiferencias=no']) {
      espia.reiniciar();
      const r = await request(app).get(`/api/finanzas/reporte-costos${q}`).set('Authorization', await auth());
      expect(r.status, q).toBe(200);
      for (const w of wheresLeidos()) expect(w, q).not.toContain('marcado_por_diferencia');
    }
  });

  it('GET /consolidado?conDiferencias=si → el EXISTS en su WHERE', async () => {
    kdb.when.select('flito_tramites', []);
    kdb.when.select('clients', []);
    const app = await buildApp();
    const r = await request(app).get('/api/finanzas/reporte-costos/consolidado?conDiferencias=si').set('Authorization', await auth());
    expect(r.status).toBe(200);
    const wheres = wheresLeidos();
    expect(wheres.length).toBeGreaterThanOrEqual(1);
    expect(wheres.some((w) => w.includes(EXISTS))).toBe(true);
  });

  it('POST /export y /consolidado/export aceptan conDiferencias: boolean; un valor no booleano es 400', async () => {
    const app = await buildApp();
    const malo = await request(app).post('/api/finanzas/reporte-costos/export')
      .set('Authorization', await auth(101)).send({ conDiferencias: 'si' });
    expect(malo.status).toBe(400);
    const maloC = await request(app).post('/api/finanzas/reporte-costos/consolidado/export')
      .set('Authorization', await auth(102)).send({ conDiferencias: 'si' });
    expect(maloC.status).toBe(400);

    kdb.when.select('flito_tramites', [filaCruda()]);
    const bueno = await request(app).post('/api/finanzas/reporte-costos/export')
      .set('Authorization', await auth(103)).send({ conDiferencias: true });
    expect(bueno.status).toBe(200);
    expect(wheresLeidos().some((w) => w.includes(EXISTS))).toBe(true);
    // Y `false` no filtra.
    espia.reiniciar();
    const sinFiltro = await request(app).post('/api/finanzas/reporte-costos/export')
      .set('Authorization', await auth(104)).send({ conDiferencias: false });
    expect(sinFiltro.status).toBe(200);
    expect(wheresLeidos().some((w) => w.includes('marcado_por_diferencia'))).toBe(false);
  });
});

// ── AC6 — Filas selladas: el origen sale del sello ──────────────────────────

describe('AC6 — sellada: el origen se lee del sello (clave jsonb como texto), el dinero sigue siendo el sellado', () => {
  it('origenTd/origenLg: sellada → COALESCE(detalle -> concepto ->> origenValor, tarifa); sin sellar → documental si hay comprobante; sin parámetros', () => {
    for (const [col, clave, doc] of [
      [SELECT_VALORES_DOCUMENTALES.origenTd, 'tramiteDigital', DOC_TD],
      [SELECT_VALORES_DOCUMENTALES.origenLg, 'logistica', DOC_LG],
    ] as const) {
      const q = renderizar(col);
      expect(q.params, clave).toEqual([]);
      expect(q.sql).toBe(
        `CASE WHEN "flito_liquidaciones"."id" IS NOT NULL
    THEN COALESCE("flito_liquidaciones"."detalle" -> '${clave}' ->> 'origenValor', 'tarifa')
    WHEN ${doc} IS NOT NULL THEN 'documental' ELSE 'tarifa' END`,
      );
    }
  });

  it('las columnas documentales van por las fábricas del leaf (misma correlación, sin parámetros) y el nombre de quien aceptó es el username interno', () => {
    const claves = Object.keys(SELECT_VALORES_DOCUMENTALES);
    // 2 orígenes + 9 por TD y LG + 10 por SA (Bug #12913: `saAceptada`, «todas las marcadas aceptadas»).
    expect(claves).toHaveLength(2 + 2 * 9 + 10);
    for (const k of claves) {
      const q = renderizar(SELECT_VALORES_DOCUMENTALES[k as keyof typeof SELECT_VALORES_DOCUMENTALES]);
      expect(q.params, k).toEqual([]);
      expect(q.sql, k).toContain('"flito_comprobantes"."tramite_id" = "flito_tramites"."id"');
      expect(q.sql, k).toContain("\"flito_comprobantes\".\"estado\" = 'aplicado' and \"flito_comprobantes\".\"es_pago\" = true");
      expect(q.sql, k).not.toContain('extraccion');
      // TD/LG: una fila por concepto (`limit 1`). SA: N filas (suma, bool_or o representante ordenado).
      if (!k.startsWith('sa')) expect(q.sql, k).toContain("\"flito_comprobantes\".\"es_pago\" = true limit 1)");
    }
    expect(renderizar(SELECT_VALORES_DOCUMENTALES.saDiferencia).sql).toMatch(/^\(select sum\("flito_comprobantes"\."diferencia_tarifa"\)/);
    expect(renderizar(SELECT_VALORES_DOCUMENTALES.saTarifaReferencia).sql).toMatch(/^\(select sum\("flito_comprobantes"\."tarifa_referencia"\)/);
    expect(renderizar(SELECT_VALORES_DOCUMENTALES.saComprobanteId).sql).toContain('order by ("flito_comprobantes"."marcado_por_diferencia" and "flito_comprobantes"."diferencia_aceptada_en" is null) desc');
    const nombre = renderizar(SELECT_VALORES_DOCUMENTALES.saAceptadaPorNombre).sql;
    expect(nombre).toContain('select "users"."username" from "flito_comprobantes" left join "users" on "users"."id" = "flito_comprobantes"."diferencia_aceptada_por_id"');
    expect(nombre).toContain("\"flito_comprobantes\".\"concepto\" = 'servicios_adicionales'");
    // Y SELECT_FILA las compone todas.
    for (const k of claves) expect(SELECT_FILA).toHaveProperty(k);
  });

  it('sellada con origenValor = documental: el valor es el sellado y el origen el del sello; la aceptación se lee en vivo', async () => {
    const fila = await filaServida(filaCruda({
      sellada: true, estadoLiquidacion: 'liquidado', tramiteDigital: '85000.00',
      origenTd: 'documental', ...documental('td', ID_TD, '80000.00', '5000.00', true),
    }));
    expect(fila.tramiteDigital).toBe(85000);
    expect(fila.origenes.tramiteDigital).toBe('documental');
    expect(fila.valorDocumental.tramiteDigital).toEqual({
      comprobanteId: ID_TD, numero: 'REC-TD-9', fecha: '2026-07-10', tarifaReferencia: 80000, diferencia: 5000,
      aceptada: true, aceptadaPorNombre: 'contadora', aceptadaEn: '2026-07-12T10:00:00.000Z', aceptadaMotivo: 'Pactado con el cliente',
    });
  });

  it('sello previo a F3 (sin la clave) con comprobante aplicado ANTES del sello: origen tarifa (el SQL lo da), nunca null en el DTO', async () => {
    // Lo que el CASE devuelve para una sellada sin clave es 'tarifa' aunque exista el comprobante:
    // el origen NO se lee de la subconsulta viva en una fila sellada.
    const fila = await filaServida(filaCruda({
      sellada: true, estadoLiquidacion: 'facturado', tramiteDigital: '80000.00', logistica: '120000.00',
      origenTd: 'tarifa', origenLg: 'tarifa', ...documental('td', ID_TD, '80000.00', '5000.00'),
    }));
    expect(fila.origenes).toEqual({ tramiteDigital: 'tarifa', logistica: 'tarifa' });
    expect(fila.valorDocumental.tramiteDigital.comprobanteId).toBe(ID_TD);
  });

  it('valoresDocumentalesDeFila: un origen que no sea documental/tarifa cae a tarifa; logística sin gestión → null', () => {
    const r = valoresDocumentalesDeFila({ ...filaCruda(), origenTd: null, origenLg: 'otra', gestionaLogistica: false });
    expect(r.origenes).toEqual({ tramiteDigital: 'tarifa', logistica: null });
    expect(r.valorDocumental).toEqual({ tramiteDigital: null, logistica: null, serviciosAdicionales: null });
  });
});

describe('Bug #12913 — SA con varios comprobantes de pago (uno por tipo): una celda con la suma, aceptada solo si TODAS', () => {
  it('diferencia y tarifa llegan sumadas por SQL; `aceptada` sale de `saAceptada` (no del id de quien aceptó el representante)', async () => {
    // El representante trae constancia (id 7) pero hay OTRA marcada sin aceptar → saAceptada false → aceptada false.
    const pendiente = await filaServida(filaCruda({ ...documental('sa', ID_SA, '150000.00', '30000.00', true), saAceptada: false }));
    expect(pendiente.valorDocumental.serviciosAdicionales).toMatchObject({ comprobanteId: ID_SA, tarifaReferencia: 150000, diferencia: 30000, aceptada: false });
    const todas = await filaServida(filaCruda({ ...documental('sa', ID_SA, '150000.00', '30000.00', true), saAceptada: true }));
    expect(todas.valorDocumental.serviciosAdicionales).toMatchObject({ aceptada: true, aceptadaPorNombre: 'contadora' });
  });
});
