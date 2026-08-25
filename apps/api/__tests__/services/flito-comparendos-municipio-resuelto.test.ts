// FLITO comparendos — el municipio del comparendo, resuelto y filtrable (HU #11878, Feature #11495).
//
// El defecto que cierra la HU es de los que no se ven: el filtro por municipio comparaba contra
// `municipio_fuente` —«a qué municipio se le PREGUNTÓ»—, que viene `NULL` en toda fila que solo vio
// el SIMIT. **Filtrar por Medellín escondía comparendos de Medellín**, y el `organismo` de esas
// mismas filas («STRIA DE TTOyTTE MEDELLIN») decía exactamente de dónde eran. No había error, ni
// log, ni fila de menos en ningún contador: solo una lista más corta de lo que debía.
//
// Este archivo prueba la HU de punta a punta, y el aserto central es el CUARTO: una fila con
// `municipio_fuente = null` **tiene que salir** al filtrar por su municipio. Ese es el test que
// falla contra el código anterior a la HU.
//
//   · AC1 — el municipio consultado manda, y corta la evaluación (ni se mira el organismo).
//   · AC2 — `STRIA DE TTOyTTE MEDELLIN` en una fila solo-SIMIT → `MEDELLIN`.
//   · AC3 — lo no reconocible (y lo AMBIGUO) queda vacío, y el `organismo` se conserva intacto.
//   · AC4 — **el filtro por Medellín devuelve también la fila solo-SIMIT.**
//   · AC6 — el Excel publica el municipio RESUELTO y conserva la columna de organismo.
//
// El AC5 (el backfill del histórico, que no toca `municipio_fuente` ni `organismo`) vive en
// `flito-comparendos-migracion-0165-paridad.test.ts`, junto con la paridad entre las dos escrituras
// del criterio: es análisis del `.sql` y no de este módulo.
//
// El AC4 no se prueba mirando el SQL —eso ya lo hace `flito-comparendos-registros.test.ts`, que fija
// la columna del WHERE— sino con una MINI-TABLA que aplica el filtro que LEE de la consulta. La
// diferencia importa: una aserción sobre la cadena del WHERE dice qué columna se nombró; esta dice
// qué filas le llegan al operador, que es lo que la HU promete.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import ExcelJS from 'exceljs';
import { getTableName } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken, type TestRole } from '../helpers/auth.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: vi.fn().mockResolvedValue(undefined) }));

const { municipioDelComparendo, resolverCampos } =
  await import('../../src/modules/flito-comparendos/flito-comparendos-merge.js');
const { COLUMNAS_EXPORT } =
  await import('../../src/modules/flito-comparendos/flito-comparendos.export.service.js');

const BASE = '/api/flito/comparendos';
const REGISTROS = `${BASE}/registros`;
const TABLA = 'flito_comparendos_registros';

/** El catálogo tal como lo sembró la 0150, que es lo que el sync le pasa al criterio. */
const CATALOGO = ['BELLO', 'ITAGUI', 'CALI', 'ENVIGADO', 'MANIZALES', 'MEDELLIN', 'RIONEGRO', 'SABANETA'];

/** El organismo REAL de las filas que solo ve el SIMIT (capturado sobre el NIT 901789698). */
const ORGANISMO_SIMIT_MEDELLIN = 'STRIA DE TTOyTTE MEDELLIN';

// ─────────────────────────── AC1/AC2/AC3 · El criterio ──────────────────────────────────────────

