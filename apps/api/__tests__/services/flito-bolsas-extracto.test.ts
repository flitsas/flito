// FLITO Bolsas — extracto del cliente y bolsa simbólica del organismo (HU #11124, Feature §6).
//
// Dos vistas del mismo libro y un registro nuevo:
//   · el EXTRACTO reparte el consumo del cliente por organismo y por concepto;
//   · la BOLSA SIMBÓLICA no tiene saldo: es lo cobrado a los clientes por cuenta de un organismo
//     menos lo que FLIT ya le pagó;
//   · el PAGO al organismo es dinero de FLIT y no puede tocar la bolsa de ningún cliente.
//
// Aviso sobre el alcance del mock: las sumas y la resta de los contramovimientos ocurren en SQL
// (`sum(case when …)`), que aquí no se ejecuta. Por eso, además de los tests de comportamiento —que
// asumen la fila ya agregada, como la devolvería Postgres— hay dos que verifican la EXPRESIÓN
// generada: son los únicos que detectarían que alguien cambie el `else -valor` de la bolsa simbólica
// por un `else 0` y deje de restar los reversos.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';

const kdb = createKeyedDb();
const espia = crearEspia(kdb);

vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const {
  extractoDe, bolsaSimbolicaDe, registrarPagoOrganismo, pagosDeOrganismo, tramitesDeOrganismo,
} = await import('../../src/modules/flito-bolsas/flito-bolsas.service.js');

// ─────────────────────────── Escenario ───────────────────────────────────────

const COMPANIA = 7;
const BOLSA_ID = '11111111-1111-1111-1111-111111111111';
const SOPORTE_ID = '33333333-3333-3333-3333-333333333333';
const PAGO_ID = '44444444-4444-4444-4444-444444444444';
const ORGANISMO = '05001';
const AHORA = new Date('2026-07-30T15:00:00Z');
const CTX = { userId: 9, nombre: 'financiera@flit.io' };

