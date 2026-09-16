// HU #12623 — Gastos diarios de Finanzas: serie por día del evento y totales por categoría (Feature
// #12621, Épica #12248).
//
// Reglas de la suite: el CI no levanta Postgres y el mock `chain` de keyed-db devuelve la fila entera e
// ignora columnas, joins, `where`, `groupBy` y `orderBy`. Por eso la FORMA de cada sub-consulta —el
// `to_char(... AT TIME ZONE 'America/Bogota', ...)` literal en SELECT y GROUP BY, los predicados de
// estado/valor/rango, el COUNT/SUM, la ausencia de `flito_liquidaciones` (RN-03) y el filtro de
// empresas presente o ausente— se afirma sobre el SQL RENDERIZADO con `QueryBuilder` a través de la
// MISMA función `ensamblar<Fuente>()` que usa el servicio. Lo puro (`resolverRango`, `serieDe`,
// `totalesDe`, `aCentavos`, `empresasIds`) se prueba llamándolo. Cada aserto lleva el mutante que lo
// pone rojo.
//
// `TZ=UTC` se fija AQUÍ (AC4): el reloj del proceso en -05 disfrazaría el default de 30 días y el
// `hoyColombia()` (memoria: «tests de hora verdes por el huso local»).
process.env.TZ = 'UTC';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryBuilder, type PgSelect } from 'drizzle-orm/pg-core';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken, type TestRole } from '../helpers/auth.js';

const kdb = createKeyedDb();

vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: vi.fn().mockResolvedValue(undefined) }));

const gd = await import('../../src/modules/finanzas/finanzas.gastos-diarios.js');
const {
  aCentavos, CANTIDAD_LOGISTICA, deCentavos, DIA_DERECHO, DIA_IMPUESTO, DIA_LOGISTICA, DIA_SERVICIOS, DIA_SOAT,
  empresasIds, ensamblarDerecho, ensamblarImpuesto, ensamblarLogistica, ensamblarServicios, ensamblarSoat,
  gastosDiarios, resolverRango, seleccion, serieDe, sumarDias, totalesDe,
} = gd;
const servicio = await import('../../src/modules/finanzas/finanzas.service.js');
const { EXPR_LOGISTICA, EXPR_LOGISTICA_ESTIMADA, conJoins } = servicio;
const { TASA_GMF } = await import('../../src/modules/flito-liquidacion/flito-liquidacion.service.js');
const schema = await import('../../src/db/schema.js');
const { flitoDerechosTramite, flitoImpuestos, flitoSoat, flitoTramites, flitoTramiteServiciosAdicionales } = schema;
const { logPiiAccess } = await import('../../src/shared/pii-audit.js');
const { GASTOS_DIARIOS_RANGO_DEFAULT_DIAS, GASTOS_DIARIOS_RANGO_MAX_DIAS } = await import('@operaciones/shared-types');

type Tabla = Parameters<ReturnType<QueryBuilder['select']>['from']>[0];
type Rango = Parameters<typeof ensamblarSoat>[1];
const RANGO: Rango = { desde: '2026-09-01', hasta: '2026-09-16' };
const EMPRESAS = ['900123456', '900123456-7'];
const MAESTRO = [
  { id: 7, nombre: 'Transportes Uno', documento: '900.123.456-7' },
  { id: 9, nombre: 'Dos S.A.S.', documento: '800999888' },
];

/** Un select abierto con `QueryBuilder` (sin base): rinde el mismo SQL que el de `db`, pero no ejecuta. */
const abrir = (campos: Record<string, unknown>, tabla: Tabla): PgSelect =>
  new QueryBuilder().select(campos as never).from(tabla).$dynamic() as unknown as PgSelect;

const SQL_SOAT = (r = RANGO, ids?: number[]) =>
  ensamblarSoat(abrir(seleccion(DIA_SOAT, flitoSoat.valorPagado), flitoSoat), r, ids).toSQL();
const SQL_IMPUESTO = (r = RANGO, e?: string[]) =>
  ensamblarImpuesto(abrir(seleccion(DIA_IMPUESTO, flitoImpuestos.valorPagado), flitoImpuestos), r, e).toSQL();
const SQL_DERECHO = (r = RANGO, e?: string[]) =>
  ensamblarDerecho(abrir(seleccion(DIA_DERECHO, flitoDerechosTramite.valor), flitoDerechosTramite), r, e).toSQL();
const SQL_SERVICIOS = (r = RANGO, e?: string[]) =>
  ensamblarServicios(abrir(seleccion(DIA_SERVICIOS, flitoTramiteServiciosAdicionales.valor), flitoTramiteServiciosAdicionales), r, e).toSQL();
