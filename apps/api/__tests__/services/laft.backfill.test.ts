import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock del client BD: simula 1 fila con doc_number_enc=null en la primera llamada,
// y 0 filas en la segunda (ya está cifrada). Verificamos que en la 2da corrida
// del backfill NO se ejecuta UPDATE.

const executeMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    execute: executeMock,
    transaction: transactionMock,
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

beforeEach(() => {
  executeMock.mockReset();
  transactionMock.mockReset();
});

describe('laft/backfill — idempotencia', () => {
  it('1ra corrida cifra 2 filas; 2da corrida NO toca BD (filtro doc_number_enc IS NULL)', async () => {
    // 1ra: SELECT devuelve 2 filas; 2da SELECT (siguiente batch) devuelve 0.
    executeMock
      .mockResolvedValueOnce([
        { id: 1, doc_number: '1036640908', email: 'a@a.com', phone: '+57300' },
        { id: 2, doc_number: '900123456', email: null, phone: null },
      ])
      .mockResolvedValueOnce([]);

    const updatesEjecutados: number[] = [];
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        execute: vi.fn(async (q: any) => {
          // Cada UPDATE ejecutado en la transacción registra el id (extraído del query SQL).
          // Como Drizzle template tag retorna un objeto opaco, sólo contamos ejecuciones.
          updatesEjecutados.push(updatesEjecutados.length + 1);
          return [];
        }),
      };
      return cb(tx);
    });

    const { run } = await import('../../src/scripts/laft-encrypt-pii-backfill.js');
    const stats1 = await run();
    expect(stats1.cifradas).toBe(2);
    expect(stats1.total).toBe(2);
    expect(updatesEjecutados.length).toBe(2);
    expect(transactionMock).toHaveBeenCalledTimes(1);

    // 2da corrida: SELECT devuelve 0 → no entra al loop, no llama transaction.
    executeMock.mockResolvedValueOnce([]);
    const stats2 = await run();
    expect(stats2.cifradas).toBe(0);
    expect(stats2.total).toBe(0);
    // transactionMock se mantuvo en 1 (no se llamó otra vez).
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });

  it('fila sin doc_number → la salta y NO la incluye en updates', async () => {
    executeMock
      .mockResolvedValueOnce([
        { id: 5, doc_number: null, email: null, phone: null },
      ])
      .mockResolvedValueOnce([]);

    transactionMock.mockImplementation(async (_cb: any) => {
      // Si llegáramos aquí con 0 updates, la transacción sigue corriendo pero sin work.
      return [];
    });

    const { run } = await import('../../src/scripts/laft-encrypt-pii-backfill.js');
    const stats = await run();
    expect(stats.total).toBe(1);
    expect(stats.saltadas).toBe(1);
    expect(stats.cifradas).toBe(0);
  });
});
