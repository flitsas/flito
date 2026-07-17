import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { Readable } from 'stream';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const deleteMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock,
    insert: insertMock,
    update: updateMock,
    delete: deleteMock,
    transaction: transactionMock,
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({
  audit: auditMock,
}));

const uploadEntityDocumentMock = vi.fn();
const getEntityDocumentStreamMock = vi.fn();
const deleteEntityDocumentMock = vi.fn();
vi.mock('../../src/services/storage.js', () => ({
  uploadEntityDocument: uploadEntityDocumentMock,
  getEntityDocumentStream: getEntityDocumentStreamMock,
  deleteEntityDocument: deleteEntityDocumentMock,
}));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

beforeEach(() => {
  selectMock.mockReset();
  insertMock.mockReset();
  updateMock.mockReset();
  deleteMock.mockReset();
  transactionMock.mockReset();
  auditMock.mockClear();
  uploadEntityDocumentMock.mockReset();
  getEntityDocumentStreamMock.mockReset();
  deleteEntityDocumentMock.mockReset().mockResolvedValue(undefined);
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/drivers/documents.routes.js');
  app.use('/api/driver-docs', router);
  return app;
}

const adminToken = () => testToken({ sub: 1, role: 'admin' });

const PDF_BUFFER = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(50, 0)]);

describe('driver-docs — auth', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/driver-docs/types');
    expect(r.status).toBe(401);
  });

  it('proveedor sin PESV → 403', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).get('/api/driver-docs/types').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });
});

describe('GET /types', () => {
  it('admin → 200 con tipos activos ordenados', async () => {
    selectMock.mockReturnValueOnce(chain([
      { id: 1, codigo: 'cedula', nombre: 'Cédula', activo: true, orden: 1 },
      { id: 2, codigo: 'licencia', nombre: 'Licencia', activo: true, orden: 2 },
    ]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/driver-docs/types').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(2);
  });
});

describe('GET /user/:id', () => {
  it('id no numérico → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/driver-docs/user/abc').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('lista documentos del conductor (excluye archivados)', async () => {
    selectMock.mockReturnValueOnce(chain([
      { id: 10, tipoCodigo: 'licencia', estado: 'vigente', archivoFilename: 'lic.pdf' },
      { id: 11, tipoCodigo: 'cedula', estado: 'por_vencer' },
    ]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/driver-docs/user/5').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(2);
  });
});

describe('POST / — crear documento (con archivo opcional)', () => {
  const VALID_BODY = {
    userId: '5', tipoId: '1',
    numero: 'L-12345',
    vigenciaDesde: '2026-01-01',
    vigenciaHasta: '2030-01-01',
  };

  it('proveedor → 403', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).post('/api/driver-docs').set('Authorization', `Bearer ${token}`).send(VALID_BODY);
    expect(r.status).toBe(403);
  });

  it('userId requerido → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/driver-docs').set('Authorization', `Bearer ${token}`)
      .send({ tipoId: '1' });
    expect(r.status).toBe(400);
  });

  it('vigenciaHasta formato inválido → 400 (regex zod)', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/driver-docs').set('Authorization', `Bearer ${token}`)
      .send({ ...VALID_BODY, vigenciaHasta: '01/01/2030' });
    expect(r.status).toBe(400);
  });

  it('user no es conductor → 404', async () => {
    selectMock.mockReturnValueOnce(chain([{ esConductor: false }]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/driver-docs').set('Authorization', `Bearer ${token}`).send(VALID_BODY);
    expect(r.status).toBe(404);
  });

  it('user no existe → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/driver-docs').set('Authorization', `Bearer ${token}`).send(VALID_BODY);
    expect(r.status).toBe(404);
  });

  it('éxito SIN archivo → 201 (storageKey null)', async () => {
    selectMock.mockReturnValueOnce(chain([{ esConductor: true }]));
    let captured: any = null;
    insertMock.mockReturnValueOnce({
      values: (v: any) => { captured = v; return { returning: () => Promise.resolve([{ id: 100, ...v }]) }; },
    });
    const token = await testToken({ sub: 7, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/driver-docs').set('Authorization', `Bearer ${token}`).send(VALID_BODY);
    expect(r.status).toBe(201);
    expect(captured.archivoStorageKey).toBeNull();
    expect(captured.archivoFilename).toBeNull();
    expect(captured.subidoPor).toBe(7);
    expect(uploadEntityDocumentMock).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'upload', resource: 'driver_document' }),
    );
  });

  it('éxito CON archivo PDF → uploadEntityDocument + storageKey persistido', async () => {
    selectMock.mockReturnValueOnce(chain([{ esConductor: true }]));
    uploadEntityDocumentMock.mockResolvedValueOnce('drivers/documents/5/123_abc_lic.pdf');
    let captured: any = null;
    insertMock.mockReturnValueOnce({
      values: (v: any) => { captured = v; return { returning: () => Promise.resolve([{ id: 100, ...v }]) }; },
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/driver-docs').set('Authorization', `Bearer ${token}`)
      .field('userId', '5')
      .field('tipoId', '1')
      .attach('archivo', PDF_BUFFER, { filename: 'licencia.pdf', contentType: 'application/pdf' });
    expect(r.status).toBe(201);
    expect(uploadEntityDocumentMock).toHaveBeenCalledWith(
      'drivers/documents', 5, 'licencia.pdf', expect.any(Buffer), 'application/pdf',
    );
    expect(captured.archivoStorageKey).toBe('drivers/documents/5/123_abc_lic.pdf');
    expect(captured.archivoFilename).toBe('licencia.pdf');
    expect(captured.archivoMime).toBe('application/pdf');
  });

  it('archivo con mime no permitido (text/plain) → 500 fileFilter throws', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/driver-docs').set('Authorization', `Bearer ${token}`)
      .field('userId', '5')
      .field('tipoId', '1')
      .attach('archivo', Buffer.from('texto'), { filename: 'evil.txt', contentType: 'text/plain' });
    expect([400, 500]).toContain(r.status);
  });

  it('destinatariosExtra como string CSV → preprocess convierte a array', async () => {
    selectMock.mockReturnValueOnce(chain([{ esConductor: true }]));
    let captured: any = null;
    insertMock.mockReturnValueOnce({
      values: (v: any) => { captured = v; return { returning: () => Promise.resolve([{ id: 100, ...v }]) }; },
    });
    const token = await adminToken();
    const app = await buildApp();
    await request(app).post('/api/driver-docs').set('Authorization', `Bearer ${token}`)
      .send({ ...VALID_BODY, destinatariosExtra: 'a@x.com, b@x.com,c@x.com' });
    expect(captured.destinatariosExtra).toEqual(['a@x.com', 'b@x.com', 'c@x.com']);
  });

  it('destinatariosExtra con email inválido → 400 zod', async () => {
    selectMock.mockReturnValueOnce(chain([{ esConductor: true }]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/driver-docs').set('Authorization', `Bearer ${token}`)
      .send({ ...VALID_BODY, destinatariosExtra: 'no-arroba' });
    expect(r.status).toBe(400);
  });
});

describe('PATCH /:id — update con reset de alertas si cambia vigencia', () => {
  it('id inválido → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/driver-docs/abc').set('Authorization', `Bearer ${token}`)
      .send({ numero: 'X' });
    expect(r.status).toBe(400);
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
    const r = await request(app).patch('/api/driver-docs/999').set('Authorization', `Bearer ${token}`)
      .send({ numero: 'X' });
    expect(r.status).toBe(404);
  });

  it('actualizar numero (sin vigenciaHasta) → NO borra alertas', async () => {
    let deleteCalled = false;
    transactionMock.mockImplementationOnce(async (cb) => {
      const tx = {
        update: vi.fn(() => ({
          set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 1, numero: 'X' }]) }) }),
        })),
        delete: vi.fn(() => { deleteCalled = true; return { where: () => Promise.resolve(undefined) }; }),
      };
      return cb(tx);
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/driver-docs/1').set('Authorization', `Bearer ${token}`)
      .send({ numero: 'NEW-001' });
    expect(r.status).toBe(200);
    expect(deleteCalled).toBe(false);
  });

  it('actualizar vigenciaHasta → BORRA alertas (transaction)', async () => {
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
    const r = await request(app).patch('/api/driver-docs/1').set('Authorization', `Bearer ${token}`)
      .send({ vigenciaHasta: '2031-01-01' });
    expect(r.status).toBe(200);
    expect(deleteCalled).toBe(true);
  });

  it('vigenciaHasta=null (limpiar fecha) → también borra alertas (undefined check)', async () => {
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
    const r = await request(app).patch('/api/driver-docs/1').set('Authorization', `Bearer ${token}`)
      .send({ vigenciaHasta: null });
    expect(r.status).toBe(200);
    expect(deleteCalled).toBe(true); // null !== undefined → SI borra
  });
});

