// FLITO Bolsas — movimientos manuales y correcciones (HU #11123, Feature #11120 §5).
//
// Dos operaciones de contingencia y una asimetría que conviene tener fijada:
//   · un movimiento MANUAL en un periodo cerrado se RECHAZA (lo escribe una persona que eligió la
//     fecha: apuntar a un mes conciliado es un error suyo);
//   · una salida AUTOMÁTICA en ese mismo periodo cerrado se imputa al siguiente (viene de un hecho
//     que ya ocurrió y perderla sería peor que imputarla con desfase).
// El último test de este archivo pone las dos una al lado de la otra, porque es el tipo de decisión
// que alguien «unifica» al refactorizar sin saber que era deliberada.
//
// La corrección NO edita la fila original: asienta un movimiento nuevo con la DIFERENCIA. Eso se
// comprueba mirando el payload real del INSERT, no la fila que devuelve el mock.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createKeyedDb, type Resolver } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';

const kdb = createKeyedDb();
const espia = crearEspia(kdb);

vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const {
  registrarMovimientoManual, corregirMovimiento, registrarSalidasLiquidacion, BolsaError,
} = await import('../../src/modules/flito-bolsas/flito-bolsas.service.js');

// ─────────────────────────── Escenario ───────────────────────────────────────

type Fila = Record<string, unknown>;

const COMPANIA = 7;
const BOLSA_ID = '11111111-1111-1111-1111-111111111111';
const MOV_ID = '22222222-2222-2222-2222-222222222222';
const SOPORTE_ID = '33333333-3333-3333-3333-333333333333';
const TRAMITE = 'aaaaaaaa-0000-0000-0000-000000000001';
const AHORA = new Date('2026-07-30T15:00:00Z');
const CTX = { userId: 9, nombre: 'financiera@flit.io' };

