// FLITO Bolsas — recargas del cliente (HU #11121, Feature #11120 §2.1).
//
// Lo que se prueba aquí es la ARITMÉTICA del libro y las guardas del dominio: qué queda escrito en
// el movimiento y en la bolsa después de una recarga, y qué recargas no llegan a escribirse. Por eso
// el mock de drizzle no solo devuelve filas, también captura el payload de `.values()`/`.set()`: si
// solo mirásemos el DTO de vuelta estaríamos afirmando sobre lo que el propio test devolvió, no
// sobre lo que el servicio calculó.
//
// Se usa el mock KEYED por tabla (no la cola posicional) porque una sola recarga toca cuatro tablas
// dentro de la transacción —bolsa, cliente, soporte y movimientos— y el orden de esas queries cambia
// según si la bolsa existe o no; enrutar por nombre de tabla evita que ese detalle rompa los tests.
//
// Sin red ni Postgres: las invariantes de BD (unique de compañía, FOR UPDATE, FKs en RESTRICT) no se
// verifican aquí.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { createKeyedDb } from '../helpers/keyed-db.js';

const kdb = createKeyedDb();

vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const { registrarRecarga, bolsaDe, BolsaError } = await import('../../src/modules/flito-bolsas/flito-bolsas.service.js');

// ─────────────────────────── Espía de escrituras ─────────────────────────────

interface Mutacion { tabla: string; datos: Record<string, unknown>; }

const inserts: Mutacion[] = [];
const updates: Mutacion[] = [];

function nombreTabla(tbl: unknown): string {
  try { return getTableName(tbl as never); } catch { return '__expr__'; }
}

/**
 * Envuelve los chains del keyed-db para registrar QUÉ se escribió, no solo en qué tabla.
 * El chain original se conserva: las filas de `returning()` las sigue resolviendo el helper.
 */
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
const ultimoMovimientoEscrito = () => insertsEn('flito_bolsa_movimientos').at(-1)?.datos ?? {};
/** Tablas escritas, en orden: sirve para afirmar qué va antes de qué dentro de la transacción. */
const secuenciaDeInserts = () => inserts.map((m) => m.tabla);

// ─────────────────────────── Escenarios ──────────────────────────────────────

const COMPANIA = 7;
const BOLSA_ID = '11111111-1111-1111-1111-111111111111';
const MOV_ID = '22222222-2222-2222-2222-222222222222';
const SOPORTE_ID = '33333333-3333-3333-3333-333333333333';
const CREADO_EN = new Date('2026-03-04T15:00:00Z');
const CTX = { userId: 9, nombre: 'financiera@flit.io' };

/** Comprobante ya subido al almacenamiento por la ruta; el servicio solo lo registra. */
const SOPORTE = {
  nombreArchivo: 'comprobante.pdf',
  contentType: 'application/pdf',
  storageKey: 'clientes/acme/bolsas-recargas/comprobante.pdf',
  hash: 'a'.repeat(64),
  tamanoBytes: 2048,
};

/** Recarga por defecto: fecha pasada (la futura se rechaza) y comprobante siempre presente. */
function datosRecarga(over: Partial<Parameters<typeof registrarRecarga>[1]> = {}) {
  return { valor: 500000, fecha: '2026-03-04', soporte: SOPORTE, ...over };
}

/** Cliente que ya tiene bolsa abierta con el saldo dado (tal como lo devuelve numeric: string). */
function conBolsa(saldo: string): void {
  kdb.when.select('flito_bolsas', [{ id: BOLSA_ID, saldo }]);
}

/**
 * Cliente que existe pero nunca ha recibido una recarga.
 *
 * El servicio consulta la bolsa DOS veces: la primera no encuentra nada, inserta con
 * `onConflictDoNothing` y vuelve a leer para quedarse con la fila ya bloqueada. Por eso el primer
 * SELECT se encola vacío y los siguientes caen al registro por defecto, que ya devuelve la bolsa.
 */
