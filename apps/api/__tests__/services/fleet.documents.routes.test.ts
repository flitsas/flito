import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createKeyedDb } from '../helpers/keyed-db.js';
import request from 'supertest';
import express from 'express';
import { Readable } from 'stream';
import { testToken } from '../helpers/auth.js';

// OPS-02b r2: mock KEYED por tabla.
const kdb = createKeyedDb();
const { select: selectMock, insert: insertMock, update: updateMock, transaction: transactionMock } = kdb;

vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({
  audit: auditMock,
}));

const uploadFleetDocMock = vi.fn();
const getFleetDocStreamMock = vi.fn();
const deleteFleetDocMock = vi.fn();
vi.mock('../../src/services/storage.js', () => ({
  uploadFleetDocument: uploadFleetDocMock,
  getFleetDocumentStream: getFleetDocStreamMock,
  deleteFleetDocument: deleteFleetDocMock,
  uploadEntityDocument: vi.fn(),
  getEntityDocumentStream: vi.fn(),
  deleteEntityDocument: vi.fn(),
}));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

beforeEach(() => {
  kdb.reset();
  auditMock.mockClear();
  uploadFleetDocMock.mockReset();
  getFleetDocStreamMock.mockReset();
  deleteFleetDocMock.mockReset().mockResolvedValue(undefined);
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/fleet/documents.routes.js');
  app.use('/api/fleet/docs', router);
  return app;
}

const adminToken = () => testToken({ sub: 1, role: 'admin' });
const PDF_BUFFER = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(50, 0)]);

describe('fleet docs — auth', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/fleet/docs/types');
    expect(r.status).toBe(401);
  });

  it('proveedor → 403', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).get('/api/fleet/docs/types').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });
});

describe('GET /types', () => {
  it('200 con tipos activos', async () => {
    kdb.when.selectOnce('document_types', [{ id: 1, codigo: 'soat' }, { id: 2, codigo: 'tecno' }]);
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/fleet/docs/types').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(2);
  });
});

