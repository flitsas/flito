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
  homologar,
  origenMerge,
  resolverCampos,
} = await import('../../src/modules/flito-comparendos/flito-comparendos-merge.js');
const { ComparendosMapaHomologacionVacioError } =
  await import('../../src/modules/flito-comparendos/flito-comparendos.errors.js');

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
    const ignorados = acumularSimit(acumulador, [
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
  // `numeroCanonico` no se exporta, así que se prueba por donde de verdad importa: la LLAVE del
  // acumulador. Es lo que decide si dos avisos son una deuda o dos, y hasta este bloque ningún test
  // del repo lo cubría — los casos de arriba usan `'C-1'` idéntico en las dos fuentes, que pasaría
  // igual con la normalización desactivada.

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
    const ignorados = acumularSimit(acumulador, [
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

// ─────────────────────────── Merge: SIMIT > municipal > lo que había ────────────────────────────

describe('resolverCampos — CF-08', () => {
  const canonico = (over: Record<string, unknown> = {}) => ({
    numeroComparendo: 'C-1', placa: null, codigoInfraccion: null, descripcionInfraccion: null,
    fechaComparendo: null, organismo: null, monto: null, estadoFuente: null, ...over,
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
    );

    expect(campos.descripcionInfraccion).toBe('Conducir sin portar la licencia');
    expect(campos.monto).toBe('1160500.00');
  });

  it('lo que NINGUNA fuente reportó hoy conserva su valor anterior', () => {
    const campos = resolverCampos(
      consolidado(canonico({ estadoFuente: 'Pagado' }), null),
      { placa: 'ABC123', organismo: 'Secretaría de Movilidad de Bello', estadoFuente: 'Notificado' },
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
