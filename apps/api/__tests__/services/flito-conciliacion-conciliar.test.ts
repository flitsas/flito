// FLITO Conciliación — conciliar una boleta y descontar las bolsas SIN doble cobro (HU #11677).
//
// Es la HU del dinero, así que este archivo no prueba el servicio contra respuestas fijadas a mano:
// simula CON ESTADO los dos libros, los dos saldos, las líneas y la boleta, y hace pasar por encima
// **las operaciones reales** —`conciliarBoleta`, `liquidar` y `reversar`—. Los dos órdenes del
// ADR-0006 §2.3 se prueban ejecutándolos de verdad, uno detrás de otro, sobre el mismo estado:
//
//   · orden 1 (AC4): conciliar → liquidar   → el sellado NO vuelve a descontar
//   · orden 2 (AC5): liquidar  → conciliar  → conciliar NO vuelve a descontar y ADOPTA el movimiento
//   · AC7:           …y después reversar    → el reverso NO devuelve lo conciliado, en los dos casos
//
// Sin ese encadenamiento, cada mitad se podría afirmar por separado con mocks que dijeran lo que el
// test quiere oír, y el fallo caro —cobrar dos veces, o devolver dinero que sí se gastó— vive
// justamente en la juntura.
//
// **La transacción se simula con rollback de verdad** (`kdb.transaction` toma una instantánea del
// estado y la restaura si el callback lanza). Es lo único que permite afirmar el AC3 —«todo o nada»—
// en vez de comprobar que se llamó a `db.transaction`, que no demuestra nada.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { createKeyedDb, type Resolver } from '../helpers/keyed-db.js';

const kdb = createKeyedDb({ transaction: 'manual' });

vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const tarifaDeMock = vi.fn();
vi.mock('../../src/modules/flito-parametrizacion/flito-tarifas.service.js', () => ({
  tarifaDe: tarifaDeMock,
}));

const { conciliarBoleta } =
  await import('../../src/modules/flito-conciliacion/flito-conciliacion.conciliar.service.js');
const { liquidar, reversar } =
  await import('../../src/modules/flito-liquidacion/flito-liquidacion.service.js');

// ─────────────────────────── Constantes del escenario ────────────────────────

const COMPANIA = 7;
const BOLETA = 'b0000000-0000-4000-8000-000000000001';
const LINEA_A = '11110000-0000-4000-8000-00000000000a';
const LINEA_B = '11110000-0000-4000-8000-00000000000b';
const SOAT_A = '50a70000-0000-4000-8000-00000000000a';
const SOAT_B = '50a70000-0000-4000-8000-00000000000b';
const TRAMITE = 'aaaaaaaa-0000-0000-0000-000000000001';
const IMPUESTO_ID = 'cccccccc-0000-0000-0000-000000000003';
const DERECHO_ID = 'dddddddd-0000-0000-0000-000000000004';
const BOLSA_CLIENTE = 'cccc0000-0000-4000-8000-000000000001';
const BOLSA_TRANSITO = 'ddd00000-0000-4000-8000-000000000001';

/** Secretaría CUBIERTA por una bolsa de tránsito para el concepto `soat`. */
const ORG_CUBIERTO = '05001';
/** Secretaría que NO está en ninguna bolsa: su línea descuenta solo la del cliente (AC1). */
const ORG_SIN_BOLSA = '11001';

const VALOR_A = 450_000;
const VALOR_B = 300_000;
const FECHA_PAGO = '2026-07-30';
const AHORA = new Date('2026-08-20T15:00:00Z');
const CTX = { userId: 9, nombre: 'laura.restrepo' };

// ─────────────────────────── Estado simulado ─────────────────────────────────

type Fila = Record<string, unknown>;

interface EstadoBd {
  saldoCliente: number;
  saldoTransito: number;
  /** `flito_bolsa_movimientos`: lo que ven los pre-chequeos de idempotencia y el reverso. */
  libroCliente: Fila[];
  /** `flito_bolsa_transito_movimientos`. */
  libroTransito: Fila[];
  boleta: Fila;
  lineas: Fila[];
  soats: Fila[];
  /** Parejas (secretaría, concepto) que cubre la bolsa de tránsito. */
  cobertura: Array<{ organismoCodigo: string; concepto: string }>;
  liquidaciones: Fila[];
}

let bd: EstadoBd;
let secuenciaCliente = 0;
let secuenciaTransito = 0;

function boletaInicial(): Fila {
  return {
    id: BOLETA,
    referencia: 'BOL-000123',
    companiaId: COMPANIA,
    concepto: 'soat',
    estado: 'cargada',
    archivoNombre: 'REPORTE SOAT.xlsx',
    filas: 2,
    totalDeclarado: String(VALOR_A + VALOR_B) + '.00',
    totalCruzado: String(VALOR_A + VALOR_B) + '.00',
    fechaPago: FECHA_PAGO,
    cargadaPorNombre: 'financiera@flit.io',
    conciliadaEn: null,
    conciliadaPorId: null,
    conciliadaPorNombre: null,
    createdAt: AHORA,
  };
}

function lineasIniciales(): Fila[] {
  return [
    {
      id: LINEA_A, filaNumero: 1, numeroPolizaNorm: 'POL0001',
      valorDeclarado: `${VALOR_A}.00`, soatId: SOAT_A, resultado: 'ok', detalle: null,
      conciliadaEn: null, movimientoBolsaId: null, movimientoTransitoId: null,
    },
    {
      id: LINEA_B, filaNumero: 2, numeroPolizaNorm: 'POL0002',
      valorDeclarado: `${VALOR_B}.00`, soatId: SOAT_B, resultado: 'ok', detalle: null,
      conciliadaEn: null, movimientoBolsaId: null, movimientoTransitoId: null,
    },
  ];
}

