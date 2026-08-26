// FLITO Bolsas — salidas automáticas al sellar la liquidación (HU #11122, Feature #11120 §2.2).
//
// Aquí se prueba el descuento de la bolsa a través del sellado real (`liquidar`/`reversar`), no solo
// la función de bolsas: lo que la HU promete es que sellar cobre y reversar devuelva, y buena parte
// de la regla vive en cómo la liquidación construye las llaves y los organismos de cada concepto.
//
// El mock de drizzle simula DOS cosas con estado, porque sin ellas los AC no se podrían afirmar:
//   · el SALDO de la bolsa, que cada asiento vuelve a leer (las salidas van en serie);
//   · el LIBRO de movimientos, contra el que se resuelven los pre-chequeos de idempotencia.
// Así, que un reintento no duplique o que reversar libere las llaves se comprueba contra el estado
// que dejó la operación anterior, no contra una respuesta fijada a mano.
//
// Para eso hace falta algo que el helper keyed no da: saber POR QUÉ LLAVE se pregunta. Se resuelve
// leyendo los parámetros del `where` de drizzle (`paramsDe`), no encolando respuestas por orden de
// llamada — con conceptos que a veces no aplican, cualquier orden fijo se desalinea y el test acaba
// afirmando lo contrario de lo que cree.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { createKeyedDb, type Resolver } from '../helpers/keyed-db.js';

const kdb = createKeyedDb();

vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const tarifaDeMock = vi.fn();
vi.mock('../../src/modules/flito-parametrizacion/flito-tarifas.service.js', () => ({
  tarifaDe: tarifaDeMock,
}));

const { liquidar, reversar } = await import('../../src/modules/flito-liquidacion/flito-liquidacion.service.js');
const { registrarSalidasLiquidacion, reversarSalidasLiquidacion } =
  await import('../../src/modules/flito-bolsas/flito-bolsas.service.js');

// ─────────────────────────── Espía de escrituras ─────────────────────────────

interface Mutacion { tabla: string; datos: Record<string, unknown>; }

const inserts: Mutacion[] = [];
const updates: Mutacion[] = [];

function nombreTabla(tbl: unknown): string {
  try { return getTableName(tbl as never); } catch { return '__expr__'; }
}

/** Parámetros del último `where` ejecutado: con qué valores se filtró la consulta en curso. */
let ultimosFiltros: string[] = [];

/**
 * Valores de los parámetros de una condición drizzle (`eq`, `and`, `like`…).
 *
 * Un `Param` guarda el valor en `.value`; los trozos de texto del SQL lo guardan como array, así que
 * quedarse con los strings sueltos deja exactamente los valores enlazados.
 */
function paramsDe(cond: unknown): string[] {
  const out: string[] = [];
  const visitar = (n: unknown): void => {
    if (n === null || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(visitar); return; }
    const o = n as Record<string, unknown>;
    if (typeof o.value === 'string') out.push(o.value);
    if (Array.isArray(o.queryChunks)) o.queryChunks.forEach(visitar);
  };
  visitar(cond);
  return out;
}

/** Igual que en flito-bolsas.test.ts: registra QUÉ se escribió, no solo en qué tabla. */
function espiarMutaciones(): void {
  const selectBase = kdb.select.getMockImplementation() as (...a: unknown[]) => Record<string, unknown>;
  kdb.select.mockImplementation((...args: unknown[]) => {
    const c = selectBase(...args);
    const original = c.where as (v: unknown) => unknown;
    c.where = (cond: unknown) => { ultimosFiltros = paramsDe(cond); return original(cond); };
    return c;
  });

  const insertBase = kdb.insert.getMockImplementation() as (t: unknown) => Record<string, unknown>;
  kdb.insert.mockImplementation((tbl: unknown) => {
    const c = insertBase(tbl);
    const original = c.values as (v: unknown) => unknown;
    c.values = (v: Record<string, unknown>) => { inserts.push({ tabla: nombreTabla(tbl), datos: v }); return original(v); };
    return c;
  });

  const updateBase = kdb.update.getMockImplementation() as (t: unknown) => Record<string, unknown>;
  kdb.update.mockImplementation((tbl: unknown) => {
    const c = updateBase(tbl);
    const original = c.set as (v: unknown) => unknown;
    c.set = (v: Record<string, unknown>) => {
      const tabla = nombreTabla(tbl);
      updates.push({ tabla, datos: v });
      aplicarEnSimulacion(tabla, v);
      return original(v);
    };
    return c;
  });
}

const insertsEn = (tabla: string) => inserts.filter((m) => m.tabla === tabla);
const updatesEn = (tabla: string) => updates.filter((m) => m.tabla === tabla);

// ─────────────────────────── Base de datos simulada ──────────────────────────

type Fila = Record<string, unknown>;

/** Saldo vigente de la bolsa. Lo mueve el mismo UPDATE que haría el servicio contra Postgres. */
let saldoBolsa = 0;
/** Movimientos ya asentados. Es lo que ven los pre-chequeos de idempotencia y el reverso. */
let libro: Fila[] = [];
let secuenciaMovimiento = 0;

const BOLSA_ID = '11111111-1111-1111-1111-111111111111';
const COMPANIA = 7;
const TRAMITE = 'aaaaaaaa-0000-0000-0000-000000000001';
const SOAT_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const IMPUESTO_ID = 'cccccccc-0000-0000-0000-000000000003';
const DERECHO_ID = 'dddddddd-0000-0000-0000-000000000004';
const AHORA = new Date('2026-07-30T15:00:00Z');
const CTX = { userId: 9, nombre: 'sistema' };

