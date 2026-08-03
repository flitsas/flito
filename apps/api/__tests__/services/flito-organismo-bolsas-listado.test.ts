// FLITO — listado de bolsas de organismo (HU #11210, AC5/AC6/AC9).
//
// El endpoint que alimenta el acordeón «Tránsitos». Lo que hay que fijar aquí no es la aritmética
// —esa ya la cubre `flito-organismo-bolsas.test.ts` a través del sellado— sino QUIÉN entra en la
// lista y en QUÉ ORDEN, que es lo que decide a quién se atiende primero.
//
// Archivo aparte del de consumo a propósito: aquel simula con estado el saldo y el libro para poder
// afirmar el préstamo y la idempotencia, y meter aquí un listado de varios organismos obligaría a
// duplicar esa simulación por código.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createKeyedDb } from '../helpers/keyed-db.js';

const kdb = createKeyedDb();

vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const { bolsasOrganismos } = await import('../../src/modules/flito-bolsas/flito-organismo-bolsas.service.js');

/** Fila de `flito_organismo_bolsas` tal y como la devuelve drizzle: numéricos en texto. */
function bolsa(codigo: string, saldo: string, ultimaCarga: string | null) {
  return {
    id: `b-${codigo}`,
    organismoCodigo: codigo,
    saldo,
    ultimaCargaValor: ultimaCarga,
    ultimaCargaEn: ultimaCarga === null ? null : new Date('2026-07-01T10:00:00Z'),
    createdAt: new Date('2026-07-01T10:00:00Z'),
    updatedAt: new Date('2026-07-01T10:00:00Z'),
  };
}

function totales(codigo: string, cargado: string, consumido: string) {
  return { codigo, cargado, consumido };
}

beforeEach(() => {
  kdb.reset();
});

describe('bolsasOrganismos — AC9: el listado del acordeón Tránsitos', () => {
  it('solo entran los organismos marcados para llevar bolsa', async () => {
    kdb.when.scenario({
      organismos_transito_config: [{ codigo: '05001' }],
      flito_organismo_bolsas: [bolsa('05001', '2500000', '10000000')],
      flito_organismo_movimientos: [totales('05001', '10000000', '7500000')],
    });

    const lista = await bolsasOrganismos();

    // Cali no está marcado, así que no sale: no es una bolsa en cero, es que no existe.
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({
      organismoCodigo: '05001', saldo: 2_500_000, nivel: 'bajo',
      totalCargado: 10_000_000, totalConsumido: 7_500_000, deuda: 0,
    });
  });

  it('sin ningún organismo marcado devuelve vacío sin tocar el libro', async () => {
    kdb.when.scenario({ organismos_transito_config: [] });

    expect(await bolsasOrganismos()).toEqual([]);
    // Una sola consulta: preguntar por el libro de una lista vacía sería un `IN ()` sin sentido.
    expect(kdb.select).toHaveBeenCalledTimes(1);
  });

  it('un organismo marcado sin movimientos aparece en cero, no desaparece', async () => {
    kdb.when.scenario({
      organismos_transito_config: [{ codigo: '11001' }],
      flito_organismo_bolsas: [],
      flito_organismo_movimientos: [],
    });

    const [b] = await bolsasOrganismos();

    // Es justo el que hay que atender: está marcado y nadie le ha cargado nada todavía.
    expect(b).toMatchObject({
      organismoCodigo: '11001', saldo: 0, nivel: 'sin_cargas',
      totalCargado: 0, totalConsumido: 0, deuda: 0, porcentaje: null,
    });
  });

  it('AC6: el saldo negativo se reporta como préstamo con su deuda', async () => {
    kdb.when.scenario({
      organismos_transito_config: [{ codigo: '05001' }],
      flito_organismo_bolsas: [bolsa('05001', '-4000000', '8000000')],
      flito_organismo_movimientos: [totales('05001', '8000000', '12000000')],
    });

    const [b] = await bolsasOrganismos();

    expect(b.nivel).toBe('en_prestamo');
    // La deuda es el saldo en negativo, no una columna aparte que pudiera desincronizarse.
    expect(b.deuda).toBe(4_000_000);
    expect(b.saldo).toBe(-4_000_000);
  });

  it('el orden lo pone el servidor: primero el que más urge', async () => {
    kdb.when.scenario({
      organismos_transito_config: [
        { codigo: '11001' }, { codigo: '05001' }, { codigo: '76001' }, { codigo: '08001' },
      ],
      flito_organismo_bolsas: [
        bolsa('11001', '9000000', '10000000'),  // normal
        bolsa('05001', '-4000000', '8000000'),  // en préstamo
        bolsa('76001', '0', '5000000'),         // agotada
        bolsa('08001', '0', null),              // sin cargas
      ],
      flito_organismo_movimientos: [],
    });

    const orden = (await bolsasOrganismos()).map((b) => b.organismoCodigo);

    // Reordenar en la pantalla abriría la puerta a que dos vistas del mismo dato prioricen distinto.
    expect(orden).toEqual(['05001', '76001', '08001', '11001']);
  });
});
