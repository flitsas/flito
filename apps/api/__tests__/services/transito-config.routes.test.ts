import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { Readable } from 'node:stream';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();
const insertMock = vi.fn();

// TRAM-MT-02 Fase 2b — mocks de MinIO (sin tocar storage real).
const storageMocks = vi.hoisted(() => ({
  uploadEntityDocument: vi.fn(),
  deleteEntityDocument: vi.fn(),
  getEntityDocumentStream: vi.fn(),
}));
vi.mock('../../src/services/storage.js', () => storageMocks);

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock,
    insert: insertMock,
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
    execute: vi.fn().mockResolvedValue([]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

vi.mock('../../src/shared/middleware/audit.js', () => ({
  audit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

beforeEach(() => {
  selectMock.mockReset();
  insertMock.mockReset();
  storageMocks.uploadEntityDocument.mockReset();
  storageMocks.deleteEntityDocument.mockReset();
  storageMocks.getEntityDocumentStream.mockReset();
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/tramites/transito-config.routes.js');
  app.use('/api/transito', router);
  return app;
}

describe('transito-config — auth', () => {
  it('GET list sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/transito/organismos-config');
    expect(r.status).toBe(401);
  });

  it('GET list rol transito → 403', async () => {
    const token = await testToken({ sub: 4, role: 'transito', transitoCodigo: '05001' });
    const app = await buildApp();
    const r = await request(app).get('/api/transito/organismos-config').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });
});

describe('transito-config — scope transito', () => {
  it('GET otro organismo → 403', async () => {
    selectMock.mockReturnValueOnce(chain([{ c: null }]));
    const token = await testToken({ sub: 4, role: 'transito', transitoCodigo: '05001' });
    const app = await buildApp();
    const r = await request(app)
      .get('/api/transito/organismos-config/05266')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });

  it('GET propio organismo sin fila config → 200 con defaults', async () => {
    selectMock
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{ c: 2 }]));
    const token = await testToken({ sub: 4, role: 'transito', transitoCodigo: '05001' });
    const app = await buildApp();
    const r = await request(app)
      .get('/api/transito/organismos-config/05001')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.codigo).toBe('05001');
    expect(r.body.ciudad).toBe('Medellín');
    expect(r.body.userCount).toBe(2);
  });
});

describe('transito-config — admin PUT', () => {
  it('código inválido → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app)
      .put('/api/transito/organismos-config/99999')
      .set('Authorization', `Bearer ${token}`)
      .send({ alias: 'X' });
    expect(r.status).toBe(400);
  });

  it('logo http rechazado → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app)
      .put('/api/transito/organismos-config/05001')
      .set('Authorization', `Bearer ${token}`)
      .send({ logoUrl: 'http://inseguro.example/logo.png' });
    expect(r.status).toBe(400);
  });
});

describe('transito-config — checklist overrides (TRAM-MT-02 F2)', () => {
  it('GET checklist sin fila → override vacío', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app)
      .get('/api/transito/organismos-config/05001/checklist/traspaso_standard')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.organismoCodigo).toBe('05001');
    expect(r.body.override.hide).toEqual([]);
  });

  it('PUT checklist hide válido → 200', async () => {
    const saved = { itemsJson: { hide: ['cert_tradicion'], require: [], add: [] }, version: 1, updatedAt: new Date() };
    selectMock
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([saved]));
    insertMock.mockReturnValueOnce({ values: () => ({ onConflictDoUpdate: () => Promise.resolve() }) });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app)
      .put('/api/transito/organismos-config/05001/checklist/traspaso_standard')
      .set('Authorization', `Bearer ${token}`)
      .send({ hide: ['cert_tradicion'] });
    expect(r.status).toBe(200);
    expect(r.body.override.hide).toContain('cert_tradicion');
  });

  it('PUT hide desconocido → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app)
      .put('/api/transito/organismos-config/05001/checklist/traspaso_standard')
      .set('Authorization', `Bearer ${token}`)
      .send({ hide: ['itemo_inventado'] });
    expect(r.status).toBe(400);
  });
});

const PNG = Buffer.from('89504e470d0a1a0a', 'hex'); // firma PNG mínima