/** Refleja en la simulación lo que el UPDATE acaba de escribir. */
function aplicarEnSimulacion(tabla: string, datos: Record<string, unknown>): void {
  if (tabla === 'flito_bolsas' && typeof datos.saldo === 'string') {
    saldoBolsa = Number(datos.saldo);
    return;
  }
  // Reverso: la llave original se reescribe con el prefijo `rev:`. El mock no ve el `where`, pero la
  // llave nueva contiene la vieja, así que la fila se identifica sin ambigüedad.
  if (tabla === 'flito_bolsa_movimientos' && typeof datos.llaveIdempotencia === 'string') {
    const nueva = datos.llaveIdempotencia;
    const anterior = nueva.replace(/^rev:/, '');
    const fila = libro.find((f) => f.llaveIdempotencia === anterior);
    if (fila) fila.llaveIdempotencia = nueva;
  }
}

/** La bolsa que devuelve el SELECT ... FOR UPDATE, con el saldo vigente de la simulación. */
const bolsaVigente: Resolver = () => [{ id: BOLSA_ID, saldo: String(saldoBolsa) }];

/**
 * Resuelve las consultas a `flito_bolsa_movimientos` contra el libro simulado, mirando por qué se
 * está filtrando. Son dos:
 *   · pre-chequeo de idempotencia — un `eq` por llave: devuelve la fila solo si de verdad se asentó
 *     antes, que es lo que hace significativos el reintento (AC6) y el cobro único por VIN (AC4);
 *   · barrido del reverso — lleva un `like 'salida:%'`: devuelve las salidas vivas del trámite.
 */
const consultaMovimientos: Resolver = () => {
  const filtros = ultimosFiltros;
  // El barrido del reverso filtra por trámite + origen + tipo (varios parámetros); el pre-chequeo
  // filtra por una sola llave. El patrón del `like` no viaja como parámetro, así que la condición
  // «llave viva» la aplica esta simulación: es lo que hace que reversar dos veces no encuentre nada.
  //
  // El origen y el tipo se toman de los PARÁMETROS REALES de la consulta y no se escriben aquí a
  // mano: así, si alguien quitara del código la condición `origen = 'automatico'` —que es lo único
  // que deja fuera del reverso los movimientos de conciliación (Feature #11623, CF-07)—, esta
  // simulación dejaría de filtrar por él y los tests se pondrían en rojo en vez de seguir verdes
  // afirmando una condición que ya no existe.
  if (filtros.length > 1) {
    const [tramite, origen, tipo] = filtros;
    return libro.filter((f) =>
      f.tramiteId === tramite && f.origen === origen && f.tipo === tipo
      && String(f.llaveIdempotencia).startsWith('salida:'));
  }
  const fila = libro.find((f) => f.llaveIdempotencia === filtros[0]);
  return fila ? [fila] : [];
};

/**
 * Las seis llaves del sellado, en el orden en que `salidasDe` las construye.
 *
 * El GMF va el último a propósito (HU #11160): las salidas se asientan en serie, así que el orden de
 * esta lista es el del libro y el `saldo_resultante` de la última línea tiene que ser el saldo final.
 */
function llavesDelSellado(): string[] {
  return [
    `salida:soat:${SOAT_ID}`,
    `salida:impuesto:${IMPUESTO_ID}`,
    `salida:tramite:${TRAMITE}:derecho`,
    `salida:tramite:${TRAMITE}:tramite_digital`,
    `salida:tramite:${TRAMITE}:logistica`,
    `salida:tramite:${TRAMITE}:gmf`,
  ];
}

// ─────────────────────────── Filas del trámite ───────────────────────────────

/**
 * Trámite con los cinco conceptos resueltos: 450.000 + 120.000 + 80.000 + tarifas.
 *
 * Lleva `modalidadOrganismo: 'requiere_gestion'` porque el impuesto solo lo gestiona FLITO si la
 * compañía no lo autogestiona Y el organismo lo entrega en gestión (RN-01). Lo que FLITO no gestiona
 * no se cobra, así que sin esto el impuesto no generaría salida y las cuentas de la bolsa serían otras.
 */
function filaCalculo(over: Fila = {}): Fila {
  return {
    tramiteId: TRAMITE, idFlit: 'FLIT-1', tipoTramite: 'Traspaso', companiaId: COMPANIA,
    logisticaAutogestionable: false, soatAutogestionable: false, impuestosAutogestionable: false,
    modalidadOrganismo: 'requiere_gestion',
    soatId: SOAT_ID, soatEstado: 'pagado', soatValorPagado: '450000',
    impuestoId: IMPUESTO_ID, impuestoEstado: 'pagado', impuestoValorPagado: '120000',
    derechoValor: '80000',
    ...over,
  };
}

/** Ids y organismos que la bolsa necesita para imputar cada salida. */
function filaIdentificadores(over: Fila = {}): Fila {
  return {
    companiaId: COMPANIA,
    soatId: SOAT_ID, soatOrganismo: '05001',
    impuestoId: IMPUESTO_ID, impuestoOrganismo: '11001',
    derechoId: DERECHO_ID, derechoOrganismo: '05266',
    ...over,
  };
}

