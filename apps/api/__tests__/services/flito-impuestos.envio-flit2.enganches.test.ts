// HU #13268 (Feature #13267) — enganches del outbox de FLIT 2 en `flito-impuestos.service.ts`:
//   · `reversar` a PAGADO programa el envío con la `tx` de la reversa (la MISMA referencia) y el id;
//     a cualquier otro destino, no.
//   · `detalleImpuesto` expone `envioFlit2` (AC10) con lo que devuelve `envioFlit2DeImpuesto(id)`.
// El servicio del outbox se sustituye: su lógica tiene spec propio (flito-impuestos.envio-flit2.test.ts).
// Aquí solo se afirma que los dos sitios lo llaman, y cómo.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chain } from '../helpers/db.js';
import { EstadoImpuesto } from '@operaciones/shared-types';

const selectMock = vi.fn();
const transactionMock = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, update: vi.fn(), insert: vi.fn(), delete: vi.fn(), transaction: transactionMock, execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
const envio = vi.hoisted(() => ({
  programarEnvioFlit2: vi.fn(async () => 'programado'),
  completarComprobanteFlit2: vi.fn(async () => {}),
  envioFlit2DeImpuesto: vi.fn(async () => null as unknown),
}));
vi.mock('../../src/modules/flito-impuestos/flito-impuestos.envio-flit2.service.js', () => envio);
vi.mock('../../src/modules/flito-impuestos/flito-impuestos.analisis.service.js', () => ({
  encolarAnalisis: vi.fn(), marcarEnCursoEnTx: vi.fn().mockResolvedValue([]), reanalizarImpuesto: vi.fn(),
}));
vi.mock('../../src/modules/flito-impuestos/flito-impuestos.direccion.js', () => ({
  bloqueDireccionDetalle: vi.fn(() => ({ origen: 'flit' })), direccionFlitDe: vi.fn(async () => null),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const { reversar, detalleImpuesto } = await import('../../src/modules/flito-impuestos/flito-impuestos.service.js');

const UUID = '00000000-0000-4000-8000-0000000000cc';
const CTX = { userId: 1, username: 'op@x.io', role: 'admin', organismos: [] as string[] };

/** La `tx` que recibe el callback de la reversa: una referencia propia, para compararla por identidad. */
function txDeReversa() {
  const tx = {
    update: vi.fn(() => chain([{ id: UUID, estado: 'x' }])),
    insert: vi.fn(() => chain([])),
    select: vi.fn(() => chain([])),
  };
  transactionMock.mockImplementation(async (cb: (t: unknown) => unknown) => cb(tx));
  return tx;
}

beforeEach(() => {
  selectMock.mockReset(); transactionMock.mockReset();
  envio.programarEnvioFlit2.mockClear(); envio.envioFlit2DeImpuesto.mockReset();
  envio.envioFlit2DeImpuesto.mockResolvedValue(null);
});

describe('HU #13268 · reversar programa el envío solo cuando el destino es PAGADO (AC1)', () => {
  it('destino PAGADO → programarEnvioFlit2(tx de la reversa, id), una vez', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: UUID, estado: EstadoImpuesto.SOLICITADO }]));
    const tx = txDeReversa();
    await reversar(UUID, EstadoImpuesto.PAGADO, 'pago verificado a mano', CTX as never);
    expect(envio.programarEnvioFlit2).toHaveBeenCalledTimes(1);
    const [txRecibida, id] = envio.programarEnvioFlit2.mock.calls[0] as unknown as [unknown, string];
    expect(txRecibida).toBe(tx); // la MISMA tx, no `db`: el outbox es atómico con la reversa
    expect(id).toBe(UUID);
  });

  it.each([EstadoImpuesto.PENDIENTE, EstadoImpuesto.SOLICITADO])('destino %s → no programa nada', async (destino) => {
    selectMock.mockReturnValueOnce(chain([{ id: UUID, estado: EstadoImpuesto.PAGADO }]));
    txDeReversa();
    await reversar(UUID, destino, 'reversa por error de carga', CTX as never);
    expect(envio.programarEnvioFlit2).not.toHaveBeenCalled();
  });
});

describe('HU #13268 · detalleImpuesto expone envioFlit2 (AC10)', () => {
  it('devuelve lo que da envioFlit2DeImpuesto(id), consultado con el id del impuesto', async () => {
    const fila = {
      id: UUID, tramiteId: 'tr-1', estado: EstadoImpuesto.PAGADO, organismoCodigo: '08001', companiaId: 1,
      createdAt: new Date('2026-10-01T00:00:00Z'), updatedAt: new Date('2026-10-01T00:00:00Z'),
      pagadoEn: new Date('2026-10-02T00:00:00Z'), extraccion: null, extraccionFacturaVenta: null, comparacionFacturaRunt: null,
      gestionOperaciones: false, subidoEn: new Date('2026-10-02T00:00:00Z'), tipo: 'recibo_impuesto', nombreArchivo: 'r.pdf',
    };
    // Frontera, cola, compradores, certificaciones, soportes…: toda lectura devuelve la misma fila.
    selectMock.mockImplementation(() => chain([{ imp: fila, dentroDeFrontera: true, ...fila }]));
    const estado = { estado: 'en_espera', intentos: 1, ultimoIntentoEn: '2026-10-05T15:00:00.000Z' };
    envio.envioFlit2DeImpuesto.mockResolvedValue(estado);

    const d = await detalleImpuesto(UUID, CTX as never);

    expect(d).not.toBeNull();
    expect(d!.envioFlit2).toEqual(estado);
    expect(envio.envioFlit2DeImpuesto).toHaveBeenCalledWith(UUID);
  });
});
