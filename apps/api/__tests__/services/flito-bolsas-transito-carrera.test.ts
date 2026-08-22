// FLITO — el libro de TRÁNSITO frente a dos escritores sobre la misma llave (Bug #11685).
//
// Desde el Feature #11623 la familia `consumo:soat:*` tiene DOS escritores: el sellado de la
// liquidación y la conciliación de una boleta. El libro del CLIENTE se defendió de esa carrera en la
// HU #11677 —relectura de la llave dentro del lock— y el de tránsito se quedó con el patrón viejo.
// Esta es la asimetría que el Bug cierra, y estos tests son su regresión.
//
// **Por qué la ventana existe de verdad y no la tapa el lock del otro libro.** Normalmente los dos
// escritores toman el `FOR UPDATE` del libro del cliente antes de llegar aquí, así que la pareja
// queda serializada de rebote. Pero `liquidar()` condiciona esa escritura a que el trámite tenga
// compañía cruzada (`if (ids?.companiaId != null)`) mientras que el consumo de tránsito lo escribe
// igual: un trámite SIN cliente cruzado se salta el libro del cliente y sí toca este. Ahí lo único
// que serializa es `bolsaBloqueada`, y lo que se afirma abajo es que eso alcanza.
//
// **Lo que estos tests NO son.** No hay concurrencia real: no se abren dos conexiones, ni hay dos
// transacciones peleando por un lock, ni MVCC. Los tests del API mockean Postgres, y llamar «prueba
// de carrera» a dos mocks encolados sería exactamente el tipo de test que este proyecto viene
// cazando. Lo que sí se afirma es cada pieza de la defensa por separado, contra un modelo declarado
// del comportamiento de PostgreSQL: la relectura ocurre DESPUÉS del `FOR UPDATE`, el error que sube
// tras un choque es el `23505` y no el `25P02`, y el `SAVEPOINT` acota el abort de la transacción.
// La serialización real bajo READ COMMITTED queda sin cubrir y solo la probaría un Postgres de
// verdad con dos sesiones.
//
// Se entra por `registrarConsumoTransito` —exportada, y la que usan de verdad el sellado y la
// conciliación— porque `asentar` es privada. Devuelve `null` tanto si ninguna bolsa cubre el par
// como si la llave ya estaba ocupada, así que cada test comprueba además que la bolsa SÍ se llegó a
// bloquear: sin eso, «null» no distinguiría la defensa de un simple «aquí no hay bolsa».

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';

const kdb = createKeyedDb();

vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const { registrarConsumoTransito } =
  await import('../../src/modules/flito-bolsas/flito-bolsas-transito.service.js');

const espia = crearEspia(kdb);

// ─────────────────────────── Orden de las lecturas ───────────────────────────
//
// El espía compartido registra escrituras, no lecturas, y aquí el orden de las lecturas ES la
// afirmación: «dentro del lock» significa DESPUÉS del SELECT que toma el `FOR UPDATE` sobre la
// bolsa. Sin esto, un segundo pre-chequeo puesto antes del lock pasaría los tests sin defender nada.

let lecturas: string[] = [];

function espiarLecturas(): void {
  const base = kdb.select.getMockImplementation() as (...a: unknown[]) => Record<string, unknown>;
  kdb.select.mockImplementation((...args: unknown[]) => {
    const c = base(...args);
    const original = c.from as (t: unknown) => unknown;
    c.from = (tbl: unknown) => {
      try { lecturas.push(getTableName(tbl as never)); } catch { lecturas.push('__expr__'); }
      return original(tbl);
    };
    return c;
  });
}

const MOVIMIENTOS = 'flito_bolsa_transito_movimientos';
const BOLSAS = 'flito_bolsas_transito';
const COBERTURA = 'flito_bolsa_transito_cobertura';

const BOLSA_ID = '99999999-9999-9999-9999-999999999999';
const SOAT_ID = '50a70000-0000-4000-8000-00000000000a';
const LLAVE = `consumo:soat:${SOAT_ID}`;
const CTX = { userId: 9, nombre: 'financiera' };

/** El movimiento que la OTRA transacción dejó asentado con esta misma llave. */
const movimientoPrevio = {
  id: 'aaaa0000-0000-4000-8000-00000000000b',
  bolsaId: BOLSA_ID,
  organismoCodigo: '05001',
  concepto: 'soat',
  tipo: 'salida',
  origen: 'automatico',
  tramiteId: null,
  valor: '450000',
  saldoResultante: '9550000',
  periodo: '2026-03',
  fecha: '2026-03-04',
  observacion: null,
  soporteId: null,
  registradoPorNombre: 'sistema',
  createdAt: new Date('2026-03-04T10:00:00Z'),
};

/** Violación de unicidad, tal como la lanza el driver de Postgres. */
function error23505(): Error {
  return Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
}