const filaLiquidacion = {
  id: 'eeeeeeee-0000-0000-0000-000000000005', tramiteId: TRAMITE, estado: 'liquidado',
  valorSoat: '450000', valorImpuesto: '120000', valorDerecho: '80000',
  valorTramiteDigital: '200000', valorLogistica: '15000',
  baseGmf: '865000', tasaGmf: '0.004', valorGmf: '3460', total: '868460',
  detalle: {}, liquidadoEn: AHORA, facturadoEn: null,
};

/** Tarifas por defecto: trámite digital 200.000 y logística 15.000. */
function tarifasConfiguradas(digital = 200000, logistica = 15000): void {
  tarifaDeMock.mockImplementation(async (_c: unknown, concepto: string) =>
    concepto === 'tramite_digital'
      ? { valor: digital, origen: 'especifica' }
      : { valor: logistica, origen: 'generica' });
}

/**
 * Deja el mock listo para un sellado. Los dos SELECT sobre `flito_tramites` van encolados porque el
 * sellado consulta la misma tabla dos veces con proyecciones distintas: primero el cálculo, después
 * los identificadores.
 */
function escenarioSellado(calculo: Fila = {}, ids: Fila = {}): void {
  kdb.when
    .select('flito_liquidaciones', [])
    .selectOnce('flito_tramites', [filaCalculo(calculo)])
    .selectOnce('flito_tramites', [filaIdentificadores(ids)])
    .select('flito_bolsa_movimientos', consultaMovimientos)
    .select('flito_bolsas', bolsaVigente)
    .insert('flito_liquidaciones', [filaLiquidacion])
    .insert('flito_liquidacion_eventos', []);
}

/** Deja el mock listo para un reverso: la liquidación existe y el libro responde por sí solo. */
function escenarioReverso(): void {
  kdb.when
    .select('flito_liquidaciones', [filaLiquidacion])
    .select('flito_bolsa_movimientos', consultaMovimientos)
    .select('flito_bolsas', bolsaVigente);
}

beforeEach(() => {
  kdb.reset();
  inserts.length = 0;
  updates.length = 0;
  libro = [];
  secuenciaMovimiento = 0;
  saldoBolsa = 1_000_000;
  tarifaDeMock.mockReset();
  tarifasConfiguradas();
  espiarMutaciones();
  // `returning()` devuelve la fila que el servicio acaba de escribir y la deja en el libro: los
  // pre-chequeos y el reverso trabajan luego sobre ella, igual que harían contra la tabla real.
  kdb.when.insert('flito_bolsa_movimientos', () => {
    const datos = insertsEn('flito_bolsa_movimientos').at(-1)?.datos ?? {};
    const fila: Fila = { id: `mov-${++secuenciaMovimiento}`, createdAt: AHORA, ...datos };
    libro.push(fila);
    return [fila];
  });
});

// Movimientos escritos, por dirección.
const salidasEscritas = () => insertsEn('flito_bolsa_movimientos').filter((m) => m.datos.tipo === 'salida').map((m) => m.datos);
const entradasEscritas = () => insertsEn('flito_bolsa_movimientos').filter((m) => m.datos.tipo === 'entrada').map((m) => m.datos);

// ─────────────────────────── AC1 ─────────────────────────────────────────────

describe('liquidar — AC1: sellar descuenta los cinco conceptos y el GMF de la bolsa', () => {
  it('asienta una salida por concepto, con su valor sellado y su trámite', async () => {
    escenarioSellado();
    await liquidar(TRAMITE, 9);

    const salidas = salidasEscritas();
    expect(salidas.map((s) => s.concepto)).toEqual(['soat', 'impuesto', 'derecho', 'tramite_digital', 'logistica', 'gmf']);
    expect(salidas.map((s) => s.valor)).toEqual(['450000', '120000', '80000', '200000', '15000', '3460']);
    // Todas cuelgan del trámite: es lo que permite reversarlas juntas y explicar el consumo.
    expect(salidas.every((s) => s.tramiteId === TRAMITE)).toBe(true);
    expect(salidas.every((s) => s.origen === 'automatico')).toBe(true);
  });

  it('el saldo baja por la suma de los seis y cada asiento parte del que dejó el anterior', async () => {
    escenarioSellado();
    await liquidar(TRAMITE, 9);

    // 1.000.000 − 450.000 − 120.000 − 80.000 − 200.000 − 15.000 − 3.460. Que la cadena sea correcta
    // es lo que hace fiable el extracto: cada línea muestra el saldo real tras aplicarse.
    expect(salidasEscritas().map((s) => s.saldoResultante))
      .toEqual(['550000', '430000', '350000', '150000', '135000', '131540']);
    expect(saldoBolsa).toBe(131540);
  });

  it('el GMF consume bolsa: la salida vale lo que la liquidación selló como gravamen', async () => {
    // HU #11160 invierte la decisión original de la #11122. Al cliente se le factura el total CON
    // gravamen (868.460 = 865.000 + 3.460), así que dejarlo fuera de la bolsa hacía que el saldo
    // mostrase un 0,4 % de más en cada trámite.
    escenarioSellado();
    await liquidar(TRAMITE, 9);

    expect(1_000_000 - saldoBolsa).toBe(868460);
    const gmf = salidasEscritas().find((s) => s.concepto === 'gmf');
    expect(gmf?.valor).toBe('3460');
  });

  it('la salida de GMF es la última del libro y deja el saldo final', async () => {
    // AC2: el orden importa porque los asientos van en serie. Si el gravamen no fuera el último, el
    // saldo_resultante de la última línea no sería el saldo real de la bolsa.
    escenarioSellado();
    await liquidar(TRAMITE, 9);

    const ultima = salidasEscritas().at(-1);
    expect(ultima?.concepto).toBe('gmf');
    expect(ultima?.saldoResultante).toBe(String(saldoBolsa));
  });

  it('el GMF no lleva organismo: es un gravamen, no un desembolso a una secretaría', async () => {
    // AC6. El extracto por organismo agrupa por `organismoCodigo`, así que una línea con organismo
    // nulo nunca puede aterrizar en la cuenta de un Organismo de Tránsito.
    escenarioSellado();
    await liquidar(TRAMITE, 9);

    expect(salidasEscritas().find((s) => s.concepto === 'gmf')?.organismoCodigo).toBeNull();
  });

  it('la salida no toca la última recarga de la bolsa', async () => {
    // `ultimaRecargaValor` es la base del nivel de riesgo (HU #11125): solo la mueven las entradas
    // de tipo recarga, no el consumo.
    escenarioSellado();
    await liquidar(TRAMITE, 9);

    for (const u of updatesEn('flito_bolsas')) {
      expect(u.datos).not.toHaveProperty('ultimaRecargaValor');
      expect(u.datos).not.toHaveProperty('ultimaRecargaEn');
    }
  });

  it('el sellado sigue devolviendo la liquidación sellada', async () => {
    // El descuento es un efecto del sellado, no su resultado: quien liquida espera su liquidación.
    escenarioSellado();
    const dto = await liquidar(TRAMITE, 9);

    expect(dto.estado).toBe('liquidado');
    expect(dto.total).toBe(868460);
  });
});