function hoyEnColombia(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

const SOPORTE = {
  nombreArchivo: 'transferencia.pdf', contentType: 'application/pdf',
  storageKey: 'organismos/05001/pagos/transferencia.pdf',
  hash: 'b'.repeat(64), tamanoBytes: 4096,
};

const filaBolsa = {
  id: BOLSA_ID, companiaId: COMPANIA, companiaNombre: 'ACME S.A.S.',
  saldo: '500000', ultimaRecargaValor: '800000', ultimaRecargaEn: AHORA,
};

/**
 * Las tres consultas de `extractoDe` sobre `flito_bolsa_movimientos` van encoladas: preguntan por la
 * misma tabla y solo las distingue el orden en que se lanzan (totales, por organismo, por concepto).
 */
function escenarioExtracto(
  totales: Record<string, unknown>,
  porOrganismo: Record<string, unknown>[],
  porConcepto: Record<string, unknown>[],
  bolsa: Record<string, unknown>[] = [filaBolsa],
): void {
  kdb.when
    .selectOnce('flito_bolsa_movimientos', [totales])
    .selectOnce('flito_bolsa_movimientos', porOrganismo)
    .selectOnce('flito_bolsa_movimientos', porConcepto)
    .select('flito_bolsas', bolsa);
}

/** Texto del SQL de una proyección: los trozos literales de la expresión, sin los parámetros. */
function sqlDe(proyeccion: unknown, campo: string): string {
  const expr = (proyeccion as Record<string, unknown>)[campo];
  const trozos: string[] = [];
  const visitar = (n: unknown): void => {
    if (n === null || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(visitar); return; }
    const o = n as Record<string, unknown>;
    if (Array.isArray(o.value)) trozos.push(...o.value.filter((v): v is string => typeof v === 'string'));
    if (Array.isArray(o.queryChunks)) o.queryChunks.forEach(visitar);
  };
  visitar(expr);
  return trozos.join(' ');
}

beforeEach(() => {
  kdb.reset();
  espia.reiniciar();
});

// ─────────────────────────── AC1: extracto del cliente ───────────────────────

describe('extractoDe — AC1: el consumo desglosado cuadra con el saldo', () => {
  it('entradas − salidas es el saldo actual de la bolsa', async () => {
    // Los desgloses salen del mismo libro que produce el saldo, así que cuadran por construcción.
    // Este test fija esa invariante: si un día el saldo se leyera de otra fuente, saltaría aquí.
    escenarioExtracto(
      { entradas: '800000', salidas: '300000' },
      [{ clave: ORGANISMO, entradas: '0', salidas: '300000', movimientos: 3 }],
      [{ clave: 'impuesto', entradas: '0', salidas: '300000', movimientos: 3 }],
    );

    const e = await extractoDe(COMPANIA);

    expect(e.totalEntradas).toBe(800000);
    expect(e.totalSalidas).toBe(300000);
    expect(e.saldoActual).toBe(500000);
    expect(e.totalEntradas - e.totalSalidas).toBe(e.saldoActual);
  });

  it('cada agrupación reparte las mismas sumas por una dimensión distinta', async () => {
    escenarioExtracto(
      { entradas: '800000', salidas: '300000' },
      [
        { clave: ORGANISMO, entradas: '0', salidas: '180000', movimientos: 2 },
        { clave: '11001', entradas: '0', salidas: '120000', movimientos: 1 },
        { clave: null, entradas: '800000', salidas: '0', movimientos: 1 },
      ],
      [
        { clave: 'impuesto', entradas: '0', salidas: '120000', movimientos: 1 },
        { clave: 'soat', entradas: '0', salidas: '180000', movimientos: 2 },
        { clave: null, entradas: '800000', salidas: '0', movimientos: 1 },
      ],
    );

    const e = await extractoDe(COMPANIA);
    const suma = (ls: { salidas: number }[]) => ls.reduce((a, l) => a + l.salidas, 0);

    expect(suma(e.porOrganismo)).toBe(e.totalSalidas);
    expect(suma(e.porConcepto)).toBe(e.totalSalidas);
  });

  it('las columnas nulas se agrupan como «sin_asignar», no se pierden', async () => {
    // Una recarga no tiene organismo ni concepto, y el trámite digital y la logística no tienen
    // organismo por ser honorarios de FLIT. Descartarlas descuadraría el desglose contra el total.
    escenarioExtracto(
      { entradas: '800000', salidas: '215000' },
      [{ clave: null, entradas: '800000', salidas: '215000', movimientos: 4 }],
      [{ clave: null, entradas: '800000', salidas: '0', movimientos: 1 }],
    );

    const e = await extractoDe(COMPANIA);
    expect(e.porOrganismo[0].clave).toBe('sin_asignar');
    expect(e.porConcepto[0].clave).toBe('sin_asignar');
    expect(e.porOrganismo[0].entradas).toBe(800000);
  });

  it('los numeric llegan como número, no como string', async () => {
    escenarioExtracto(
      { entradas: '800000.50', salidas: '300000.25' },
      [{ clave: ORGANISMO, entradas: '0', salidas: '300000.25', movimientos: 3 }],
      [],
    );

    const e = await extractoDe(COMPANIA);
    expect(e.totalEntradas).toBe(800000.5);
    expect(e.porOrganismo[0].salidas).toBe(300000.25);
    expect(e.porOrganismo[0].movimientos).toBe(3);
  });

  it('cliente sin bolsa → saldo 0 y desgloses vacíos, no un error', async () => {
    escenarioExtracto({ entradas: '0', salidas: '0' }, [], [], []);

    const e = await extractoDe(COMPANIA);
    expect(e).toMatchObject({ companiaId: COMPANIA, saldoActual: 0, totalEntradas: 0, totalSalidas: 0 });
    expect(e.porOrganismo).toEqual([]);
  });

  it('con periodo, el filtro llega a la consulta', async () => {
    // El extracto mensual es lo que Financiera concilia contra el cierre; sin el filtro mostraría el
    // histórico completo y ambos números no cuadrarían nunca.
    escenarioExtracto({ entradas: '0', salidas: '0' }, [], []);
    await extractoDe(COMPANIA, '2026-06');

    // Se mira el historial y no el último `where`: la consulta que cierra el extracto es la de la
    // bolsa, que solo filtra por compañía.
    expect(espia.filtrosUsados()).toContain('2026-06');
  });

  it('las entradas y las salidas se suman por separado, no en neto', async () => {
    // Verificado sobre la expresión SQL: el mock no ejecuta el `sum(case when …)`. Si alguien lo
    // sustituyera por un `sum(valor)` a secas, el extracto mostraría un neto y el desglose por
    // concepto dejaría de poder explicar el consumo.
    escenarioExtracto({ entradas: '0', salidas: '0' }, [], []);
    await extractoDe(COMPANIA);

    const proyeccion = kdb.select.mock.calls[0][0];
    expect(sqlDe(proyeccion, 'entradas')).toMatch(/case when/);
    expect(sqlDe(proyeccion, 'entradas')).toMatch(/else 0/);
  });
});

// ─────────────────────────── AC2: bolsa simbólica ────────────────────────────

describe('bolsaSimbolicaDe — AC2: lo cobrado por cuenta del organismo', () => {
  it('el pendiente es lo cobrado menos lo pagado', async () => {
    kdb.when
      .select('flito_bolsa_movimientos', [
        { concepto: 'soat', salidas: '450000', movimientos: 1 },
        { concepto: 'impuesto', salidas: '120000', movimientos: 1 },
      ])
      .select('flito_organismo_pagos', [{ total: '400000' }]);

    const b = await bolsaSimbolicaDe(ORGANISMO);

    expect(b.totalCobrado).toBe(570000);
    expect(b.totalPagado).toBe(400000);
    expect(b.saldoPendiente).toBe(170000);
  });

  it('una salida de 100 y un contramovimiento de 40 dejan 60 cobrados', async () => {
    // La resta la hace la consulta (`else -valor`), así que la fila ya llega neta: 100 − 40. Lo que
    // este test fija es que ese neto se propaga tal cual al total y al pendiente, sin volver a
    // sumar el reverso por otro lado.
    kdb.when
      .select('flito_bolsa_movimientos', [{ concepto: 'soat', salidas: '60', movimientos: 2 }])
      .select('flito_organismo_pagos', [{ total: '0' }]);

    const b = await bolsaSimbolicaDe(ORGANISMO);

    expect(b.porConcepto).toEqual([{ concepto: 'soat', cobrado: 60, movimientos: 2 }]);
    expect(b.totalCobrado).toBe(60);
    expect(b.saldoPendiente).toBe(60);
  });

  it('las entradas se RESTAN: el reverso no puede inflar la deuda con el organismo', async () => {
    // Verificado sobre la expresión SQL, que es donde vive la regla. Un `else 0` aquí —el mismo que
    // usa el extracto— convertiría cada contramovimiento en más deuda con el organismo.
    kdb.when
      .select('flito_bolsa_movimientos', [])
      .select('flito_organismo_pagos', [{ total: '0' }]);
    await bolsaSimbolicaDe(ORGANISMO);

    const proyeccion = kdb.select.mock.calls[0][0];
    const expr = sqlDe(proyeccion, 'salidas');
    expect(expr).toMatch(/else -/);
    expect(expr).not.toMatch(/else 0/);
  });

  it('un organismo sin movimientos ni pagos → todo en cero, sin error', async () => {
    // Es el caso de un organismo recién configurado: la pantalla tiene que abrir igual.
    kdb.when
      .select('flito_bolsa_movimientos', [])
      .select('flito_organismo_pagos', []);

    const b = await bolsaSimbolicaDe(ORGANISMO);
    expect(b).toEqual({
      organismoCodigo: ORGANISMO, porConcepto: [], totalCobrado: 0, totalPagado: 0, saldoPendiente: 0,
    });
  });

  it('si se le pagó de más, el pendiente queda negativo', async () => {
    // No se recorta a cero: un pendiente negativo es un saldo a favor de FLIT y esconderlo haría
    // que nadie lo reclamara.
    kdb.when
      .select('flito_bolsa_movimientos', [{ concepto: 'soat', salidas: '100000', movimientos: 1 }])
      .select('flito_organismo_pagos', [{ total: '150000' }]);

    expect((await bolsaSimbolicaDe(ORGANISMO)).saldoPendiente).toBe(-50000);
  });

  it('un movimiento sin concepto se agrupa como «sin_concepto»', async () => {
    kdb.when
      .select('flito_bolsa_movimientos', [{ concepto: null, salidas: '50000', movimientos: 1 }])
      .select('flito_organismo_pagos', []);

    expect((await bolsaSimbolicaDe(ORGANISMO)).porConcepto[0].concepto).toBe('sin_concepto');
  });
});

// ─────────────────────────── AC3: pago al organismo ──────────────────────────

describe('registrarPagoOrganismo — AC3: es dinero de FLIT, no de la bolsa del cliente', () => {
  function escenarioPago(): void {
    kdb.when
      .insert('flito_organismo_pagos', [{ id: PAGO_ID }])
      .insert('flito_soportes', [{ id: SOPORTE_ID }])
      .select('flito_bolsa_movimientos', [{ concepto: 'soat', salidas: '450000', movimientos: 1 }])
      .select('flito_organismo_pagos', [{ total: '450000' }]);
  }

  it('registra el pago y devuelve el pendiente recalculado', async () => {
    escenarioPago();
    const r = await registrarPagoOrganismo(ORGANISMO, { valor: 450000 }, CTX);

    expect(r.id).toBe(PAGO_ID);
    expect(r.saldoPendiente).toBe(0);
    expect(espia.ultimoInsertEn('flito_organismo_pagos')).toMatchObject({
      organismoCodigo: ORGANISMO, valor: '450000', fecha: hoyEnColombia(),
      registradoPorId: CTX.userId, registradoPorNombre: CTX.nombre,
    });
  });

  it('NO genera ningún movimiento de bolsa ni toca el saldo de nadie', async () => {
    // Es la invariante de la HU: pagarle al organismo no puede descontar del prepago de un cliente,
    // que ya pagó su parte cuando se selló la liquidación.
    escenarioPago();
    await registrarPagoOrganismo(ORGANISMO, { valor: 450000 }, CTX);

    expect(espia.insertsEn('flito_bolsa_movimientos')).toHaveLength(0);
    expect(espia.updatesEn('flito_bolsas')).toHaveLength(0);
    expect(espia.updates).toHaveLength(0);
  });

  it('el soporte es OPCIONAL: se puede registrar antes de tener el comprobante del banco', async () => {
    escenarioPago();
    await registrarPagoOrganismo(ORGANISMO, { valor: 450000, observacion: '  Transferencia ordenada  ' }, CTX);

    expect(espia.insertsEn('flito_soportes')).toHaveLength(0);
    expect(espia.ultimoInsertEn('flito_organismo_pagos')).toMatchObject({
      soporteId: null, observacion: 'Transferencia ordenada',
    });
  });

  it('con soporte, se registra en la misma transacción y queda enlazado', async () => {
    escenarioPago();
    await registrarPagoOrganismo(ORGANISMO, { valor: 450000, soporte: SOPORTE }, CTX);

    expect(espia.secuencia()).toEqual(['flito_soportes', 'flito_organismo_pagos']);
    expect(espia.ultimoInsertEn('flito_organismo_pagos').soporteId).toBe(SOPORTE_ID);
  });

  it('una observación en blanco se guarda como null', async () => {
    escenarioPago();
    await registrarPagoOrganismo(ORGANISMO, { valor: 450000, observacion: '   ' }, CTX);
    expect(espia.ultimoInsertEn('flito_organismo_pagos').observacion).toBeNull();
  });

  for (const valor of [0, -1000, Number.NaN]) {
    it(`valor ${valor} → error y ninguna escritura`, async () => {
      escenarioPago();
      await expect(registrarPagoOrganismo(ORGANISMO, { valor }, CTX))
        .rejects.toMatchObject({ name: 'BolsaError', message: 'El valor del pago debe ser mayor que cero' });
      expect(espia.inserts).toHaveLength(0);
    });
  }

  it('valor por encima del techo de la columna → error de negocio, no un 22003', async () => {
    escenarioPago();
    await expect(registrarPagoOrganismo(ORGANISMO, { valor: 1_000_000_000_000 }, CTX))
      .rejects.toMatchObject({ message: 'El valor del pago excede el máximo admitido' });
    expect(espia.inserts).toHaveLength(0);
  });

  it('fecha imposible de calendario → error', async () => {
    escenarioPago();
    await expect(registrarPagoOrganismo(ORGANISMO, { valor: 1000, fecha: '2026-02-31' }, CTX))
      .rejects.toMatchObject({ message: 'La fecha del pago no es válida' });
    expect(espia.inserts).toHaveLength(0);
  });

  it('fecha futura → error: no se registra un pago que aún no se hizo', async () => {
    escenarioPago();
    await expect(registrarPagoOrganismo(ORGANISMO, { valor: 1000, fecha: '2099-01-01' }, CTX))
      .rejects.toMatchObject({ message: 'La fecha del pago no puede ser futura' });
    expect(espia.inserts).toHaveLength(0);
  });
});

// ─────────────────────────── Historial de pagos ──────────────────────────────

describe('pagosDeOrganismo — con qué se ha ido bajando el pendiente', () => {
  it('mapea los numeric a número y conserva el orden de la consulta', async () => {
    // El orden (fecha desc, y a igual fecha el más reciente primero) lo pone el `orderBy`; lo que
    // se fija aquí es que el mapeo no lo altera ni pierde el enlace al soporte.
    kdb.when.select('flito_organismo_pagos', [
      { id: 'p2', valor: '300000', fecha: '2026-07-20', observacion: null, soporteId: null, registradoPorNombre: 'financiera@flit.io', createdAt: AHORA },
      { id: 'p1', valor: '150000.50', fecha: '2026-06-30', observacion: 'Primer abono', soporteId: SOPORTE_ID, registradoPorNombre: 'financiera@flit.io', createdAt: AHORA },
    ]);

    const pagos = await pagosDeOrganismo(ORGANISMO);
    expect(pagos.map((p) => p.id)).toEqual(['p2', 'p1']);
    expect(pagos[1]).toEqual({
      id: 'p1', valor: 150000.5, fecha: '2026-06-30', observacion: 'Primer abono',
      soporteId: SOPORTE_ID, registradoPorNombre: 'financiera@flit.io', createdAt: AHORA.toISOString(),
    });
  });

  it('organismo sin pagos → lista vacía', async () => {
    kdb.when.select('flito_organismo_pagos', []);
    expect(await pagosDeOrganismo(ORGANISMO)).toEqual([]);
  });

  it('la consulta se filtra por el organismo pedido', async () => {
    kdb.when.select('flito_organismo_pagos', []);
    await pagosDeOrganismo(ORGANISMO);
    expect(espia.filtrosUsados()).toContain(ORGANISMO);
  });
});

// ─────────────────────────── Trámites que cobró el organismo ─────────────────

describe('tramitesDeOrganismo — de dónde viene lo que se le debe', () => {
  const linea = (over: Record<string, unknown> = {}) => ({
    tramiteId: 'tramite-1', idFlit: 'FLIT-1024', companiaId: COMPANIA, concepto: 'soat',
    valor: '450000', fecha: '2026-07-20', soporteId: SOPORTE_ID, ...over,
  });

  it('trae el id de FLIT del trámite, no solo su UUID', async () => {
    kdb.when.select('flito_bolsa_movimientos', [linea()]);

    const [t] = await tramitesDeOrganismo(ORGANISMO);
    expect(t).toEqual({
      tramiteId: 'tramite-1', idFlit: 'FLIT-1024', companiaId: COMPANIA, concepto: 'soat',
      valor: 450000, fecha: '2026-07-20', soporteId: SOPORTE_ID,
    });
  });

  it('un trámite sin sincronizar llega con idFlit null y no rompe la lista', async () => {
    kdb.when.select('flito_bolsa_movimientos', [linea({ idFlit: null })]);
    expect((await tramitesDeOrganismo(ORGANISMO))[0].idFlit).toBeNull();
  });

  it('SOLO cuenta las salidas automáticas: ni ajustes manuales ni contramovimientos', async () => {
    // Es la regla de la vista. Un ajuste manual imputado a este organismo es una corrección de
    // FLIT, no algo que el organismo facturara, y una entrada es el reverso de un cobro; mezclar
    // cualquiera de los dos haría creer que el organismo cobró algo que nunca cobró.
    //
    // El filtro vive en el `where` y el mock no lo evalúa, así que se verifica que la consulta lo
    // lleva: sin `origen` y `tipo` la lista se llenaría de movimientos que no son suyos.
    kdb.when.select('flito_bolsa_movimientos', []);
    await tramitesDeOrganismo(ORGANISMO);

    const filtros = espia.filtrosUsados();
    expect(filtros).toContain(ORGANISMO);
    expect(filtros).toContain('automatico');
    expect(filtros).toContain('salida');
  });

  it('un movimiento sin trámite no se cuela en la lista', async () => {
    // Este descarte sí ocurre en JS, después de la consulta: una salida automática con
    // `tramiteId` nulo no tiene trámite que enseñar y la fila saldría con un hueco.
    kdb.when.select('flito_bolsa_movimientos', [
      linea(),
      linea({ tramiteId: null, idFlit: null, concepto: 'impuesto' }),
    ]);

    const lista = await tramitesDeOrganismo(ORGANISMO);
    expect(lista).toHaveLength(1);
    expect(lista[0].tramiteId).toBe('tramite-1');
  });

  it('organismo sin cobros → lista vacía', async () => {
    kdb.when.select('flito_bolsa_movimientos', []);
    expect(await tramitesDeOrganismo(ORGANISMO)).toEqual([]);
  });
});
