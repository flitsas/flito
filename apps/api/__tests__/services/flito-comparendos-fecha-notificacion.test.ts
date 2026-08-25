// FLITO comparendos — la fecha de notificación canónica (HU #11794, Feature #11492 17a).
//
// Este archivo prueba la HU **contra el mapa v4 REAL**, leído del `.sql` de la migración 0164 y no
// de una lista escrita aquí. La diferencia no es de estilo y es lo que hace que el archivo muerda:
// toda la HU es inerte si `fechaNotificacion` no entra en el `field_map`, porque la lista blanca de
// la poda se DERIVA de los `source_path` de la versión vigente (RN-25) y el merge lee la versión
// MÁXIMA (RN-11). Con un mapa fabricado en el propio test, la columna se llenaría en las aserciones
// y seguiría vacía en producción.
//
// Lo que se demuestra, y el orden importa porque es el orden de la cadena:
//
//   1. **El mapa v4 la nombra en los dos orígenes** y es la versión que gana.
//   2. **Las TRES grafías medidas entran por el mismo camino** — `DD/MM/YYYY HH:MM:SS` (SIMIT),
//      `YYYY-MM-DD` (UTS Medellín) y `DD/MM/YYYY` **sin hora** (UTS Bogotá)—. La tercera es la que
//      se cae si alguien hace obligatoria la hora, y el fallo no se ve mirando a Medellín.
//   3. **El centinela `01/01/1900` no es una fecha** y no se persiste, ni en la columna nueva ni en
//      `fecha_comparendo`, que hasta esta HU lo guardaba tal cual.
//   4. **La poda la conserva** (RN-25), que es el eslabón que vuelve inerte a todo lo demás.
//   5. **SIMIT prevalece y el municipal solo rellena** (CF-08), probado donde SÍ discrepan.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { filasSembradas, rutaMigracion } from '../helpers/field-map-sql.js';
import {
  FECHA_NOTIFICACION, itemMunicipalNotificadoBogota, itemMunicipalNotificadoMedellin, itemSimit,
  itemSimitNotificado, numeroSimit,
} from '../fixtures/comparendos/payloads-fuente.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const {
  acumularMunicipal, acumularSimit, camposConservables, cargarMapaHomologacion, candidatosDe,
  homologar, podarPayload, resolverCampos, FECHA_CENTINELA_NO_NOTIFICADO,
} = await import('../../src/modules/flito-comparendos/flito-comparendos-merge.js');

// ─────────────────────────── El mapa v4, leído de la migración ──────────────────────────────────

// El extractor vive en `helpers/field-map-sql.ts` desde la HU #11877: era la misma función escrita
// aquí y en la paridad de la 0164, y dos copias del mismo parser son dos oportunidades de que una se
// quede atrás y su archivo pase por vacuidad.
const RUTA_0164 = rutaMigracion('0164_flito_comparendos_fecha_notificacion.sql');

const MAPA_V4 = filasSembradas(readFileSync(RUTA_0164, 'utf8'));

/**
 * Siembra el mock con el mapa v4 REAL **y con ruido de versiones viejas**.
 *
 * El ruido no es adorno: `cargarMapaHomologacion` se queda con la versión MÁXIMA (RN-11), y una fila
 * v1 que apunte `fechaNotificacion` a otro sitio tiene que quedarse fuera. Sin ella, el test pasaría
 * igual con una implementación que fusionara todas las versiones.
 */
const conMapaV4 = () => kdb.when.select('flito_comparendos_field_map', [
  { version: 1, origen: 'simit', sourcePath: 'fechaNotificacion', targetField: 'fechaComparendo', prioridad: 1, provisional: true },
  ...MAPA_V4,
]);

beforeEach(() => { kdb.reset(); });

// ─────────────────────────── 0. El instrumento lee algo ─────────────────────────────────────────

describe('el extractor lee de verdad la v4 de la migración 0164', () => {
  // Va primero: si el regex dejara de casar, TODO lo de abajo pasaría por vacuidad —el mapa quedaría
  // vacío, `cargarMapaHomologacion` lanzaría y los `expect(...).toBeNull()` de las fechas serían
  // ciertos por accidente.
  it('siembra 43 filas, todas `version = 4` y ninguna provisional', () => {
    expect(MAPA_V4).toHaveLength(43);
    expect(MAPA_V4.every((f) => f.version === 4)).toBe(true);
    expect(MAPA_V4.every((f) => f.provisional === false)).toBe(true);
  });
});