describe('AC1 · el municipio CONSULTADO manda y corta la evaluación', () => {
  it('con `municipioFuente`, ese es el municipio aunque el organismo diga otro', () => {
    // No es una preferencia: es que el hecho vence a la heurística. A Bello se le preguntó y Bello
    // respondió; que su secretaría escriba «Medellín» en el organismo no cambia de quién es la fila,
    // y dejar ganar al texto libre del proveedor sobre el dato de la corrida sería empeorar un dato
    // que ya era cierto.
    expect(municipioDelComparendo('BELLO', ORGANISMO_SIMIT_MEDELLIN, CATALOGO)).toBe('BELLO');
  });

  it('y vale incluso con un organismo AMBIGUO o ausente: el escalón 2 ni se ejecuta', () => {
    expect(municipioDelComparendo('BELLO', 'CONVENIO MEDELLIN - ITAGUI', CATALOGO)).toBe('BELLO');
    expect(municipioDelComparendo('BELLO', null, CATALOGO)).toBe('BELLO');
  });

  it('**un municipio consultado que NO está en el catálogo también gana**', () => {
    // El escalón 1 no valida contra el catálogo, y no debe: si se le preguntó a esa fuente y
    // respondió, la fila es suya. Validar aquí haría que dar de baja un municipio del catálogo
    // vaciara el municipio de los comparendos que acaba de traer.
    expect(municipioDelComparendo('TUNJA', ORGANISMO_SIMIT_MEDELLIN, CATALOGO)).toBe('TUNJA');
  });
});

describe('AC2 · sin municipio consultado, el municipio sale del ORGANISMO', () => {
  it('**`STRIA DE TTOyTTE MEDELLIN` → `MEDELLIN`**: el caso que motiva la HU', () => {
    expect(municipioDelComparendo(null, ORGANISMO_SIMIT_MEDELLIN, CATALOGO)).toBe('MEDELLIN');
  });

  it('el organismo largo del UTS se reconoce igual', () => {
    expect(municipioDelComparendo(null, 'SECRETARIA DE TRANSITO Y TRANSPORTE DE BELLO', CATALOGO))
      .toBe('BELLO');
  });

  it('**y con TILDES y minúsculas también**: se normaliza como el catálogo', () => {
    // El organismo real llega escrito para un humano («Secretaría de Movilidad de Medellín»). Sin el
    // pliegue de acentos —el mismo `normalizarCodigoFuente` con el que el catálogo guardó el código—
    // el municipio más frecuente del módulo sería justo el que no se reconoce.
    expect(municipioDelComparendo(null, 'Secretaría de Movilidad de Medellín', CATALOGO))
      .toBe('MEDELLIN');
  });

  it('el catálogo entra COMPLETO: un municipio DESACTIVADO se sigue reconociendo', () => {
    // Es la misma premisa con la que el filtro no valida su municipio contra el catálogo: desactivar
    // una fuente deja de consultarla, no borra de dónde eran los comparendos que ya trajo. Como el
    // criterio recibe la lista ya cargada, se prueba por lo que hace con ella: reconocer a Medellín
    // no depende de que Medellín siga activo, y quien decide eso es quien construye la lista
    // (`catalogoMunicipios()` en el sync, SIN `WHERE activo`).
    expect(municipioDelComparendo(null, ORGANISMO_SIMIT_MEDELLIN, ['MEDELLIN'])).toBe('MEDELLIN');
  });
});

