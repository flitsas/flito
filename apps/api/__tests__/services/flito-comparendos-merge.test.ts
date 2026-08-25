// FLITO comparendos — homologación y merge (HU #11500, Feature #11492 17a).
//
// La mitad pura del sync: convertir el vocabulario de cada proveedor en el canónico y decidir qué
// valor gana. Se prueba aquí, aparte del sync, porque son funciones sin red ni transacciones y
// porque son las que el spike #11501 va a mover — un fallo de merge tiene que salir en un test que
// no dependa de la orquestación.
//
// Lo que se demuestra, por orden de importancia:
//
//   1. **SIMIT gana y el municipal solo rellena huecos** (CF-08). Es la regla que el Feature nombra
//      explícitamente y la que un refactor puede invertir sin que nada más se rompa.
//   2. **Lo que ya estaba no se borra.** Un campo que ninguna fuente reportó hoy conserva su valor:
//      dejar de recibir un dato no es recibir que está vacío.
//   3. **El mapa vacío falla en vez de devolver un canónico sin número.** Con `null` en el número, el
//      sync leería «cero comparendos» y la inactivación apagaría el histórico entero.
//   4. **Ni un `__proto__` del proveedor contamina nada** (RN-14): los ítems vienen de `JSON.parse` y
//      `types.ts` los declara con firma de índice.

import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';
import { createKeyedDb } from '../helpers/keyed-db.js';
import {
  FABRICADO, itemMunicipal, itemMunicipalDeSimit, itemMunicipalMulta, itemSimit, itemSimitMulta,
  numeroSimit,
} from '../fixtures/comparendos/payloads-fuente.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const {
  acumularMunicipal,
  acumularSimit,
  cargarMapaHomologacion,
  candidatosDe,
  formaNumero,
  homologar,
  numeroCanonico,
  origenMerge,
  resolverCampos,
  tipoDeRegistro,
} = await import('../../src/modules/flito-comparendos/flito-comparendos-merge.js');
const { ComparendosMapaHomologacionVacioError } =
  await import('../../src/modules/flito-comparendos/flito-comparendos.errors.js');

/**
 * El tercer parámetro de `resolverCampos` (HU #11878), con el municipio que estos casos ya usaban.
 *
 * Coincide a propósito con el `municipioFuente: 'BELLO'` del `consolidado` de más abajo: en el
 * servicio los dos salen de la MISMA const, así que un fixture donde discreparan estaría probando
 * una combinación que el código no puede producir. Lo que este archivo ejercita del municipio es
 * solo que el escalón 1 devuelve el consultado; la deducción por organismo y la regla de ambigüedad
 * viven en `flito-comparendos-municipio-resuelto.test.ts`.
 */
const CTX_MUNICIPIO = {
  municipioFuente: 'BELLO' as string | null,
  catalogoMunicipios: ['BELLO', 'MEDELLIN', 'ITAGUI'] as readonly string[],
};

type FilaMapa = {
  version: number; origen: string; sourcePath: string; targetField: string;
  prioridad: number; provisional: boolean;
};

const fila = (
  version: number, origen: string, sourcePath: string, targetField: string,
  prioridad = 1, provisional = true,
): FilaMapa => ({ version, origen, sourcePath, targetField, prioridad, provisional });

/**
 * Recorte del mapa v1 que siembra la migración 0150, **ya ordenado por prioridad** — que es como lo
 * devuelve la consulta real (`ORDER BY prioridad, source_path`).
 */
const MAPA_V1: FilaMapa[] = [
  fila(1, 'simit', 'numeroComparendo', 'numeroComparendo', 1),
  fila(1, 'simit', 'placa', 'placa', 1),
  fila(1, 'simit', 'codigoInfraccion', 'codigoInfraccion', 1),
  fila(1, 'simit', 'descripcionInfraccion', 'descripcionInfraccion', 1),
  fila(1, 'simit', 'fechaComparendo', 'fechaComparendo', 1),
  fila(1, 'simit', 'secretariaNombre', 'organismo', 1),
  fila(1, 'simit', 'valorAPagar', 'monto', 1),
  fila(1, 'simit', 'estado', 'estadoFuente', 1),
  fila(1, 'simit', 'comparendo', 'numeroComparendo', 2),
  fila(1, 'simit', 'fechaImposicion', 'fechaComparendo', 2),
  fila(1, 'simit', 'organismoTransito', 'organismo', 2),
  fila(1, 'simit', 'valor', 'monto', 2),
  fila(1, 'municipal', 'numero', 'numeroComparendo', 1),
  fila(1, 'municipal', 'placa', 'placa', 1),
  fila(1, 'municipal', 'codigo', 'codigoInfraccion', 1),
  fila(1, 'municipal', 'descripcion', 'descripcionInfraccion', 1),
  fila(1, 'municipal', 'fecha', 'fechaComparendo', 1),
  fila(1, 'municipal', 'organismo', 'organismo', 1),
  fila(1, 'municipal', 'valor', 'monto', 1),
  fila(1, 'municipal', 'estado', 'estadoFuente', 1),
];

const conMapa = (filas: FilaMapa[]) => kdb.when.select('flito_comparendos_field_map', filas);

beforeEach(() => { kdb.reset(); });

// ─────────────────────────── Carga del mapa (RN-11, RN-12) ──────────────────────────────────────

