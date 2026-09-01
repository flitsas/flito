// HU #11963 (Feature #11908) — las colas de SOAT e Impuestos abren por lo MÁS RECIENTE.
//
// ── Qué se comprueba y por qué en un solo sitio ──────────────────────────────────────────────────
//
// El cambio son cuatro `ORDER BY` en cuatro archivos, y las cuatro superficies tienen que girar
// JUNTAS: si el Excel se quedara con el orden viejo, el archivo dejaría de leerse como la pantalla —
// que es la invariante que su propio comentario declara— y nadie lo notaría hasta que un usuario
// comparase las dos cosas. Por eso las cuatro se afirman en la misma suite: quien vuelva una a `asc`
// ve caer un test con el nombre de SU superficie.
//
// ── Por qué el orden NO se lee de la respuesta ───────────────────────────────────────────────────
//
// `helpers/db.ts` (como `keyed-db`) devuelve las filas que el test registró y `orderBy` es
// passthrough: la respuesta sale en el orden de la fixture con `asc`, con `desc` y sin `ORDER BY`.
// Un `expect(items[0].id).toBe(NUEVA)` aquí sería una tautología —el test comprobando su propia
// fixture— y sobreviviría al mutante entero.
//
// Lo que se hace en su lugar: se captura el `ORDER BY` que el servicio emitió, se LEE del SQL
// renderizado (columna y sentido) y se aplica a las filas como lo haría PostgreSQL
// (`helpers/orden-sql.ts`). El aserto sigue hablando de datos —«arriba la del 29 de agosto»— pero el
// criterio sale del código bajo prueba, no de esta suite.
//
// Dos detalles de las fixtures que no son decorado:
//
//   · **Tres filas, no dos.** Con dos, un orden invertido acierta la mitad de las veces por
//     casualidad —y `[b, a]` frente a `[a, b]` no distingue «ordenó al revés» de «no ordenó».
//   · **Los ids NO siguen el orden de las fechas.** Si el id mayor fuera siempre el más nuevo, un
//     `ORDER BY id DESC` a secas daría la misma respuesta que el criterio correcto y el test no
//     vería la diferencia. Aquí `MEDIA` tiene el id más alto a propósito.
//
// El desempate por `id` tiene su propio caso: dos filas con el MISMO `created_at`. Es lo que evita
// que una fila salga en dos páginas o en ninguna, y con `created_at desc` solo se sostiene si el id
// desempata en el mismo sentido — un `asc` olvidado ahí es el defecto probable de esta HU.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { terminosDeOrden, ordenarComoPostgres } from '../helpers/orden-sql.js';

const selectMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock,
    insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
    update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn(),
  },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

// ─────────────────────────────── El mock que RECUERDA cómo se ordenó ────────────────────────────

interface Lectura { proyeccion: string[]; orden: unknown[] }

type Fila = Record<string, unknown>;

let lecturas: Lectura[] = [];
/** Las filas que devuelve la consulta de la cola/el export. Cada test pone las suyas. */
let filas: Fila[] = [];

const METODOS = [
  'from', 'where', 'leftJoin', 'innerJoin', 'limit', 'offset', 'groupBy', 'having', 'for', '$dynamic',
] as const;

/** La lectura de la cola es la que ordena por `created_at`; las del ensamblado no ordenan por ahí. */
function esLecturaDeLaCola(l: Lectura): boolean {
  return l.orden.length > 0 && terminosDeOrden(l.orden).some((t) => t.columna === 'created_at');
}

function chainEspia(proyeccion?: unknown): Record<string, unknown> {
  const lectura: Lectura = {
    proyeccion: proyeccion && typeof proyeccion === 'object' ? Object.keys(proyeccion as object) : [],
    orden: [],
  };
  lecturas.push(lectura);

  const t: Record<string, unknown> = {};
  for (const m of METODOS) t[m] = () => t;
  t.orderBy = (...args: unknown[]) => { lectura.orden.push(...args); return t; };
  // Las filas se deciden al AWAIT y no al construir el chain: para entonces el servicio ya llamó a
  // `.orderBy()`, así que la consulta de la cola se distingue de las del ensamblado por su criterio
  // y no por la posición en que se encoló —que cambia en cuanto alguien añade una lectura.
  const run = () => Promise.resolve().then(() => {
    if (lectura.proyeccion.includes('total')) return [{ total: filas.length }];
    return esLecturaDeLaCola(lectura) ? filas : [];
  });
  t.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => run().then(res, rej);
  t.catch = (rej: (e: unknown) => unknown) => run().catch(rej);
  t.finally = (cb: () => void) => run().finally(cb);
  return t;
}

