// FLITO Bolsas — cierre mensual del periodo (HU #11126, Feature #11120 §2.5).
//
// Dos cosas se prueban aquí y conviene no confundirlas:
//   · CERRAR un periodo sella un reporte (saldo inicial, totales, saldo final, movimientos). No mueve
//     dinero: el saldo de la bolsa queda exactamente donde estaba.
//   · Una vez cerrado, lo que llega tarde con fecha de ese mes NO se rechaza ni se cuela: se imputa
//     al primer periodo abierto, conservando su fecha real (AC3).
//
// Los periodos se calculan a partir de HOY, nunca literales: un test que fije '2026-06' como «el mes
// pasado» se pone rojo solo con que pase el tiempo, y este archivo se va a ejecutar durante años.
//
// El mock mantiene el estado de los cierres ya sellados, así que «cerrar dos veces» o «encadenar el
// saldo inicial» se resuelven contra lo que escribió la llamada anterior, no contra filas fijadas a
// mano.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { createKeyedDb, type Resolver } from '../helpers/keyed-db.js';

const kdb = createKeyedDb();

vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const {
  cerrarPeriodo, cierresDe, periodoEstaCerrado, periodoSiguiente, registrarRecarga, BolsaError,
} = await import('../../src/modules/flito-bolsas/flito-bolsas.service.js');

// ─────────────────────────── Espía de escrituras ─────────────────────────────

interface Mutacion { tabla: string; datos: Record<string, unknown>; }

const inserts: Mutacion[] = [];
const updates: Mutacion[] = [];

function nombreTabla(tbl: unknown): string {
  try { return getTableName(tbl as never); } catch { return '__expr__'; }
}

function espiarMutaciones(): void {
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
    c.set = (v: Record<string, unknown>) => { updates.push({ tabla: nombreTabla(tbl), datos: v }); return original(v); };
    return c;
  });
}

const insertsEn = (tabla: string) => inserts.filter((m) => m.tabla === tabla);
const updatesEn = (tabla: string) => updates.filter((m) => m.tabla === tabla);
const ultimoCierreEscrito = () => insertsEn('flito_bolsa_cierres').at(-1)?.datos ?? {};
const ultimoMovimientoEscrito = () => insertsEn('flito_bolsa_movimientos').at(-1)?.datos ?? {};

// ─────────────────────────── Periodos relativos a hoy ────────────────────────

type Fila = Record<string, unknown>;

