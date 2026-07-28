// HU #10980 — desbloqueo excepcional de la autogestión, por trámite.
//
// Se prueba aquí lo que es verificable sin base de datos: las guardas de entrada y la FORMA de lo
// que se persiste. El comportamiento real —que el registro creado entra en la cola y que revocarlo
// lo saca— se verificó contra Postgres, porque el helper `chain()` descarta los argumentos de
// `where()` y no distingue una frontera abierta de una cerrada.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chain } from '../helpers/db.js';

const selectMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: transactionMock, execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const {
  desbloquear, esConceptoExcepcion, ExcepcionError, MOTIVO_MINIMO, CONCEPTO_EXCEPCION,
} = await import('../../src/modules/flito-excepciones/flito-excepciones.service.js');

const TRAMITE = 'aaaa0000-0000-0000-0000-000000000001';
const ctx = { userId: 7, username: 'ops@flit' };

/** Fila del trámite tal como la devuelve `cargarTramite`. */
function fila(over: Record<string, unknown> = {}) {
  return {
    tramiteId: TRAMITE, idFlit: 'FLIT-1', vin: 'VIN00000000000001', vehiculoId: 3,
    companiaId: 1, organismoCodigo: '05001', soatId: null,
    soatAutogestionable: true, impuestosAutogestionable: true, logisticaAutogestionable: true,
    valorImpuestoLiquidado: null, ...over,
  };
}

beforeEach(() => { selectMock.mockReset(); transactionMock.mockReset(); });

describe('esConceptoExcepcion — guarda de entrada', () => {
  it('acepta los tres conceptos', () => {
    for (const c of ['soat', 'impuesto', 'logistica']) expect(esConceptoExcepcion(c)).toBe(true);
  });

  it('rechaza cualquier otro valor en vez de dejarlo llegar al SQL', () => {
    for (const v of ['', 'SOAT', 'derecho', "'; DROP TABLE", null, undefined, 7, {}]) {
      expect(esConceptoExcepcion(v)).toBe(false);
    }
  });
});

describe('desbloquear — qué se rechaza antes de tocar la base', () => {
  it('un motivo corto no pasa: queda en la auditoría y «ok» no explica nada', async () => {
    await expect(desbloquear(TRAMITE, CONCEPTO_EXCEPCION.SOAT, 'no', ctx))
      .rejects.toThrow(new RegExp(`mínimo ${MOTIVO_MINIMO}`));
    // Ni siquiera se consultó el trámite.
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('un motivo de solo espacios cuenta como vacío', async () => {
    await expect(desbloquear(TRAMITE, CONCEPTO_EXCEPCION.SOAT, '        ', ctx))
      .rejects.toThrow(ExcepcionError);
  });

  it('un trámite inexistente falla con 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    await expect(desbloquear(TRAMITE, CONCEPTO_EXCEPCION.SOAT, 'motivo suficiente', ctx))
      .rejects.toMatchObject({ status: 404 });
  });

  it('si la compañía NO autogestiona ese concepto, no hay nada que desbloquear', async () => {
    // Crear una excepción aquí sería basura: FLITO ya lo gestiona y nadie sabría después por qué está.
    selectMock.mockReturnValueOnce(chain([fila({ soatAutogestionable: false })]));
    await expect(desbloquear(TRAMITE, CONCEPTO_EXCEPCION.SOAT, 'motivo suficiente', ctx))
      .rejects.toMatchObject({ status: 400 });
  });

  it('un trámite sin compañía no se puede desbloquear', async () => {
    selectMock.mockReturnValueOnce(chain([fila({ companiaId: null })]));
    await expect(desbloquear(TRAMITE, CONCEPTO_EXCEPCION.IMPUESTO, 'motivo suficiente', ctx))
      .rejects.toMatchObject({ status: 400 });
  });

  it('el mismo concepto dos veces → 409, no una segunda excepción', async () => {
    selectMock
      .mockReturnValueOnce(chain([fila()]))                    // cargarTramite
      .mockReturnValueOnce(chain([{ id: 'excepcion-vigente' }])); // ya hay una viva
    await expect(desbloquear(TRAMITE, CONCEPTO_EXCEPCION.IMPUESTO, 'motivo suficiente', ctx))
      .rejects.toMatchObject({ status: 409 });
    expect(transactionMock).not.toHaveBeenCalled();
  });
});
