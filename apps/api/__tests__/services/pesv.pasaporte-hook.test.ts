import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const appendEventoSafe = vi.fn().mockResolvedValue(undefined);

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const deleteMock = vi.fn();
const executeMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: insertMock, update: updateMock, delete: deleteMock, execute: executeMock, transaction: transactionMock },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('express-rate-limit', () => ({ default: () => (_req: any, _res: any, next: any) => next() }));
vi.mock('../../src/modules/vehicles/vehiculo-historial.js', () => ({
  appendEventoSafe,
  getHistorial: vi.fn(),
  generarCertificadoPdf: vi.fn(),
  normalizeVin: (v: string) => v,
  hydratePasaporteFromLegacy: vi.fn(),
}));
vi.mock('../../src/services/storage.js', () => ({
  uploadEntityDocument: vi.fn().mockResolvedValue('drivers/incidents/1/foto.jpg'),
  getEntityDocumentStream: vi.fn(),
  uploadPhoto: vi.fn(),
  uploadFleetDocument: vi.fn(),
  deleteEntityDocument: vi.fn(),
}));
vi.mock('../../src/modules/jornadas/notify.js', () => ({
  notifyPesvAdmin: vi.fn().mockResolvedValue(undefined),
}));

let app: any;

beforeEach(async () => {
  appendEventoSafe.mockClear();
  selectMock.mockReset();
  insertMock.mockReset();
  updateMock.mockReset();
  deleteMock.mockReset();
  executeMock.mockReset();
  transactionMock.mockReset();
  executeMock.mockResolvedValue([{ '?column?': 1 }]);
  const { createApp } = await import('../../src/app.js');
  app = createApp();
});

describe('TRAM-B1-PESV · pasaporte desde incidente', () => {
  it('reporte móvil con vehicleId registra pesv_incidente en pasaporte', async () => {
    insertMock.mockReturnValueOnce(chain([{
      id: 42,
      tipo: 'accidente',
      estado: 'abierto',
      vehicleId: 9,
    }]));
    selectMock.mockReturnValueOnce(chain([{ vin: '9BWZZZ377VT004251' }]));

    const tok = await testToken({ role: 'conductor', sub: 7 });
    const r = await request(app).post('/api/drivers/incidents/report-mobile')
      .set('Authorization', `Bearer ${tok}`)
      .send({
        tipo: 'accidente',
        fecha: '2026-05-07',
        vehicleId: 9,
        descripcion: 'Colisión leve en intersección con daño en parachoques',
      });

    expect(r.status).toBe(201);
    expect(appendEventoSafe).toHaveBeenCalledWith(expect.objectContaining({
      vin: '9BWZZZ377VT004251',
      eventoTipo: 'pesv_incidente',
      payload: expect.objectContaining({ incidentId: 42, origen: 'mobile', tipo: 'accidente' }),
    }));
  });

  it('reporte móvil sin vehicleId no llama pasaporte', async () => {
    insertMock.mockReturnValueOnce(chain([{
      id: 43,
      tipo: 'casi_accidente',
      estado: 'abierto',
      vehicleId: null,
    }]));

    const tok = await testToken({ role: 'conductor', sub: 7 });
    const r = await request(app).post('/api/drivers/incidents/report-mobile')
      .set('Authorization', `Bearer ${tok}`)
      .send({
        tipo: 'casi_accidente',
        fecha: '2026-05-08',
        descripcion: 'Casi colisión sin vehículo identificado en el momento',
      });

    expect(r.status).toBe(201);
    expect(appendEventoSafe).not.toHaveBeenCalled();
  });
});
