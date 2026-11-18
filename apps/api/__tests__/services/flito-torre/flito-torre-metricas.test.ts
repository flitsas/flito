// Torre de Control Gerencial (Épica #14590, ADR-0043) — motor de métricas y ficha de placa: las 8 preguntas de negocio
// contra PostgreSQL real (transacción con ROLLBACK, `torre-pg.ts`; se saltan sin TEST_DATABASE_URL) y, sin base, los
// topes de rango, el permiso de dinero y la resolución de presets en Bogotá.
// ADR-0044 (bloque ii): fecha base por métrica (RN-TOR-M10 a M14), clave de caché con la fecha base resuelta y las
// liquidaciones de trámites anulados/revocados fuera de costo e ingreso (RN-TOR-L1).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/db/client.js', async () => ({ db: (await import('./torre-pg.js')).dbProxy, getPoolStats: vi.fn() }));
const redis = { cliente: null as null | { get: () => Promise<string | null>; set: () => Promise<unknown> } };
vi.mock('../../../src/shared/redis.js', () => ({ getRedis: () => redis.cliente, closeRedis: vi.fn(), redisHealthy: vi.fn() }));

const { abrirTx, cerrarBase, cerrarTx, sembrador, placaNueva, URL_BASE } = await import('./torre-pg.js');
const { consultarMetrica, rangoDeConsulta, TorreDineroDenegadoError } = await import('../../../src/modules/flito-torre/flito-torre.metricas.service.js');
const { TorreConsultaInvalidaError } = await import('../../../src/modules/flito-torre/flito-torre.service.js');
const { RangoTorreExcedidoError, exigirTopesRango, resolverRango } = await import('../../../src/modules/flito-torre/flito-torre.filtro.js');
const { buscarPlaca, enmascararVin, PlacaTorreNoEncontradaError } = await import('../../../src/modules/flito-torre/flito-torre.placa.service.js');
const { libroMetrica, nombreArchivoTorre } = await import('../../../src/modules/flito-torre/flito-torre.export.js');
import type { AlcanceResuelto } from '../../../src/shared/middleware/frontera-enlace.js';

const TODO: AlcanceResuelto = { enlace: 'ninguno' };
const HOY = '2035-03-20';
const OP = { dinero: true, hoy: HOY };
const MARZO = { desde: '2035-03-01', hasta: '2035-03-31' };

