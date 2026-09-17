// HU #10966 — reporte de costos con valores reales (Feature #10941).
//
// El módulo `finanzas` no tenía NINGÚN test pese a ser el que alimenta la conciliación con
// contabilidad. Aquí se cubre lo que es puro; el SQL —que es casi todo el servicio— se verifica
// contra Postgres real, porque el helper `chain()` descarta los argumentos de `where()` y no
// distingue un CASE bien escrito de uno que devuelve siempre NULL.

import { describe, it, expect, vi } from 'vitest';
import { QueryBuilder } from 'drizzle-orm/pg-core';

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const servicio = await import('../../src/modules/finanzas/finanzas.service.js');
const { agruparEmpresas, condiciones, conJoins } = servicio;
const { COLUMNAS_EXPORT_DETALLE, filasExcelDetalle } = await import('../../src/modules/finanzas/finanzas.export-excel.js');
const { flitoTramites } = await import('../../src/db/schema.js');
const { and } = await import('drizzle-orm');
const { renderizar } = await import('../helpers/sql-ligado.js');

type Fila = Parameters<typeof filasExcelDetalle>[0][number];

function fila(over: Partial<Fila> = {}): Fila {
  return {
    tramiteId: 't1', idFlit: 'FLIT-1', placa: 'ABC123', estado: 'Aprobado', empresa: 'ACME',
    vin: 'VIN1', marca: 'CHEVROLET', linea: 'ONIX',
    tipoTramite: 'Traspaso', fechaAprobacion: '2026-07-14T15:30:00.000Z',
    fechaCreacion: '2026-07-01T10:00:00.000Z',
    soat: 450000, impuesto: 120000, derechoTramite: 80000,
    logistica: 15000, tramiteDigital: 200000, gmf: 3460, total: 868460,
    // HU #12546 — la fila las trae siempre; `null` = el trámite no lleva servicios adicionales.
    serviciosAdicionales: null, serviciosAdicionalesCantidad: 0,
    sellada: true, estadoLiquidacion: 'liquidado', noConfigurados: [],
    sinRecibo: [], pendientesPago: [], autogestionados: [], noAplican: [],
    estadoFacturacion: 'no_enviado', facturaNumero: null, facturaRequiereRevision: false,
    soatConciliado: false, boletaReferencia: null, soatConciliadoEn: null,
    // HU #12432 — titular, organismo, periodo y subtotales.
    titularNombres: 'ANA MARÍA', titularApellidos: 'PÉREZ', titularRazonSocial: null,
    titularTipoDocumento: 'CC', titularDocumento: '1020304050',
    organismoCodigo: '05266', organismoNombre: 'Envigado', mes: '2026-07', trimestre: '2026-T3',
    totalReintegro: 668460, totalServicio: 200000,
    // HU #12531 — contacto del primer comprador.
    titularCorreo: null, titularTelefono: null, titularDireccion: null,
    ...over,
  } as Fila;
}

/** La celda de UNA fila serializada por su CLAVE de `COLUMNAS_EXPORT_DETALLE` (HU #12531: .xlsx). */
const celda = (f: Fila, clave: string): unknown => filasExcelDetalle([f])[0]![clave];

