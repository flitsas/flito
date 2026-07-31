// FLITO — bolsa prepago de FLIT en el Organismo de Tránsito (HU #11161, Feature #11120 §4).
//
// Se prueba a través del sellado real (`liquidar`/`reversar`) y no solo del servicio, porque lo que
// la HU promete es que sellar consuma el saldo del organismo y reversar se lo devuelva — y la mitad
// de la regla vive en cómo la liquidación decide QUÉ organismo y por QUÉ valor.
//
// Archivo aparte de `flito-bolsas-salidas.test.ts` a propósito: ese cubre el libro del CLIENTE y se
// está tocando en la HU #11160 en paralelo. Dos ramas editando el mismo archivo solo produce un
// conflicto que no aporta nada.
//
// El mock simula con estado el SALDO del organismo y su LIBRO, igual que el del cliente: sin eso, ni
// el préstamo (AC5) ni la idempotencia (AC10) se podrían afirmar contra el estado real que dejó la
// operación anterior.

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
const { registrarCargaOrganismo } =
  await import('../../src/modules/flito-bolsas/flito-organismo-bolsas.service.js');

// ─────────────────────────── Espía de escrituras ─────────────────────────────

interface Mutacion { tabla: string; datos: Record<string, unknown>; }

const inserts: Mutacion[] = [];
const updates: Mutacion[] = [];

function nombreTabla(tbl: unknown): string {
  try { return getTableName(tbl as never); } catch { return '__expr__'; }
}

/** Parámetros del último `where`: con qué valores se filtró la consulta en curso. */
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

/** Saldo del ORGANISMO. Lo mueve el mismo UPDATE que haría el servicio contra Postgres. */
let saldoOrganismo = 0;
/** Libro del organismo: lo que ven los pre-chequeos de idempotencia y el reverso. */
let libroOrganismo: Fila[] = [];
let secuencia = 0;
/** Si el organismo bajo prueba está marcado para llevar bolsa. */
let llevaBolsa = true;

const BOLSA_ORG_ID = '99999999-9999-9999-9999-999999999999';
const COMPANIA = 7;
const TRAMITE = 'aaaaaaaa-0000-0000-0000-000000000001';
const SOAT_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const IMPUESTO_ID = 'cccccccc-0000-0000-0000-000000000003';
const DERECHO_ID = 'dddddddd-0000-0000-0000-000000000004';
const ORG_DERECHO = '05266';
const AHORA = new Date('2026-07-30T15:00:00Z');
const CTX = { userId: 9, nombre: 'financiera' };

function aplicarEnSimulacion(tabla: string, datos: Record<string, unknown>): void {
  if (tabla === 'flito_organismo_bolsas' && typeof datos.saldo === 'string') {
    saldoOrganismo = Number(datos.saldo);
    return;
  }
  // Reverso: la llave original se reescribe con el prefijo `rev:`.
  if (tabla === 'flito_organismo_movimientos' && typeof datos.llaveIdempotencia === 'string') {
    const nueva = datos.llaveIdempotencia;
    const anterior = nueva.replace(/^rev:/, '');
    const fila = libroOrganismo.find((f) => f.llaveIdempotencia === anterior);
    if (fila) fila.llaveIdempotencia = nueva;
  }
}

const configOrganismo: Resolver = () => [{ lleva: llevaBolsa }];
const bolsaOrgVigente: Resolver = () => [{ id: BOLSA_ORG_ID, saldo: String(saldoOrganismo) }];

/**
 * Resuelve las consultas al libro del organismo mirando por qué se filtra:
 *   · un solo parámetro → pre-chequeo de idempotencia por llave;
 *   · varios → barrido del reverso por trámite.
 */
const consultaLibroOrganismo: Resolver = () => {
  const filtros = ultimosFiltros;
  if (filtros.length > 1) {
    const tramite = filtros[0];
    return libroOrganismo.filter((f) =>
      f.tramiteId === tramite && f.origen === 'automatico' && f.tipo === 'salida'
      && String(f.llaveIdempotencia).startsWith('consumo:'));
  }
  const fila = libroOrganismo.find((f) => f.llaveIdempotencia === filtros[0]);
  return fila ? [fila] : [];
};