describe('rango y topes (sin base)', () => {
  it('presets en días de Bogotá', () => {
    expect(resolverRango({ preset: 'hoy' }, HOY)).toEqual({ desde: HOY, hasta: HOY });
    expect(resolverRango({ preset: 'ayer' }, HOY)).toEqual({ desde: '2035-03-19', hasta: '2035-03-19' });
    expect(resolverRango({ preset: 'mes_anterior' }, HOY)).toEqual({ desde: '2035-02-01', hasta: '2035-02-28' });
    expect(resolverRango({ preset: 'trimestre' }, '2035-05-07')).toEqual({ desde: '2035-04-01', hasta: '2035-05-07' });
    expect(resolverRango({ preset: 'semana' }, HOY)).toEqual({ desde: '2035-03-19', hasta: HOY }); // lunes 19
  });

  it('tope: 24 meses de rango y 366 días si se agrupa por día → RangoTorreExcedidoError', () => {
    expect(() => exigirTopesRango({ desde: '2033-01-01', hasta: '2034-12-31' })).not.toThrow();
    expect(() => exigirTopesRango({ desde: '2033-01-01', hasta: '2035-01-01' })).toThrow(RangoTorreExcedidoError);
    expect(() => exigirTopesRango({ desde: '2034-01-01', hasta: '2035-01-01' }, 'dia')).not.toThrow(); // 366 días
    expect(() => exigirTopesRango({ desde: '2034-01-01', hasta: '2035-01-02' }, 'dia')).toThrow(RangoTorreExcedidoError);
  });

  it('el motor rechaza el rango excedido ANTES de consultar la base', async () => {
    await expect(consultarMetrica({ metrica: 'tramites_creados', filtro: { rango: { desde: '2030-01-01', hasta: '2035-01-01' } } }, TODO, OP))
      .rejects.toBeInstanceOf(RangoTorreExcedidoError);
  });

  it('métrica de dinero sin FUNCION_TORRE_DINERO → TorreDineroDenegadoError (403), sin tocar la base', async () => {
    for (const metrica of ['costo_logistica', 'impuestos_pagados', 'derechos_pagados', 'ingreso_liquidado', 'sin_facturar'] as const) {
      await expect(consultarMetrica({ metrica, filtro: { rango: MARZO } }, TODO, { dinero: false, hoy: HOY }))
        .rejects.toBeInstanceOf(TorreDineroDenegadoError);
    }
  });

  it('VIN enmascarado: solo los 4 últimos; el archivo de exportación no lleva placa ni NIT', () => {
    expect(enmascararVin('9BWZZZ377VT004251')).toBe('*************4251');
    expect(enmascararVin(null)).toBeNull();
    expect(nombreArchivoTorre({ metrica: 'costo_logistica', filtro: { rango: MARZO, companiaIds: [7] } }, HOY))
      .toBe('torre-costo-logistica-aprobacion-2035-03-01_2035-03-31.xlsx');
    expect(nombreArchivoTorre({ metrica: 'tramites', fechaBase: 'facturacion', agrupacion: 'compania', agrupacionColumnas: 'mes', filtro: { rango: MARZO } }, HOY))
      .toBe('torre-tramites-facturacion-2035-03-01_2035-03-31-cruce.xlsx');
    expect(nombreArchivoTorre({ metrica: 'wip_activo', filtro: { rango: MARZO } }, HOY)).toBe('torre-wip-activo-actual.xlsx');
  });

  it('RN-TOR-M10/M11: el motor vuelve a exigir la matriz medida × fecha base (400), sin tocar la base', async () => {
    for (const [metrica, fechaBase] of [
      ['tiempo_creacion_aprobacion', 'creacion'], ['impuestos_pagados', 'facturacion'], ['wip_activo', 'creacion'],
      ['sin_facturar', 'facturacion'], ['tramites', 'pago'],
    ] as const) {
      await expect(consultarMetrica({ metrica, fechaBase, filtro: { rango: MARZO } }, TODO, OP)).rejects.toBeInstanceOf(TorreConsultaInvalidaError);
    }
  });

  it('RN-TOR-F5: el preset ultimos_6m llega al motor como 1-jun … hoy (18-nov), con la fecha base que se pida', () => {
    for (const fechaBase of ['creacion', 'aprobacion', 'facturacion'] as const) {
      expect(rangoDeConsulta({ metrica: 'tramites', fechaBase, filtro: { rango: { preset: 'ultimos_6m' } } }, '2026-11-18'))
        .toEqual({ desde: '2026-06-01', hasta: '2026-11-18' });
    }
    expect(rangoDeConsulta({ metrica: 'wip_activo', filtro: { rango: { preset: 'ultimos_6m' } } }, '2026-11-18')).toBeNull();
  });
});