// ─────────────────────────── AC1 · El mapa v4 nombra el campo ───────────────────────────────────

describe('AC1 · `fechaNotificacion` es target canónico en la v4, en los DOS orígenes', () => {
  it('la versión que gana es la 4 y trae candidato para la notificación en ambos orígenes', async () => {
    conMapaV4();
    const mapa = await cargarMapaHomologacion();

    expect(mapa.version).toBe(4);
    expect(mapa.provisional).toBe(false);
    // El `source_path` es el mismo en los dos: las tres grafías llegan por la misma clave, así que
    // homologarlas es trabajo del parser y no de tres filas del mapa.
    expect(candidatosDe(mapa, 'simit').get('fechaNotificacion')).toEqual(['fechaNotificacion']);
    expect(candidatosDe(mapa, 'municipal').get('fechaNotificacion')).toEqual(['fechaNotificacion']);
  });

  it('**la fila v1 que apunta a otro canónico NO se hereda**: se lee la versión máxima (RN-11)', async () => {
    conMapaV4();
    const mapa = await cargarMapaHomologacion();

    // Si el cargador fusionara versiones, `fechaNotificacion` sería también candidato de
    // `fechaComparendo` y la fecha de notificación acabaría pintada en la columna de al lado.
    expect(candidatosDe(mapa, 'simit').get('fechaComparendo')).toEqual(['fechaComparendo', 'fechaImposicion']);
  });
});

// ─────────────────────────── AC1 · Las tres grafías ─────────────────────────────────────────────

describe('AC1 · las TRES grafías reales entran por el mismo camino', () => {
  const cargar = async () => { conMapaV4(); return cargarMapaHomologacion(); };

  it('SIMIT — `DD/MM/YYYY HH:MM:SS` → `YYYY-MM-DD`', async () => {
    const mapa = await cargar();
    const canonico = homologar(itemSimitNotificado(), candidatosDe(mapa, 'simit'));

    expect(canonico.fechaNotificacion).toBe(FECHA_NOTIFICACION.canonicoSimit);
    // Y la del comparendo sigue siendo la suya: las dos columnas no se cruzan.
    expect(canonico.fechaComparendo).toBe('2026-05-11');
  });

  it('UTS Medellín — ISO en la RAÍZ del ítem de `informacionComparendo`', async () => {
    const mapa = await cargar();
    const canonico = homologar(itemMunicipalNotificadoMedellin(), candidatosDe(mapa, 'municipal'));

    expect(canonico.fechaNotificacion).toBe(FECHA_NOTIFICACION.canonicoMedellin);
  });

  it('**UTS Bogotá — `DD/MM/YYYY` SIN HORA**: la hora es opcional o la ciudad entera sale vacía', async () => {
    // El caso que la HU exige explícitamente. Con `(?:[T ].*)?` convertido en obligatorio en la rama
    // con barras, esto es `null` y ningún test escrito contra Medellín (ISO) o contra SIMIT (que sí
    // manda hora) se entera.
    const mapa = await cargar();
    const canonico = homologar(itemMunicipalNotificadoBogota(), candidatosDe(mapa, 'municipal'));

    expect(canonico.fechaNotificacion).toBe(FECHA_NOTIFICACION.canonicoBogota);
  });

  it('la grafía con barras y con hora da lo MISMO que la grafía con barras y sin ella', async () => {
    // Dicho como propiedad y no como dos literales: es la afirmación «entran por el mismo camino».
    const mapa = await cargar();
    const candidatos = candidatosDe(mapa, 'municipal');
    const conHora = homologar({ numeroComparendo: 'X1', fechaNotificacion: '14/05/2026 09:31:07' }, candidatos);
    const sinHora = homologar({ numeroComparendo: 'X1', fechaNotificacion: '14/05/2026' }, candidatos);

    expect(sinHora.fechaNotificacion).toBe(conHora.fechaNotificacion);
    expect(sinHora.fechaNotificacion).toBe('2026-05-14');
  });

  it('lo que no se entiende sigue siendo `null`: no se inventa una fecha para llenar la columna', async () => {
    const mapa = await cargar();
    const candidatos = candidatosDe(mapa, 'simit');
    for (const basura of ['pendiente', '31/02/2026', '2026-13-01', '', '14/05/26']) {
      expect(
        homologar({ numeroComparendo: 'X1', fechaNotificacion: basura }, candidatos).fechaNotificacion,
        `«${basura}» no debería producir fecha`,
      ).toBeNull();
    }
  });
});

