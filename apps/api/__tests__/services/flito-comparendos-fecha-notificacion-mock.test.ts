// FLITO comparendos — la fecha de notificación EN EL MODO SIMULADO (HU #11877, Feature #11492 17a).
//
// ── Qué defecto cierra este archivo ──────────────────────────────────────────────────────────────
//
// El mapeo de `fechaNotificacion` estaba bien desde la HU #11794 —la v4 la nombra en los dos
// orígenes, `fechaCanonica` entiende las tres grafías y descarta el centinela, `resolverCampos` la
// arbitra y `escribirRegistros` la escribe en el INSERT y en el UPDATE—, y aun así la funcionalidad
// **no era comprobable**: `COMPARENDOS_SIMIT_MODE` vale `mock` POR DEFECTO (`config/env.ts`) y
// NINGUNO de los dos payloads simulados traía el campo. En el modo que de verdad se ejecuta hoy —el
// módulo está apagado en todos los ambientes— la columna salía vacía **por construcción**.
//
// Las dos consecuencias, que son distintas y las dos malas:
//
//   1. Quien mirara la pantalla en mock veía la columna vacía y no podía distinguir «el mapeo está
//      roto» de «el mock no manda el dato». Ese fue literalmente el síntoma reportado.
//   2. Ninguna prueba que pasara por el camino del mock podía detectar una regresión del mapeo,
//      porque por ahí no circulaba ni una fecha.
//
// ── Qué NO está aquí, para que nadie lo busque dos veces ─────────────────────────────────────────
//
// Las grafías, el centinela, la precedencia SIMIT → municipal y la poda RN-25 se prueban contra el
// `.sql` de la 0164 en `flito-comparendos-fecha-notificacion.test.ts` (HU #11794). Este archivo NO
// las repite: añade las dos cosas que aquel no puede afirmar.
//
//   · **El payload simulado publica la fecha**, con la grafía de cada fuente y con el centinela
//     presente, de modo que el modo por defecto ejercita las dos ramas.
//   · **La fila vive en el mapa VIGENTE de la cadena entera de migraciones**, no solo en la 0164. Un
//     test que lea un archivo elegido a mano seguiría verde el día que una v5 se olvide del campo.
//
// La base NO se toca: el mapa se lee de los `.sql` (helper `field-map-sql.ts`) y se le sirve al
// módulo por el mock de `db/client`. La red tampoco: `integraciones/http.js` está mockeado con una
// función que LANZA, así que si algún día el modo simulado dejara de cortocircuitar, estos tests se
// caen en vez de salir a internet.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { mapaVigenteSembrado, todasLasFilasSembradas } from '../helpers/field-map-sql.js';
import {
  FECHA_NOTIFICACION, itemMunicipalNotificadoMedellin,
} from '../fixtures/comparendos/payloads-fuente.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

/** La frontera con la red. En `mock` no se cruza, y aquí se afirma con un error y no con confianza. */
const salirAInternet = () => { throw new Error('el modo simulado NO puede tocar la red'); };
vi.mock('../../src/modules/integraciones/http.js', () => ({
  httpsJson: salirAInternet,
  httpsGetJson: salirAInternet,
  httpsFormPost: salirAInternet,
}));

const loggerFalso = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => loggerFalso,
};
vi.mock('../../src/shared/logger.js', () => ({ logger: loggerFalso, loggerFor: () => loggerFalso }));

const {
  acumularMunicipal, acumularSimit, camposConservables, cargarMapaHomologacion, candidatosDe,
  homologar, podarPayload, resolverCampos,
} = await import('../../src/modules/flito-comparendos/flito-comparendos-merge.js');
const { consultarComparendosSimit } =
  await import('../../src/modules/flito-comparendos/clients/verifik-simit.client.js');
const { consultarComparendosMunicipales } =
  await import('../../src/modules/flito-comparendos/clients/uts-municipal.client.js');
const { env } = await import('../../src/config/env.js');

const NIT = '900123456';
const MUNICIPIO = 'MEDELLIN';

/** Lo que el mock de cada fuente publica hoy. Un literal por grafía, nombrado. */
const ESPERADO = {
  /** SIMIT, `DD/MM/YYYY HH:MM:SS`, en el ítem que solo tiene SIMIT. */
  simitCrudo: '20/05/2026 00:00:00',
  simitCanonico: '2026-05-20',
  /** El centinela de SIMIT, con hora, en el comparendo COMPARTIDO. */
  simitCentinela: '01/01/1900 00:00:00',
  /** UTS, ISO en la raíz, en el comparendo COMPARTIDO. */
  municipalCrudo: '2026-06-10',
  municipalCanonico: '2026-06-10',
  /** El centinela del UTS, SIN hora, en el comparendo que solo existe en el municipio. */
  municipalCentinela: '01/01/1900',
} as const;

