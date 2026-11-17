// Torre de Control Gerencial (Épica #14590, UX §7) — un caso por tablero contra PostgreSQL real (tx con ROLLBACK,
// `torre-pg.ts`; se saltan sin TEST_DATABASE_URL), acotados a las compañías que siembra cada caso, y el orden de los
// riesgos del 360° sin base.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/db/client.js', async () => ({ db: (await import('./torre-pg.js')).dbProxy, getPoolStats: vi.fn() }));
vi.mock('../../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn() }));

const { abrirTx, cerrarBase, cerrarTx, sembrador, URL_BASE } = await import('./torre-pg.js');
const { tableroComercial } = await import('../../../src/modules/flito-torre/flito-torre.comercial.service.js');
const { tableroOperativo } = await import('../../../src/modules/flito-torre/flito-torre.operativa.service.js');
const { tableroFinanciero } = await import('../../../src/modules/flito-torre/flito-torre.financiera.service.js');
const { tableroEjecutivo, ordenarRiesgos } = await import('../../../src/modules/flito-torre/flito-torre.ejecutivo.service.js');
import type { RiesgoTorre } from '@operaciones/shared-types';

const TODO = { enlace: 'ninguno' } as const;
const dias = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

describe('360° · orden de los riesgos (sin base)', () => {
  it('crítico antes que atención y, dentro de cada uno, más impacto primero; máximo 5', () => {
    const r = (severidad: RiesgoTorre['severidad'], impacto: number): RiesgoTorre => ({ area: 'comercial', frase: `${severidad}${impacto}`, umbral: '', severidad, impacto });
    const orden = ordenarRiesgos([r('atencion', 900), r('critico', 1), r('atencion', 5), r('critico', 50), r('atencion', 10), r('atencion', 1)]);
    expect(orden.map((x) => x.frase)).toEqual(['critico50', 'critico1', 'atencion900', 'atencion10', 'atencion5']);
  });
});

describe.skipIf(!URL_BASE)('tableros contra PostgreSQL (tx con ROLLBACK)', () => {
  let s: ReturnType<typeof sembrador>;
  beforeEach(async () => { s = sembrador(await abrirTx()); await s.organismos('05001', '11001'); });
  afterEach(cerrarTx);
  afterAll(cerrarBase);

  it('Comercial: fuga frente al promedio de 90 días, concentración, embudo y venta cruzada con «Autogestiona»', async () => {
    const hoy = '2035-06-30';
    const a = await s.cia('A', { soat: true }); const b = await s.cia('B');
    for (let i = 0; i < 9; i++) {
      await s.tramite({ cia: a, creadoFlit: `2035-04-${String(10 + i).padStart(2, '0')}T15:00:00Z` });
      await s.tramite({ cia: b, creadoFlit: `2035-04-${String(10 + i).padStart(2, '0')}T15:00:00Z` });
    }
    await s.tramite({ cia: a, creadoFlit: '2035-06-20T15:00:00Z' });
    const b1 = await s.tramite({ cia: b, creadoFlit: '2035-06-05T15:00:00Z', aprobado: '2035-06-07T15:00:00Z' });
    await s.tramite({ cia: b, creadoFlit: '2035-06-06T15:00:00Z', flitEstado: 'Entregado' });
    await s.tramite({ cia: b, creadoFlit: '2035-06-07T15:00:00Z' });
    await s.liquidacion(b1, { total: 400_000, logistica: 50_000 });

    const t = await tableroComercial({ filtro: { rango: { desde: '2035-06-01', hasta: hoy }, companiaIds: [a, b] }, alcance: TODO, dinero: true, hoy });
    // A: 1 en los últimos 30 días frente a 9 en los 90 anteriores (3 por ventana) → −66,7 %; B: 3 frente a 3 → sin caída.
    expect(t.fuga.filas.map((f) => [f.companiaId, f.tramitesVentana, f.promedio, f.variacionPct])).toEqual([[a, 1, 3, -66.7]]);
    expect(t.cifras.clientesEnCaida).toBe(1);
    expect(t.embudo.pasos.map((p) => [p.paso, p.valor, p.pct])).toEqual([['creados', 4, 100], ['radicados', 2, 50], ['aprobados', 1, 25], ['facturados', 0, 0]]);
    expect(t.concentracion.volumen.top.map((c) => [c.companiaId, c.pct])).toEqual([[b, 75], [a, 25]]);
    expect(t.concentracion.volumen.top3Pct).toBe(100);
    expect(t.concentracion.ingreso?.total).toBe(400_000);
    expect(t.ventaCruzada.filas.map((f) => [f.companiaId, f.lineas])).toEqual([
      [b, { tramites: 'usa', soat: 'no_usa', impuestos: 'no_usa', derechos: 'no_usa', logistica: 'usa' }],
      [a, { tramites: 'usa', soat: 'autogestiona', impuestos: 'no_usa', derechos: 'no_usa', logistica: 'no_usa' }],
    ]);
    expect(t.tendencia.mensual.map((m) => m.clave)).toEqual(['2034-12', '2035-01', '2035-02', '2035-03', '2035-04', '2035-05']);
    expect(t.tendencia.mensual.find((m) => m.clave === '2035-04')?.valor).toBe(18);

    const sinDinero = await tableroComercial({ filtro: { rango: { desde: '2035-06-01', hasta: hoy }, companiaIds: [a] }, alcance: TODO, dinero: false, hoy });
    expect(sinDinero.concentracion.ingreso).toBeNull();
    expect(sinDinero.dineroVisible).toBe(false);
  });

  it('Operativo: radar con umbrales (borradores y estancados en OT), WIP por OT, comparativo y logística', async () => {
    const x = await s.cia('X');
    await s.tramite({ cia: x, flitEstado: 'Borrador', creadoFlit: dias(7) });   // > 5 días: atención
    await s.tramite({ cia: x, flitEstado: 'Borrador', creadoFlit: dias(1) });
    const ot = await s.tramite({ cia: x, flitEstado: 'Entregado', organismo: '11001', creadoFlit: dias(9) });
    await s.historial(ot, 'Asignado', 'Entregado', dias(5));                   // > 2 × 2 días: crítico
    const apr = await s.tramite({ cia: x, organismo: '11001', creadoFlit: '2035-03-01T15:00:00Z', aprobado: '2035-03-04T15:00:00Z' });
    await s.historial(apr, 'Asignado', 'Entregado', '2035-03-02T15:00:00Z');
    await s.liquidacion(apr, { total: 100_000, logistica: 40_000 });
    const apr2 = await s.tramite({ cia: x, organismo: '11001', creadoFlit: '2035-03-01T15:00:00Z', aprobado: '2035-03-05T15:00:00Z' });
    await s.liquidacion(apr2, { total: 100_000, logistica: 60_000 });
    await s.viaje(apr2, 2, 20_000);

    const t = await tableroOperativo({ filtro: { rango: { desde: '2035-03-01', hasta: '2035-03-31' }, companiaIds: [x] }, alcance: TODO, dinero: true, hoy: '2035-03-31' });
    const radar = Object.fromEntries(t.radar.filas.map((f) => [f.causa, [f.cantidad, f.severidad]]));
    expect(radar.borrador_abandonado).toEqual([1, 'atencion']);
    expect(radar.estancado_ot).toEqual([1, 'critico']);
    expect(radar.soat_sin_gestion).toEqual([0, 'ok']);
    expect(t.cifras.borradoresAbandonados).toBe(1);
    expect(t.cifras.wip).toBe(3);
    expect(t.carga.porOrganismo[0]).toMatchObject({ clave: '05001', valor: 2 });
    expect(t.carga.porFuncionario).toBeNull();
    const bog = t.benchmarkOt.filas.find((f) => f.organismoCodigo === '11001')!;
    expect(bog).toMatchObject({ volumen: 2, pctAprobado: 100, medianaRespuestaDias: 2, sobreUmbral: false });
    expect(t.logistica).toMatchObject({ entregas: 2, primerIntento: 1, primerIntentoPct: 50, viajesAdicionales: 1 });
  });

  it('Financiero: cobertura de bolsa con semáforo, sin facturar valorizado, margen y conciliación; sin dinero → null', async () => {
    const hoy = '2035-06-30';
    const x = await s.cia('X');
    const bolsa = await s.bolsa(x, 1_000_000);
    await s.salida(bolsa, 3_000_000, '2035-06-15');           // 100.000/día → 10 días: atención (7 < 10 < 15)
    await s.salida(bolsa, 9_000_000, '2035-05-01');           // fuera de los 30 días
    const t1 = await s.tramite({ cia: x, aprobado: '2035-06-10T15:00:00Z' });
    await s.liquidacion(t1, { total: 500_000, digital: 200_000 });
    await s.impuesto({ tramiteId: t1, cia: x, organismo: '05001', valorPagado: 0, pagadoEn: '2035-06-11T15:00:00Z' });

    const ctx = { filtro: { rango: { desde: '2035-06-01', hasta: hoy }, companiaIds: [x] }, alcance: TODO, hoy };
    const t = await tableroFinanciero({ ...ctx, dinero: true });
    expect(t.bolsas.filas).toEqual([expect.objectContaining({ companiaId: x, saldo: 1_000_000, consumoDiario: 100_000, diasCobertura: 10, severidad: 'atencion' })]);
    expect(t.cifras.menorCobertura).toMatchObject({ companiaId: x, dias: 10, severidad: 'atencion' });
    expect(t.cifras).toMatchObject({ sinFacturarTramites: 1, sinFacturarValor: 500_000 });
    const tram = t.margen!.porServicio.find((m) => m.servicio === 'tramite')!;
    expect(tram).toMatchObject({ cobrado: 200_000, costo: null, sinCostoRegistrado: true });
    expect(t.margen!.porServicio.find((m) => m.servicio === 'impuestos')).toMatchObject({ costo: 0, sinCostoRegistrado: false });
    expect(t.conciliacion).toMatchObject({ total: 1, cero: 1, completos: 0, pctCompletos: 0 });

    const sin = await tableroFinanciero({ ...ctx, dinero: false });
    expect(sin.margen).toBeNull();
    expect(sin.cifras.sinFacturarValor).toBeNull();
    expect(sin.bolsas.filas[0]).toMatchObject({ saldo: null, consumoDiario: null, diasCobertura: 10 });
  });

  it('360°: proyección del mes con el ritmo diario frente al mes anterior y riesgos del financiero', async () => {
    const hoy = '2035-06-10';
    const x = await s.cia('X');
    for (let d = 1; d <= 5; d++) await s.tramite({ cia: x, creadoFlit: '2035-06-01T13:00:00Z', aprobado: `2035-06-0${d}T15:00:00Z` });
    for (let d = 1; d <= 20; d++) await s.tramite({ cia: x, creadoFlit: '2035-05-01T13:00:00Z', aprobado: `2035-05-${String(d).padStart(2, '0')}T15:00:00Z` });
    const bolsa = await s.bolsa(x, 100_000);
    await s.salida(bolsa, 3_000_000, '2035-06-01');             // 1 día de cobertura: crítico

    const t = await tableroEjecutivo({ filtro: { rango: { preset: 'mes' }, companiaIds: [x] }, alcance: TODO, dinero: true, hoy });
    expect(t.rango).toEqual({ desde: '2035-06-01', hasta: hoy });
    expect(t.proyeccion).toMatchObject({ mes: '2035-06', diasTranscurridos: 10, diasMes: 30, totalMesAnterior: 20, proyeccionCierre: 15, variacionPct: -25, meta: null });
    expect(t.proyeccion.acumulado.at(-1)).toEqual({ dia: 10, valor: 5 });
    expect(t.comercial.tramitesMes).toBe(5);
    expect(t.operativo.pctDentroAns).toBe(40); // los aprobados el 1 y el 2 de junio (2 h y 26 h) caben en 2 días
    expect(t.riesgos[0]).toMatchObject({ area: 'financiero', severidad: 'critico' });
  });

  it('bolsa con saldo ≤ 0: agotada (0 días, crítico) en el financiero y en el riesgo del 360°; días con coma es-CO', async () => {
    const hoy = '2035-06-30';
    const neg = await s.cia('Negativa');
    const cero = await s.cia('Cero');
    const dec = await s.cia('Decimal');
    const bNeg = await s.bolsa(neg, -262_000);
    await s.salida(bNeg, 300_000, '2035-06-15');                 // con consumo y saldo negativo: antes daba −26,2 días
    await s.bolsa(cero, 0);                                      // saldo 0 sin consumo: antes «Sin consumo» y ok
    const bDec = await s.bolsa(dec, 250_000);
    await s.salida(bDec, 3_000_000, '2035-06-15');               // 100.000/día → 2,5 días: crítico

    const ctx = { filtro: { rango: { desde: '2035-06-01', hasta: hoy }, companiaIds: [neg, cero, dec] }, alcance: TODO, hoy };
    const f = await tableroFinanciero({ ...ctx, dinero: true });
    const porCia = Object.fromEntries(f.bolsas.filas.map((b) => [b.companiaId, [b.diasCobertura, b.severidad]]));
    expect(porCia[neg]).toEqual([0, 'critico']);
    expect(porCia[cero]).toEqual([0, 'critico']);
    expect(porCia[dec]).toEqual([2.5, 'critico']);
    expect(f.cifras.menorCobertura).toMatchObject({ dias: 0, severidad: 'critico' });
    expect(f.bolsas.filas.every((b) => (b.diasCobertura ?? 0) >= 0)).toBe(true);

    const e = await tableroEjecutivo({ ...ctx, filtro: { ...ctx.filtro, rango: { preset: 'mes' } }, dinero: true });
    const frases = e.riesgos.filter((r) => r.area === 'financiero').map((r) => r.frase);
    expect(frases).toHaveLength(3);
    expect(frases).toEqual(expect.arrayContaining([
      expect.stringMatching(/^La bolsa de Negativa\b.* está agotada$/), expect.stringMatching(/^La bolsa de Cero\b.* está agotada$/),
      expect.stringMatching(/^La bolsa de Decimal\b.* alcanza para 2,5 días$/),
    ]));
    expect(frases.join(' ')).not.toMatch(/-\d|−/);
  });
});