// ─────────────────────────── AC2 · El centinela ─────────────────────────────────────────────────

describe('AC2 · `01/01/1900` es «no notificado», no una fecha', () => {
  const cargar = async () => { conMapaV4(); return cargarMapaHomologacion(); };

  it('**el ítem real de SIMIT trae el centinela y la columna queda en `null`**', async () => {
    // `itemSimit()` lleva `fechaNotificacion: '01/01/1900 00:00:00'` desde la HU #11501: es el motivo
    // por el que la v3 NO mapeaba el campo. Ahora se mapea y el centinela se descarta.
    const mapa = await cargar();
    const canonico = homologar(itemSimit(), candidatosDe(mapa, 'simit'));

    expect(canonico.fechaNotificacion).toBeNull();
    // Y no es que no se haya leído: el campo está en el ítem y en la lista blanca.
    expect(itemSimit().fechaNotificacion).toBe(FECHA_NOTIFICACION.centinela);
  });

  it('las CUATRO escrituras del mismo centinela caen por igual', async () => {
    const mapa = await cargar();
    const candidatos = candidatosDe(mapa, 'simit');
    for (const centinela of ['01/01/1900 00:00:00', '01/01/1900', '1900-01-01', '01-01-1900']) {
      expect(
        homologar({ numeroComparendo: 'X1', fechaNotificacion: centinela }, candidatos).fechaNotificacion,
        `«${centinela}» debería descartarse`,
      ).toBeNull();
    }
  });

  it('**y se ESTRENA para `fechaComparendo`, que hoy lo guardaba**: `1900-01-01` pasa a `null`', async () => {
    // ESTA es la aserción que cambia comportamiento vivo. Antes de esta HU el mismo ítem homologaba
    // `fechaComparendo: '1900-01-01'` y se persistía tal cual.
    const mapa = await cargar();
    const candidatos = candidatosDe(mapa, 'simit');

    expect(homologar({ numeroComparendo: 'X1', fechaComparendo: '01/01/1900 00:00:00' }, candidatos)
      .fechaComparendo).toBeNull();
    expect(homologar({ numeroComparendo: 'X1', fechaComparendo: '01/01/1900' }, candidatos)
      .fechaComparendo).toBeNull();
  });

  it('el ítem SIN el campo también queda en `null`, y no en otra cosa', async () => {
    const mapa = await cargar();
    const { fechaNotificacion: _sin, ...sinCampo } = itemSimitNotificado();

    expect(homologar(sinCampo, candidatosDe(mapa, 'simit')).fechaNotificacion).toBeNull();
  });

  it('**el alcance es de UN día, no de un rango**: el 2 de enero de 1900 SÍ es una fecha', async () => {
    // La regla ancha —«cualquier cosa de 1900 es centinela»— se tragaría fechas legítimas, y ese
    // error sí sería irreversible. No hay ni un byte medido que respalde un rango.
    const mapa = await cargar();
    const candidatos = candidatosDe(mapa, 'simit');

    expect(homologar({ numeroComparendo: 'X1', fechaNotificacion: '02/01/1900' }, candidatos)
      .fechaNotificacion).toBe('1900-01-02');
    expect(homologar({ numeroComparendo: 'X1', fechaNotificacion: '01/01/1901' }, candidatos)
      .fechaNotificacion).toBe('1901-01-01');
    expect(homologar({ numeroComparendo: 'X1', fechaNotificacion: '01/02/1900' }, candidatos)
      .fechaNotificacion).toBe('1900-02-01');
  });

  it('el literal del centinela es UNO solo y se exporta: el `.sql` y el código no pueden separarse', () => {
    expect(FECHA_CENTINELA_NO_NOTIFICADO).toBe('1900-01-01');
    // La migración lo declara en los COMMENT de las dos columnas de fecha. Si alguien cambiara el
    // literal del código, esto diría que la base sigue prometiendo otra cosa.
    const sql = readFileSync(RUTA_0164, 'utf8');
    expect(sql).toContain('01/01/1900');
  });

  it('**el sync CORRIGE la fila que ya guardaba `1900-01-01`**, aunque la fuente calle hoy', async () => {
    // Es la mitad de «no hay backfill: se corrigen en el siguiente sync» que no sale gratis. El
    // centinela llega y `homologar` lo vuelve `null`, así que los dos primeros escalones se quedan
    // mudos y el `??` caería en el valor guardado: la fila se re-escribiría con el defecto para
    // siempre y, como la migración tampoco hace backfill, no lo corregiría NADIE. Por eso el tercer
    // escalón no puede devolver el centinela.
    const mapa = await cargar();
    const acumulador = new Map();
    acumularSimit(acumulador, [{ numeroComparendo: 'C-1' }], candidatosDe(mapa, 'simit'));

    const campos = resolverCampos(acumulador.get('C-1')!, { fechaComparendo: '1900-01-01' });

    expect(campos.fechaComparendo).toBeNull();
  });

  it('…y también cuando la fuente vuelve a mandar el centinela', async () => {
    const mapa = await cargar();
    const acumulador = new Map();
    acumularSimit(
      acumulador,
      [{ numeroComparendo: 'C-1', fechaComparendo: '01/01/1900 00:00:00', fechaNotificacion: '01/01/1900' }],
      candidatosDe(mapa, 'simit'),
    );

    const campos = resolverCampos(
      acumulador.get('C-1')!,
      { fechaComparendo: '1900-01-01', fechaNotificacion: '1900-01-01' },
    );

    expect(campos.fechaComparendo).toBeNull();
    expect(campos.fechaNotificacion).toBeNull();
  });

  it('**una fecha guardada que NO es el centinela sí se conserva** (RN-13 sigue intacta)', async () => {
    // El corte es de UN valor y no del escalón entero: si el tercer escalón dejara de mirar, una
    // corrida en la que el proveedor calle borraría la fecha buena de la fila.
    const mapa = await cargar();
    const acumulador = new Map();
    acumularSimit(acumulador, [{ numeroComparendo: 'C-1' }], candidatosDe(mapa, 'simit'));

    const campos = resolverCampos(
      acumulador.get('C-1')!,
      { fechaComparendo: '2026-05-11', fechaNotificacion: '1900-01-02' },
    );

    expect(campos.fechaComparendo).toBe('2026-05-11');
    // Y el 2 de enero de 1900 no es el centinela: se conserva igual que cualquier otra fecha.
    expect(campos.fechaNotificacion).toBe('1900-01-02');
  });
});

