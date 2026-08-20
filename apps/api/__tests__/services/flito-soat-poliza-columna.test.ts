// FLITO SOAT — la póliza sube de la extracción a su columna al pagar (HU #11673, Feature #11623).
//
// `pagarEnTx` es el ÚNICO punto del sistema que escribe `estado = 'pagado'` y `extraccion` a la vez,
// y por eso es el único sitio donde puede escribirse `numero_poliza` sin abrir un segundo camino que
// mañana discrepe. Los dos flujos que llevan un SOAT a pagado —la carga directa de la factura y la
// confirmación en la cola de revisión OCR— pasan por él.
//
// Qué se está cazando aquí, que no caza ningún otro test:
//
//   · **que la columna deje de escribirse.** No rompe nada visible: el SOAT queda pagado, la
//     pantalla lo pinta igual y la póliza sigue en `extraccion`. Lo que se rompe es la conciliación,
//     semanas después y en otro módulo: la fila del Excel dice «no encontrada» sobre un SOAT que
//     está ahí, y nadie relaciona una cosa con la otra.
//
//   · **que se escriba SIN normalizar.** El backfill de la 0157 dejó los históricos normalizados; un
//     `'FLIT-999'` escrito en crudo aquí no cruzaría con el `'FLIT999'` de una boleta, y además
//     violaría el CHECK `flito_soat_numero_poliza_norm_chk` — un 23514 en la transacción del pago.
//
//   · **que un pago sin póliza legible BORRE la que había.** La póliza es campo requerido para
//     llegar a pagado, así que el caso es raro; pero si llega, machacar con `null` una corrección
//     hecha a mano sería perder el único dato con el que ese SOAT podía conciliarse.
//
// Drizzle está mockeado: lo que se afirma es el PAYLOAD del `set()`, que es exactamente la promesa
// del AC4. Que la columna exista y aguante ese valor lo afirman la migración y el test de paridad.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chain } from '../helpers/db.js';
import { CampoSoat, normalizarPoliza } from '@operaciones/shared-types';
import type { ExtraccionSoat } from '@operaciones/shared-types';

const transactionMock = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), update: vi.fn(), insert: vi.fn(), delete: vi.fn(), transaction: transactionMock, execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const { marcarPagado } = await import('../../src/modules/flito-soat/flito-soat.service.js');

const SOAT_ID = '11111111-1111-1111-1111-111111111111';
const VIN = '9BWZZZ377VT004251';
const ctx = { userId: 7, username: 'financiera@x.io', role: 'admin', proveedorSoatId: null };

const campo = (valor: string | null) => ({ valor, confianza: 0.95, confiable: true });

/** Extracción completa, con la póliza que se le pase (o sin el campo si es `undefined`). */
function extraccion(poliza?: string | null): ExtraccionSoat {
  const base = {
    [CampoSoat.PLACA]: campo('QTQ100'),
    [CampoSoat.VIN]: campo(VIN),
    [CampoSoat.VALOR_TOTAL]: campo('250000'),
    [CampoSoat.ASEGURADORA]: campo('SURA'),
  } as ExtraccionSoat;
  return poliza === undefined ? base : { ...base, [CampoSoat.NUMERO_POLIZA]: campo(poliza) };
}

/** Captura el objeto que `pagarEnTx` le pasa a `set()`. Es lo único que este test mira. */
function montarTx() {
  const setSpy = vi.fn().mockReturnValue({ where: () => Promise.resolve([]) });
  const txSelect = vi.fn()
    .mockReturnValueOnce(chain([{ id: SOAT_ID, vin: VIN, estado: 'solicitado' }])) // el SOAT
    .mockReturnValueOnce(chain([{ id: 'sop-1' }]))                                 // su factura
    .mockReturnValueOnce(chain([{ n: 1 }]));                                       // count de soportes
  const tx = { select: txSelect, update: vi.fn(() => ({ set: setSpy })), insert: vi.fn(() => chain([])) };
  transactionMock.mockImplementation(async (cb: (t: unknown) => unknown) => cb(tx));
  return { setSpy, tx };
}

beforeEach(() => { transactionMock.mockReset(); });

describe('pagarEnTx — `numero_poliza` se escribe en el mismo `set()` que el estado (AC4)', () => {
  it('**escribe la póliza normalizada** junto a estado, extracción y valor pagado', async () => {
    const { setSpy } = montarTx();

    await marcarPagado(SOAT_ID, extraccion('FLIT-999'), ctx);

    const payload = setSpy.mock.calls[0][0];
    expect(payload.numeroPoliza).toBe('FLIT999');
    // En el MISMO `set()`: si la columna se escribiera en un UPDATE aparte, un fallo entre los dos
    // dejaría un SOAT pagado sin la llave con la que se concilia, y nada volvería a intentarlo.
    expect(payload.estado).toBe('pagado');
    expect(payload.valorPagado).toBe('250000');
    expect(payload.extraccion).toBeDefined();
  });

  it('normaliza igual que `normalizarPoliza`, no «como se leyó»', () => {
    // La aserción de arriba fija el valor concreto; esta fija de dónde sale, para que cambiar la
    // regla en shared-types no deje aquí una copia con vida propia.
    expect(normalizarPoliza('FLIT-999')).toBe('FLIT999');
  });

  it.each([
    ['minúsculas y espacios', 'flit 999', 'FLIT999'],
    ['con acentos que se tiran', 'Póliza 12', 'PLIZA12'],
    ['ya normalizada, se queda igual', 'ABC0O1', 'ABC0O1'],
  ])('%s → %s', async (_caso, cruda, esperada) => {
    const { setSpy } = montarTx();
    await marcarPagado(SOAT_ID, extraccion(cruda), ctx);
    expect(setSpy.mock.calls[0][0].numeroPoliza).toBe(esperada);
  });

  it('**sin póliza legible NO toca la columna** (no la pone a null): el pago sigue su curso', async () => {
    // El `set()` no lleva la clave en absoluto. La diferencia con `numeroPoliza: null` importa: esto
    // deja intacta una corrección manual anterior, y aquello la borraría sin que nadie lo pidiera.
    for (const sinNada of [undefined, null, '   ']) {
      const { setSpy } = montarTx();
      await marcarPagado(SOAT_ID, extraccion(sinNada as string | null | undefined), ctx);
      const payload = setSpy.mock.calls[0][0];
      expect(Object.hasOwn(payload, 'numeroPoliza'), `póliza ${JSON.stringify(sinNada)}`).toBe(false);
      // Y lo importante: el pago no se frena por eso.
      expect(payload.estado).toBe('pagado');
    }
  });

  it('el resto del flujo de pago no cambia: historial de estado y bitácora siguen en la misma tx', async () => {
    // El AC4 dice «y el flujo de pago no cambia en ningún otro aspecto observable». Los dos INSERT
    // son ese resto: la fila de `flito_estado_historial` y la de `audit_logs`.
    const { setSpy, tx } = montarTx();
    await marcarPagado(SOAT_ID, extraccion('FLIT-999'), ctx);
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(tx.insert).toHaveBeenCalledTimes(2);
    expect(setSpy.mock.calls[0][0].motivoRechazo).toBeNull();
    expect(setSpy.mock.calls[0][0].pagadoEn).toBeInstanceOf(Date);
  });
});