function filaCalculo(over: Fila = {}): Fila {
  return {
    tramiteId: TRAMITE, idFlit: 'FLIT-1', tipoTramite: 'Traspaso', companiaId: COMPANIA,
    logisticaAutogestionable: false, soatAutogestionable: false, impuestosAutogestionable: false,
    soatId: SOAT_ID, soatEstado: 'pagado', soatValorPagado: '450000',
    impuestoId: IMPUESTO_ID, impuestoEstado: 'pagado', impuestoValorPagado: '120000',
    derechoValor: '100000',
    ...over,
  };
}

function filaIdentificadores(over: Fila = {}): Fila {
  return {
    companiaId: COMPANIA,
    soatId: SOAT_ID, soatOrganismo: '05001',
    impuestoId: IMPUESTO_ID, impuestoOrganismo: '11001',
    derechoId: DERECHO_ID, derechoOrganismo: ORG_DERECHO,
    ...over,
  };
}

const filaLiquidacion = {
  id: 'eeeeeeee-0000-0000-0000-000000000005', tramiteId: TRAMITE, estado: 'liquidado',
  valorSoat: '450000', valorImpuesto: '120000', valorDerecho: '100000',
  valorTramiteDigital: '200000', valorLogistica: '15000',
  baseGmf: '885000', tasaGmf: '0.004', valorGmf: '3540', total: '888540',
  detalle: {}, liquidadoEn: AHORA, facturadoEn: null,
};

function tarifasConfiguradas(digital = 200000, logistica = 15000): void {
  tarifaDeMock.mockImplementation(async (_c: unknown, concepto: string) =>
    concepto === 'tramite_digital'
      ? { valor: digital, origen: 'especifica' }
      : { valor: logistica, origen: 'generica' });
}

/**
 * Mock de un sellado completo. La bolsa del CLIENTE se resuelve con respuestas mínimas: aquí no se
 * afirma nada sobre ella (eso es la HU #11122), solo hace falta que no estorbe.
 */
function escenarioSellado(calculo: Fila = {}, ids: Fila = {}): void {
  kdb.when
    .select('flito_liquidaciones', [])
    .selectOnce('flito_tramites', [filaCalculo(calculo)])
    .selectOnce('flito_tramites', [filaIdentificadores(ids)])
    .select('flito_bolsas', [{ id: 'bolsa-cliente', saldo: '99000000' }])
    .select('flito_bolsa_movimientos', [])
    .select('organismos_transito_config', configOrganismo)
    .select('flito_organismo_bolsas', bolsaOrgVigente)
    .select('flito_organismo_movimientos', consultaLibroOrganismo)
    .insert('flito_liquidaciones', [filaLiquidacion])
    .insert('flito_liquidacion_eventos', [])
    .insert('flito_bolsa_movimientos', [{ id: 'mov-cliente' }]);
}

function escenarioReverso(): void {
  kdb.when
    .select('flito_liquidaciones', [filaLiquidacion])
    .select('flito_bolsa_movimientos', [])
    .select('flito_bolsas', [{ id: 'bolsa-cliente', saldo: '99000000' }])
    .select('organismos_transito_config', configOrganismo)
    .select('flito_organismo_bolsas', bolsaOrgVigente)
    .select('flito_organismo_movimientos', consultaLibroOrganismo);
}

beforeEach(() => {
  kdb.reset();
  inserts.length = 0;
  updates.length = 0;
  libroOrganismo = [];
  secuencia = 0;
  saldoOrganismo = 10_000_000;
  llevaBolsa = true;
  tarifaDeMock.mockReset();
  tarifasConfiguradas();
  espiarMutaciones();
  kdb.when.insert('flito_organismo_movimientos', () => {
    const datos = insertsEn('flito_organismo_movimientos').at(-1)?.datos ?? {};
    const fila: Fila = { id: `org-${++secuencia}`, createdAt: AHORA, ...datos };
    libroOrganismo.push(fila);
    return [fila];
  });
});

