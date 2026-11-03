// HU #13989 (ADR-0033 §2) — buffer en memoria + UPSERT por lotes. S1–S7 de la lista del ADR.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.hoisted(() => { process.env.USO_LEGACY_CONTEO_ENABLED = '1'; });

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../../src/shared/logger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/shared/logger.js')>()),
  loggerFor: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../src/db/client.js', () => ({ db: { insert: vi.fn() }, getPoolStats: vi.fn() }));

const { db } = await import('../../src/db/client.js');
const metrics = await import('../../src/shared/metrics.js');
const {
  acumular, flushUsoLegacy, cerrarUsoLegacy, _bufferUsoLegacy, _reiniciarUsoLegacy,
  INTERVALO_FLUSH_MS, TIMEOUT_CIERRE_MS, TIMEOUT_FLUSH_MS, TOPE_CLAVES,
} = await import('../../src/modules/uso-legacy/uso-legacy.service.js');

type Fila = { dia: string; modulo: string; ruta: string; metodo: string; consumidor: string; total: number };

/** `db.insert(...).values(filas).onConflictDoUpdate(...)`: guarda lo enviado y responde lo que diga `resultado`. */
function insertQue(resultado: () => Promise<unknown>) {
  const lotes: Fila[][] = [];
  vi.mocked(db.insert).mockImplementation((() => ({
    values: (filas: Fila[]) => {
      lotes.push(filas);
      return { onConflictDoUpdate: () => resultado() };
    },
  })) as never);
  return lotes;
}

const conteo = (extra: Partial<Parameters<typeof acumular>[0]> = {}) => ({
  prefijo: '/api/soat', modulo: 'soat' as const, patron: '/stats', metodo: 'GET', consumidor: 'admin', ...extra,
});
const claves = () => [..._bufferUsoLegacy().keys()];
const valorMetrica = async (c: { get(): Promise<{ values: { value: number; labels: Record<string, unknown> }[] }> }, resultado?: string) =>
  (await c.get()).values.find((v) => !resultado || v.labels.resultado === resultado)?.value ?? 0;

beforeEach(() => {
  _reiniciarUsoLegacy();
  vi.mocked(db.insert).mockReset();
  warn.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  _reiniciarUsoLegacy();
});

describe('S1 — agregación y día civil de Colombia', () => {
  it('agrega por clave', () => {
    acumular(conteo());
    acumular(conteo());
    acumular(conteo({ consumidor: 'contable' }));
    expect(_bufferUsoLegacy().size).toBe(2);
    expect([..._bufferUsoLegacy().values()].sort()).toEqual([1, 2]);
  });

  it('a las 19:30 de Bogotá (00:30 UTC del día siguiente) el día no avanza, y lo fija el conteo, no el flush', async () => {
    const lotes = insertQue(() => Promise.resolve([]));
    vi.useFakeTimers({ now: new Date('2026-11-04T00:30:00Z') });
    acumular(conteo());
    vi.setSystemTime(new Date('2026-11-05T15:00:00Z'));
    await flushUsoLegacy();
    expect(lotes[0]![0]!.dia).toBe('2026-11-03');
  });
});