const SQL_LOGISTICA = (r = RANGO, e?: string[]) =>
  ensamblarLogistica(abrir(seleccion(DIA_LOGISTICA, EXPR_LOGISTICA_ESTIMADA, CANTIDAD_LOGISTICA), flitoTramites), r, e).toSQL();
const LAS_CINCO = () => ({
  soat: SQL_SOAT(), impuesto: SQL_IMPUESTO(), derecho: SQL_DERECHO(), servicios: SQL_SERVICIOS(), logistica: SQL_LOGISTICA(),
});

/** El SQL de una expresión suelta, para afirmar que la sub-consulta lo contiene tal cual. */
const render = (expr: unknown, tabla: Tabla = flitoTramites) =>
  new QueryBuilder().select({ x: expr as never }).from(tabla).toSQL().sql.replace(/^select /, '').replace(/ from .*$/s, '');

const TZ = "AT TIME ZONE 'America/Bogota'";
// Drizzle renderiza la lista del SELECT de una consulta SIN joins con los nombres de columna pelados
// (`"pagado_en"`) y el GROUP BY calificado (`"flito_soat"."pagado_en"`): es la MISMA instancia de la
// expresión y Postgres los resuelve al mismo Var, así que el GROUP BY casa (no hay 42803). Con joins
// (logística) los dos van calificados.
const DIA = (col: string) => `to_char(${col} ${TZ}, 'YYYY-MM-DD')`;
const pelada = (expr: string) => expr.replace(/"[^"]+"\.(?=")/, '');

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/finanzas/finanzas.routes.js');
  app.use('/api/finanzas', router);
  return app;
}
let sub = 6100;
const auth = async (role: TestRole = 'financiera', allowedPages?: string[]) =>
  `Bearer ${await testToken({ sub: sub++, username: `${role}@flit.io`, role, allowedPages })}`;
const CON_PAGINA = ['finanzas_gastos_diarios'];

beforeEach(() => {
  kdb.reset();
  kdb.when.select('clients', MAESTRO);
});
afterEach(() => { vi.useRealTimers(); });

// ── AC4 / AC6 — la forma de las cinco sub-consultas ─────────────────────────────

