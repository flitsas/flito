import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { chain } from '../helpers/db.js';
import { adminAuth, testToken } from '../helpers/auth.js';

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

// Stub uploadEntityDocument para no hacer S3 real.
vi.mock('../../src/services/storage.js', () => ({
  uploadEntityDocument: vi.fn().mockResolvedValue('drivers/incidents/1/foto.jpg'),
  getEntityDocumentStream: vi.fn(),
  uploadPhoto: vi.fn(),
  uploadFleetDocument: vi.fn(),
  deleteEntityDocument: vi.fn(),
}));

let app: any;
beforeEach(async () => {
  selectMock.mockReset(); insertMock.mockReset(); updateMock.mockReset();
  deleteMock.mockReset(); executeMock.mockReset(); transactionMock.mockReset();
  executeMock.mockResolvedValue([{ '?column?': 1 }]);
  const { createApp } = await import('../../src/app.js');
  app = createApp();
});

describe('PESV-S5 · Roles granulares — lider_pesv', () => {
  it('lider_pesv puede crear política', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        execute: vi.fn().mockResolvedValueOnce([{ next: 1 }]),
        insert: vi.fn().mockReturnValueOnce(chain([{ id: 1, version: 1, estado: 'borrador' }])),
      };
      return cb(tx);
    });
    const tok = await testToken({ role: 'lider_pesv', sub: 5 });
    const r = await request(app).post('/api/pesv/policy')
      .set('Authorization', `Bearer ${tok}`)
      .send({ titulo: 'PSV 2026 nueva', contenidoMd: 'contenido suficientemente largo de la política', vigenciaDesde: '2026-06-01' });
    expect(r.status).toBe(201);
  });

  it('lider_pesv puede crear plan PESV', async () => {
    insertMock.mockReturnValueOnce(chain([{ id: 1, anio: 2026, estado: 'borrador' }]));
    const tok = await testToken({ role: 'lider_pesv', sub: 5 });
    const r = await request(app).post('/api/pesv/plan')
      .set('Authorization', `Bearer ${tok}`)
      .send({ anio: 2026, objetivoGeneral: 'reducir índice accidentalidad anual en 20%' });
    expect(r.status).toBe(201);
  });

  it('lider_pesv puede crear comité', async () => {
    insertMock.mockReturnValueOnce(chain([{ id: 1, nombre: 'CSV Kyverum' }]));
    const tok = await testToken({ role: 'lider_pesv', sub: 5 });
    const r = await request(app).post('/api/pesv/comite')
      .set('Authorization', `Bearer ${tok}`)
      .send({ nombre: 'CSV Kyverum', periodicidad: 'trimestral' });
    expect(r.status).toBe(201);
  });

  it('proveedor NO puede crear política → 403', async () => {
    const tok = await testToken({ role: 'proveedor', sub: 6 });
    const r = await request(app).post('/api/pesv/policy')
      .set('Authorization', `Bearer ${tok}`)
      .send({ titulo: 'X', contenidoMd: 'X', vigenciaDesde: '2026-01-01' });
    expect(r.status).toBe(403);
  });

  it('conductor NO puede crear diagnóstico → 403', async () => {
    const tok = await testToken({ role: 'conductor', sub: 7 });
    const r = await request(app).post('/api/pesv/diagnostico')
      .set('Authorization', `Bearer ${tok}`)
      .send({ anio: 2026, fecha: '2026-05-07' });
    expect(r.status).toBe(403);
  });

  it('lider_pesv NO puede generar export SISI → 403 (admin only por seguridad)', async () => {
    const tok = await testToken({ role: 'lider_pesv', sub: 5 });
    const r = await request(app).post('/api/pesv/export/sisi')
      .set('Authorization', `Bearer ${tok}`)
      .send({});
    expect(r.status).toBe(403);
  });
});

describe('PESV-S5 · Reporte móvil incidente', () => {
  it('conductor con rol "conductor" puede reportar desde móvil → 201', async () => {
    insertMock.mockReturnValueOnce(chain([{ id: 1, tipo: 'casi_accidente', estado: 'reportado' }]));
    updateMock.mockReturnValueOnce(chain([])); // patch descripción con foto key
    insertMock.mockReturnValueOnce(chain([])); // notify outbox vía notifyPesvAdmin (insert outbox)
    selectMock.mockReturnValueOnce(chain([{ email: 'admin@kyverum.com' }])); // getAdminEmails

    const tok = await testToken({ role: 'conductor', sub: 7 });
    const r = await request(app).post('/api/drivers/incidents/report-mobile')
      .set('Authorization', `Bearer ${tok}`)
      .send({
        tipo: 'casi_accidente',
        fecha: '2026-05-07',
        hora: '14:30',
        lat: 4.65,
        lng: -74.10,
        descripcion: 'Casi colisión con motociclista en Av. Boyacá con calle 80',
        // sin fotoBase64 — opcional
      });
    expect(r.status).toBe(201);
    expect(r.body.data.id).toBe(1);
  });

  it('reporte móvil con foto base64 → uploadEntityDocument se invoca', async () => {
    insertMock.mockReturnValueOnce(chain([{ id: 2, tipo: 'accidente', estado: 'reportado' }]));
    updateMock.mockReturnValueOnce(chain([{ id: 2, descripcion: 'desc + foto key' }]));
    insertMock.mockReturnValueOnce(chain([])); // outbox notify
    selectMock.mockReturnValueOnce(chain([{ email: 'admin@kyverum.com' }]));

    const fakeBase64 = Buffer.from('fake-jpeg-data').toString('base64');
    const tok = await testToken({ role: 'conductor', sub: 7 });
    const r = await request(app).post('/api/drivers/incidents/report-mobile')
      .set('Authorization', `Bearer ${tok}`)
      .send({
        tipo: 'accidente',
        fecha: '2026-05-07',
        descripcion: 'Choque trasero leve con vehículo particular',
        fotoBase64: fakeBase64,
        fotoMime: 'image/jpeg',
      });
    expect(r.status).toBe(201);
    expect(r.body.fotoKey).toBeTruthy();
  });

  it('reporte móvil sin auth → 401', async () => {
    const r = await request(app).post('/api/drivers/incidents/report-mobile')
      .send({ tipo: 'accidente', fecha: '2026-05-07', descripcion: 'sin auth nada' });
    expect(r.status).toBe(401);
  });

  it('descripción <10 chars → 400 zod', async () => {
    const tok = await testToken({ role: 'conductor', sub: 7 });
    const r = await request(app).post('/api/drivers/incidents/report-mobile')
      .set('Authorization', `Bearer ${tok}`)
      .send({ tipo: 'comparendo', fecha: '2026-05-07', descripcion: 'corta' });
    expect(r.status).toBe(400);
  });

  it('lat fuera rango → 400 zod', async () => {
    const tok = await testToken({ role: 'conductor', sub: 7 });
    const r = await request(app).post('/api/drivers/incidents/report-mobile')
      .set('Authorization', `Bearer ${tok}`)
      .send({ tipo: 'accidente', fecha: '2026-05-07', descripcion: 'descripción suficiente larga', lat: 999, lng: 0 });
    expect(r.status).toBe(400);
  });
});