/** Lo que responde Postgres a CUALQUIER consulta hecha en una transacción ya abortada. */
function error25P02(): Error {
  return Object.assign(
    new Error('current transaction is aborted, commands ignored until end of transaction block'),
    { code: '25P02' },
  );
}

const consumo = () => registrarConsumoTransito(kdb.db as never, {
  organismoCodigo: '05001',
  concepto: 'soat' as const,
  tramiteId: null,
  valor: 450000,
  fecha: '2026-03-04',
  llave: `soat:${SOAT_ID}`,
  origen: 'conciliacion' as const,
}, CTX);

beforeEach(() => {
  kdb.reset();
  espia.reiniciar();
  lecturas = [];
  espiarLecturas();
  kdb.when
    .select(COBERTURA, [{ id: BOLSA_ID, nombre: 'Bolsa de prueba' }])
    .select(BOLSAS, [{ id: BOLSA_ID, saldo: '10000000' }])
    .insert(MOVIMIENTOS, [{ ...movimientoPrevio, id: 'nuevo', llaveIdempotencia: LLAVE }]);
});

// ─────────── Punto 1 · la relectura de la llave va DENTRO del lock ────────────

describe('asiento de tránsito — la relectura de la llave dentro del lock', () => {
  it('el segundo escritor encuentra la llave ya ocupada y no llega al INSERT', async () => {
    // Los dos pasan el pre-chequeo de fuera del lock porque ninguno ha escrito todavía. El que llega
    // segundo se serializa en `bolsaBloqueada` y vuelve a mirar la llave: ahí está lo que el primero
    // acaba de confirmar.
    kdb.when
      .selectOnce(MOVIMIENTOS, [])                 // fuera del lock: libre
      .select(MOVIMIENTOS, [movimientoPrevio]);    // dentro del lock: la otra ya escribió

    expect(await consumo()).toBeNull();
    // Ni el asiento ni el saldo: es un «esto ya estaba hecho», no un 500 ni un doble descuento.
    expect(espia.insertsEn(MOVIMIENTOS)).toHaveLength(0);
    expect(espia.updatesEn(BOLSAS)).toHaveLength(0);
    // Y la bolsa SÍ se bloqueó, así que el `null` es la defensa y no un «aquí no hay bolsa».
    expect(lecturas).toEqual([COBERTURA, MOVIMIENTOS, BOLSAS, MOVIMIENTOS]);
  });

  it('la segunda lectura va DESPUÉS del FOR UPDATE, no antes', async () => {
    // Un segundo pre-chequeo colocado antes del lock cerraría menos ventana de la que parece: las dos
    // transacciones seguirían leyendo sin haberse serializado. El orden es la defensa.
    kdb.when.select(MOVIMIENTOS, []);

    await consumo();

    const bolsa = lecturas.indexOf(BOLSAS);
    expect(bolsa).toBeGreaterThan(-1);
    expect(lecturas.lastIndexOf(MOVIMIENTOS)).toBeGreaterThan(bolsa);
    expect(espia.insertsEn(MOVIMIENTOS)).toHaveLength(1);
  });
});

// ─────────── Punto 2 · el error que sube tras el choque dice la verdad ────────

describe('asiento de tránsito — qué error sube cuando el INSERT choca', () => {
  it('si la relectura tras el 23505 encuentra el movimiento, es un duplicado y el saldo no se toca', async () => {
    // Red de DEBAJO de la relectura bajo el lock: la llave es única para toda la tabla, así que dos
    // bolsas distintas pueden colisionar sin compartir el lock que serializa el caso de arriba.
    kdb.when
      .selectOnce(MOVIMIENTOS, [])
      .selectOnce(MOVIMIENTOS, [])
      .select(MOVIMIENTOS, [movimientoPrevio])
      .insert(MOVIMIENTOS, () => { throw error23505(); });

    expect(await consumo()).toBeNull();
    expect(espia.updatesEn(BOLSAS)).toHaveLength(0);
  });

  it('si la relectura tras el choque falla, sube el 23505 original y no el error de la relectura', async () => {
    // El `25P02` de aquí representa cualquier motivo por el que la relectura pueda morir —que alguien
    // quite el savepoint, la conexión caída—. Lo que se fija es que el error que llega al log sea el
    // que dice la verdad de lo que pasó y no uno que solo despista.
    kdb.when
      .selectOnce(MOVIMIENTOS, [])
      .selectOnce(MOVIMIENTOS, [])
      .selectThrow(MOVIMIENTOS, error25P02())
      .insert(MOVIMIENTOS, () => { throw error23505(); });

    await expect(consumo()).rejects.toMatchObject({ code: '23505' });
  });

  it('si tras el 23505 no aparece ningún movimiento, el 23505 sube tal cual', async () => {
    // Sin fila que devolver no hay nada que resolver: tragarse el error dejaría el consumo por
    // asentar y la liquidación creyendo que sí se descontó.
    kdb.when
      .select(MOVIMIENTOS, [])
      .insert(MOVIMIENTOS, () => { throw error23505(); });

    await expect(consumo()).rejects.toMatchObject({ code: '23505' });
  });

  it('un fallo que no es de unicidad sigue subiendo tal cual', async () => {
    // Un CHECK roto no es una carrera. Tratarlo como replay dejaría el trámite sin consumo y sin
    // rastro de que algo falló.
    kdb.when
      .select(MOVIMIENTOS, [])
      .insert(MOVIMIENTOS, () => {
        throw Object.assign(new Error('violates check constraint'), { code: '23514' });
      });

    await expect(consumo()).rejects.toMatchObject({ code: '23514' });
  });
});