function sinBolsa(): void {
  kdb.when
    .selectOnce('flito_bolsas', [])
    .select('flito_bolsas', [{ id: BOLSA_ID, saldo: '0' }])
    .select('clients', [{ id: COMPANIA }]);
}

beforeEach(() => {
  kdb.reset();
  inserts.length = 0;
  updates.length = 0;
  espiarMutaciones();
  kdb.when.insert('flito_soportes', [{ id: SOPORTE_ID }]);
  // `returning()` del movimiento devuelve lo que el servicio acaba de escribir, como haría Postgres.
  // Así el DTO de respuesta refleja el cálculo real y no una fila inventada por el test.
  kdb.when.insert('flito_bolsa_movimientos', () => [
    { id: MOV_ID, createdAt: CREADO_EN, ...ultimoMovimientoEscrito() },
  ]);
});

// ─────────────────────────── AC1 ─────────────────────────────────────────────

describe('registrarRecarga — AC1: la entrada de dinero queda asentada y el saldo al día', () => {
  it('sobre una bolsa en cero, el saldo queda exactamente en lo recargado', async () => {
    conBolsa('0');
    const { saldo, movimiento } = await registrarRecarga(COMPANIA, datosRecarga(), CTX);

    expect(saldo).toBe(500000);
    // El saldo que se persiste es el mismo que se devuelve: la bolsa no puede quedar contando
    // una cosa y el extracto otra.
    expect(ultimoMovimientoEscrito().saldoResultante).toBe('500000');
    expect(updatesEn('flito_bolsas')[0]?.datos.saldo).toBe('500000');
    expect(movimiento.saldoResultante).toBe(500000);
  });

  it('el movimiento nace como entrada de origen recarga, sin concepto ni trámite', async () => {
    conBolsa('0');
    const { movimiento } = await registrarRecarga(COMPANIA, datosRecarga(), CTX);

    expect(movimiento.tipo).toBe('entrada');
    expect(movimiento.origen).toBe('recarga');
    // El dinero entra sin pasar por un organismo: esas cuatro columnas son de las salidas
    // automáticas (HU #11122) y dejarlas heredar basura ensuciaría el extracto por concepto.
    expect(movimiento.concepto).toBeNull();
    expect(movimiento.organismoCodigo).toBeNull();
    expect(movimiento.tramiteId).toBeNull();
    expect(ultimoMovimientoEscrito().llaveIdempotencia).toBeNull();
  });

  it('el valor se guarda positivo y con quién lo registró: una entrada sin responsable no es auditable', async () => {
    conBolsa('0');
    await registrarRecarga(COMPANIA, datosRecarga({ observacion: 'Transferencia Bancolombia' }), CTX);

    const m = ultimoMovimientoEscrito();
    expect(m.valor).toBe('500000');
    expect(m.registradoPorId).toBe(CTX.userId);
    expect(m.registradoPorNombre).toBe(CTX.nombre);
    expect(m.observacion).toBe('Transferencia Bancolombia');
  });

  it('la recarga mueve el monto y la fecha de la última recarga de la bolsa', async () => {
    conBolsa('0');
    await registrarRecarga(COMPANIA, datosRecarga(), CTX);

    // `ultimaRecargaValor` es la base con la que la HU #11125 clasifica el riesgo del saldo:
    // si no se actualiza aquí, el porcentaje restante se calcula contra una recarga vieja.
    const set = updatesEn('flito_bolsas')[0]?.datos ?? {};
    expect(set.ultimaRecargaValor).toBe('500000');
    expect(set.ultimaRecargaEn).toBeInstanceOf(Date);
    expect(set.updatedAt).toBeInstanceOf(Date);
  });
});

// ─────────────────────────── AC2 ─────────────────────────────────────────────

