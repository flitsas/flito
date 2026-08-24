// HU #11281 — el camino de fallo de LA BASE al guardar un catálogo (hallazgo Medium de auditoría).
//
// Lo que cubre este archivo no es «que la sincronización funcione» —eso está en
// `siigo-catalogos.test.ts`— sino el camino que hasta ahora no tenía ninguna prueba: qué pasa
// cuando Postgres rechaza la escritura.
//
// Por qué importa tanto. Desde `drizzle-orm` 0.45, `pg-core/session.js` envuelve TODO error del
// driver en un `DrizzleQueryError` cuyo `message` se construye literalmente como
// `Failed query: <SQL>\nparams: <valores enlazados>`. Ese error salía crudo de `persistirCatalogo`,
// caía en la rama genérica del traductor y terminaba en DOS sitios: la respuesta HTTP y la bitácora
// `siigo_operaciones`, que es WORM real —`0126_siigo_operaciones_worm.sql` prohíbe UPDATE y DELETE
// por disparador—. Lo que entra ahí no se puede rectificar ni suprimir después (Ley 1581, art. 8), y
// entre los parámetros de ese INSERT están los NOMBRES de los vendedores y el esquema interno.
//
// No hace falta un atacante: basta un nombre de vendedor más largo que `varchar(200)`, un
// `statement timeout` o una conexión caída en mitad de un lote de hasta 500 filas.
//
// El error se simula con la MISMA forma que produce drizzle 0.45.2, no con un `Error` cualquiera:
// si alguien revierte el `catch` tipado de `persistirCatalogo`, el volcado vuelve a aparecer en la
// respuesta y en la bitácora, y estos tests fallan. No se importa `DrizzleQueryError` de
// `drizzle-orm/errors.js` a propósito: esa clase NO existe en 0.35.3, que es lo que declara
// `apps/api/package.json`, y el test tiene que seguir siendo válido con las dos versiones —que es
// justo lo que hace peligrosa a esta regresión: se activa sola al actualizar la dependencia.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const envMock = {
  SIIGO_BASE_URL: 'https://api.siigo.test',
  SIIGO_PARTNER_ID: 'FlitoIntegracion',
  SIIGO_AMBIENTE: 'pruebas' as const,
  SIIGO_MODE: 'real' as 'mock' | 'real',
  SIIGO_ENC_KEY: 'b71d3f9a20c845e6f8319ad4c7be5026a19d3f84c60be27159ad83f4c2e70b91',
  NODE_ENV: 'development',
  PII_ENC_KEY: 'test-pii',
};
vi.mock('../../src/config/env.js', () => ({ env: envMock }));

const obtenerTokenMock = vi.fn();
vi.mock('../../src/modules/siigo/siigo.token.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/siigo/siigo.token.js')>();
  return { ...actual, obtenerToken: obtenerTokenMock };
});

const registrarOperacionMock = vi.fn();
vi.mock('../../src/modules/siigo/siigo.operaciones.repo.js', () => ({
  registrarOperacion: registrarOperacionMock,
}));

vi.mock('../../src/services/circuitBreaker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/circuitBreaker.js')>();
  return { ...actual, withCircuitBreaker: <T>(_n: string, fn: () => Promise<T>) => fn() };
});

const transactionMock = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  db: {
    select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(),
    transaction: transactionMock, execute: vi.fn(),
  },
  getPoolStats: vi.fn(),
}));

const { sincronizarCatalogos } =
  await import('../../src/modules/siigo/siigo.catalogos.service.js');
const { reiniciarLimitador } = await import('../../src/modules/siigo/siigo.resiliencia.js');

// ── El error, tal como lo construye drizzle 0.45.2 ──────────────────────────

/**
 * Réplica de `DrizzleQueryError` (`drizzle-orm/errors.js`, 0.45.2):
 *
 * ```js
 * super(`Failed query: ${query}\nparams: ${params}`);
 * ```
 *
 * Un array interpolado se une por comas, así que el `message` acaba conteniendo la sentencia y
 * TODOS los valores enlazados. `cause` es el error del driver, que es lo único que sirve para
 * depurar y lo único que puede ir al log.
 */