/** Hoy en Colombia, que es el huso con el que fecha el servicio. */
function hoyEnColombia(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
const PERIODO_HOY = hoyEnColombia().slice(0, 7);

/** Periodo 'YYYY-MM' desplazado n meses respecto al de hoy. Nunca literales: el tiempo pasa. */
function periodoDesplazado(n: number): string {
  const [anio, mes] = PERIODO_HOY.split('-').map(Number);
  const total = anio * 12 + (mes - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}
const fechaEn = (periodo: string) => `${periodo}-15`;

const SOPORTE = {
  nombreArchivo: 'evidencia.pdf', contentType: 'application/pdf',
  storageKey: 'clientes/acme/bolsas-recargas/evidencia.pdf',
  hash: 'a'.repeat(64), tamanoBytes: 1024,
};

let saldoBolsa = 0;
const bolsaVigente: Resolver = () => [{ id: BOLSA_ID, saldo: String(saldoBolsa) }];

/** Movimiento manual ya asentado, tal como lo devuelve el SELECT por id. */
function movimientoOriginal(over: Fila = {}): Fila {
  return {
    id: MOV_ID, bolsaId: BOLSA_ID, companiaId: COMPANIA, tipo: 'salida', origen: 'manual',
    concepto: 'impuesto', organismoCodigo: '11001', tramiteId: TRAMITE,
    valor: '100000', saldoResultante: '900000', periodo: PERIODO_HOY, fecha: hoyEnColombia(),
    observacion: 'Pago en ventanilla', soporteId: SOPORTE_ID,
    registradoPorId: 9, registradoPorNombre: 'financiera@flit.io',
    llaveIdempotencia: null, corrigeMovimientoId: null, createdAt: AHORA,
    ...over,
  };
}

/**
 * Responde a las DOS consultas que se hacen sobre `flito_bolsa_cierres`, distinguiéndolas por su
 * filtro (el mock enruta por tabla, así que sin esto un cierre de enero haría parecer cerrado
 * también a marzo):
 *   · «¿está cerrado ESTE periodo?» (`exigirPeriodoAbierto`) — lleva el periodo en el `where`;
 *   · «¿cuáles están cerrados?» (el rezago del asiento) — solo filtra por compañía.
 */
function cierresSegunConsulta(cerrados: string[]): Resolver {
  return () => {
    const filas = cerrados.map((periodo) => ({ id: `cierre-${periodo}`, periodo }));
    const periodo = espia.filtros().find((v) => /^\d{4}-\d{2}$/.test(v));
    return periodo === undefined ? filas : filas.filter((f) => f.periodo === periodo);
  };
}

/** Deja el mock listo para asentar: bolsa con saldo y los periodos cerrados que se indiquen. */
function escenario(periodosCerrados: string[] = []): void {
  kdb.when
    .select('flito_bolsas', bolsaVigente)
    .select('flito_bolsa_cierres', cierresSegunConsulta(periodosCerrados))
    .insert('flito_soportes', [{ id: SOPORTE_ID }]);
}

beforeEach(() => {
  kdb.reset();
  espia.reiniciar();
  saldoBolsa = 1_000_000;
  kdb.when.insert('flito_bolsa_movimientos', () => [{
    id: 'mov-nuevo', createdAt: AHORA, ...espia.ultimoInsertEn('flito_bolsa_movimientos'),
  }]);
});

const escrito = () => espia.ultimoInsertEn('flito_bolsa_movimientos');

// ─────────────────────────── AC1: el movimiento manual ───────────────────────

describe('registrarMovimientoManual — AC1: la contingencia queda registrada y motivada', () => {
  it('una entrada manual sube el saldo y guarda el motivo como observación', async () => {
    escenario();
    const { movimiento, saldo } = await registrarMovimientoManual(
      COMPANIA,
      { tipo: 'entrada', valor: 250000, motivo: 'Devolución del organismo por trámite anulado', soporte: SOPORTE },
      CTX,
    );

    expect(movimiento.origen).toBe('manual');
    expect(movimiento.tipo).toBe('entrada');
    expect(escrito().observacion).toBe('Devolución del organismo por trámite anulado');
    expect(saldo).toBe(1_250_000);
  });

  it('una salida manual baja el saldo', async () => {
    escenario();
    const { saldo } = await registrarMovimientoManual(
      COMPANIA,
      { tipo: 'salida', valor: 250000, motivo: 'Cobro en ventanilla no capturado', soporte: SOPORTE },
      CTX,
    );

    expect(escrito().tipo).toBe('salida');
    expect(saldo).toBe(750_000);
  });

  it('no lleva llave de idempotencia: dos ajustes iguales son dos ajustes', async () => {
    // A diferencia de la recarga (doble clic) o de la salida automática (reintento del sellado),
    // aquí quien registra está mirando la pantalla y puede querer repetir el mismo importe.
    escenario();
    await registrarMovimientoManual(
      COMPANIA, { tipo: 'salida', valor: 250000, motivo: 'Ajuste de contingencia', soporte: SOPORTE }, CTX,
    );
    await registrarMovimientoManual(
      COMPANIA, { tipo: 'salida', valor: 250000, motivo: 'Ajuste de contingencia', soporte: SOPORTE }, CTX,
    );

    expect(espia.insertsEn('flito_bolsa_movimientos')).toHaveLength(2);
    expect(escrito().llaveIdempotencia).toBeNull();
  });

  it('la evidencia se registra en la misma transacción que el dinero', async () => {
    escenario();
    await registrarMovimientoManual(
      COMPANIA, { tipo: 'entrada', valor: 250000, motivo: 'Devolución del organismo', soporte: SOPORTE }, CTX,
    );

    expect(espia.secuencia()).toEqual(['flito_soportes', 'flito_bolsa_movimientos']);
    expect(escrito().soporteId).toBe(SOPORTE_ID);
  });

  it('concepto y organismo viajan si se indican: el ajuste se puede imputar', async () => {
    // Un ajuste sobre el impuesto de un organismo concreto tiene que aparecer en el extracto por
    // organismo (HU #11124), no caer en «sin asignar».
    escenario();
    await registrarMovimientoManual(
      COMPANIA,
      { tipo: 'salida', valor: 50000, motivo: 'Diferencia en el impuesto', concepto: 'impuesto', organismoCodigo: '11001', soporte: SOPORTE },
      CTX,
    );

    expect(escrito()).toMatchObject({ concepto: 'impuesto', organismoCodigo: '11001' });
  });

  it('sin fecha explícita se fecha hoy', async () => {
    escenario();
    await registrarMovimientoManual(
      COMPANIA, { tipo: 'entrada', valor: 1000, motivo: 'Ajuste del día', soporte: SOPORTE }, CTX,
    );
    expect(escrito().fecha).toBe(hoyEnColombia());
  });
});

describe('registrarMovimientoManual — el motivo es obligatorio', () => {
  for (const motivo of ['', '   ', 'abc', ' ok ']) {
    it(`motivo "${motivo}" → error sin escribir nada`, async () => {
      // El motivo es lo único que hace auditable un movimiento que no viene de ningún hecho del
      // sistema: sin él, el ajuste es un número que apareció solo.
      escenario();
      await expect(registrarMovimientoManual(
        COMPANIA, { tipo: 'entrada', valor: 1000, motivo, soporte: SOPORTE }, CTX,
      )).rejects.toMatchObject({ name: 'BolsaError', estado: 400, message: 'Indica el motivo del movimiento' });

      expect(espia.inserts).toHaveLength(0);
      expect(kdb.transaction).not.toHaveBeenCalled();
    });
  }

  it('el motivo se guarda recortado', async () => {
    escenario();
    await registrarMovimientoManual(
      COMPANIA, { tipo: 'entrada', valor: 1000, motivo: '   Devolución del organismo   ', soporte: SOPORTE }, CTX,
    );
    expect(escrito().observacion).toBe('Devolución del organismo');
  });
});

// ─────────────────────────── AC2: la corrección ──────────────────────────────

describe('corregirMovimiento — AC2: se corrige con un ajuste, no editando el pasado', () => {
  it('corregir al alza una salida asienta la diferencia como otra salida', async () => {
    // 100.000 registrados, 150.000 reales: faltan 50.000 por sacar. La corrección va en la misma
    // dirección que el original.
    escenario();
    kdb.when.select('flito_bolsa_movimientos', [movimientoOriginal({ valor: '100000' })]);

    const { correccion, saldo } = await corregirMovimiento(MOV_ID, 150000, 'Error de digitación', CTX);

    expect(escrito()).toMatchObject({ tipo: 'salida', valor: '50000', origen: 'manual' });
    expect(correccion.valor).toBe(50000);
    // El saldo queda como si el valor correcto se hubiera registrado desde el principio.
    expect(saldo).toBe(950_000);
  });

  it('corregir a la baja una salida devuelve la diferencia como entrada', async () => {
    escenario();
    kdb.when.select('flito_bolsa_movimientos', [movimientoOriginal({ valor: '100000' })]);

    const { saldo } = await corregirMovimiento(MOV_ID, 60000, 'Se cobró de menos en ventanilla', CTX);

    expect(escrito()).toMatchObject({ tipo: 'entrada', valor: '40000' });
    expect(saldo).toBe(1_040_000);
  });

  it('corregir al alza una entrada asienta otra entrada', async () => {
    escenario();
    kdb.when.select('flito_bolsa_movimientos', [movimientoOriginal({ tipo: 'entrada', valor: '100000' })]);

    await corregirMovimiento(MOV_ID, 130000, 'Faltaba parte de la devolución', CTX);
    expect(escrito()).toMatchObject({ tipo: 'entrada', valor: '30000' });
  });

  it('corregir a la baja una entrada asienta una salida', async () => {
    escenario();
    kdb.when.select('flito_bolsa_movimientos', [movimientoOriginal({ tipo: 'entrada', valor: '100000' })]);

    await corregirMovimiento(MOV_ID, 70000, 'La devolución fue menor', CTX);
    expect(escrito()).toMatchObject({ tipo: 'salida', valor: '30000' });
  });

  it('la fila original no se toca: el libro sigue siendo append-only', async () => {
    // El histórico tiene que seguir mostrando qué se registró primero; lo que cambia es el saldo,
    // mediante un asiento nuevo.
    escenario();
    kdb.when.select('flito_bolsa_movimientos', [movimientoOriginal()]);

    await corregirMovimiento(MOV_ID, 150000, 'Error de digitación', CTX);

    expect(espia.updatesEn('flito_bolsa_movimientos')).toHaveLength(0);
    // Lo único que se actualiza es el saldo denormalizado de la bolsa.
    expect(espia.updates.map((u) => u.tabla)).toEqual(['flito_bolsas']);
  });

  it('la corrección apunta al movimiento que corrige y explica el cambio', async () => {
    escenario();
    kdb.when.select('flito_bolsa_movimientos', [movimientoOriginal({ valor: '100000' })]);

    await corregirMovimiento(MOV_ID, 150000, 'Error de digitación', CTX);

    expect(escrito().corrigeMovimientoId).toBe(MOV_ID);
    expect(escrito().observacion).toBe('Corrección de 100000 a 150000: Error de digitación');
  });

  it('hereda concepto, organismo y trámite del original', async () => {
    // Si la corrección cayera en «sin asignar», el extracto por organismo dejaría de cuadrar con
    // el movimiento que corrige.
    escenario();
    kdb.when.select('flito_bolsa_movimientos', [movimientoOriginal()]);

    await corregirMovimiento(MOV_ID, 150000, 'Error de digitación', CTX);

    expect(escrito()).toMatchObject({ concepto: 'impuesto', organismoCodigo: '11001', tramiteId: TRAMITE });
  });
});

describe('corregirMovimiento — lo que no se corrige', () => {
  it('un movimiento automático → 409 con la salida a mano', async () => {
    // Viene del sellado de una liquidación: cambiarle el valor desalinearía la bolsa de lo que dice
    // la liquidación. El mensaje dice qué hacer en su lugar.
    escenario();
    kdb.when.select('flito_bolsa_movimientos', [movimientoOriginal({ origen: 'automatico' })]);

    await expect(corregirMovimiento(MOV_ID, 150000, 'Error de digitación', CTX))
      .rejects.toMatchObject({
        name: 'BolsaError', estado: 409,
        message: 'Un movimiento automático no se edita: corrígelo con un ajuste manual',
      });
    expect(espia.inserts).toHaveLength(0);
  });

  it('una recarga tampoco se corrige por aquí', async () => {
    escenario();
    kdb.when.select('flito_bolsa_movimientos', [movimientoOriginal({ origen: 'recarga' })]);

    await expect(corregirMovimiento(MOV_ID, 150000, 'Error de digitación', CTX))
      .rejects.toMatchObject({ estado: 409 });
  });

  it('movimiento inexistente → 404', async () => {
    escenario();
    kdb.when.select('flito_bolsa_movimientos', []);

    await expect(corregirMovimiento(MOV_ID, 150000, 'Error de digitación', CTX))
      .rejects.toMatchObject({ name: 'BolsaError', estado: 404, message: 'El movimiento no existe' });
  });

  it('diferencia cero → error: no hay nada que corregir', async () => {
    // Asentar un movimiento de valor cero es imposible (lo rechaza el asiento), así que se corta
    // antes con un mensaje que explica el caso real: el valor ya es ese.
    escenario();
    kdb.when.select('flito_bolsa_movimientos', [movimientoOriginal({ valor: '100000' })]);

    await expect(corregirMovimiento(MOV_ID, 100000, 'Error de digitación', CTX))
      .rejects.toMatchObject({ name: 'BolsaError', message: 'El valor corregido es igual al actual' });
    expect(espia.inserts).toHaveLength(0);
  });

  it('motivo corto → error antes de leer el movimiento', async () => {
    escenario();
    await expect(corregirMovimiento(MOV_ID, 150000, 'x', CTX))
      .rejects.toMatchObject({ message: 'Indica el motivo del movimiento' });
    expect(kdb.select).not.toHaveBeenCalled();
  });
});

// ─────────────────────────── AC4: periodo cerrado ────────────────────────────

describe('periodo cerrado — lo manual se rechaza', () => {
  it('un movimiento manual fechado en un mes cerrado → 409', async () => {
    const mes = periodoDesplazado(-2);
    escenario([mes]);

    await expect(registrarMovimientoManual(
      COMPANIA,
      { tipo: 'entrada', valor: 250000, motivo: 'Ajuste tardío', fecha: fechaEn(mes), soporte: SOPORTE },
      CTX,
    )).rejects.toMatchObject({
      name: 'BolsaError', estado: 409,
      message: 'No se pueden registrar ni editar movimientos de un periodo cerrado',
    });

    expect(espia.inserts).toHaveLength(0);
    expect(kdb.transaction).not.toHaveBeenCalled();
  });

  it('corregir un movimiento de un mes cerrado → 409', async () => {
    // El reporte de ese mes ya se firmó; tocar su saldo lo dejaría desmentido.
    const mes = periodoDesplazado(-2);
    escenario([mes]);
    kdb.when.select('flito_bolsa_movimientos', [movimientoOriginal({ fecha: fechaEn(mes), periodo: mes })]);

    await expect(corregirMovimiento(MOV_ID, 150000, 'Error de digitación', CTX))
      .rejects.toMatchObject({ estado: 409, message: 'No se pueden registrar ni editar movimientos de un periodo cerrado' });
    expect(espia.inserts).toHaveLength(0);
  });

  it('con OTRO mes cerrado, el manual entra sin problema', async () => {
    const mes = periodoDesplazado(-2);
    escenario([periodoDesplazado(-5)]);

    const { saldo } = await registrarMovimientoManual(
      COMPANIA,
      { tipo: 'entrada', valor: 250000, motivo: 'Ajuste tardío', fecha: fechaEn(mes), soporte: SOPORTE },
      CTX,
    );
    expect(saldo).toBe(1_250_000);
  });

  it('CONTRASTE: en el mismo mes cerrado, la salida automática sí entra y se corre de periodo', async () => {
    // La asimetría es deliberada. El automático viene de un hecho consumado —el organismo cobró— y
    // perderlo sería peor que imputarlo con desfase; el manual lo decide una persona que eligió la
    // fecha, y ahí el mes cerrado es un error suyo. Si alguien «unifica» ambos caminos, este test
    // es el que lo cuenta.
    const mes = periodoDesplazado(-2);
    escenario([mes]);
    kdb.when.select('flito_bolsa_movimientos', []);

    const asentadas = await registrarSalidasLiquidacion(
      kdb.db as never,
      {
        companiaId: COMPANIA,
        tramiteId: TRAMITE,
        fecha: fechaEn(mes),
        conceptos: [{ concepto: 'derecho', valor: 80000, organismoCodigo: '05266', llave: `tramite:${TRAMITE}:derecho` }],
      },
      CTX,
    );

    expect(asentadas).toHaveLength(1);
    // Mismo mes, misma fecha: el automático se imputa al siguiente periodo abierto…
    expect(escrito().periodo).toBe(periodoDesplazado(-1));
    expect(escrito().fecha).toBe(fechaEn(mes));

    // …y el manual, con esa misma fecha, se rechaza.
    await expect(registrarMovimientoManual(
      COMPANIA,
      { tipo: 'salida', valor: 80000, motivo: 'El mismo ajuste, a mano', fecha: fechaEn(mes), soporte: SOPORTE },
      CTX,
    )).rejects.toBeInstanceOf(BolsaError);
  });
});