/** Los dos SOAT tal como los proyecta `seleccionSoat()`, con su organismo congelado. */
function soatsIniciales(): Fila[] {
  return [
    {
      id: SOAT_A, numeroPoliza: 'POL0001', estado: 'pagado', valorPagado: `${VALOR_A}.00`,
      companiaId: COMPANIA, companiaNombre: 'Transportes Andinos S.A.S.', placa: 'ABC123',
      organismoCodigo: ORG_CUBIERTO,
    },
    {
      id: SOAT_B, numeroPoliza: 'POL0002', estado: 'pagado', valorPagado: `${VALOR_B}.00`,
      companiaId: COMPANIA, companiaNombre: 'Transportes Andinos S.A.S.', placa: 'DEF456',
      organismoCodigo: ORG_SIN_BOLSA,
    },
  ];
}

function estadoInicial(): EstadoBd {
  return {
    saldoCliente: 10_000_000,
    saldoTransito: 5_000_000,
    libroCliente: [],
    libroTransito: [],
    boleta: boletaInicial(),
    lineas: lineasIniciales(),
    soats: soatsIniciales(),
    cobertura: [{ organismoCodigo: ORG_CUBIERTO, concepto: 'soat' }],
    liquidaciones: [],
  };
}

// ─────────────────────────── Espía de escrituras ─────────────────────────────

interface Mutacion { tabla: string; datos: Fila; filtros: string[]; }

const inserts: Mutacion[] = [];
const updates: Mutacion[] = [];

function nombreTabla(tbl: unknown): string {
  try { return getTableName(tbl as never); } catch { return '__expr__'; }
}

/** Valores enlazados del `where` en curso: es lo único que dice POR QUÉ LLAVE se está preguntando. */
let ultimosFiltros: string[] = [];

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

/**
 * Refleja en la simulación lo que un UPDATE acaba de escribir.
 *
 * Se aplica en el `where` y no en el `set` —al revés que en los tests hermanos— porque aquí hay
 * UPDATE cuyo payload no identifica la fila: la adopción escribe `{ origen: 'conciliacion' }` y sin
 * el `where` no habría forma de saber a qué movimiento se refiere. Esa es exactamente la condición
 * que este archivo tiene que poder afirmar.
 */
function aplicar(tabla: string, datos: Fila, filtros: string[]): void {
  const id = filtros[0];
  if (tabla === 'flito_bolsas' && typeof datos.saldo === 'string') {
    bd.saldoCliente = Number(datos.saldo);
    return;
  }
  if (tabla === 'flito_bolsas_transito' && typeof datos.saldo === 'string') {
    bd.saldoTransito = Number(datos.saldo);
    return;
  }
  const destino: Record<string, Fila[]> = {
    flito_bolsa_movimientos: bd.libroCliente,
    flito_bolsa_transito_movimientos: bd.libroTransito,
    flito_conciliacion_lineas: bd.lineas,
    flito_conciliacion_boletas: [bd.boleta],
  };
  const filas = destino[tabla];
  if (!filas) return;
  const fila = filas.find((f) => f.id === id);
  if (fila) Object.assign(fila, datos);
}

function espiar(): void {
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
    const original = c.values as (v: Fila) => unknown;
    c.values = (v: Fila) => {
      inserts.push({ tabla: nombreTabla(tbl), datos: v, filtros: [] });
      return original(v);
    };
    return c;
  });

  const updateBase = kdb.update.getMockImplementation() as (t: unknown) => Record<string, unknown>;
  kdb.update.mockImplementation((tbl: unknown) => {
    const c = updateBase(tbl);
    const tabla = nombreTabla(tbl);
    const setOriginal = c.set as (v: Fila) => unknown;
    const whereOriginal = c.where as (v: unknown) => unknown;
    let datos: Fila = {};
    c.set = (v: Fila) => {
      datos = v;
      updates.push({ tabla, datos: v, filtros: [] });
      return setOriginal(v);
    };
    c.where = (cond: unknown) => {
      const filtros = paramsDe(cond);
      const m = updates.at(-1);
      if (m && m.datos === datos) m.filtros = filtros;
      aplicar(tabla, datos, filtros);
      return whereOriginal(cond);
    };
    return c;
  });
}

const insertsEn = (tabla: string) => inserts.filter((m) => m.tabla === tabla);
const updatesEn = (tabla: string) => updates.filter((m) => m.tabla === tabla);
const salidasCliente = () => insertsEn('flito_bolsa_movimientos').map((m) => m.datos)
  .filter((d) => d.tipo === 'salida');
const entradasCliente = () => insertsEn('flito_bolsa_movimientos').map((m) => m.datos)
  .filter((d) => d.tipo === 'entrada');
const movsTransito = () => insertsEn('flito_bolsa_transito_movimientos').map((m) => m.datos);

// ─────────────────────────── Resolvers por tabla ─────────────────────────────

/**
 * `flito_bolsa_movimientos` tiene TRES consultas distintas y se distinguen por su filtro:
 *   · un solo parámetro                → pre-chequeo de idempotencia por llave;
 *   · el último es 'automatico'        → el `descontados` del cruce (llaves… + origen);
 *   · el último es 'salida'            → el barrido del reverso (trámite + origen + tipo + like).
 */