/**
 * Siembra el mock de `db` con TODAS las versiones del mapa, tal y como está la tabla de verdad.
 *
 * No solo con la v4: `field_map` es acumulativa y `cargarMapaHomologacion` se queda con la máxima
 * (RN-11). Sembrar solo la vigente escondería una implementación que fusionara versiones.
 */
const conMapaDeLaCadena = () =>
  kdb.when.select('flito_comparendos_field_map', todasLasFilasSembradas());

const cargar = async () => { conMapaDeLaCadena(); return cargarMapaHomologacion(); };

beforeEach(() => { kdb.reset(); });

// ─────────────────────────── 0. Las premisas del archivo ────────────────────────────────────────

describe('las premisas de este archivo se cumplen', () => {
  it('**el modo por defecto es `mock`**: es el camino que de verdad se ejecuta', () => {
    // Si esto dejara de ser cierto, la HU entera cambia de sentido —y el resto del archivo estaría
    // midiendo un camino secundario—. `setup.ts` no provisiona la variable a propósito.
    expect(process.env.COMPARENDOS_SIMIT_MODE).toBeUndefined();
    expect(env.COMPARENDOS_SIMIT_MODE).toBe('mock');
  });

  it('el extractor lee la cadena de migraciones y la versión vigente es la 4', () => {
    // Guardarraíl: si el regex dejara de casar, el mapa saldría vacío y las aserciones de abajo
    // pasarían por vacuidad (`cargarMapaHomologacion` lanzaría, sí, pero los `toBeNull()` de las
    // fechas serían ciertos por accidente en cuanto alguien los moviera de sitio).
    const vigente = mapaVigenteSembrado();

    expect(vigente.version).toBe(4);
    expect(vigente.filas).toHaveLength(43);
    expect(vigente.archivos).toEqual(['0164_flito_comparendos_fecha_notificacion.sql']);
    // Y la tabla completa tiene más que la vigente: v1 + v2 + v3 + v4.
    expect(todasLasFilasSembradas().length).toBeGreaterThan(vigente.filas.length);
  });
});

// ─────────────────────────── AC4 · La fila está en el mapa VIGENTE ──────────────────────────────

describe('AC4 · `fechaNotificacion` es del mapa VIGENTE, no de un archivo elegido a mano', () => {
  it('**la versión máxima de la cadena la nombra en los DOS orígenes, en prioridad 1**', () => {
    // Este es el test que se pone rojo si mañana una migración nueva siembra una v5 sin el campo:
    // el módulo leería esa v5 (RN-11, no hereda), la poda tiraría el campo (RN-25) y la columna se
    // vaciaría en producción sin que nada más avisara. Leer solo la 0164 no lo vería.
    const { version, filas, archivos } = mapaVigenteSembrado();

    for (const origen of ['simit', 'municipal'] as const) {
      const suyas = filas.filter((f) => f.origen === origen && f.targetField === 'fechaNotificacion');
      expect(
        suyas.map((f) => `${f.sourcePath}@${f.prioridad}`),
        `la v${version} (${archivos.join(', ')}) no mapea fechaNotificacion en ${origen}`,
      ).toEqual(['fechaNotificacion@1']);
    }
  });

  it('el mapa que el módulo CARGA de esa siembra trae el candidato en los dos orígenes', async () => {
    // La otra mitad: que lo sembrado sobreviva a `cargarMapaHomologacion` —el filtro por
    // `CAMPOS_CANONICOS` descarta en silencio lo que no reconoce, así que una fila presente en el
    // `.sql` puede no llegar a candidato—.
    const mapa = await cargar();

    expect(mapa.version).toBe(mapaVigenteSembrado().version);
    expect(candidatosDe(mapa, 'simit').get('fechaNotificacion')).toEqual(['fechaNotificacion']);
    expect(candidatosDe(mapa, 'municipal').get('fechaNotificacion')).toEqual(['fechaNotificacion']);
  });

  it('**y con ese mapa la respuesta real de Medellín se homologa a su fecha** (AC1)', async () => {
    // El ítem tiene la FORMA real del `informacionComparendo` del UTS —`fechaNotificacion` en la
    // RAÍZ, el organismo colgando de `estadoCuenta.secretaria`, `nroResolucion`, `descripcionEstado`—
    // con todos los VALORES fabricados (ver la cabecera de la fixture: nada real entra a git).
    const mapa = await cargar();

    const canonico = homologar(itemMunicipalNotificadoMedellin(), candidatosDe(mapa, 'municipal'));

    expect(canonico.fechaNotificacion).toBe(FECHA_NOTIFICACION.canonicoMedellin);
    // Y no por casualidad: el resto del ítem se homologa, así que el `null` de un campo hablaría del
    // campo y no de un ítem que no se entendió entero.
    expect(canonico.numeroComparendo).not.toBeNull();
    expect(canonico.fechaComparendo).toBe('2026-07-19');
  });
});