describe('AC4 — cada categoría cuenta su evento, en día colombiano', () => {
  it('SOAT: agrupa por pagado_en en Bogotá, filtra pagado + valor_pagado IS NOT NULL y cuenta pólizas SIN join a flito_tramites', () => {
    const { sql, params } = SQL_SOAT();
    const dia = DIA('"flito_soat"."pagado_en"');
    // Mutante «quitar AT TIME ZONE»: el SELECT y el GROUP BY dejan de llevar el huso.
    expect(sql).toContain(`select ${pelada(dia)}, COUNT(*)::int, COALESCE(SUM("valor_pagado"), 0) from "flito_soat"`);
    expect(sql.endsWith(`group by ${dia}`)).toBe(true);
    // Mutante «'pagado' → 'enviado'» y mutante «quitar IS NOT NULL».
    expect(sql).toContain(`"flito_soat"."estado" = 'pagado' AND "flito_soat"."valor_pagado" IS NOT NULL`);
    expect(sql).not.toContain('flito_tramites');
    expect(sql).not.toContain('join');
    expect(params).toEqual(['2026-09-01', 'America/Bogota', '2026-09-16', 'America/Bogota']);
  });

  it('Impuesto: pagado_en en Bogotá con pagado + valor_pagado IS NOT NULL', () => {
    const { sql } = SQL_IMPUESTO();
    const dia = DIA('"flito_impuestos"."pagado_en"');
    expect(sql).toContain(`select ${pelada(dia)}, COUNT(*)::int, COALESCE(SUM("valor_pagado"), 0) from "flito_impuestos"`);
    expect(sql.endsWith(`group by ${dia}`)).toBe(true);
    expect(sql).toContain(`"flito_impuestos"."estado" = 'pagado' AND "flito_impuestos"."valor_pagado" IS NOT NULL`);
  });

  it('Derecho: fecha_pago es date → to_char SIN AT TIME ZONE, valor IS NOT NULL y BETWEEN desde AND hasta', () => {
    const { sql, params } = SQL_DERECHO();
    const dia = `to_char("flito_derechos_tramite"."fecha_pago", 'YYYY-MM-DD')`;
    expect(sql).toContain(`select ${pelada(dia)}, COUNT(*)::int, COALESCE(SUM("valor"), 0) from "flito_derechos_tramite"`);
    expect(sql.endsWith(`group by ${dia}`)).toBe(true);
    expect(sql).not.toContain('AT TIME ZONE');
    expect(sql).toContain(`"flito_derechos_tramite"."valor" IS NOT NULL`);
    expect(sql).toContain(`"flito_derechos_tramite"."fecha_pago" BETWEEN $1::date AND $2::date`);
    expect(params).toEqual(['2026-09-01', '2026-09-16']);
  });

  it('Servicios adicionales: asignado_en en Bogotá y una fila por servicio (COUNT(*) sobre la puente)', () => {
    const { sql } = SQL_SERVICIOS();
    const dia = DIA('"flito_tramite_servicios_adicionales"."asignado_en"');
    expect(sql).toContain(`select ${pelada(dia)}, COUNT(*)::int, COALESCE(SUM("valor"), 0) from "flito_tramite_servicios_adicionales"`);
    expect(sql.endsWith(`group by ${dia}`)).toBe(true);
    expect(sql).not.toContain('distinct');
  });

  it('Logística: fecha_aprobacion en Bogotá, IS NOT NULL, SUM(EXPR_LOGISTICA_ESTIMADA), COUNT FILTER, joins lg + excepción vigente', () => {
    const { sql } = SQL_LOGISTICA();
    const dia = DIA('"flito_tramites"."fecha_aprobacion"');
    const estimada = render(EXPR_LOGISTICA_ESTIMADA);
    expect(sql.startsWith(`select ${dia}, (COUNT(*) FILTER (WHERE ${estimada} IS NOT NULL))::int, COALESCE(SUM(${estimada}), 0) from "flito_tramites"`)).toBe(true);
    expect(sql.endsWith(`group by ${dia}`)).toBe(true);
    expect(sql).toContain(`"flito_tramites"."fecha_aprobacion" IS NOT NULL`);
    expect(sql).toContain(`left join "clients" on "flito_tramites"."compania_id" = "clients"."id"`);
    expect(sql).toContain(`left join "flito_excepciones_autogestion" on ("flito_excepciones_autogestion"."tramite_id" = "flito_tramites"."id" and "flito_excepciones_autogestion"."concepto" = $1 and "flito_excepciones_autogestion"."revocado_en" is null)`);
    expect(sql).toContain(`left join "flito_tarifas_vigencias" "lg" on "lg"."compania_id" = "flito_tramites"."compania_id" AND "lg"."concepto" = 'logistica'`);
    // Sin el resto de `conJoins()`: ni vehicles ni liquidaciones ni tarifa de trámite digital.
    expect(sql).not.toContain('"vehicles"');
    expect(sql).not.toContain('"td"');
  });

  it('RN-03: ninguna de las cinco nombra flito_liquidaciones (y conJoins sí, por contraste)', () => {
    for (const [nombre, { sql }] of Object.entries(LAS_CINCO())) {
      expect(sql, nombre).not.toContain('flito_liquidaciones');
    }
    expect(conJoins(abrir({ id: flitoTramites.id }, flitoTramites)).toSQL().sql).toContain('flito_liquidaciones');
  });

  it('el rango de los timestamptz es inclusivo por día colombiano: >= desde::date en Bogotá y < (hasta + 1 día) en Bogotá', () => {
    const { soat, impuesto, servicios, logistica } = LAS_CINCO();
    const rango = (col: string) =>
      `${col} >= ($1::date AT TIME ZONE $2) and ${col} < (($3::date + interval '1 day') AT TIME ZONE $4)`;
    expect(soat.sql).toContain(rango('"flito_soat"."pagado_en"'));
    expect(impuesto.sql).toContain(rango('"flito_impuestos"."pagado_en"'));
    expect(servicios.sql).toContain(rango('"flito_tramite_servicios_adicionales"."asignado_en"'));
    // La logística lleva `$1` en el join de la excepción: sus marcadores van corridos en uno.
    expect(logistica.sql).toContain(
      `"flito_tramites"."fecha_aprobacion" >= ($2::date AT TIME ZONE $3) and "flito_tramites"."fecha_aprobacion" < (($4::date + interval '1 day') AT TIME ZONE $5)`,
    );
    expect(logistica.params).toEqual(['logistica', '2026-09-01', 'America/Bogota', '2026-09-16', 'America/Bogota']);
  });

  it('guarda del 42803: el GROUP BY de cada sub-consulta no lleva ningún marcador $n (huso literal)', () => {
    for (const [nombre, { sql }] of Object.entries(LAS_CINCO())) {
      const groupBy = sql.slice(sql.lastIndexOf('group by'));
      expect(groupBy, nombre).not.toMatch(/\$\d/);
    }
  });
});

