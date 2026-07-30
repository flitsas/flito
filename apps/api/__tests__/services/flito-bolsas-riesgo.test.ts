// FLITO Bolsas — nivel de riesgo del saldo y alertas (HU #11125, Feature #11120 §7).
//
// La regla de clasificación es pura y vive en shared-types (se prueba en
// packages/shared-types/__tests__/flito-bolsas-riesgo.test.ts). Aquí se prueba lo que el backend
// añade encima: el ORDEN de la lista, qué se convierte en alerta y qué no, y los dos contadores de
// conciliación.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';

const kdb = createKeyedDb();
const espia = crearEspia(kdb);

vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const {
  bolsasConRiesgo, bolsaConRiesgoDe, alertasDeSaldo, alertasDeConciliacion,
} = await import('../../src/modules/flito-bolsas/flito-bolsas.service.js');

const AHORA = new Date('2026-07-30T15:00:00Z');

/** Fila de la bolsa tal como la devuelve el join con clients. */
function bolsa(companiaId: number, nombre: string, saldo: string, ultimaRecarga: string | null) {
  return {
    id: `bolsa-${companiaId}`, companiaId, companiaNombre: nombre,
    saldo, ultimaRecargaValor: ultimaRecarga, ultimaRecargaEn: ultimaRecarga === null ? null : AHORA,
  };
}

beforeEach(() => {
  kdb.reset();
  espia.reiniciar();
});

// ─────────────────────────── Clasificación ───────────────────────────────────

describe('bolsaConRiesgoDe — la bolsa llega ya clasificada', () => {
  it('añade nivel y porcentaje sin perder los datos de la bolsa', async () => {
    // La pantalla no recalcula nada: pinta lo que la API dice. Si el nivel se calculara en el
    // frontend, dos vistas podrían mostrar prioridades distintas del mismo saldo.
    kdb.when.select('flito_bolsas', [bolsa(7, 'ACME S.A.S.', '80000', '800000')]);

    const b = await bolsaConRiesgoDe(7);
    expect(b).toMatchObject({
      companiaId: 7, companiaNombre: 'ACME S.A.S.', saldo: 80000,
      nivel: 'critico', porcentaje: 10,
    });
  });

  it('cliente sin bolsa → null (lo traduce la ruta a 404)', async () => {
    kdb.when.select('flito_bolsas', []);
    expect(await bolsaConRiesgoDe(7)).toBeNull();
  });

  it('sin recargas, el porcentaje es null y el nivel no alarma', async () => {
    kdb.when.select('flito_bolsas', [bolsa(7, 'Cliente nuevo', '0', null)]);

    const b = await bolsaConRiesgoDe(7);
    expect(b?.nivel).toBe('sin_recargas');
    expect(b?.porcentaje).toBeNull();
  });
});

// ─────────────────────────── AC1: el orden de la lista ───────────────────────

describe('bolsasConRiesgo — AC1: primero las que peor están', () => {
  /** Una de cada nivel, deliberadamente desordenadas en la respuesta de la base. */
  const desordenadas = [
    bolsa(1, 'Normal', '500000', '800000'),        // 62,5 %
    bolsa(2, 'Sin recargas', '0', null),
    bolsa(3, 'Agotada', '-15000', '800000'),
    bolsa(4, 'Bajo', '200000', '800000'),          // 25 %
    bolsa(5, 'Crítico', '40000', '800000'),        // 5 %
  ];

  it('el orden es agotada, crítico, bajo, normal y sin_recargas al final', async () => {
    // Es la lista con la que Financiera decide a quién recargar hoy; el orden lo pone el servidor
    // para que no dependa de cómo ordene cada pantalla.
    kdb.when.select('flito_bolsas', desordenadas);

    const lista = await bolsasConRiesgo();
    expect(lista.map((b) => b.nivel)).toEqual(['agotada', 'critico', 'bajo', 'normal', 'sin_recargas']);
    expect(lista.map((b) => b.companiaId)).toEqual([3, 5, 4, 1, 2]);
  });

  it('a igual nivel, primero la que está más lejos de su base', async () => {
    // Dos clientes en «bajo» no son igual de urgentes: el que está al 12 % se queda sin saldo antes
    // que el que está al 28 %.
    kdb.when.select('flito_bolsas', [
      bolsa(1, 'Bajo 28 %', '280000', '1000000'),
      bolsa(2, 'Bajo 12 %', '120000', '1000000'),
      bolsa(3, 'Bajo 20 %', '200000', '1000000'),
    ]);

    const lista = await bolsasConRiesgo();
    expect(lista.map((b) => b.porcentaje)).toEqual([12, 20, 28]);
  });

  it('las que no tienen porcentaje van al final de su grupo, no al principio', async () => {
    // `sin_recargas` no tiene porcentaje; ordenarlas como si fuera 0 las pondría por delante de
    // clientes que sí necesitan atención.
    kdb.when.select('flito_bolsas', [
      bolsa(1, 'Sin recargas A', '0', null),
      bolsa(2, 'Agotada', '0', '500000'),
      bolsa(3, 'Sin recargas B', '900000', null),
    ]);

    const lista = await bolsasConRiesgo();
    expect(lista[0].companiaId).toBe(2);
    expect(lista.slice(1).every((b) => b.nivel === 'sin_recargas')).toBe(true);
  });

  it('sin bolsas → lista vacía, no error', async () => {
    kdb.when.select('flito_bolsas', []);
    expect(await bolsasConRiesgo()).toEqual([]);
  });
});