const movsOrganismo = () => insertsEn('flito_organismo_movimientos').map((m) => m.datos);
const salidasOrganismo = () => movsOrganismo().filter((m) => m.tipo === 'salida');
const entradasOrganismo = () => movsOrganismo().filter((m) => m.tipo === 'entrada');

// ─────────────────────────── AC3 y AC4 ───────────────────────────────────────

describe('liquidar — AC3: el derecho consume la bolsa del organismo', () => {
  it('asienta una salida por el valor del derecho y baja el saldo', async () => {
    escenarioSellado();
    await liquidar(TRAMITE, 9);

    expect(salidasOrganismo()).toHaveLength(1);
    expect(salidasOrganismo()[0]).toMatchObject({
      organismoCodigo: ORG_DERECHO,
      tipo: 'salida',
      origen: 'automatico',
      tramiteId: TRAMITE,
      valor: '100000',
      saldoResultante: '9900000',
    });
    expect(saldoOrganismo).toBe(9_900_000);
  });

  it('AC4 — el valor consumido excluye el GMF', async () => {
    // La liquidación selló 3.540 de gravamen sobre una base de 885.000, pero el organismo ya lo
    // incluye en el total de su comprobante: sumárselo aquí le cobraría dos veces el mismo 4x1000.
    escenarioSellado();
    await liquidar(TRAMITE, 9);

    expect(salidasOrganismo()[0].valor).toBe('100000');
    expect(10_000_000 - saldoOrganismo).toBe(100_000);
  });

  it('AC8 — ningún otro concepto consume la bolsa del organismo', async () => {
    // El trámite liquida SOAT (450.000), impuesto (120.000), logística (15.000) y trámite digital
    // (200.000), y SOAT e impuesto además tienen organismo propio en el libro del cliente. Nada de
    // eso sale del saldo prepago: solo el derecho.
    escenarioSellado();
    await liquidar(TRAMITE, 9);

    expect(movsOrganismo()).toHaveLength(1);
    expect(salidasOrganismo()[0].organismoCodigo).toBe(ORG_DERECHO);
  });

  it('el consumo no depende de la autogestión de la compañía', async () => {
    // Una compañía autogestionada no paga SOAT ni impuesto ni logística, pero el derecho se cobra
    // siempre, así que la secretaría gasta su saldo igual.
    escenarioSellado({
      soatAutogestionable: true, impuestosAutogestionable: true, logisticaAutogestionable: true,
    });
    await liquidar(TRAMITE, 9);

    expect(salidasOrganismo()).toHaveLength(1);
    expect(saldoOrganismo).toBe(9_900_000);
  });
});

// ─────────────────────────── AC1 ─────────────────────────────────────────────

describe('liquidar — AC1: solo los organismos marcados llevan bolsa', () => {
  it('con el indicador apagado no se asienta nada y el sellado no falla', async () => {
    llevaBolsa = false;
    escenarioSellado();

    const dto = await liquidar(TRAMITE, 9);

    expect(dto.estado).toBe('liquidado');
    expect(movsOrganismo()).toHaveLength(0);
    expect(updatesEn('flito_organismo_bolsas')).toHaveLength(0);
  });

  it('un derecho sin organismo resuelto tampoco consume nada', async () => {
    escenarioSellado({}, { derechoOrganismo: null });
    await liquidar(TRAMITE, 9);

    expect(movsOrganismo()).toHaveLength(0);
  });

  it('un derecho en cero no genera línea', async () => {
    // Mismo criterio que la bolsa del cliente: cero no es un desembolso, y el asiento rechaza los
    // valores no positivos, así que intentarlo impediría sellar el trámite entero.
    escenarioSellado({ derechoValor: '0' });
    await liquidar(TRAMITE, 9);

    expect(movsOrganismo()).toHaveLength(0);
  });
});

// ─────────────────────────── AC5 ─────────────────────────────────────────────

