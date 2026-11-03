// Feature #14097 (HU #14098 AC1, AC3) — script de recifrado. La BD es un doble en memoria que evalúa
// los parámetros que Drizzle genera de verdad (paginación y guarda `AND columna = valor leído`), para
// que el guardado condicional se pruebe y no se dé por hecho.
import crypto from 'node:crypto';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Fila = {
  id: number;
  fotoRostro: string | null;
  fotoCedulaFrontal: string | null;
  fotoCedulaReverso: string | null;
};

const m = vi.hoisted(() => ({
  filas: [] as Fila[],
  limites: [] as number[],
  escrituras: [] as { id: number; prop: string }[],
  antesDeEscribir: null as null | ((id: number) => void),
}));

const dialect = new PgDialect();
const PROP: Record<string, keyof Omit<Fila, 'id'>> = {
  foto_rostro: 'fotoRostro',
  foto_cedula_frontal: 'fotoCedulaFrontal',
  foto_cedula_reverso: 'fotoCedulaReverso',
};

function fakeSelect() {
  let despuesDe = 0;
  let limite = Infinity;
  const q = {
    from: () => q,
    where: (cond: SQL) => { despuesDe = Number(dialect.sqlToQuery(cond).params[0]); return q; },
    orderBy: () => q,
    limit: (n: number) => { limite = n; m.limites.push(n); return q; },
    then: (ok: (v: Fila[]) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(
      m.filas.filter((f) => f.id > despuesDe).sort((a, b) => a.id - b.id).slice(0, limite).map((f) => ({ ...f })),
    ).then(ok, ko),
  };
  return q;
}

function fakeUpdate() {
  let cambios: Record<string, string> = {};
  let cond: SQL;
  const q = {
    set: (v: Record<string, string>) => { cambios = v; return q; },
    where: (c: SQL) => { cond = c; return q; },
    returning: async () => {
      const { sql: texto, params } = dialect.sqlToQuery(cond);
      const columna = /"(foto_\w+)" = \$2/.exec(texto)?.[1];
      if (!columna) throw new Error(`el UPDATE no tiene la guarda sobre la columna: ${texto}`);
      const id = Number(params[0]);
      m.antesDeEscribir?.(id);
      const fila = m.filas.find((f) => f.id === id);
      if (!fila || fila[PROP[columna]] !== params[1]) return [];
      const [prop, valor] = Object.entries(cambios)[0];
      expect(prop).toBe(PROP[columna]);
      (fila as Record<string, unknown>)[prop] = valor;
      m.escrituras.push({ id, prop });
      return [{ id }];
    },
  };
  return q;
}

vi.mock('../../src/db/client.js', () => ({
  db: { select: () => fakeSelect(), update: () => fakeUpdate() },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

vi.mock('../../src/services/storage.js', () => ({
  uploadPhoto: vi.fn(), getPhoto: vi.fn(), ensureBucket: vi.fn(),
}));

const { env } = await import('../../src/config/env.js');
const { decryptPiiText } = await import('../../src/shared/utils/crypto.js');
const { clasificarFoto } = await import('../../src/modules/tramites/identidad.fotos.js');
const { run, modoDesdeArgs, codigoSalida, LOTE } = await import('../../src/scripts/flito-recifrar-biometria.js');

const TABLA = 'tramites_validaciones';
const PLANO_VIEJO = 'data:image/jpeg;base64,RkFDRV9WSUVKTw==';
const DATA_URI = 'data:image/png;base64,RkFDRV9VUkk=';
const BASE64 = 'RkFDRUJBU0U2NA'.repeat(10);
const DESCONOCIDO = 'valor raro sin formato';
const CLAVE = 'validaciones/1/rostro_abc.jpg';

function cifrarViejo(plano: string, passphrase: string = env.PII_ENC_KEY): string {
  const key = crypto.scryptSync(passphrase, 'kyverum-pii-salt', 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plano, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${data.toString('base64')}`;
}

function fila(id: number, p: Partial<Omit<Fila, 'id'>> = {}): Fila {
  return { id, fotoRostro: null, fotoCedulaFrontal: null, fotoCedulaReverso: null, ...p };
}

const instantanea = () => JSON.stringify(m.filas);

beforeEach(() => {
  m.filas.length = 0;
  m.limites.length = 0;
  m.escrituras.length = 0;
  m.antesDeEscribir = null;
});

describe('--dry-run', () => {
  it('no escribe, cuenta por columna y clase, y el resultado no lleva valores', async () => {
    const viejo = cifrarViejo(PLANO_VIEJO);
    m.filas.push(
      fila(1, { fotoRostro: viejo, fotoCedulaFrontal: DATA_URI, fotoCedulaReverso: BASE64 }),
      fila(2, { fotoRostro: CLAVE, fotoCedulaFrontal: DESCONOCIDO }),
    );
    const antes = instantanea();

    const r = await run({ commit: false });

    expect(instantanea()).toBe(antes);
    expect(m.escrituras).toEqual([]);
    expect(r.modo).toBe('dry-run');
    expect(r.filas).toBe(2);
    expect(r.columnas.foto_rostro).toMatchObject({ viejo: 1, storage_key: 1, recifrable: 1, escrito: 0 });
    expect(r.columnas.foto_cedula_frontal).toMatchObject({ data_uri: 1, desconocido: 1, recifrable: 1, escrito: 0 });
    expect(r.columnas.foto_cedula_reverso).toMatchObject({ base64_plano: 1, vacio: 1, recifrable: 1, escrito: 0 });

    const salida = JSON.stringify(r);
    for (const secreto of [viejo, 'RkFDRV9WSUVKTw', DATA_URI, 'RkFDRUJBU0U2NA', DESCONOCIDO, CLAVE]) {
      expect(salida).not.toContain(secreto);
    }
  });

  it('detecta la llave equivocada: cuenta la indescifrable y sale 0', async () => {
    m.filas.push(fila(3, { fotoRostro: cifrarViejo(PLANO_VIEJO, 'otra-llave-otra-llave-otra-llave-otra-1234') }));

    const r = await run({ commit: false });

    expect(r.columnas.foto_rostro.viejo_indescifrable).toBe(1);
    expect(r.idsFallidos).toEqual([3]);
    expect(codigoSalida(r)).toBe(0);
  });
});

describe('--commit', () => {
  it('recifra viejo, data_uri y base64_plano al formato nuevo con el AAD de su celda', async () => {
    m.filas.push(fila(5, { fotoRostro: cifrarViejo(PLANO_VIEJO), fotoCedulaFrontal: DATA_URI, fotoCedulaReverso: BASE64 }));

    const r = await run({ commit: true });

    const f = m.filas[0];
    expect(clasificarFoto(f.fotoRostro)).toBe('nuevo');
    expect(clasificarFoto(f.fotoCedulaFrontal)).toBe('nuevo');
    expect(clasificarFoto(f.fotoCedulaReverso)).toBe('nuevo');
    expect(decryptPiiText(f.fotoRostro!, { table: TABLA, column: 'foto_rostro', id: 5 })).toBe(PLANO_VIEJO);
    expect(decryptPiiText(f.fotoCedulaFrontal!, { table: TABLA, column: 'foto_cedula_frontal', id: 5 })).toBe(DATA_URI);
    expect(decryptPiiText(f.fotoCedulaReverso!, { table: TABLA, column: 'foto_cedula_reverso', id: 5 })).toBe(BASE64);
    expect(r.columnas.foto_rostro.escrito).toBe(1);
    expect(r.columnas.foto_cedula_frontal.escrito).toBe(1);
    expect(r.columnas.foto_cedula_reverso.escrito).toBe(1);
    expect(r.pendientes).toBe(0);
    expect(codigoSalida(r)).toBe(0);
  });

  it('la segunda corrida no cambia nada: 0 escrituras y los mismos bytes', async () => {
    m.filas.push(fila(5, { fotoRostro: cifrarViejo(PLANO_VIEJO), fotoCedulaFrontal: DATA_URI, fotoCedulaReverso: BASE64 }));
    await run({ commit: true });
    const despuesDeLaPrimera = instantanea();
    m.escrituras.length = 0;

    const r = await run({ commit: true });

    expect(m.escrituras).toEqual([]);
    expect(instantanea()).toBe(despuesDeLaPrimera);
    expect(r.columnas.foto_rostro).toMatchObject({ nuevo: 1, escrito: 0, recifrable: 0 });
    expect(codigoSalida(r)).toBe(0);
  });

  it('desconocido y storage_key quedan intactos', async () => {
    m.filas.push(fila(6, { fotoRostro: DESCONOCIDO, fotoCedulaFrontal: CLAVE }));

    const r = await run({ commit: true });

    expect(m.filas[0].fotoRostro).toBe(DESCONOCIDO);
    expect(m.filas[0].fotoCedulaFrontal).toBe(CLAVE);
    expect(m.escrituras).toEqual([]);
    expect(r.columnas.foto_rostro.desconocido).toBe(1);
    expect(r.pendientes).toBe(0);
  });

  it('fila indescifrable: contada, no escrita, y las demás siguen; sale 2', async () => {
    const roto = cifrarViejo(PLANO_VIEJO, 'otra-llave-otra-llave-otra-llave-otra-1234');
    m.filas.push(fila(7, { fotoRostro: roto }), fila(8, { fotoRostro: DATA_URI }));

    const r = await run({ commit: true });

    expect(m.filas[0].fotoRostro).toBe(roto);
    expect(clasificarFoto(m.filas[1].fotoRostro)).toBe('nuevo');
    expect(r.columnas.foto_rostro.viejo_indescifrable).toBe(1);
    expect(r.idsFallidos).toEqual([7]);
    expect(r.pendientes).toBe(1);
    expect(codigoSalida(r)).toBe(2);
    expect(JSON.stringify(r)).not.toContain(roto);
  });

  it('no pisa un anonimizado concurrente: la guarda sobre el valor leído no escribe', async () => {
    m.filas.push(fila(9, { fotoRostro: DATA_URI }));
    m.antesDeEscribir = (id) => { m.filas.find((f) => f.id === id)!.fotoRostro = null; };

    const r = await run({ commit: true });

    expect(m.filas[0].fotoRostro).toBeNull();
    expect(r.columnas.foto_rostro.omitido_concurrente).toBe(1);
    expect(r.columnas.foto_rostro.escrito).toBe(0);
    expect(codigoSalida(r)).toBe(2);
  });

  it('pagina en lotes de 50 hasta agotar las filas', async () => {
    for (let id = 1; id <= LOTE + 3; id++) m.filas.push(fila(id, { fotoRostro: DATA_URI }));

    const r = await run({ commit: true });

    expect(LOTE).toBe(50);
    expect(new Set(m.limites)).toEqual(new Set([50]));
    expect(r.filas).toBe(53);
    expect(r.columnas.foto_rostro.escrito).toBe(53);
  });
});

describe('banderas', () => {
  it.each([
    [[], null],
    [['--dry-run', '--commit'], null],
    [['--otra'], null],
    [['--dry-run'], { commit: false }],
    [['--commit'], { commit: true }],
  ])('%j → %j', (args, esperado) => {
    expect(modoDesdeArgs(args)).toEqual(esperado);
  });
});