describe('mapa de homologación — se lee de la tabla, no del código', () => {
  it('usa la versión MÁXIMA e ignora las anteriores', async () => {
    conMapa([
      ...MAPA_V1,
      // v2: el proveedor renombró el campo. La v1 sigue en la tabla como histórico.
      fila(2, 'simit', 'nroComparendo', 'numeroComparendo', 1, false),
      fila(2, 'simit', 'placaVehiculo', 'placa', 1, false),
    ]);

    const mapa = await cargarMapaHomologacion();

    expect(mapa.version).toBe(2);
    // `provisional` sale de la versión vigente: la v1 era provisional, la v2 no.
    expect(mapa.provisional).toBe(false);
    expect(candidatosDe(mapa, 'simit').get('numeroComparendo')).toEqual(['nroComparendo']);
    // Sin candidatos v2 para el estado, el campo simplemente no se homologa: NO se cae a la v1.
    expect(candidatosDe(mapa, 'simit').get('estadoFuente')).toBeUndefined();
  });

  it('respeta la columna `prioridad`: menor gana entre candidatos del mismo campo', async () => {
    conMapa(MAPA_V1);

    const mapa = await cargarMapaHomologacion();
    const simit = candidatosDe(mapa, 'simit');

    expect(simit.get('numeroComparendo')).toEqual(['numeroComparendo', 'comparendo']);
    expect(simit.get('monto')).toEqual(['valorAPagar', 'valor']);

    // Y se aplica de verdad: con los dos campos presentes, gana el de prioridad 1.
    const canonico = homologar({ numeroComparendo: 'A-1', comparendo: 'B-2' }, simit);
    expect(canonico.numeroComparendo).toBe('A-1');
  });

  it('la tabla vacía es un ERROR, no un mapa sin candidatos (RN-12)', async () => {
    conMapa([]);

    // Devolver un mapa vacío haría que todo ítem se homologara a un canónico sin número, que la
    // corrida leyera «cero comparendos» para cada NIT y que la inactivación apagara el histórico
    // completo. Mismo razonamiento que `ComparendosFuenteRespuestaIlegibleError`.
    await expect(cargarMapaHomologacion()).rejects.toBeInstanceOf(ComparendosMapaHomologacionVacioError);
  });

  it('un mapa sin candidato para el NÚMERO también falla: es tan inservible como el vacío', async () => {
    conMapa([fila(1, 'simit', 'placa', 'placa', 1)]);

    await expect(cargarMapaHomologacion()).rejects.toBeInstanceOf(ComparendosMapaHomologacionVacioError);
  });

  it('ignora `target_field` que no sea un campo canónico (RN-14)', async () => {
    conMapa([
      ...MAPA_V1,
      // `target_field` es texto libre en la base. Sin la lista cerrada, una fila decidiría el nombre
      // de una propiedad que este módulo escribe.
      fila(1, 'simit', 'algo', '__proto__', 1),
      fila(1, 'simit', 'otro', 'campoQueNoExiste', 1),
    ]);

    const mapa = await cargarMapaHomologacion();

    expect([...candidatosDe(mapa, 'simit').keys()]).not.toContain('__proto__');
    expect([...candidatosDe(mapa, 'simit').keys()]).not.toContain('campoQueNoExiste');
    expect(({} as Record<string, unknown>).algo).toBeUndefined();
  });

  it('ignora orígenes desconocidos en vez de mezclarlos con los dos buenos', async () => {
    conMapa([...MAPA_V1, fila(1, 'runt', 'numero', 'numeroComparendo', 1)]);

    const mapa = await cargarMapaHomologacion();

    expect(candidatosDe(mapa, 'simit').get('numeroComparendo')).toEqual(['numeroComparendo', 'comparendo']);
    expect(candidatosDe(mapa, 'municipal').get('numeroComparendo')).toEqual(['numero']);
  });
});

// ─────────────────────────── Homologación de un ítem ────────────────────────────────────────────

describe('homologar — el vocabulario del proveedor pasa al canónico', () => {
  let simit: ReturnType<typeof candidatosDe>;
  let municipal: ReturnType<typeof candidatosDe>;

  beforeEach(async () => {
    conMapa(MAPA_V1);
    const mapa = await cargarMapaHomologacion();
    simit = candidatosDe(mapa, 'simit');
    municipal = candidatosDe(mapa, 'municipal');
  });

  it('mapea la respuesta de Verifik del mock de la HU #11499', () => {
    const canonico = homologar({
      numeroComparendo: '05001000000012345678',
      placa: 'MOK123',
      codigoInfraccion: 'C29',
      descripcionInfraccion: 'Estacionar un vehículo en sitio prohibido',
      fechaComparendo: '2026-05-14',
      secretariaNombre: 'Secretaría de Movilidad de Medellín',
      valorAPagar: '604100',
      estado: 'Pendiente de pago',
    }, simit);

    expect(canonico).toEqual({
      numeroComparendo: '05001000000012345678',
      placa: 'MOK123',
      codigoInfraccion: 'C29',
      descripcionInfraccion: 'Estacionar un vehículo en sitio prohibido',
      fechaComparendo: '2026-05-14',
      organismo: 'Secretaría de Movilidad de Medellín',
      monto: '604100.00',
      estadoFuente: 'Pendiente de pago',
      // Ídem con `fechaNotificacion`, cuyo candidato lo siembra la v4 (HU #11794).
      fechaNotificacion: null,
      // El mapa v1 de esta tabla no tiene candidatos de resolución (los siembra la v3, HU #11712):
      // sin candidato, el campo se homologa a `null`. La aserción se deja EXHAUSTIVA a propósito —un
      // `toMatchObject` dejaría de mirar los campos nuevos justo cuando alguien los mapee mal.
      numeroResolucion: null,
      idResolucion: null,
    });
  });

  it('mapea el vocabulario municipal, que es otro para lo mismo', () => {
    const canonico = homologar({
      numero: '05001000000012345678',
      placa: 'mok-123',
      codigo: 'D02',
      descripcion: 'Conducir sin portar la licencia de tránsito',
      fecha: '02/06/2026',
      organismo: 'Secretaría de Movilidad de Bello',
      valor: 1160500,
      estado: 'Notificado',
    }, municipal);

    expect(canonico.numeroComparendo).toBe('05001000000012345678');
    // La placa se normaliza: `mok-123` y `MOK123` son el mismo vehículo, y sin esto el filtro por
    // placa de la HU #11502 no encontraría nada.
    expect(canonico.placa).toBe('MOK123');
    expect(canonico.fechaComparendo).toBe('2026-06-02');
    expect(canonico.monto).toBe('1160500.00');
  });

  it.each([
    ['ISO', '2026-05-14', '2026-05-14'],
    ['ISO con hora', '2026-05-14T08:30:00.000Z', '2026-05-14'],
    ['DD/MM/YYYY', '14/05/2026', '2026-05-14'],
    ['D-M-YYYY', '4-5-2026', '2026-05-04'],
    ['día que no existe', '31/02/2026', null],
    ['texto', 'no hay fecha', null],
    ['mes fuera de rango', '2026-13-01', null],
  ])('fecha %s → %s', (_caso, entrada, esperado) => {
    // Se parsea con regex y no con `new Date(...)`: el constructor lee '2026-05-14' como medianoche
    // UTC y en un servidor en America/Bogota (UTC-5) devolvería el día anterior.
    expect(homologar({ numeroComparendo: 'X', fechaComparendo: entrada }, simit).fechaComparendo)
      .toBe(esperado);
  });

  it.each([
    ['entero como número', 604100, '604100.00'],
    ['entero como texto', '604100', '604100.00'],
    ['miles a la colombiana', '604.100', '604100.00'],
    ['miles y decimales', '$ 1.160.500,00', '1160500.00'],
    ['decimales con punto', '1160500.50', '1160500.50'],
    ['coma decimal sola', '1160500,75', '1160500.75'],
    ['con símbolo y espacios', ' COP 232.100 ', '232100.00'],
    ['sin dígitos', 'N/A', null],
    ['fuera del rango de numeric(14,2)', '99999999999999', null],
  ])('monto %s → %s', (_caso, entrada, esperado) => {
    expect(homologar({ numeroComparendo: 'X', valorAPagar: entrada }, simit).monto).toBe(esperado);
  });

  it('descarta el ítem cuyo número no cabe en la columna en vez de recortarlo', () => {
    // Recortar la llave inventaría un comparendo que no existe y podría fundir dos deudas distintas
    // que compartan prefijo en una sola fila.
    const canonico = homologar({ numeroComparendo: '9'.repeat(61) }, simit);
    expect(canonico.numeroComparendo).toBeNull();
  });

  it('recorta los campos descriptivos al ancho de su columna en vez de tumbar el INSERT', () => {
    const canonico = homologar({
      numeroComparendo: 'X-1',
      secretariaNombre: 'S'.repeat(200),
    }, simit);

    // Un `22001` de PostgreSQL a mitad de corrida se llevaría por delante el NIT entero y, con él,
    // la cobertura que autoriza su inactivación.
    expect(canonico.organismo).toHaveLength(120);
  });

  it('el campo vacío no le gana al siguiente candidato', () => {
    const canonico = homologar({ numeroComparendo: '   ', comparendo: 'B-2' }, simit);
    expect(canonico.numeroComparendo).toBe('B-2');
  });

  it('un objeto donde se esperaba un valor NO se guarda como "[object Object]"', () => {
    const canonico = homologar({ numeroComparendo: 'X-1', secretariaNombre: { nombre: 'X' } }, simit);
    expect(canonico.organismo).toBeNull();
  });

  it('un `__proto__` propio del proveedor no contamina Object.prototype (RN-14)', () => {
    // Así es exactamente como llega: `JSON.parse` sí crea `__proto__` como propiedad PROPIA, y el
    // ítem acaba en `payload_simit`. Un `Object.assign` sobre él sería contaminación de prototipo.
    const envenenado = JSON.parse('{"numeroComparendo":"X-1","__proto__":{"contaminado":true}}');

    const canonico = homologar(envenenado, simit);

    expect(canonico.numeroComparendo).toBe('X-1');
    expect(({} as Record<string, unknown>).contaminado).toBeUndefined();
  });

  it('no lee del PROTOTIPO cuando el `source_path` nombra un miembro heredado', async () => {
    conMapa([
      fila(1, 'simit', 'numeroComparendo', 'numeroComparendo', 1),
      fila(1, 'simit', 'constructor', 'organismo', 1),
    ]);
    const otro = candidatosDe(await cargarMapaHomologacion(), 'simit');

    // Sin `hasOwnProperty`, esto devolvería la función `Object` y acabaría convertida a texto en una
    // columna del canónico.
    expect(homologar({ numeroComparendo: 'X-1' }, otro).organismo).toBeNull();
  });
});