class DrizzleQueryErrorSimulado extends Error {
  readonly query: string;
  readonly params: unknown[];

  constructor(query: string, params: unknown[], cause?: Error) {
    super(`Failed query: ${query}\nparams: ${params}`);
    this.name = 'Error'; // drizzle no le pone `name`: se queda en 'Error'.
    this.query = query;
    this.params = params;
    if (cause) this.cause = cause;
  }
}

/** La sentencia real del upsert de vendedores, con los nombres de las personas como parámetros. */
const SQL_UPSERT = 'insert into "siigo_catalogos" ("ambiente", "tipo", "codigo", "nombre", '
  + '"descripcion", "activo", "atributos", "sincronizado_en", "inactivado_en", "updated_at") '
  + 'values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) '
  + 'on conflict ("ambiente","tipo","codigo") do update set "nombre" = excluded.nombre';

const PARAMS_UPSERT = ['pruebas', 'user', '35071', 'Ana Ramírez', null, true, null];

function falloDePostgres(motivo = 'value too long for type character varying(200)'): Error {
  return new DrizzleQueryErrorSimulado(SQL_UPSERT, PARAMS_UPSERT, new Error(motivo));
}

/** Todo lo que NO puede salir del proceso: esquema interno, sentencia y datos de personas. */
const FUGAS = [
  /Failed query/i,
  /insert into/i,
  /on conflict/i,
  /siigo_catalogos/,
  /sincronizado_en/,
  /Ana Ramírez/,
  /\$1/,
  /params:/i,
];

function noFiltraNada(texto: string): void {
  for (const patron of FUGAS) {
    expect(texto, `filtró ${patron}`).not.toMatch(patron);
  }
}

// ── Respuestas de Siigo ─────────────────────────────────────────────────────

const CATALOGOS_REALES: Record<string, unknown[]> = {
  '/v1/document-types?type=FV': [{ id: 24446, name: 'Factura de venta', type: 'FV', active: true }],
  '/v1/users': [
    { id: 35071, first_name: 'Ana', last_name: 'Ramírez', active: true },
  ],
  '/v1/payment-types?document_type=FV': [{ id: 5636, name: 'Contado', active: true }],
  '/v1/taxes': [{ id: 13156, name: 'IVA 19%', type: 'IVA', percentage: 19, active: true }],
  '/v1/account-groups': [{ id: 1253, name: 'Servicios', active: true }],
  '/v1/cost-centers': [{ id: 25732, code: '13-1', name: 'Principal', active: true }],
};

const fetchMock = vi.fn();

function respuestaHttp(status: number, datos: unknown) {
  return { status, ok: status >= 200 && status < 300, json: async () => datos };
}

function rutaDe(url: string): string {
  return url.replace(envMock.SIIGO_BASE_URL, '');
}

// ── Transacción falsa ───────────────────────────────────────────────────────

let upserts: Record<string, unknown>[][] = [];
/** Si devuelve un error para el lote, la escritura falla como lo haría Postgres. */
let fallarEscritura: (lote: Record<string, unknown>[]) => Error | null = () => null;

function txFalso() {
  return {
    insert: () => ({
      values: (v: Record<string, unknown>[]) => {
        const err = fallarEscritura(v);
        if (err) throw err;
        upserts.push(v);
        return { onConflictDoUpdate: () => Promise.resolve([]) };
      },
    }),
    update: () => ({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    }),
    delete: () => { throw new Error('siigo_catalogos no admite DELETE'); },
  };
}

/** Filas escritas de un catálogo. */
function filasDe(tipo: string): Record<string, unknown>[] {
  return upserts.flat().filter((v) => v.tipo === tipo);
}

let errSpy = vi.spyOn(console, 'error');

