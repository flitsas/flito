// HU #11679 — el reporte de costos dice qué SOAT ya se descontó de bolsa al conciliar (CF-05).
//
// Hay dos cosas que probar y son de naturaleza distinta, así que se prueban distinto:
//
//   1. **La FORMA del SQL.** Es donde vive el riesgo real de esta historia: un join mal puesto
//      multiplica la fila del trámite y corrompe totales, conteo y CSV sin que nada falle. El mock
//      de drizzle ignora el SQL y devuelve lo que el test registró, así que sobre él un join
//      abanicado y una subconsulta escalar son indistinguibles. Por eso la consulta se COMPILA con
//      `PgDialect` y se afirma sobre el texto — el mismo recurso que ya usa el test de la HU #11336.
//      Afirmar sobre el texto NO es afirmar por substring: el predicado que impide el abanico se
//      comprueba por implicación lógica sobre los términos del WHERE (ver `whereDeTope`), porque
//      `toContain` no distingue el predicado de su neutralización.
//   2. **La TRADUCCIÓN a la fila.** Eso sí es puro, y se interroga por la ruta HTTP real para que
//      cubra también quién puede verla (AC5). Lo que la fila no debe cambiar se compara contra
//      `FILA_BASE`, un literal escrito a mano, y no contra otra salida del mismo código.
//
// Esas dos precisiones son la HU #11769. Hasta ella TRES casos de este archivo estaban en verde
// sin poder ponerse en rojo: los dos del predicado del WHERE y el de «ninguna otra columna
// cambia». El resto sí mordía; lo que se corrigió fue el modo de afirmar de esos tres.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken, type TestRole } from '../helpers/auth.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const {
  celdaConciliacionCsv, conciliacionDeFila, SELECT_CONCILIACION_SOAT,
} = await import('../../src/modules/finanzas/finanzas.conciliacion-soat.js');
const { aCsv, conJoins } = await import('../../src/modules/finanzas/finanzas.service.js');

const RUTA = '/api/finanzas/reporte-costos';

beforeEach(() => kdb.reset());

// ── Utilidades ──────────────────────────────────────────────────────────────

/** El SQL realmente compilado de una de las columnas nuevas. */
async function sqlDe(columna: keyof typeof SELECT_CONCILIACION_SOAT): Promise<string> {
  const { PgDialect } = await import('drizzle-orm/pg-core');
  return new PgDialect().sqlToQuery(SELECT_CONCILIACION_SOAT[columna]).sql;
}

/** El SQL de la cadena de joins COMPARTIDA del reporte, tal como sale hacia PostgreSQL. */
async function sqlDeConJoins(): Promise<string> {
  const { PgDialect, QueryBuilder } = await import('drizzle-orm/pg-core');
  const { flitoTramites } = await import('../../src/db/schema.js');
  const q = new QueryBuilder()
    .select({ id: flitoTramites.id })
    .from(flitoTramites)
    .$dynamic();
  const conJoined = conJoins(q as any);
  return new PgDialect().sqlToQuery(conJoined.getSQL()).sql.toLowerCase();
}