describe('S2 — flush', () => {
  it('una sola sentencia, claves ordenadas, y vacía el buffer', async () => {
    const lotes = insertQue(() => Promise.resolve([]));
    const hoy = new Date('2026-11-03T15:00:00Z');
    acumular(conteo({ patron: '/zeta' }), hoy);
    acumular(conteo({ patron: '/alfa' }), hoy);
    acumular(conteo({ patron: '/alfa' }), hoy);
    await flushUsoLegacy();
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(lotes[0]).toEqual([
      { dia: '2026-11-03', modulo: 'soat', ruta: '/api/soat/alfa', metodo: 'GET', consumidor: 'admin', total: 2 },
      { dia: '2026-11-03', modulo: 'soat', ruta: '/api/soat/zeta', metodo: 'GET', consumidor: 'admin', total: 1 },
    ]);
    expect(_bufferUsoLegacy().size).toBe(0);
  });

  it('con el buffer vacío no consulta', async () => {
    await flushUsoLegacy();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('el temporizador se arma con el primer conteo y vuelca a los 60 s', async () => {
    vi.useFakeTimers();
    insertQue(() => Promise.resolve([]));
    acumular(conteo());
    await vi.advanceTimersByTimeAsync(INTERVALO_FLUSH_MS - 1);
    expect(db.insert).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });
});

describe('S3 — fallo de BD', () => {
  it('reintegra, avisa sin rutas ni roles, mide `error`, y el flush siguiente envía la suma', async () => {
    const errorAntes = await valorMetrica(metrics.usoLegacyFlushTotal, 'error');
    const hoy = new Date('2026-11-03T15:00:00Z');
    insertQue(() => Promise.reject(Object.assign(new Error('Failed query params: /api/soat/stats,admin'), { code: '57P01' })));
    acumular(conteo(), hoy);
    await expect(flushUsoLegacy()).resolves.toBeUndefined();

    expect(_bufferUsoLegacy().size).toBe(1);
    expect(await valorMetrica(metrics.usoLegacyFlushTotal, 'error')).toBe(errorAntes + 1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toEqual({ err: '57P01', claves: 1, conteos: 1 });
    expect(JSON.stringify(warn.mock.calls[0])).not.toMatch(/api\/soat|admin/);

    const lotes = insertQue(() => Promise.resolve([]));
    acumular(conteo(), hoy);
    const okAntes = await valorMetrica(metrics.usoLegacyFlushTotal, 'ok');
    await flushUsoLegacy();
    expect(lotes[0]![0]!.total).toBe(2);
    expect(await valorMetrica(metrics.usoLegacyFlushTotal, 'ok')).toBe(okAntes + 1);
  });
});

describe('S4 — tope de claves', () => {
  it('con 5000 claves: una nueva se descarta y se mide; una existente sigue sumando', async () => {
    const hoy = new Date('2026-11-03T15:00:00Z');
    for (let i = 0; i < TOPE_CLAVES; i += 1) acumular(conteo({ patron: `/r${i}` }), hoy);
    expect(_bufferUsoLegacy().size).toBe(TOPE_CLAVES);
    const antes = await valorMetrica(metrics.usoLegacyConteosDescartadosTotal);

    acumular(conteo({ patron: '/nueva' }), hoy);
    expect(_bufferUsoLegacy().size).toBe(TOPE_CLAVES);
    expect(claves().some((c) => c.includes('/nueva'))).toBe(false);
    expect(await valorMetrica(metrics.usoLegacyConteosDescartadosTotal)).toBe(antes + 1);

    acumular(conteo({ patron: '/r0' }), hoy);
    expect(_bufferUsoLegacy().get(claves().find((c) => c.includes('/r0\t'))!)).toBe(2);
    expect(await valorMetrica(metrics.usoLegacyConteosDescartadosTotal)).toBe(antes + 1);
  });
});

describe('S5 — solapamiento y timeout', () => {
  it('un flush en curso no lanza otro; a los 10 s reintegra y deja de bloquear', async () => {
    vi.useFakeTimers();
    insertQue(() => new Promise(() => {})); // conexión colgada
    acumular(conteo());
    const primero = flushUsoLegacy();
    acumular(conteo());
    const segundo = flushUsoLegacy();
    expect(db.insert).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(TIMEOUT_FLUSH_MS);
    await Promise.all([primero, segundo]);
    expect(warn.mock.calls[0]![0]).toMatchObject({ claves: 1, conteos: 1 });
    expect([..._bufferUsoLegacy().values()]).toEqual([2]);

    const lotes = insertQue(() => Promise.resolve([]));
    await flushUsoLegacy();
    expect(lotes[0]![0]!.total).toBe(2);
  });
});

describe('S6 — cierre', () => {
  it('vacía el buffer, incluido lo contado durante un flush en curso', async () => {
    let soltar!: () => void;
    const lotes = insertQue(() => new Promise<void>((r) => { soltar = r; }));
    acumular(conteo());
    void flushUsoLegacy();
    acumular(conteo({ patron: '/despues' }));
    const cierre = cerrarUsoLegacy();
    soltar();
    await vi.waitFor(() => expect(lotes).toHaveLength(2));
    soltar();
    await cierre;
    expect(_bufferUsoLegacy().size).toBe(0);
  });

  it('nunca rechaza, aunque la BD falle', async () => {
    insertQue(() => Promise.reject(new Error('caída')));
    acumular(conteo());
    await expect(cerrarUsoLegacy()).resolves.toBeUndefined();
  });

  it('con la BD colgada termina por su tope de 5 s', async () => {
    vi.useFakeTimers();
    insertQue(() => new Promise(() => {}));
    acumular(conteo());
    let termino = false;
    void cerrarUsoLegacy().then(() => { termino = true; });
    await vi.advanceTimersByTimeAsync(TIMEOUT_CIERRE_MS - 1);
    expect(termino).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(termino).toBe(true);
  });
});

describe('S7 — normalización de la clave', () => {
  it('método raro → OTRO; los conocidos se conservan', () => {
    acumular(conteo({ metodo: 'PROPFIND' }));
    acumular(conteo({ metodo: 'PATCH', patron: '/p' }));
    expect(claves().some((c) => c.endsWith('\tOTRO\tadmin'))).toBe(true);
    expect(claves().some((c) => c.includes('\t/api/soat/p\tPATCH\t'))).toBe(true);
  });

  it('patrón de más de 200 caracteres, ausente o no string → (sin_ruta)', () => {
    acumular(conteo({ patron: `/${'x'.repeat(200)}` }));
    acumular(conteo({ patron: undefined }));
    acumular(conteo({ patron: ['/a', '/b'] }));
    acumular(conteo({ patron: /re/ }));
    expect(_bufferUsoLegacy().size).toBe(1);
    expect(claves()[0]).toContain('\t/api/soat/(sin_ruta)\t');
    expect([..._bufferUsoLegacy().values()]).toEqual([4]);
  });

  it('`/` no se añade al prefijo, y sin rol el consumidor es `publico`', () => {
    acumular(conteo({ patron: '/', consumidor: undefined }));
    expect(claves()[0]).toMatch(/\t\/api\/soat\tGET\tpublico$/);
  });
});