const consultaLibroCliente: Resolver = () => {
  const f = ultimosFiltros;
  if (f.length === 1) {
    const fila = bd.libroCliente.find((x) => x.llaveIdempotencia === f[0]);
    return fila ? [fila] : [];
  }
  if (f[f.length - 1] === 'salida') {
    const tramite = f[0];
    return bd.libroCliente.filter((x) =>
      x.tramiteId === tramite && x.origen === 'automatico' && x.tipo === 'salida'
      && String(x.llaveIdempotencia).startsWith('salida:'));
  }
  const llaves = f.slice(0, -1);
  return bd.libroCliente
    .filter((x) => llaves.includes(String(x.llaveIdempotencia)) && x.origen === 'automatico')
    .map((x) => ({ llave: x.llaveIdempotencia }));
};

/** Igual, con dos consultas: por llave (1 parámetro) o el barrido del reverso de tránsito. */
const consultaLibroTransito: Resolver = () => {
  const f = ultimosFiltros;
  if (f.length === 1) {
    const fila = bd.libroTransito.find((x) => x.llaveIdempotencia === f[0]);
    return fila ? [fila] : [];
  }
  const tramite = f[0];
  return bd.libroTransito.filter((x) =>
    x.tramiteId === tramite && x.origen === 'automatico' && x.tipo === 'salida'
    && String(x.llaveIdempotencia).startsWith('consumo:'));
};

/** `bolsaQueCubre`: el índice único garantiza que como mucho salga una fila. */
const consultaCobertura: Resolver = () => {
  const [organismoCodigo, concepto] = ultimosFiltros;
  const hay = bd.cobertura.some((c) =>
    c.organismoCodigo === organismoCodigo && c.concepto === concepto);
  return hay ? [{ id: BOLSA_TRANSITO, nombre: 'Bolsa de tránsito de Medellín' }] : [];
};

/** Sirve al `FOR UPDATE` del asiento y a la lectura final del saldo: la proyección es compatible. */
const consultaBolsasTransito: Resolver = () => {
  const ids = ultimosFiltros;
  if (!ids.includes(BOLSA_TRANSITO)) return [];
  return [{
    id: BOLSA_TRANSITO,
    nombre: 'Bolsa de tránsito de Medellín',
    saldo: String(bd.saldoTransito),
  }];
};

/** La bolsa del cliente se filtra por un `companiaId` numérico, así que no llega ningún parámetro. */
const consultaBolsaCliente: Resolver = () =>
  [{ id: BOLSA_CLIENTE, saldo: String(bd.saldoCliente) }];

/**
 * `flito_conciliacion_lineas` se consulta de dos formas: las líneas de la boleta (un solo filtro, el
 * id de la boleta) y las conciliadas en OTRA boleta, que es el diagnóstico de `ya_conciliada`.
 */
const consultaLineas: Resolver = () => {
  if (ultimosFiltros.length === 1) return bd.lineas.map((l) => ({ ...l }));
  return [];
};

const consultaBoleta: Resolver = () => [{ ...bd.boleta }];
const consultaSoat: Resolver = () => bd.soats.map((s) => ({ ...s }));
const consultaCliente: Resolver = () => [{ nombre: 'Transportes Andinos S.A.S.' }];

// ─────────────────────────── Filas del sellado ───────────────────────────────

function filaCalculo(over: Fila = {}): Fila {
  return {
    tramiteId: TRAMITE, idFlit: 'FLIT-1', tipoTramite: 'Traspaso', companiaId: COMPANIA,
    logisticaAutogestionable: false, soatAutogestionable: false, impuestosAutogestionable: false,
    modalidadOrganismo: 'requiere_gestion',
    soatId: SOAT_A, soatEstado: 'pagado', soatValorPagado: String(VALOR_A),
    impuestoId: IMPUESTO_ID, impuestoEstado: 'pagado', impuestoValorPagado: '120000',
    derechoValor: '80000',
    ...over,
  };
}

function filaIdentificadores(over: Fila = {}): Fila {
  return {
    companiaId: COMPANIA,
    soatId: SOAT_A, soatOrganismo: ORG_CUBIERTO,
    impuestoId: IMPUESTO_ID, impuestoOrganismo: '11001',
    derechoId: DERECHO_ID, derechoOrganismo: '05266',
    ...over,
  };
}

/** Base gravable del trámite de prueba: 450.000 + 120.000 + 80.000 + 200.000 + 15.000. */
const BASE_GMF = VALOR_A + 120_000 + 80_000 + 200_000 + 15_000;
const GMF = Math.round(BASE_GMF * 0.004 * 100) / 100;

const filaLiquidacion: Fila = {
  id: 'eeeeeeee-0000-0000-0000-000000000005', tramiteId: TRAMITE, estado: 'liquidado',
  valorSoat: String(VALOR_A), valorImpuesto: '120000', valorDerecho: '80000',
  valorTramiteDigital: '200000', valorLogistica: '15000',
  baseGmf: String(BASE_GMF), tasaGmf: '0.004', valorGmf: String(GMF),
  total: String(BASE_GMF + GMF), detalle: {}, liquidadoEn: AHORA, facturadoEn: null,
};

/** Deja el mock listo para conciliar. Es el escenario por defecto de casi todos los tests. */
function escenarioConciliacion(): void {
  kdb.when
    .select('flito_conciliacion_boletas', consultaBoleta)
    .select('flito_conciliacion_lineas', consultaLineas)
    .select('flito_soat', consultaSoat)
    .select('clients', consultaCliente)
    .select('flito_bolsa_movimientos', consultaLibroCliente)
    .select('flito_bolsas', consultaBolsaCliente)
    .select('flito_bolsa_cierres', [])
    .select('flito_bolsa_transito_cobertura', consultaCobertura)
    .select('flito_bolsas_transito', consultaBolsasTransito)
    .select('flito_bolsa_transito_movimientos', consultaLibroTransito)
    .update('flito_conciliacion_lineas', [])
    .update('flito_conciliacion_boletas', []);
}

