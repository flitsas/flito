// FLITO Tablero (Fase 5 P4). Verifica que resumen() agrega los conteos (por estado con filtro de
// autogestión, revisiones pendientes, sin clasificar, retenidos, estancados, diferencias, compuerta).
// drizzle + compuerta.listar mockeados.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';
import { EstadoImpuesto, EstadoSoat } from '@operaciones/shared-types';

const selectMock = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
const listarCompuertaMock = vi.fn().mockResolvedValue([{}, {}]); // 2 habilitados, sin tocar BD
vi.mock('../../src/modules/flito-compuerta/flito-compuerta.service.js', () => ({ listar: listarCompuertaMock }));

const { resumen } = await import('../../src/modules/flito-tablero/flito-tablero.service.js');
const { default: tableroRoutes } = await import('../../src/modules/flito-tablero/flito-tablero.routes.js');

beforeEach(() => { selectMock.mockReset(); listarCompuertaMock.mockClear().mockResolvedValue([{}, {}]); });

describe('resumen — agrega los indicadores de Operaciones', () => {
  it('mapea conteos por estado y deriva estancados/diferencias', async () => {
    selectMock
      .mockReturnValueOnce(chain([{ estado: EstadoSoat.PAGADO, total: 3 }, { estado: EstadoSoat.SOLICITADO, total: 2 }])) // soat
      .mockReturnValueOnce(chain([{ estado: EstadoImpuesto.PAGADO, total: 1 }, { estado: EstadoImpuesto.SOLICITADO, total: 4 }])) // impuestos
      .mockReturnValueOnce(chain([{ n: 2 }]))  // revisiones soat
      .mockReturnValueOnce(chain([{ n: 1 }]))  // revisiones impuestos
      .mockReturnValueOnce(chain([{ n: 1 }]))  // diferencias de valor
      .mockReturnValueOnce(chain([{ n: 0 }]))  // estancados soat
      .mockReturnValueOnce(chain([{ n: 3 }])); // estancados impuestos

    const r = await resumen();

    expect(r.soat[EstadoSoat.PAGADO]).toBe(3);
    expect(r.soat[EstadoSoat.SOLICITADO]).toBe(2);
    expect(r.soat[EstadoSoat.CON_NOVEDAD]).toBe(0); // estado sin filas → 0
    expect(r.impuestos[EstadoImpuesto.SOLICITADO]).toBe(4);
    expect(r.revisionesPendientes).toEqual({ soat: 2, impuestos: 1 });
    expect(r.diferenciasDeValor).toBe(1);
    expect(r.estancados).toEqual({ soat: 0, impuestos: 3 });
    expect(r.compuertaHabilitados).toBe(2);
  });
});

describe('ruta — solo Operaciones/Auditoría', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/flito/tablero', tableroRoutes);

  it('un gestor no ve el tablero (403)', async () => {
    const token = await testToken({ role: 'gestor_impuestos' });
    const res = await request(app).get('/api/flito/tablero').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});
