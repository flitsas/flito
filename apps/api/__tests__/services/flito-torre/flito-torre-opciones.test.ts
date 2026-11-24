// Torre de Control Gerencial (Épica #14590) — opciones de la barra de filtros contra PostgreSQL real (tx con ROLLBACK,
// `torre-pg.ts`; se saltan sin TEST_DATABASE_URL): forma, alcance del motor, sin NIT, y que cada `valor` de tipos y
// estados filtre exacto en el motor (misma columna, misma comparación en minúsculas). Y el libro de exportación de los
// cuatro tableros armado con sus servicios REALES (el HTTP y las guardas, en `flito-torre-exportar-tablero.test.ts`).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/db/client.js', async () => ({ db: (await import('./torre-pg.js')).dbProxy, getPoolStats: vi.fn() }));
vi.mock('../../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn() }));

const { abrirTx, cerrarBase, cerrarTx, sembrador, URL_BASE } = await import('./torre-pg.js');
const { opcionesFiltroTorre } = await import('../../../src/modules/flito-torre/flito-torre.opciones.service.js');
const { consultarMetrica } = await import('../../../src/modules/flito-torre/flito-torre.metricas.service.js');
const { libroTablero } = await import('../../../src/modules/flito-torre/flito-torre.tablero-export.js');

const TODO = { enlace: 'ninguno' } as const;

describe.skipIf(!URL_BASE)('opciones de filtro contra PostgreSQL (tx con ROLLBACK)', () => {
  let s: ReturnType<typeof sembrador>;
  beforeEach(async () => { s = sembrador(await abrirTx()); await s.organismos('05001', '11001'); });
  afterEach(cerrarTx);
  afterAll(cerrarBase);

  it('forma { companias, organismos, tiposTramite, flitEstados } solo con id/nombre/código, sin NIT ni documento', async () => {
    const a = await s.cia('OpcA');
    await s.tramite({ cia: a, organismo: '11001', tipo: 'TraspasoTorreX', flitEstado: 'EstadoTorreX' });
    const o = await opcionesFiltroTorre(TODO, '2035-03-31');
    expect(Object.keys(o).sort()).toEqual(['companias', 'flitEstados', 'organismos', 'tiposTramite']);
    const cia = o.companias.find((c) => c.id === a)!;
    expect(Object.keys(cia).sort()).toEqual(['id', 'nombre']);
    expect(cia.nombre).toMatch(/^OpcA /);
    expect(o.organismos.find((x) => x.codigo === '11001')).toEqual({ codigo: '11001', nombre: expect.any(String) });
    expect(o.tiposTramite).toContainEqual({ valor: 'TraspasoTorreX', etiqueta: 'TraspasoTorreX' });
    expect(o.flitEstados).toContainEqual({ valor: 'EstadoTorreX', etiqueta: 'EstadoTorreX' });
    // Los `document` que siembra `s.cia` empiezan por «T»+sello: ninguno viaja.
    expect(JSON.stringify(o)).not.toMatch(/"(document|nit|documentType)"/i);
  });

  it('alcance del motor: un enlace de compañía solo ve SUS compañías y SUS valores; un enlace sin compañía, nada', async () => {
    const a = await s.cia('OpcA'); const b = await s.cia('OpcB');
    await s.tramite({ cia: a, tipo: 'TipoSoloA', flitEstado: 'EstadoSoloA' });
    await s.tramite({ cia: b, tipo: 'TipoSoloB', flitEstado: 'EstadoSoloB' });
    const deA = await opcionesFiltroTorre({ enlace: 'compania', companiaId: a }, '2035-03-31');
    expect(deA.companias.map((c) => c.id)).toEqual([a]);
    expect(deA.tiposTramite.map((t) => t.valor)).toContain('TipoSoloA');
    expect(deA.tiposTramite.map((t) => t.valor)).not.toContain('TipoSoloB');
    expect(deA.flitEstados.map((e) => e.valor)).not.toContain('EstadoSoloB');
    const nadie = await opcionesFiltroTorre({ enlace: null }, '2035-03-31');
    expect(nadie).toEqual({ companias: [], organismos: [], tiposTramite: [], flitEstados: [] });
  });

  it('las grafías de un mismo valor salen una vez y el valor devuelto filtra exacto en el motor', async () => {
    const a = await s.cia('OpcA');
    await s.tramite({ cia: a, tipo: 'TipoCaso', flitEstado: 'EstadoCaso' });
    await s.tramite({ cia: a, tipo: 'TipoCaso', flitEstado: 'EstadoCaso' });
    await s.tramite({ cia: a, tipo: 'TIPOCASO', flitEstado: 'ESTADOCASO' });
    const o = await opcionesFiltroTorre({ enlace: 'compania', companiaId: a }, '2035-03-31');
    expect(o.tiposTramite.filter((t) => t.valor.toLowerCase() === 'tipocaso')).toEqual([{ valor: 'TipoCaso', etiqueta: 'TipoCaso' }]);
    const r = await consultarMetrica(
      { metrica: 'tramites_creados', filtro: { rango: { desde: '2035-03-01', hasta: '2035-03-31' }, companiaIds: [a], tiposTramite: [o.tiposTramite[0]!.valor], flitEstados: [o.flitEstados[0]!.valor] } },
      TODO, { dinero: false, hoy: '2035-03-31' },
    );
    expect(r.total.valor).toBe(3);
  });

  it('libro de exportación de los cuatro tableros con sus servicios reales: una hoja por bloque y, sin dinero, sin filas ni hojas de dinero', async () => {
    const a = await s.cia('OpcA');
    await s.tramite({ cia: a, creadoFlit: '2035-03-05T15:00:00Z', aprobado: '2035-03-07T15:00:00Z' });
    const ctx = (dinero: boolean) => ({ filtro: { rango: { desde: '2035-03-01', hasta: '2035-03-31' }, companiaIds: [a] }, alcance: TODO, dinero, hoy: '2035-03-31' });
    const nombres = async (t: 'comercial' | 'operativa' | 'financiera' | 'ejecutivo', d: boolean) => (await libroTablero(t, ctx(d))).hojas.map((h) => h.nombre);
    expect(await nombres('comercial', true)).toEqual(['Cifras', 'Fuga de clientes', 'Concentración volumen', 'Concentración ingreso', 'Embudo', 'Tendencia', 'Venta cruzada']);
    expect(await nombres('comercial', false)).not.toContain('Concentración ingreso');
    expect(await nombres('operativa', false)).toEqual(['Cifras', 'Radar', 'Carga por organismo', 'Comparativo OT', 'Logística']);
    expect(await nombres('ejecutivo', false)).toEqual(['Resumen', 'Proyección', 'Acumulado diario', 'Riesgos']);
    const ej = await libroTablero('ejecutivo', ctx(false));
    expect(ej.rango).toEqual({ desde: '2035-03-01', hasta: '2035-03-31' });
    expect(ej.hojas[0]!.filas.map((f) => f.concepto)).not.toContain('Margen %');
    const fin = await libroTablero('financiera', ctx(false));
    expect(fin.hojas.find((h) => h.nombre === 'Sin facturar')!.columnas.map((c) => c.key)).not.toContain('valorEstimado');
  });
});