describe('POST /types', () => {
  it('codigo inválido (no regex) → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/fleet/docs/types').set('Authorization', `Bearer ${token}`)
      .send({ codigo: 'CON MAYUS', nombre: 'X' });
    expect(r.status).toBe(400);
  });

  it('éxito → 201', async () => {
    insertMock.mockReturnValueOnce({
      values: () => ({ returning: () => Promise.resolve([{ id: 100, codigo: 'soat' }]) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/fleet/docs/types').set('Authorization', `Bearer ${token}`)
      .send({ codigo: 'soat', nombre: 'SOAT' });
    expect(r.status).toBe(201);
  });
});

describe('GET /vehicle/:id', () => {
  it('id inválido → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/fleet/docs/vehicle/abc').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('lista documentos no archivados → 200', async () => {
    kdb.when.selectOnce('vehicle_documents', [{ id: 1, tipoCodigo: 'soat', estado: 'vigente' }]);
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/fleet/docs/vehicle/5').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
  });
});

describe('POST /', () => {
  const VALID = { vehicleId: '5', tipoId: '1' };

  it('vehículo no es flota propia → 404', async () => {
    kdb.when.selectOnce('vehicles', [{ id: 5, esFlota: false }]);
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/fleet/docs').set('Authorization', `Bearer ${token}`).send(VALID);
    expect(r.status).toBe(404);
  });

  it('éxito sin archivo → 201', async () => {
    kdb.when.selectOnce('vehicles', [{ id: 5, esFlota: true }]);
    let captured: any = null;
    insertMock.mockReturnValueOnce({
      values: (v: any) => { captured = v; return { returning: () => Promise.resolve([{ id: 100, ...v }]) }; },
    });
    const token = await testToken({ sub: 7, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/fleet/docs').set('Authorization', `Bearer ${token}`).send(VALID);
    expect(r.status).toBe(201);
    expect(captured.archivoStorageKey).toBeNull();
    expect(captured.subidoPor).toBe(7);
  });

  it('éxito con PDF → uploadFleetDocument llamado', async () => {
    kdb.when.selectOnce('vehicles', [{ id: 5, esFlota: true }]);
    uploadFleetDocMock.mockResolvedValueOnce('fleet/5/abc.pdf');
    let captured: any = null;
    insertMock.mockReturnValueOnce({
      values: (v: any) => { captured = v; return { returning: () => Promise.resolve([{ id: 100, ...v }]) }; },
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/fleet/docs').set('Authorization', `Bearer ${token}`)
      .field('vehicleId', '5')
      .field('tipoId', '1')
      .attach('archivo', PDF_BUFFER, { filename: 'soat.pdf', contentType: 'application/pdf' });
    expect(r.status).toBe(201);
    expect(uploadFleetDocMock).toHaveBeenCalledWith(5, 'soat.pdf', expect.any(Buffer), 'application/pdf');
    expect(captured.archivoStorageKey).toBe('fleet/5/abc.pdf');
  });

  it('mime no permitido → 500 fileFilter', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/fleet/docs').set('Authorization', `Bearer ${token}`)
      .field('vehicleId', '5')
      .field('tipoId', '1')
      .attach('archivo', Buffer.from('x'), { filename: 'evil.txt', contentType: 'text/plain' });
    expect([400, 500]).toContain(r.status);
  });

  it('destinatariosExtra como CSV → preprocess a array', async () => {
    kdb.when.selectOnce('vehicles', [{ id: 5, esFlota: true }]);
    let captured: any = null;
    insertMock.mockReturnValueOnce({
      values: (v: any) => { captured = v; return { returning: () => Promise.resolve([{ id: 100, ...v }]) }; },
    });
    const token = await adminToken();
    const app = await buildApp();
    await request(app).post('/api/fleet/docs').set('Authorization', `Bearer ${token}`)
      .send({ ...VALID, destinatariosExtra: 'a@x.com,b@x.com' });
    expect(captured.destinatariosExtra).toEqual(['a@x.com', 'b@x.com']);
  });
});

describe('PATCH /:id', () => {
  it('id inválido → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/fleet/docs/abc').set('Authorization', `Bearer ${token}`)
      .send({ numero: 'X' });
    expect(r.status).toBe(400);
  });

  it('vigenciaHasta cambia → borra alertas', async () => {
    let deleteCalled = false;
    transactionMock.mockImplementationOnce(async (cb) => {
      const tx = {
        update: vi.fn(() => ({
          set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 1 }]) }) }),
        })),
        delete: vi.fn(() => ({
          where: () => { deleteCalled = true; return Promise.resolve(undefined); },
        })),
      };
      return cb(tx);
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/fleet/docs/1').set('Authorization', `Bearer ${token}`)
      .send({ vigenciaHasta: '2027-01-01' });
    expect(r.status).toBe(200);
    expect(deleteCalled).toBe(true);
  });

  it('no encontrado → 404', async () => {
    transactionMock.mockImplementationOnce(async (cb) => {
      const tx = {
        update: vi.fn(() => ({
          set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
        })),
        delete: vi.fn(),
      };
      return cb(tx);
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/fleet/docs/999').set('Authorization', `Bearer ${token}`)
      .send({ numero: 'X' });
    expect(r.status).toBe(404);
  });
});

describe('DELETE /:id', () => {
  it('no encontrado → 404', async () => {
    kdb.when.selectOnce('vehicle_documents', []);
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).delete('/api/fleet/docs/999').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
  });

  it('con archivo → deleteFleetDocument + soft delete', async () => {
    kdb.when.selectOnce('vehicle_documents', [{ id: 1, archivoStorageKey: 'fleet/5/x.pdf' }]);
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => Promise.resolve(undefined) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).delete('/api/fleet/docs/1').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(deleteFleetDocMock).toHaveBeenCalledWith('fleet/5/x.pdf');
  });
});

describe('GET /:id/download', () => {
  it('no encontrado o sin archivo → 404', async () => {
    kdb.when.selectOnce('vehicle_documents', [{ id: 1, archivoStorageKey: null }]);
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/fleet/docs/1/download').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
  });

  it('con archivo → stream PDF', async () => {
    kdb.when.selectOnce('vehicle_documents', [{
      id: 1, archivoStorageKey: 'fleet/5/x.pdf',
      archivoMime: 'application/pdf', archivoFilename: 'soat.pdf',
    }]);
    getFleetDocStreamMock.mockResolvedValueOnce(Readable.from(Buffer.from('%PDF')));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/fleet/docs/1/download').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toContain('soat.pdf');
  });
});

describe('GET /expiring', () => {
  it('200 con count', async () => {
    kdb.when.selectOnce('vehicle_documents', [
      { id: 1, plate: 'ABC123', vigenciaHasta: '2026-05-15' },
    ]);
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/fleet/docs/expiring?dias=15').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(1);
  });
});