/** Y para sellar: los dos SELECT sobre `flito_tramites` van encolados, con proyecciones distintas. */
function escenarioSellado(calculo: Fila = {}, ids: Fila = {}): void {
  escenarioConciliacion();
  kdb.when
    .select('flito_liquidaciones', () => bd.liquidaciones.map((l) => ({ ...l })))
    .selectOnce('flito_tramites', [filaCalculo(calculo)])
    .selectOnce('flito_tramites', [filaIdentificadores(ids)])
    .insert('flito_liquidaciones', () => { bd.liquidaciones = [filaLiquidacion]; return [filaLiquidacion]; })
    .insert('flito_liquidacion_eventos', [])
    .delete('flito_liquidaciones', () => { bd.liquidaciones = []; return []; });
}

// ─────────────────────────── Arranque ────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(AHORA);
  kdb.reset();
  inserts.length = 0;
  updates.length = 0;
  ultimosFiltros = [];
  secuenciaCliente = 0;
  secuenciaTransito = 0;
  bd = estadoInicial();
  tarifaDeMock.mockReset();
  tarifaDeMock.mockImplementation(async (_c: unknown, concepto: string) =>
    concepto === 'tramite_digital'
      ? { valor: 200000, origen: 'especifica' }
      : { valor: 15000, origen: 'generica' });
  espiar();

  // La transacción, con ROLLBACK REAL sobre el estado simulado. Es lo que hace afirmable el AC3.
  kdb.transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => {
    const snapshot = structuredClone(bd);
    try {
      return await cb(kdb.db);
    } catch (e) {
      bd = snapshot;
      throw e;
    }
  });

  // `returning()` devuelve la fila que el servicio acaba de escribir y la deja en el libro: los
  // pre-chequeos y el reverso trabajan después sobre ella, igual que contra la tabla real.
  kdb.when.insert('flito_bolsa_movimientos', () => {
    const datos = insertsEn('flito_bolsa_movimientos').at(-1)?.datos ?? {};
    const fila: Fila = { id: `mov-${++secuenciaCliente}`, createdAt: AHORA, ...datos };
    bd.libroCliente.push(fila);
    return [fila];
  });
  kdb.when.insert('flito_bolsa_transito_movimientos', () => {
    const datos = insertsEn('flito_bolsa_transito_movimientos').at(-1)?.datos ?? {};
    const fila: Fila = { id: `tra-${++secuenciaTransito}`, createdAt: AHORA, ...datos };
    bd.libroTransito.push(fila);
    return [fila];
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// ─────────────────────────── AC1 ─────────────────────────────────────────────

describe('conciliar — AC1: el descuento ocurre en la conciliación', () => {
  it('una salida por línea en la bolsa del cliente, con origen conciliacion y sin trámite', async () => {
    escenarioConciliacion();
    await conciliarBoleta(BOLETA, CTX);

    const salidas = salidasCliente();
    expect(salidas).toHaveLength(2);
    expect(salidas.map((s) => s.concepto)).toEqual(['soat', 'soat']);
    // El valor sale de `flito_soat.valor_pagado`, NUNCA de la columna del Excel (RN-03, ADR §2.6).
    expect(salidas.map((s) => s.valor)).toEqual([String(VALOR_A), String(VALOR_B)]);
    expect(salidas.every((s) => s.origen === 'conciliacion')).toBe(true);
    // `tramite_id` NULL: un SOAT tiene N trámites y no hay uno «correcto» que poner (ADR §4.1).
    expect(salidas.every((s) => s.tramiteId === null)).toBe(true);
  });

  it('la llave es la MISMA que reserva el sellado de la liquidación', async () => {
    // Es la decisión central del ADR §2.2: la garantía anti doble cobro la pone el índice único de
    // PostgreSQL, no un `if`. Si alguien cambiara este prefijo, el sellado volvería a cobrar.
    escenarioConciliacion();
    await conciliarBoleta(BOLETA, CTX);

    expect(salidasCliente().map((s) => s.llaveIdempotencia))
      .toEqual([`salida:soat:${SOAT_A}`, `salida:soat:${SOAT_B}`]);
    expect(movsTransito().map((m) => m.llaveIdempotencia)).toEqual([`consumo:soat:${SOAT_A}`]);
  });

  it('el saldo del cliente baja por la suma y cada asiento parte del que dejó el anterior', async () => {
    escenarioConciliacion();
    await conciliarBoleta(BOLETA, CTX);

    // En serie: el `saldo_resultante` de la última línea tiene que ser el saldo real de la bolsa,
    // que es lo que el extracto usa para auditar sin recalcular.
    expect(salidasCliente().map((s) => s.saldoResultante))
      .toEqual([String(10_000_000 - VALOR_A), String(10_000_000 - VALOR_A - VALOR_B)]);
    expect(bd.saldoCliente).toBe(10_000_000 - VALOR_A - VALOR_B);
  });

  it('la bolsa de tránsito solo descuenta la línea cuyo organismo está cubierto', async () => {
    escenarioConciliacion();
    await conciliarBoleta(BOLETA, CTX);

    // AC1: una línea sin cobertura de tránsito descuenta solo la del cliente, SIN error.
    expect(movsTransito()).toHaveLength(1);
    expect(movsTransito()[0]).toMatchObject({
      organismoCodigo: ORG_CUBIERTO, concepto: 'soat', tipo: 'salida',
      origen: 'conciliacion', tramiteId: null, valor: String(VALOR_A),
    });
    expect(bd.saldoTransito).toBe(5_000_000 - VALOR_A);
  });

  it('la fecha contable es la del PAGO en el portal, no la de hoy', async () => {
    // Un pago del 30 que se concilia el 20 del mes siguiente pertenece al mes del pago: es lo que
    // decide a qué periodo se imputa el dinero en el cierre.
    escenarioConciliacion();
    await conciliarBoleta(BOLETA, CTX);

    expect(salidasCliente().every((s) => s.fecha === FECHA_PAGO)).toBe(true);
    expect(movsTransito()[0].fecha).toBe(FECHA_PAGO);
  });

  it('la observación nombra la boleta y NO lleva placa, VIN ni número de póliza', async () => {
    // La observación acaba en el .xlsx que exporta el extracto, que es un archivo que sale del
    // sistema (ADR §4.2). Por eso existe la referencia legible.
    escenarioConciliacion();
    await conciliarBoleta(BOLETA, CTX);

    for (const s of salidasCliente()) {
      expect(s.observacion).toBe('Conciliación de la boleta BOL-000123');
      expect(String(s.observacion)).not.toContain('ABC123');
      expect(String(s.observacion)).not.toContain('POL0001');
    }
  });

  it('la boleta queda conciliada con actor y fecha, y cada línea con su movimiento', async () => {
    escenarioConciliacion();
    await conciliarBoleta(BOLETA, CTX);

    expect(bd.boleta).toMatchObject({
      estado: 'conciliada', conciliadaEn: AHORA, conciliadaPorId: 9,
      conciliadaPorNombre: 'laura.restrepo',
    });
    expect(bd.lineas.map((l) => l.conciliadaEn)).toEqual([AHORA, AHORA]);
    // Trazabilidad: la línea del organismo cubierto amarra los DOS movimientos; la otra solo el del
    // cliente, porque no hubo consumo de tránsito que amarrar.
    expect(bd.lineas[0]).toMatchObject({ movimientoBolsaId: 'mov-1', movimientoTransitoId: 'tra-1' });
    expect(bd.lineas[1]).toMatchObject({ movimientoBolsaId: 'mov-2', movimientoTransitoId: null });
  });

  it('la respuesta trae lo que el aviso de éxito necesita decir', async () => {
    escenarioConciliacion();
    const r = await conciliarBoleta(BOLETA, CTX);

    expect(r.soatConciliados).toBe(2);
    expect(r.totalConciliado).toBe(VALOR_A + VALOR_B);
    expect(r.cliente).toEqual({
      companiaId: COMPANIA,
      nombre: 'Transportes Andinos S.A.S.',
      descontado: VALOR_A + VALOR_B,
      saldoResultante: 10_000_000 - VALOR_A - VALOR_B,
    });
    // Una línea por bolsa de tránsito tocada, con su nombre y su saldo resultante.
    expect(r.transito).toEqual([{
      bolsaId: BOLSA_TRANSITO,
      nombre: 'Bolsa de tránsito de Medellín',
      descontado: VALOR_A,
      saldoResultante: 5_000_000 - VALOR_A,
    }]);
    expect(r.adoptados).toEqual([]);
    expect(r.boleta).toMatchObject({
      estado: 'conciliada', referencia: 'BOL-000123', sinCuadrar: 0,
      conciliadaPorNombre: 'laura.restrepo',
    });
    expect(r.boleta.lineas.every((l) => l.conciliadaEn !== null)).toBe(true);
  });

  it('sin ninguna bolsa de tránsito que cubra, se concilia igual y `transito` viene vacío', async () => {
    bd.cobertura = [];
    escenarioConciliacion();
    const r = await conciliarBoleta(BOLETA, CTX);

    expect(r.transito).toEqual([]);
    expect(movsTransito()).toHaveLength(0);
    expect(bd.boleta.estado).toBe('conciliada');
    expect(bd.saldoCliente).toBe(10_000_000 - VALOR_A - VALOR_B);
  });
});

// ─────────────────────────── AC2 ─────────────────────────────────────────────

describe('conciliar — AC2: una línea que no cuadra para la boleta entera', () => {
  it('409 boleta_incompleta con el detalle, y ninguna bolsa se mueve', async () => {
    // El SOAT dejó de estar pagado entre la carga y el clic: el re-cruce DENTRO de la transacción
    // lo detecta aunque el botón estuviera habilitado.
    bd.soats[1].estado = 'anulado';
    escenarioConciliacion();

    await expect(conciliarBoleta(BOLETA, CTX)).rejects.toMatchObject({
      estado: 409, codigo: 'boleta_incompleta',
    });

    expect(insertsEn('flito_bolsa_movimientos')).toHaveLength(0);
    expect(insertsEn('flito_bolsa_transito_movimientos')).toHaveLength(0);
    expect(bd.saldoCliente).toBe(10_000_000);
    expect(bd.saldoTransito).toBe(5_000_000);
    expect(bd.boleta.estado).toBe('cargada');
    expect(bd.lineas.every((l) => l.conciliadaEn === null)).toBe(true);
  });

  it('el cuerpo del 409 trae la boleta con el cuadre YA ACTUALIZADO', async () => {
    // La pantalla repinta la tabla con lo que trae el 409, no con lo que tenía. Si el re-cruce se
    // hubiera perdido con un rollback, el usuario vería los resultados viejos y no entendería nada.
    bd.soats[1].estado = 'anulado';
    escenarioConciliacion();

    const error = await conciliarBoleta(BOLETA, CTX)
      .catch((e) => e as { extra: Record<string, unknown> });
    const boleta = error.extra.boleta as { sinCuadrar: number; lineas: Array<{ resultado: string }> };

    expect(error.extra.sinCuadrar).toBe(1);
    expect(boleta.sinCuadrar).toBe(1);
    expect(boleta.lineas.map((l) => l.resultado)).toEqual(['ok', 'no_pagado']);
  });

  it('el re-cruce SÍ se persiste: la transacción hizo commit antes de rechazar', async () => {
    bd.soats[1].estado = 'anulado';
    escenarioConciliacion();

    await conciliarBoleta(BOLETA, CTX).catch(() => undefined);

    expect(bd.lineas[1].resultado).toBe('no_pagado');
    expect(updatesEn('flito_conciliacion_lineas')).toHaveLength(1);
  });
});

// ─────────────────────────── AC3 ─────────────────────────────────────────────

describe('conciliar — AC3: todo o nada', () => {
  it('si el asiento de la última línea falla, ninguna de las anteriores queda asentada', async () => {
    escenarioConciliacion();
    // La segunda salida revienta al escribir, como reventaría un 23514 o un fallo de red.
    kdb.when.insert('flito_bolsa_movimientos', () => {
      const datos = insertsEn('flito_bolsa_movimientos').at(-1)?.datos ?? {};
      if (datos.llaveIdempotencia === `salida:soat:${SOAT_B}`) throw new Error('fallo al asentar');
      const fila: Fila = { id: `mov-${++secuenciaCliente}`, createdAt: AHORA, ...datos };
      bd.libroCliente.push(fila);
      return [fila];
    });

    await expect(conciliarBoleta(BOLETA, CTX)).rejects.toThrow('fallo al asentar');

    // La transacción se deshizo entera: ni el libro, ni los saldos, ni las líneas, ni la boleta.
    expect(bd.libroCliente).toHaveLength(0);
    expect(bd.libroTransito).toHaveLength(0);
    expect(bd.saldoCliente).toBe(10_000_000);
    expect(bd.saldoTransito).toBe(5_000_000);
    expect(bd.boleta.estado).toBe('cargada');
    expect(bd.lineas.every((l) => l.conciliadaEn === null)).toBe(true);
  });
});

// ─────────────────────────── AC4 — orden 1 ───────────────────────────────────

describe('AC4 · orden 1: concilio y DESPUÉS liquido', () => {
  it('el sellado no vuelve a descontar el SOAT ni en el cliente ni en tránsito', async () => {
    escenarioSellado();
    await conciliarBoleta(BOLETA, CTX);
    const saldoTrasConciliar = bd.saldoCliente;
    const transitoTrasConciliar = bd.saldoTransito;
    inserts.length = 0;

    await liquidar(TRAMITE, 9);

    // El SOAT no aparece entre las salidas del sellado: su llave ya estaba ocupada.
    expect(salidasCliente().map((s) => s.concepto))
      .toEqual(['impuesto', 'derecho', 'tramite_digital', 'logistica', 'gmf']);
    // Y el saldo bajó solo por los OTROS conceptos.
    expect(saldoTrasConciliar - bd.saldoCliente).toBe(120_000 + 80_000 + 200_000 + 15_000 + GMF);
    // La bolsa de tránsito tampoco vuelve a consumir por el SOAT.
    expect(movsTransito().some((m) => m.llaveIdempotencia === `consumo:soat:${SOAT_A}`)).toBe(false);
    expect(bd.saldoTransito).toBe(transitoTrasConciliar);
  });

  it('el GMF NO cambia: se sigue calculando sobre el subtotal al sellar', async () => {
    // Es explícito en el AC4 y es lo que evita que esta HU se filtre a `flito-liquidacion`: el
    // gravamen se calcula sobre la base COMPLETA, incluido el SOAT que aquí no se descuenta.
    escenarioSellado();
    await conciliarBoleta(BOLETA, CTX);
    inserts.length = 0;

    const dto = await liquidar(TRAMITE, 9);

    expect(dto.baseGmf).toBe(BASE_GMF);
    expect(dto.valorGmf).toBe(GMF);
    expect(dto.total).toBe(BASE_GMF + GMF);
    // Y el total sellado incluye el SOAT, que es lo que se le factura al cliente.
    expect(dto.soat.valor).toBe(VALOR_A);
    expect(salidasCliente().find((s) => s.concepto === 'gmf')?.valor).toBe(String(GMF));
  });

  it('la liquidación se sella igual: el descuento previo no la bloquea', async () => {
    escenarioSellado();
    await conciliarBoleta(BOLETA, CTX);

    await expect(liquidar(TRAMITE, 9)).resolves.toMatchObject({ estado: 'liquidado' });
  });
});

// ─────────────────────────── AC5 — orden 2 ───────────────────────────────────

describe('AC5 · orden 2: liquido y DESPUÉS concilio', () => {
  it('conciliar no asienta nada nuevo y el saldo no se mueve dos veces', async () => {
    escenarioSellado();
    await liquidar(TRAMITE, 9);
    const saldoTrasSellar = bd.saldoCliente;
    const transitoTrasSellar = bd.saldoTransito;
    inserts.length = 0;

    const r = await conciliarBoleta(BOLETA, CTX);

    // Solo se asienta la línea B, cuyo SOAT no participó en ese trámite.
    expect(salidasCliente().map((s) => s.llaveIdempotencia)).toEqual([`salida:soat:${SOAT_B}`]);
    expect(saldoTrasSellar - bd.saldoCliente).toBe(VALOR_B);
    expect(bd.saldoTransito).toBe(transitoTrasSellar);
    // El aviso lo dice con números: se conciliaron los dos, pero HOY solo salió uno.
    expect(r.totalConciliado).toBe(VALOR_A + VALOR_B);
    expect(r.cliente.descontado).toBe(VALOR_B);
    expect(r.transito[0].descontado).toBe(0);
  });

  it('el movimiento existente se ADOPTA: pasa a origen conciliacion, en los dos libros', async () => {
    escenarioSellado();
    await liquidar(TRAMITE, 9);
    updates.length = 0;

    const r = await conciliarBoleta(BOLETA, CTX);

    const movSoat = bd.libroCliente.find((m) => m.llaveIdempotencia === `salida:soat:${SOAT_A}`);
    expect(movSoat).toMatchObject({ origen: 'conciliacion', tramiteId: TRAMITE });
    const consumo = bd.libroTransito.find((m) => m.llaveIdempotencia === `consumo:soat:${SOAT_A}`);
    expect(consumo).toMatchObject({ origen: 'conciliacion' });

    // La llave NO se toca: sigue reservada, así que un segundo sellado tampoco podría cobrar.
    const adopciones = updatesEn('flito_bolsa_movimientos');
    expect(adopciones).toHaveLength(1);
    expect(adopciones[0].datos).toEqual({ origen: 'conciliacion' });

    expect(r.adoptados).toHaveLength(1);
    expect(r.adoptados[0]).toMatchObject({
      lineaId: LINEA_A, filaNumero: 1, soatId: SOAT_A, valor: VALOR_A, adoptado: true,
    });
  });

  it('la línea queda conciliada y amarrada al movimiento que ya existía', async () => {
    escenarioSellado();
    await liquidar(TRAMITE, 9);

    await conciliarBoleta(BOLETA, CTX);

    const movSoat = bd.libroCliente.find((m) => m.llaveIdempotencia === `salida:soat:${SOAT_A}`);
    expect(bd.lineas[0]).toMatchObject({
      conciliadaEn: AHORA, movimientoBolsaId: movSoat?.id,
    });
    expect(bd.boleta.estado).toBe('conciliada');
  });

  it('la línea adoptada deja de anunciarse como «ya descontado al liquidar»', async () => {
    // El aviso lo cuenta con `adoptados`. Si además el flag de la línea siguiera en `true`, la
    // pantalla diría dos veces lo mismo y —peor— al recargar diría otra cosa, porque el movimiento
    // ya no es `automatico`.
    escenarioSellado();
    await liquidar(TRAMITE, 9);

    const r = await conciliarBoleta(BOLETA, CTX);

    expect(r.boleta.lineas.map((l) => l.yaDescontadoEnLiquidacion)).toEqual([false, false]);
  });
});

// ─────────────────────────── AC6 ─────────────────────────────────────────────

describe('conciliar — AC6: conciliar dos veces', () => {
  it('el segundo intento es 409 y ningún saldo cambia', async () => {
    escenarioConciliacion();
    await conciliarBoleta(BOLETA, CTX);
    const saldo = bd.saldoCliente;
    const transito = bd.saldoTransito;
    inserts.length = 0;
    updates.length = 0;

    await expect(conciliarBoleta(BOLETA, CTX)).rejects.toMatchObject({
      estado: 409, codigo: 'boleta_ya_conciliada',
    });

    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(bd.saldoCliente).toBe(saldo);
    expect(bd.saldoTransito).toBe(transito);
    expect(bd.libroCliente).toHaveLength(2);
  });

  it('una boleta descartada tampoco se concilia', async () => {
    bd.boleta.estado = 'descartada';
    escenarioConciliacion();

    await expect(conciliarBoleta(BOLETA, CTX)).rejects.toMatchObject({
      estado: 409, codigo: 'boleta_descartada',
    });
    expect(inserts).toHaveLength(0);
  });
});

// ─────────────────────────── AC7 ─────────────────────────────────────────────

describe('AC7 · reversar la liquidación NO devuelve lo conciliado', () => {
  it('orden 1 · el reverso alcanza los otros conceptos pero no el SOAT conciliado', async () => {
    escenarioSellado();
    await conciliarBoleta(BOLETA, CTX);
    await liquidar(TRAMITE, 9);
    const saldoTrasLiquidar = bd.saldoCliente;
    inserts.length = 0;

    await reversar(TRAMITE, 'Error en el valor del derecho', 9);

    // Cinco contramovimientos: los cinco conceptos del sellado. El SOAT no está.
    expect(entradasCliente().map((c) => c.concepto))
      .toEqual(['impuesto', 'derecho', 'tramite_digital', 'logistica', 'gmf']);
    expect(bd.saldoCliente - saldoTrasLiquidar).toBe(120_000 + 80_000 + 200_000 + 15_000 + GMF);
    // El dinero del SOAT NO volvió: la bolsa sigue debiendo los dos SOAT conciliados.
    expect(bd.saldoCliente).toBe(10_000_000 - VALOR_A - VALOR_B);

    // Y su llave sigue ocupada, así que volver a liquidar tampoco lo cobraría.
    const movSoat = bd.libroCliente.find((m) => m.llaveIdempotencia === `salida:soat:${SOAT_A}`);
    expect(movSoat).toBeDefined();
    expect(movSoat?.origen).toBe('conciliacion');
  });

  it('orden 1 · la bolsa de tránsito tampoco recupera el consumo conciliado', async () => {
    escenarioSellado();
    await conciliarBoleta(BOLETA, CTX);
    await liquidar(TRAMITE, 9);
    const transitoTrasLiquidar = bd.saldoTransito;

    await reversar(TRAMITE, 'Error en el valor del derecho', 9);

    expect(bd.saldoTransito).toBe(transitoTrasLiquidar);
    const consumo = bd.libroTransito.find((m) => m.llaveIdempotencia === `consumo:soat:${SOAT_A}`);
    expect(consumo).toBeDefined();
    expect(consumo?.origen).toBe('conciliacion');
  });

  it('orden 2 · el movimiento ADOPTADO tampoco vuelve, aunque conserve su tramite_id', async () => {
    // Este es el caso que la adopción existe para cerrar (ADR §2.4-ii): sin ella el movimiento
    // seguiría siendo `automatico` con su `tramite_id`, el barrido lo alcanzaría, y la boleta diría
    // «conciliada» mientras el dinero volvía a la bolsa.
    escenarioSellado();
    await liquidar(TRAMITE, 9);
    await conciliarBoleta(BOLETA, CTX);
    const saldoTrasConciliar = bd.saldoCliente;
    inserts.length = 0;

    await reversar(TRAMITE, 'El trámite retrocede de estado', 9);

    expect(entradasCliente().map((c) => c.concepto))
      .toEqual(['impuesto', 'derecho', 'tramite_digital', 'logistica', 'gmf']);
    expect(entradasCliente().some((c) => c.concepto === 'soat')).toBe(false);
    expect(bd.saldoCliente - saldoTrasConciliar).toBe(120_000 + 80_000 + 200_000 + 15_000 + GMF);

    const movSoat = bd.libroCliente.find((m) => m.llaveIdempotencia === `salida:soat:${SOAT_A}`);
    // Sigue teniendo su trámite: lo que lo protege es el ORIGEN, y por eso hay que afirmarlo aquí.
    expect(movSoat).toMatchObject({ origen: 'conciliacion', tramiteId: TRAMITE });
    const consumo = bd.libroTransito.find((m) => m.llaveIdempotencia === `consumo:soat:${SOAT_A}`);
    expect(consumo).toMatchObject({ origen: 'conciliacion', tramiteId: TRAMITE });
  });

  it('orden 2 · volver a liquidar después del reverso tampoco vuelve a cobrar el SOAT', async () => {
    // El reverso libera las llaves de lo que sí barrió (prefijo `rev:`), pero la del SOAT conciliado
    // no la tocó: sigue reservada. Es la otra mitad del CF-07.
    escenarioSellado();
    await liquidar(TRAMITE, 9);
    await conciliarBoleta(BOLETA, CTX);
    await reversar(TRAMITE, 'El trámite retrocede de estado', 9);
    inserts.length = 0;

    escenarioSellado();
    await liquidar(TRAMITE, 9);

    expect(salidasCliente().map((s) => s.concepto))
      .toEqual(['impuesto', 'derecho', 'tramite_digital', 'logistica', 'gmf']);
  });
});

// ─────────────────────────── Guardas ─────────────────────────────────────────

describe('conciliar — guardas del asiento', () => {
  it('sin usuario identificado no se concilia y no se abre ninguna transacción', async () => {
    // El sello de la boleta exige actor y fecha juntos (`flito_concil_boleta_sello_chk`): sin este
    // rechazo sería un 23514 en mitad de la transacción que mueve el dinero.
    escenarioConciliacion();

    await expect(conciliarBoleta(BOLETA, { userId: null, nombre: 'desconocido' }))
      .rejects.toMatchObject({ estado: 403, codigo: 'sin_actor' });
    expect(kdb.transaction).not.toHaveBeenCalled();
  });

  it('una boleta que no existe es 404 y no toca ninguna bolsa', async () => {
    escenarioConciliacion();
    kdb.when.select('flito_conciliacion_boletas', []);

    await expect(conciliarBoleta(BOLETA, CTX))
      .rejects.toMatchObject({ estado: 404, codigo: 'boleta_no_existe' });
    expect(inserts).toHaveLength(0);
  });

  it('un SOAT que pierde el valor pagado dentro de la transacción aborta el asiento entero', async () => {
    // Salvaguarda: `evaluarFila` marcaría ese SOAT como `valor_distinto`, así que llegar aquí es que
    // la fila cambió dentro de la transacción. Descontar cero sería peor que no descontar.
    escenarioConciliacion();
    let vaciado = false;
    kdb.when.select('flito_soat', () => {
      const filas = bd.soats.map((s) => ({ ...s }));
      // El primer SELECT (el del cruce) ve el valor; el segundo, el del asiento, ya no existe —el
      // asiento no relee—, así que se vacía el estado justo después de que el cruce lo apruebe.
      if (!vaciado) { vaciado = true; return filas; }
      return filas;
    });
    // Se fuerza el desenlace por la vía real: el contexto se arma una vez, así que se manipula el
    // valor tras el cruce mediante un resultado `ok` cuyo SOAT no tiene valor.
    bd.soats[1].valorPagado = null;
    bd.lineas[1].resultado = 'ok';

    // Con `valor_pagado` nulo el re-cruce lo marca `valor_distinto` → 409 boleta_incompleta, que es
    // la defensa de PRIMERA línea. La de segunda línea (`sin_valor_pagado`) solo se alcanza si el
    // cruce dijera `ok`, y este test fija que el camino feliz nunca descuenta cero.
    await expect(conciliarBoleta(BOLETA, CTX)).rejects.toMatchObject({ estado: 409 });
    expect(insertsEn('flito_bolsa_movimientos')).toHaveLength(0);
  });
});
