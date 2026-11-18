// Torre de Control — Explorador flexible (Épica #14590, ADR-0044 §(d)): sugerencias de placa contra PostgreSQL real
// (tx con ROLLBACK, `torre-pg.ts`; se saltan sin TEST_DATABASE_URL) y, sin base, el escape del LIKE. RN-TOR-P5 y P6.
// Cada caso acota por el alcance de una compañía que crea, o usa un texto único: la base local tiene datos reales.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/db/client.js', async () => ({ db: (await import('./torre-pg.js')).dbProxy, getPoolStats: vi.fn() }));
vi.mock('../../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn() }));

const { abrirTx, cerrarBase, cerrarTx, sembrador, URL_BASE } = await import('./torre-pg.js');
const { escaparLike, sugerirPlacas } = await import('../../../src/modules/flito-torre/flito-torre.placa.service.js');
import type { AlcanceResuelto } from '../../../src/shared/middleware/frontera-enlace.js';

let n = 0;
/** 3 caracteres [A-Z0-9] distintos en cada llamada (base 36 del reloj + contador). */
const unico = (): string => `${(Date.now() % 46_656).toString(36)}${(n++ % 36).toString(36)}`.toUpperCase().padStart(4, 'Q').slice(-4);

describe('escape del LIKE (sin base)', () => {
  it('escapa %, _ y la barra invertida', () => {
    expect(escaparLike('A%B_C\\')).toBe('A\\%B\\_C\\\\');
    expect(escaparLike('ABC123')).toBe('ABC123');
  });
});

describe.skipIf(!URL_BASE)('sugerencias de placa contra PostgreSQL (tx con ROLLBACK)', () => {
  let s: ReturnType<typeof sembrador>;
  beforeEach(async () => { s = sembrador(await abrirTx()); await s.organismos('05001'); });
  afterEach(cerrarTx);
  afterAll(cerrarBase);

  const de = (companiaId: number): AlcanceResuelto => ({ enlace: 'compania', companiaId });

  it('«contiene» en medio de la placa, en minúsculas o mayúsculas; prefijo primero y luego por recencia', async () => {
    const x = await s.cia('X');
    const u = unico().slice(-3);
    await s.tramite({ cia: x, placa: `Z${u}91`, creadoFlit: '2035-03-10T15:00:00Z' });   // en medio, la más reciente
    await s.tramite({ cia: x, placa: `${u}123`, creadoFlit: '2035-01-10T15:00:00Z' });   // empieza por el texto
    await s.tramite({ cia: x, placa: `YY${u}2`, creadoFlit: '2035-02-10T15:00:00Z' });   // en medio
    await s.tramite({ cia: x, placa: 'ZQ0000', creadoFlit: '2035-03-11T15:00:00Z' });    // no coincide
    const r = await sugerirPlacas(u.toLowerCase(), de(x));
    expect(r.sugerencias.map((g) => g.placa)).toEqual([`${u}123`, `Z${u}91`, `YY${u}2`]);
    expect(r.hayMas).toBe(false);
  });

  it('una por placa (≤ 8 distintas) y `hayMas` si hay una novena; sin conteo de trámites ni datos del comprador', async () => {
    const x = await s.cia('X');
    const u = unico();
    for (let i = 0; i < 10; i++) {
      await s.tramite({ cia: x, placa: `${u}${i}`, creadoFlit: `2035-03-${String(10 + i).padStart(2, '0')}T15:00:00Z` });
    }
    await s.tramite({ cia: x, placa: `${u}9`, creadoFlit: '2035-01-01T15:00:00Z' });        // la misma placa, otro trámite
    const r = await sugerirPlacas(u, de(x));
    expect(r.sugerencias).toHaveLength(8);
    expect(r.hayMas).toBe(true);
    expect(new Set(r.sugerencias.map((g) => g.placa)).size).toBe(8);
    expect(r.sugerencias[0]!.placa).toBe(`${u}9`);                                           // la más reciente primero
    for (const g of r.sugerencias) expect(Object.keys(g).sort()).toEqual(['compania', 'flitEstado', 'placa']);
    expect(JSON.stringify(r)).not.toMatch(/comprador|tramites|nit|documento/i);

    const nueve = await sugerirPlacas(u, de(x));
    expect(nueve).toEqual(r); // determinista
  });

  it('manda el trámite MÁS RECIENTE dentro del alcance (compañía y flit_estado de ese trámite)', async () => {
    const x = await s.cia('Equis'); const y = await s.cia('Ye');
    const u = unico();
    const placa = `${u}77`;
    await s.tramite({ cia: x, placa, creadoFlit: '2035-01-01T15:00:00Z', flitEstado: 'Aprobado' });
    await s.tramite({ cia: x, placa, creadoFlit: '2035-02-01T15:00:00Z', flitEstado: 'Entregado' });
    await s.tramite({ cia: y, placa, creadoFlit: '2035-03-01T15:00:00Z', flitEstado: 'Asignado' });
    const deX = await sugerirPlacas(placa, de(x));
    expect(deX.sugerencias).toHaveLength(1);
    expect(deX.sugerencias[0]).toMatchObject({ placa, flitEstado: 'Entregado' });
    expect(deX.sugerencias[0]!.compania).toMatch(/^Equis/);
    const todo = await sugerirPlacas(placa, { enlace: 'ninguno' });
    expect(todo.sugerencias).toHaveLength(1);
    expect(todo.sugerencias[0]).toMatchObject({ placa, flitEstado: 'Asignado' });
    expect(todo.sugerencias[0]!.compania).toMatch(/^Ye/);
  });

  it('fuera de alcance → lista vacía (no un error); los comodines del LIKE no coinciden con todo', async () => {
    const x = await s.cia('X'); const y = await s.cia('Y');
    const u = unico();
    await s.tramite({ cia: x, placa: `${u}55` });
    expect(await sugerirPlacas(u, de(y))).toEqual({ sugerencias: [], hayMas: false });
    expect(await sugerirPlacas(u, { enlace: 'compania', companiaId: null })).toEqual({ sugerencias: [], hayMas: false });
    expect(await sugerirPlacas('%%%', de(x))).toEqual({ sugerencias: [], hayMas: false });
    expect(await sugerirPlacas('___', de(x))).toEqual({ sugerencias: [], hayMas: false });
    expect((await sugerirPlacas(u, de(x))).sugerencias).toHaveLength(1);
  });
});