// ─────────────────────────── Totales del periodo ─────────────────────────────

describe('bolsasConRiesgo(periodo) — lo que se movió ese mes, por tarjeta', () => {
  it('cada total se asigna al cliente que le corresponde', async () => {
    // Los totales salen de UNA consulta agrupada por compañía y se cruzan en memoria; si el cruce
    // fallara, el tablero enseñaría el movimiento de un cliente en la tarjeta de otro.
    kdb.when
      .select('flito_bolsas', [
        bolsa(1, 'Uno', '500000', '800000'),
        bolsa(2, 'Dos', '400000', '800000'),
      ])
      .select('flito_bolsa_movimientos', [
        { companiaId: 2, entradas: '200000', salidas: '50000' },
        { companiaId: 1, entradas: '800000', salidas: '300000' },
      ]);

    const lista = await bolsasConRiesgo('2026-06');
    const porCompania = Object.fromEntries(lista.map((b) => [b.companiaId, b]));

    expect(porCompania[1]).toMatchObject({ entradasPeriodo: 800000, salidasPeriodo: 300000 });
    expect(porCompania[2]).toMatchObject({ entradasPeriodo: 200000, salidasPeriodo: 50000 });
  });

  it('un cliente sin movimientos ese mes queda en cero, no fuera de la lista', async () => {
    // Cero es información: significa «ese mes no se movió». Omitir la tarjeta escondería al cliente
    // justo cuando lleva un mes sin operar.
    kdb.when
      .select('flito_bolsas', [bolsa(1, 'Con movimientos', '500000', '800000'), bolsa(2, 'Quieto', '400000', '800000')])
      .select('flito_bolsa_movimientos', [{ companiaId: 1, entradas: '800000', salidas: '300000' }]);

    const quieto = (await bolsasConRiesgo('2026-06')).find((b) => b.companiaId === 2);
    expect(quieto).toMatchObject({ entradasPeriodo: 0, salidasPeriodo: 0 });
  });

  it('SIN periodo, ambos totales son null y no cero', async () => {
    // La distinción es la que evita que el tablero pinte «0 movimientos este mes» cuando nadie
    // preguntó por ningún mes. Si alguien aplana esto a cero, salta aquí.
    kdb.when.select('flito_bolsas', [bolsa(1, 'ACME', '500000', '800000')]);

    const [b] = await bolsasConRiesgo();
    expect(b.entradasPeriodo).toBeNull();
    expect(b.salidasPeriodo).toBeNull();
  });

  it('sin periodo no se consulta el libro: la agregación solo se paga si se pide', async () => {
    kdb.when.select('flito_bolsas', [bolsa(1, 'ACME', '500000', '800000')]);
    await bolsasConRiesgo();

    // Una sola consulta, la de las bolsas: sin mes que agrupar no hay nada que sumar.
    expect(kdb.select).toHaveBeenCalledTimes(1);
  });

  it('el periodo pedido llega a la consulta de totales', async () => {
    kdb.when
      .select('flito_bolsas', [bolsa(1, 'ACME', '500000', '800000')])
      .select('flito_bolsa_movimientos', []);
    await bolsasConRiesgo('2026-06');

    expect(espia.filtrosUsados()).toContain('2026-06');
  });

  it('los totales no alteran el orden por urgencia', async () => {
    kdb.when
      .select('flito_bolsas', [bolsa(1, 'Normal', '500000', '800000'), bolsa(2, 'Agotada', '0', '800000')])
      .select('flito_bolsa_movimientos', [{ companiaId: 1, entradas: '900000', salidas: '0' }]);

    expect((await bolsasConRiesgo('2026-06')).map((b) => b.companiaId)).toEqual([2, 1]);
  });
});

