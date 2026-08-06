// HU #11281 — el SQL REAL de la copia local de catálogos. [keyed]
//
// El resto de la suite afirma contra un `tx` escrito a mano: `values()` y `set()` guardan el objeto
// que reciben y `onConflictDoUpdate()` lo descarta. Eso deja sin ejercer justo el corazón de AC4 —el
// upsert, el `COALESCE` que conserva la primera fecha de inactivación, la guarda del `notInArray`
// con lista vacía y el filtro por ambiente—, que son expresiones SQL, no propiedades de un objeto.
//
// Aquí `db` es un drizzle DE VERDAD sobre el driver `pg-proxy`: compila cada consulta con el mismo
// dialecto de Postgres que producción y entrega `(sql, params)` en lugar de abrir un socket. Lo que
// se afirma es el texto de la sentencia y sus valores enlazados, no un espejo de lo que el test
// acaba de escribir.
//
// Por qué no `helpers/espia-drizzle.ts`: ese espía envuelve el mock `keyed-db`, cuyos `values`,
// `set` y `onConflictDoUpdate` siguen siendo passthrough. Registra el payload —que ya está cubierto
// en `siigo-catalogos.test.ts`— pero no puede ver una cláusula que nunca se compila. Se reutiliza su
// idea (capturar los valores enlazados del `where`) sobre un compilador real.
//
// Lo que NO se puede cubrir sin un Postgres vivo: que el índice único RECHACE un duplicado. En su
// lugar se comprueba lo que sí es verificable y es donde estaría el error humano — que las columnas
// del `ON CONFLICT` sean exactamente las del índice único declarado en la migración y en
// `schema.ts`. Si dejan de coincidir, Postgres rechaza la sentencia entera («no unique or exclusion
// constraint matching the ON CONFLICT specification») y la sincronización cae por completo.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/pg-proxy';