/**
 * El WHERE de una subconsulta compilada, partido en sus condiciones DE TOPE, más si a ese nivel
 * aparece algún `OR`.
 *
 * Existe porque `toContain('l.conciliada_en is not null')` **no distingue el predicado de su
 * neutralización**: `AND (l.conciliada_en IS NOT NULL OR TRUE)` contiene la frase entera y no
 * restringe nada, y eso devuelve el abanico de filas que esta historia existe para impedir.
 *
 * Con las dos piezas que devuelve esta función el predicado se afirma por IMPLICACIÓN LÓGICA y no
 * por presencia del texto: si el WHERE es una conjunción —sin ningún `OR` de tope, así que ningún
 * término puede anular a otro— y uno de sus términos ES, palabra por palabra, el predicado,
 * entonces el WHERE entero lo implica y ninguna fila con `conciliada_en` en NULL puede salir.
 * Envolverlo en un paréntesis, relajarlo con un `OR`, esconderlo dentro de otro término o borrarlo
 * rompe una de las dos condiciones.
 *
 * Es deliberadamente CONSERVADOR: una reescritura equivalente (`NOT (l.conciliada_en IS NULL)`)
 * también lo pondría rojo. Es el mismo criterio que el canario del conteo de joins de este archivo
 * — no prohíbe el cambio, obliga a pasar por aquí a justificarlo.
 *
 * Y sigue siendo una afirmación sobre el TEXTO del SQL, no sobre su ejecución: `apps/api/__tests__`
 * no tiene base, así que nada de esto demuestra que PostgreSQL use el índice ni reproduce el
 * abanico de verdad. Demuestra que la consulta que se le manda dice lo que tiene que decir, que es
 * lo máximo que se puede afirmar sin base y es exactamente lo que el `toContain` no afirmaba.
 */
function whereDeTope(sqlCompilado: string): { conjuntos: string[]; orDeTope: boolean } {
  const t = sqlCompilado.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t.startsWith('(') || !t.endsWith(')')) throw new Error(`no es una subconsulta: ${t}`);
  const cuerpo = t.slice(1, -1).trim();

  // Qué posiciones están fuera de TODO paréntesis y de toda comilla: es lo que separa el nivel de
  // tope del interior, y sin ello `(... OR TRUE)` se confundiría con un `OR` de tope.
  const tope = new Array<boolean>(cuerpo.length).fill(false);
  let prof = 0;
  let comilla: string | null = null;
  for (let i = 0; i < cuerpo.length; i++) {
    const c = cuerpo[i];
    if (comilla !== null) { if (c === comilla) comilla = null; continue; }
    if (c === "'" || c === '"') { comilla = c; continue; }
    if (c === '(') { prof++; continue; }
    if (c === ')') { prof--; continue; }
    tope[i] = prof === 0;
  }
  const enTope = (aguja: string, desde: number): number => {
    for (let i = desde; i <= cuerpo.length - aguja.length; i++) {
      if (tope[i] && cuerpo.startsWith(aguja, i)) return i;
    }
    return -1;
  };

  const iw = enTope(' where ', 0);
  if (iw < 0) throw new Error(`la subconsulta no tiene WHERE de tope: ${cuerpo}`);
  // Todo lo que puede venir DESPUÉS del WHERE y no forma parte de él. Si apareciera cualquiera, el
  // troceo pararía ahí en vez de tragárselo como si fuera una condición más.
  let fin = cuerpo.length;
  for (const cola of [' group by ', ' having ', ' window ', ' order by ', ' limit ', ' offset ', ' fetch ']) {
    const j = enTope(cola, iw);
    if (j > -1 && j < fin) fin = j;
  }

  const conjuntos: string[] = [];
  let orDeTope = false;
  let ini = iw + ' where '.length;
  for (let i = ini; i < fin; i++) {
    if (!tope[i]) continue;
    if (cuerpo.startsWith(' or ', i)) orDeTope = true;
    if (cuerpo.startsWith(' and ', i)) {
      conjuntos.push(cuerpo.slice(ini, i).trim());
      ini = i + ' and '.length;
      i = ini - 1;
    }
  }
  conjuntos.push(cuerpo.slice(ini, fin).trim());
  return { conjuntos, orDeTope };
}