// ─────────────────────────── AC3 · El payload simulado publica la fecha ─────────────────────────

describe('AC3 · el modo simulado manda `fechaNotificacion`, con la grafía de cada fuente', () => {
  it('**Verifik SIMIT**: el 0001 notificado en `DD/MM/YYYY HH:MM:SS` y el 0002 con el centinela', async () => {
    const r = await consultarComparendosSimit(NIT);

    expect(r.modo).toBe('mock');
    // La grafía importa tanto como el valor: un mock en ISO ejercitaría una rama del parser que esta
    // fuente no usa, y la de Verifik —la que trae hora— se quedaría sin recorrer en el modo por
    // defecto.
    expect(r.items[0].fechaNotificacion).toBe(ESPERADO.simitCrudo);
    expect(r.items[1].fechaNotificacion).toBe(ESPERADO.simitCentinela);
  });

  it('**UTS municipal**: el compartido en ISO y en la RAÍZ, y el 0003 con el centinela SIN hora', async () => {
    const r = await consultarComparendosMunicipales(NIT, MUNICIPIO);

    expect(r.modo).toBe('mock');
    // En la RAÍZ del ítem, que es donde el mapa v4 la nombra. Dentro de `estadoCuenta` el mock se
    // homologaría a `null` por una razón distinta de la que se quiere ejercitar.
    expect(r.items[0].fechaNotificacion).toBe(ESPERADO.municipalCrudo);
    expect(r.items[1].fechaNotificacion).toBe(ESPERADO.municipalCentinela);
    // Las dos escrituras del centinela quedan cubiertas por el mock: con hora en SIMIT, sin ella
    // aquí. Es la diferencia que la 0164 midió entre los dos proveedores.
    expect(ESPERADO.municipalCentinela).not.toBe(ESPERADO.simitCentinela);
  });

  it('**homologados con el mapa vigente: al menos uno con fecha y al menos uno en `null`**', async () => {
    // El AC dicho tal cual, y por las DOS fuentes: el modo simulado tiene que ejercer el camino feliz
    // y la rama de descarte del centinela. Con el mock anterior —sin el campo— la lista de fechas era
    // `[null, null]` en las dos fuentes y este test no habría podido escribirse.
    const mapa = await cargar();

    const simit = await consultarComparendosSimit(NIT);
    const municipal = await consultarComparendosMunicipales(NIT, MUNICIPIO);

    const fechasSimit = simit.items
      .map((i) => homologar(i as Record<string, unknown>, candidatosDe(mapa, 'simit')).fechaNotificacion);
    const fechasMunicipal = municipal.items
      .map((i) => homologar(i as Record<string, unknown>, candidatosDe(mapa, 'municipal')).fechaNotificacion);

    expect(fechasSimit).toEqual([ESPERADO.simitCanonico, null]);
    expect(fechasMunicipal).toEqual([ESPERADO.municipalCanonico, null]);

    for (const [origen, fechas] of [['simit', fechasSimit], ['municipal', fechasMunicipal]] as const) {
      expect(fechas.filter((f) => f !== null).length, `${origen} sin ninguna fecha`).toBeGreaterThan(0);
      expect(fechas.filter((f) => f === null).length, `${origen} sin ningún centinela`).toBeGreaterThan(0);
    }
  });

  it('el mock sigue siendo determinista: la fecha no depende de cuándo se corra', async () => {
    // Nada de «hoy»: en mock corren la suite y las demos, y una fecha que cambia entre ejecuciones
    // convierte cualquier prueba del merge en intermitente.
    const a = await consultarComparendosSimit(NIT);
    const b = await consultarComparendosSimit(NIT);
    const m1 = await consultarComparendosMunicipales(NIT, MUNICIPIO);
    const m2 = await consultarComparendosMunicipales(NIT, MUNICIPIO);

    expect(b.items).toEqual(a.items);
    expect(m2.items).toEqual(m1.items);
  });

  it('la notificación simulada NUNCA es anterior al comparendo: el mock es un dato razonable', async () => {
    const mapa = await cargar();
    const simit = await consultarComparendosSimit(NIT);
    const municipal = await consultarComparendosMunicipales(NIT, MUNICIPIO);

    const pares = [
      ...simit.items.map((i) => homologar(i as Record<string, unknown>, candidatosDe(mapa, 'simit'))),
      ...municipal.items.map((i) => homologar(i as Record<string, unknown>, candidatosDe(mapa, 'municipal'))),
    ];

    for (const c of pares) {
      if (c.fechaNotificacion === null || c.fechaComparendo === null) continue;
      // Comparación de cadenas `YYYY-MM-DD`, que en ISO ordena igual que la fecha.
      expect(c.fechaNotificacion >= c.fechaComparendo, `${c.numeroComparendo}`).toBe(true);
    }
  });
});