// ─────────────────────────── Acumulación por NIT ────────────────────────────────────────────────

describe('acumular — una entrada por número de comparendo', () => {
  let simit: ReturnType<typeof candidatosDe>;
  let municipal: ReturnType<typeof candidatosDe>;

  beforeEach(async () => {
    conMapa(MAPA_V1);
    const mapa = await cargarMapaHomologacion();
    simit = candidatosDe(mapa, 'simit');
    municipal = candidatosDe(mapa, 'municipal');
  });

  it('el mismo número visto por las dos fuentes es UNA entrada con las dos versiones', () => {
    const acumulador = new Map();

    acumularSimit(acumulador, [{ numeroComparendo: 'C-1', valorAPagar: '100' }], simit);
    acumularMunicipal(acumulador, [{ numero: 'C-1', descripcion: 'Del municipio' }], municipal, 'BELLO');

    expect(acumulador.size).toBe(1);
    const entrada = acumulador.get('C-1')!;
    expect(entrada.simit?.monto).toBe('100.00');
    expect(entrada.municipal?.descripcionInfraccion).toBe('Del municipio');
    expect(entrada.municipioFuente).toBe('BELLO');
  });

  it('cuenta los ítems sin número reconocible en vez de tragárselos', () => {
    const acumulador = new Map();

    // Es la pista que el spike #11501 necesita: si el proveedor cambia el nombre del campo, esto
    // sube y el resumen de la corrida lo enseña.
    const { ignorados } = acumularSimit(acumulador, [
      { numeroComparendo: 'C-1' },
      { otroCampo: 'sin número' },
      { numeroComparendo: '' },
    ], simit);

    expect(ignorados).toBe(2);
    expect(acumulador.size).toBe(1);
  });

  it('un número repetido dentro de la misma respuesta no se duplica ni se pisa', () => {
    const acumulador = new Map();

    acumularSimit(acumulador, [
      { numeroComparendo: 'C-1', estado: 'Primero' },
      { numeroComparendo: 'C-1', estado: 'Segundo' },
    ], simit);

    expect(acumulador.size).toBe(1);
    expect(acumulador.get('C-1')!.simit?.estadoFuente).toBe('Primero');
  });

  // ── Normalización del número (ADR-0003 decisión 6, cerrada por el spike #11501) ──────────────
  //
  // `numeroCanonico` se exporta desde la HU #11806 (el filtro `q` de `GET /registros` tiene que
  // normalizar igual que se normalizó lo guardado) y su tabla de casos vive en su propio `describe`,
  // más abajo. Aquí se prueba por donde de verdad importa: la LLAVE del acumulador. Es lo que decide
  // si dos avisos son una deuda o dos, y hasta este bloque ningún test del repo lo cubría — los
  // casos de arriba usan `'C-1'` idéntico en las dos fuentes, que pasaría igual con la normalización
  // desactivada.

  it('**el mismo comparendo con espacios y minúsculas es UNA sola entrada**, no dos deudas', () => {
    const acumulador = new Map();

    // Lo que cambia entre las dos fuentes es solo la forma de escribirlo. Si la normalización se
    // relajara a un `trim` —la regla PROVISIONAL que el ADR describía antes del spike—, los espacios
    // INTERNOS de `'C - 1'` sobrevivirían, la llave sería otra y el mismo comparendo se cobraría dos
    // veces. Ojo al límite real: se quitan los espacios, no los separadores. `'C 1'` NO es `'C-1'`
    // (normaliza a `'C1'`), y así debe ser: fundirlos exigiría adivinar qué separador quiso el
    // proveedor.
    acumularSimit(acumulador, [{ numeroComparendo: '  c-1  ', valorAPagar: '100' }], simit);
    acumularMunicipal(acumulador, [{ numero: 'C - 1', descripcion: 'Del municipio' }], municipal, 'BELLO');

    expect(acumulador.size).toBe(1);
    const entrada = acumulador.get('C-1')!;
    expect(entrada.simit?.monto).toBe('100.00');
    expect(entrada.municipal?.descripcionInfraccion).toBe('Del municipio');
  });

  it('la llave guardada es la NORMALIZADA, no la que mandó el primero en llegar', () => {
    const acumulador = new Map();

    // Guardar `' c-1 '` tal cual dejaría el filtro por número de `GET /registros` sin encontrar una
    // fila que existe: ese filtro busca con `like` contra el valor ya normalizado (ADR-0003 dec. 6).
    acumularSimit(acumulador, [{ numeroComparendo: ' c-1 ' }], simit);

    expect([...acumulador.keys()]).toEqual(['C-1']);
    expect(acumulador.get('C-1')!.simit?.numeroComparendo).toBe('C-1');
  });

  it('**un número que no cabe en varchar(60) se descarta entero; NO se recorta**', () => {
    const acumulador = new Map();

    // Recortar la llave inventaría un comparendo que no existe y, peor, dos números largos que
    // compartan los primeros 60 caracteres se fundirían en una sola fila — dos deudas distintas
    // convertidas en una. Por eso el ítem se ignora y el descarte se CUENTA.
    const { ignorados } = acumularSimit(acumulador, [
      { numeroComparendo: 'X'.repeat(61) },
      { numeroComparendo: 'Y'.repeat(60) },
    ], simit);

    expect(ignorados).toBe(1);
    expect([...acumulador.keys()]).toEqual(['Y'.repeat(60)]);
  });

  it('si dos municipios traen el mismo comparendo, se conserva el primero', () => {
    const acumulador = new Map();

    acumularMunicipal(acumulador, [{ numero: 'C-1', estado: 'De Bello' }], municipal, 'BELLO');
    acumularMunicipal(acumulador, [{ numero: 'C-1', estado: 'De Itagüí' }], municipal, 'ITAGUI');

    // Con el pool de paralelismo el orden de respuesta no está garantizado; quedarse con el último
    // haría bailar `municipio_fuente` entre corridas sin que nada hubiera cambiado en la realidad.
    expect(acumulador.get('C-1')!.municipioFuente).toBe('BELLO');
  });
});