/** Una fila cruda del reporte, como la devolvería PostgreSQL. Por defecto, SIN conciliar. */
function filaCruda(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tramiteId: 'aaaa1111-2222-4333-8444-555566667777', idFlit: 'FLIT-1',
    placa: 'ABC123', estado: 'Aprobado', empresa: 'ACME', tipoTramite: 'Traspaso',
    vin: 'VIN1', marca: 'RENAULT', linea: 'LOGAN',
    fechaAprobacion: new Date('2026-07-14T15:30:00.000Z'),
    fechaCreacion: new Date('2026-07-01T00:00:00.000Z'),
    sellada: false, estadoLiquidacion: null,
    soat: '450000.00', impuesto: null, derechoTramite: '80000.00',
    tramiteDigital: '200000.00', logistica: '15000.00', gmf: '2980.00', totalFila: '747980.00',
    soatPendiente: false, impuestoPendiente: false,
    gestionaSoat: true, gestionaImpuesto: false, gestionaLogistica: true,
    soatAutogestionable: false, impuestosAutogestionable: false, logisticaAutogestionable: false,
    estadoFacturacion: 'no_enviado', facturaDatos: null,
    boletaReferencia: null, boletaConciliadaEn: null,
    ...over,
  };
}

/** Lo que devuelven las dos columnas nuevas cuando el SOAT SÍ se concilió. */
const CONCILIADA = {
  boletaReferencia: 'BOL-000123',
  boletaConciliadaEn: new Date('2026-08-05T14:20:00.000Z'),
};

/** Las tres claves que ESTA historia añade a la fila. Todo lo demás es preexistente. */
const NUEVAS = ['soatConciliado', 'boletaReferencia', 'soatConciliadoEn'] as const;

/**
 * La fila del reporte que corresponde a `filaCruda()`, **escrita a mano**: la LÍNEA BASE del AC2.
 *
 * Está a mano a propósito. Hasta la HU #11769 el AC2 se comprobaba comparando `filaServida(sin)`
 * contra `filaServida(conciliada)`, y eso no es una línea base: los dos lados los produce el MISMO
 * código, sobre el MISMO fixture, en el MISMO commit, así que romper una columna preexistente
 * —`gmf` a `null` en `aFila`, por ejemplo— movía los dos lados a la vez y el test seguía en verde.
 * Comparar contra este literal es lo que hace que romper cualquier columna del reporte se vea.
 *
 * Cada valor sale de `filaCruda()` y de las reglas de `aFila`, no de copiar una salida:
 *   · los importes son los de la fila cruda, ya en número (`gmf` 2980, `total` 747980);
 *   · `noConfigurados`, `sinRecibo` y `pendientesPago` van vacíos porque la fila trae los tres
 *     conceptos con valor y ningún pendiente;
 *   · `autogestionados` va vacío porque las tres banderas `*Autogestionable` son `false`;
 *   · `noAplican` trae 'Impuesto' porque el organismo no lo entrega en gestión
 *     (`gestionaImpuesto: false`) y la compañía tampoco lo autogestiona.
 */
const FILA_BASE = {
  tramiteId: 'aaaa1111-2222-4333-8444-555566667777', idFlit: 'FLIT-1',
  placa: 'ABC123', estado: 'Aprobado', empresa: 'ACME', tipoTramite: 'Traspaso',
  vin: 'VIN1', marca: 'RENAULT', linea: 'LOGAN',
  fechaAprobacion: '2026-07-14T15:30:00.000Z',
  fechaCreacion: '2026-07-01T00:00:00.000Z',
  soat: 450000, impuesto: null, derechoTramite: 80000,
  logistica: 15000, tramiteDigital: 200000, gmf: 2980, total: 747980,
  sellada: false, estadoLiquidacion: null,
  noConfigurados: [], sinRecibo: [], pendientesPago: [], autogestionados: [],
  noAplican: ['Impuesto'],
  estadoFacturacion: 'no_enviado', facturaNumero: null, facturaRequiereRevision: false,
};

/** La fila servida sin las tres claves de esta historia: lo que el AC2 dice que no cambia. */
function salvoLasNuevas(fila: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fila).filter(([k]) => !(NUEVAS as readonly string[]).includes(k)));
}

