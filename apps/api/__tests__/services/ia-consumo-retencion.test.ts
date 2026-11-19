// Contrato `ia-consumo` v1 — retención del detalle (RN-IAC1..4). Sin BD: conexión simulada y candado mockeado.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/client.js', () => ({ db: {}, getPoolStats: vi.fn() }));
const lockMock = vi.hoisted(() => vi.fn(async (_n: string, _t: number, fn: () => Promise<unknown>) => fn()));
vi.mock('../../src/shared/utils/lock.js', () => ({ withLock: lockMock }));

const { purgarDetalleIa, latidoRetencionIa, reiniciarEstadoRetencionIa, LOTE_RETENCION_IA, NOMBRE_LOCK_RETENCION_IA } =
  await import('../../src/modules/ia-consumo/ia-consumo-retencion.cron.js');

function conexionFalsa(totalViejos: number) {
  let quedan = totalViejos;
  const cortes: unknown[] = [];
  const conexion = {
    select: () => ({ from: () => ({ where: (w: unknown) => { cortes.push(w); return { limit: async (n: number) => Array.from({ length: Math.min(n, quedan) }, (_, i) => ({ id: `id-${i}` })) }; } }) }),
    delete: () => ({ where: () => ({ returning: async () => { const n = Math.min(LOTE_RETENCION_IA, quedan); quedan -= n; return Array.from({ length: n }, () => ({ id: 'x' })); } }) }),
  };
  return { conexion, cortes, quedan: () => quedan };
}

beforeEach(() => { reiniciarEstadoRetencionIa(); lockMock.mockClear(); });

describe('purgarDetalleIa', () => {
  it('borra por lotes hasta vaciar lo vencido y calcula el corte con los días', async () => {
    const f = conexionFalsa(LOTE_RETENCION_IA * 2 + 7);
    const ahora = new Date('2026-11-18T09:00:00Z');
    const r = await purgarDetalleIa({ ahora, dias: 30, conexion: f.conexion as never });
    expect(r.borrados).toBe(LOTE_RETENCION_IA * 2 + 7);
    expect(r.corte.toISOString()).toBe('2026-10-19T09:00:00.000Z');
    expect(f.quedan()).toBe(0);
  });

  it('sin detalle vencido no borra nada', async () => {
    const f = conexionFalsa(0);
    expect((await purgarDetalleIa({ dias: 30, conexion: f.conexion as never })).borrados).toBe(0);
  });
});

describe('latidoRetencionIa', () => {
  it('fuera de la hora 04 de Colombia no corre; dentro corre una vez al día con candado', async () => {
    expect(await latidoRetencionIa(new Date('2026-11-18T12:00:00Z'))).toBe('fuera_de_ventana');
    lockMock.mockResolvedValueOnce({ borrados: 0, corte: new Date() });
    // 09:30 UTC = 04:30 en Bogotá.
    expect(await latidoRetencionIa(new Date('2026-11-18T09:30:00Z'))).toBe('corrida');
    expect(lockMock.mock.calls[0]![0]).toBe(NOMBRE_LOCK_RETENCION_IA);
    expect(await latidoRetencionIa(new Date('2026-11-18T09:40:00Z'))).toBe('ya_corrio_hoy');
  });

  it('otra instancia con el candado → no borra y no repite ese día', async () => {
    lockMock.mockResolvedValueOnce(null);
    expect(await latidoRetencionIa(new Date('2026-11-19T09:30:00Z'))).toBe('otra_instancia');
  });
});