describe('AC3 · lo que no se sabe queda VACÍO, y vacío es `null`', () => {
  it('un organismo que no nombra a nadie del catálogo → `null`', () => {
    expect(municipioDelComparendo(null, 'DIRECCION TERRITORIAL DE TRANSITO', CATALOGO)).toBeNull();
  });

  it('sin organismo → `null`', () => {
    expect(municipioDelComparendo(null, null, CATALOGO)).toBeNull();
  });

  it('**DOS municipios en el mismo texto → `null`**: la ambigüedad no se desempata', () => {
    // Ni por longitud ni por «gana el primero»: los dos serían una decisión inventada sobre texto
    // libre, y equivocarse aquí es enseñarle a un operador un comparendo de otro municipio.
    expect(municipioDelComparendo(null, 'CONVENIO MEDELLIN - BELLO', CATALOGO)).toBeNull();
    expect(municipioDelComparendo(null, 'AREA METROPOLITANA BELLO ITAGUI SABANETA', CATALOGO)).toBeNull();
  });

  it('**el LÍMITE de palabra: `CALIDAD` no es `CALI`, ni `MEDELLINENSE` es `MEDELLIN`**', () => {
    // Sin el límite —con un `includes` o un `LIKE '%…%'`— las dos casarían y el comparendo quedaría
    // atribuido a un municipio que su organismo no nombra.
    expect(municipioDelComparendo(null, 'OFICINA DE CALIDAD VIAL', CATALOGO)).toBeNull();
    expect(municipioDelComparendo(null, 'INSTITUTO MEDELLINENSE', CATALOGO)).toBeNull();
  });

  it('pero el separador SÍ cuenta como límite: `MEDELLIN-CENTRO` es Medellín', () => {
    expect(municipioDelComparendo(null, 'STRIA MEDELLIN-CENTRO', CATALOGO)).toBe('MEDELLIN');
  });

  it('un código CON ESPACIOS se reconoce entero, que es por lo que `\\b` no servía', () => {
    const catalogo = [...CATALOGO, 'SANTA FE DE ANTIOQUIA'];
    expect(municipioDelComparendo(null, 'TRANSITO DE SANTA FE DE ANTIOQUIA', catalogo))
      .toBe('SANTA FE DE ANTIOQUIA');
  });

  it('**nunca devuelve cadena vacía**: `null` es el único valor de «no se sabe»', () => {
    for (const organismo of [null, '', '   ', 'SIN MUNICIPIO', 'MEDELLIN Y BELLO']) {
      expect(municipioDelComparendo(null, organismo, CATALOGO)).not.toBe('');
    }
  });
});

// ─────────────────────────── El derivado dentro del merge ───────────────────────────────────────

describe('`resolverCampos` deriva el municipio del organismo YA RESUELTO (RN-13)', () => {
  const canonico = (over: Record<string, unknown> = {}) => ({
    numeroComparendo: 'C-1', placa: null, codigoInfraccion: null, descripcionInfraccion: null,
    fechaComparendo: null, fechaNotificacion: null, organismo: null, monto: null, estadoFuente: null,
    numeroResolucion: null, idResolucion: null, ...over,
  });

  const consolidado = (simit: unknown, municipal: unknown, municipioFuente: string | null = null) => ({
    numero: 'C-1',
    simit: simit as never,
    payloadSimit: null,
    municipal: municipal as never,
    payloadMunicipal: null,
    municipioFuente,
  });

  const ctx = (municipioFuente: string | null) => ({ municipioFuente, catalogoMunicipios: CATALOGO });

  it('AC2 · una fila que solo vio el SIMIT sale con su municipio deducido', () => {
    const campos = resolverCampos(
      consolidado(canonico({ organismo: ORGANISMO_SIMIT_MEDELLIN }), null),
      null,
      ctx(null),
    );

    expect(campos.municipioComparendo).toBe('MEDELLIN');
    // AC3: el organismo se CONSERVA. La deducción no consume el texto del que salió, entre otras
    // cosas porque es lo único con lo que un humano puede auditar la atribución.
    expect(campos.organismo).toBe(ORGANISMO_SIMIT_MEDELLIN);
  });

  it('**se deduce del organismo RESUELTO, no del que trajo un origen suelto**', () => {
    // El mutante que este caso caza: derivar el municipio dentro de `homologar`, por origen. SIMIT
    // gana el organismo por RN-13, así que la fila diría «Bello» en el organismo y «Medellín» en el
    // municipio — dos columnas de la misma fila contradiciéndose, y ninguna consulta lo delataría.
    const campos = resolverCampos(
      consolidado(
        canonico({ organismo: 'SECRETARIA DE TRANSITO DE BELLO' }),
        canonico({ organismo: ORGANISMO_SIMIT_MEDELLIN }),
      ),
      null,
      ctx(null),
    );

    expect(campos.organismo).toBe('SECRETARIA DE TRANSITO DE BELLO');
    expect(campos.municipioComparendo).toBe('BELLO');
  });

  it('el organismo del TERCER escalón (lo ya guardado) también sirve para deducir', () => {
    // Si ninguna fuente publica el organismo hoy, RN-13 conserva el guardado; el municipio tiene que
    // salir de ese mismo valor, o la fila perdería el municipio por el silencio del proveedor.
    const campos = resolverCampos(
      consolidado(canonico(), null),
      { organismo: ORGANISMO_SIMIT_MEDELLIN },
      ctx(null),
    );

    expect(campos.municipioComparendo).toBe('MEDELLIN');
  });

  it('AC1 · con municipio consultado, ese gana dentro del merge', () => {
    const campos = resolverCampos(
      consolidado(canonico({ organismo: ORGANISMO_SIMIT_MEDELLIN }), null, 'BELLO'),
      null,
      ctx('BELLO'),
    );

    expect(campos.municipioComparendo).toBe('BELLO');
  });

  it('**se RE-DERIVA entera: no hay escalón «lo que ya había»**', () => {
    // Es lo que hace que añadir un municipio al catálogo corrija el histórico que el sync visita,
    // sin migración. Un tercer escalón que conservara el valor viejo congelaría lo deducido con el
    // catálogo de ayer — y aquí se ve al revés: con un catálogo que ya no reconoce el organismo, el
    // municipio vuelve a `null` en vez de quedarse pegado.
    const campos = resolverCampos(
      consolidado(canonico({ organismo: 'TRANSITO DE TUNJA' }), null),
      { organismo: 'TRANSITO DE TUNJA' },
      { municipioFuente: null, catalogoMunicipios: CATALOGO },
    );

    expect(campos.municipioComparendo).toBeNull();
  });
});