describe('AC6 — filtro de cliente por empresa (RN-07)', () => {
  it('impuesto, derecho y servicios filtran con EXISTS al trámite por tramite_id y compania_nit IN (...)', () => {
    const exists = (tabla: string) =>
      `EXISTS (SELECT 1 FROM "flito_tramites" WHERE "flito_tramites"."id" = "${tabla}"."tramite_id" AND "flito_tramites"."compania_nit" in ($3, $4))`;
    const imp = SQL_IMPUESTO(RANGO, EMPRESAS);
    expect(imp.sql.replace(/\$5, \$6/, '$3, $4')).toContain(exists('flito_impuestos'));
    expect(imp.params.slice(-2)).toEqual(EMPRESAS);
    const der = SQL_DERECHO(RANGO, EMPRESAS);
    expect(der.sql).toContain(exists('flito_derechos_tramite'));
    expect(der.params).toEqual(['2026-09-01', '2026-09-16', ...EMPRESAS]);
    const srv = SQL_SERVICIOS(RANGO, EMPRESAS);
    expect(srv.sql.replace(/\$5, \$6/, '$3, $4')).toContain(exists('flito_tramite_servicios_adicionales'));
    expect(srv.params.slice(-2)).toEqual(EMPRESAS);
  });

  it('la logística filtra sobre el propio trámite: "flito_tramites"."compania_nit" in (...)', () => {
    const { sql, params } = SQL_LOGISTICA(RANGO, EMPRESAS);
    expect(sql).toContain(`"flito_tramites"."compania_nit" in ($6, $7)`);
    expect(params.slice(-2)).toEqual(EMPRESAS);
    expect(sql).not.toContain('EXISTS');
  });

  it('el SOAT filtra por compania_id con los ids resueltos por indiceEmpresas (NIT con y sin dígito, con puntos)', () => {
    expect(empresasIds(EMPRESAS, MAESTRO)).toEqual([7]);
    expect(empresasIds(['800999888', '999'], MAESTRO)).toEqual([9]);
    const { sql, params } = SQL_SOAT(RANGO, [7]);
    expect(sql).toContain(`"flito_soat"."compania_id" in ($5)`);
    expect(params).toEqual(['2026-09-01', 'America/Bogota', '2026-09-16', 'America/Bogota', 7]);
    expect(sql).not.toContain('flito_tramites');
  });

  it('sin empresas o empresas=[]: ningún filtro de compañía; NITs sin empresa registrada: el SOAT devuelve cero filas', () => {
    for (const vacio of [undefined, []]) {
      for (const [nombre, { sql }] of Object.entries({
        soat: SQL_SOAT(RANGO, empresasIds(vacio, MAESTRO)), impuesto: SQL_IMPUESTO(RANGO, vacio),
        derecho: SQL_DERECHO(RANGO, vacio), servicios: SQL_SERVICIOS(RANGO, vacio), logistica: SQL_LOGISTICA(RANGO, vacio),
      })) {
        expect(sql, nombre).not.toContain('compania_nit');
        expect(sql, nombre).not.toContain('compania_id" in');
      }
    }
    // `[]` como lista de NITs NO es «no resolvió»: pasa por `empresasIds` y llega como `undefined`.
    for (const vacio of [undefined, []]) {
      expect(SQL_SOAT(RANGO, empresasIds(vacio, MAESTRO)).sql).not.toContain('and false');
    }
    // Mutante «empresas=[] como ninguna»: `empresasIds([])` devolvería `[]` y el SOAT llevaría `false`.
    expect(empresasIds([], MAESTRO)).toBeUndefined();
    expect(empresasIds(undefined, MAESTRO)).toBeUndefined();
    // NITs que no casan con ninguna empresa: `[]` (no `undefined`) y la sub-consulta de SOAT no devuelve
    // nada —un SOAT siempre tiene compania_id, un NIT sin empresa no puede tener SOAT—. Mutante
    // «devolver el universo cuando no resuelve» (`empresasIds?.length ? in : undefined`) → cae: el SQL
    // no llevaría `false` y enseñaría el SOAT de todas las compañías bajo un filtro de cliente.
    expect(empresasIds(['111222333'], MAESTRO)).toEqual([]);
    const sinEmpresa = SQL_SOAT(RANGO, []).sql;
    expect(sinEmpresa).toContain('and false)');
    expect(sinEmpresa).not.toContain('compania_id" in');
  });
});

// ── AC5 — EXPR_LOGISTICA_ESTIMADA compartida con el reporte ──────────────────