describe('DELETE /:id — soft delete + cleanup S3', () => {
  it('id inválido → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).delete('/api/driver-docs/abc').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('no encontrado → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).delete('/api/driver-docs/999').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
  });

  it('doc con archivo → deleteEntityDocument + soft delete BD', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 1, archivoStorageKey: 'drivers/documents/5/abc.pdf',
    }]));
    let updateValues: any = null;
    updateMock.mockReturnValueOnce({
      set: (v: any) => { updateValues = v; return { where: () => Promise.resolve(undefined) }; },
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).delete('/api/driver-docs/1').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(deleteEntityDocumentMock).toHaveBeenCalledWith('drivers/documents/5/abc.pdf');
    expect(updateValues.estado).toBe('archivado');
    expect(auditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'delete', resource: 'driver_document' }),
    );
  });

  it('doc SIN archivo → soft delete BD sin llamar deleteEntityDocument', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, archivoStorageKey: null }]));
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => Promise.resolve(undefined) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).delete('/api/driver-docs/1').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(deleteEntityDocumentMock).not.toHaveBeenCalled();
  });

  it('proveedor → 403', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).delete('/api/driver-docs/1').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });
});

describe('GET /:id/download — stream archivo', () => {
  it('id inválido → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/driver-docs/abc/download').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('no encontrado → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/driver-docs/999/download').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
  });

  it('doc sin archivoStorageKey → 404', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, archivoStorageKey: null }]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/driver-docs/1/download').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
  });

  it('doc con archivo → stream + Content-Disposition con filename', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 1, archivoStorageKey: 'drivers/documents/5/x.pdf',
      archivoMime: 'application/pdf', archivoFilename: 'licencia.pdf',
    }]));
    const stream = Readable.from(Buffer.from('%PDF-content'));
    getEntityDocumentStreamMock.mockResolvedValueOnce(stream);
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/driver-docs/1/download').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/application\/pdf/);
    expect(r.headers['content-disposition']).toContain('licencia.pdf');
  });
});