const auth = async (role: TestRole) => `Bearer ${await testToken({ sub: 3, username: `${role}@flit.io`, role })}`;

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/finanzas/finanzas.routes.js');
  app.use('/api/finanzas', router);
  return app;
}

/** Consulta el reporte con UNA fila cruda registrada y devuelve la fila ya servida. */
async function filaServida(cruda: Record<string, unknown>, role: TestRole = 'financiera') {
  kdb.when.select('flito_tramites', [cruda]);
  const app = await buildApp();
  const r = await request(app).get(RUTA).set('Authorization', await auth(role));
  expect(r.status).toBe(200);
  return r.body.items[0] as Record<string, unknown>;
}

// ── AC1 ─────────────────────────────────────────────────────────────────────

describe('AC1 — la fila conciliada trae la boleta de la que salió el dinero', () => {
  it('llega la marca, el identificador de la boleta y la fecha', async () => {
    const fila = await filaServida(filaCruda(CONCILIADA));

    expect(fila.soatConciliado).toBe(true);
    expect(fila.boletaReferencia).toBe('BOL-000123');
    expect(fila.soatConciliadoEn).toBe('2026-08-05T14:20:00.000Z');
  });

  it('el valor de la columna SOAT no se toca', async () => {
    // La conciliación cuenta de dónde salió el dinero; NO redefine cuánto cuesta el trámite. Si la
    // marca cambiara el valor, el total del periodo se movería solo por haber cargado una boleta.
    const sin = await filaServida(filaCruda());
    kdb.reset();
    const con = await filaServida(filaCruda(CONCILIADA));

    expect(con.soat).toBe(sin.soat);
    expect(con.total).toBe(sin.total);
    expect(con.gmf).toBe(sin.gmf);
  });

  it('el identificador que sale es la referencia legible, no el uuid de la boleta', async () => {
    // `referencia` es única y es la que ve quien concilia; el uuid no le dice nada a nadie y la
    // póliza y la placa —lo único PII de la conciliación— no salen por aquí.
    const texto = await sqlDe('boletaReferencia');
    expect(texto).toContain('b.referencia');
    expect(texto).not.toContain('numero_poliza');
    expect(texto).not.toContain('l.id');
  });

  it('la fecha es la de la LÍNEA, que es la de ESE SOAT, no la de la boleta entera', async () => {
    const texto = await sqlDe('boletaConciliadaEn');
    expect(texto).toContain('l.conciliada_en');
    expect(texto).not.toContain('b.conciliada_en');
  });
});

// ── El nombre del archivo de la boleta NO sale por aquí ──────────────────────

describe('El nombre del archivo de la boleta no se expone (bloqueante de seguridad)', () => {
  // `archivo_nombre` es el `originalname` de multer: texto libre del cliente, solo recortado a 300.
  // Una boleta agrupa SOAT de muchos trámites, así que puede traer placa, nombre o NIT de un
  // tercero — y `auditor` lee este reporte pero recibe 403 en `/flito-conciliacion/*`, sin que este
  // módulo registre acceso PII. Estos dos tests son los que impiden que vuelva «para completar».

  it('la fila conciliada NO trae `boletaArchivoNombre`, ni siquiera si la consulta lo devolviera', async () => {
    const fila = await filaServida(filaCruda({
      ...CONCILIADA, boletaArchivoNombre: 'soat_JUAN_PEREZ_ABC123.xlsx',
    }));

    expect(fila.soatConciliado).toBe(true);
    expect(fila.boletaReferencia).toBe('BOL-000123');
    expect(fila).not.toHaveProperty('boletaArchivoNombre');
    // Y tampoco por otra clave: el nombre no aparece en NINGUNA parte de la fila servida.
    expect(JSON.stringify(fila)).not.toContain('JUAN_PEREZ');
  });

  it('ninguna columna del bloque compila `archivo_nombre`', async () => {
    const columnas = Object.keys(SELECT_CONCILIACION_SOAT) as (keyof typeof SELECT_CONCILIACION_SOAT)[];
    // Son estas dos y solo estas dos: añadir una tercera obliga a pasar por aquí a justificarla.
    expect(columnas).toEqual(['boletaReferencia', 'boletaConciliadaEn']);
    for (const t of await Promise.all(columnas.map(sqlDe))) {
      expect(t.toLowerCase()).not.toContain('archivo_nombre');
    }
  });
});

