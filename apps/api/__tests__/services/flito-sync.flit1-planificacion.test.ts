// HU #13629 (Feature #13612, Épica #13576) — planificación pura de la lectura automática de FLIT 1.
// AC1 (ventana móvil), AC2 (nocturna 02:00 y recuperación), AC3 (semilla), AC4 (tope 90), AC8 (parámetros
// en caliente). Sin base ni reloj del sistema: `ahora` explícito. Bogotá = UTC−5 fijo, nunca el huso local.

import { describe, it, expect, afterEach } from 'vitest';

process.env.TZ = 'UTC';

const { planificarLecturaFlit1, semillaLecturaFlit1, diaBogota, sumarDias, TOPE_DIAS } =
  await import('../../src/modules/flito-sync/flit1-lectura-automatica.service.js');

type Entrada = Parameters<typeof planificarLecturaFlit1>[0];
const P = { frecuenciaMinutos: 2, ventanaDias: 7, ventanaNocturnaDias: 60, arranque: null as string | null };
const d = (iso: string) => new Date(iso);
const menos = (base: string, ms: number) => new Date(d(base).getTime() - ms);
const MIN = 60_000;

function plan(o: Partial<Entrada> & { ahora: Date }, marcas: Partial<Entrada['marcas']> = {}, params: Partial<typeof P> = {}) {
  return planificarLecturaFlit1({
    ahora: o.ahora,
    parametros: { ...P, ...params },
    marcas: { ultimaCorridaEn: null, ultimaBuenaEn: null, nocturnaBuenaDia: null, ...marcas },
    semillaKv: o.semillaKv ?? null,
  });
}

// 2026-10-16 10:00 en Bogotá; la nocturna de hoy ya se hizo, salvo que el caso diga otra cosa.
const AHORA = '2026-10-16T15:00:00Z';
const HOY_HECHA = { nocturnaBuenaDia: '2026-10-16' };

describe('HU #13629 · AC1 · periódica con ventana móvil', () => {
  it('cumplida la frecuencia: periódica, initialDate = hoy − ventana, finalDate = mañana (exclusivo)', () => {
    const r = plan({ ahora: d(AHORA) }, { ...HOY_HECHA, ultimaCorridaEn: menos(AHORA, 2 * MIN), ultimaBuenaEn: menos(AHORA, 2 * MIN) });
    expect(r).toMatchObject({ toca: true, tipo: 'periodica', initialDate: '20261009', finalDate: '20261017' });
    if (r.toca) expect(r.proximaPrevistaEn.toISOString()).toBe('2026-10-16T15:02:00.000Z');
  });

  it('antes de la frecuencia no toca; la próxima es última corrida + frecuencia', () => {
    const r = plan({ ahora: d(AHORA) }, { ...HOY_HECHA, ultimaCorridaEn: menos(AHORA, MIN), ultimaBuenaEn: menos(AHORA, MIN) });
    expect(r).toMatchObject({ toca: false, motivo: 'no_toca' });
    expect(r.proximaPrevistaEn.toISOString()).toBe('2026-10-16T15:01:00.000Z');
  });

  it('tolerancia de medio tick: a frecuencia − 30 s ya toca; a frecuencia − 31 s todavía no', () => {
    const marcas = { ...HOY_HECHA, ultimaBuenaEn: menos(AHORA, 5 * MIN) };
    expect(plan({ ahora: d(AHORA) }, { ...marcas, ultimaCorridaEn: menos(AHORA, 90_000) }).toca).toBe(true);
    expect(plan({ ahora: d(AHORA) }, { ...marcas, ultimaCorridaEn: menos(AHORA, 89_000) }).toca).toBe(false);
  });

  it('borde de día: 04:30Z del 17 son las 23:30 del 16 en Bogotá → hoy 20261016, final 20261017', () => {
    const ahora = '2026-10-17T04:30:00Z';
    const r = plan({ ahora: d(ahora) }, { ...HOY_HECHA, ultimaCorridaEn: menos(ahora, 3 * MIN), ultimaBuenaEn: menos(ahora, 3 * MIN) });
    expect(r).toMatchObject({ toca: true, tipo: 'periodica', initialDate: '20261009', finalDate: '20261017' });
  });
});