// ─────────────────────────── AC4 · El filtro devuelve la fila solo-SIMIT ────────────────────────

const dialecto = new PgDialect();

interface Consulta { tabla: string; condiciones: unknown[]; orden: unknown[]; limite: number | null }

const lecturas: Consulta[] = [];

function nombre(tbl: unknown): string {
  try { return getTableName(tbl as never); } catch { return '__expr__'; }
}

/** Registra WHERE, ORDER BY y LIMIT de cada lectura: el mock los descarta y aquí son la prueba. */
function instalarEspia(): void {
  const base = kdb.select.getMockImplementation() as (...a: unknown[]) => Record<string, unknown>;
  kdb.select.mockImplementation((...args: unknown[]) => {
    const chain = base(...args);
    const registro: Consulta = { tabla: '__sin_from__', condiciones: [], orden: [], limite: null };
    const from = chain.from as (t: unknown) => unknown;
    chain.from = (tbl: unknown) => { registro.tabla = nombre(tbl); lecturas.push(registro); return from(tbl); };
    const where = chain.where as (v: unknown) => unknown;
    chain.where = (c: unknown) => { if (c !== undefined) registro.condiciones.push(c); return where(c); };
    const orderBy = chain.orderBy as (...v: unknown[]) => unknown;
    chain.orderBy = (...c: unknown[]) => { registro.orden.push(...c); return orderBy(...c); };
    const limit = chain.limit as (v: number) => unknown;
    chain.limit = (n: number) => { registro.limite = n; return limit(n); };
    return chain;
  });
}

const AHORA = new Date('2026-08-25T15:30:00.000Z');
const ANTES = new Date('2026-08-24T09:00:00.000Z');
const idNumero = (n: number) => {
  const d = String(n);
  return `${d.repeat(8)}-${d.repeat(4)}-4${d.repeat(3)}-8${d.repeat(3)}-${d.repeat(12)}`;
};