// ─────────────────────────── AC2 ─────────────────────────────────────────────

describe('liquidar — AC2: lo que la compañía autogestiona no consume bolsa', () => {
  it('SOAT y logística autogestionados → tres salidas más el gravamen', async () => {
    // `valor: null` significa «no aplica», no cero: si generaran salida de 0, el extracto mostraría
    // un consumo que nunca ocurrió (y el asiento fallaría por valor no positivo).
    escenarioSellado({ soatAutogestionable: true, logisticaAutogestionable: true });
    await liquidar(TRAMITE, 9);

    expect(salidasEscritas().map((s) => s.concepto)).toEqual(['impuesto', 'derecho', 'tramite_digital', 'gmf']);
    // El gravamen se calcula sobre lo que SÍ aplica: 400.000 × 0,004 = 1.600. Lo autogestionado no
    // entra a la base, que es lo que hace que una compañía como Renting pague un GMF proporcional.
    const base = 120000 + 80000 + 200000;
    expect(saldoBolsa).toBe(1_000_000 - base - 1600);
  });

  it('un impuesto que FLITO no gestiona tampoco genera su salida', async () => {
    // Se declara por la parametrización, no por la ausencia del registro: que no exista la fila
    // puede significar «no aplica» o «todavía no se ha gestionado», y solo la primera deja liquidar.
    escenarioSellado({
      impuestosAutogestionable: true,
      impuestoId: null, impuestoEstado: null, impuestoValorPagado: null,
    });
    await liquidar(TRAMITE, 9);

    expect(salidasEscritas().map((s) => s.concepto)).toEqual(['soat', 'derecho', 'tramite_digital', 'logistica', 'gmf']);
  });
});

// ─────────────────────────── Conceptos en cero ───────────────────────────────

/**
 * Un concepto que cuesta CERO no genera línea en el libro, y eso no es un caso de laboratorio: el
 * tarifario admite el cero a propósito (`El valor debe ser un número mayor o igual a cero`), que es
 * como se registra una tarifa de cortesía.
 *
 * Por eso el guard de `salidasDe` exige `> 0` y no basta con `!== null`: el asiento va DENTRO de la
 * transacción del sellado y rechaza los valores no positivos, así que intentar mover $0 no dejaría
 * una línea de más — impediría liquidar el trámite entero. Si alguien «simplifica» ese guard, los
 * tres tests de aquí abajo se ponen en rojo.
 */
describe('liquidar — un concepto que vale cero no consume bolsa ni impide sellar', () => {
  it('tarifa de trámite digital en cero → se sella y ese concepto no genera salida', async () => {
    tarifasConfiguradas(0, 15000);
    escenarioSellado();

    const dto = await liquidar(TRAMITE, 9);

    expect(dto.estado).toBe('liquidado');
    expect(salidasEscritas().map((s) => s.concepto)).toEqual(['soat', 'impuesto', 'derecho', 'logistica', 'gmf']);
    // Los otros cuatro sí bajan el saldo: la cortesía se aplica al concepto, no a la factura entera.
    const base = 450000 + 120000 + 80000 + 15000;
    expect(saldoBolsa).toBe(1_000_000 - base - 2660);
  });

  it('derecho de tránsito en cero → se sella y no se asienta su salida', async () => {
    escenarioSellado({ derechoValor: '0' });

    const dto = await liquidar(TRAMITE, 9);

    expect(dto.estado).toBe('liquidado');
    expect(salidasEscritas().map((s) => s.concepto)).toEqual(['soat', 'impuesto', 'tramite_digital', 'logistica', 'gmf']);
    const base = 450000 + 120000 + 200000 + 15000;
    expect(saldoBolsa).toBe(1_000_000 - base - 3140);
  });

  it('todos los conceptos en cero o no aplicables → se sella sin mover la bolsa', async () => {
    // Trámite de cortesía completo: nada que desembolsar. El sellado sigue siendo información
    // válida del trámite aunque no haya un solo peso que descontar. AC4 de la HU #11160: con base
    // gravable en cero el GMF también vale cero y su línea tampoco se asienta.
    tarifasConfiguradas(0, 0);
    escenarioSellado({
      soatAutogestionable: true, impuestosAutogestionable: true,
      impuestoId: null, impuestoEstado: null, impuestoValorPagado: null,
      derechoValor: '0',
    });

    const dto = await liquidar(TRAMITE, 9);

    expect(dto.estado).toBe('liquidado');
    expect(insertsEn('flito_bolsa_movimientos')).toHaveLength(0);
    expect(updatesEn('flito_bolsas')).toHaveLength(0);
    expect(saldoBolsa).toBe(1_000_000);
  });
});