describe('AC5 — EXPR_LOGISTICA_ESTIMADA compartida con el reporte (RN-02)', () => {
  // Renderizado en el commit base (9ddae71) ANTES de tocar finanzas.service.ts, byte a byte, en el
  // contexto REAL del reporte: `conJoins()`, que es donde `EXPR_LOGISTICA` vive (SELECT_FILA,
  // SELECT_TOTALES). En una consulta sin joins Drizzle pela el prefijo de tabla SOLO de las columnas
  // que son chunk de primer nivel del template, así que `lg.valor` —ahora dentro de la instancia
  // compartida `RAMAS_LOGISTICA_ESTIMADA`— saldría `"lg"."valor"` donde antes salía `"valor"`; ese
  // contexto no existe en producción (la expresión referencia `clients`, `lg` y `flito_liquidaciones`,
  // que solo están tras `conJoins`).
  // Desde la HU #12627 el ELSE sin sellar es tarifa + Σ viajes adicionales (D5, Épica #12244), y entra
  // en la instancia compartida a propósito: gastos diarios y reporte siguen estimando lo mismo (RN-02).
  const EXPR_LOGISTICA_BASE = `select CASE WHEN "flito_liquidaciones"."id" IS NOT NULL THEN "flito_liquidaciones"."valor_logistica"
  WHEN NOT (NOT COALESCE("clients"."logistica_autogestionable", false) OR ("flito_excepciones_autogestion"."id" IS NOT NULL)) THEN NULL
  ELSE "lg"."valor" + COALESCE((SELECT SUM("flito_tramite_viajes_logistica"."valor") FROM "flito_tramite_viajes_logistica" WHERE "flito_tramite_viajes_logistica"."tramite_id" = "flito_tramites"."id"), 0) END`;

  it('EXPR_LOGISTICA renderiza EXACTAMENTE igual que antes del refactor en el contexto del reporte (no regresión)', () => {
    const sql = conJoins(abrir({ x: EXPR_LOGISTICA }, flitoTramites)).toSQL().sql;
    expect(sql.split(' from "flito_tramites"')[0]).toBe(EXPR_LOGISTICA_BASE);
    // Mutante «cambiar el salto de línea o el orden de las ramas»: cae aquí byte a byte.
  });

  it('EXPR_LOGISTICA_ESTIMADA es la rama sin sellar: CASE WHEN NOT gestiona THEN NULL ELSE lg.valor + Σ viajes END', () => {
    expect(render(EXPR_LOGISTICA_ESTIMADA)).toBe(
      `CASE WHEN NOT (NOT COALESCE("clients"."logistica_autogestionable", false) OR ("flito_excepciones_autogestion"."id" IS NOT NULL)) THEN NULL
  ELSE "lg"."valor" + COALESCE((SELECT SUM("flito_tramite_viajes_logistica"."valor") FROM "flito_tramite_viajes_logistica" WHERE "flito_tramite_viajes_logistica"."tramite_id" = "flito_tramites"."id"), 0) END`,
    );
    expect(render(EXPR_LOGISTICA_ESTIMADA)).not.toContain('flito_liquidaciones');
    // Y es la MISMA instancia que compone EXPR_LOGISTICA: su render está contenido en el del reporte.
    expect(EXPR_LOGISTICA_BASE).toContain(render(EXPR_LOGISTICA_ESTIMADA).replace(/^CASE /, ''));
  });

  it('el dashboard suma exactamente esa constante (el SQL de la sub-consulta contiene su render)', () => {
    // Con `lg` en los joins, `"valor"` se califica como `"lg"."valor"`: se compara el render en el mismo contexto.
    const enContexto = ensamblarLogistica(abrir({ x: EXPR_LOGISTICA_ESTIMADA }, flitoTramites), RANGO, undefined).toSQL().sql
      .replace(/^select /, '').replace(/ from .*$/s, '');
    expect(SQL_LOGISTICA().sql).toContain(`COALESCE(SUM(${enContexto}), 0)`);
    expect(enContexto).toContain('"lg"."valor"');
  });
});

// ── AC3 — el rango ──────────────────────────────────────────────────────────