/**
 * Fila del consolidado. Los tres campos que esta HU distingue van explícitos en cada caso porque son
 * justamente los que no pueden confundirse: quién respondió, qué dice el organismo y de dónde es.
 */
const fila = (over: Record<string, unknown> = {}) => ({
  id: idNumero(1),
  numeroComparendo: '05001000000012345678',
  nitMonitoreado: '900123456',
  placa: 'ABC123',
  codigoInfraccion: 'C29',
  descripcionInfraccion: 'Estacionar en sitio prohibido',
  fechaComparendo: '2026-06-02',
  fechaNotificacion: '2026-06-19',
  organismo: ORGANISMO_SIMIT_MEDELLIN,
  municipioFuente: null,
  municipioComparendo: 'MEDELLIN',
  monto: '604100.00',
  estadoFuente: 'PENDIENTE',
  tipoRegistro: 'comparendo',
  numeroResolucion: null,
  origenMerge: 'simit',
  vistoEnSimit: true,
  vistoEnMunicipal: false,
  estado: 'activo',
  primeraVistoEn: ANTES,
  ultimoVistoEn: AHORA,
  inactivadoEn: null,
  ultimoSyncRunId: null,
  causalId: null,
  observacion: null,
  gestionActualizadaEn: null,
  gestionActualizadaPor: null,
  gestionAutorNombre: null,
  createdAt: ANTES,
  updatedAt: AHORA,
  payloadSimit: null,
  payloadMunicipal: null,
  ...over,
});

/**
 * El municipio por el que la consulta acota, leído del SQL que construyó el servicio.
 *
 * Se lee la COLUMNA además del valor, y ese es el corazón del AC4: si el servicio volviera a
 * comparar contra `municipio_fuente`, esta tabla filtraría por `municipio_fuente` —como haría
 * PostgreSQL— y la fila solo-SIMIT desaparecería del resultado. La mini-tabla no puede «arreglar»
 * el defecto sin dejar de simular la base.
 */
function acotacionPorMunicipio(c: Consulta): { columna: string; valor: string } | null {
  if (c.condiciones.length === 0) return null;
  const w = dialecto.sqlToQuery(c.condiciones[0] as never);
  const m = /"(municipio_[a-z_]+)" = \$(\d+)/.exec(w.sql);
  return m ? { columna: m[1], valor: String(w.params[Number(m[2]) - 1]) } : null;
}

function tablaEnMemoria(filas: Record<string, unknown>[]) {
  return (): Record<string, unknown>[] => {
    const q = lecturas.filter((l) => l.tabla === TABLA).at(-1)!;
    const acota = acotacionPorMunicipio(q);
    const visibles = acota === null
      ? filas
      : filas.filter((f) => f[acota.columna === 'municipio_fuente' ? 'municipioFuente' : 'municipioComparendo'] === acota.valor);
    return q.limite === null ? visibles : visibles.slice(0, q.limite);
  };
}

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-comparendos/flito-comparendos.routes.js');
  app.use(BASE, router);
  return app;
}

const sesion = (sub: number) => async (role: TestRole = 'admin') =>
  `Bearer ${await testToken({ sub, username: 'ops@flit.io', role })}`;

beforeEach(() => {
  kdb.reset();
  lecturas.length = 0;
  instalarEspia();
});