// ── AC2 ─────────────────────────────────────────────────────────────────────

describe('AC2 — la fila sin conciliar no cambia', () => {
  it('sin línea sellada la marca es false y la boleta llega en null', async () => {
    const fila = await filaServida(filaCruda());

    expect(fila.soatConciliado).toBe(false);
    expect(fila.boletaReferencia).toBeNull();
    expect(fila.soatConciliadoEn).toBeNull();
  });

  it('ninguna otra columna de la fila cambia: solo se AÑADEN las tres nuevas', async () => {
    // El AC2 es de no regresión, así que los dos lados se comparan contra `FILA_BASE`, que está
    // escrita a mano en este archivo, y NO uno contra el otro: comparar dos salidas del mismo
    // código sobre el mismo fixture no puede detectar que ese código se rompa (ver `FILA_BASE`).
    const sin = await filaServida(filaCruda());
    kdb.reset();
    const con = await filaServida(filaCruda(CONCILIADA));

    // Ni una columna preexistente cambia de valor, ni sobra ni falta ninguna: `toEqual` exige el
    // mismo juego de claves, así que una columna nueva colada de rondón también se ve.
    expect(salvoLasNuevas(sin)).toEqual(FILA_BASE);
    // Y conciliar el SOAT no mueve NADA fuera de su bloque: mismo literal, misma fila.
    expect(salvoLasNuevas(con)).toEqual(FILA_BASE);

    // Las tres nuevas están en las dos filas, conciliada o no: la columna existe siempre y lo que
    // cambia es su valor. Una clave que aparece solo a veces se lee como un dato que se perdió.
    for (const k of NUEVAS) {
      expect(Object.keys(sin)).toContain(k);
      expect(Object.keys(con)).toContain(k);
    }
  });

  it('una referencia vacía cuenta como ausencia, no como boleta sin nombre', async () => {
    const r = conciliacionDeFila({ boletaReferencia: '   ', boletaConciliadaEn: new Date() });
    expect(r.soatConciliado).toBe(false);
    expect(r.boletaReferencia).toBeNull();
    expect(r.soatConciliadoEn).toBeNull();
  });
});

// ── La trampa de la historia: el abanico de filas ────────────────────────────