/** Hoy en Colombia, que es el huso con el que el servicio decide el periodo en curso. */
function hoyEnColombia(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

const PERIODO_HOY = hoyEnColombia().slice(0, 7);

/** Periodo 'YYYY-MM' desplazado n meses respecto al de hoy. Negativo = pasado. */
function periodoDesplazado(n: number): string {
  const [anio, mes] = PERIODO_HOY.split('-').map(Number);
  const total = anio * 12 + (mes - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

/** Día 15 de ese periodo: siempre pasado si el periodo lo es, así nunca es fecha futura. */
const fechaEn = (periodo: string) => `${periodo}-15`;

const MES_PASADO = periodoDesplazado(-1);

// ─────────────────────────── Estado simulado ─────────────────────────────────

const COMPANIA = 7;
const BOLSA_ID = '11111111-1111-1111-1111-111111111111';
const SOPORTE_ID = '33333333-3333-3333-3333-333333333333';
const CERRADO_EN = new Date('2026-07-30T15:00:00Z');
const CTX = { userId: 9, nombre: 'financiera@flit.io' };

/** Cierres ya sellados, en el orden en que se sellaron. */
let cierres: Fila[] = [];
let saldoBolsa = 0;
let secuenciaCierre = 0;

const bolsaVigente: Resolver = () => [{ id: BOLSA_ID, saldo: String(saldoBolsa) }];

const cierreDelPeriodo = (periodo: string) => cierres.filter((c) => c.periodo === periodo);
/** Cierre inmediatamente anterior: el que aporta el saldo de arranque del siguiente. */
const cierrePrevioA = (periodo: string) =>
  cierres.filter((c) => String(c.periodo) < periodo)
    .sort((a, b) => String(b.periodo).localeCompare(String(a.periodo)))
    .slice(0, 1);

/**
 * Encola las dos consultas que `cerrarPeriodo` hace sobre `flito_bolsa_cierres` — «¿ya está
 * cerrado?» y «¿cuál fue el anterior?» —, ambas resueltas contra los cierres ya sellados.
 *
 * Van encoladas y no enrutadas por filtro porque las dos preguntan por la misma tabla con el mismo
 * parámetro (el periodo); lo que las distingue es el orden, que aquí es fijo.
 */
function escenarioCierre(periodo: string, totales: Fila = {}): void {
  kdb.when
    .select('flito_bolsas', bolsaVigente)
    .selectOnce('flito_bolsa_cierres', () => cierreDelPeriodo(periodo))
    .selectOnce('flito_bolsa_cierres', () => cierrePrevioA(periodo))
    .select('flito_bolsa_movimientos', [{ entradas: '0', salidas: '0', movimientos: 0, ...totales }]);
}

beforeEach(() => {
  kdb.reset();
  inserts.length = 0;
  updates.length = 0;
  cierres = [];
  secuenciaCierre = 0;
  saldoBolsa = 1_000_000;
  espiarMutaciones();
  // `returning()` devuelve lo que el servicio acaba de sellar y lo deja registrado: el siguiente
  // cierre y el chequeo de «ya cerrado» trabajan sobre él, como harían contra la tabla real.
  kdb.when.insert('flito_bolsa_cierres', () => {
    const fila: Fila = { id: `cierre-${++secuenciaCierre}`, cerradoEn: CERRADO_EN, ...ultimoCierreEscrito() };
    cierres.push(fila);
    return [fila];
  });
});

// ─────────────────────────── periodoSiguiente ────────────────────────────────

describe('periodoSiguiente — avanzar un mes contable', () => {
  it('dentro del mismo año suma un mes con cero a la izquierda', () => {
    expect(periodoSiguiente('2026-01')).toBe('2026-02');
    expect(periodoSiguiente('2026-08')).toBe('2026-09');
  });

  it('diciembre salta de año', () => {
    // Sin este salto, el rezago de un movimiento de diciembre se quedaría dando vueltas en un
    // '2026-13' que no existe.
    expect(periodoSiguiente('2026-12')).toBe('2027-01');
  });
});

// ─────────────────────────── AC1: el reporte del cierre ──────────────────────

describe('cerrarPeriodo — AC1: sella el reporte del mes', () => {
  it('congela totales, movimientos y saldo final encadenado', async () => {
    // Arrastre de 1.200.000 del cierre anterior + 500.000 que entraron − 320.000 que salieron.
    cierres.push({ id: 'cierre-previo', periodo: periodoDesplazado(-2), saldoFinal: '1200000' });
    escenarioCierre(MES_PASADO, { entradas: '500000', salidas: '320000', movimientos: 12 });

    const cierre = await cerrarPeriodo(COMPANIA, MES_PASADO, null, CTX);

    expect(cierre).toMatchObject({
      periodo: MES_PASADO,
      saldoInicial: 1200000,
      totalEntradas: 500000,
      totalSalidas: 320000,
      saldoFinal: 1380000,
      movimientos: 12,
    });
  });

  it('lo sellado en la tabla es lo mismo que se devuelve', async () => {
    escenarioCierre(MES_PASADO, { entradas: '500000', salidas: '320000', movimientos: 12 });
    await cerrarPeriodo(COMPANIA, MES_PASADO, null, CTX);

    expect(ultimoCierreEscrito()).toMatchObject({
      bolsaId: BOLSA_ID, companiaId: COMPANIA, periodo: MES_PASADO,
      saldoInicial: '0', totalEntradas: '500000', totalSalidas: '320000', saldoFinal: '180000',
      movimientos: 12,
    });
  });

  it('queda registrado quién cerró: un reporte de auditoría sin responsable no vale', async () => {
    escenarioCierre(MES_PASADO, { entradas: '500000', salidas: '320000', movimientos: 12 });
    const cierre = await cerrarPeriodo(COMPANIA, MES_PASADO, '  Conciliado con extracto bancario  ', CTX);

    expect(cierre.cerradoPorNombre).toBe(CTX.nombre);
    expect(ultimoCierreEscrito().cerradoPorId).toBe(CTX.userId);
    // La observación se recorta; una de solo espacios no se guarda como texto vacío.
    expect(cierre.observaciones).toBe('Conciliado con extracto bancario');
  });

  it('sin observaciones se guarda null, no una cadena vacía', async () => {
    escenarioCierre(MES_PASADO);
    await cerrarPeriodo(COMPANIA, MES_PASADO, '   ', CTX);
    expect(ultimoCierreEscrito().observaciones).toBeNull();
  });

  it('un mes sin movimientos se cierra igual, en ceros', async () => {
    // Cerrar un mes vacío es información: dice que se revisó y que no hubo nada.
    escenarioCierre(MES_PASADO);
    const cierre = await cerrarPeriodo(COMPANIA, MES_PASADO, null, CTX);

    expect(cierre).toMatchObject({ totalEntradas: 0, totalSalidas: 0, movimientos: 0, saldoFinal: 0 });
  });

  it('el saldo final puede ser negativo: el cierre retrata, no corrige', async () => {
    escenarioCierre(MES_PASADO, { entradas: '100000', salidas: '350000', movimientos: 4 });
    const cierre = await cerrarPeriodo(COMPANIA, MES_PASADO, null, CTX);

    expect(cierre.saldoFinal).toBe(-250000);
  });
});

describe('cerrarPeriodo — AC1 bis: el primer cierre del cliente', () => {
  it('sin cierre anterior, el saldo inicial es cero', async () => {
    // No se recalcula el libro entero hacia atrás: el arrastre nace en el primer cierre.
    escenarioCierre(MES_PASADO, { entradas: '900000', salidas: '100000', movimientos: 5 });
    const cierre = await cerrarPeriodo(COMPANIA, MES_PASADO, null, CTX);

    expect(cierre.saldoInicial).toBe(0);
    expect(cierre.saldoFinal).toBe(800000);
  });
});

describe('cerrarPeriodo — AC1 ter: los cierres se encadenan', () => {
  it('el saldo final de un mes es el saldo inicial del siguiente', async () => {
    // Es lo que hace auditable el arrastre mes a mes sin releer el libro completo.
    const haceDos = periodoDesplazado(-2);
    escenarioCierre(haceDos, { entradas: '600000', salidas: '100000', movimientos: 3 });
    const primero = await cerrarPeriodo(COMPANIA, haceDos, null, CTX);

    escenarioCierre(MES_PASADO, { entradas: '200000', salidas: '50000', movimientos: 2 });
    const segundo = await cerrarPeriodo(COMPANIA, MES_PASADO, null, CTX);

    expect(primero.saldoFinal).toBe(500000);
    expect(segundo.saldoInicial).toBe(primero.saldoFinal);
    expect(segundo.saldoFinal).toBe(650000);
  });
});

// ─────────────────────────── AC4: no se cierra dos veces ─────────────────────

describe('cerrarPeriodo — AC4: un periodo cerrado no se vuelve a cerrar', () => {
  it('el segundo intento → 409 y no sella nada', async () => {
    // Cerrar dos veces produciría dos reportes distintos del mismo mes; el segundo, además, con el
    // saldo inicial equivocado.
    escenarioCierre(MES_PASADO, { entradas: '500000', salidas: '320000', movimientos: 12 });
    await cerrarPeriodo(COMPANIA, MES_PASADO, null, CTX);

    escenarioCierre(MES_PASADO, { entradas: '500000', salidas: '320000', movimientos: 12 });
    await expect(cerrarPeriodo(COMPANIA, MES_PASADO, null, CTX))
      .rejects.toMatchObject({ name: 'BolsaError', estado: 409, message: 'El periodo ya está cerrado' });

    expect(insertsEn('flito_bolsa_cierres')).toHaveLength(1);
  });

  it('periodoEstaCerrado distingue el mes sellado del que no lo está', async () => {
    escenarioCierre(MES_PASADO);
    await cerrarPeriodo(COMPANIA, MES_PASADO, null, CTX);

    kdb.when.select('flito_bolsa_cierres', () => cierreDelPeriodo(MES_PASADO));
    expect(await periodoEstaCerrado(kdb.db as never, COMPANIA, MES_PASADO)).toBe(true);

    kdb.when.select('flito_bolsa_cierres', () => cierreDelPeriodo(periodoDesplazado(-9)));
    expect(await periodoEstaCerrado(kdb.db as never, COMPANIA, periodoDesplazado(-9))).toBe(false);
  });
});

// ─────────────────────────── Qué periodos se pueden cerrar ───────────────────

describe('cerrarPeriodo — qué mes se puede cerrar', () => {
  it('un periodo futuro no se cierra', async () => {
    await expect(cerrarPeriodo(COMPANIA, periodoDesplazado(1), null, CTX))
      .rejects.toMatchObject({ name: 'BolsaError', message: 'No se puede cerrar un periodo futuro' });
    expect(inserts).toHaveLength(0);
  });

  it('el mes en curso tampoco: aún puede entrar dinero', async () => {
    // El saldo final que quedaría sellado no sería el del periodo, y el reporte es irreversible.
    await expect(cerrarPeriodo(COMPANIA, PERIODO_HOY, null, CTX))
      .rejects.toMatchObject({
        name: 'BolsaError',
        message: 'El periodo en curso no ha terminado: solo se cierra un mes ya cumplido',
      });
    expect(inserts).toHaveLength(0);
  });

  it('un mes ya cumplido sí, aunque no sea el inmediatamente anterior', async () => {
    // El disparo es manual: Financiera cierra cuando ha conciliado, no en orden estricto.
    const haceCuatro = periodoDesplazado(-4);
    escenarioCierre(haceCuatro, { entradas: '10000', salidas: '0', movimientos: 1 });

    const cierre = await cerrarPeriodo(COMPANIA, haceCuatro, null, CTX);
    expect(cierre.periodo).toBe(haceCuatro);
  });

  for (const malo of ['2026-13', '2026-00', 'julio', '2026-6', '2026-06-01']) {
    it(`formato "${malo}" → error antes de tocar la base`, async () => {
      await expect(cerrarPeriodo(COMPANIA, malo, null, CTX))
        .rejects.toMatchObject({ name: 'BolsaError', message: 'El periodo debe tener la forma AAAA-MM' });
      expect(kdb.transaction).not.toHaveBeenCalled();
    });
  }
});

// ─────────────────────────── El cierre no mueve dinero ───────────────────────

describe('cerrarPeriodo — cerrar es reportar, no mover saldo', () => {
  it('el saldo de la bolsa queda intacto', async () => {
    // El cierre sella un documento; el dinero sigue donde estaba. Si esto cambiara, el saldo del
    // cliente bajaría solo por auditar.
    escenarioCierre(MES_PASADO, { entradas: '500000', salidas: '320000', movimientos: 12 });
    await cerrarPeriodo(COMPANIA, MES_PASADO, null, CTX);

    expect(updatesEn('flito_bolsas')).toHaveLength(0);
    expect(insertsEn('flito_bolsa_movimientos')).toHaveLength(0);
    expect(saldoBolsa).toBe(1_000_000);
  });
});

// ─────────────────────────── cierresDe ───────────────────────────────────────

describe('cierresDe — la lista que ve Financiera', () => {
  it('los numeric llegan como número, no como string', async () => {
    kdb.when.select('flito_bolsa_cierres', [{
      id: 'c1', companiaId: COMPANIA, periodo: MES_PASADO,
      saldoInicial: '1200000.00', totalEntradas: '500000.00', totalSalidas: '320000.50',
      saldoFinal: '1379999.50', movimientos: 12, observaciones: 'Conciliado',
      cerradoPorId: 9, cerradoPorNombre: 'financiera@flit.io', cerradoEn: CERRADO_EN, bolsaId: BOLSA_ID,
    }]);

    const [c] = await cierresDe(COMPANIA);
    expect(c).toEqual({
      id: 'c1', companiaId: COMPANIA, periodo: MES_PASADO,
      saldoInicial: 1200000, totalEntradas: 500000, totalSalidas: 320000.5,
      saldoFinal: 1379999.5, movimientos: 12, observaciones: 'Conciliado',
      cerradoPorNombre: 'financiera@flit.io', cerradoEn: CERRADO_EN.toISOString(),
    });
  });

  it('cliente sin cierres → lista vacía, no error', async () => {
    kdb.when.select('flito_bolsa_cierres', []);
    expect(await cierresDe(COMPANIA)).toEqual([]);
  });
});

// ─────────────────────────── AC3: imputación con el mes cerrado ──────────────

/** Comprobante ya subido: el servicio solo lo registra. */
const SOPORTE = {
  nombreArchivo: 'comprobante.pdf', contentType: 'application/pdf',
  storageKey: 'clientes/acme/bolsas-recargas/comprobante.pdf',
  hash: 'a'.repeat(64), tamanoBytes: 2048,
};

/** Deja el mock listo para una recarga, con los periodos ya cerrados que se le indiquen. */
function escenarioRecarga(periodosCerrados: string[]): void {
  kdb.when
    .select('flito_bolsa_movimientos', [])
    .select('flito_bolsas', bolsaVigente)
    .select('flito_bolsa_cierres', periodosCerrados.map((periodo) => ({ periodo })))
    .insert('flito_soportes', [{ id: SOPORTE_ID }])
    .insert('flito_bolsa_movimientos', () => [{
      id: 'mov-1', createdAt: CERRADO_EN, ...ultimoMovimientoEscrito(),
    }]);
}

const recarga = (fecha: string) => ({ valor: 100000, fecha, soporte: SOPORTE, claveIdempotencia: `k-${fecha}` });

describe('asentarMovimiento — AC3: lo que llega tarde se imputa al primer periodo abierto', () => {
  it('con su periodo natural abierto, el movimiento se imputa a su propio mes', async () => {
    // Comportamiento de siempre, fijado aquí para que la regla del rezago no se lleve por delante
    // el caso normal.
    const mes = periodoDesplazado(-2);
    escenarioRecarga([]);
    await registrarRecarga(COMPANIA, recarga(fechaEn(mes)), CTX);

    expect(ultimoMovimientoEscrito().periodo).toBe(mes);
    expect(ultimoMovimientoEscrito().fecha).toBe(fechaEn(mes));
  });

  it('con su periodo natural cerrado, se corre al siguiente y CONSERVA su fecha', async () => {
    // Un soporte del organismo fechado en el mes cerrado que llega tarde: rechazarlo sería perderlo,
    // y meterlo en el mes cerrado cambiaría un reporte ya firmado. El rezago queda visible
    // comparando `fecha` con `periodo`.
    const mes = periodoDesplazado(-2);
    escenarioRecarga([mes]);
    await registrarRecarga(COMPANIA, recarga(fechaEn(mes)), CTX);

    const m = ultimoMovimientoEscrito();
    expect(m.periodo).toBe(periodoDesplazado(-1));
    expect(m.fecha).toBe(fechaEn(mes));
  });

  it('varios meses cerrados seguidos: salta hasta el primero abierto', async () => {
    const mes = periodoDesplazado(-3);
    escenarioRecarga([periodoDesplazado(-3), periodoDesplazado(-2), periodoDesplazado(-1)]);
    await registrarRecarga(COMPANIA, recarga(fechaEn(mes)), CTX);

    expect(ultimoMovimientoEscrito().periodo).toBe(PERIODO_HOY);
  });

  it('nunca se imputa a un mes futuro, aunque todo lo intermedio esté cerrado', async () => {
    // El tope es el periodo de hoy: empujar el movimiento a un mes que aún no existe lo dejaría
    // fuera de cualquier cierre futuro y descuadraría el arrastre.
    const mes = periodoDesplazado(-3);
    escenarioRecarga([
      periodoDesplazado(-3), periodoDesplazado(-2), periodoDesplazado(-1), PERIODO_HOY,
    ]);
    await registrarRecarga(COMPANIA, recarga(fechaEn(mes)), CTX);

    expect(ultimoMovimientoEscrito().periodo).toBe(PERIODO_HOY);
  });

  it('un cierre de OTRO mes no desvía al movimiento', async () => {
    const mes = periodoDesplazado(-2);
    escenarioRecarga([periodoDesplazado(-5), periodoDesplazado(-4)]);
    await registrarRecarga(COMPANIA, recarga(fechaEn(mes)), CTX);

    expect(ultimoMovimientoEscrito().periodo).toBe(mes);
  });

  it('el saldo se mueve igual: el rezago cambia la imputación, no el dinero', async () => {
    const mes = periodoDesplazado(-2);
    escenarioRecarga([mes]);
    const { saldo } = await registrarRecarga(COMPANIA, recarga(fechaEn(mes)), CTX);

    expect(saldo).toBe(1_100_000);
    expect(ultimoMovimientoEscrito().saldoResultante).toBe('1100000');
  });
});

describe('BolsaError — el cierre usa los mismos códigos que el resto del módulo', () => {
  it('el error de periodo ya cerrado es un BolsaError de negocio', async () => {
    escenarioCierre(MES_PASADO);
    await cerrarPeriodo(COMPANIA, MES_PASADO, null, CTX);

    escenarioCierre(MES_PASADO);
    await expect(cerrarPeriodo(COMPANIA, MES_PASADO, null, CTX)).rejects.toBeInstanceOf(BolsaError);
  });
});