// ─────────────────────────── AC3 ─────────────────────────────────────────────

describe('liquidar — AC3: la bolsa puede quedar en negativo', () => {
  it('saldo 10.000 y liquidación de 150.000 → se descuenta igual y no se lanza error', async () => {
    // Si el organismo ya aprobó, el gasto ocurrió: frenar el descuento no lo deshace, solo desalinea
    // el sistema de la realidad. El saldo negativo es lo que dispara la alerta (HU #11125).
    saldoBolsa = 10000;
    tarifasConfiguradas(40000, 10000);
    escenarioSellado({
      // Compañía que autogestiona SOAT e impuesto: FLITO solo le cobra derecho y honorarios.
      soatAutogestionable: true, impuestosAutogestionable: true,
      soatId: null, soatEstado: null, soatValorPagado: null,
      impuestoId: null, impuestoEstado: null, impuestoValorPagado: null,
      derechoValor: '100000',
    });

    await expect(liquidar(TRAMITE, 9)).resolves.toBeDefined();
    // Tres conceptos más el gravamen: 150.000 de base y 600 de 4x1000.
    expect(salidasEscritas()).toHaveLength(4);
    expect(saldoBolsa).toBe(-140600);
  });

  it('la última línea del extracto muestra el saldo negativo real', async () => {
    saldoBolsa = 10000;
    tarifasConfiguradas(40000, 10000);
    escenarioSellado({
      // Compañía que autogestiona SOAT e impuesto: FLITO solo le cobra derecho y honorarios.
      soatAutogestionable: true, impuestosAutogestionable: true,
      soatId: null, soatEstado: null, soatValorPagado: null,
      impuestoId: null, impuestoEstado: null, impuestoValorPagado: null,
      derechoValor: '100000',
    });
    await liquidar(TRAMITE, 9);

    expect(salidasEscritas().at(-1)?.saldoResultante).toBe('-140600');
  });
});

// ─────────────────────────── AC4 y llaves ────────────────────────────────────

describe('liquidar — AC4: el SOAT se cobra una vez por vehículo', () => {
  it('la llave de cada concepto identifica lo que no debe cobrarse dos veces', async () => {
    escenarioSellado();
    await liquidar(TRAMITE, 9);

    // SOAT por su fila (una por VIN, RN-01), impuesto por la suya (una por trámite) y el resto por
    // radicación. Todas bajo el prefijo de familia `salida:`.
    expect(salidasEscritas().map((s) => s.llaveIdempotencia)).toEqual(llavesDelSellado());
  });

  it('si otro trámite del mismo vehículo ya pagó el SOAT, no se vuelve a cobrar', async () => {
    // Mismo VIN, trámite anulado y rehecho: el SOAT ya salió de la bolsa una vez y el segundo
    // sellado no puede volver a descontarlo.
    libro.push({
      id: 'mov-previo', tramiteId: 'otro-tramite', tipo: 'salida', origen: 'automatico',
      concepto: 'soat', organismoCodigo: '05001', valor: '450000', saldoResultante: '550000',
      periodo: '2026-07', fecha: '2026-07-01', observacion: null, soporteId: null,
      companiaId: COMPANIA, registradoPorNombre: 'sistema', createdAt: AHORA,
      llaveIdempotencia: `salida:soat:${SOAT_ID}`,
    });
    escenarioSellado();
    await liquidar(TRAMITE, 9);

    expect(salidasEscritas().map((s) => s.concepto)).toEqual(['impuesto', 'derecho', 'tramite_digital', 'logistica', 'gmf']);
    // Los otros cuatro sí se cobran: el duplicado se omite, no aborta el sellado.
    //
    // El GMF sigue valiendo 3.460, calculado sobre la base COMPLETA (865.000) incluido el SOAT que
    // aquí no se descuenta. Es deliberado: el AC1 exige que la salida valga lo que la liquidación
    // selló, y el sellado no sabe nada de la deduplicación por VIN, que es una regla de la bolsa.
    // Consecuencia conocida: en este caso el consumo de la bolsa no cuadra con el total facturado.
    expect(saldoBolsa).toBe(1_000_000 - (865000 - 450000) - 3460);
  });
});