describe('El join que no se hizo — por qué la fila no se multiplica', () => {
  it('`conJoins` NO toca las tablas de conciliación', async () => {
    // Esta es LA prueba del AC2 y del alcance. `conJoins` lo comparten siete consultas de dos
    // módulos: la página, el conteo `distinct`, los agregados de DINERO, las facetas, la
    // exportación y la elegibilidad de facturación de Siigo. Un join ahí pondría a esta historia a
    // responder por los totales del reporte y por qué se puede facturar ante la DIAN.
    const texto = await sqlDeConJoins();
    expect(texto).not.toContain('flito_conciliacion');
  });

  it('la cadena compartida sigue teniendo los mismos joins que antes de esta historia', async () => {
    // Canario deliberado: si alguien añade un join a la cadena compartida, este test se pone rojo y
    // obliga a demostrar que los otros seis llamadores siguen dando el mismo resultado. No es que
    // añadir un join esté prohibido; es que no puede hacerse de pasada.
    const texto = await sqlDeConJoins();
    expect((texto.match(/ inner join /g) ?? []).length).toBe(1);
    expect((texto.match(/ left join /g) ?? []).length).toBe(11);
  });

  it.each(['boletaReferencia', 'boletaConciliadaEn'] as const)(
    '%s es una subconsulta CORRELACIONADA por el SOAT del trámite', async (col) => {
      const texto = await sqlDe(col);
      // Correlacionada por `flito_tramites.soat_id`: devuelve un valor por fila del reporte, nunca
      // una fila más. Es la propiedad que hace imposible el abanico, y no una promesa del autor.
      expect(texto).toContain('"flito_tramites"."soat_id"');
      expect(texto.trim().startsWith('(')).toBe(true);
      expect(texto).toContain('flito_conciliacion_lineas');
    },
  );

  it.each(['boletaReferencia', 'boletaConciliadaEn'] as const)(
    '%s: el WHERE IMPLICA `conciliada_en IS NOT NULL`, no solo lo menciona', async (col) => {
      // SIN este predicado el índice único parcial `idx_flito_concil_linea_soat_unica` deja de
      // aplicar: una boleta descartada y su reemplazo conservan las dos líneas del mismo SOAT, la
      // subconsulta devuelve dos filas y PostgreSQL aborta la consulta. Y aun si devolviera una,
      // marcaría como cobrado un SOAT cuya boleta nunca movió dinero.
      //
      // Se afirma por implicación y no con `toContain`, que es lo que hacía este test hasta la HU
      // #11769: la frase también está —intacta— dentro de `AND (l.conciliada_en IS NOT NULL OR
      // TRUE)`, que no restringe NADA. Ver `whereDeTope` para el argumento completo.
      const { conjuntos, orDeTope } = whereDeTope(await sqlDe(col));

      // (1) El WHERE es una conjunción pura: sin un `OR` a este nivel ningún término anula a otro.
      expect(orDeTope).toBe(false);
      // (2) Y sus términos son EXACTAMENTE estos dos. Que el predicado sea un término ENTERO —y no
      //     que aparezca dentro de uno— es lo que hace que el WHERE completo lo implique. De paso
      //     ata la correlación por `soat_id`, que si se neutralizara igual devolvería el abanico.
      expect(conjuntos).toEqual([
        'l.soat_id = "flito_tramites"."soat_id"',
        'l.conciliada_en is not null',
      ]);
    },
  );

  describe('y el troceador que lo sostiene muerde de verdad', () => {
    // `whereDeTope` es código, y de él depende que el test de arriba discrimine. Si algún día se
    // rompiera, el bloque entero volvería a aparentar cobertura en silencio: estos son los WHERE
    // que TIENEN que caer, incluido el mutante exacto que sobrevivía al `toContain`.
    const ESPERADO = ['l.soat_id = "flito_tramites"."soat_id"', 'l.conciliada_en is not null'];
    const acepta = (where: string): boolean => {
      const { conjuntos, orDeTope } = whereDeTope(
        `(\n SELECT b.referencia\n FROM flito_conciliacion_lineas l\n WHERE ${where}\n)`);
      return !orDeTope && conjuntos.length === ESPERADO.length
        && conjuntos.every((c, i) => c === ESPERADO[i]);
    };
    const SOAT = 'l.soat_id = "flito_tramites"."soat_id"';

    const CASOS: [string, string, boolean][] = [
      ['el predicado tal cual pasa', `${SOAT} AND l.conciliada_en IS NOT NULL`, true],
      ['neutralizado dentro de un paréntesis cae', `${SOAT} AND (l.conciliada_en IS NOT NULL OR TRUE)`, false],
      ['relajado con un OR al final cae', `${SOAT} AND l.conciliada_en IS NOT NULL OR TRUE`, false],
      ['con TODO el WHERE bajo un OR cae', `TRUE OR (${SOAT} AND l.conciliada_en IS NOT NULL)`, false],
      ['borrado cae', SOAT, false],
      ['neutralizada la correlación cae', `(${SOAT} OR TRUE) AND l.conciliada_en IS NOT NULL`, false],
    ];

    it.each(CASOS)('%s', (_nombre, where, esperado) => {
      expect(acepta(where)).toBe(esperado);
    });
  });

  it.each(['boletaReferencia', 'boletaConciliadaEn'] as const)(
    '%s NO lleva LIMIT: si la unicidad se rompiera, tiene que doler', async (col) => {
      // Un `LIMIT 1` elegiría una boleta al azar y el reporte diría en silencio de cuál salió el
      // dinero cuando en realidad habría salido dos veces. En trazabilidad contable el fallo
      // ruidoso es el correcto.
      expect((await sqlDe(col)).toLowerCase()).not.toContain('limit');
    },
  );

  it('las dos columnas salen de la MISMA línea, palabra por palabra', async () => {
    // Dos subconsultas independientes serían dos definiciones de «qué línea cuenta». Una fila que
    // dice «BOL-000123» con la fecha de otra conciliación es peor que no decir nada.
    const cuerpo = (t: string) => t.slice(t.indexOf('FROM')).replace(/\s+/g, ' ').trim();
    const [a, b] = await Promise.all([
      sqlDe('boletaReferencia'), sqlDe('boletaConciliadaEn'),
    ]);
    expect(cuerpo(a)).toBe(cuerpo(b));
  });
});