describe('AC3 — rango por defecto, inclusivo y acotado (RN-04, RN-09)', () => {
  it('sin desde ni hasta: los últimos 30 días, hoy incluido, en Bogotá', () => {
    // 2026-09-17 01:30 UTC = 2026-09-16 20:30 en Bogotá: «hoy» es el 16, no el 17.
    vi.useFakeTimers({ now: new Date('2026-09-17T01:30:00Z') });
    expect(resolverRango(undefined, undefined)).toEqual({ ok: true, rango: { desde: '2026-08-18', hasta: '2026-09-16' } });
    expect(GASTOS_DIARIOS_RANGO_DEFAULT_DIAS).toBe(30);
    // Mutante «hoy − 30»: 30 días son hoy y los 29 anteriores.
    expect(sumarDias('2026-08-18', 29)).toBe('2026-09-16');
  });

  it('uno solo de los dos → 400 nombrando el que falta', () => {
    expect(resolverRango('2026-09-10', undefined)).toEqual({ ok: false, error: expect.stringContaining('hasta'), parametro: 'hasta' });
    expect(resolverRango(undefined, '2026-09-10')).toEqual({ ok: false, error: expect.stringContaining('desde'), parametro: 'desde' });
  });

  it('no ISO (o día inexistente), hasta < desde y más de 366 días → 400 con el parámetro', () => {
    expect(resolverRango('10/09/2026', '2026-09-12')).toMatchObject({ ok: false, parametro: 'desde' });
    expect(resolverRango('2026-09-10', '2026-02-30')).toMatchObject({ ok: false, parametro: 'hasta' });
    expect(resolverRango('2026-09-12', '2026-09-10')).toMatchObject({ ok: false, parametro: 'hasta', error: expect.stringContaining('anterior') });
    expect(GASTOS_DIARIOS_RANGO_MAX_DIAS).toBe(366);
    // 2025-01-01 → 2026-01-01 son 366 días (2025 no es bisiesto... son 365 + 1 = 366 elementos): cabe.
    expect(resolverRango('2025-01-01', '2026-01-01')).toEqual({ ok: true, rango: { desde: '2025-01-01', hasta: '2026-01-01' } });
    // Un día más: 367 elementos → 400.
    expect(resolverRango('2025-01-01', '2026-01-02')).toMatchObject({ ok: false, parametro: 'hasta', error: expect.stringContaining('366') });
  });

  it('la serie trae exactamente un elemento por día, en orden, en cero donde no hubo gasto', () => {
    const vacio = { soat: [], impuesto: [], derecho: [], logistica: [], serviciosAdicionales: [] };
    const serie = serieDe({ desde: '2026-09-10', hasta: '2026-09-12' }, vacio);
    expect(serie.map((d) => d.dia)).toEqual(['2026-09-10', '2026-09-11', '2026-09-12']);
    expect(serie[1]).toEqual({
      dia: '2026-09-11', soat: { cantidad: 0, valor: '0.00' }, impuesto: { cantidad: 0, valor: '0.00' },
      derecho: { cantidad: 0, valor: '0.00' }, logistica: { cantidad: 0, valor: '0.00' }, serviciosAdicionales: { cantidad: 0, valor: '0.00' },
    });
    // Cruza el cambio de mes y un rango de un solo día.
    expect(serieDe({ desde: '2026-08-30', hasta: '2026-09-02' }, vacio).map((d) => d.dia)).toEqual(['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02']);
    expect(serieDe({ desde: '2026-09-16', hasta: '2026-09-16' }, vacio)).toHaveLength(1);
    // Las filas se vuelcan por día y categoría; el `cantidad` que llega como texto del driver se numera.
    const con = serieDe({ desde: '2026-09-10', hasta: '2026-09-12' }, {
      ...vacio, soat: [{ dia: '2026-09-12', cantidad: '2', valor: '100000.00' }], derecho: [{ dia: '2026-09-10', cantidad: 1, valor: '30000.00' }],
    });
    expect(con[2]!.soat).toEqual({ cantidad: 2, valor: '100000.00' });
    expect(con[0]!.derecho).toEqual({ cantidad: 1, valor: '30000.00' });
    expect(con[1]!.soat).toEqual({ cantidad: 0, valor: '0.00' });
  });
});

// ── AC7 — totales ───────────────────────────────────────────────────────────