describe('registrarRecarga — AC2: el cliente sin bolsa no bloquea la recarga', () => {
  it('crea la bolsa en cero ANTES de asentar el movimiento', async () => {
    sinBolsa();
    await registrarRecarga(COMPANIA, datosRecarga({ valor: 200000 }), CTX);

    const creada = insertsEn('flito_bolsas');
    expect(creada).toHaveLength(1);
    expect(creada[0].datos).toMatchObject({ companiaId: COMPANIA, saldo: '0' });
    // El orden importa: el movimiento referencia bolsa y soporte por FK (ahora en RESTRICT), así
    // que ambos tienen que existir antes de la línea del libro.
    expect(secuenciaDeInserts()).toEqual(['flito_bolsas', 'flito_soportes', 'flito_bolsa_movimientos']);
  });

  it('el movimiento cuelga de la bolsa recién creada y su saldo arranca desde cero', async () => {
    sinBolsa();
    const { saldo } = await registrarRecarga(COMPANIA, datosRecarga({ valor: 200000 }), CTX);

    expect(ultimoMovimientoEscrito().bolsaId).toBe(BOLSA_ID);
    expect(saldo).toBe(200000);
  });

  it('compañía inexistente → 404, y no se abre bolsa ni se asienta nada', async () => {
    // Sin cliente no hay a quién abrirle bolsa: crearla igual dejaría saldo colgando de un id
    // que no existe. Es 404 y no 400 porque el recurso de la URL es el que no está.
    kdb.when.select('flito_bolsas', []).select('clients', []);

    await expect(registrarRecarga(COMPANIA, datosRecarga(), CTX))
      .rejects.toMatchObject({ name: 'BolsaError', estado: 404, message: 'La compañía no existe' });
    expect(inserts).toHaveLength(0);
  });

  it('si tras crear la bolsa sigue sin poder leerse → 409, no un movimiento sin bolsa', async () => {
    // Carrera perdida: el INSERT no hizo nada (conflicto) y la relectura tampoco trae fila. Es
    // preferible un 409 reintentable a seguir adelante y escribir el libro contra una bolsa
    // fantasma.
    kdb.when.select('flito_bolsas', []).select('clients', [{ id: COMPANIA }]);

    await expect(registrarRecarga(COMPANIA, datosRecarga(), CTX))
      .rejects.toMatchObject({ name: 'BolsaError', estado: 409 });
    expect(insertsEn('flito_bolsas')).toHaveLength(1);
    expect(insertsEn('flito_bolsa_movimientos')).toHaveLength(0);
  });
});

// ─────────────────────────── Soporte transaccional ───────────────────────────

describe('registrarRecarga — el comprobante se registra con el dinero, no antes', () => {
  it('el soporte se inserta dentro de la transacción y justo antes del movimiento', async () => {
    // Si el soporte se registrara fuera, una transacción que no cuaja dejaría una fila apuntando
    // a una recarga que nunca ocurrió.
    conBolsa('0');
    await registrarRecarga(COMPANIA, datosRecarga(), CTX);

    expect(secuenciaDeInserts()).toEqual(['flito_soportes', 'flito_bolsa_movimientos']);
    expect(insertsEn('flito_soportes')[0].datos).toMatchObject({
      tipo: 'recarga_bolsa',
      nombreArchivo: SOPORTE.nombreArchivo,
      contentType: SOPORTE.contentType,
      storageKey: SOPORTE.storageKey,
      hash: SOPORTE.hash,
      tamanoBytes: SOPORTE.tamanoBytes,
      subidoPorId: CTX.userId,
    });
  });

  it('el movimiento queda enlazado al soporte recién creado', async () => {
    conBolsa('0');
    const { movimiento } = await registrarRecarga(COMPANIA, datosRecarga(), CTX);

    expect(ultimoMovimientoEscrito().soporteId).toBe(SOPORTE_ID);
    expect(movimiento.soporteId).toBe(SOPORTE_ID);
  });

  it('un nombre de archivo larguísimo se trunca en vez de tumbar la recarga', async () => {
    // `nombre_archivo` es varchar(300): pasarse sería un 22001 DESPUÉS de haber subido el archivo,
    // es decir, un 500 con el comprobante ya en el almacenamiento.
    conBolsa('0');
    const nombreLargo = `${'x'.repeat(400)}.pdf`;
    await registrarRecarga(COMPANIA, datosRecarga({ soporte: { ...SOPORTE, nombreArchivo: nombreLargo } }), CTX);

    expect(String(insertsEn('flito_soportes')[0].datos.nombreArchivo)).toHaveLength(300);
  });
});