beforeEach(() => {
  lecturas = [];
  filas = [];
  selectMock.mockReset();
  selectMock.mockImplementation((p?: unknown) => chainEspia(p));
});

/** El `ORDER BY` de la cola, o el fallo si no hubo ninguno (dejar de ordenar TAMBIÉN es el defecto). */
function ordenDeLaCola(): ReturnType<typeof terminosDeOrden> {
  const l = lecturas.find(esLecturaDeLaCola);
  if (!l) throw new Error('Ninguna consulta ordenó por `created_at`');
  return terminosDeOrden(l.orden);
}

/** El SQL habla snake_case y las fixtures camelCase; una columna inesperada es un fallo, no un `undefined`. */
function lector(f: Fila, columna: string): Date | string {
  if (columna === 'created_at') return f.createdAt as Date;
  if (columna === 'id') return f.id as string;
  throw new Error(`La consulta ordenó por una columna que esta prueba no conoce: ${columna}`);
}

/** Los ids en el orden en que PostgreSQL devolvería estas filas con el `ORDER BY` que emitió el servicio. */
const idsComoLosDevolveriaLaBase = (): unknown[] =>
  ordenarComoPostgres(filas, ordenDeLaCola(), lector).map((f) => f.id);

// ───────────────────────────────────────── Fixtures ─────────────────────────────────────────────

const ID_VIEJA = '11111111-1111-4111-8111-111111111111';
const ID_NUEVA = '22222222-2222-4222-8222-222222222222';
// El id MÁS ALTO es el de la fila de en medio: así `ORDER BY id DESC` a secas no da la respuesta
// correcta por accidente.
const ID_MEDIA = '33333333-3333-4333-8333-333333333333';

const F_VIEJA = new Date('2026-08-01T08:00:00.000Z');
const F_MEDIA = new Date('2026-08-15T08:00:00.000Z');
const F_NUEVA = new Date('2026-08-29T08:00:00.000Z');

/** Las tres, registradas de la más ANTIGUA a la más nueva: el orden que la HU voltea. */
const TRES = [
  { id: ID_VIEJA, createdAt: F_VIEJA },
  { id: ID_MEDIA, createdAt: F_MEDIA },
  { id: ID_NUEVA, createdAt: F_NUEVA },
];
const ESPERADO = [ID_NUEVA, ID_MEDIA, ID_VIEJA];

/** El empate: mismo instante, ids distintos, registrados de menor a mayor. */
const EMPATE_MENOR = '44444444-4444-4444-8444-444444444444';
const EMPATE_MAYOR = '55555555-5555-4555-8555-555555555555';
const MISMO_INSTANTE = new Date('2026-08-20T10:30:00.000Z');
const EMPATADAS = [
  { id: EMPATE_MENOR, createdAt: MISMO_INSTANTE },
  { id: EMPATE_MAYOR, createdAt: MISMO_INSTANTE },
];

/** Fila de la cola de SOAT, tal como sale del join `flito_soat` × `vehicles` × … */
const filaSoat = (base: { id: string; createdAt: Date }): Fila => ({
  ...base,
  vin: '9FKRG2222T2042405', estado: 'pendiente', origen: 'tramite',
  proveedorSoatId: null, gestionOperaciones: false, enviadoEn: null, pagadoEn: null,
  valorPagado: null, motivoRechazo: null,
  placa: 'JNH38H', marca: 'MAZDA', linea: 'CX-30',
  cilindraje: '1598', carroceria: null, tipoServicio: 'Particular',
  companiaNombre: 'ACME SAS', organismoNombre: 'FUNZA', proveedorSoatNombre: null,
  proveedorSlaHoras: null, enviadoPorNombre: null,
});