// ─────────────────────────── AC3 · De punta a punta, sin salir de `mock` ────────────────────────

describe('AC3 · el merge del modo simulado resuelve la fecha como en una corrida real', () => {
  /** Consolida las dos respuestas simuladas exactamente como lo hace el sync. */
  async function consolidarElMock() {
    const mapa = await cargar();
    const simit = await consultarComparendosSimit(NIT);
    const municipal = await consultarComparendosMunicipales(NIT, MUNICIPIO);

    const acumulador = new Map();
    acumularSimit(acumulador, simit.items as Record<string, unknown>[], candidatosDe(mapa, 'simit'));
    acumularMunicipal(
      acumulador, municipal.items as Record<string, unknown>[], candidatosDe(mapa, 'municipal'), MUNICIPIO,
    );
    return acumulador;
  }

  it('**el comparendo COMPARTIDO: SIMIT manda el centinela y el municipio rellena** (CF-08, RN-13)', async () => {
    // El escalón que hasta ahora ninguna corrida simulada podía ejercer. SIMIT trae `01/01/1900`,
    // `homologar` lo vuelve `null` —no es «fecha usable»— y el segundo escalón toma la del municipio.
    // Si el centinela se persistiera, aquí saldría `1900-01-01` y el dato bueno se perdería.
    const acumulador = await consolidarElMock();
    const compartido = acumulador.get(`MOCK-COMPARTIDO-${NIT}-0002`)!;

    expect(compartido.simit!.fechaNotificacion).toBeNull();
    expect(compartido.municipal!.fechaNotificacion).toBe(ESPERADO.municipalCanonico);
    expect(resolverCampos(compartido, null).fechaNotificacion).toBe(ESPERADO.municipalCanonico);
  });

  it('el que solo ve SIMIT conserva su fecha, y el que solo ve el municipio se queda en `null`', async () => {
    const acumulador = await consolidarElMock();

    expect(resolverCampos(acumulador.get(`MOCK-SIMIT-${NIT}-0001`)!, null).fechaNotificacion)
      .toBe(ESPERADO.simitCanonico);
    // Centinela del UTS: la columna queda vacía porque el comparendo NO se ha notificado, que es
    // justo lo que el proveedor está diciendo.
    expect(resolverCampos(acumulador.get(`MOCK-${MUNICIPIO}-${NIT}-0003`)!, null).fechaNotificacion)
      .toBeNull();
  });

  it('**y el crudo del mock sobrevive a la poda** (RN-25), centinela incluido', async () => {
    // La poda deriva su lista blanca del mapa vigente, así que esto también se vaciaría si la fila
    // desapareciera. Y el centinela SÍ se conserva crudo: en el payload «el proveedor dijo que no
    // hay notificación» es información; en la columna sería una fecha falsa.
    const mapa = await cargar();
    const municipal = await consultarComparendosMunicipales(NIT, MUNICIPIO);
    const permitidos = camposConservables(candidatosDe(mapa, 'municipal'));

    const podados = municipal.items
      .map((i) => podarPayload(i as Record<string, unknown>, permitidos)!);

    expect(podados[0].fechaNotificacion).toBe(ESPERADO.municipalCrudo);
    expect(podados[1].fechaNotificacion).toBe(ESPERADO.municipalCentinela);
  });
});