// ─────────────────────────── AC1 · CF-08, donde SÍ discrepan ────────────────────────────────────

describe('AC1 · SIMIT prevalece; el municipal solo si SIMIT no trae fecha usable (CF-08)', () => {
  const cargar = async () => { conMapaV4(); return cargarMapaHomologacion(); };

  /** El mismo comparendo visto por las dos fuentes, cada una con su fecha de notificación. */
  async function consolidar(fechaSimit: unknown, fechaMunicipal: unknown) {
    const mapa = await cargar();
    const numero = numeroSimit(0);
    const acumulador = new Map();
    acumularSimit(
      acumulador,
      [{ ...itemSimit(0), fechaNotificacion: fechaSimit }],
      candidatosDe(mapa, 'simit'),
    );
    acumularMunicipal(
      acumulador,
      [{ ...itemMunicipalNotificadoMedellin(), numeroComparendo: numero, fechaNotificacion: fechaMunicipal }],
      candidatosDe(mapa, 'municipal'),
      'MEDELLIN',
    );
    return resolverCampos(acumulador.get(numero)!, null);
  }

  it('**discrepan y gana SIMIT**: el contraste medido coincidía, así que aquí se fuerza que no', async () => {
    // En la muestra del NIT 901789698 las dos fuentes dicen `30/07/2026` para el mismo comparendo, y
    // con datos que coinciden la precedencia no se puede observar: pasaría igual con el orden
    // invertido. Por eso el caso se construye con fechas DISTINTAS.
    const campos = await consolidar('14/05/2026 00:00:00', '2026-07-30');

    expect(campos.fechaNotificacion).toBe('2026-05-14');
  });

  it('SIMIT no la trae → **el municipal SÍ rellena el hueco**', async () => {
    const campos = await consolidar(undefined, '2026-07-30');

    expect(campos.fechaNotificacion).toBe('2026-07-30');
  });

  it('**SIMIT la trae con el CENTINELA → eso no es «fecha usable»** y habla el municipal', async () => {
    // La lectura literal del AC: «municipal solo si SIMIT no trae fecha usable». Un centinela llega,
    // ocupa el campo y no es usable; como el merge lo convierte en `null` ANTES de arbitrar, el
    // escalón siguiente funciona sin regla nueva. Con el centinela persistido, esto sería
    // `1900-01-01` y el dato bueno del municipio se perdería.
    const campos = await consolidar(FECHA_NOTIFICACION.centinela, '2026-07-30');

    expect(campos.fechaNotificacion).toBe('2026-07-30');
  });

  it('ninguna la trae hoy pero la fila ya la tenía → se conserva (RN-13, tercer escalón)', async () => {
    const mapa = await cargar();
    const acumulador = new Map();
    acumularSimit(acumulador, [{ numeroComparendo: 'C-1' }], candidatosDe(mapa, 'simit'));

    const campos = resolverCampos(acumulador.get('C-1')!, { fechaNotificacion: '2026-03-26' });

    expect(campos.fechaNotificacion).toBe('2026-03-26');
  });
});

