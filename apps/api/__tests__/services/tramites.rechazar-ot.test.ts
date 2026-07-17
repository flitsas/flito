// TRAM-PRODUCTO · TRAM-OPS-02 — POST /api/tramites/:id/rechazar-ot

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();
const updateMock = vi.fn();
const insertMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock,
    insert: insertMock,
    update: updateMock,
    delete: vi.fn(),
    execute: vi.fn().mockResolvedValue([]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));

const emitEventoMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/modules/tramites/eventos.js', () => ({
  emitEvento: emitEventoMock,
  sha256: vi.fn(),
  getTimeline: vi.fn(),
  generateVerifyToken: vi.fn(),
}));

vi.mock('../../src/modules/tramites/notificaciones.js', () => ({
  notifyEstado: vi.fn().mockResolvedValue(undefined),
  notifConfig: vi.fn().mockReturnValue({ email: false, whatsapp: false }),
}));

beforeEach(() => {
  selectMock.mockReset();
  updateMock.mockReset();
  insertMock.mockReset();
  auditMock.mockClear();
  emitEventoMock.mockClear();
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/tramites/tramites.routes.js');
  app.use('/api/tramites', router);
  return app;
}

describe('GET /api/tramites/motivos-rechazo-ot', () => {
  it('admin → catálogo de motivos', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/motivos-rechazo-ot').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.some((m: { codigo: string }) => m.codigo === 'comparendo')).toBe(true);
  });
});

describe('POST /api/tramites/:id/rechazar-ot', () => {
  it('código inválido → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/1/rechazar-ot').set('Authorization', `Bearer ${token}`).send({ codigo: 'foo' });
    expect(r.status).toBe(400);
  });

  it('trámite no encontrado → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/99/rechazar-ot').set('Authorization', `Bearer ${token}`).send({ codigo: 'otro' });
    expect(r.status).toBe(404);
  });

  it('estado no elegible → 409', async () => {
    selectMock.mockReturnValueOnce(chain([{ estado: 'borrador', tipologiaCodigo: null, checklistEstado: null }]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/1/rechazar-ot').set('Authorization', `Bearer ${token}`).send({ codigo: 'laft' });
    expect(r.status).toBe(409);
    expect(r.body.estado).toBe('borrador');
  });

  it('rechazo OK → 200 + evento con payload', async () => {
    selectMock
      .mockReturnValueOnce(chain([{ estado: 'enviado_transito', tipologiaCodigo: 'traspaso_standard', checklistEstado: {} }]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{ estado: 'enviado_transito', tipologiaCodigo: 'traspaso_standard', checklistEstado: {} }]));
    updateMock
      .mockReturnValueOnce(chain([{
        id: 1, estado: 'rechazado', vin: 'ABC123', placa: null, paso: 1, tipologiaCodigo: 'traspaso_standard',
        checklistEstado: {}, motivoRechazoCodigo: null, createdAt: new Date(), updatedAt: new Date(),
      }]))
      .mockReturnValueOnce(chain([{
        id: 1, estado: 'rechazado', vin: 'ABC123', placa: null, paso: 1, tipologiaCodigo: 'traspaso_standard',
        checklistEstado: {}, motivoRechazoCodigo: 'comparendo', createdAt: new Date(), updatedAt: new Date(),
      }]));
    insertMock.mockReturnValueOnce(chain([{ id: 1 }]));

    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/1/rechazar-ot').set('Authorization', `Bearer ${token}`).send({ codigo: 'comparendo', nota: 'SIMIT' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.tramite.estado).toBe('rechazado');
    expect(emitEventoMock).toHaveBeenCalledWith(expect.objectContaining({
      tramiteId: 1,
      tipo: 'rechazado_ot',
      payload: expect.objectContaining({ codigo: 'comparendo', nota: 'SIMIT' }),
    }));
  });
});