describe.skipIf(!URL_BASE)('fecha base y RN-TOR-L1 contra PostgreSQL (tx con ROLLBACK)', () => {
  let s: ReturnType<typeof sembrador>;
  beforeEach(async () => { s = sembrador(await abrirTx()); await s.organismos('05001'); redis.cliente = null; });
  afterEach(cerrarTx);
  afterAll(cerrarBase);

  it('RN-TOR-M10: sin fechaBase, `tramites` da lo mismo que `tramites_creados` (defecto = creación) y lo declara', async () => {
    const x = await s.cia('X');
    await s.tramite({ cia: x, creadoFlit: '2035-03-03T15:00:00Z' });
    await s.tramite({ cia: x, creadoFlit: null, creadoSync: '2035-03-04T15:00:00Z' });
    await s.tramite({ cia: x, creadoFlit: '2035-04-03T15:00:00Z' });
    const f = { rango: MARZO, companiaIds: [x] };
    const neutra = await consultarMetrica({ metrica: 'tramites', filtro: f }, TODO, OP);
    const legado = await consultarMetrica({ metrica: 'tramites_creados', filtro: f }, TODO, OP);
    const explicita = await consultarMetrica({ metrica: 'tramites', fechaBase: 'creacion', filtro: f }, TODO, OP);
    expect(neutra.total).toEqual(legado.total);
    expect(explicita.total).toEqual(legado.total);
    expect(neutra.total.valor).toBe(2);
    expect(neutra.baseFecha).toMatchObject({ campo: 'fecha_creacion_flit', fechaBase: 'creacion', nBaseSincronizacion: 1 });
  });

  it('RN-TOR-M13: `tramites` + aprobación ≡ `tramites_aprobados`, sin mirar flit_estado; «siguen en Aprobado» es el filtro', async () => {
    const x = await s.cia('X');
    await s.tramite({ cia: x, aprobado: '2035-03-05T15:00:00Z' });                          // Aprobado
    await s.tramite({ cia: x, aprobado: '2035-03-06T15:00:00Z', flitEstado: 'Anulado' });   // aprobado y luego anulado
    await s.tramite({ cia: x, aprobado: null, creadoFlit: '2035-03-07T15:00:00Z' });
    const f = { rango: MARZO, companiaIds: [x] };
    const neutra = await consultarMetrica({ metrica: 'tramites', fechaBase: 'aprobacion', filtro: f }, TODO, OP);
    const legado = await consultarMetrica({ metrica: 'tramites_aprobados', filtro: f }, TODO, OP);
    expect(neutra.total).toEqual(legado.total);
    expect(neutra.total.valor).toBe(2);
    expect(neutra.baseFecha).toMatchObject({ campo: 'fecha_aprobacion', fechaBase: 'aprobacion', nBaseSincronizacion: 0 });
    const siguen = await consultarMetrica({ metrica: 'tramites', fechaBase: 'aprobacion', filtro: { ...f, flitEstados: ['Aprobado'] } }, TODO, OP);
    expect(siguen.total.valor).toBe(1);
  });

  it('RN-TOR-M14: facturación = primera factura ACTIVA; la inactiva no cuenta y dos conceptos cuentan una vez', async () => {
    const x = await s.cia('X');
    const dosConceptos = await s.tramite({ cia: x, aprobado: '2035-02-01T15:00:00Z' });
    await s.factura(dosConceptos, { creada: '2035-03-05T15:00:00Z', concepto: 'tramite' });
    await s.factura(dosConceptos, { creada: '2035-03-10T15:00:00Z', concepto: 'soat' });
    const soloInactiva = await s.tramite({ cia: x, aprobado: '2035-02-01T15:00:00Z' });
    await s.factura(soloInactiva, { creada: '2035-03-07T15:00:00Z', activo: false });
    const primeraManda = await s.tramite({ cia: x, aprobado: '2035-02-01T15:00:00Z' });
    await s.factura(primeraManda, { creada: '2035-03-02T15:00:00Z', activo: false });
    await s.factura(primeraManda, { creada: '2035-04-01T15:00:00Z', concepto: 'soat' });
    const deFebrero = await s.tramite({ cia: x, aprobado: '2035-02-01T15:00:00Z' });
    await s.factura(deFebrero, { creada: '2035-02-25T15:00:00Z', concepto: 'tramite' });
    await s.factura(deFebrero, { creada: '2035-03-15T15:00:00Z', concepto: 'soat' });
    await s.liquidacion(dosConceptos, { total: 100_000, logistica: 30_000 });
    await s.liquidacion(soloInactiva, { total: 999_000, logistica: 999_000 });

    const f = { rango: MARZO, companiaIds: [x] };
    const r = await consultarMetrica({ metrica: 'tramites', fechaBase: 'facturacion', filtro: f }, TODO, OP);
    expect(r.total.valor).toBe(1);
    expect(r.baseFecha.fechaBase).toBe('facturacion');
    const porMes = await consultarMetrica({ metrica: 'tramites', fechaBase: 'facturacion', agrupacion: 'mes', filtro: { rango: { desde: '2035-02-01', hasta: '2035-04-30' }, companiaIds: [x] } }, TODO, OP);
    expect(porMes.filas.map((g) => [g.clave, g.valor])).toEqual([['2035-02', 1], ['2035-03', 1], ['2035-04', 1]]);
    expect((await consultarMetrica({ metrica: 'ingreso_liquidado', fechaBase: 'facturacion', filtro: f }, TODO, OP)).total.valor).toBe(100_000);
    expect((await consultarMetrica({ metrica: 'costo_logistica', fechaBase: 'facturacion', filtro: f }, TODO, OP)).total.valor).toBe(30_000);
    // Por aprobación (defecto) los cuatro son de febrero: en marzo no hay ingreso.
    expect((await consultarMetrica({ metrica: 'ingreso_liquidado', filtro: f }, TODO, OP)).total.valor).toBe(0);
  });

  it('RN-TOR-L1: costo e ingreso no suman las liquidaciones de Anulado ni Revocado; Rechazado y flit_estado nulo sí', async () => {
    const x = await s.cia('X');
    await s.cuartetoL1(x, { aprobado: '2035-03-05T15:00:00Z', total: 100_000, logistica: 10_000 });
    const f = { rango: MARZO, companiaIds: [x] };
    const ingreso = await consultarMetrica({ metrica: 'ingreso_liquidado', agrupacion: 'flit_estado', filtro: f }, TODO, OP);
    expect(ingreso.total).toMatchObject({ valor: 200_000, n: 2 });
    expect(ingreso.filas.map((g) => g.etiqueta).sort()).toEqual(['Rechazado', 'Sin estado']);
    const costo = await consultarMetrica({ metrica: 'costo_logistica', filtro: f }, TODO, OP);
    expect(costo.total).toMatchObject({ valor: 20_000, n: 2 });
    // sin_facturar es un conteo de trámites: no cambia (los cuatro siguen sin facturar).
    expect((await consultarMetrica({ metrica: 'sin_facturar', filtro: f }, TODO, OP)).total.valor).toBe(4);
  });

  it('caché: la clave lleva la fecha base RESUELTA y las columnas (defecto ≡ explícita; otra fecha o cruce = otra clave)', async () => {
    const claves: string[] = [];
    redis.cliente = { get: async () => null, set: async (k: string) => { claves.push(k); return 'OK'; } } as never;
    const x = await s.cia('X');
    const f = { rango: MARZO, companiaIds: [x] };
    await consultarMetrica({ metrica: 'tramites', agrupacion: 'compania', filtro: f }, TODO, OP);
    await consultarMetrica({ metrica: 'tramites', fechaBase: 'creacion', agrupacion: 'compania', filtro: f }, TODO, OP);
    await consultarMetrica({ metrica: 'tramites', fechaBase: 'aprobacion', agrupacion: 'compania', filtro: f }, TODO, OP);
    await consultarMetrica({ metrica: 'tramites', agrupacion: 'compania', agrupacionColumnas: 'mes', filtro: f }, TODO, OP);
    expect(claves).toHaveLength(4);
    expect(claves[0]).toBe(claves[1]);
    expect(new Set(claves).size).toBe(3);
  });
});