// ─────────────────────────── RN-25 · La cadena que vuelve inerte a todo ─────────────────────────

describe('RN-25 · la poda deriva del mapa, así que la v4 también decide qué se conserva crudo', () => {
  it('**`fechaNotificacion` entra en la lista blanca porque está en el mapa**, no por una lista aparte', async () => {
    conMapaV4();
    const mapa = await cargarMapaHomologacion();

    for (const origen of ['simit', 'municipal'] as const) {
      expect(camposConservables(candidatosDe(mapa, origen)).has('fechaNotificacion'), origen).toBe(true);
    }
  });

  it('y el valor CRUDO sobrevive en el payload podado, con su grafía original', async () => {
    // Es lo que hace reversible la decisión: si mañana se descubre que la grafía importaba, el dato
    // sigue ahí. Y es el eslabón que la HU marca como el que la vuelve inerte si falta — sin la fila
    // en la v4, la poda tiraría el campo aunque los tipos compilaran.
    conMapaV4();
    const mapa = await cargarMapaHomologacion();
    const permitidos = camposConservables(candidatosDe(mapa, 'municipal'));

    const podado = podarPayload(itemMunicipalNotificadoBogota(), permitidos)!;

    expect(podado.fechaNotificacion).toBe(FECHA_NOTIFICACION.bogota);
    // Y la poda sigue tirando lo de siempre: la lista blanca creció por una hoja escalar, no por un
    // subárbol (Ley 1581, RN-25).
    expect(podado.nombres).toBeUndefined();
    expect(podado.identificador).toBeUndefined();
    expect((podado.estadoCuenta as Record<string, unknown>).direccion).toBeUndefined();
  });

  it('**el centinela también se conserva CRUDO**: podar y homologar son dos preguntas distintas', async () => {
    // La columna queda en `null` y el payload guarda `01/01/1900 00:00:00`. No es una contradicción:
    // el payload es la materia prima del spike #11501 y ahí «el proveedor mandó el centinela» es
    // información, mientras que en la columna sería una fecha falsa.
    conMapaV4();
    const mapa = await cargarMapaHomologacion();
    const permitidos = camposConservables(candidatosDe(mapa, 'simit'));

    const podado = podarPayload(itemSimit(), permitidos)!;

    expect(podado.fechaNotificacion).toBe(FECHA_NOTIFICACION.centinela);
    expect(homologar(itemSimit(), candidatosDe(mapa, 'simit')).fechaNotificacion).toBeNull();
  });
});