describe('filasExcelDetalle — el archivo que abre contabilidad', () => {
  it('abre con las columnas literales del Excel de Financiero: «cliente», «Mes/Trimestre», «FLIT» (HU #12536)', () => {
    // Mutante «cabecera 'Cliente' con mayúscula» o «'Flit'» como en la HU #12432: cae.
    expect(COLUMNAS_EXPORT_DETALLE.slice(0, 3).map((c) => c.header)).toEqual(['cliente', 'Mes/Trimestre', 'FLIT']);
  });

  it('sellada, facturada o estimada exportan sus valores igual: ya no hay columna «Liquidación» (HU #12536)', () => {
    // Mutante «sin sellar → dinero vacío»: el estimado es lo que Financiero cuadra.
    expect(celda(fila({ estadoLiquidacion: 'liquidado' }), 'soat')).toBe(450000);
    expect(celda(fila({ estadoLiquidacion: 'facturado' }), 'soat')).toBe(450000);
    expect(celda(fila({ sellada: false, estadoLiquidacion: null }), 'soat')).toBe(450000);
    expect(COLUMNAS_EXPORT_DETALLE.map((c) => c.key)).not.toContain('liquidacion');
  });

  it('la fecha de aprobación sale como Date del DÍA en UTC, que es lo que Excel ordena y filtra', () => {
    // Con el instante completo Excel enseñaría la hora; con texto no dejaría ordenar por fecha.
    const v = celda(fila(), 'fechaAprobacion');
    expect(v).toBeInstanceOf(Date);
    expect((v as Date).toISOString()).toBe('2026-07-14T00:00:00.000Z');
  });

  it('un trámite sin aprobar deja la celda vacía (null), y con ella Filtromes y Mes/Trimestre', () => {
    const f = filasExcelDetalle([fila({ fechaAprobacion: null, mes: null, trimestre: null })])[0]!;
    expect(f.fechaAprobacion).toBeNull();
    // Mutante «?? ''» en filtromes o mesTrimestre: dejaría de ser null.
    expect(f.filtromes).toBeNull();
    expect(f.mesTrimestre).toBeNull();
  });

  it('un concepto no configurado sale vacío, no como cero; Columna2 y Factura Terceros también van vacías', () => {
    // Un cero en la hoja se sumaría y cuadraría un total que no existe.
    const f = filasExcelDetalle([fila({ logistica: null, noConfigurados: ['Logística'] })])[0]!;
    // Mutante «Columna1 ← tramiteDigital»: sería 200000, no null.
    expect(f.columna1).toBeNull();
    expect(f.columna2).toBeNull();
    expect(f.facturaTerceros).toBeNull();
    expect(Object.values(f).filter((c) => c === 0)).toHaveLength(0);
    expect(Object.values(f).filter((c) => c === '')).toHaveLength(0);
  });

  it('un texto con el separador o comillas va tal cual: en xlsx no hay nada que escapar', () => {
    const f = filasExcelDetalle([fila({ empresa: 'GÓMEZ; HIJOS', placa: 'A"B' })])[0]!;
    expect(f.cliente).toBe('GÓMEZ; HIJOS');
    expect(f.placa).toBe('A"B');
    // Mutante «Placa2 ← vin»: la placa duplicada es la misma placa.
    expect(f.placa2).toBe('A"B');
  });

  it('«Modelo» es la LÍNEA del vehículo y «Columna1» la logística, como en el Excel de Financiero', () => {
    const f = filasExcelDetalle([fila({ marca: 'RENAULT', linea: 'LOGAN', logistica: 17000 })])[0]!;
    // Mutante «Modelo ← marca»: saldría RENAULT.
    expect(f.modelo).toBe('LOGAN');
    expect(f.columna1).toBe(17000);
    // Mutante «Marca sigue en el archivo»: no hay clave para ella.
    expect(COLUMNAS_EXPORT_DETALLE.map((c) => c.key)).not.toContain('marca');
    expect(COLUMNAS_EXPORT_DETALLE.find((c) => c.key === 'modelo')?.header).toBe('Modelo');
    expect(COLUMNAS_EXPORT_DETALLE.find((c) => c.key === 'columna1')?.header).toBe('Columna1');
  });

  it('la lista de faltantes ya no viaja en el archivo (HU #12536): no hay clave queFalta', () => {
    const f = fila({ sellada: false, estadoLiquidacion: null, noConfigurados: ['Derecho de tránsito', 'Logística'] });
    expect(filasExcelDetalle([f])[0]).not.toHaveProperty('queFalta');
    expect(COLUMNAS_EXPORT_DETALLE.map((c) => c.header)).not.toContain('Qué falta para liquidar');
  });

  it('sin filas devuelve una lista vacía (la cabecera la pone sendExcel)', () => {
    expect(filasExcelDetalle([])).toEqual([]);
  });
});

