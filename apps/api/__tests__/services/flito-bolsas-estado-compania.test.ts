// HU #13899 (AC9, contrato (d) con #13407) — `estadoBolsaDeCompania` en sus tres casos, y que la
// consulta va al modelo único filtrando por alcance 'compania' (la tabla NO tiene unique(compania_id)).
// Sin red ni Postgres: el mock keyed por tabla. El caso real «autocreada vacía no migrada» lo cubre
// `flito-bolsas-unicas-migracion.test.ts` (TC-08) contra PostgreSQL.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createKeyedDb } from '../helpers/keyed-db.js';

const kdb = createKeyedDb();

vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const { estadoBolsaDeCompania } = await import('../../src/modules/flito-bolsas/flito-bolsas.estado-compania.js');
const { estadoBolsaDeCompania: delPuerto13407 } =
  await import('../../src/modules/flito-bolsas-documentos/flito-bolsas-documentos.bolsa-compania.js');

beforeEach(() => kdb.reset());

describe('estadoBolsaDeCompania — AC9', () => {
  it.each([
    ['sin bolsa', [], { existe: false, activa: false }],
    ['bolsa activa', [{ activa: true }], { existe: true, activa: true }],
    ['bolsa inactiva', [{ activa: false }], { existe: true, activa: false }],
  ])('TC-26 · %s → %j', async (_caso, filas, esperado) => {
    kdb.when.select('flito_bolsas_unicas', filas);
    expect(await estadoBolsaDeCompania(7)).toEqual(esperado);
  });

  it('TC-08 · lee el modelo único: una bolsa vieja (autocreada, no migrada) NO cuenta', async () => {
    // La tabla vieja diría «sí»; el modelo único no la tiene → {false,false}.
    kdb.when.select('flito_bolsas', [{ activa: true, id: 'vieja' }]).select('flito_bolsas_unicas', []);
    expect(await estadoBolsaDeCompania(7)).toEqual({ existe: false, activa: false });
  });

  it('AC10 · el puerto de #13407 ES esta función (swap del fallback)', () => {
    expect(delPuerto13407).toBe(estadoBolsaDeCompania);
  });
});