/** Fila de la cola de Impuestos. */
const filaImpuesto = (base: { id: string; createdAt: Date }): Fila => ({
  ...base,
  tramiteId: `tr-${base.id}`, idFlit: 'FLIT-1', tipoTramite: 'Traspaso',
  fechaAprobacion: null, fechaCreacion: null,
  marca: 'MAZDA', linea: 'CX-30', estado: 'pendiente', organismoCodigo: '25286000',
  valorLiquidado: null, valorPagado: null, marcadoPorDiferencia: false, facturaVentaFlitId: null,
  gestionOperaciones: false, enviadoEn: null, pagadoEn: null, motivoRechazo: null,
  placa: 'JNH38H', vin: '9FKRG2222T2042405', companiaNombre: 'ACME SAS',
  organismoNombre: 'FUNZA', organismoSla: null, enviadoPorNombre: null, tipoTitularFlit: null,
});

/** Fila del export de SOAT: la proyección del archivo, más `createdAt` (que ordena sin proyectarse). */
const filaExportSoat = (base: { id: string; createdAt: Date }): Fila => ({
  ...base,
  origen: 'tramite', vin: '9FKRG2222T2042405', placa: 'JNH38H',
  carroceria: null, servicio: 'Particular', cilindraje: '1598', organismoCodigo: '25286000',
});

/** Fila del export de Impuestos. */
const filaExportImpuesto = (base: { id: string; createdAt: Date }): Fila => ({
  ...base,
  tramiteId: `tr-${base.id}`, placa: 'JNH38H', vin: '9FKRG2222T2042405',
  municipio: 'FUNZA', organismoDetto: 'SECRETARIA DE FUNZA',
  carroceria: null, servicio: 'Particular', cilindraje: '1598', organismoCodigo: '25286000',
  nombres: null, apellidos: null, numeroDocumento: null, correo: null, celular: null,
  direccion: null, modelo: null, clase: null, capacidad: null, departamento: null, tipo: null,
});

const CTX_SOAT = { userId: 1, username: 'admin', role: 'admin', proveedorSoatId: null, companiaId: null };
const CTX_IMPUESTOS = { userId: 1, username: 'admin', role: 'admin', transitoCodigo: null };

// ────────────────────────────────────────── Las cuatro ──────────────────────────────────────────

describe('cola de SOAT — abre por lo más reciente (HU #11963)', () => {
  it('**tres solicitudes de tres días distintos: arriba la de HOY, abajo la más antigua**', async () => {
    const { cola } = await import('../../src/modules/flito-soat/flito-soat.service.js');
    filas = TRES.map(filaSoat);

    const r = await cola(CTX_SOAT as never, {});
    // El servicio consultó de verdad (si no, no habría `ORDER BY` que leer) y devolvió las tres.
    expect(r.items).toHaveLength(3);
    expect(idsComoLosDevolveriaLaBase()).toEqual(ESPERADO);
  });

  it('mismo instante de creación: manda el `id` MAYOR — el desempate viaja con la clave', async () => {
    const { cola } = await import('../../src/modules/flito-soat/flito-soat.service.js');
    filas = EMPATADAS.map(filaSoat);

    await cola(CTX_SOAT as never, {});
    // Registradas de menor a mayor: si el desempate desapareciera, o si se quedara en `asc`, aquí
    // saldrían en el orden de la fixture. Es el caso de las dos páginas (o ninguna).
    expect(idsComoLosDevolveriaLaBase()).toEqual([EMPATE_MAYOR, EMPATE_MENOR]);
  });
});

describe('cola de Impuestos — abre por lo más reciente (HU #11963)', () => {
  it('**tres impuestos de tres días distintos: arriba el de HOY, abajo el más antiguo**', async () => {
    const { colaImpuestos } = await import('../../src/modules/flito-impuestos/flito-impuestos.service.js');
    filas = TRES.map(filaImpuesto);

    const r = await colaImpuestos(CTX_IMPUESTOS as never, {});
    expect(r.items).toHaveLength(3);
    expect(idsComoLosDevolveriaLaBase()).toEqual(ESPERADO);
  });

  it('mismo instante de creación: manda el `id` MAYOR — el desempate viaja con la clave', async () => {
    const { colaImpuestos } = await import('../../src/modules/flito-impuestos/flito-impuestos.service.js');
    filas = EMPATADAS.map(filaImpuesto);

    await colaImpuestos(CTX_IMPUESTOS as never, {});
    expect(idsComoLosDevolveriaLaBase()).toEqual([EMPATE_MAYOR, EMPATE_MENOR]);
  });
});