describe('HU #13629 · AC2 · nocturna a las 02:00 (Bogotá) o en el primer tick posterior', () => {
  const AYER = { nocturnaBuenaDia: '2026-10-15', ultimaBuenaEn: d('2026-10-16T06:55:00Z') };

  it('01:59 Bogotá: no hay nocturna (y la periódica no toca a 1 min)', () => {
    const r = plan({ ahora: d('2026-10-16T06:59:00Z') }, { ...AYER, ultimaCorridaEn: d('2026-10-16T06:58:00Z') });
    expect(r.toca).toBe(false);
  });

  it('02:00 Bogotá: nocturna aunque la periódica no tocara (la última corrida fue antes de las 02:00)', () => {
    const r = plan({ ahora: d('2026-10-16T07:00:00Z') }, { ...AYER, ultimaCorridaEn: d('2026-10-16T06:59:30Z') });
    expect(r).toMatchObject({ toca: true, tipo: 'nocturna', initialDate: '20260817', finalDate: '20261017' });
  });

  it('proceso caído a las 02:00: el primer tick del día (08:00) hace la nocturna', () => {
    const r = plan({ ahora: d('2026-10-16T13:00:00Z') }, {
      nocturnaBuenaDia: '2026-10-15', ultimaCorridaEn: d('2026-10-15T20:00:00Z'), ultimaBuenaEn: d('2026-10-15T20:00:00Z'),
    });
    expect(r).toMatchObject({ toca: true, tipo: 'nocturna', initialDate: '20260817' });
  });

  it('nocturna fallida: no se reintenta al minuto sino en el siguiente slot de la frecuencia', () => {
    const marcas = { ...AYER, ultimaCorridaEn: d('2026-10-16T07:00:00Z') };
    expect(plan({ ahora: d('2026-10-16T07:01:00Z') }, marcas).toca).toBe(false);
    expect(plan({ ahora: d('2026-10-16T07:02:00Z') }, marcas)).toMatchObject({ toca: true, tipo: 'nocturna' });
  });

  it('nocturna buena de hoy: lo siguiente vuelve a ser periódica', () => {
    const r = plan({ ahora: d('2026-10-16T07:05:00Z') }, {
      nocturnaBuenaDia: '2026-10-16', ultimaCorridaEn: d('2026-10-16T07:00:00Z'), ultimaBuenaEn: d('2026-10-16T07:00:00Z'),
    });
    expect(r).toMatchObject({ toca: true, tipo: 'periodica', initialDate: '20261009' });
  });
});

describe('HU #13629 · AC3 · primera lectura desde la semilla (arranque › system_kv › hace 1 mes)', () => {
  const primera = (params: Partial<typeof P>, semillaKv: string | null = null) =>
    plan({ ahora: d(AHORA), semillaKv }, HOY_HECHA, params);

  it('arranque guardado manda', () => {
    expect(primera({ arranque: '2026-09-01' }, '2026-10-01T20:00:00Z')).toMatchObject({ toca: true, tipo: 'periodica', initialDate: '20260901' });
  });

  it('sin arranque: el día Bogotá de system_kv (día completo)', () => {
    expect(primera({}, '2026-10-01T20:00:00Z')).toMatchObject({ initialDate: '20261001' });
    // 03:00Z del 2 = 22:00 del 1 en Bogotá.
    expect(primera({}, '2026-10-02T03:00:00Z')).toMatchObject({ initialDate: '20261001' });
  });

  it('sin arranque ni system_kv (o ilegible): hace 1 mes', () => {
    expect(primera({})).toMatchObject({ initialDate: '20260916' });
    expect(primera({}, 'no-es-fecha')).toMatchObject({ initialDate: '20260916' });
  });

  it('una semilla más reciente que la ventana no la acorta: min(hoy − ventana, semilla)', () => {
    expect(primera({ arranque: '2026-10-15' })).toMatchObject({ initialDate: '20261009' });
  });

  it('con una corrida buena la semilla ya no cuenta', () => {
    const r = plan({ ahora: d(AHORA), semillaKv: '2026-01-01T00:00:00Z' },
      { ...HOY_HECHA, ultimaCorridaEn: menos(AHORA, 2 * MIN), ultimaBuenaEn: menos(AHORA, 2 * MIN) }, { arranque: '2026-08-01' });
    expect(r).toMatchObject({ initialDate: '20261009' });
  });

  it('semillaLecturaFlit1 aislada: precedencia', () => {
    expect(semillaLecturaFlit1('2026-10-16', '2026-09-01', '2026-10-01T20:00:00Z')).toBe('2026-09-01');
    expect(semillaLecturaFlit1('2026-10-16', null, '2026-10-01T20:00:00Z')).toBe('2026-10-01');
    expect(semillaLecturaFlit1('2026-10-16', null, null)).toBe('2026-09-16');
  });
});