describe('liquidar — cada salida se imputa a su propio organismo', () => {
  it('SOAT, impuesto y derecho llevan el de su registro, no el del trámite', async () => {
    // Los tres se congelan al crearse y el del trámite se reescribe en cada sincronización: tomar
    // el del trámite imputaría el gasto al organismo equivocado en el reporte por organismo.
    escenarioSellado();
    await liquidar(TRAMITE, 9);

    const porConcepto = Object.fromEntries(salidasEscritas().map((s) => [s.concepto, s.organismoCodigo]));
    expect(porConcepto).toEqual({
      soat: '05001', impuesto: '11001', derecho: '05266',
      tramite_digital: null, logistica: null, gmf: null,
    });
  });

  it('trámite digital y logística van sin organismo: son honorarios de FLIT', async () => {
    escenarioSellado();
    await liquidar(TRAMITE, 9);

    const honorarios = salidasEscritas().filter((s) => s.concepto === 'tramite_digital' || s.concepto === 'logistica');
    expect(honorarios).toHaveLength(2);
    expect(honorarios.every((s) => s.organismoCodigo === null)).toBe(true);
  });

  it('un organismo sin resolver llega como null, no revienta el sellado', async () => {
    escenarioSellado({}, { soatOrganismo: null, impuestoOrganismo: null, derechoOrganismo: null });
    await liquidar(TRAMITE, 9);

    expect(salidasEscritas()).toHaveLength(6);
    expect(salidasEscritas().every((s) => s.organismoCodigo === null)).toBe(true);
  });
});

// ─────────────────────────── Trámite sin compañía ────────────────────────────

describe('liquidar — trámite que todavía no cruzó con un cliente', () => {
  it('sin companiaId no se intenta ninguna salida y el sellado no falla', async () => {
    // No hay bolsa a la que cobrar. El sellado tiene que seguir funcionando: la liquidación es
    // información del trámite, la bolsa es una consecuencia.
    escenarioSellado({ companiaId: null }, { companiaId: null });
    const dto = await liquidar(TRAMITE, 9);

    expect(dto.estado).toBe('liquidado');
    expect(insertsEn('flito_bolsa_movimientos')).toHaveLength(0);
    expect(updatesEn('flito_bolsas')).toHaveLength(0);
  });
});

// ─────────────────────────── AC6: reintento del sellado ──────────────────────

describe('registrarSalidasLiquidacion — AC6: reintentar el sellado no duplica', () => {
  /** Los conceptos tal como los arma la liquidación, para llamar al servicio directamente. */
  const conceptos = [
    { concepto: 'derecho' as const, valor: 80000, organismoCodigo: '05266', llave: `tramite:${TRAMITE}:derecho` },
    { concepto: 'logistica' as const, valor: 15000, organismoCodigo: null, llave: `tramite:${TRAMITE}:logistica` },
    // El gravamen entra en la misma lista y con la misma mecánica de llave: su idempotencia no es un
    // caso aparte (HU #11160, AC5).
    { concepto: 'gmf' as const, valor: 380, organismoCodigo: null, llave: `tramite:${TRAMITE}:gmf` },
  ];
  const datos = { companiaId: COMPANIA, tramiteId: TRAMITE, fecha: '2026-07-30', conceptos };
  // El `tx` de una transacción abierta: en la simulación, el mismo db enrutado por tabla.
  const tx = kdb.db as never;

  it('la segunda pasada no asienta nada y el saldo no se mueve', async () => {
    kdb.when
      .select('flito_bolsas', bolsaVigente)
      .select('flito_bolsa_movimientos', consultaMovimientos);

    const primera = await registrarSalidasLiquidacion(tx, datos, CTX);
    const saldoTrasPrimera = saldoBolsa;
    const segunda = await registrarSalidasLiquidacion(tx, datos, CTX);

    expect(primera).toHaveLength(3);
    // Devuelve solo lo realmente asentado: la segunda no aporta ninguna línea nueva.
    expect(segunda).toEqual([]);
    expect(insertsEn('flito_bolsa_movimientos')).toHaveLength(3);
    expect(saldoBolsa).toBe(saldoTrasPrimera);
  });

  it('un concepto ya asentado no impide asentar los que faltan', async () => {
    // Reintento parcial: la primera pasada murió después del derecho. La segunda completa el resto
    // en vez de rechazarlo todo.
    kdb.when
      .select('flito_bolsas', bolsaVigente)
      .select('flito_bolsa_movimientos', consultaMovimientos);

    await registrarSalidasLiquidacion(tx, { ...datos, conceptos: [conceptos[0]] }, CTX);
    const segunda = await registrarSalidasLiquidacion(tx, datos, CTX);

    expect(segunda.map((m) => m.concepto)).toEqual(['logistica', 'gmf']);
    expect(saldoBolsa).toBe(1_000_000 - 95380);
  });
});

// ─────────────────────────── AC5: reverso ────────────────────────────────────