// ─────────────────────────── La clave de negocio entre fuentes (HU #11806) ──────────────────────
//
// Lo que se demuestra aquí, y el orden NO es casual: primero que la regla fusiona (AC1), y
// enseguida las cuatro formas sobre las que **no** puede disparar (AC2 y AC3). Un archivo que solo
// probara la fusión dejaría pasar la regla peligrosa —`slice(-20)` o `^[A-Z]*[0-9]+$`—, que pondría
// AC1 igual de verde y fundiría dos deudas distintas el día que un municipio numere con 21 dígitos.
//
// El argumento de por qué la regla es segura está en el docblock de `numeroCanonico` y es CF-07: el
// número lo asigna el Estado y veinte dígitos con la DIVIPOLA delante ya son la identidad completa.
// Estos tests vigilan que el ALCANCE de la regla siga siendo el que ese argumento justifica, ni un
// carácter más.

describe('numeroCanonico — la forma nacional de 20 dígitos (HU #11806)', () => {
  it('**las dos grafías del MISMO comparendo dan la MISMA clave** (AC1)', () => {
    // La pareja real medida: SIMIT manda los veinte dígitos y el portal municipal los mismos veinte
    // con la letra delante. Si esto se rompe, la deuda se cuenta dos veces.
    expect(numeroCanonico('D05001000000054652201')).toBe('05001000000054652201');
    expect(numeroCanonico('05001000000054652201')).toBe('05001000000054652201');
    expect(numeroCanonico(`D${numeroSimit(0)}`)).toBe(numeroSimit(0));
  });

  it('**Bogotá ya llega canónica y sale INTACTA**: la regla no dispara sobre 20 dígitos pelados (AC2)', () => {
    // `11001` es la DIVIPOLA de Bogotá. No hay nada que quitar y no se quita nada — y en particular
    // esto NO es «quítale la primera letra a todo», que se lo llevaría por delante si algún día
    // llegara con una.
    const bogota = '11001000000012345678';
    expect(numeroCanonico(bogota)).toBe(bogota);
    expect(numeroCanonico(bogota)).toHaveLength(20);
  });

  it('**`D` + 19 y `D` + 21 NO disparan** — la regla es de longitud EXACTA (AC3)', () => {
    // El test que impide que alguien «mejore» la regla a `^[A-Z]*[0-9]+$` o le quite el `{20}`. Un
    // municipio que numere con 19 o 21 dígitos no está emitiendo el número único nacional, así que
    // quitarle la letra fabricaría una clave que no es de nadie — y podría chocar con la de otro.
    expect(numeroCanonico('D9999900000012345678')).toBe('D9999900000012345678');
    expect(numeroCanonico('D999990000001234567890')).toBe('D999990000001234567890');
  });

  it('**tres letras tampoco**, y un prefijo con separador se queda entero (AC3)', () => {
    // `{1,2}` es lo medido; tres letras es otra cosa de la que no hay muestra. Y `D-05001…` lleva un
    // separador: adivinar separadores es exactamente lo que ADR-0003 §6 cierra.
    expect(numeroCanonico('ABC99999000000099999901')).toBe('ABC99999000000099999901');
    expect(numeroCanonico('D-9999900000009999990')).toBe('D-9999900000009999990');
  });

  it('**no recorta NUNCA**: 28 dígitos salen los 28, no los últimos 20 (AC3)', () => {
    // La mutación `s.slice(-20)` sin el anclaje pondría AC1 en verde e inventaría aquí un comparendo
    // que no existe, fundiendo esta deuda con cualquier otra que comparta el final.
    const largo = 'ABCDE12345678901234567890123';
    expect(numeroCanonico(largo)).toBe(largo);
    expect(numeroCanonico('9'.repeat(28))).toBe('9'.repeat(28));
  });

  it('**dos números de 20 que difieren en el primer dígito son DOS claves** (AC3)', () => {
    // Medellín y Bogotá comparten longitud y difieren en la DIVIPOLA. La regla no toca dígitos, así
    // que no hay forma de que estos dos colapsen.
    const medellin = '05001000000054652201';
    const bogota = '11001000000054652201';
    expect(numeroCanonico(medellin)).not.toBe(numeroCanonico(bogota));
  });

  it('lo de siempre sigue igual: mayúsculas, sin espacios internos, y >60 se descarta', () => {
    // La regla nueva se aplica DESPUÉS de la normalización de siempre, no en su lugar.
    expect(numeroCanonico('  d 05001 000000054652201  ')).toBe('05001000000054652201');
    expect(numeroCanonico(' c-1 ')).toBe('C-1');
    expect(numeroCanonico('X'.repeat(61))).toBeNull();
    expect(numeroCanonico('')).toBeNull();
    expect(numeroCanonico(null)).toBeNull();
    expect(numeroCanonico({ numero: '05001000000054652201' })).toBeNull();
  });

  it('es idempotente: normalizar lo ya normalizado no vuelve a quitar nada', () => {
    // Importa porque `condicionesDeFiltro` la aplica sobre una entrada que puede venir de cualquier
    // sitio, y porque la migración 0163 puede correrse dos veces.
    const una = numeroCanonico('D05001000000054652201')!;
    expect(numeroCanonico(una)).toBe(una);
  });
});