describe.skipIf(!URL_BASE)('motor de métricas contra PostgreSQL (tx con ROLLBACK)', () => {
  let s: ReturnType<typeof sembrador>;
  beforeEach(async () => { s = sembrador(await abrirTx()); await s.organismos('05001', '11001'); redis.cliente = null; });
  afterEach(cerrarTx);
  afterAll(cerrarBase);

  it('P1 · aprobados HOY por la compañía X (día de Bogotá, no de UTC)', async () => {
    const x = await s.cia('X'); const y = await s.cia('Y');
    await s.tramite({ cia: x, aprobado: '2035-03-20T15:00:00Z' });
    await s.tramite({ cia: x, aprobado: '2035-03-21T03:30:00Z' }); // 20-mar 22:30 en Bogotá
    await s.tramite({ cia: x, aprobado: '2035-03-20T04:00:00Z' }); // 19-mar 23:00 en Bogotá: ayer
    await s.tramite({ cia: x, aprobado: null });
    await s.tramite({ cia: y, aprobado: '2035-03-20T15:00:00Z' });
    const r = await consultarMetrica({ metrica: 'tramites_aprobados', filtro: { rango: { preset: 'hoy' }, companiaIds: [x] } }, TODO, OP);
    expect(r.total.valor).toBe(2);
    expect(r.baseFecha.campo).toBe('fecha_aprobacion');
  });

  it('P3 · lapso, mediana y p90 de N aprobados de X; excluye y cuenta los que no tienen fecha_creacion_flit', async () => {
    const x = await s.cia('X');
    const creado = '2035-03-01T12:00:00Z';
    const placas: string[] = [];
    for (const horas of [24, 48, 72, 96, 240]) {
      const placa = placaNueva(); placas.push(placa);
      await s.tramite({ cia: x, creadoFlit: creado, placa, aprobado: new Date(Date.parse(creado) + horas * 3_600_000).toISOString() });
    }
    await s.tramite({ cia: x, creadoFlit: null, creadoSync: '2035-01-01T00:00:00Z', aprobado: '2035-03-10T12:00:00Z' });
    const r = await consultarMetrica({ metrica: 'tiempo_creacion_aprobacion', filtro: { rango: MARZO, companiaIds: [x] } }, TODO, OP);
    expect(r.total.n).toBe(5);
    expect(r.total.mediana).toBe(72);
    expect(r.total.p90).toBe(182.4); // percentile_cont: 96 + 0,6 × (240 − 96)
    expect(r.total.max).toBe(240);
    expect(r.total.lapsoHoras).toBe(240);
    expect(r.total.maximo?.placa).toBe(placas[4]);
    expect(r.baseFecha.excluidosSinFecha).toBe(1);
  });

  it('P5 · costo de logística de marzo de X = Σ valor_logistica; los viajes NO se suman otra vez', async () => {
    const x = await s.cia('X');
    const a = await s.tramite({ cia: x, aprobado: '2035-03-05T15:00:00Z' });
    const b = await s.tramite({ cia: x, aprobado: '2035-03-25T15:00:00Z' });
    const abril = await s.tramite({ cia: x, aprobado: '2035-04-02T15:00:00Z' });
    await s.liquidacion(a, { total: 300_000, logistica: 100_000 });
    await s.liquidacion(b, { total: 400_000, logistica: 150_000 }); // ya incluye el viaje adicional de 50.000
    await s.viaje(b, 2, 50_000);
    await s.liquidacion(abril, { total: 100_000, logistica: 90_000 });
    const r = await consultarMetrica({ metrica: 'costo_logistica', filtro: { rango: MARZO, companiaIds: [x] } }, TODO, OP);
    expect(r.total.valor).toBe(250_000);
    expect(r.total.n).toBe(2);
  });

  it('P6 · impuestos pagados al OT Y, por pagado_en, agrupados por organismo', async () => {
    const x = await s.cia('X');
    const t1 = await s.tramite({ cia: x }); const t2 = await s.tramite({ cia: x }); const t3 = await s.tramite({ cia: x });
    await s.impuesto({ tramiteId: t1, cia: x, organismo: '05001', valorPagado: 300_000, pagadoEn: '2035-03-10T15:00:00Z' });
    await s.impuesto({ tramiteId: t2, cia: x, organismo: '11001', valorPagado: 500_000, pagadoEn: '2035-03-11T15:00:00Z' });
    await s.impuesto({ tramiteId: t3, cia: x, organismo: '05001', valorPagado: 999_000, pagadoEn: null });
    const r = await consultarMetrica({ metrica: 'impuestos_pagados', agrupacion: 'organismo', filtro: { rango: MARZO, organismos: ['05001'], companiaIds: [x] } }, TODO, OP);
    expect(r.total.valor).toBe(300_000);
    expect(r.filas).toHaveLength(1);
    expect(r.filas[0]).toMatchObject({ clave: '05001', valor: 300_000, participacion: 100 });
  });

  it('P7 · derechos pagados en un rango, por fecha_pago [desde, hasta]', async () => {
    const x = await s.cia('X');
    for (const [valor, fecha] of [[100_000, '2035-03-01'], [50_000, '2035-03-31'], [70_000, '2035-04-01'], [10_000, '2035-02-28']] as const) {
      await s.derecho({ tramiteId: await s.tramite({ cia: x }), cia: x, organismo: '05001', valor, fechaPago: fecha });
    }
    const r = await consultarMetrica({ metrica: 'derechos_pagados', filtro: { rango: MARZO } }, TODO, OP);
    expect(r.total.valor).toBe(150_000);
  });

  it('P8 · matriculados por departamento; sin organismo → «Sin secretaría»', async () => {
    const x = await s.cia('X');
    const mat = 'Matrícula inicial';
    await s.tramite({ cia: x, tipo: mat, organismo: '05001', aprobado: '2035-03-05T15:00:00Z' });
    await s.tramite({ cia: x, tipo: mat, organismo: '05001', aprobado: '2035-03-06T15:00:00Z' });
    await s.tramite({ cia: x, tipo: mat, organismo: '11001', aprobado: '2035-03-07T15:00:00Z' });
    await s.tramite({ cia: x, tipo: mat, organismo: null, aprobado: '2035-03-07T15:00:00Z' });
    await s.tramite({ cia: x, tipo: 'Traspaso', organismo: '05001', aprobado: '2035-03-07T15:00:00Z' });
    const r = await consultarMetrica({ metrica: 'tramites_aprobados', agrupacion: 'departamento', filtro: { rango: MARZO, tiposTramite: ['matrícula inicial'] } }, TODO, OP);
    expect(r.total.valor).toBe(4);
    expect(r.filas.map((f) => [f.etiqueta, f.valor])).toEqual([['Antioquia', 2], ['Bogotá D.C.', 1], ['Sin secretaría', 1]]);
    expect(r.filas[0]!.participacion).toBe(50);
  });

  it('alcance: una compañía no ve la otra aunque la pida en el filtro', async () => {
    const x = await s.cia('X'); const y = await s.cia('Y');
    await s.tramite({ cia: x, aprobado: '2035-03-05T15:00:00Z' });
    await s.tramite({ cia: y, aprobado: '2035-03-05T15:00:00Z' });
    await s.tramite({ cia: y, aprobado: '2035-03-06T15:00:00Z' });
    const deY: AlcanceResuelto = { enlace: 'compania', companiaId: y };
    expect((await consultarMetrica({ metrica: 'tramites_aprobados', filtro: { rango: MARZO, companiaIds: [x] } }, deY, OP)).total.valor).toBe(0);
    expect((await consultarMetrica({ metrica: 'tramites_aprobados', filtro: { rango: MARZO } }, deY, OP)).total.valor).toBe(2);
    expect((await consultarMetrica({ metrica: 'tramites_aprobados', filtro: { rango: MARZO } }, { enlace: 'compania', companiaId: null }, OP)).total.valor).toBe(0);
  });

  it('«Sin compañía»: compania_id nulo es su propia fila y el total cuadra; nBaseSincronizacion cuenta el respaldo al created_at', async () => {
    const x = await s.cia('Equis');
    await s.tramite({ cia: x, creadoFlit: '2035-03-03T15:00:00Z' });
    await s.tramite({ cia: null, creadoFlit: null, creadoSync: '2035-03-04T15:00:00Z' });
    const r = await consultarMetrica({ metrica: 'tramites_creados', agrupacion: 'compania', filtro: { rango: MARZO } }, TODO, OP);
    expect(r.total.valor).toBe(2);
    expect(r.filas.find((f) => f.clave === 'sin')).toMatchObject({ etiqueta: 'Sin compañía', valor: 1 });
    expect(r.filas.find((f) => f.clave === String(x))?.etiqueta).toMatch(/^Equis/);
    expect(r.baseFecha.nBaseSincronizacion).toBe(1);
  });

  it('agrupación por mes en hora de Bogotá; si Redis falla se consulta la base igual', async () => {
    redis.cliente = { get: () => Promise.reject(new Error('caído')), set: () => Promise.reject(new Error('caído')) };
    const x = await s.cia('X');
    await s.tramite({ cia: x, aprobado: '2035-04-01T03:00:00Z' }); // 31-mar 22:00 en Bogotá
    await s.tramite({ cia: x, aprobado: '2035-04-01T06:00:00Z' });
    const r = await consultarMetrica({ metrica: 'tramites_aprobados', agrupacion: 'mes', filtro: { rango: { desde: '2035-03-01', hasta: '2035-04-30' }, companiaIds: [x] } }, TODO, OP);
    expect(r.filas.map((f) => [f.clave, f.valor])).toEqual([['2035-03', 1], ['2035-04', 1]]);
  });

  it('exportación: solo agregados + total, sin la placa del máximo', async () => {
    const x = await s.cia('X');
    await s.tramite({ cia: x, creadoFlit: '2035-03-01T12:00:00Z', aprobado: '2035-03-02T12:00:00Z', placa: 'ZQEXP1' });
    const { columnas, filas } = await libroMetrica({ metrica: 'tiempo_creacion_aprobacion', agrupacion: 'compania', filtro: { rango: MARZO, companiaIds: [x] } }, TODO, OP);
    expect(columnas.map((c) => c.key)).toEqual(['etiqueta', 'valor', 'n', 'participacion', 'mediana', 'p90', 'max']);
    expect(filas.at(-1)).toMatchObject({ etiqueta: 'Total', n: 1, mediana: 24 });
    expect(JSON.stringify(filas)).not.toContain('ZQEXP1');
  });
});

