// FLITO — listado de bolsas de tránsito (HU #11210, AC5/AC6/AC9).
//
// El endpoint que alimenta el acordeón «Tránsitos». Lo que hay que fijar aquí no es la aritmética
// —esa ya la cubre `flito-bolsas-transito.test.ts` a través del sellado— sino QUÉ trae cada fila y
// en QUÉ ORDEN, que es lo que decide a quién se atiende primero.
//
// Archivo aparte del de consumo a propósito: aquel simula con estado el saldo y el libro para poder
// afirmar el préstamo y la idempotencia, y meter aquí un listado de varias bolsas obligaría a
// duplicar esa simulación por código.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createKeyedDb } from '../helpers/keyed-db.js';

const kdb = createKeyedDb();

vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const { bolsasTransito } = await import('../../src/modules/flito-bolsas/flito-bolsas-transito.service.js');

/**
 * Fila de `flito_bolsas_unicas` (alcance 'transito', HU #13906) tal y como la devuelve drizzle:
 * numéricos en texto. La «última carga» del DTO sale de `ultima_entrada_*` del modelo único.
 */
function bolsa(id: string, nombre: string, saldo: string, ultimaCarga: string | null) {
  return {
    id,
    alcance: 'transito',
    nombre,
    companiaId: null,
    activa: true,
    saldo,
    ultimaEntradaValor: ultimaCarga,
    ultimaEntradaEn: ultimaCarga === null ? null : new Date('2026-07-01T10:00:00Z'),
    createdAt: new Date('2026-07-01T10:00:00Z'),
    updatedAt: new Date('2026-07-01T10:00:00Z'),
  };
}

function totales(bolsaId: string, cargado: string, consumido: string) {
  return { bolsaId, cargado, consumido };
}

function cobertura(bolsaId: string, organismoCodigo: string, concepto: string, organismoNombre: string | null = null) {
  return { bolsaId, organismoCodigo, organismoNombre, concepto };
}

beforeEach(() => {
  kdb.reset();
});

describe('bolsasTransito — AC9: el listado del acordeón Tránsitos', () => {
  it('cada bolsa trae su cobertura y sus totales', async () => {
    kdb.when.scenario({
      flito_bolsas_unicas: [bolsa('b-1', 'Bolsa de mi sector', '2500000', '10000000')],
      flito_bolsas_unicas_movimientos: [totales('b-1', '10000000', '7500000')],
      flito_bolsas_unicas_cobertura: [
        cobertura('b-1', '05001', 'impuesto', 'Medellín'),
        cobertura('b-1', '05266', 'impuesto', 'Envigado'),
      ],
    });

    const lista = await bolsasTransito();

    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({
      nombre: 'Bolsa de mi sector', saldo: 2_500_000, nivel: 'bajo',
      totalCargado: 10_000_000, totalConsumido: 7_500_000, deuda: 0,
    });
    // La cobertura es lo que distingue una bolsa de otra: sin ella la tarjeta sería un saldo anónimo.
    expect(lista[0].cobertura).toEqual([
      { organismoCodigo: '05001', organismoNombre: 'Medellín', concepto: 'impuesto' },
      { organismoCodigo: '05266', organismoNombre: 'Envigado', concepto: 'impuesto' },
    ]);
  });

  it('sin ninguna bolsa devuelve vacío sin tocar el libro', async () => {
    kdb.when.scenario({ flito_bolsas_unicas: [] });

    expect(await bolsasTransito()).toEqual([]);
    // Una sola consulta: preguntar por el libro de una lista vacía sería un `IN ()` sin sentido.
    expect(kdb.select).toHaveBeenCalledTimes(1);
  });

  it('una bolsa sin movimientos aparece en cero, no desaparece', async () => {
    kdb.when.scenario({
      flito_bolsas_unicas: [bolsa('b-2', 'Bolsa nueva', '0', null)],
      flito_bolsas_unicas_movimientos: [],
      flito_bolsas_unicas_cobertura: [cobertura('b-2', '11001', 'derecho')],
    });

    const [b] = await bolsasTransito();

    // Es justo la que hay que atender: existe y nadie le ha cargado nada todavía.
    expect(b).toMatchObject({
      nombre: 'Bolsa nueva', saldo: 0, nivel: 'sin_cargas',
      totalCargado: 0, totalConsumido: 0, deuda: 0, porcentaje: null,
    });
  });

  it('AC6: el saldo negativo se reporta como préstamo con su deuda', async () => {
    kdb.when.scenario({
      flito_bolsas_unicas: [bolsa('b-3', 'Bolsa norte', '-4000000', '8000000')],
      flito_bolsas_unicas_movimientos: [totales('b-3', '8000000', '12000000')],
      flito_bolsas_unicas_cobertura: [cobertura('b-3', '05001', 'derecho')],
    });

    const [b] = await bolsasTransito();

    expect(b.nivel).toBe('en_prestamo');
    // La deuda es el saldo en negativo, no una columna aparte que pudiera desincronizarse.
    expect(b.deuda).toBe(4_000_000);
    expect(b.saldo).toBe(-4_000_000);
  });

  it('el orden lo pone el servidor: primero la que más urge', async () => {
    kdb.when.scenario({
      flito_bolsas_unicas: [
        bolsa('b-normal', 'Normal', '9000000', '10000000'),
        bolsa('b-prestamo', 'En préstamo', '-4000000', '8000000'),
        bolsa('b-agotada', 'Agotada', '0', '5000000'),
        bolsa('b-sin-cargas', 'Sin cargas', '0', null),
      ],
      flito_bolsas_unicas_movimientos: [],
      flito_bolsas_unicas_cobertura: [],
    });

    const orden = (await bolsasTransito()).map((b) => b.id);

    // Reordenar en la pantalla abriría la puerta a que dos vistas del mismo dato prioricen distinto.
    expect(orden).toEqual(['b-prestamo', 'b-agotada', 'b-sin-cargas', 'b-normal']);
  });
});