describe('liquidar — AC5: el saldo del organismo puede quedar en préstamo', () => {
  it('saldo insuficiente → queda negativo y el sellado no se bloquea', async () => {
    // Si la secretaría ya emitió el derecho, el gasto ocurrió. Frenar el asiento no lo deshace.
    saldoOrganismo = 40_000;
    escenarioSellado();

    await expect(liquidar(TRAMITE, 9)).resolves.toBeDefined();
    expect(saldoOrganismo).toBe(-60_000);
    expect(salidasOrganismo()[0].saldoResultante).toBe('-60000');
  });
});

// ─────────────────────────── AC10 ────────────────────────────────────────────

describe('liquidar — AC10: reintentar el sellado no duplica el consumo', () => {
  it('la llave del derecho ya asentada bloquea el segundo consumo', async () => {
    libroOrganismo.push({
      id: 'org-previo', organismoCodigo: ORG_DERECHO, tramiteId: TRAMITE,
      tipo: 'salida', origen: 'automatico', valor: '100000', saldoResultante: '9900000',
      periodo: '2026-07', fecha: '2026-07-30', observacion: null, soporteId: null,
      registradoPorNombre: 'sistema', createdAt: AHORA,
      llaveIdempotencia: `consumo:tramite:${TRAMITE}:derecho`,
    });
    saldoOrganismo = 9_900_000;
    escenarioSellado();

    await liquidar(TRAMITE, 9);

    expect(insertsEn('flito_organismo_movimientos')).toHaveLength(0);
    expect(saldoOrganismo).toBe(9_900_000);
  });
});

// ─────────────────────────── AC9 ─────────────────────────────────────────────

describe('reversar — AC9: el organismo recupera lo consumido', () => {
  it('una entrada por el valor del derecho y el saldo vuelve a su sitio', async () => {
    escenarioSellado();
    await liquidar(TRAMITE, 9);
    expect(saldoOrganismo).toBe(9_900_000);

    escenarioReverso();
    await reversar(TRAMITE, 'Error en el valor del derecho', 9);

    expect(entradasOrganismo()).toHaveLength(1);
    expect(entradasOrganismo()[0]).toMatchObject({
      tipo: 'entrada', origen: 'automatico', valor: '100000', tramiteId: TRAMITE,
    });
    expect(saldoOrganismo).toBe(10_000_000);
  });

  it('la devolución no se toma como base del nivel de alerta', async () => {
    // `ultimaCargaValor` solo la mueven las CARGAS: contar una devolución por reverso como carga
    // nueva falsearía el porcentaje del tablero.
    escenarioSellado();
    await liquidar(TRAMITE, 9);
    escenarioReverso();
    await reversar(TRAMITE, 'Error en el valor del derecho', 9);

    for (const u of updatesEn('flito_organismo_bolsas')) {
      expect(u.datos).not.toHaveProperty('ultimaCargaValor');
    }
  });

  it('la llave del consumo queda prefijada con rev: y nada más se reescribe', async () => {
    escenarioSellado();
    await liquidar(TRAMITE, 9);
    escenarioReverso();
    await reversar(TRAMITE, 'Error en el valor del derecho', 9);

    const reescrituras = updatesEn('flito_organismo_movimientos');
    expect(reescrituras).toHaveLength(1);
    expect(reescrituras[0].datos.llaveIdempotencia)
      .toBe(`rev:consumo:tramite:${TRAMITE}:derecho`);
    expect(Object.keys(reescrituras[0].datos)).toHaveLength(1);
  });

  it('reversar dos veces no acredita dos veces', async () => {
    escenarioSellado();
    await liquidar(TRAMITE, 9);
    escenarioReverso();
    await reversar(TRAMITE, 'Error en el valor del derecho', 9);
    const saldoTrasReverso = saldoOrganismo;

    escenarioReverso();
    await reversar(TRAMITE, 'Reverso repetido por reintento', 9);

    expect(entradasOrganismo()).toHaveLength(1);
    expect(saldoOrganismo).toBe(saldoTrasReverso);
  });

  it('volver a liquidar vuelve a consumir', async () => {
    // Es la razón del prefijo `rev:`: sin liberar la llave, el segundo sellado vería el derecho como
    // ya consumido y el organismo se quedaría sin registrar un gasto que sí ocurrió.
    escenarioSellado();
    await liquidar(TRAMITE, 9);
    escenarioReverso();
    await reversar(TRAMITE, 'Error en el valor del derecho', 9);
    expect(saldoOrganismo).toBe(10_000_000);

    escenarioSellado();
    await liquidar(TRAMITE, 9);

    expect(salidasOrganismo()).toHaveLength(2);
    expect(saldoOrganismo).toBe(9_900_000);
    // Tres líneas en el libro: consumo, devolución y consumo nuevo. Nada se borró.
    expect(libroOrganismo).toHaveLength(3);
  });
});

