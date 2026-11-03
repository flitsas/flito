// Feature #14097 (HU #14098 AC1, AC3) — script de recifrado. La BD es un doble en memoria que evalúa
// los parámetros que Drizzle genera de verdad (paginación y guarda `AND columna = valor leído`), para
// que el guardado condicional se pruebe y no se dé por hecho. El canario de llave se prueba con la
// llave cambiada de verdad vía `env.PII_ENC_KEY`: la primitiva de cifrado no se dobla.
import crypto from 'node:crypto';
import { PgDialect } from 'drizzle-orm/pg-core';
import { getTableName, type SQL, type Table } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Fila = {
  id: number;
  fotoRostro: string | null;
  fotoCedulaFrontal: string | null;
  fotoCedulaReverso: string | null;
};

type Conductor = {
  userId: number;
  cipher: Buffer;
  iv: Buffer;
  authTag: Buffer;
  aadNonce: string;
  keyVersion: number;
};

const m = vi.hoisted(() => ({
  filas: [] as Fila[],
  conductores: [] as Conductor[],
  lecturasDeLote: 0,
  antesDeLeerLote: null as null | ((n: number) => void),
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
  let tabla = '';
  let despuesDe = 0;
  let limite = Infinity;
  // Canario: el doble evalúa el patrón que el script manda a Postgres, no uno propio.
  let canario: null | { prop: keyof Omit<Fila, 'id'>; largo: number; patron: RegExp } = null;
  const q = {
    from: (t: Table) => { tabla = getTableName(t); return q; },
    where: (cond: SQL) => {
      if (tabla !== 'tramites_validaciones') return q;
      const { sql: texto, params } = dialect.sqlToQuery(cond);
      const columna = /left\("tramites_validaciones"\."(foto_\w+)", \$1\) ~ \$2/.exec(texto)?.[1];
      if (columna) canario = { prop: PROP[columna], largo: Number(params[0]), patron: new RegExp(String(params[1])) };
      else despuesDe = Number(params[0]);
      return q;
    },
    orderBy: () => q,
    limit: (n: number) => {
      limite = n;
      if (tabla === 'tramites_validaciones' && !canario) m.limites.push(n);
      return q;
    },
    then: (ok: (v: unknown[]) => unknown, ko?: (e: unknown) => unknown) => {
      let filas: unknown[];
      if (tabla === 'driver_profile') {
        filas = m.conductores.slice(0, limite);
      } else if (canario) {
        const { prop, largo, patron } = canario;
        filas = m.filas
          .filter((f) => f[prop] !== null && patron.test(f[prop]!.slice(0, largo)))
          .sort((a, b) => a.id - b.id)
          .slice(0, limite)
          .map((f) => ({ id: f.id, valor: f[prop] }));
      } else {
        m.antesDeLeerLote?.(++m.lecturasDeLote);
        filas = m.filas.filter((f) => f.id > despuesDe).sort((a, b) => a.id - b.id).slice(0, limite).map((f) => ({ ...f }));
      }
      return Promise.resolve(filas).then(ok, ko);
    },
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
const { decryptPiiText, encryptPii, encryptPiiText, newUuid } = await import('../../src/shared/utils/crypto.js');
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

const LLAVE_OTRA = 'otra-llave-otra-llave-otra-llave-otra-1234';
const LLAVE_BUENA = env.PII_ENC_KEY;
const CEDULA = '1020304050';

/** `foto_rostro` en formato vigente, cifrada con la llave activa al llamar. */
function cifrarNuevo(id: number, plano: string = PLANO_VIEJO): string {
  return encryptPiiText(plano, { table: TABLA, column: 'foto_rostro', id });
}

/** Mismo paquete y AAD que escribe `drivers.routes`. */
function conductor(userId: number): Conductor {
  const aadNonce = newUuid();
  const b = encryptPii(CEDULA, { table: 'driver_profile', column: 'cedula', empresaNit: String(userId), aadNonce });
  return { userId, cipher: b.cipher, iv: b.iv, authTag: b.authTag, aadNonce, keyVersion: b.keyVersion };
}

afterEach(() => {
  env.PII_ENC_KEY = LLAVE_BUENA;
});

beforeEach(() => {
  m.filas.length = 0;
  m.conductores.length = 0;
  m.lecturasDeLote = 0;
  m.antesDeLeerLote = null;
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

  it('una celda indescifrable junto a un canario bueno se cuenta y sale 0', async () => {
    m.filas.push(fila(2, { fotoRostro: cifrarNuevo(2) }), fila(3, { fotoRostro: cifrarViejo(PLANO_VIEJO, LLAVE_OTRA) }));

    const r = await run({ commit: false });

    expect(r.canario).toBe('ok');
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
    const roto = cifrarViejo(PLANO_VIEJO, LLAVE_OTRA);
    m.filas.push(fila(7, { fotoRostro: roto }), fila(8, { fotoRostro: DATA_URI }), fila(10, { fotoRostro: cifrarNuevo(10) }));

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
    m.conductores.push(conductor(1));
    m.antesDeEscribir = (id) => { m.filas.find((f) => f.id === id)!.fotoRostro = null; };

    const r = await run({ commit: true });

    expect(m.filas[0].fotoRostro).toBeNull();
    expect(r.columnas.foto_rostro.omitido_concurrente).toBe(1);
    expect(r.columnas.foto_rostro.escrito).toBe(0);
    expect(codigoSalida(r)).toBe(2);
  });

  it('pagina en lotes de 50 hasta agotar las filas', async () => {
    for (let id = 1; id <= LOTE + 3; id++) m.filas.push(fila(id, { fotoRostro: DATA_URI }));
    m.conductores.push(conductor(1));

    const r = await run({ commit: true });

    expect(LOTE).toBe(50);
    expect(new Set(m.limites)).toEqual(new Set([50]));
    expect(r.filas).toBe(53);
    expect(r.columnas.foto_rostro.escrito).toBe(53);
  });
});

describe('canario de llave', () => {
  it.each([
    ['nuevo', () => cifrarNuevo(1)],
    ['viejo', () => cifrarViejo(PLANO_VIEJO)],
  ])('--commit con llave errónea y canario %s: 0 escrituras, código 1, valores intactos', async (_clase, canario) => {
    m.filas.push(fila(1, { fotoRostro: canario() }), fila(2, { fotoCedulaFrontal: DATA_URI, fotoCedulaReverso: BASE64 }));
    const antes = instantanea();
    env.PII_ENC_KEY = LLAVE_OTRA;

    const r = await run({ commit: true });

    expect(m.escrituras).toEqual([]);
    expect(instantanea()).toBe(antes);
    expect(r.canario).toBe('fallo');
    expect(r.abortado).toBe(true);
    expect(codigoSalida(r)).toBe(1);
  });

  it('--dry-run con llave errónea: canario fallo y código 1', async () => {
    m.filas.push(fila(1, { fotoRostro: cifrarNuevo(1), fotoCedulaFrontal: DATA_URI }));
    const antes = instantanea();
    env.PII_ENC_KEY = LLAVE_OTRA;

    const r = await run({ commit: false });

    expect(r.modo).toBe('dry-run');
    expect(r.canario).toBe('fallo');
    expect(codigoSalida(r)).toBe(1);
    expect(instantanea()).toBe(antes);
  });

  it('el canario se busca en las tres columnas y prueba con el AAD de su columna', async () => {
    const valor = encryptPiiText(PLANO_VIEJO, { table: TABLA, column: 'foto_cedula_reverso', id: 4 });
    m.filas.push(fila(4, { fotoCedulaReverso: valor }), fila(5, { fotoRostro: DATA_URI }));

    const r = await run({ commit: true });

    expect(r.canario).toBe('ok');
    expect(r.canarioFuente).toBe(TABLA);
    expect(m.escrituras).toEqual([{ id: 5, prop: 'fotoRostro' }]);
  });

  it('un valor nuevo copiado a otra fila no sirve de canario: su AAD no cuadra', async () => {
    m.filas.push(fila(1, { fotoRostro: cifrarNuevo(99), fotoCedulaFrontal: DATA_URI }));

    const r = await run({ commit: true });

    expect(r.canario).toBe('fallo');
    expect(m.escrituras).toEqual([]);
  });

  it('prueba como mucho 5 canarios y con uno bueno basta', async () => {
    for (let id = 1; id <= 4; id++) m.filas.push(fila(id, { fotoRostro: cifrarNuevo(99) }));
    m.filas.push(fila(5, { fotoRostro: cifrarNuevo(5) }), fila(6, { fotoRostro: cifrarNuevo(6, DATA_URI) }));

    expect((await run({ commit: false })).canario).toBe('ok');

    m.filas.length = 0;
    for (let id = 1; id <= 5; id++) m.filas.push(fila(id, { fotoRostro: cifrarNuevo(99) }));
    m.filas.push(fila(6, { fotoRostro: cifrarNuevo(6) }));

    expect((await run({ commit: false })).canario).toBe('fallo');
  });

  it('un viejo corrupto junto a un nuevo bueno: ok, sigue y cuenta el corrupto', async () => {
    const corrupto = cifrarViejo(PLANO_VIEJO, LLAVE_OTRA);
    m.filas.push(
      fila(1, { fotoRostro: corrupto }),
      fila(2, { fotoRostro: cifrarNuevo(2) }),
      fila(3, { fotoRostro: DATA_URI }),
    );

    const r = await run({ commit: true });

    expect(r.canario).toBe('ok');
    expect(r.columnas.foto_rostro.viejo_indescifrable).toBe(1);
    expect(r.columnas.foto_rostro.escrito).toBe(1);
    expect(r.idsFallidos).toEqual([1]);
    expect(m.filas[0].fotoRostro).toBe(corrupto);
    expect(codigoSalida(r)).toBe(2);
  });

  it('sin canario en la tabla, driver_profile con llave buena: escribe', async () => {
    m.filas.push(fila(1, { fotoRostro: DATA_URI }));
    m.conductores.push(conductor(7));

    const r = await run({ commit: true });

    expect(r.canario).toBe('ok');
    expect(r.canarioFuente).toBe('driver_profile.cedula');
    expect(r.columnas.foto_rostro.escrito).toBe(1);
    expect(codigoSalida(r)).toBe(0);
  });

  it('sin canario en la tabla, driver_profile con llave errónea: 0 escrituras', async () => {
    m.filas.push(fila(1, { fotoRostro: DATA_URI }));
    m.conductores.push(conductor(7));
    env.PII_ENC_KEY = LLAVE_OTRA;

    const r = await run({ commit: true });

    expect(r.canario).toBe('fallo');
    expect(r.canarioFuente).toBe('driver_profile.cedula');
    expect(m.escrituras).toEqual([]);
    expect(m.filas[0].fotoRostro).toBe(DATA_URI);
    expect(codigoSalida(r)).toBe(1);
  });

  it('la tabla manda: con candidatos que fallan, un conductor bueno no la rescata', async () => {
    m.filas.push(fila(1, { fotoRostro: cifrarViejo(PLANO_VIEJO, LLAVE_OTRA), fotoCedulaFrontal: DATA_URI }));
    m.conductores.push(conductor(7));

    const r = await run({ commit: true });

    expect(r.canario).toBe('fallo');
    expect(m.escrituras).toEqual([]);
  });

  it.each([[true], [false]])('sin ningún canario y con filas en claro (commit=%s): 0 escrituras y código 1', async (commit) => {
    m.filas.push(fila(1, { fotoRostro: CLAVE }), fila(2, { fotoCedulaReverso: BASE64 }));
    const antes = instantanea();

    const r = await run({ commit });

    expect(r.canario).toBe('sin_canario');
    expect(r.abortado).toBe(true);
    expect(m.escrituras).toEqual([]);
    expect(instantanea()).toBe(antes);
    expect(codigoSalida(r)).toBe(1);
  });

  it('sin ningún canario y sin nada que escribir: termina normal con código 0', async () => {
    m.filas.push(fila(1, { fotoRostro: CLAVE, fotoCedulaFrontal: DESCONOCIDO }));

    const r = await run({ commit: true });

    expect(r.canario).toBe('sin_canario');
    expect(r.abortado).toBe(false);
    expect(r.filas).toBe(1);
    expect(m.escrituras).toEqual([]);
    expect(codigoSalida(r)).toBe(0);
  });

  it('una foto en claro que llega en plena corrida sin canario no se escribe y queda pendiente', async () => {
    m.antesDeLeerLote = (n) => { if (n === 2) m.filas.push(fila(1, { fotoRostro: DATA_URI })); };

    const r = await run({ commit: true });

    expect(r.canario).toBe('sin_canario');
    expect(m.escrituras).toEqual([]);
    expect(m.filas[0].fotoRostro).toBe(DATA_URI);
    expect(r.pendientes).toBe(1);
    expect(codigoSalida(r)).toBe(2);
  });

  it('ninguna salida contiene los valores', async () => {
    const nuevo = cifrarNuevo(1);
    const viejo = cifrarViejo(PLANO_VIEJO);
    m.filas.push(fila(1, { fotoRostro: nuevo, fotoCedulaFrontal: viejo, fotoCedulaReverso: DATA_URI }), fila(2, { fotoRostro: BASE64 }));
    const c = conductor(7);
    m.conductores.push(c);
    const secretos = [nuevo, viejo, 'RkFDRV9WSUVKTw', DATA_URI, 'RkFDRV9VUkk', 'RkFDRUJBU0U2NA', CEDULA, c.aadNonce, c.cipher.toString('base64')];

    const salidas = [JSON.stringify(await run({ commit: false }))];
    env.PII_ENC_KEY = LLAVE_OTRA;
    salidas.push(JSON.stringify(await run({ commit: true })));
    m.filas.length = 0;
    m.filas.push(fila(1, { fotoRostro: DATA_URI }));
    salidas.push(JSON.stringify(await run({ commit: false })));

    for (const salida of salidas) {
      for (const secreto of secretos) expect(salida).not.toContain(secreto);
    }
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