describe('AC4 · el filtro por MEDELLIN devuelve también la fila que solo vio el SIMIT', () => {
  const auth = sesion(7878);

  /** Las tres filas que separan las dos preguntas. Ninguna es decorativa. */
  const UNIVERSO = [
    // 1. La del defecto: nadie le preguntó a Medellín, pero el comparendo es de Medellín.
    fila({
      id: idNumero(1),
      organismo: ORGANISMO_SIMIT_MEDELLIN,
      municipioFuente: null,
      municipioComparendo: 'MEDELLIN',
      origenMerge: 'simit',
    }),
    // 2. La que ya salía antes: se le preguntó a Medellín y respondió.
    fila({
      id: idNumero(2),
      organismo: 'Secretaría de Movilidad de Medellín',
      municipioFuente: 'MEDELLIN',
      municipioComparendo: 'MEDELLIN',
      origenMerge: 'ambos',
    }),
    // 3. La que NO debe salir: es de otro municipio. Sin ella, un filtro que no filtrara nada
    //    también pasaría el test.
    fila({
      id: idNumero(3),
      organismo: 'Secretaría de Movilidad de Bello',
      municipioFuente: 'BELLO',
      municipioComparendo: 'BELLO',
      origenMerge: 'ambos',
    }),
  ];

  it('**salen las DOS de Medellín, incluida la que tiene `municipioFuente` en `null`**', async () => {
    kdb.when.select(TABLA, tablaEnMemoria(UNIVERSO));

    const r = await request(await buildApp())
      .get(`${REGISTROS}?municipio=MEDELLIN`).set('Authorization', await auth());

    expect(r.status).toBe(200);
    // Este es el aserto que falla contra el código anterior a la HU: con el filtro sobre
    // `municipio_fuente`, la mini-tabla deja fuera la fila 1 y aquí solo llega la 2.
    expect(r.body.items.map((i: { id: string }) => i.id)).toEqual([idNumero(1), idNumero(2)]);
  });

  it('la fila solo-SIMIT llega con su municipio resuelto y su `municipioFuente` intacto en `null`', async () => {
    kdb.when.select(TABLA, tablaEnMemoria(UNIVERSO));

    const r = await request(await buildApp())
      .get(`${REGISTROS}?municipio=MEDELLIN`).set('Authorization', await auth());

    expect(r.status).toBe(200);
    const item = r.body.items.find((i: { id: string }) => i.id === idNumero(1));
    // Las dos columnas viajan y dicen cosas distintas: es lo que permite al visor explicar por qué
    // una fila aparece bajo Medellín sin que Medellín la haya confirmado todavía.
    expect(item.municipioComparendo).toBe('MEDELLIN');
    expect(item.municipioFuente).toBeNull();
    expect(item.organismo).toBe(ORGANISMO_SIMIT_MEDELLIN);
  });

  it('y no arrastra las de OTRO municipio: el filtro sigue siendo por igualdad', async () => {
    kdb.when.select(TABLA, tablaEnMemoria(UNIVERSO));

    const r = await request(await buildApp())
      .get(`${REGISTROS}?municipio=BELLO`).set('Authorization', await auth());

    expect(r.status).toBe(200);
    expect(r.body.items.map((i: { id: string }) => i.id)).toEqual([idNumero(3)]);
  });

  it('**`fuente=simit` + `municipio` ya NO es una página vacía por construcción**', async () => {
    // Lo era —y así lo decía el contrato— porque esas filas tienen `municipioFuente` en `null`. Con
    // el municipio resuelto, la combinación es la pregunta más útil de las dos: «¿qué comparendos de
    // Medellín tiene el SIMIT que Medellín todavía no me ha confirmado?».
    kdb.when.select(TABLA, tablaEnMemoria(UNIVERSO.filter((f) => f.origenMerge === 'simit')));

    const r = await request(await buildApp())
      .get(`${REGISTROS}?municipio=MEDELLIN&fuente=simit`).set('Authorization', await auth());

    expect(r.status).toBe(200);
    expect(r.body.items.map((i: { id: string }) => i.id)).toEqual([idNumero(1)]);
  });

  it('un municipio sin comparendos propios devuelve la lista vacía, no la tabla entera', async () => {
    kdb.when.select(TABLA, tablaEnMemoria(UNIVERSO));

    const r = await request(await buildApp())
      .get(`${REGISTROS}?municipio=CALI`).set('Authorization', await auth());

    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([]);
  });
});

// ─────────────────────────── AC6 · El Excel ─────────────────────────────────────────────────────

