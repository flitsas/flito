// Torre de Control — Explorador flexible (Épica #14590, ADR-0044 §(b)): la segunda agrupación (tabla cruzada) contra
// PostgreSQL real (tx con ROLLBACK, `torre-pg.ts`; se saltan sin TEST_DATABASE_URL) y, sin base, los topes del cruce.
// RN-TOR-C1 a C5, RN-TOR-X4 y X5.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/db/client.js', async () => ({ db: (await import('./torre-pg.js')).dbProxy, getPoolStats: vi.fn() }));
vi.mock('../../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn() }));

const { abrirTx, cerrarBase, cerrarTx, sembrador, URL_BASE } = await import('./torre-pg.js');
const { consultarMetrica } = await import('../../../src/modules/flito-torre/flito-torre.metricas.service.js');
const { topesCruce } = await import('../../../src/modules/flito-torre/flito-torre.cruce.js');
const { RangoTorreExcedidoError, cortesTemporales } = await import('../../../src/modules/flito-torre/flito-torre.filtro.js');
const { TorreConsultaInvalidaError } = await import('../../../src/modules/flito-torre/flito-torre.service.js');
const { libroMetrica } = await import('../../../src/modules/flito-torre/flito-torre.export.js');
import type { AlcanceResuelto } from '../../../src/shared/middleware/frontera-enlace.js';
import type postgres from 'postgres';

const TODO: AlcanceResuelto = { enlace: 'ninguno' };
const OP = { dinero: true, hoy: '2035-12-31' };
const MARZO = { desde: '2035-03-01', hasta: '2035-03-31' };

describe('cruce sin base: reglas y topes (RN-TOR-C1, RN-TOR-C3)', () => {
  it('dos agrupaciones temporales → 400 (TorreConsultaInvalidaError) antes de consultar', async () => {
    await expect(consultarMetrica({ metrica: 'tramites', agrupacion: 'mes', agrupacionColumnas: 'semana', filtro: { rango: MARZO } }, TODO, OP))
      .rejects.toBeInstanceOf(TorreConsultaInvalidaError);
    await expect(consultarMetrica({ metrica: 'tramites', agrupacionColumnas: 'mes', filtro: { rango: MARZO } }, TODO, OP))
      .rejects.toBeInstanceOf(TorreConsultaInvalidaError);
  });

  it('más de 62 cortes en el eje temporal → RangoTorreExcedidoError con el copy del diseño; 62 justos pasan el tope', async () => {
    const r = { desde: '2035-01-01', hasta: '2035-03-04' }; // 63 días
    expect(cortesTemporales('dia', r)).toBe(63);
    await expect(consultarMetrica({ metrica: 'tramites', agrupacion: 'compania', agrupacionColumnas: 'dia', filtro: { rango: r } }, TODO, OP))
      .rejects.toThrow('Con dos agrupaciones, el periodo admite hasta 62 cortes por día. Elija una agrupación más amplia o acorte el periodo.');
    await expect(consultarMetrica({ metrica: 'tramites', agrupacion: 'semana', agrupacionColumnas: 'compania', filtro: { rango: { desde: '2034-01-02', hasta: '2035-03-31' } } }, TODO, OP))
      .rejects.toBeInstanceOf(RangoTorreExcedidoError);
    expect(cortesTemporales('dia', { desde: '2035-01-01', hasta: '2035-03-03' })).toBe(62);
    expect(cortesTemporales('semana', { desde: '2035-03-07', hasta: '2035-03-12' })).toBe(2); // miércoles → lunes siguiente
    expect(cortesTemporales('mes', { desde: '2034-11-15', hasta: '2035-02-01' })).toBe(4);
    expect(cortesTemporales('trimestre', { desde: '2034-12-31', hasta: '2035-04-01' })).toBe(3);
  });

  it('topes de dimensión: pantalla 50 × 12 (acotados por `limite`), Excel 2.000 × 100', () => {
    expect(topesCruce('pantalla', 500)).toEqual({ topeFilas: 50, topeColumnas: 12 });
    expect(topesCruce('pantalla', 3)).toEqual({ topeFilas: 3, topeColumnas: 12 });
    expect(topesCruce('exportar', 5_000)).toEqual({ topeFilas: 2_000, topeColumnas: 100 });
  });
});

describe.skipIf(!URL_BASE)('cruce contra PostgreSQL (tx con ROLLBACK)', () => {
  let s: ReturnType<typeof sembrador>;
  let tx: postgres.ReservedSql;
  beforeEach(async () => { tx = await abrirTx(); s = sembrador(tx); await s.organismos('05001'); });
  afterEach(cerrarTx);
  afterAll(cerrarBase);

  /** A: 8 trámites, B: 5, C: 2; 13 tipos (T01 ×3, T02…T13 ×1). */
  async function sembrarDimensiones() {
    const a = await s.cia('A'); const b = await s.cia('B'); const c = await s.cia('C');
    const plan: [number, string][] = [
      ...['T01', 'T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07'].map((t) => [a, t] as [number, string]),
      ...['T01', 'T08', 'T09', 'T10', 'T11'].map((t) => [b, t] as [number, string]),
      ...['T12', 'T13'].map((t) => [c, t] as [number, string]),
    ];
    for (const [cia, tipo] of plan) await s.tramite({ cia, tipo, creadoFlit: '2035-03-10T15:00:00Z' });
    return { a, b, c };
  }

  it('RN-TOR-C2 · dimensión × dimensión: top-N con «Los demás (N)» al final en filas y columnas; celda sin registros = null', async () => {
    const { a, b, c } = await sembrarDimensiones();
    const r = await consultarMetrica({
      metrica: 'tramites', agrupacion: 'compania', agrupacionColumnas: 'tipo_tramite', limite: 2,
      filtro: { rango: MARZO, companiaIds: [a, b, c] },
    }, TODO, OP);
    expect(r.total.valor).toBe(15);
    expect(r.rango).toEqual(MARZO);   // RN-TOR-F5: el cruce también declara el rango aplicado
    expect(r.truncado).toBe(true);
    expect(r.filas.map((f) => [f.clave, f.valor, f.esOtros ?? false])).toEqual([[String(a), 8, false], [String(b), 5, false], ['__otros', 2, true]]);
    expect(r.filas[2]!.etiqueta).toBe('Los demás (1)');
    expect(r.filas[0]!.participacion).toBe(53.33);
    const cruce = r.cruce!;
    expect(cruce.agrupacion).toBe('tipo_tramite');
    expect(cruce.truncadoColumnas).toBe(true);
    expect(cruce.columnas.map((col) => col.etiqueta)).toEqual(['T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08', 'T09', 'T10', 'T11', 'T12', 'Los demás (1)']);
    expect(cruce.columnas.at(-1)).toMatchObject({ clave: '__otros', valor: 1, esOtros: true });
    expect(cruce.columnas[0]).toMatchObject({ clave: 'T01', valor: 3, n: 3, participacion: 20 });
    expect(cruce.celdas).toHaveLength(3);
    expect(cruce.celdas.every((fila) => fila.length === 13)).toBe(true);
    expect(cruce.celdas[0]![0]).toEqual({ valor: 2, n: 2 });   // A × T01
    expect(cruce.celdas[1]![0]).toEqual({ valor: 1, n: 1 });   // B × T01
    expect(cruce.celdas[0]![7]).toBeNull();                    // A × T08: sin registros
    expect(cruce.celdas[2]![11]).toEqual({ valor: 1, n: 1 });  // Los demás × T12
    expect(cruce.celdas[2]![12]).toEqual({ valor: 1, n: 1 });  // Los demás × Los demás
  });

  it('RN-TOR-C2 · temporal × dimensión: el eje temporal no se corta (orden cronológico, sin «Otros»), aunque pase de 12', async () => {
    const x = await s.cia('X'); const y = await s.cia('Y');
    await s.tramite({ cia: x, aprobado: '2035-03-05T15:00:00Z' });
    await s.tramite({ cia: y, aprobado: '2035-03-06T15:00:00Z' });
    await s.tramite({ cia: x, aprobado: '2035-04-05T15:00:00Z' });
    await s.tramite({ cia: x, aprobado: '2035-04-06T15:00:00Z' });
    const r = await consultarMetrica({
      metrica: 'tramites', fechaBase: 'aprobacion', agrupacion: 'mes', agrupacionColumnas: 'compania',
      filtro: { rango: { desde: '2035-03-01', hasta: '2035-04-30' }, companiaIds: [x, y] },
    }, TODO, OP);
    expect(r.filas.map((f) => [f.clave, f.valor])).toEqual([['2035-03', 2], ['2035-04', 2]]);
    expect(r.filas.some((f) => f.esOtros)).toBe(false);
    expect(r.cruce!.columnas.map((col) => [col.clave, col.valor])).toEqual([[String(x), 3], [String(y), 1]]);
    expect(r.cruce!.celdas[1]).toEqual([{ valor: 2, n: 2 }, null]);
    expect(r.baseFecha.fechaBase).toBe('aprobacion');

    // 14 semanas con registros en las columnas: las 14, sin plegar.
    for (let i = 0; i < 14; i++) {
      await s.tramite({ cia: x, creadoFlit: new Date(Date.parse('2035-01-03T15:00:00Z') + i * 7 * 86_400_000).toISOString() });
    }
    const semanas = await consultarMetrica({
      metrica: 'tramites', agrupacion: 'compania', agrupacionColumnas: 'semana',
      filtro: { rango: { desde: '2035-01-01', hasta: '2035-04-30' }, companiaIds: [x] },
    }, TODO, OP);
    expect(semanas.cruce!.columnas).toHaveLength(14);
    expect(semanas.cruce!.truncadoColumnas).toBe(false);
    const claves = semanas.cruce!.columnas.map((col) => col.clave);
    expect([...claves].sort()).toEqual(claves);
  });

  it('RN-TOR-C4 · tiempo: los marginales son la mediana y el p90 de las filas crudas (percentile_cont aparte), no de las celdas', async () => {
    const x = await s.cia('X'); const y = await s.cia('Y');
    const creado = '2035-03-01T12:00:00Z';
    const con = (horas: number) => new Date(Date.parse(creado) + horas * 3_600_000).toISOString();
    await s.tramite({ cia: x, tipo: 'Traspaso', creadoFlit: creado, aprobado: con(10) });
    await s.tramite({ cia: x, tipo: 'Traspaso', creadoFlit: creado, aprobado: con(20) });
    await s.tramite({ cia: x, tipo: 'Matrícula', creadoFlit: creado, aprobado: con(100) });
    await s.tramite({ cia: y, tipo: 'Traspaso', creadoFlit: creado, aprobado: con(30) });
    const r = await consultarMetrica({
      metrica: 'tiempo_creacion_aprobacion', agrupacion: 'compania', agrupacionColumnas: 'tipo_tramite',
      filtro: { rango: MARZO, companiaIds: [x, y] },
    }, TODO, OP);
    const [aparte] = await tx`SELECT
        percentile_cont(0.5) WITHIN GROUP (ORDER BY h) FILTER (WHERE g = 'x') AS mx,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY h) FILTER (WHERE g = 'x') AS px,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY h) FILTER (WHERE t = 'tr') AS mt,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY h) AS mtot
      FROM (VALUES ('x', 'tr', 10), ('x', 'tr', 20), ('x', 'ma', 100), ('y', 'tr', 30)) v(g, t, h)`;
    const filaX = r.filas.find((f) => f.clave === String(x))!;
    expect(filaX).toMatchObject({ valor: Number(aparte!.mx), mediana: Number(aparte!.mx), p90: Number(aparte!.px), n: 3 });
    expect(filaX.mediana).toBe(20);
    expect(filaX.p90).toBe(84);
    const traspaso = r.cruce!.columnas.find((col) => col.clave === 'Traspaso')!;
    expect(traspaso).toMatchObject({ mediana: Number(aparte!.mt), n: 3 });
    expect(r.total.mediana).toBe(Number(aparte!.mtot));
    // Las celdas de X son 15 (Traspaso) y 100 (Matrícula): ni su suma ni su promedio dan el marginal.
    const jT = r.cruce!.columnas.findIndex((col) => col.clave === 'Traspaso');
    const jM = r.cruce!.columnas.findIndex((col) => col.clave === 'Matrícula');
    const iX = r.filas.findIndex((f) => f.clave === String(x));
    expect(r.cruce!.celdas[iX]![jT]).toMatchObject({ mediana: 15, n: 2 });
    expect(r.cruce!.celdas[iX]![jM]).toMatchObject({ mediana: 100, n: 1 });
    expect(filaX.mediana).not.toBe(115);
    expect(filaX.mediana).not.toBe(57.5);
  });

  it('RN-TOR-C5 · el cruce aplica el alcance en el WHERE: una compañía solo ve lo suyo aunque pida otra', async () => {
    const x = await s.cia('X'); const y = await s.cia('Y');
    await s.tramite({ cia: x, aprobado: '2035-03-05T15:00:00Z' });
    await s.tramite({ cia: y, aprobado: '2035-03-05T15:00:00Z' });
    await s.tramite({ cia: y, aprobado: '2035-03-06T15:00:00Z' });
    const deY: AlcanceResuelto = { enlace: 'compania', companiaId: y };
    const consulta = { metrica: 'tramites' as const, fechaBase: 'aprobacion' as const, agrupacion: 'compania' as const, agrupacionColumnas: 'mes' as const };
    const propio = await consultarMetrica({ ...consulta, filtro: { rango: MARZO } }, deY, OP);
    expect(propio.filas.map((f) => [f.clave, f.valor])).toEqual([[String(y), 2]]);
    expect(propio.cruce!.columnas.map((col) => col.clave)).toEqual(['2035-03']);
    const ajeno = await consultarMetrica({ ...consulta, filtro: { rango: MARZO, companiaIds: [x] } }, deY, OP);
    expect(ajeno.filas).toEqual([]);
    expect(ajeno.cruce).toMatchObject({ columnas: [], celdas: [], truncadoColumnas: false });
  });

  it('RN-TOR-X4 · Excel cruzado: cabecera «principal / secundaria», cierre «Total» al sumar y «General» en tiempo; sin fórmulas', async () => {
    const x = await s.cia('=HACK'); const y = await s.cia('@Y');
    await s.tramite({ cia: x, aprobado: '2035-03-05T15:00:00Z', creadoFlit: '2035-03-04T15:00:00Z' });
    await s.tramite({ cia: x, aprobado: '2035-04-05T15:00:00Z', creadoFlit: '2035-04-04T15:00:00Z' });
    await s.tramite({ cia: y, aprobado: '2035-04-06T15:00:00Z', creadoFlit: '2035-04-04T15:00:00Z' });
    const filtro = { rango: { desde: '2035-03-01', hasta: '2035-04-30' }, companiaIds: [x, y] };

    const conteo = await libroMetrica({ metrica: 'tramites', fechaBase: 'aprobacion', agrupacion: 'compania', agrupacionColumnas: 'mes', filtro }, TODO, OP);
    expect(conteo.columnas.map((col) => col.header)).toEqual(['Compañía / Mes', '2035-03', '2035-04', 'Total']);
    expect(conteo.filas.map((f) => [f.c0, f.c1, f.cierre])).toEqual([[1, 1, 2], [null, 1, 1], [1, 2, 3]]);
    expect(conteo.filas.at(-1)!.etiqueta).toBe('Total');
    expect(String(conteo.filas[0]!.etiqueta)).toMatch(/^'=HACK/);
    expect(String(conteo.filas[1]!.etiqueta)).toMatch(/^'@Y/);
    const textos = [...conteo.columnas.map((col) => String(col.header)), ...conteo.filas.flatMap((f) => Object.values(f).filter((v) => typeof v === 'string'))];
    expect(textos.filter((t) => /^[=+\-@]/.test(t))).toEqual([]);

    const tiempo = await libroMetrica({ metrica: 'tiempo_creacion_aprobacion', agrupacion: 'mes', agrupacionColumnas: 'compania', filtro }, TODO, OP);
    expect(tiempo.columnas[0]!.header).toBe('Mes / Compañía · mediana en horas');
    expect(tiempo.columnas.at(-1)!.header).toBe('General (mediana en horas)');
    expect(tiempo.filas.at(-1)).toMatchObject({ etiqueta: 'General', cierre: 24 });
    expect(tiempo.columnas.every((col) => !/^[=+\-@]/.test(String(col.header)))).toBe(true);
  });
});