beforeEach(() => {
  fetchMock.mockReset();
  obtenerTokenMock.mockReset();
  registrarOperacionMock.mockReset();
  transactionMock.mockReset();
  reiniciarLimitador();

  upserts = [];
  fallarEscritura = () => null;
  envMock.SIIGO_MODE = 'real';

  obtenerTokenMock.mockResolvedValue('Bearer token-simulado');
  registrarOperacionMock.mockResolvedValue(undefined);
  transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(txFalso()));

  fetchMock.mockImplementation(async (url: string) =>
    respuestaHttp(200, CATALOGOS_REALES[rutaDe(url)] ?? []));
  vi.stubGlobal('fetch', fetchMock);

  // El servicio SÍ registra el detalle técnico en el log del servidor; se silencia y se inspecciona.
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => { errSpy.mockRestore(); });

// ───────────────────────────────────────────────────────────────────────────
describe('un fallo de la base al guardar no filtra la consulta ni sus parámetros', () => {
  beforeEach(() => { fallarEscritura = () => falloDePostgres(); });

  it('la respuesta trae un error de dominio con mensaje fijo, sin nada del motor', async () => {
    const r = await sincronizarCatalogos({ ambiente: 'pruebas', tipos: ['user'] });

    const vendedores = r.catalogos[0]!;
    expect(vendedores.ok).toBe(false);
    expect(vendedores.error?.codigo).toBe('error_persistencia');
    expect(vendedores.error?.mensaje).toMatch(/No se pudo guardar el catálogo en la copia local\./);
    noFiltraNada(vendedores.error!.mensaje);
  });

  it('el resultado COMPLETO que viaja por HTTP está limpio', async () => {
    const r = await sincronizarCatalogos({ ambiente: 'pruebas', tipos: ['user'] });

    // No basta con mirar `error.mensaje`: lo que se serializa hacia el cliente es todo el objeto.
    noFiltraNada(JSON.stringify(r));
  });

  it('lo que se escribe en la bitácora WORM tampoco lleva la sentencia', async () => {
    await sincronizarCatalogos({ ambiente: 'pruebas', tipos: ['user'] });

    expect(registrarOperacionMock).toHaveBeenCalledTimes(1);
    const registro = registrarOperacionMock.mock.calls[0]![0];
    expect(registro).toMatchObject({
      operacion: 'sync_catalogo', entidadId: 'user', resultado: 'error_tecnico',
      codigo: 'error_persistencia',
    });
    // La fila es INMUTABLE por disparador: si esto entrara, no habría forma de suprimirlo después.
    noFiltraNada(JSON.stringify(registro));
  });

  it('el detalle técnico queda en el log del servidor, y también sin la sentencia', async () => {
    await sincronizarCatalogos({ ambiente: 'pruebas', tipos: ['user'] });

    const anotado = errSpy.mock.calls.map((c) => JSON.stringify(c)).join(' ');
    // Lo que hace falta para depurar sí está: la causa del driver.
    expect(anotado).toMatch(/value too long for type character varying\(200\)/);
    expect(anotado).toMatch(/no se pudo guardar el catálogo/i);
    // El volcado, no. El log también se conserva y también está sujeto a la Ley 1581.
    noFiltraNada(anotado);
  });

  it('un error del motor SIN volcado tampoco se copia al mensaje', async () => {
    // Una caída de conexión trae un mensaje corto y aparentemente inocuo. Da igual: el mensaje que
    // sale es fijo. Si alguien vuelve a incrustar `e.message`, este test lo delata aunque pruebe
    // con un error que no lleve SQL dentro.
    fallarEscritura = () => new Error('Connection terminated unexpectedly (db-prod-01:5432)');

    const r = await sincronizarCatalogos({ ambiente: 'pruebas', tipos: ['user'] });

    expect(r.catalogos[0]!.error?.codigo).toBe('error_persistencia');
    expect(r.catalogos[0]!.error?.mensaje).not.toMatch(/Connection terminated/);
    expect(r.catalogos[0]!.error?.mensaje).not.toMatch(/db-prod-01/);
  });

  it('un timeout de sentencia se reporta igual: mismo código, mismo mensaje', async () => {
    fallarEscritura = () => falloDePostgres('canceling statement due to statement timeout');

    const r = await sincronizarCatalogos({ ambiente: 'pruebas', tipos: ['user'] });

    expect(r.catalogos[0]!.error?.codigo).toBe('error_persistencia');
    noFiltraNada(JSON.stringify(r));
  });

  it('el catálogo que no pudo escribirse no arrastra a los otros cinco', async () => {
    fallarEscritura = (lote) => (lote[0]?.tipo === 'user' ? falloDePostgres() : null);

    const r = await sincronizarCatalogos({ ambiente: 'pruebas' });

    expect(r.ok).toBe(false);
    expect(r.parcial).toBe(true);
    expect(r.catalogos.filter((c) => c.ok)).toHaveLength(5);
    expect(r.catalogos.find((c) => c.tipo === 'user')!.error?.codigo).toBe('error_persistencia');
    // Y los cinco sanos sí escribieron.
    expect(filasDe('tax')).toHaveLength(1);
    expect(filasDe('user')).toHaveLength(0);
    noFiltraNada(JSON.stringify(r));
  });

  it('no se marca como vaciado masivo: no llegó a saberse qué quedó en la tabla', async () => {
    const r = await sincronizarCatalogos({ ambiente: 'pruebas', tipos: ['user'] });

    expect(r.catalogos[0]!.vaciadoMasivo).toBe(false);
    expect(r.vaciadoMasivo).toBe(false);
    expect(r.catalogos[0]!.total).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// La otra mitad del hallazgo: el fallo más probable era un texto de Siigo más largo que su columna.
// Recortar antes de escribir hace que ese error no llegue a existir.
describe('los textos se ajustan a lo que admite la copia local', () => {
  // Longitudes de `siigo_catalogos` en `db/schema.ts`: nombre 200, descripcion 300, codigo 60.
  const MAX_NOMBRE = 200;
  const MAX_DESCRIPCION = 300;
  const MAX_CODIGO = 60;

  /** La escritura falla como Postgres si algún valor no cabe: el test no puede darlo por bueno. */
  beforeEach(() => {
    fallarEscritura = (lote) => {
      for (const fila of lote) {
        const nombre = String(fila.nombre ?? '');
        const codigo = String(fila.codigo ?? '');
        const descripcion = fila.descripcion === null ? '' : String(fila.descripcion);
        if (Array.from(nombre).length > MAX_NOMBRE) {
          return falloDePostgres(`value too long for type character varying(${MAX_NOMBRE})`);
        }
        if (Array.from(codigo).length > MAX_CODIGO) {
          return falloDePostgres(`value too long for type character varying(${MAX_CODIGO})`);
        }
        if (Array.from(descripcion).length > MAX_DESCRIPCION) {
          return falloDePostgres(`value too long for type character varying(${MAX_DESCRIPCION})`);
        }
      }
      return null;
    };
  });

  it('un nombre de vendedor de más de 200 caracteres no revienta la sincronización', async () => {
    const apellidoLargo = 'Ramírez'.padEnd(400, 'z');
    fetchMock.mockImplementation(async (url: string) => (
      rutaDe(url) === '/v1/users'
        ? respuestaHttp(200, [{ id: 35071, first_name: 'Ana', last_name: apellidoLargo, active: true }])
        : respuestaHttp(200, CATALOGOS_REALES[rutaDe(url)] ?? [])
    ));

    const r = await sincronizarCatalogos({ ambiente: 'pruebas', tipos: ['user'] });

    // Antes: `value too long for type character varying(200)` y el catálogo entero perdido.
    expect(r.catalogos[0]!.ok).toBe(true);
    expect(r.catalogos[0]!.total).toBe(1);
    const fila = filasDe('user')[0]!;
    expect(Array.from(String(fila.nombre)).length).toBe(MAX_NOMBRE);
    expect(String(fila.nombre).startsWith('Ana Ramírez')).toBe(true);
    // El elemento sigue siendo el mismo: el identificador NO se toca.
    expect(fila.codigo).toBe('35071');
  });

  it('el recorte cuenta caracteres, no unidades UTF-16: no parte una letra por la mitad', async () => {
    // Un nombre de emojis es el caso extremo, pero la propiedad es la misma para «ñ» o «í»:
    // `varchar(n)` de Postgres cuenta caracteres y `String.length` cuenta unidades UTF-16.
    const nombreEmoji = '😀'.repeat(300);
    fetchMock.mockImplementation(async (url: string) => (
      rutaDe(url) === '/v1/users'
        ? respuestaHttp(200, [{ id: 35071, first_name: nombreEmoji, active: true }])
        : respuestaHttp(200, CATALOGOS_REALES[rutaDe(url)] ?? [])
    ));

    const r = await sincronizarCatalogos({ ambiente: 'pruebas', tipos: ['user'] });

    expect(r.catalogos[0]!.ok).toBe(true);
    const nombre = String(filasDe('user')[0]!.nombre);
    expect(Array.from(nombre).length).toBe(MAX_NOMBRE);
    // Ningún par suplente partido: media letra en la base sería un error distinto y peor.
    expect(nombre).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('una descripción de más de 300 caracteres se recorta a 300', async () => {
    const codigoContableLargo = '13-'.padEnd(500, '9');
    fetchMock.mockImplementation(async (url: string) => (
      rutaDe(url) === '/v1/cost-centers'
        ? respuestaHttp(200, [{ id: 25732, code: codigoContableLargo, name: 'Principal', active: true }])
        : respuestaHttp(200, CATALOGOS_REALES[rutaDe(url)] ?? [])
    ));

    const r = await sincronizarCatalogos({ ambiente: 'pruebas', tipos: ['cost_center'] });

    expect(r.catalogos[0]!.ok).toBe(true);
    expect(Array.from(String(filasDe('cost_center')[0]!.descripcion)).length).toBe(MAX_DESCRIPCION);
  });

  it('un CÓDIGO demasiado largo se descarta: recortarlo sería otro elemento', async () => {
    const codigoLargo = '9'.repeat(120);
    fetchMock.mockImplementation(async (url: string) => (
      rutaDe(url) === '/v1/taxes'
        ? respuestaHttp(200, [
          { id: codigoLargo, name: 'Impuesto con código imposible', active: true },
          { id: 13156, name: 'IVA 19%', active: true },
        ])
        : respuestaHttp(200, CATALOGOS_REALES[rutaDe(url)] ?? [])
    ));

    const r = await sincronizarCatalogos({ ambiente: 'pruebas', tipos: ['tax'] });

    expect(r.catalogos[0]!.ok).toBe(true);
    // Recortado a 60 sería el identificador de OTRO impuesto: la parametrización acabaría
    // apuntando a algo que en Siigo no existe.
    expect(filasDe('tax').map((f) => f.codigo)).toEqual(['13156']);
    expect(r.catalogos[0]!.total).toBe(1);
    expect(r.catalogos[0]!.descartados).toBe(1);
  });

  it('el descarte se dice en el resultado y en la bitácora, no en silencio', async () => {
    fetchMock.mockImplementation(async (url: string) => (
      rutaDe(url) === '/v1/taxes'
        ? respuestaHttp(200, [
          { id: '9'.repeat(120), name: 'Código imposible', active: true },
          { name: 'Sin identificador', active: true },
          { id: 13156, name: 'IVA 19%', active: true },
        ])
        : respuestaHttp(200, CATALOGOS_REALES[rutaDe(url)] ?? [])
    ));

    const r = await sincronizarCatalogos({ ambiente: 'pruebas', tipos: ['tax'] });

    expect(r.catalogos[0]!.descartados).toBe(2);
    const registro = registrarOperacionMock.mock.calls[0]![0];
    expect(registro.mensaje).toMatch(/descartaron/);
    expect(registro.responseBody).toMatchObject({ total: 1, descartados: 2 });
  });

  it('una sincronización sin descartes reporta cero y no habla de descartes', async () => {
    const r = await sincronizarCatalogos({ ambiente: 'pruebas', tipos: ['tax'] });

    expect(r.catalogos[0]!.descartados).toBe(0);
    expect(registrarOperacionMock.mock.calls[0]![0].mensaje).not.toMatch(/descart/i);
  });
});