// ─────────────────────────── AC2 y AC6 ───────────────────────────────────────

describe('registrarCargaOrganismo — AC2: FLIT precarga saldo', () => {
  function escenarioCarga(): void {
    kdb.when
      .select('organismos_transito_config', configOrganismo)
      .select('flito_organismo_bolsas', bolsaOrgVigente)
      .select('flito_organismo_movimientos', consultaLibroOrganismo);
  }

  it('la carga entra como movimiento y deja el saldo al día', async () => {
    saldoOrganismo = 0;
    escenarioCarga();

    const { movimiento, saldo } = await registrarCargaOrganismo(
      ORG_DERECHO, { valor: 10_000_000, fecha: '2026-07-30' }, CTX,
    );

    expect(movimiento).toMatchObject({ tipo: 'entrada', origen: 'carga', valor: 10_000_000 });
    expect(saldo).toBe(10_000_000);
    expect(saldoOrganismo).toBe(10_000_000);
  });

  it('la carga fija la base del nivel de alerta', async () => {
    saldoOrganismo = 0;
    escenarioCarga();
    await registrarCargaOrganismo(ORG_DERECHO, { valor: 10_000_000, fecha: '2026-07-30' }, CTX);

    const u = updatesEn('flito_organismo_bolsas').at(-1);
    expect(u?.datos).toMatchObject({ ultimaCargaValor: '10000000' });
  });

  it('AC6 — una carga sobre saldo negativo neta la deuda', async () => {
    // El ejemplo del refinamiento: −4.000.000 más una carga de 10.000.000 deja 6.000.000, sin que la
    // deuda necesite estado propio en ninguna parte.
    saldoOrganismo = -4_000_000;
    escenarioCarga();

    const { saldo } = await registrarCargaOrganismo(
      ORG_DERECHO, { valor: 10_000_000, fecha: '2026-07-30' }, CTX,
    );

    expect(saldo).toBe(6_000_000);
    expect(saldoOrganismo).toBe(6_000_000);
  });

  it('AC1 — cargar en un organismo sin bolsa se rechaza', async () => {
    llevaBolsa = false;
    escenarioCarga();

    await expect(
      registrarCargaOrganismo(ORG_DERECHO, { valor: 1_000_000, fecha: '2026-07-30' }, CTX),
    ).rejects.toThrow(/no maneja bolsa prepago/i);
    expect(insertsEn('flito_organismo_movimientos')).toHaveLength(0);
  });

  it('una carga con valor no positivo se rechaza antes de tocar la bolsa', async () => {
    escenarioCarga();

    await expect(
      registrarCargaOrganismo(ORG_DERECHO, { valor: 0, fecha: '2026-07-30' }, CTX),
    ).rejects.toThrow(/mayor que cero/i);
    expect(insertsEn('flito_organismo_movimientos')).toHaveLength(0);
  });

  it('una carga con fecha futura se rechaza', async () => {
    escenarioCarga();

    await expect(
      registrarCargaOrganismo(ORG_DERECHO, { valor: 1_000_000, fecha: '2099-01-01' }, CTX),
    ).rejects.toThrow(/no puede ser futura/i);
  });
});