describe('Excel de SOAT — el archivo se lee como la pantalla (HU #11963)', () => {
  it('**el `.xlsx` sale en el MISMO sentido que la cola: lo más nuevo primero**', async () => {
    const { construirFilasExportSoat } = await import('../../src/modules/flito-soat/flito-soat.export.service.js');
    filas = TRES.map(filaExportSoat);

    const r = await construirFilasExportSoat(CTX_SOAT as never, {});
    expect(r).toHaveLength(3);
    // La invariante de la HU: el archivo NO tiene un orden propio, tiene el de la pantalla. Si un día
    // vuelve a girar, gira en los dos sitios o esta prueba y la de la cola dejan de coincidir.
    expect(idsComoLosDevolveriaLaBase()).toEqual(ESPERADO);
  });

  it('mismo instante de creación: el archivo desempata por `id` y en el mismo sentido', async () => {
    const { construirFilasExportSoat } = await import('../../src/modules/flito-soat/flito-soat.export.service.js');
    filas = EMPATADAS.map(filaExportSoat);

    await construirFilasExportSoat(CTX_SOAT as never, {});
    // Sin desempate, dos descargas del mismo filtro pueden traer las filas en orden distinto.
    expect(idsComoLosDevolveriaLaBase()).toEqual([EMPATE_MAYOR, EMPATE_MENOR]);
  });
});

describe('Excel de Impuestos — el archivo se lee como la pantalla (HU #11963)', () => {
  it('**el `.xlsx` sale en el MISMO sentido que la cola: lo más nuevo primero**', async () => {
    const { construirFilasExportImpuestos } = await import('../../src/modules/flito-impuestos/flito-impuestos.export.service.js');
    filas = TRES.map(filaExportImpuesto);

    const r = await construirFilasExportImpuestos(CTX_IMPUESTOS as never, {});
    expect(r).toHaveLength(3);
    expect(idsComoLosDevolveriaLaBase()).toEqual(ESPERADO);
  });

  it('mismo instante de creación: el archivo desempata por `id` y en el mismo sentido', async () => {
    const { construirFilasExportImpuestos } = await import('../../src/modules/flito-impuestos/flito-impuestos.export.service.js');
    filas = EMPATADAS.map(filaExportImpuesto);

    await construirFilasExportImpuestos(CTX_IMPUESTOS as never, {});
    expect(idsComoLosDevolveriaLaBase()).toEqual([EMPATE_MAYOR, EMPATE_MENOR]);
  });
});

describe('lo que esta HU NO voltea', () => {
  it('los COMPRADORES de un registro siguen en su orden natural (`orden` ascendente)', async () => {
    // El orden de los propietarios DENTRO de una fila no es el de la cola: el titular principal es el
    // `orden = 0` y voltearlo cambiaría quién sale como principal en la pantalla y en el archivo.
    // Se afirma sobre la consulta real, no sobre el comentario.
    const { cola } = await import('../../src/modules/flito-soat/flito-soat.service.js');
    filas = TRES.map(filaSoat);
    await cola(CTX_SOAT as never, {});

    const porOrden = lecturas
      .filter((l) => l.orden.length > 0)
      .map((l) => terminosDeOrden(l.orden))
      .filter((ts) => ts.some((t) => t.columna === 'orden'));

    // Puede no haber ninguna (la fixture no trae trámites) — pero si la hay, es ascendente.
    for (const ts of porOrden) {
      expect(ts.every((t) => t.direccion === 'asc')).toBe(true);
    }
    // Y la de la cola sigue siendo descendente en SUS DOS términos, ni uno solo.
    expect(ordenDeLaCola().map((t) => t.direccion)).toEqual(['desc', 'desc']);
  });
});
