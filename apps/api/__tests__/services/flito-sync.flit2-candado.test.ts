// HU #13092 (Feature #13059) — candado de la lectura de FLIT 2 (AC2).
//
// El advisory lock es de SESIÓN: tomarlo y soltarlo tiene que ir por LA MISMA conexión reservada, y
// esa conexión tiene que volver al pool pase lo que pase. Aquí `db.$client.reserve()` es un doble que
// registra cada sentencia con sus parámetros y simula el candado del servidor (compartido entre
// «procesos»). El CI no levanta Postgres; la prueba contra una base real está en el diseño de la HU.

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Sentencia { conexion: number; texto: string; valores: unknown[] }
const srv = vi.hoisted(() => ({
  duenoDelCandado: null as number | null,
  sentencias: [] as { conexion: number; texto: string; valores: unknown[] }[],
  liberadas: [] as number[],
  siguiente: 1,
  fallarUnlock: false,
}));

function reservar() {
  const id = srv.siguiente++;
  const conexion = async (strings: TemplateStringsArray, ...valores: unknown[]) => {
    const texto = strings.join('$');
    srv.sentencias.push({ conexion: id, texto, valores });
    if (/pg_try_advisory_lock/.test(texto)) {
      if (srv.duenoDelCandado !== null && srv.duenoDelCandado !== id) return [{ tomado: false }];
      srv.duenoDelCandado = id;
      return [{ tomado: true }];
    }
    if (/pg_advisory_unlock/.test(texto)) {
      if (srv.fallarUnlock) throw new Error('conexión cerrada');
      const era = srv.duenoDelCandado === id;
      if (era) srv.duenoDelCandado = null;
      return [{ pg_advisory_unlock: era }];
    }
    throw new Error(`sentencia inesperada: ${texto}`);
  };
  return Object.assign(conexion, { release: () => { srv.liberadas.push(id); } });
}

vi.mock('../../src/db/client.js', () => ({
  db: { $client: { reserve: async () => reservar() } },
  getPoolStats: vi.fn(),
}));
const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../src/shared/logger.js', () => ({ logger: logMock, loggerFor: () => logMock }));

const { conCandadoLectura, CLAVE_CANDADO_LECTURA_FLIT2 } = await import('../../src/modules/flito-sync/flit2-candado.js');

const de = (c: number): Sentencia[] => srv.sentencias.filter((s) => s.conexion === c);

beforeEach(() => {
  srv.duenoDelCandado = null; srv.sentencias = []; srv.liberadas = []; srv.siguiente = 1; srv.fallarUnlock = false;
  logMock.warn.mockClear();
});

describe('HU #13092 AC2 · candado de la lectura (advisory lock de sesión)', () => {
  it('clave fija de dos enteros (13092, 2): toma y suelta por la MISMA conexión, que vuelve al pool', async () => {
    expect(CLAVE_CANDADO_LECTURA_FLIT2).toEqual([13_092, 2]);
    const r = await conCandadoLectura(async () => 'hecho');
    expect(r).toEqual({ tomado: true, valor: 'hecho' });
    const s = de(1);
    expect(s.map((x) => x.texto.match(/pg_\w+/)?.[0])).toEqual(['pg_try_advisory_lock', 'pg_advisory_unlock']);
    for (const x of s) expect(x.valores).toEqual([13_092, 2]);
    expect(srv.liberadas).toEqual([1]);
    expect(srv.duenoDelCandado).toBeNull();
  });

  it('con el candado en otra sesión (otro proceso): no ejecuta, no intenta soltar lo ajeno y devuelve la conexión', async () => {
    srv.duenoDelCandado = 99;
    const fn = vi.fn(async () => 'no');
    const r = await conCandadoLectura(fn);
    expect(r).toEqual({ tomado: false });
    expect(fn).not.toHaveBeenCalled();
    expect(de(1).some((x) => /unlock/.test(x.texto))).toBe(false);
    expect(srv.liberadas).toEqual([1]);
    expect(srv.duenoDelCandado).toBe(99);
  });

  it('dos corridas simultáneas: la segunda ve el candado tomado mientras la primera sigue', async () => {
    let soltar!: () => void;
    const primera = conCandadoLectura(() => new Promise<string>((ok) => { soltar = () => ok('primera'); }));
    await new Promise((ok) => { setImmediate(ok); });
    const segunda = await conCandadoLectura(async () => 'segunda');
    expect(segunda).toEqual({ tomado: false });
    soltar();
    expect(await primera).toEqual({ tomado: true, valor: 'primera' });
    expect(await conCandadoLectura(async () => 'tercera')).toEqual({ tomado: true, valor: 'tercera' });
  });

  it('si la corrida lanza, el candado se suelta, la conexión vuelve y el error se propaga', async () => {
    await expect(conCandadoLectura(async () => { throw new Error('se cayó la lectura'); })).rejects.toThrow('se cayó la lectura');
    expect(srv.duenoDelCandado).toBeNull();
    expect(srv.liberadas).toEqual([1]);
  });

  it('si soltar falla (conexión caída: Postgres ya lo soltó) no tapa el resultado y la conexión vuelve igual', async () => {
    srv.fallarUnlock = true;
    await expect(conCandadoLectura(async () => 'ok')).resolves.toEqual({ tomado: true, valor: 'ok' });
    expect(srv.liberadas).toEqual([1]);
    expect(logMock.warn).toHaveBeenCalledTimes(1);
  });
});