// ─────────── Punto 3 · el SAVEPOINT acota el abort de la transacción ─────────
//
// **Modelo declarado de PostgreSQL**, que es lo que estas dos pruebas usan en lugar de una base real:
//   · un `23505` deja la transacción ABORTADA y cualquier consulta posterior responde `25P02`;
//   · `rollback to savepoint` devuelve la transacción al estado que tenía al abrir el savepoint —es
//     decir, la desaborta— y el error original se relanza;
//   · bajo READ COMMITTED cada sentencia toma un snapshot nuevo, así que la relectura de después ve
//     lo que la otra transacción confirmó entre medias.
// El modelo no simula concurrencia: el choque se inyecta a mano. Lo que demuestra es que el código
// se comporta bien EN ESE MODELO, no que la carrera esté probada contra Postgres.

describe('asiento de tránsito — el SAVEPOINT alrededor del INSERT', () => {
  /** Estado de la transacción simulada: `true` desde el 23505 hasta un rollback a savepoint. */
  let abortada = false;
  /** Lo que ve un SELECT nuevo. Vacío hasta que la otra transacción confirma. */
  let visible: unknown[] = [];
  /** Sentencias emitidas mientras había un savepoint abierto. */
  let dentroDelSavepoint: string[] = [];
  let savepointAbierto = false;

  beforeEach(() => {
    abortada = false;
    visible = [];
    dentroDelSavepoint = [];
    savepointAbierto = false;

    // `tx.transaction()` sobre una transacción ya abierta es un SAVEPOINT: al fallar hace
    // `rollback to savepoint` —que desaborta— y relanza el error tal cual (drizzle 0.45,
    // `NodePgTransaction.transaction`).
    kdb.transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => {
      const antes = abortada;
      savepointAbierto = true;
      try {
        return await cb(kdb.db);
      } catch (e) {
        abortada = antes;
        throw e;
      } finally {
        savepointAbierto = false;
      }
    });

    kdb.when
      .select(MOVIMIENTOS, () => {
        if (savepointAbierto) dentroDelSavepoint.push(`select ${MOVIMIENTOS}`);
        if (abortada) throw error25P02();
        return visible;
      })
      // El INSERT choca porque la otra transacción confirmó su fila entre nuestra relectura bajo el
      // lock y este INSERT: esa es la ventana que el índice único cierra, y la que deja la
      // transacción abortada.
      .insert(MOVIMIENTOS, () => {
        if (savepointAbierto) dentroDelSavepoint.push(`insert ${MOVIMIENTOS}`);
        abortada = true;
        visible = [movimientoPrevio];
        throw error23505();
      })
      .update(BOLSAS, () => {
        if (savepointAbierto) dentroDelSavepoint.push(`update ${BOLSAS}`);
        if (abortada) throw error25P02();
        return [];
      });
  });

  it('tras el 23505 la relectura SÍ puede correr: el choque acaba en duplicado, no en 500', async () => {
    // Sin savepoint, el 23505 deja la transacción abortada y la relectura muere con 25P02: el
    // desenlace sería el error de servidor que reporta el Bug, con el movimiento correcto ahí al lado.
    expect(await consumo()).toBeNull();
    expect(espia.updatesEn(BOLSAS)).toHaveLength(0);
  });

  it('el savepoint envuelve el INSERT y nada más', async () => {
    // El UPDATE del saldo queda FUERA a propósito: si falla tiene que abortar la transacción del
    // dinero, no quedar acotado por un savepoint que alguien podría tragarse.
    visible = [];
    kdb.when.insert(MOVIMIENTOS, () => {
      if (savepointAbierto) dentroDelSavepoint.push(`insert ${MOVIMIENTOS}`);
      return [{ ...movimientoPrevio, id: 'nuevo', llaveIdempotencia: LLAVE }];
    });

    await consumo();

    expect(dentroDelSavepoint).toEqual([`insert ${MOVIMIENTOS}`]);
    expect(espia.updatesEn(BOLSAS)).toHaveLength(1);
  });
});