describe('acumular — las dos grafías del mismo comparendo son UNA fila (HU #11806, AC1)', () => {
  let simit: ReturnType<typeof candidatosDe>;
  let municipal: ReturnType<typeof candidatosDe>;

  beforeEach(async () => {
    conMapa(MAPA_V3);
    const mapa = await cargarMapaHomologacion();
    simit = candidatosDe(mapa, 'simit');
    municipal = candidatosDe(mapa, 'municipal');
  });

  it('**SIMIT y el municipio traen el MISMO comparendo y sale UNA entrada**, no dos deudas', () => {
    const acumulador = new Map();

    // `itemMunicipalDeSimit(0)` compone su número como `'D' + numeroSimit(0)`: es la MISMA deuda que
    // `itemSimit(0)`, no dos números parecidos. Antes de esta HU la fixture municipal usaba un
    // número propio y por eso la suite entera pasaba en verde con el defecto vivo.
    acumularSimit(acumulador, [itemSimit(0)], simit);
    acumularMunicipal(acumulador, [itemMunicipalDeSimit(0)], municipal, 'MEDELLIN');

    expect([...acumulador.keys()]).toEqual([numeroSimit(0)]);
    const entrada = acumulador.get(numeroSimit(0))!;
    expect(entrada.simit).not.toBeNull();
    expect(entrada.municipal).not.toBeNull();
    expect(entrada.municipioFuente).toBe('MEDELLIN');
  });

  it('y da igual QUIÉN llegue primero: la llave no depende del orden de las fuentes', () => {
    // El pool (RN-17) no garantiza el orden de respuesta. Una llave que cambiara según quién habló
    // primero sería un duplicado con otro nombre: `numero_comparendo` es el único de la tabla y la
    // llave del upsert.
    const municipalPrimero = new Map();
    acumularMunicipal(municipalPrimero, [itemMunicipalDeSimit(0)], municipal, 'MEDELLIN');
    acumularSimit(municipalPrimero, [itemSimit(0)], simit);

    expect([...municipalPrimero.keys()]).toEqual([numeroSimit(0)]);
    expect(municipalPrimero.get(numeroSimit(0))!.simit).not.toBeNull();
  });

  it('**la grafía cruda `D…` sobrevive en el payload**: la decisión es REVERSIBLE', () => {
    // Si algún día se descubre que la letra era identidad, se quita la regla y el municipal vuelve a
    // crear su fila en el siguiente sync, con el número crudo todavía en el JSONB (RN-25 lo
    // conserva porque `numeroComparendo` es `source_path` de la v3).
    const acumulador = new Map();
    acumularMunicipal(acumulador, [itemMunicipalDeSimit(0)], municipal, 'MEDELLIN');

    const payload = acumulador.get(numeroSimit(0))!.payloadMunicipal as Record<string, unknown>;
    expect(payload.numeroComparendo).toBe(`D${numeroSimit(0)}`);
  });

  it('dos comparendos DISTINTOS del mismo municipio siguen siendo dos entradas', () => {
    // El guardarraíl del test de arriba: si la regla fusionara de más, esto caería.
    const acumulador = new Map();
    acumularMunicipal(
      acumulador, [itemMunicipalDeSimit(0), itemMunicipalDeSimit(1)], municipal, 'MEDELLIN',
    );

    expect([...acumulador.keys()].sort()).toEqual([numeroSimit(0), numeroSimit(1)].sort());
  });
});

describe('formaNumero — el histograma que trae la muestra que falta (HU #11806)', () => {
  it('emite la FORMA y **nunca el número**', () => {
    // Es la propiedad de privacidad, y se afirma como tal: ni un dígito del número en el token.
    const numero = '05001000000054652201';
    expect(formaNumero(numero)).toBe('D20');
    expect(formaNumero(numero)).not.toContain('5465');
    expect(formaNumero(`D${numero}`)).toBe('L1D20');
    expect(formaNumero(`AB${numero}`)).toBe('L2D20');
  });

  it('distingue las longitudes, que es justo lo que la regla no puede adivinar', () => {
    expect(formaNumero('D9999900000012345678')).toBe('L1D19');
    expect(formaNumero('D999990000001234567890')).toBe('L1D21');
  });

  it('lo que no es «letras + dígitos» es `OTRO`, y los bordes tienen su propio token', () => {
    // `OTRO` es deliberadamente grueso: si un municipio empieza a mandar separadores, se verá como
    // un `OTRO` que sube y alguien irá a mirar. Poner el valor en el token para «ayudar» sería
    // publicar el número en el log.
    expect(formaNumero('D-05001000000054652201')).toBe('OTRO');
    expect(formaNumero('05001-2026')).toBe('OTRO');
    expect(formaNumero('123ABC')).toBe('OTRO');
    expect(formaNumero('X'.repeat(61))).toBe('LARGO');
    expect(formaNumero('')).toBe('VACIO');
    expect(formaNumero(undefined)).toBe('AUSENTE');
    expect(formaNumero({ n: 1 })).toBe('AUSENTE');
  });

  it('**mide la forma CRUDA, no la normalizada**: el acumulador cuenta el prefijo que llegó', async () => {
    // Si se midiera después de aplicar la regla, `L1D20` no aparecería jamás y el histograma no
    // serviría para lo único que se hizo: saber qué emite cada municipio.
    conMapa(MAPA_V3);
    const mapa = await cargarMapaHomologacion();

    const { formas } = acumularMunicipal(
      new Map(), [itemMunicipalDeSimit(0)], candidatosDe(mapa, 'municipal'), 'MEDELLIN',
    );

    expect(Object.fromEntries(formas)).toEqual({ L1D20: 1 });
  });
});

// ─────────────────────────── Merge: SIMIT > municipal > lo que había ────────────────────────────

describe('resolverCampos — CF-08', () => {
  const canonico = (over: Record<string, unknown> = {}) => ({
    numeroComparendo: 'C-1', placa: null, codigoInfraccion: null, descripcionInfraccion: null,
    fechaComparendo: null, organismo: null, monto: null, estadoFuente: null,
    numeroResolucion: null, idResolucion: null, ...over,
  });

  const consolidado = (simit: unknown, municipal: unknown) => ({
    numero: 'C-1',
    simit: simit as never,
    payloadSimit: null,
    municipal: municipal as never,
    payloadMunicipal: null,
    municipioFuente: 'BELLO',
  });

  it('SIMIT gana cuando las dos fuentes traen el campo', () => {
    const campos = resolverCampos(
      consolidado(canonico({ estadoFuente: 'En cobro coactivo' }), canonico({ estadoFuente: 'Notificado' })),
      null,
      CTX_MUNICIPIO,
    );

    expect(campos.estadoFuente).toBe('En cobro coactivo');
  });

  it('el municipal SOLO rellena el hueco que SIMIT dejó', () => {
    // Es literalmente el caso de los mocks de la HU #11499: el comparendo compartido llega sin
    // descripción por SIMIT y con ella por el UTS.
    const campos = resolverCampos(
      consolidado(
        canonico({ descripcionInfraccion: null, monto: '1160500.00' }),
        canonico({ descripcionInfraccion: 'Conducir sin portar la licencia', monto: '999.00' }),
      ),
      null,
      CTX_MUNICIPIO,
    );

    expect(campos.descripcionInfraccion).toBe('Conducir sin portar la licencia');
    expect(campos.monto).toBe('1160500.00');
  });

  it('lo que NINGUNA fuente reportó hoy conserva su valor anterior', () => {
    const campos = resolverCampos(
      consolidado(canonico({ estadoFuente: 'Pagado' }), null),
      { placa: 'ABC123', organismo: 'Secretaría de Movilidad de Bello', estadoFuente: 'Notificado' },
      CTX_MUNICIPIO,
    );

    // Dejar de recibir un dato no es recibir que está vacío: ponerlo en `null` borraría información
    // buena por un cambio de contrato del proveedor.
    expect(campos.placa).toBe('ABC123');
    expect(campos.organismo).toBe('Secretaría de Movilidad de Bello');
    // Y lo que sí llegó se actualiza.
    expect(campos.estadoFuente).toBe('Pagado');
  });

  it('el municipal SÍ refresca lo guardado: el valor viejo es el último escalón, no el primero', () => {
    const campos = resolverCampos(
      consolidado(null, canonico({ estadoFuente: 'Pagado' })),
      { estadoFuente: 'Pendiente de pago' },
      CTX_MUNICIPIO,
    );

    // Si lo guardado tuviera prioridad sobre el municipal, un comparendo que pasó a «Pagado» en el
    // municipio se quedaría congelado en la fila para siempre.
    expect(campos.estadoFuente).toBe('Pagado');
  });
});