// ─────────────────────────── AC2: alertas de saldo ───────────────────────────

describe('alertasDeSaldo — AC2: solo lo que hay que mirar hoy', () => {
  it('deja fuera las bolsas en nivel normal', async () => {
    kdb.when.select('flito_bolsas', [
      bolsa(1, 'Normal', '500000', '800000'),
      bolsa(2, 'Crítico', '40000', '800000'),
    ]);

    const alertas = await alertasDeSaldo();
    expect(alertas.map((a) => a.companiaId)).toEqual([2]);
  });

  it('sin_recargas NO alerta: no es un problema de saldo', async () => {
    // El día que se den de alta veinte clientes, el panel se llenaría de ruido y las alertas reales
    // se perderían entre ellas.
    kdb.when.select('flito_bolsas', [
      bolsa(1, 'Cliente nuevo', '0', null),
      bolsa(2, 'Cliente nuevo con saldo', '900000', null),
    ]);

    expect(await alertasDeSaldo()).toEqual([]);
  });

  it('la alerta trae lo necesario para actuar sin abrir el detalle', async () => {
    kdb.when.select('flito_bolsas', [bolsa(4, 'ACME S.A.S.', '200000', '800000')]);

    const [a] = await alertasDeSaldo();
    expect(a).toMatchObject({
      tipo: 'saldo', nivel: 'bajo', companiaId: 4, companiaNombre: 'ACME S.A.S.',
      saldo: 200000, porcentaje: 25,
    });
    expect(a.mensaje).toBe('ACME S.A.S. tiene saldo bajo: 25 % de su última recarga.');
  });

  it('la bolsa agotada tiene su propio mensaje: el porcentaje ahí no dice nada', async () => {
    kdb.when.select('flito_bolsas', [bolsa(5, 'ACME S.A.S.', '-15000', '800000')]);

    const [a] = await alertasDeSaldo();
    expect(a.nivel).toBe('agotada');
    expect(a.mensaje).toBe('La bolsa de ACME S.A.S. está agotada (saldo -15000).');
  });

  it('las alertas conservan el orden de urgencia de la lista', async () => {
    kdb.when.select('flito_bolsas', [
      bolsa(1, 'Bajo', '200000', '800000'),
      bolsa(2, 'Agotada', '0', '800000'),
      bolsa(3, 'Crítico', '40000', '800000'),
    ]);

    expect((await alertasDeSaldo()).map((a) => a.nivel)).toEqual(['agotada', 'critico', 'bajo']);
  });
});

// ─────────────────────────── AC4: alertas de conciliación ────────────────────

describe('alertasDeConciliacion — AC4: los dos extremos que no cuadran', () => {
  it('cuenta los soportes sin trámite y las salidas automáticas sin soporte', async () => {
    kdb.when
      .select('flito_derechos_pendientes', [{ n: 3 }])
      .select('flito_bolsa_movimientos', [{ n: 5 }]);

    expect(await alertasDeConciliacion()).toEqual({ soportesSinTramite: 3, movimientosSinSoporte: 5 });
  });

  it('sin nada pendiente → dos ceros, no undefined', async () => {
    // El tablero pinta estos números tal cual; un undefined saldría como «NaN» en pantalla.
    kdb.when
      .select('flito_derechos_pendientes', [])
      .select('flito_bolsa_movimientos', []);

    expect(await alertasDeConciliacion()).toEqual({ soportesSinTramite: 0, movimientosSinSoporte: 0 });
  });

  it('solo cuenta los pendientes sin resolver y las salidas automáticas sin soporte', async () => {
    // Los filtros viven en el `where` y el mock no los evalúa; lo que se verifica aquí es que la
    // consulta los lleva: sin `resuelto = false` el contador nunca bajaría, y sin `origen` y `tipo`
    // se contarían también recargas y ajustes manuales, que no tienen por qué llevar soporte del
    // organismo.
    kdb.when
      .select('flito_derechos_pendientes', [{ n: 0 }])
      .select('flito_bolsa_movimientos', [{ n: 0 }]);
    await alertasDeConciliacion();

    expect(espia.filtrosUsados()).toContain('automatico');
    expect(espia.filtrosUsados()).toContain('salida');
  });
});