describe('agruparEmpresas — el desplegable de empresas del filtro', () => {
  const MAESTRO = [
    { id: 1, nombre: 'RENTING S.A.S', documento: '811011779' },
    { id: 2, nombre: 'BANCOLOMBIA S.A.', documento: '890903938-8' },
  ];

  it('una empresa aparece UNA vez, aunque sus trámites traigan el NIT de dos maneras', () => {
    // El bicho: FLIT manda unas veces el NIT con dígito de verificación y otras sin él. El sync
    // solo empareja los exactos, así que la misma empresa salía dos veces en el desplegable: una
    // con su nombre y otra como un NIT crudo, y filtrar por una dejaba fuera la mitad de sus
    // trámites.
    const r = agruparEmpresas([
      { nit: '811011779', companiaId: 1 },
      { nit: '8110117795', companiaId: null },
    ], MAESTRO);

    expect(r).toHaveLength(1);
    expect(r[0].nombre).toBe('RENTING S.A.S');
    // Y elegirla filtra por sus dos escrituras, no solo por la que emparejó.
    expect(r[0].valor.split(',').sort()).toEqual(['811011779', '8110117795']);
  });

  it('empareja también cuando el dígito de verificación lo lleva el maestro', () => {
    const r = agruparEmpresas([{ nit: '890903938', companiaId: null }], MAESTRO);
    expect(r).toEqual([{ valor: '890903938', nombre: 'BANCOLOMBIA S.A.' }]);
  });

  it('el NIT con puntos y guion es el mismo NIT', () => {
    const r = agruparEmpresas([{ nit: '811.011.779', companiaId: null }], MAESTRO);
    expect(r).toEqual([{ valor: '811.011.779', nombre: 'RENTING S.A.S' }]);
  });

  it('no recorta un NIT de nueve dígitos: dos empresas distintas no pueden fundirse', () => {
    // Quitar el último dígito a un documento que ya es la raíz cruzaría empresas que solo se
    // parecen. Solo se prueba a quitarlo cuando hay diez o más.
    const r = agruparEmpresas([{ nit: '811011770', companiaId: null }], MAESTRO);
    expect(r).toHaveLength(1);
    expect(r[0].nombre).toContain('sin empresa registrada');
  });

  it('un NIT sin empresa dada de alta se rotula como tal, no como si fuera un nombre', () => {
    const r = agruparEmpresas([{ nit: '900077718', companiaId: null }], []);
    expect(r).toEqual([{ valor: '900077718', nombre: 'NIT 900077718 (sin empresa registrada)' }]);
  });

  it('manda el emparejamiento del sync sobre el del NIT', () => {
    // Si el sync ya dijo de quién es el trámite, esa es la empresa: el NIT normalizado es solo el
    // recurso para los que se quedaron sin emparejar.
    const r = agruparEmpresas([{ nit: '890903938', companiaId: 1 }], MAESTRO);
    expect(r[0].nombre).toBe('RENTING S.A.S');
  });

  it('sale ordenado por nombre, que es como se busca en una lista', () => {
    const r = agruparEmpresas([
      { nit: '811011779', companiaId: 1 },
      { nit: '890903938-8', companiaId: 2 },
    ], MAESTRO);
    expect(r.map((e) => e.nombre)).toEqual(['BANCOLOMBIA S.A.', 'RENTING S.A.S']);
  });
});

// ───────── HU #12374: el reporte resuelve la tarifa por la FECHA DE APROBACIÓN (RN-07) ─────────
//
// Se afirma sobre el SQL RENDERIZADO y no sobre el mock: el mock `chain` devuelve la fila entera y
// descarta las condiciones del join, así que un `vigente_hasta IS NULL` fantasma (o un `now()` a
// secas: mutante M1) pasaría en verde. El fragmento que se busca es el MISMO que renderiza
// `vigenteEn` en flito-tarifas.test.ts: es la guarda de paridad reporte ↔ compuerta (AC7).

const VIGENTE_EN = (a: string) =>
  `tstzrange("${a}"."vigente_desde", "${a}"."vigente_hasta", '[)') @> COALESCE("flito_tramites"."fecha_aprobacion", now())::timestamptz`;