describe('origenMerge', () => {
  it.each([
    [true, false, 'simit'],
    [false, true, 'municipal'],
    [true, true, 'ambos'],
  ])('visto en simit=%s / municipal=%s → %s', (enSimit, enMunicipal, esperado) => {
    expect(origenMerge(enSimit as boolean, enMunicipal as boolean)).toBe(esperado);
  });
});

// ─────────────────── Comparendo o multa: la resolución manda (HU #11712) ────────────────────────
//
// Los dos endpoints devuelven comparendos Y multas en la misma lista. Lo que los distingue es la
// resolución: sin resolución sigue siendo un comparendo, con resolución ya es una multa.
//
// Lo que se demuestra aquí, por orden de importancia:
//
//   1. **La fila no puede mentir.** `tipo = 'multa'` exactamente cuando hay alguna resolución. Es el
//      invariante que la 0160 sostiene con un CHECK, y aquí se comprueba con la MISMA expresión
//      (`mienteLaFila`) para que un cambio de criterio no pueda pasar por uno solo de los dos sitios.
//   2. **La promoción es MONÓTONA.** Que una fuente calle no es la afirmación «no hay resolución»:
//      cualquiera de las dos que la presente promueve la fila.
//   3. **No hay regresión por silencio.** Una fila que ya fue multa no vuelve a comparendo porque el
//      proveedor deje de mandar el campo.
//   4. **`fechaResolucion` no es señal.** El ítem real de Medellín la trae CON valor y
//      `nroResolucion` en `null` a la vez: tomarla como señal fabricaría multas.

/** Recorte del mapa v3 que siembra la 0160: lo mínimo para hablar de resolución. */
const MAPA_V3: FilaMapa[] = [
  fila(3, 'simit', 'numeroComparendo', 'numeroComparendo', 1, false),
  fila(3, 'simit', 'numeroResolucion', 'numeroResolucion', 1, false),
  fila(3, 'simit', 'idResolucion', 'idResolucion', 1, false),
  fila(3, 'simit', 'estadoComparendo', 'estadoFuente', 1, false),
  fila(3, 'simit', 'estadoPago', 'estadoFuente', 3, false),
  fila(3, 'municipal', 'numeroComparendo', 'numeroComparendo', 1, false),
  fila(3, 'municipal', 'nroResolucion', 'numeroResolucion', 1, false),
  // El respaldo de prioridad 2 que la 0160 siembra de verdad. Está aquí y no se omite «por
  // simplicidad»: es el único sitio del mapa v3 donde un campo NUEVO tiene un segundo candidato, y
  // por tanto el único donde se puede observar si el primero SOMBREA al segundo.
  fila(3, 'municipal', 'numeroResolucion', 'numeroResolucion', 2, false),
  fila(3, 'municipal', 'descripcionEstado', 'estadoFuente', 1, false),
];

/**
 * El CHECK `flito_comparendos_tipo_resolucion_chk` de la 0160, dicho en TypeScript.
 *
 * No es una reimplementación cómoda: es la MISMA condición que la base va a rechazar con un 23514,
 * escrita aquí para que estos tests fallen en el mismo sitio en que fallaría producción y no haga
 * falta una base para verlo.
 *
 * El `if` del tipo nulo es la traducción de las dos ramas del CHECK, y traduce las dos: sin tipo y
 * sin resolución es el HISTÓRICO —legal, «no se sabe»—; sin tipo y CON resolución es la mentira que
 * la guarda `tipo_registro IS NOT NULL AND` de la segunda rama rechaza en la base. En SQL esa
 * distinción cuesta las dos piezas porque la comparación desnuda `(NULL = 'multa') = (…)` evalúa a
 * NULL y un CHECK que evalúa a NULL pasa; en TypeScript sale de un `if`, pero es lo mismo.
 */
function mienteLaFila(campos: {
  tipoRegistro: string | null; numeroResolucion: string | null; idResolucion: string | null;
}): boolean {
  const hayResolucion = campos.numeroResolucion !== null || campos.idResolucion !== null;
  if (campos.tipoRegistro === null) return hayResolucion;
  return (campos.tipoRegistro === 'multa') !== hayResolucion;
}

describe('tipoDeRegistro — la regla de negocio, en una línea', () => {
  it.each([
    ['3000000123', null, 'multa'],
    [null, '115697134', 'multa'],
    ['3000000123', '115697134', 'multa'],
    [null, null, 'comparendo'],
  ])('numero=%s / id=%s → %s', (numero, id, esperado) => {
    // Cualquiera de los dos vale como señal: el proveedor manda los dos y los dos vienen nulos
    // mientras es comparendo. Exigir el número dejaría sin promover a las multas cuyo número aún no
    // se publica; exigir los dos, a todas las del municipal, que no manda `idResolucion`.
    expect(tipoDeRegistro(numero as string | null, id as string | null)).toBe(esperado);
  });
});