describe.skipIf(!URL_BASE)('ficha de placa contra PostgreSQL (tx con ROLLBACK)', () => {
  let s: ReturnType<typeof sembrador>;
  beforeEach(async () => { s = sembrador(await abrirTx()); await s.organismos('05001'); });
  afterEach(cerrarTx);
  afterAll(cerrarBase);

  it('P2 · duración de una placa: de la creación a la aprobación, con los pasos y la línea de tiempo', async () => {
    const x = await s.cia('X');
    const placa = placaNueva();
    const id = await s.tramite({ cia: x, placa, creadoFlit: '2035-03-01T15:00:00Z', aprobado: '2035-03-15T15:00:00Z', vin: '9BWZZZ377VT004251' });
    await s.historial(id, 'Asignado', 'Entregado', '2035-03-05T15:00:00Z');
    await s.historial(id, 'Entregado', 'Aprobado', '2035-03-15T15:00:00Z');
    const r = await buscarPlaca(placa.toLowerCase(), { enlace: 'ninguno' });
    expect(r.tramites).toHaveLength(1);
    const f = r.tramites[0]!;
    expect(f.tramiteUuid).toBe(id);
    expect(f.duracionHoras).toBe(336);
    expect(f.pasos).toMatchObject({ creado: '2035-03-01T15:00:00.000Z', radicado: '2035-03-05T15:00:00.000Z', aprobado: '2035-03-15T15:00:00.000Z', facturado: null });
    expect(f.lineaTiempo.map((h) => [h.anterior, h.estado])).toEqual([['Asignado', 'Entregado'], ['Entregado', 'Aprobado']]);
    expect(f.vinMascara).toBe('*************4251');
  });

  it('P4 · estado de una placa con varios trámites: lista del más reciente al más antiguo, estados sin valores', async () => {
    const x = await s.cia('X');
    const placa = placaNueva();
    const viejo = await s.tramite({ cia: x, placa, creadoFlit: '2035-01-01T15:00:00Z', aprobado: '2035-01-05T15:00:00Z', vin: `V1${placa}` });
    const nuevo = await s.tramite({ cia: x, placa, creadoFlit: '2035-03-01T15:00:00Z', flitEstado: 'Entregado', vin: `V2${placa}` });
    await s.impuesto({ tramiteId: nuevo, cia: x, organismo: '05001', valorPagado: 123_456, pagadoEn: '2035-03-02T15:00:00Z' });
    await s.liquidacion(viejo, { total: 500_000, logistica: 80_000 });
    await s.viaje(viejo, 2, 30_000);
    const r = await buscarPlaca(placa, { enlace: 'ninguno' }, new Date('2035-03-11T15:00:00Z'));
    expect(r.tramites.map((t) => t.tramiteUuid)).toEqual([nuevo, viejo]);
    const [n, v] = r.tramites;
    expect(n).toMatchObject({ flitEstado: 'Entregado', fechaAprobacion: null, duracionHoras: 240 });
    expect(n!.impuesto.estado).toBe('Pagado');
    expect(n!.soat.estado).toBe('Sin SOAT');
    expect(n!.derecho.estado).toBe('Sin registro');
    expect(v!.logistica.estado).toBe('Liquidada · 1 viaje adicional');
    expect(JSON.stringify(r)).not.toMatch(/123456|500000|80000|comprador/i);
  });

  it('fuera de alcance y no existe son el MISMO 404', async () => {
    const x = await s.cia('X'); const y = await s.cia('Y');
    const placa = placaNueva();
    await s.tramite({ cia: x, placa });
    await expect(buscarPlaca(placa, { enlace: 'compania', companiaId: y })).rejects.toBeInstanceOf(PlacaTorreNoEncontradaError);
    await expect(buscarPlaca('ZQ0000', { enlace: 'ninguno' })).rejects.toBeInstanceOf(PlacaTorreNoEncontradaError);
  });
});