describe('conJoins — la tarifa estimada es la vigencia que CONTIENE la fecha de aprobación (HU #12374)', () => {
  const q = () => conJoins(new QueryBuilder().select({ id: flitoTramites.id }).from(flitoTramites).$dynamic());

  it('exactamente DOS alias de vigencia (td, lg) contra flito_tarifas_vigencias; los _esp/_gen del modelo viejo ya no existen', () => {
    const { sql } = q().toSQL();
    expect(sql.match(/"flito_tarifas_vigencias" "/g)).toHaveLength(2);
    expect(sql).toContain('"flito_tarifas_vigencias" "td"');
    expect(sql).toContain('"flito_tarifas_vigencias" "lg"');
    for (const viejo of ['td_esp', 'td_gen', 'lg_esp', 'lg_gen']) expect(sql).not.toContain(`"${viejo}"`);
    expect(sql).not.toContain('flito_tarifas_compania');
    expect(sql).not.toMatch(/"(td|lg)"\."activo"/);
  });

  it('cada alias casa la vigencia que contiene COALESCE(fecha_aprobacion, now()) en rango [), no la abierta ni la de ahora (AC1, AC2, AC6; mutantes M1 y M3)', () => {
    const { sql, params } = q().toSQL();
    expect(sql).toContain(VIGENTE_EN('td'));
    expect(sql).toContain(VIGENTE_EN('lg'));
    // Ni «abierta» (el modelo del eslabón 1) ni «ahora» a secas (M1): la referencia es la aprobación.
    expect(sql).not.toMatch(/"(td|lg)"\."vigente_hasta" IS NULL/);
    expect(sql).not.toMatch(/@> now\(\)::timestamptz/);
    // La referencia es columna + now(): NINGÚN Date viaja como parámetro (Drizzle no deduplica literales).
    expect(params.filter((p) => p instanceof Date)).toHaveLength(0);
  });

  it('la llave: trámite digital por tipo normalizado del trámite, logística sin tipo (RN-02, RN-03)', () => {
    const { sql } = q().toSQL();
    expect(sql).toMatch(/"td"\."concepto" = 'tramite_digital'/);
    expect(sql).toMatch(/"td"\."tipo_tramite" = UPPER\(TRIM\(COALESCE\("flito_tramites"\."tipo_tramite", ''\)\)\)/);
    expect(sql).toMatch(/"lg"\."concepto" = 'logistica'/);
    expect(sql).toMatch(/"lg"\."tipo_tramite" IS NULL/);
  });

  it('AC10 (forma estática): la cola de listos/incompletos lee el MISMO alias del join, sin segunda definición', () => {
    const listo = renderizar(and(...condiciones({ etapa: 'listo' }))!).sql;
    const incompleto = renderizar(and(...condiciones({ etapa: 'incompleto' }))!).sql;
    for (const sql of [listo, incompleto]) {
      // Desde la HU #12653 la tarifa va dentro de COALESCE(documental, tarifa): sigue siendo el alias del join.
      expect(sql).toContain('"td"."valor") IS NULL');
      expect(sql).toContain('"lg"."valor") IS NULL');
      expect(sql).not.toMatch(/COALESCE\("td_esp"|COALESCE\("lg_esp"/);
    }
  });
});

// ── HU #12653 — el valor documental manda en trámite digital y logística (viaje 1) ──────────────

describe('HU #12653 — COALESCE(documental, tarifa) en las expresiones compartidas por tabla, totales, consolidado y Excel', () => {
  const { EXPR_DIGITAL, EXPR_LOGISTICA, EXPR_LOGISTICA_ESTIMADA, EXPR_INCOMPLETA, SELECT_FILA, SELECT_TOTALES } = servicio;
  const enReporte = (expr: unknown) =>
    conJoins(new QueryBuilder().select({ x: expr as never }).from(flitoTramites).$dynamic()).toSQL().sql
      .replace(/^select /, '').split(' from "flito_tramites"')[0]!;
  const DOC = (concepto: string) =>
    `(select "flito_comprobantes"."valor" from "flito_comprobantes" where "flito_comprobantes"."tramite_id" = "flito_tramites"."id" and "flito_comprobantes"."concepto" = '${concepto}' and "flito_comprobantes"."estado" = 'aplicado' and "flito_comprobantes"."es_pago" = true limit 1)`;
  const VIAJES = 'COALESCE((SELECT SUM("flito_tramite_viajes_logistica"."valor") FROM "flito_tramite_viajes_logistica" WHERE "flito_tramite_viajes_logistica"."tramite_id" = "flito_tramites"."id"), 0)';

  it('AC1 (mutante 4): EXPR_DIGITAL = sellada, si no COALESCE(documental, "td"."valor") — el documental PRIMERO', () => {
    expect(enReporte(EXPR_DIGITAL)).toBe(`CASE WHEN "flito_liquidaciones"."id" IS NOT NULL THEN "flito_liquidaciones"."valor_tramite_digital"
  ELSE COALESCE(${DOC('tramite_digital')}, "td"."valor") END`);
    expect(enReporte(SELECT_FILA.tramiteDigital)).toBe(enReporte(EXPR_DIGITAL));
    expect(enReporte(SELECT_TOTALES.tramiteDigital)).toBe(`COALESCE(SUM(${enReporte(EXPR_DIGITAL)}), 0)`);
  });

  it('AC2/AC3 (mutante 9): RAMAS_LOGISTICA_ESTIMADA = WHEN NOT gestiona THEN NULL, y DESPUÉS ELSE COALESCE(documental, "lg"."valor") + Σ viajes; compartida con gastos diarios', () => {
    const rama = `WHEN NOT (NOT COALESCE("clients"."logistica_autogestionable", false) OR ("flito_excepciones_autogestion"."id" IS NOT NULL)) THEN NULL
  ELSE COALESCE(${DOC('logistica')}, "lg"."valor") + ${VIAJES} END`;
    expect(enReporte(EXPR_LOGISTICA)).toBe(`CASE WHEN "flito_liquidaciones"."id" IS NOT NULL THEN "flito_liquidaciones"."valor_logistica"
  ${rama}`);
    expect(enReporte(EXPR_LOGISTICA_ESTIMADA)).toBe(`CASE ${rama}`);
    expect(enReporte(SELECT_TOTALES.logistica)).toBe(`COALESCE(SUM(${enReporte(EXPR_LOGISTICA)}), 0)`);
  });

  it('AC1: BLOQUEA_DIGITAL y BLOQUEA_LOGISTICA usan el mismo COALESCE (tarifa NULL + documental ⇒ no bloquea)', () => {
    const incompleta = enReporte(EXPR_INCOMPLETA);
    expect(incompleta).toContain(`OR COALESCE(${DOC('tramite_digital')}, "td"."valor") IS NULL`);
    expect(incompleta).toContain(`AND COALESCE(${DOC('logistica')}, "lg"."valor") IS NULL)`);
    expect(incompleta).not.toMatch(/OR "td"\."valor" IS NULL|AND "lg"\."valor" IS NULL/);
  });

  it('AC5: condiciones({ conDiferencias: true }) añade el EXISTS sin parámetros y se compone; ausente no lo añade', () => {
    const q = renderizar(and(...condiciones({ conDiferencias: true, etapa: 'facturado' }))!);
    expect(q.sql).toContain(`EXISTS (SELECT 1 FROM "flito_comprobantes"`);
    expect(q.sql).toContain(`AND "flito_comprobantes"."marcado_por_diferencia" = true
    AND "flito_comprobantes"."diferencia_aceptada_por_id" IS NULL)`);
    expect(q.sql).toContain(`"flito_liquidaciones"."estado" = 'facturado'`);
    expect(q.params).toEqual([]);
    expect(renderizar(and(...condiciones({ etapa: 'facturado' }))!).sql).not.toContain('flito_comprobantes');
  });
});