describe('homologar — la resolución del proveedor entra al canónico (HU #11712)', () => {
  let simit: ReturnType<typeof candidatosDe>;
  let municipal: ReturnType<typeof candidatosDe>;

  beforeEach(async () => {
    conMapa(MAPA_V3);
    const mapa = await cargarMapaHomologacion();
    simit = candidatosDe(mapa, 'simit');
    municipal = candidatosDe(mapa, 'municipal');
  });

  it('el ítem de SIMIT que ya es multa trae los DOS campos, y el que no, ninguno', () => {
    expect(homologar(itemSimitMulta(), simit)).toMatchObject({
      numeroResolucion: FABRICADO.numeroResolucionSimit,
      idResolucion: FABRICADO.idResolucionSimit,
    });
    // El comparendo los manda EXPLÍCITAMENTE en `null`: la clave está, el valor no.
    expect(homologar(itemSimit(), simit)).toMatchObject({
      numeroResolucion: null, idResolucion: null,
    });
  });

  it('**el ítem municipal con `fechaResolucion` y sin `nroResolucion` NO es una multa**', () => {
    // La trampa del proveedor real: la fecha viene con valor («2026-09-22») y el número en `null`.
    // El mapa v3 no nombra `fechaResolucion` en ninguna parte, y por eso esto sale comparendo.
    const canonico = homologar(itemMunicipal(), municipal);

    expect(canonico.numeroResolucion).toBeNull();
    expect(tipoDeRegistro(canonico.numeroResolucion, canonico.idResolucion)).toBe('comparendo');
    // Y el ítem SÍ trae la fecha: el test no está pasando por no haber dato que mirar.
    expect(itemMunicipal().fechaResolucion).toBe('2026-09-22');
  });

  it('el mutante que mapea `fechaResolucion` fabricaría una multa — por eso la v3 no lo hace', () => {
    // La consecuencia, hecha visible: es lo que pasaría con UNA fila de más en el `field_map`.
    conMapa([...MAPA_V3, fila(3, 'municipal', 'fechaResolucion', 'numeroResolucion', 3, false)]);
    return cargarMapaHomologacion().then((mapa) => {
      const canonico = homologar(itemMunicipal(), candidatosDe(mapa, 'municipal'));
      expect(tipoDeRegistro(canonico.numeroResolucion, canonico.idResolucion)).toBe('multa');
    });
  });

  it('el número de resolución SÍ se recorta al ancho de la columna (no es llave)', () => {
    // Al revés que `numeroComparendo`, que se descarta entero: aquel es la llave y recortarlo podría
    // fundir dos deudas; este no lo usa ningún join, así que recortar degrada un dato de pantalla en
    // vez de tumbar el NIT con un 22001.
    const canonico = homologar({ numeroComparendo: 'C-1', numeroResolucion: 'R'.repeat(75) }, simit);
    expect(canonico.numeroResolucion).toHaveLength(60);
  });

  it('un vacío o un no-escalar no son una resolución: SIN otro candidato, la fila queda en comparendo', () => {
    for (const valor of ['', '   ', { total: 'RES-1' }, ['RES-1'], true]) {
      // `simit` tiene UN solo candidato para la resolución, así que aquí solo se observa la mitad
      // fácil del AC: que el valor no cuenta. La otra mitad —que no SOMBREA— necesita dos
      // candidatos y es el test de abajo.
      const canonico = homologar({ numeroComparendo: 'C-1', numeroResolucion: valor }, simit);
      expect(canonico.numeroResolucion, `\`${JSON.stringify(valor)}\` coló como resolución`).toBeNull();
      expect(tipoDeRegistro(canonico.numeroResolucion, canonico.idResolucion)).toBe('comparendo');
    }
  });

  it('**un no-escalar en prioridad 1 NO sombrea al candidato de prioridad 2** (AC6)', () => {
    // El fallo que el gate de QA reprodujo. Con el mapa v3 municipal real —`nroResolucion` p1,
    // `numeroResolucion` p2— un objeto, un array o un booleano en el primer candidato hacían que el
    // segundo NUNCA se leyera: `primerValor` devolvía el ruido, `texto()` lo volvía `null` y la
    // multa se quedaba marcada como comparendo teniendo el número una fila más abajo del mapa.
    //
    // Es el mismo sombreado del `comparendo: true` que documenta la 0158; allí se esquivó sacando la
    // fila del mapa, y esto es la corrección en la función.
    for (const ruido of [{ numero: 'RES-1' }, ['RES-1'], true, false, '', '   ', null]) {
      const canonico = homologar(
        { numeroComparendo: 'C-1', nroResolucion: ruido, numeroResolucion: 'RES-9' }, municipal,
      );

      expect(canonico.numeroResolucion, `\`${JSON.stringify(ruido)}\` en p1 sombreó al de p2`)
        .toBe('RES-9');
      expect(tipoDeRegistro(canonico.numeroResolucion, canonico.idResolucion)).toBe('multa');
    }
  });

  it('el sombreado tampoco ocurre en el campo donde se descubrió: `comparendo: true` (0158)', () => {
    // La cadena de SIMIT para el NÚMERO, con el booleano delante. Antes de esta corrección el ítem
    // entero se descartaba por «número irreconocible» y el NIT perdía un comparendo por corrida.
    conMapa([
      fila(3, 'simit', 'comparendo', 'numeroComparendo', 1, false),
      fila(3, 'simit', 'numeroMulta', 'numeroComparendo', 2, false),
    ]);
    return cargarMapaHomologacion().then((mapa) => {
      const canonico = homologar(
        { comparendo: true, numeroMulta: '05001000000012345678' }, candidatosDe(mapa, 'simit'),
      );
      expect(canonico.numeroComparendo).toBe('05001000000012345678');
    });
  });

  it('**los números legítimos siguen pasando**: saltar el ruido no es saltar los `number`', () => {
    // El riesgo de la corrección, comprobado en vez de prometido: los proveedores mandan el mismo
    // campo como `"604100"` y como `604100` según el endpoint, y el `valor: 633232.0` del UTS es el
    // monto de verdad. Un predicado que se pasara de estricto vaciaría el importe de cada fila del
    // municipal sin romper ningún otro test.
    conMapa([
      fila(3, 'municipal', 'numeroComparendo', 'numeroComparendo', 1, false),
      fila(3, 'municipal', 'valor', 'monto', 1, false),
      fila(3, 'municipal', 'codigoInfraccion', 'codigoInfraccion', 1, false),
      fila(3, 'municipal', 'nroResolucion', 'numeroResolucion', 1, false),
    ]);
    return cargarMapaHomologacion().then((mapa) => {
      const canonico = homologar({
        numeroComparendo: 'C-1', valor: 633232.0, codigoInfraccion: 29, nroResolucion: 4471,
      }, candidatosDe(mapa, 'municipal'));

      expect(canonico.monto).toBe('633232.00');
      expect(canonico.codigoInfraccion).toBe('29');
      expect(canonico.numeroResolucion).toBe('4471');
      // Y el `0` no es ausencia: es un número, y quien decide si significa algo es la normalización
      // del campo, no el filtro de candidatos.
      expect(homologar({ numeroComparendo: 'C-1', valor: 0 }, candidatosDe(mapa, 'municipal')).monto)
        .toBe('0.00');
    });
  });

  it('el número de resolución se normaliza a MAYÚSCULAS y sin espacios internos dobles', () => {
    // La normalización existe —misma familia que `codigoInfraccion`, que también es un código— y
    // hasta ahora no la probaba nadie: el test de recorte usa una cadena que ya está en mayúsculas,
    // así que quitar el `toUpperCase` no ponía nada en rojo. Con esto, la frase «se guarda tal cual
    // lo manda la fuente» deja de ser cierta, y por eso se corrigió en el COMMENT de la 0160 y en
    // `shared-types`.
    const canonico = homologar(
      { numeroComparendo: 'C-1', nroResolucion: '  res-2026   4471 ' }, municipal,
    );
    expect(canonico.numeroResolucion).toBe('RES-2026 4471');
  });
});