describe('AC7 — totales, GMF estimado y total (RN-05)', () => {
  const celda = (cantidad: number, valor: string) => ({ cantidad, valor });
  const dia = (d: string, c: Partial<Record<'soat' | 'impuesto' | 'derecho' | 'logistica' | 'serviciosAdicionales', { cantidad: number; valor: string }>>) => ({
    dia: d, soat: celda(0, '0.00'), impuesto: celda(0, '0.00'), derecho: celda(0, '0.00'), logistica: celda(0, '0.00'),
    serviciosAdicionales: celda(0, '0.00'), ...c,
  });

  it('base 215000.00, gmfEstimado 860.00 (ROUND(base × TASA_GMF, 2)), total 215860.00', () => {
    const serie = [
      dia('2026-09-10', { soat: celda(1, '40000.00'), serviciosAdicionales: celda(2, '10000.00') }),
      dia('2026-09-11', { soat: celda(1, '60000.00'), impuesto: celda(1, '50000.00'), derecho: celda(1, '30000.00') }),
      dia('2026-09-12', { logistica: celda(1, '20000.00'), serviciosAdicionales: celda(1, '5000.00') }),
    ];
    const t = totalesDe(serie);
    expect(t.soat).toEqual(celda(2, '100000.00'));
    expect(t.impuesto).toEqual(celda(1, '50000.00'));
    expect(t.derecho).toEqual(celda(1, '30000.00'));
    expect(t.logistica).toEqual(celda(1, '20000.00'));
    expect(t.serviciosAdicionales).toEqual(celda(3, '15000.00'));
    expect(t.base).toBe('215000.00');
    expect(TASA_GMF).toBe(0.004);
    expect(t.gmfEstimado).toBe('860.00');
    // Mutante «gmf sumado dos veces»: total sería 216720.00.
    expect(t.total).toBe('215860.00');
  });

  it('el redondeo del GMF es ROUND(…, 2), no truncado (mutante ROUND → trunc)', () => {
    // 1234.57 × 0.004 = 4.93828 → 4.94 (truncado daría 4.93).
    const t = totalesDe([dia('2026-09-10', { derecho: celda(1, '1234.57') })]);
    expect(t.gmfEstimado).toBe('4.94');
    expect(t.total).toBe('1239.51');
  });

  it('la suma es en centavos enteros, no en float: 9007199254740993.00 sale exacto (float daría …992)', () => {
    const t = totalesDe([
      dia('2026-09-10', { soat: celda(1, '9007199254740992.00') }),
      dia('2026-09-11', { soat: celda(1, '1.00') }),
    ]);
    expect(t.soat.valor).toBe('9007199254740993.00');
    expect(t.base).toBe('9007199254740993.00');
    // Y los centavos no se pierden: 0.10 + 0.20 = 0.30, no 0.30000000000000004.
    expect(totalesDe([dia('2026-09-10', { soat: celda(1, '0.10'), impuesto: celda(1, '0.20') })]).base).toBe('0.30');
  });

  it('aCentavos/deCentavos: dos decimales exactos, signo, y rechazo de lo que no es un numérico de la base', () => {
    expect(aCentavos('215000.00')).toBe(21500000n);
    expect(aCentavos('0')).toBe(0n);
    expect(aCentavos('12.5')).toBe(1250n);
    expect(aCentavos('-3.07')).toBe(-307n);
    expect(aCentavos(42)).toBe(4200n);
    expect(deCentavos(21500000n)).toBe('215000.00');
    expect(deCentavos(7n)).toBe('0.07');
    expect(deCentavos(-307n)).toBe('-3.07');
    expect(() => aCentavos('1e5')).toThrow(TypeError);
    expect(() => aCentavos('abc')).toThrow(TypeError);
  });

  it('con la serie vacía todo es cero', () => {
    expect(totalesDe([])).toEqual({
      soat: celda(0, '0.00'), impuesto: celda(0, '0.00'), derecho: celda(0, '0.00'), logistica: celda(0, '0.00'),
      serviciosAdicionales: celda(0, '0.00'), base: '0.00', gmfEstimado: '0.00', total: '0.00',
    });
  });
});

// ── AC2 / AC8 — la ruta ─────────────────────────────────────────────────────