// ─────────────────────────── AC4 ─────────────────────────────────────────────

describe('registrarRecarga — AC4: un valor no positivo no entra al libro', () => {
  const invalidos = [
    { etiqueta: 'cero', valor: 0 },
    { etiqueta: 'negativo', valor: -50000 },
    { etiqueta: 'NaN (lo que deja un "abc" convertido a número)', valor: Number.NaN },
  ];

  for (const caso of invalidos) {
    it(`valor ${caso.etiqueta} → BolsaError y ninguna escritura`, async () => {
      conBolsa('0');

      await expect(registrarRecarga(COMPANIA, datosRecarga({ valor: caso.valor }), CTX))
        .rejects.toThrow(BolsaError);
      await expect(registrarRecarga(COMPANIA, datosRecarga({ valor: caso.valor }), CTX))
        .rejects.toThrow('El valor de la recarga debe ser mayor que cero');

      // La validación va ANTES de abrir la transacción: un valor basura no debe ni tocar la BD,
      // y menos dejar el saldo de la bolsa reescrito con el mismo número que ya tenía.
      expect(inserts).toHaveLength(0);
      expect(updates).toHaveLength(0);
      expect(kdb.transaction).not.toHaveBeenCalled();
    });
  }

  it('el error de valor es de negocio (400 por defecto), no un 500', async () => {
    conBolsa('0');
    await expect(registrarRecarga(COMPANIA, datosRecarga({ valor: 0 }), CTX)).rejects.toMatchObject({ estado: 400 });
  });

  it('el mensaje nombra la operación: en una recarga dice «recarga», no «movimiento»', async () => {
    // El texto se parametriza porque la misma función la reutilizarán las salidas automáticas
    // (#11122) y los ajustes manuales (#11123); quien recarga debe leer su propio sustantivo.
    conBolsa('0');
    await expect(registrarRecarga(COMPANIA, datosRecarga({ valor: -1 }), CTX))
      .rejects.toThrow('El valor de la recarga debe ser mayor que cero');
  });
});

// ─────────────────────────── Techo de numeric(14,2) ──────────────────────────

describe('registrarRecarga — el valor tiene techo', () => {
  it('por encima de 999.999.999.999,99 → error de negocio, no un 22003 de Postgres', async () => {
    // Sin esta guarda el overflow llega como 500 y con el comprobante ya subido al almacenamiento.
    conBolsa('0');

    await expect(registrarRecarga(COMPANIA, datosRecarga({ valor: 1_000_000_000_000 }), CTX))
      .rejects.toMatchObject({
        name: 'BolsaError', estado: 400, message: 'El valor de la recarga excede el máximo admitido',
      });
    expect(inserts).toHaveLength(0);
  });

  it('el tope exacto sí entra: la guarda no se come un valor legal', async () => {
    conBolsa('0');
    const { saldo } = await registrarRecarga(COMPANIA, datosRecarga({ valor: 999_999_999_999.99 }), CTX);

    expect(ultimoMovimientoEscrito().valor).toBe('999999999999.99');
    expect(saldo).toBe(999999999999.99);
  });
});

// ─────────────────────────── AC5 ─────────────────────────────────────────────