// ── AC3 ─────────────────────────────────────────────────────────────────────

describe('AC3 — la marca convive con la fila sellada', () => {
  it('un trámite liquidado sigue sellado y con sus valores congelados, y además trae la boleta', async () => {
    const fila = await filaServida(filaCruda({
      ...CONCILIADA,
      sellada: true, estadoLiquidacion: 'liquidado',
      soat: '450000.00', totalFila: '747980.00',
    }));

    expect(fila.sellada).toBe(true);
    expect(fila.estadoLiquidacion).toBe('liquidado');
    expect(fila.soat).toBe(450000);
    expect(fila.total).toBe(747980);
    // Las dos cosas a la vez: sellar es «este cobro ya se congeló» y conciliar es «este pago ya
    // salió de la bolsa». No se excluyen, y la fila tiene que poder decir las dos.
    expect(fila.soatConciliado).toBe(true);
    expect(fila.boletaReferencia).toBe('BOL-000123');
  });

  it('una fila sellada sin conciliar sigue marcada como sellada y sin boleta', async () => {
    const fila = await filaServida(filaCruda({ sellada: true, estadoLiquidacion: 'facturado' }));
    expect(fila.sellada).toBe(true);
    expect(fila.soatConciliado).toBe(false);
    expect(fila.boletaReferencia).toBeNull();
  });
});

// ── AC4 ─────────────────────────────────────────────────────────────────────