describe('AC6 · el archivo publica el municipio RESUELTO y conserva el organismo', () => {
  const auth = sesion(7879);

  it('la columna «Municipio» sale de `municipioComparendo`, y sigue habiendo las mismas columnas', () => {
    const municipio = COLUMNAS_EXPORT.find((c) => c.header === 'Municipio');
    expect(municipio, 'el archivo perdió la columna Municipio').toBeDefined();
    expect(municipio!.key).toBe('municipioComparendo');
    // Mismo rótulo y mismo ancho: un consumidor externo que localice la columna por el TEXTO de la
    // cabecera no se entera del cambio, que es la única forma estable de leer este archivo.
    expect(municipio!.width).toBe(16);
    // Y «Organismo» sigue justo detrás: es el texto del que sale la deducción.
    const indices = COLUMNAS_EXPORT.map((c) => c.header);
    expect(indices.indexOf('Organismo')).toBe(indices.indexOf('Municipio') + 1);
    // Ninguna columna se añadió ni se quitó: el aserto de cabeceras de la #11558 sigue valiendo.
    expect(COLUMNAS_EXPORT).toHaveLength(22);
  });

  it('**una fila solo-SIMIT trae «MEDELLIN» en la celda de municipio y su organismo al lado**', async () => {
    kdb.when.select(TABLA, [fila({
      organismo: ORGANISMO_SIMIT_MEDELLIN, municipioFuente: null, municipioComparendo: 'MEDELLIN',
      causalNombre: null,
    })]);

    const r = await request(await buildApp())
      .post(`${REGISTROS}/export`).set('Authorization', await auth())
      // Sin `responseType('blob')` supertest interpreta el binario como texto y `exceljs` no puede
      // abrir el zip: el fallo se lee como «archivo corrupto» y no como lo que sería, un test mal
      // pedido.
      .responseType('blob').send({});

    expect(r.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.body as Buffer);
    const hoja = wb.worksheets[0];
    const cabeceras = (hoja.getRow(1).values as unknown[]).slice(1).map(String);
    const celda = (header: string) => hoja.getRow(2).getCell(cabeceras.indexOf(header) + 1).value;

    // Antes de la HU esta celda salía VACÍA en toda fila que solo hubiera visto el SIMIT: el archivo
    // se llevaba el organismo sin decir de qué municipio era.
    expect(celda('Municipio')).toBe('MEDELLIN');
    expect(celda('Organismo')).toBe(ORGANISMO_SIMIT_MEDELLIN);
  });

  it('y si el municipio no se pudo resolver, la celda va VACÍA y el organismo se conserva', async () => {
    // Vacío y no «SIMIT» ni «Desconocido»: una celda vacía es lo que Excel sabe filtrar, y un texto
    // de relleno convertiría una laguna en un dato dentro de un archivo que sale del perímetro.
    kdb.when.select(TABLA, [fila({
      organismo: 'DIRECCION TERRITORIAL DE TRANSITO', municipioFuente: null,
      municipioComparendo: null, causalNombre: null,
    })]);

    const r = await request(await buildApp())
      .post(`${REGISTROS}/export`).set('Authorization', await auth())
      // Sin `responseType('blob')` supertest interpreta el binario como texto y `exceljs` no puede
      // abrir el zip: el fallo se lee como «archivo corrupto» y no como lo que sería, un test mal
      // pedido.
      .responseType('blob').send({});

    expect(r.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.body as Buffer);
    const hoja = wb.worksheets[0];
    const cabeceras = (hoja.getRow(1).values as unknown[]).slice(1).map(String);
    const celda = (header: string) => hoja.getRow(2).getCell(cabeceras.indexOf(header) + 1).value;

    expect(celda('Municipio') ?? null).toBeNull();
    expect(celda('Organismo')).toBe('DIRECCION TERRITORIAL DE TRANSITO');
  });
});