describe('transito-config — logo upload (TRAM-MT-02 F2b)', () => {
  it('POST logo rol transito → 403 (solo admin)', async () => {
    const token = await testToken({ sub: 4, role: 'transito', transitoCodigo: '05001' });
    const app = await buildApp();
    const r = await request(app)
      .post('/api/transito/organismos-config/05001/logo')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', PNG, { filename: 'logo.png', contentType: 'image/png' });
    expect(r.status).toBe(403);
    expect(storageMocks.uploadEntityDocument).not.toHaveBeenCalled();
  });

  it('POST logo código inválido → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app)
      .post('/api/transito/organismos-config/99999/logo')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', PNG, { filename: 'logo.png', contentType: 'image/png' });
    expect(r.status).toBe(400);
  });

  it('POST sin archivo → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app)
      .post('/api/transito/organismos-config/05001/logo')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('POST formato no permitido (gif) → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app)
      .post('/api/transito/organismos-config/05001/logo')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('GIF89a'), { filename: 'x.gif', contentType: 'image/gif' });
    expect(r.status).toBe(400);
    expect(storageMocks.uploadEntityDocument).not.toHaveBeenCalled();
  });

  it('POST logo > 512 KB → 400 (LIMIT_FILE_SIZE)', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const big = Buffer.alloc(600 * 1024, 1);
    const r = await request(app)
      .post('/api/transito/organismos-config/05001/logo')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', big, { filename: 'big.png', contentType: 'image/png' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/512/);
    expect(storageMocks.uploadEntityDocument).not.toHaveBeenCalled();
  });

  it('POST logo png válido → 200, sube a MinIO y resuelve ruta API', async () => {
    const key = 'transito/organismos/05001/logo/1_ab_logo.png';
    storageMocks.uploadEntityDocument.mockResolvedValue(key);
    selectMock
      .mockReturnValueOnce(chain([{ k: null }]))                                                    // getOrganismoLogoStorageKey (prev)
      .mockReturnValueOnce(chain([{ codigo: '05001', alias: null, logoUrl: null, logoStorageKey: key, activo: true, updatedAt: new Date() }])) // getOrganismoConfig row
      .mockReturnValueOnce(chain([{ c: 0 }]));                                                       // getOrganismoConfig count
    insertMock.mockReturnValue(chain([]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app)
      .post('/api/transito/organismos-config/05001/logo')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', PNG, { filename: 'logo.png', contentType: 'image/png' });
    expect(r.status).toBe(200);
    expect(storageMocks.uploadEntityDocument).toHaveBeenCalledOnce();
    expect(r.body.logoStorageKey).toBe(key);
    expect(r.body.logoUrl).toBe('/api/transito/organismos-config/05001/logo');
  });

  it('POST logo reemplazo → borra la key anterior tras subir la nueva', async () => {
    const prev = 'transito/organismos/05001/logo/old.png';
    const next = 'transito/organismos/05001/logo/new.png';
    storageMocks.uploadEntityDocument.mockResolvedValue(next);
    selectMock
      .mockReturnValueOnce(chain([{ k: prev }]))
      .mockReturnValueOnce(chain([{ codigo: '05001', alias: null, logoUrl: null, logoStorageKey: next, activo: true, updatedAt: new Date() }]))
      .mockReturnValueOnce(chain([{ c: 0 }]));
    insertMock.mockReturnValue(chain([]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app)
      .post('/api/transito/organismos-config/05001/logo')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', PNG, { filename: 'logo.png', contentType: 'image/png' });
    expect(r.status).toBe(200);
    expect(storageMocks.deleteEntityDocument).toHaveBeenCalledWith(prev);
  });

  it('DELETE logo admin con key → 200 y borra de MinIO', async () => {
    const key = 'transito/organismos/05001/logo/x.png';
    selectMock
      .mockReturnValueOnce(chain([{ k: key }]))                                                       // getOrganismoLogoStorageKey
      .mockReturnValueOnce(chain([{ codigo: '05001', alias: null, logoUrl: null, logoStorageKey: null, activo: true, updatedAt: new Date() }]))
      .mockReturnValueOnce(chain([{ c: 0 }]));
    insertMock.mockReturnValue(chain([]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app)
      .delete('/api/transito/organismos-config/05001/logo')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(storageMocks.deleteEntityDocument).toHaveBeenCalledWith(key);
    expect(r.body.logoStorageKey).toBeNull();
  });

  it('GET logo otro organismo (transito) → 403', async () => {
    const token = await testToken({ sub: 4, role: 'transito', transitoCodigo: '05001' });
    const app = await buildApp();
    const r = await request(app)
      .get('/api/transito/organismos-config/05266/logo')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });

  it('GET logo sin key subida → 404', async () => {
    selectMock.mockReturnValueOnce(chain([{ k: null }]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app)
      .get('/api/transito/organismos-config/05001/logo')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
  });

  it('GET logo con key → 200, stream con content-type por extensión', async () => {
    selectMock.mockReturnValueOnce(chain([{ k: 'transito/organismos/05001/logo/x.png' }]));
    storageMocks.getEntityDocumentStream.mockResolvedValue(Readable.from(PNG));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app)
      .get('/api/transito/organismos-config/05001/logo')
      .set('Authorization', `Bearer ${token}`)
      .buffer(true);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
  });
});