describe('reversar — AC5: el reverso devuelve el dinero con contramovimientos', () => {
  it('una entrada por cada salida viva, con llave propia y el valor original', async () => {
    // El libro es append-only: devolver el dinero no es borrar la salida, es asentar su contrario.
    escenarioSellado();
    await liquidar(TRAMITE, 9);
    escenarioReverso();
    await reversar(TRAMITE, 'Error en el valor del derecho', 9);

    const contras = entradasEscritas();
    expect(contras).toHaveLength(6);
    expect(contras.map((c) => c.valor)).toEqual(['450000', '120000', '80000', '200000', '15000', '3460']);
    expect(contras.map((c) => c.llaveIdempotencia)).toEqual(['contra:mov-1', 'contra:mov-2', 'contra:mov-3', 'contra:mov-4', 'contra:mov-5', 'contra:mov-6']);
    expect(contras.every((c) => c.origen === 'automatico')).toBe(true);
  });

  it('el reverso devuelve también el GMF', async () => {
    // AC3 de la HU #11160. El reverso es genérico —barre las salidas vivas del trámite—, así que el
    // gravamen vuelve sin código nuevo. El test lo fija para que nadie lo excluya por «no ser un
    // concepto del tarifario».
    escenarioSellado();
    await liquidar(TRAMITE, 9);
    escenarioReverso();
    await reversar(TRAMITE, 'Error en el valor del derecho', 9);

    const gmf = entradasEscritas().find((c) => c.concepto === 'gmf');
    expect(gmf).toMatchObject({ tipo: 'entrada', valor: '3460', organismoCodigo: null });
  });

  it('el saldo vuelve a donde estaba antes del sellado', async () => {
    escenarioSellado();
    await liquidar(TRAMITE, 9);
    expect(saldoBolsa).toBe(131540);

    escenarioReverso();
    await reversar(TRAMITE, 'Error en el valor del derecho', 9);
    expect(saldoBolsa).toBe(1_000_000);
  });

  it('el contramovimiento conserva concepto, organismo y trámite del original', async () => {
    // Sin eso, el reporte por organismo seguiría contando un gasto que ya se devolvió.
    escenarioSellado();
    await liquidar(TRAMITE, 9);
    escenarioReverso();
    await reversar(TRAMITE, 'Error en el valor del derecho', 9);

    const soat = entradasEscritas().find((c) => c.concepto === 'soat');
    expect(soat).toMatchObject({ organismoCodigo: '05001', tramiteId: TRAMITE, tipo: 'entrada' });
    expect(String(soat?.observacion)).toContain('Reverso de la liquidación');
  });

  it('la llave de la salida original queda prefijada con rev: y nada más se reescribe', async () => {
    escenarioSellado();
    await liquidar(TRAMITE, 9);
    escenarioReverso();
    await reversar(TRAMITE, 'Error en el valor del derecho', 9);

    const reescrituras = updatesEn('flito_bolsa_movimientos');
    expect(reescrituras).toHaveLength(6);
    expect(reescrituras.map((u) => u.datos.llaveIdempotencia))
      .toEqual(llavesDelSellado().map((ll) => `rev:${ll}`));
    // Lo único que se toca de la fila es la llave: el dinero asentado no se edita jamás.
    expect(reescrituras.every((u) => Object.keys(u.datos).length === 1)).toBe(true);
  });

  it('reversar dos veces no acredita dos veces', async () => {
    // El segundo reverso no encuentra salidas vivas porque el primero les quitó la llave; sin ese
    // filtro, cada reverso repetido regalaría el importe entero.
    escenarioSellado();
    await liquidar(TRAMITE, 9);
    escenarioReverso();
    await reversar(TRAMITE, 'Error en el valor del derecho', 9);
    const saldoTrasReverso = saldoBolsa;

    escenarioReverso();
    await reversar(TRAMITE, 'Reverso repetido por reintento', 9);

    expect(entradasEscritas()).toHaveLength(6);
    expect(saldoBolsa).toBe(saldoTrasReverso);
  });

  it('un trámite sin salidas se reversa sin tocar la bolsa', async () => {
    // Trámite de una compañía sin bolsa, o liquidado antes de esta HU.
    kdb.when
      .select('flito_liquidaciones', [filaLiquidacion])
      .select('flito_bolsa_movimientos', [])
      .select('flito_bolsas', bolsaVigente);

    await reversar(TRAMITE, 'Motivo suficiente', 9);

    expect(insertsEn('flito_bolsa_movimientos')).toHaveLength(0);
    expect(saldoBolsa).toBe(1_000_000);
  });
});

// ───────── CF-07 del Feature #11623: lo conciliado no lo alcanza el reverso ──────────