describe('HU #13629 · AC4 · recuperación con tope de 90 días', () => {
  it('última buena hace 20 días: lee desde ese día (min con la ventana)', () => {
    const r = plan({ ahora: d(AHORA) }, { ...HOY_HECHA, ultimaCorridaEn: menos(AHORA, 2 * MIN), ultimaBuenaEn: d('2026-09-26T15:00:00Z') });
    expect(r).toMatchObject({ initialDate: '20260926' });
  });

  it('última buena hace 120 días: tope hoy − 90', () => {
    const r = plan({ ahora: d(AHORA) }, { ...HOY_HECHA, ultimaCorridaEn: menos(AHORA, 2 * MIN), ultimaBuenaEn: d('2026-06-18T15:00:00Z') });
    expect(r).toMatchObject({ initialDate: '20260718' });
    expect(sumarDias('2026-10-16', -TOPE_DIAS)).toBe('2026-07-18');
  });

  it('arranque de hace 6 meses en la primera lectura: también con tope', () => {
    expect(plan({ ahora: d(AHORA) }, HOY_HECHA, { arranque: '2026-04-16' })).toMatchObject({ initialDate: '20260718' });
  });
});

describe('HU #13629 · AC8 · parámetros en caliente', () => {
  it('frecuencia 2 → 10: el siguiente tick ya decide con 10 y recalcula la próxima', () => {
    const marcas = { ...HOY_HECHA, ultimaCorridaEn: menos(AHORA, 3 * MIN), ultimaBuenaEn: menos(AHORA, 3 * MIN) };
    expect(plan({ ahora: d(AHORA) }, marcas, { frecuenciaMinutos: 2 }).toca).toBe(true);
    const r = plan({ ahora: d(AHORA) }, marcas, { frecuenciaMinutos: 10 });
    expect(r.toca).toBe(false);
    expect(r.proximaPrevistaEn.toISOString()).toBe('2026-10-16T15:07:00.000Z');
  });

  it('ventana 7 → 14 aplica al rango de la siguiente corrida', () => {
    const marcas = { ...HOY_HECHA, ultimaCorridaEn: menos(AHORA, 2 * MIN), ultimaBuenaEn: menos(AHORA, 2 * MIN) };
    expect(plan({ ahora: d(AHORA) }, marcas, { ventanaDias: 14 })).toMatchObject({ initialDate: '20261002' });
  });
});

describe('HU #13629 · fechas desde UTC, no desde el huso del servidor', () => {
  afterEach(() => { process.env.TZ = 'UTC'; });

  it('el mismo instante da el mismo plan con TZ=Asia/Tokyo', () => {
    const casos = [
      () => plan({ ahora: d('2026-10-17T04:30:00Z') }, { ...HOY_HECHA, ultimaCorridaEn: d('2026-10-17T04:25:00Z'), ultimaBuenaEn: d('2026-10-17T04:25:00Z') }),
      () => plan({ ahora: d('2026-10-16T07:00:00Z') }, { nocturnaBuenaDia: '2026-10-15', ultimaCorridaEn: d('2026-10-16T06:59:30Z'), ultimaBuenaEn: null }),
    ];
    const enUtc = casos.map((c) => c());
    process.env.TZ = 'Asia/Tokyo';
    expect(new Date('2026-10-17T04:30:00Z').getHours()).toBe(13); // el huso sí cambió
    expect(casos.map((c) => c())).toEqual(enUtc);
    expect(diaBogota(d('2026-10-17T04:30:00Z'))).toBe('2026-10-16');
  });
});