describe('AC4 — el CSV distingue los dos casos y nombra la boleta', () => {
  /** Una fila del reporte tal como llega a `aCsv`. */
  function fila(over: Record<string, unknown> = {}): Parameters<typeof aCsv>[0][number] {
    return {
      tramiteId: 't1', idFlit: 'FLIT-1', placa: 'ABC123', estado: 'Aprobado', empresa: 'ACME',
      vin: 'VIN1', marca: 'RENAULT', linea: 'LOGAN', tipoTramite: 'Traspaso',
      fechaAprobacion: '2026-07-14T15:30:00.000Z', fechaCreacion: '2026-07-01T00:00:00.000Z',
      soat: 450000, impuesto: 120000, derechoTramite: 80000,
      logistica: 15000, tramiteDigital: 200000, gmf: 3460, total: 868460,
      sellada: true, estadoLiquidacion: 'liquidado',
      noConfigurados: [], sinRecibo: [], pendientesPago: [], autogestionados: [], noAplican: [],
      estadoFacturacion: 'no_enviado', facturaNumero: null, facturaRequiereRevision: false,
      soatConciliado: false, boletaReferencia: null, soatConciliadoEn: null,
      ...over,
    } as Parameters<typeof aCsv>[0][number];
  }

  it('hay una columna propia, y distingue conciliado de no conciliado nombrando la boleta', () => {
    const csv = aCsv([
      fila({ soatConciliado: true, boletaReferencia: 'BOL-000123' }),
      fila(),
    ]);
    const [cabecera, conciliada, sinConciliar] = csv.trim().split('\r\n');

    expect(cabecera.split(';')).toContain('SOAT conciliado');
    const i = cabecera.split(';').indexOf('SOAT conciliado');
    expect(conciliada.split(';')[i]).toBe('Sí (BOL-000123)');
    expect(sinConciliar.split(';')[i]).toBe('No');
  });

  it('la celda del no conciliado NO se deja vacía', () => {
    // Una celda vacía se lee igual que un dato que no se pudo calcular, y este CSV se usa para
    // decidir a quién se le cobra: «no consta» y «no está conciliado» no son lo mismo.
    const csv = aCsv([fila()]);
    const i = csv.split('\r\n')[0].split(';').indexOf('SOAT conciliado');
    expect(csv.split('\r\n')[1].split(';')[i]).not.toBe('');
  });

  it('la columna nueva va al final: ninguna de las anteriores se desplaza', () => {
    const cabeceras = aCsv([]).trim().split(';');
    expect(cabeceras[cabeceras.length - 1]).toBe('SOAT conciliado');
    expect(cabeceras[0]).toContain('Trámite');
    expect(cabeceras[6]).toBe('SOAT');
  });

  it('cada fila tiene tantas celdas como cabeceras', () => {
    const csv = aCsv([fila({ soatConciliado: true, boletaReferencia: 'BOL-000999' }), fila()]);
    const [cabecera, ...filas] = csv.trim().split('\r\n');
    for (const f of filas) expect(f.split(';')).toHaveLength(cabecera.split(';').length);
  });

  it('sin referencia —que la base impide— la celda sigue diciendo que está conciliado', () => {
    expect(celdaConciliacionCsv({
      soatConciliado: true, boletaReferencia: null, soatConciliadoEn: null,
    })).toBe('Sí');
  });
});

// ── AC5 ─────────────────────────────────────────────────────────────────────

describe('AC5 — sin permisos nuevos', () => {
  /** Ninguno de estos leía el reporte, y ninguno empieza a leerlo por esta historia. */
  const SIN_LECTURA: TestRole[] = [
    'proveedor', 'transito', 'compliance', 'lider_pesv',
    'supervisor_flota', 'conductor', 'gestor_impuestos', 'mensajero',
  ];

  it.each(['auditor', 'financiera', 'admin'] as TestRole[])(
    '%s ve la marca de conciliado igual que los demás', async (role) => {
      kdb.reset();
      const fila = await filaServida(filaCruda(CONCILIADA), role);
      expect(fila.soatConciliado).toBe(true);
      expect(fila.boletaReferencia).toBe('BOL-000123');
    },
  );

  it.each(SIN_LECTURA)('%s sigue recibiendo 403', async (role) => {
    const app = await buildApp();
    const r = await request(app).get(RUTA).set('Authorization', await auth(role));
    expect(r.status).toBe(403);
  });

  it('sin token sigue siendo 401', async () => {
    const app = await buildApp();
    expect((await request(app).get(RUTA)).status).toBe(401);
  });

  it('la ruta no estrena guarda propia: se reutiliza la de lectura del reporte', async () => {
    const { readFileSync } = await import('node:fs');
    const fuente = readFileSync(
      new URL('../../src/modules/finanzas/finanzas.routes.ts', import.meta.url), 'utf8');
    expect(fuente).toContain("requireRole('financiera', 'admin', 'auditor')");
    // Una segunda guarda sería una segunda verdad sobre quién puede mirar lo mismo.
    expect((fuente.match(/requireRole\(/g) ?? []).length).toBe(1);
  });
});