describe('AC2 — la ruta y su guarda', () => {
  it('403 con el cuerpo canónico de exigirFuncion sin la función pagina.finanzas_gastos_diarios (financiera sin la página)', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/finanzas/gastos-diarios').set('Authorization', await auth('financiera'));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ funcion: 'pagina.finanzas_gastos_diarios' });
    expect(res.body.error).toEqual(expect.any(String));
  });

  it('401 sin token', async () => {
    const app = await buildApp();
    expect((await request(app).get('/api/finanzas/gastos-diarios')).status).toBe(401);
  });

  it('200 con la función: GastosDiariosRespuesta con desde/hasta, serie completa y totales; empresas por lista()', async () => {
    kdb.when
      .select('flito_soat', [{ dia: '2026-09-02', cantidad: 2, valor: '100000.00' }])
      .select('flito_impuestos', [{ dia: '2026-09-03', cantidad: '1', valor: '50000.00' }])
      .select('flito_derechos_tramite', [{ dia: '2026-09-03', cantidad: 1, valor: '30000.00' }])
      .select('flito_tramite_servicios_adicionales', [{ dia: '2026-09-01', cantidad: 3, valor: '15000.00' }])
      .select('flito_tramites', [{ dia: '2026-09-16', cantidad: 1, valor: '20000.00' }]);
    const app = await buildApp();
    const res = await request(app)
      .get('/api/finanzas/gastos-diarios?desde=2026-09-01&hasta=2026-09-16&empresas=900123456,%20900123456-7,,')
      .set('Authorization', await auth('financiera', CON_PAGINA));
    expect(res.status).toBe(200);
    expect(res.body.desde).toBe('2026-09-01');
    expect(res.body.hasta).toBe('2026-09-16');
    expect(res.body.serie).toHaveLength(16);
    expect(res.body.serie[1]).toMatchObject({ dia: '2026-09-02', soat: { cantidad: 2, valor: '100000.00' } });
    expect(res.body.serie[2]).toMatchObject({ impuesto: { cantidad: 1, valor: '50000.00' }, derecho: { cantidad: 1, valor: '30000.00' } });
    expect(res.body.serie[15]).toMatchObject({ dia: '2026-09-16', logistica: { cantidad: 1, valor: '20000.00' } });
    expect(res.body.totales).toEqual({
      soat: { cantidad: 2, valor: '100000.00' }, impuesto: { cantidad: 1, valor: '50000.00' },
      derecho: { cantidad: 1, valor: '30000.00' }, logistica: { cantidad: 1, valor: '20000.00' },
      serviciosAdicionales: { cantidad: 3, valor: '15000.00' }, base: '215000.00', gmfEstimado: '860.00', total: '215860.00',
    });
    // AC8: la respuesta son días, cantidades y valores; nada más.
    expect(Object.keys(res.body).sort()).toEqual(['desde', 'hasta', 'serie', 'totales']);
    expect(Object.keys(res.body.serie[0]).sort()).toEqual(['derecho', 'dia', 'impuesto', 'logistica', 'serviciosAdicionales', 'soat']);
    expect(JSON.stringify(res.body)).not.toMatch(/placa|vin|nombre|documento|tramite/i);
    expect(logPiiAccess).not.toHaveBeenCalled();
  });

  it('admin (todas las páginas concedibles) también entra', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/finanzas/gastos-diarios?desde=2026-09-10&hasta=2026-09-12').set('Authorization', await auth('admin'));
    expect(res.status).toBe(200);
    expect(res.body.serie.map((d: { dia: string }) => d.dia)).toEqual(['2026-09-10', '2026-09-11', '2026-09-12']);
  });

  it('la pila de middlewares de la ruta lleva requirePage y NO requireRole/LECTURA (y el archivo sigue con un solo requireRole)', async () => {
    const { default: router } = await import('../../src/modules/finanzas/finanzas.routes.js');
    const capa = (router as unknown as { stack: Array<{ route?: { path: string; stack: Array<{ handle: () => void }> } }> }).stack
      .find((l) => l.route?.path === '/gastos-diarios')!.route!;
    // Los handlers son closures anónimos: se compara su CÓDIGO con el que fabrican `requirePage` y
    // `requireRole` (cada llamada crea una closure nueva, así que la identidad no sirve).
    expect(capa.stack).toHaveLength(2);
    const { requireRole } = await import('../../src/shared/middleware/auth.js');
    const { requirePage } = await import('../../src/shared/permissions.js');
    const guarda = capa.stack[0]!.handle.toString();
    expect(guarda).toBe(requirePage('finanzas_gastos_diarios').toString());
    expect(guarda).not.toBe(requireRole('admin').toString());
    const fuente = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/modules/finanzas/finanzas.routes.ts'), 'utf8');
    expect(fuente.match(/requireRole\(/g)).toHaveLength(1);
    expect(fuente).toMatch(/router\.get\('\/gastos-diarios', requirePage\('finanzas_gastos_diarios'\)/);
  });

  it('400 de rango con el nombre del parámetro (no 500 ni «todo el histórico»)', async () => {
    const app = await buildApp();
    const token = await auth('financiera', CON_PAGINA);
    const casos: Array<[string, 'desde' | 'hasta']> = [
      ['desde=2026-09-10', 'hasta'], ['hasta=2026-09-10', 'desde'], ['desde=10-09-2026&hasta=2026-09-12', 'desde'],
      ['desde=2026-09-12&hasta=2026-09-10', 'hasta'], ['desde=2025-01-01&hasta=2026-01-02', 'hasta'],
    ];
    for (const [qs, parametro] of casos) {
      const res = await request(app).get(`/api/finanzas/gastos-diarios?${qs}`).set('Authorization', token);
      expect(res.status, qs).toBe(400);
      expect(res.body, qs).toEqual({ error: expect.stringContaining(parametro), parametro });
    }
  });

  it('sin desde ni hasta: 30 días hasta hoy en Bogotá (vi.setSystemTime)', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-17T01:30:00Z'), toFake: ['Date'] });
    const app = await buildApp();
    const res = await request(app).get('/api/finanzas/gastos-diarios').set('Authorization', await auth('financiera', CON_PAGINA));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ desde: '2026-08-18', hasta: '2026-09-16' });
    expect(res.body.serie).toHaveLength(30);
  });
});

describe('AC8 — sin PII y sin escritura', () => {
  it('el servicio no ejecuta INSERT/UPDATE/DELETE, no usa db.transaction ni logPiiAccess, y lo documenta', () => {
    const fuente = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/modules/finanzas/finanzas.gastos-diarios.ts'), 'utf8');
    const codigo = fuente.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(codigo).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\btransaction\b|INSERT INTO|UPDATE |DELETE FROM/);
    expect(codigo).not.toContain('logPiiAccess');
    expect(fuente).toMatch(/Sin registro PII/);
  });

  it('gastosDiarios() dispara las cinco sub-consultas y el maestro, y nada más (con el mock keyed-db)', async () => {
    const r = await gastosDiarios(RANGO, EMPRESAS);
    expect(r.serie).toHaveLength(16);
    expect(r.totales.total).toBe('0.00');
  });
});