const envMock = {
  SIIGO_BASE_URL: 'https://api.siigo.test',
  SIIGO_PARTNER_ID: 'FlitoIntegracion',
  SIIGO_AMBIENTE: 'pruebas' as const,
  SIIGO_MODE: 'real' as 'mock' | 'real',
  SIIGO_MOCK_ERROR_RATE: 0,
  SIIGO_MOCK_TIMEOUT_RATE: 0,
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

vi.mock('../../src/modules/siigo/siigo.operaciones.repo.js', () => ({
  registrarOperacion: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/services/circuitBreaker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/circuitBreaker.js')>();
  return { ...actual, withCircuitBreaker: <T>(_n: string, fn: () => Promise<T>) => fn() };
});

// ── El drizzle real, sin base ───────────────────────────────────────────────

interface Sentencia { sql: string; params: unknown[] }

const sentencias: Sentencia[] = [];
/**
 * Filas que devuelve la siguiente consulta que las pida, en formato POSICIONAL: pg-proxy entrega
 * al mapeador de drizzle un arreglo de valores por fila, en el orden de las columnas seleccionadas.
 */
let filasEncoladas: unknown[][] = [];

const proxy = drizzle(async (sql: string, params: unknown[]) => {
  sentencias.push({ sql, params });
  const filas = filasEncoladas;
  filasEncoladas = [];
  return { rows: filas };
});

// pg-proxy no implementa transacciones (abrir el BEGIN sería trabajo del otro lado del proxy). Se
// ejecuta el cuerpo contra el mismo `db`: lo que se examina son las sentencias interiores, que se
// compilan igual dentro y fuera de la transacción.
const dbFalsa: Record<string, unknown> = {
  select: proxy.select.bind(proxy),
  insert: proxy.insert.bind(proxy),
  update: proxy.update.bind(proxy),
  delete: proxy.delete.bind(proxy),
  execute: proxy.execute.bind(proxy),
  transaction: async (cb: (tx: unknown) => unknown) => cb(dbFalsa),
};

vi.mock('../../src/db/client.js', () => ({ db: dbFalsa, getPoolStats: vi.fn() }));

const { sincronizarCatalogos, leerCatalogo, resumenCatalogos } =
  await import('../../src/modules/siigo/siigo.catalogos.service.js');

// ── Utilidades ──────────────────────────────────────────────────────────────

const fetchMock = vi.fn();

function respuestaHttp(status: number, datos: unknown) {
  return { status, ok: status >= 200 && status < 300, json: async () => datos };
}

/** Impuestos devueltos por Siigo en cada test. Un solo catálogo mantiene el SQL legible. */
let impuestos: unknown[] = [];

function sentenciasQueEmpiezanCon(prefijo: string): Sentencia[] {
  return sentencias.filter((s) => s.sql.trim().toLowerCase().startsWith(prefijo));
}

function unicaSentencia(prefijo: string): Sentencia {
  const encontradas = sentenciasQueEmpiezanCon(prefijo);
  expect(encontradas, `se esperaba una sola sentencia "${prefijo}"`).toHaveLength(1);
  return encontradas[0]!;
}

/** Columnas del `on conflict (...)` tal como Postgres las va a leer. */
function columnasDelConflicto(sql: string): string[] {
  const m = /on conflict \(([^)]*)\)/i.exec(sql);
  if (!m) return [];
  return m[1]!.split(',').map((c) => c.trim().replace(/"/g, ''));
}

const RUTA_MIGRACION = fileURLToPath(
  new URL('../../src/db/migrations/0127_siigo_catalogos.sql', import.meta.url),
);

async function sincronizarImpuestos(ambiente: 'pruebas' | 'produccion' = 'pruebas'): Promise<void> {
  await sincronizarCatalogos({ ambiente, tipos: ['tax'], dormir: async () => undefined });
}

beforeEach(() => {
  sentencias.length = 0;
  filasEncoladas = [];
  fetchMock.mockReset();
  obtenerTokenMock.mockReset();
  obtenerTokenMock.mockResolvedValue('Bearer token-simulado');
  envMock.SIIGO_MODE = 'real';

  impuestos = [{ id: 13156, name: 'IVA 19%', type: 'IVA', percentage: 19, active: true }];
  fetchMock.mockImplementation(async () => respuestaHttp(200, impuestos));
  vi.stubGlobal('fetch', fetchMock);
});

// ───────────────────────────────────────────────────────────────────────────
describe('AC4 — el upsert compilado [keyed]', () => {
  it('el ON CONFLICT apunta a las tres columnas del índice único', async () => {
    await sincronizarImpuestos();

    const insert = unicaSentencia('insert');
    expect(columnasDelConflicto(insert.sql)).toEqual(['ambiente', 'tipo', 'codigo']);
  });

  it('esas columnas son EXACTAMENTE las del índice único de la migración', () => {
    const migracion = readFileSync(RUTA_MIGRACION, 'utf8');

    const m = /create unique index[^(]*on siigo_catalogos \(([^)]*)\)/i.exec(migracion);
    expect(m, 'la migración debe declarar el índice único').not.toBeNull();
    const columnas = m![1]!.split(',').map((c) => c.trim());

    // Si estas dos listas divergen, Postgres rechaza el upsert entero con «no unique or exclusion
    // constraint matching the ON CONFLICT specification» y la sincronización deja de funcionar.
    expect(columnas).toEqual(['ambiente', 'tipo', 'codigo']);
    // Y es el índice el que impide que un duplicado llegue a crear dos filas del mismo elemento.
    expect(migracion).toMatch(/CREATE UNIQUE INDEX/i);
  });

  it('la migración declara una sola fila por ambiente, tipo y código', () => {
    const migracion = readFileSync(RUTA_MIGRACION, 'utf8');

    // La llave anterior —(tipo, codigo)— haría que el id 13156 de la empresa de pruebas y el de la
    // de producción fueran la misma fila.
    expect(migracion).not.toMatch(/on siigo_catalogos \(tipo, codigo\)/i);
    expect(migracion).toMatch(/ambiente\s+varchar\(12\)\s+NOT NULL/i);
    expect(migracion).toMatch(/CHECK \(ambiente IN \('pruebas', 'produccion'\)\)/i);
  });

  it('conserva la PRIMERA fecha de inactivación al re-sincronizar un elemento ya inactivo', async () => {
    impuestos = [{ id: 13156, name: 'IVA 19%', type: 'IVA', percentage: 19, active: false }];

    await sincronizarImpuestos();

    const { sql } = unicaSentencia('insert');
    const normalizado = sql.replace(/\s+/g, ' ').toLowerCase();
    // COALESCE(fecha_que_ya_estaba, la_de_ahora): si el elemento ya venía inactivo desde marzo, la
    // sincronización de agosto NO puede mover esa fecha a agosto — lo que se quiere saber es desde
    // cuándo dejó de estar disponible, no cuándo se volvió a confirmar.
    expect(normalizado).toContain(
      'coalesce("siigo_catalogos"."inactivado_en", excluded.sincronizado_en)',
    );
  });

  it('reactivar un elemento que vuelve a venir deja `inactivado_en` en NULL', async () => {
    await sincronizarImpuestos();

    const { sql } = unicaSentencia('insert');
    const normalizado = sql.replace(/\s+/g, ' ').toLowerCase();
    // La rama que borra la marca: sin ella, un elemento reactivado seguiría arrastrando la fecha en
    // que se dio de baja y la pantalla lo mostraría como «inactivo desde…» estando disponible.
    expect(normalizado).toContain('case when excluded.activo then null');
    expect(normalizado).toContain('"inactivado_en" = case when excluded.activo then null');
  });

  it('el INSERT enlaza el ambiente como valor, no lo interpola en el texto', async () => {
    await sincronizarImpuestos('produccion');

    const insert = unicaSentencia('insert');
    expect(insert.params).toContain('produccion');
    expect(insert.params).toContain('13156');
    // Concatenar valores en el SQL es la vía de la inyección; drizzle los enlaza y así debe quedar.
    expect(insert.sql).not.toContain('produccion');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('AC4 — la inactivación de «lo que no vino» [keyed]', () => {
  it('acota la baja al ambiente, al tipo y a las filas hoy activas', async () => {
    await sincronizarImpuestos('produccion');

    const update = unicaSentencia('update');
    const normalizado = update.sql.replace(/\s+/g, ' ').toLowerCase();
    expect(normalizado).toContain('"ambiente" = $');
    expect(normalizado).toContain('"tipo" = $');
    expect(normalizado).toContain('"activo" = $');
    // El ambiente es lo que impide que sincronizar producción inactive el catálogo de pruebas.
    expect(update.params).toContain('produccion');
    expect(update.params).toContain('tax');
  });

  it('excluye por código lo que sí vino, en vez de inactivarlo y volverlo a activar', async () => {
    impuestos = [
      { id: 13156, name: 'IVA 19%', active: true },
      { id: 13157, name: 'IVA 5%', active: true },
    ];

    await sincronizarImpuestos();

    const update = unicaSentencia('update');
    expect(update.sql.toLowerCase()).toContain('not in');
    expect(update.params).toContain('13156');
    expect(update.params).toContain('13157');
  });

  it('con la respuesta vacía NO emite `not in ()`: sería SQL inválido', async () => {
    impuestos = [];
    filasEncoladas = [];

    await sincronizarImpuestos();

    const update = unicaSentencia('update');
    // La guarda del `notInArray` con lista vacía. Sin ella, el caso más delicado de todos —Siigo
    // devuelve el catálogo vacío— muere con un error de sintaxis en vez de inactivar.
    expect(update.sql.toLowerCase()).not.toContain('not in');
    // Pero la condición sigue acotada: «todas las activas de este tipo en este ambiente».
    expect(update.params).toContain('pruebas');
    expect(update.params).toContain('tax');
    // Y sin elementos no hay INSERT que emitir.
    expect(sentenciasQueEmpiezanCon('insert')).toHaveLength(0);
  });

  it('la inactivación también conserva la primera fecha', async () => {
    await sincronizarImpuestos();

    const { sql } = unicaSentencia('update');
    const normalizado = sql.replace(/\s+/g, ' ').toLowerCase();
    expect(normalizado).toContain('coalesce("siigo_catalogos"."inactivado_en"');
  });

  it('nunca se emite un DELETE sobre la tabla (AC4)', async () => {
    await sincronizarImpuestos();

    expect(sentenciasQueEmpiezanCon('delete')).toHaveLength(0);
    expect(sentencias.some((s) => /delete/i.test(s.sql))).toBe(false);
  });

  it('el conteo de inactivados sale del RETURNING, no de una estimación', async () => {
    impuestos = [];
    // Dos filas devueltas por el `returning({ id })`: formato posicional, una columna por fila.
    filasEncoladas = [[10], [11]];

    const r = await sincronizarCatalogos({
      ambiente: 'pruebas', tipos: ['tax'], dormir: async () => undefined,
    });

    expect(unicaSentencia('update').sql.toLowerCase()).toContain('returning');
    expect(r.catalogos[0]!.inactivados).toBe(2);
    // Y con eso, el vaciado masivo queda señalado (BUG-C).
    expect(r.catalogos[0]!.vaciadoMasivo).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('AC3 — las lecturas compiladas [keyed]', () => {
  it('leerCatalogo filtra por ambiente y tipo, y ordena por nombre en la base', async () => {
    filasEncoladas = [];

    await leerCatalogo('cost_center', { ambiente: 'produccion' });

    const select = unicaSentencia('select');
    const normalizado = select.sql.replace(/\s+/g, ' ').toLowerCase();
    expect(normalizado).toContain('from "siigo_catalogos"');
    expect(normalizado).toContain('"ambiente" = $');
    expect(normalizado).toContain('"tipo" = $');
    // El orden lo pone Postgres, no el servicio: con el índice (ambiente, tipo, activo, nombre) es
    // gratis, y ordenar en memoria daría un orden distinto según la configuración regional.
    expect(normalizado).toContain('order by "siigo_catalogos"."nombre" asc');
    expect(select.params).toEqual(expect.arrayContaining(['produccion', 'cost_center']));
  });

  it('leerCatalogo no mezcla ambientes ni cuando no se le pide ninguno', async () => {
    filasEncoladas = [];

    await leerCatalogo('tax');

    // Sin ambiente explícito manda el configurado (`pruebas`), nunca «todos».
    expect(unicaSentencia('select').params).toContain('pruebas');
  });

  it('el resumen agrupa por tipo DENTRO de un ambiente', async () => {
    filasEncoladas = [];

    await resumenCatalogos({ ambiente: 'produccion' });

    const select = unicaSentencia('select');
    const normalizado = select.sql.replace(/\s+/g, ' ').toLowerCase();
    expect(normalizado).toContain('group by "siigo_catalogos"."tipo"');
    expect(normalizado).toContain('"ambiente" = $');
    expect(select.params).toContain('produccion');
  });

  it('el resumen lee los conteos que devuelve la base, no los recalcula', async () => {
    // Orden posicional de la selección: tipo, total, activos, sincronizado_en.
    filasEncoladas = [['tax', 4, 3, new Date('2026-08-05T10:00:00.000Z')]];

    const r = await resumenCatalogos({ ambiente: 'pruebas' });

    expect(r.find((c) => c.tipo === 'tax')).toMatchObject({
      total: 4, activos: 3, ambiente: 'pruebas', sincronizadoEn: '2026-08-05T10:00:00.000Z',
    });
    // Los cinco que nunca se sincronizaron en ESTE ambiente siguen apareciendo en cero.
    expect(r.filter((c) => c.total === 0)).toHaveLength(5);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('aislamiento por ambiente en el SQL [keyed]', () => {
  it('ninguna sentencia de la sincronización sale sin su ambiente enlazado', async () => {
    await sincronizarImpuestos('produccion');

    expect(sentencias.length).toBeGreaterThan(0);
    for (const s of sentencias) {
      expect(s.params, `sentencia sin ambiente: ${s.sql}`).toContain('produccion');
      expect(s.params).not.toContain('pruebas');
    }
  });

  it('sincronizar el mismo catálogo en los dos ambientes emite dos escrituras separadas', async () => {
    await sincronizarImpuestos('pruebas');
    await sincronizarImpuestos('produccion');

    const inserts = sentenciasQueEmpiezanCon('insert');
    const updates = sentenciasQueEmpiezanCon('update');
    expect(inserts).toHaveLength(2);
    expect(updates).toHaveLength(2);
    // Mismo código de Siigo, filas distintas: son empresas distintas.
    expect(inserts[0]!.params).toContain('pruebas');
    expect(inserts[1]!.params).toContain('produccion');
    expect(inserts.every((i) => i.params.includes('13156'))).toBe(true);
    expect(updates[0]!.params).toContain('pruebas');
    expect(updates[1]!.params).toContain('produccion');
  });
});