describe('reversarSalidasLiquidacion — un movimiento de conciliación queda fuera del barrido', () => {
  /**
   * Un movimiento asentado al CONCILIAR una boleta de pago externo (HU #11677): misma llave que la
   * salida del sellado —esa es la decisión del ADR-0006 §2.2— pero `origen = 'conciliacion'`.
   *
   * **Se le pone `tramiteId: TRAMITE` a propósito**, que es justo lo que la conciliación NO hace.
   * Sin eso, el test pasaría por la condición equivocada: quedaría fuera del barrido por no tener
   * trámite y no por su origen, y el día que alguien decidiera poblar `tramite_id` la protección
   * habría desaparecido sin que nada avisara (ADR §3.3, «el aunque su tramite_id sea T es lo
   * importante»).
   */
  function movimientoConciliado(): Fila {
    return {
      id: 'mov-conciliado', tramiteId: TRAMITE, tipo: 'salida', origen: 'conciliacion',
      concepto: 'soat', organismoCodigo: '05001', valor: '450000', saldoResultante: '550000',
      periodo: '2026-07', fecha: '2026-07-30', observacion: 'Conciliación de la boleta BOL-000123',
      soporteId: null, companiaId: COMPANIA, registradoPorNombre: 'laura.restrepo', createdAt: AHORA,
      llaveIdempotencia: `salida:soat:${SOAT_ID}`,
    };
  }

  it('no produce contramovimiento ni le reescribe la llave', async () => {
    libro.push(movimientoConciliado());
    saldoBolsa = 550000;
    kdb.when
      .select('flito_bolsa_movimientos', consultaMovimientos)
      .select('flito_bolsas', bolsaVigente);

    const contras = await reversarSalidasLiquidacion(kdb.db as never, TRAMITE, CTX);

    expect(contras).toEqual([]);
    expect(insertsEn('flito_bolsa_movimientos')).toHaveLength(0);
    expect(updatesEn('flito_bolsa_movimientos')).toHaveLength(0);
    // El dinero de ese SOAT se pagó de verdad en un portal externo: no vuelve (CF-07).
    expect(saldoBolsa).toBe(550000);
    expect(libro[0].llaveIdempotencia).toBe(`salida:soat:${SOAT_ID}`);
  });

  it('sí devuelve las salidas del sellado que conviven con él en el mismo trámite', async () => {
    // El reverso no se rompe ni se salta nada: barre lo suyo y deja lo ajeno.
    libro.push(movimientoConciliado());
    escenarioSellado();
    await liquidar(TRAMITE, 9);
    escenarioReverso();

    const contras = await reversarSalidasLiquidacion(kdb.db as never, TRAMITE, CTX);

    // Cinco: el sellado no asentó el SOAT porque su llave ya estaba ocupada por la conciliación.
    expect(contras.map((c) => c.concepto))
      .toEqual(['impuesto', 'derecho', 'tramite_digital', 'logistica', 'gmf']);
    expect(contras.some((c) => c.concepto === 'soat')).toBe(false);
  });

  it('la consulta del barrido nombra de verdad la columna `origen` en su WHERE', async () => {
    // La simulación filtra por los parámetros REALES, así que ya detectaría que la condición
    // desapareciera; esto lo afirma además sobre el SQL, que es donde vive la garantía.
    const { PgDialect } = await import('drizzle-orm/pg-core');
    let condicion: unknown = null;
    const selectBase = kdb.select.getMockImplementation() as (...a: unknown[]) => Record<string, unknown>;
    kdb.select.mockImplementation((...args: unknown[]) => {
      const c = selectBase(...args);
      const original = c.where as (v: unknown) => unknown;
      c.where = (cond: unknown) => { condicion = cond; return original(cond); };
      return c;
    });
    kdb.when.select('flito_bolsa_movimientos', []).select('flito_bolsas', bolsaVigente);

    await reversarSalidasLiquidacion(kdb.db as never, TRAMITE, CTX);

    const { sql: texto } = new PgDialect().sqlToQuery(condicion as never);
    expect(texto).toContain('"origen"');
    expect(texto).toContain('"tramite_id"');
    expect(texto).toContain('like');
  });
});

describe('reversarSalidasLiquidacion — devuelve lo que asentó', () => {
  it('la lista de contramovimientos permite auditar qué se devolvió', async () => {
    escenarioSellado();
    await liquidar(TRAMITE, 9);

    kdb.when
      .select('flito_bolsa_movimientos', consultaMovimientos)
      .select('flito_bolsas', bolsaVigente);

    const contras = await reversarSalidasLiquidacion(kdb.db as never, TRAMITE, CTX);
    expect(contras.map((c) => c.concepto))
      .toEqual(['soat', 'impuesto', 'derecho', 'tramite_digital', 'logistica', 'gmf']);
    expect(contras.every((c) => c.tipo === 'entrada')).toBe(true);
  });
});

// ─────────────────────────── Ciclo completo ──────────────────────────────────

describe('liquidar → reversar → liquidar: el reverso libera las llaves', () => {
  it('volver a liquidar vuelve a cobrar', async () => {
    // Es la razón de ser del prefijo `rev:`. Sin liberar la llave, el segundo sellado vería el
    // concepto como ya cobrado y el trámite quedaría liquidado sin haber consumido bolsa.
    escenarioSellado();
    await liquidar(TRAMITE, 9);
    escenarioReverso();
    await reversar(TRAMITE, 'Error en el valor del derecho', 9);
    expect(saldoBolsa).toBe(1_000_000);

    escenarioSellado();
    await liquidar(TRAMITE, 9);

    // Doce salidas en total: seis del primer sellado y seis del segundo, con llaves nuevas que
    // ya no chocan con las reversadas.
    expect(salidasEscritas()).toHaveLength(12);
    expect(salidasEscritas().slice(6).map((s) => s.llaveIdempotencia)).toEqual(llavesDelSellado());
    expect(saldoBolsa).toBe(131540);
  });

  it('el libro conserva las quince líneas: nada se borró por el camino', async () => {
    escenarioSellado();
    await liquidar(TRAMITE, 9);
    escenarioReverso();
    await reversar(TRAMITE, 'Error en el valor del derecho', 9);
    escenarioSellado();
    await liquidar(TRAMITE, 9);

    // 6 salidas + 6 contramovimientos + 6 salidas nuevas. El extracto explica el saldo entero.
    expect(libro).toHaveLength(18);
    // Las seis primeras siguen ahí, con su llave reversada: el reverso no borró ninguna línea.
    expect(libro.slice(0, 6).map((f) => f.llaveIdempotencia))
      .toEqual(llavesDelSellado().map((ll) => `rev:${ll}`));
  });
});