describe('resolverCampos — promoción monótona a multa (HU #11712)', () => {
  const canonico = (over: Record<string, unknown> = {}) => ({
    numeroComparendo: 'C-1', placa: null, codigoInfraccion: null, descripcionInfraccion: null,
    fechaComparendo: null, organismo: null, monto: null, estadoFuente: null,
    numeroResolucion: null, idResolucion: null, ...over,
  });

  const consolidado = (simit: unknown, municipal: unknown) => ({
    numero: 'C-1',
    simit: simit as never,
    payloadSimit: null,
    municipal: municipal as never,
    payloadMunicipal: null,
    municipioFuente: 'BELLO',
  });

  it('1. lo dice SIMIT y el municipal calla → multa', () => {
    const campos = resolverCampos(
      consolidado(canonico({ numeroResolucion: 'R-1', idResolucion: '115697134' }), canonico()),
      null,
      CTX_MUNICIPIO,
    );

    expect(campos.tipoRegistro).toBe('multa');
    expect(campos.numeroResolucion).toBe('R-1');
    expect(mienteLaFila(campos)).toBe(false);
  });

  it('2. **lo dice el municipal y SIMIT calla → multa igual**', () => {
    // El caso que justifica la regla entera. Que SIMIT no traiga el campo es indistinguible de que
    // no lo publique para este ítem: no es la afirmación «no hay resolución». Si el silencio de la
    // fuente prioritaria ganara, la mitad de las multas se quedarían sin promover.
    const campos = resolverCampos(
      consolidado(canonico(), canonico({ numeroResolucion: 'RES-2026-4471' })),
      null,
      CTX_MUNICIPIO,
    );

    expect(campos.tipoRegistro).toBe('multa');
    expect(campos.numeroResolucion).toBe('RES-2026-4471');
    expect(mienteLaFila(campos)).toBe(false);
  });

  it('3. **ninguna la trae hoy, pero la fila YA era multa → sigue siendo multa**', () => {
    // No hay regresión por silencio: el tercer escalón de RN-13 conserva lo guardado, así que un
    // proveedor que deje de mandar el campo no degrada la fila.
    const campos = resolverCampos(
      consolidado(canonico({ estadoFuente: 'En cobro' }), null),
      { numeroResolucion: 'R-VIEJA', idResolucion: null },
      CTX_MUNICIPIO,
    );

    expect(campos.tipoRegistro).toBe('multa');
    expect(campos.numeroResolucion).toBe('R-VIEJA');
    expect(mienteLaFila(campos)).toBe(false);
  });

  it('4. nadie la trae y nunca la hubo → comparendo', () => {
    const campos = resolverCampos(consolidado(canonico(), canonico()), { placa: 'ABC123' }, CTX_MUNICIPIO);

    expect(campos.tipoRegistro).toBe('comparendo');
    expect(campos.numeroResolucion).toBeNull();
    expect(campos.idResolucion).toBeNull();
    expect(mienteLaFila(campos)).toBe(false);
  });

  it('la fila que solo tiene `idResolucion` también es multa (el municipal no manda el número)', () => {
    const campos = resolverCampos(
      consolidado(canonico({ idResolucion: '115697134' }), canonico()), null,
      CTX_MUNICIPIO,
    );

    expect(campos.tipoRegistro).toBe('multa');
    expect(campos.numeroResolucion).toBeNull();
    expect(mienteLaFila(campos)).toBe(false);
  });

  it('si las dos traen números DISTINTOS gana SIMIT (RN-13): discrepan en el número, no en el tipo', () => {
    const campos = resolverCampos(
      consolidado(canonico({ numeroResolucion: 'R-SIMIT' }), canonico({ numeroResolucion: 'R-UTS' })),
      null,
      CTX_MUNICIPIO,
    );

    expect(campos.numeroResolucion).toBe('R-SIMIT');
    expect(campos.tipoRegistro).toBe('multa');
  });

  it('**el tipo se deriva de lo RESUELTO, no se elige por fuente**: es el mutante que rompe el CHECK', () => {
    // Si `tipoRegistro` fuera un campo más del mapa, `elegir('tipoRegistro')` tomaría el de SIMIT
    // —que no tiene resolución, luego `comparendo`— y `elegir('numeroResolucion')` el del municipal
    // —que sí la tiene—: la fila saldría `comparendo` CON número de resolución y el INSERT moriría
    // con un 23514. Reproducido aquí para que se vea que la incoherencia es alcanzable y que esta
    // implementación no la produce.
    const porFuente = {
      tipoRegistro: 'comparendo',                  // lo que habría dicho SIMIT, que gana por RN-13
      numeroResolucion: 'RES-2026-4471',           // lo que aportó el municipal por el 2.º escalón
      idResolucion: null,
    };
    expect(mienteLaFila(porFuente)).toBe(true);

    const campos = resolverCampos(
      consolidado(canonico(), canonico({ numeroResolucion: 'RES-2026-4471' })), null,
      CTX_MUNICIPIO,
    );
    expect(mienteLaFila(campos)).toBe(false);
    expect(campos.tipoRegistro).toBe('multa');
  });

  it('un tipo NULO no es un comodín: sin resolución es el histórico, con resolución es una mentira', () => {
    // Las dos filas que ninguna versión de `resolverCampos` puede producir pero un UPDATE a mano sí,
    // y que en la base separan las dos piezas del CHECK.
    //
    // Esta la rechaza la GUARDA `tipo_registro IS NOT NULL AND` de la segunda rama (sin ella,
    // `(NULL = 'multa') = (…)` evalúa a NULL y el CHECK pasaría):
    expect(mienteLaFila({ tipoRegistro: null, numeroResolucion: 'R-1', idResolucion: null })).toBe(true);
    // Y esta la ADMITE la primera rama, que existe justo para eso: el histórico entero llega así al
    // aplicar la 0160, y sin esa rama el `ADD CONSTRAINT` no habría podido ni validarse.
    expect(mienteLaFila({ tipoRegistro: null, numeroResolucion: null, idResolucion: null })).toBe(false);
  });

  it('ninguna combinación de las dos fuentes y el histórico produce una fila que mienta', () => {
    // Barrido de las 27 combinaciones (cada fuente y el previo: sin resolución / con número / con
    // id). El invariante del CHECK no puede depender de qué caso escribió alguien un test.
    const opciones = [null, { numeroResolucion: 'R-X' }, { idResolucion: 'ID-X' }];
    for (const s of opciones) {
      for (const m of opciones) {
        for (const p of opciones) {
          const campos = resolverCampos(
            consolidado(canonico(s ?? {}), canonico(m ?? {})),
            p === null ? null : p,
            CTX_MUNICIPIO,
          );
          expect(mienteLaFila(campos), `simit=${JSON.stringify(s)} municipal=${JSON.stringify(m)} previo=${JSON.stringify(p)}`)
            .toBe(false);
        }
      }
    }
  });
});

describe('acumular* — el ítem municipal que ya es multa llega entero al consolidado', () => {
  it('la resolución del UTS sobrevive al acumulador y sale en el merge', async () => {
    conMapa(MAPA_V3);
    const mapa = await cargarMapaHomologacion();
    const acumulador = new Map();

    acumularMunicipal(acumulador, [itemMunicipalMulta()], candidatosDe(mapa, 'municipal'), 'MEDELLIN');
    // La llave ya no lleva la letra del portal (HU #11806): `D99999…901` normaliza a `99999…901`.
    const consolidado = acumulador.get(FABRICADO.numeroMunicipalCanonico)!;
    const campos = resolverCampos(consolidado, null, CTX_MUNICIPIO);

    expect(campos.numeroResolucion).toBe(FABRICADO.numeroResolucionMunicipal);
    expect(campos.tipoRegistro).toBe('multa');
  });
});
