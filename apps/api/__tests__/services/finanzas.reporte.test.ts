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

const { aCsv, agruparEmpresas, CABECERAS_CSV, condiciones, conJoins } = await import('../../src/modules/finanzas/finanzas.service.js');
const { flitoTramites } = await import('../../src/db/schema.js');
const { and } = await import('drizzle-orm');
const { renderizar } = await import('../helpers/sql-ligado.js');

type Fila = Parameters<typeof aCsv>[0][number];

function fila(over: Partial<Fila> = {}): Fila {
  return {
    tramiteId: 't1', idFlit: 'FLIT-1', placa: 'ABC123', estado: 'Aprobado', empresa: 'ACME',
    vin: 'VIN1', marca: 'CHEVROLET', linea: 'ONIX',
    tipoTramite: 'Traspaso', fechaAprobacion: '2026-07-14T15:30:00.000Z',
    fechaCreacion: '2026-07-01T10:00:00.000Z',
    soat: 450000, impuesto: 120000, derechoTramite: 80000,
    logistica: 15000, tramiteDigital: 200000, gmf: 3460, total: 868460,
    sellada: true, estadoLiquidacion: 'liquidado', noConfigurados: [],
    sinRecibo: [], pendientesPago: [], autogestionados: [], noAplican: [],
    estadoFacturacion: 'no_enviado', facturaNumero: null, facturaRequiereRevision: false,
    soatConciliado: false, boletaReferencia: null, soatConciliadoEn: null,
    // HU #12432 — titular, organismo, periodo y subtotales.
    titularNombres: 'ANA MARÍA', titularApellidos: 'PÉREZ', titularRazonSocial: null,
    titularTipoDocumento: 'CC', titularDocumento: '1020304050',
    organismoCodigo: '05266', organismoNombre: 'Envigado', mes: '2026-07', trimestre: '2026-T3',
    totalReintegro: 668460, totalServicio: 200000,
    ...over,
  } as Fila;
}

/** La celda de UNA fila del CSV por el NOMBRE de su cabecera: el índice se lee de la cabecera real. */
const columna = (csv: string, cabecera: (typeof CABECERAS_CSV)[number], linea = 1): string =>
  csv.trim().split('\r\n')[linea].split(';')[CABECERAS_CSV.indexOf(cabecera)];

describe('aCsv — el archivo que abre contabilidad', () => {
  it('usa punto y coma y BOM, que es lo que Excel en español abre sin asistente', () => {
    const csv = aCsv([fila()]);
    expect(csv.startsWith('﻿')).toBe(true);
    // HU #12432: la sección de identificación abre el archivo; «Flit» es el identificador del trámite.
    expect(csv.split('\r\n')[0]).toContain('Empresa;Flit;Placa');
  });

  it('distingue sellado, facturado y estimado', () => {
    const csv = aCsv([
      fila({ estadoLiquidacion: 'liquidado' }),
      fila({ estadoLiquidacion: 'facturado' }),
      fila({ sellada: false, estadoLiquidacion: null }),
    ]);
    const filas = csv.trim().split('\r\n').slice(1);
    expect(filas[0]).toContain('Liquidado');
    expect(filas[1]).toContain('Facturado');
    expect(filas[2]).toContain('Estimado');
  });

  it('la fecha de aprobación sale como día, que es lo que Excel reconoce', () => {
    // Con el instante completo Excel lo trata como texto y no deja ordenar ni filtrar por fecha.
    const csv = aCsv([fila()]);
    expect(csv.split('\r\n')[0]).toContain('Aprobado');
    expect(columna(csv, 'Aprobado')).toBe('2026-07-14');
    expect(csv).not.toContain('T15:30:00');
  });

  it('un trámite sin aprobar deja la celda vacía', () => {
    const csv = aCsv([fila({ fechaAprobacion: null })]);
    expect(columna(csv, 'Aprobado')).toBe('');
  });

  it('un concepto no configurado sale vacío, no como cero', () => {
    // Un cero en el CSV se sumaría en la hoja de cálculo y cuadraría un total que no existe.
    const csv = aCsv([fila({ tramiteDigital: null, noConfigurados: ['Trámite digital'] })]);
    const celdas = csv.trim().split('\r\n')[1].split(';');
    expect(celdas).toContain('');
    expect(csv).toContain('Trámite digital');
    expect(celdas.filter((c) => c === '0')).toHaveLength(0);
  });

  it('escapa las comillas y entrecomilla lo que lleva el separador', () => {
    // Una empresa llamada «GÓMEZ; HIJOS» partiría la fila en dos columnas sin esto.
    const csv = aCsv([fila({ empresa: 'GÓMEZ; HIJOS', placa: 'A"B' })]);
    expect(csv).toContain('"GÓMEZ; HIJOS"');
    expect(csv).toContain('"A""B"');
  });

  it('lista los conceptos sin configurar en su propia columna', () => {
    const csv = aCsv([fila({ sellada: false, estadoLiquidacion: null, noConfigurados: ['Derecho de tránsito', 'Logística'] })]);
    expect(csv).toContain('Derecho de tránsito | Logística');
  });

  it('la columna de faltantes recoge los tres motivos, no solo las tarifas', () => {
    // A quien concilia le da igual si lo que falta es una tarifa, un recibo o un pago: lo que
    // necesita es la lista completa de lo que hay que resolver para poder liquidar.
    const csv = aCsv([fila({
      sellada: false, estadoLiquidacion: null,
      noConfigurados: ['Logística'], sinRecibo: ['Derecho de tránsito'], pendientesPago: ['SOAT'],
    })]);
    expect(csv.split('\r\n')[0]).toContain('Qué falta para liquidar');
    expect(csv).toContain('Logística | Derecho de tránsito | SOAT');
  });

  it('sin filas devuelve solo la cabecera', () => {
    expect(aCsv([]).trim().split('\r\n')).toHaveLength(1);
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
      expect(sql).toContain('"td"."valor" IS NULL');
      expect(sql).toContain('"lg"."valor" IS NULL');
      expect(sql).not.toMatch(/COALESCE\("td_esp"|COALESCE\("lg_esp"/);
    }
  });
});