describe('registrarRecarga — AC5: la recarga se suma al saldo que ya había', () => {
  it('30.000 en bolsa + recarga de 20.000 → saldoResultante 50.000 en el movimiento', async () => {
    conBolsa('30000');
    const { movimiento, saldo } = await registrarRecarga(COMPANIA, datosRecarga({ valor: 20000 }), CTX);

    // El saldo resultante viaja EN el movimiento para poder auditar el extracto línea a línea
    // sin recalcular la suma completa del histórico.
    expect(ultimoMovimientoEscrito().saldoResultante).toBe('50000');
    expect(movimiento.saldoResultante).toBe(50000);
    expect(movimiento.valor).toBe(20000);
    expect(saldo).toBe(50000);
  });

  it('una bolsa en negativo se recupera sumando, no se reinicia', async () => {
    // El saldo puede quedar negativo cuando el organismo ya aprobó el gasto; la recarga lo repone
    // desde donde estaba, no desde cero.
    conBolsa('-15000');
    const { saldo } = await registrarRecarga(COMPANIA, datosRecarga({ valor: 20000 }), CTX);
    expect(saldo).toBe(5000);
  });
});

// ─────────────────────────── Fecha del movimiento ────────────────────────────

/** Hoy en Colombia, que es el huso con el que fecha el servicio (no UTC). */
function hoyEnColombia(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

describe('registrarRecarga — el periodo se deriva de la fecha del movimiento', () => {
  it('marzo se guarda como "2026-03": el mes va con cero a la izquierda', async () => {
    // El cierre mensual (HU #11126) agrupa por este string; un "2026-3" partiría el periodo en dos.
    conBolsa('0');
    await registrarRecarga(COMPANIA, datosRecarga({ valor: 10000, fecha: '2026-03-04' }), CTX);
    expect(ultimoMovimientoEscrito().periodo).toBe('2026-03');
  });

  it('el 31 de diciembre se imputa a "2025-12", no al año siguiente', async () => {
    conBolsa('0');
    await registrarRecarga(COMPANIA, datosRecarga({ valor: 10000, fecha: '2025-12-31' }), CTX);
    expect(ultimoMovimientoEscrito().periodo).toBe('2025-12');
    expect(ultimoMovimientoEscrito().fecha).toBe('2025-12-31');
  });

  it('sin fecha explícita usa el día de hoy en Colombia, y el periodo cuadra con esa fecha', async () => {
    // A las 8 p.m. de Bogotá en UTC ya es mañana: fechar en UTC imputaría la recarga al periodo
    // siguiente el último día del mes.
    conBolsa('0');
    await registrarRecarga(COMPANIA, { valor: 10000, soporte: SOPORTE }, CTX);

    const m = ultimoMovimientoEscrito();
    expect(m.fecha).toBe(hoyEnColombia());
    expect(m.periodo).toBe(hoyEnColombia().slice(0, 7));
  });
});

describe('registrarRecarga — fechas que no existen o que no han llegado', () => {
  const imposibles = ['2026-02-31', '2026-99-99', '2025-13-01'];

  for (const fecha of imposibles) {
    it(`fecha ${fecha} → error de negocio, no un periodo corrido`, async () => {
      // Estas pasan el regex de la ruta pero no son días reales: sin la validación, el periodo
      // saldría desplazado (marzo en vez de febrero) y el dinero acabaría en el mes equivocado.
      conBolsa('0');

      await expect(registrarRecarga(COMPANIA, datosRecarga({ fecha }), CTX))
        .rejects.toMatchObject({
          name: 'BolsaError', estado: 400, message: 'La fecha del movimiento no es válida',
        });
      expect(inserts).toHaveLength(0);
    });
  }

  it('fecha futura → error: nadie recarga mañana', async () => {
    // Un dedazo en el año imputaría el dinero a un periodo que el cierre mensual nunca revisaría.
    conBolsa('0');

    await expect(registrarRecarga(COMPANIA, datosRecarga({ fecha: '2099-01-01' }), CTX))
      .rejects.toMatchObject({
        name: 'BolsaError', estado: 400, message: 'La fecha del movimiento no puede ser futura',
      });
    expect(inserts).toHaveLength(0);
  });

  it('hoy sí se admite: el tope es el futuro, no el propio día', async () => {
    conBolsa('0');
    const { saldo } = await registrarRecarga(COMPANIA, datosRecarga({ fecha: hoyEnColombia() }), CTX);
    expect(saldo).toBe(500000);
  });

  it('una fecha vieja sigue valiendo: los soportes del organismo llegan tarde con frecuencia', async () => {
    conBolsa('0');
    await registrarRecarga(COMPANIA, datosRecarga({ fecha: '2024-01-15' }), CTX);
    expect(ultimoMovimientoEscrito().periodo).toBe('2024-01');
  });
});

// ─────────────────────────── Redondeo a numeric(14,2) ────────────────────────

describe('registrarRecarga — redondeo a dos decimales', () => {
  it('1000.005 se guarda como 1000.01, sin decimales de más', async () => {
    // La columna es numeric(14,2): mandarle "1000.005" lo redondearía Postgres a su manera, y con
    // otros valores el flotante llegaría como "1000.0050000000001". Se redondea antes de escribir.
    conBolsa('0');
    await registrarRecarga(COMPANIA, datosRecarga({ valor: 1000.005 }), CTX);

    const m = ultimoMovimientoEscrito();
    expect(m.valor).toBe('1000.01');
    expect(m.saldoResultante).toBe('1000.01');
  });

  it('la suma con el saldo previo no arrastra ruido de coma flotante', async () => {
    // 1.10 + 2.20 da 3.3000000000000003 en JS; sin redondeo eso viajaría tal cual al numeric.
    conBolsa('1.10');
    const { saldo } = await registrarRecarga(COMPANIA, datosRecarga({ valor: 2.20 }), CTX);

    expect(ultimoMovimientoEscrito().saldoResultante).toBe('3.3');
    expect(saldo).toBe(3.3);
  });
});

// ─────────────────────────── Lectura de la bolsa ─────────────────────────────

describe('bolsaDe — la bolsa llega al frontend con números, no con strings de numeric', () => {
  it('convierte saldo y última recarga a number', async () => {
    kdb.when.select('flito_bolsas', [{
      id: BOLSA_ID, companiaId: COMPANIA, companiaNombre: 'ACME S.A.S.',
      saldo: '150000.50', ultimaRecargaValor: '500000.00', ultimaRecargaEn: CREADO_EN,
    }]);

    const bolsa = await bolsaDe(COMPANIA);
    expect(bolsa).toEqual({
      id: BOLSA_ID, companiaId: COMPANIA, companiaNombre: 'ACME S.A.S.',
      saldo: 150000.5, ultimaRecargaValor: 500000, ultimaRecargaEn: CREADO_EN.toISOString(),
    });
  });

  it('cliente que nunca ha recargado → null (no es un error, es que aún no tiene bolsa)', async () => {
    kdb.when.select('flito_bolsas', []);
    expect(await bolsaDe(COMPANIA)).toBeNull();
  });

  it('bolsa abierta sin recargas todavía: la última recarga queda en null, no en cero', async () => {
    // Distinguir «sin recargas» de «recargó cero» es lo que permite a la HU #11125 no calcular un
    // porcentaje contra una base inexistente.
    kdb.when.select('flito_bolsas', [{
      id: BOLSA_ID, companiaId: COMPANIA, companiaNombre: 'ACME S.A.S.',
      saldo: '0', ultimaRecargaValor: null, ultimaRecargaEn: null,
    }]);

    const bolsa = await bolsaDe(COMPANIA);
    expect(bolsa?.ultimaRecargaValor).toBeNull();
    expect(bolsa?.ultimaRecargaEn).toBeNull();
  });

  it('una fecha que el driver devuelve como string tampoco revienta', async () => {
    // El tipo declarado dice Date, pero una expresión cruda llega como string; `aIso` es lo que
    // evita el .toISOString() sobre un string, que solo se ve en producción.
    kdb.when.select('flito_bolsas', [{
      id: BOLSA_ID, companiaId: COMPANIA, companiaNombre: 'ACME S.A.S.',
      saldo: '0', ultimaRecargaValor: '1000', ultimaRecargaEn: '2026-03-04T15:00:00.000Z',
    }]);

    expect((await bolsaDe(COMPANIA))?.ultimaRecargaEn).toBe(CREADO_EN.toISOString());
  });
});
