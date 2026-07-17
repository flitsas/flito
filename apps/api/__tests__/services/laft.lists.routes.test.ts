import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock,
    insert: insertMock,
    update: updateMock,
    delete: vi.fn(),
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const checkAllListsMock = vi.fn();
const decideFromMatchesMock = vi.fn();
const getListsWithCountsMock = vi.fn();
vi.mock('../../src/modules/laft/match.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/laft/match.service.js')>();
  return {
    ...actual,
    checkAllLists: checkAllListsMock,
    decideFromMatches: decideFromMatchesMock,
    getListsWithCounts: getListsWithCountsMock,
  };
});

const syncOfacMock = vi.fn();
const syncUnMock = vi.fn();
const syncEuMock = vi.fn();
vi.mock('../../src/modules/laft/lists/ofac.loader.js', () => ({ syncOfacSdn: syncOfacMock }));
vi.mock('../../src/modules/laft/lists/un.loader.js', () => ({ syncUnConsolidated: syncUnMock }));
vi.mock('../../src/modules/laft/lists/eu.loader.js', () => ({ syncEuSanctions: syncEuMock }));

const syncManualCsvMock = vi.fn();
const isManualListCodeMock = vi.fn();
vi.mock('../../src/modules/laft/lists/manual-csv.loader.js', () => ({
  syncManualCsv: syncManualCsvMock,
  isManualListCode: isManualListCodeMock,
}));

const laftAuditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/modules/laft/audit.service.js', () => ({
  laftAudit: laftAuditMock,
}));

vi.mock('../../src/shared/middleware/rateLimiter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/middleware/rateLimiter.js')>();
  return {
    ...actual,
    apiLimiter: (_req: any, _res: any, next: any) => next(),
  };
});

// Bypass express-rate-limit (la ruta /sync tiene 2 req/hora; con 4 tests sync excede el límite).
vi.mock('express-rate-limit', () => ({
  default: () => (_req: any, _res: any, next: any) => next(),
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
  checkAllListsMock.mockReset();
  decideFromMatchesMock.mockReset();
  getListsWithCountsMock.mockReset();
  syncOfacMock.mockReset();
  syncUnMock.mockReset();
  syncEuMock.mockReset();
  syncManualCsvMock.mockReset();
  isManualListCodeMock.mockReset();
  laftAuditMock.mockClear();
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/laft/lists.routes.js');
  app.use('/api/laft/lists', router);
  return app;
}

describe('laft/lists — auth', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/laft/lists');
    expect(r.status).toBe(401);
  });

  it('proveedor → 403 (requireRole admin|compliance)', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/lists').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });
});

describe('GET / — catálogo de listas', () => {
  it('compliance → devuelve lists con counts', async () => {
    getListsWithCountsMock.mockResolvedValueOnce([
      { id: 1, code: 'OFAC', name: 'OFAC SDN', binding: true, totalEntries: 10000, lastSyncedAt: null, active: true },
    ]);
    const token = await testToken({ sub: 1, role: 'compliance' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/lists').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body[0].code).toBe('OFAC');
  });
});

describe('POST /:code/sync — sync automático (admin only)', () => {
  it('compliance → 403 (sync requiere admin)', async () => {
    const token = await testToken({ sub: 1, role: 'compliance' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/lists/OFAC/sync').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });

  it('código sin loader → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/lists/INVENTADA/sync').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/loader automático/);
  });

  it('OFAC sync exitoso → 200 + audit', async () => {
    syncOfacMock.mockResolvedValueOnce({ listCode: 'OFAC', fetched: 100, inserted: 100, errors: 0, durationMs: 500 });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/lists/OFAC/sync').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.fetched).toBe(100);
    expect(laftAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'sync_list', resourceId: 'OFAC' }),
    );
  });

  it('sync con errors > 0 → 500 (parcial reportado)', async () => {
    syncOfacMock.mockResolvedValueOnce({ listCode: 'OFAC', fetched: 100, inserted: 80, errors: 2, durationMs: 500 });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/lists/OFAC/sync').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(500);
    expect(r.body.error).toMatch(/parcial/);
  });

  it('sync throws → 500 con mensaje', async () => {
    syncOfacMock.mockRejectedValueOnce(new Error('OFAC HTTP 503'));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/lists/OFAC/sync').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(500);
    expect(r.body.error).toContain('OFAC HTTP 503');
  });

  it('lowercase code se uppercase (ofac -> OFAC)', async () => {
    syncOfacMock.mockResolvedValueOnce({ listCode: 'OFAC', fetched: 1, inserted: 1, errors: 0, durationMs: 1 });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/lists/ofac/sync').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(syncOfacMock).toHaveBeenCalled();
  });
});

describe('POST /:code/upload-csv', () => {
  it('código no manual → 400', async () => {
    isManualListCodeMock.mockReturnValueOnce(false);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/lists/OFAC/upload-csv')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('a,b,c\n1,2,3'), { filename: 'x.csv', contentType: 'text/csv' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/no acepta upload manual/);
  });

  it('sin archivo → 400', async () => {
    isManualListCodeMock.mockReturnValueOnce(true);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/lists/PROCURADURIA/upload-csv')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/CSV requerido/);
  });

  it('archivo no CSV (mimetype) → 500 multer fileFilter', async () => {
    isManualListCodeMock.mockReturnValueOnce(true);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    // multer rechaza con error genérico
    const r = await request(app).post('/api/laft/lists/PROCURADURIA/upload-csv')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('binary'), { filename: 'x.png', contentType: 'image/png' });
    // El error de multer se propaga como 500 sin handler
    expect([400, 500]).toContain(r.status);
  });

  it('CSV exitoso → 200 + audit', async () => {
    isManualListCodeMock.mockReturnValueOnce(true);
    syncManualCsvMock.mockResolvedValueOnce({ listCode: 'PROCURADURIA', fetched: 50, inserted: 50, errors: 0, durationMs: 100 });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/lists/PROCURADURIA/upload-csv')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('cedula,nombre\n123,Juan'), { filename: 'lista.csv', contentType: 'text/csv' });
    expect(r.status).toBe(200);
    expect(syncManualCsvMock).toHaveBeenCalledWith(expect.objectContaining({ code: 'PROCURADURIA' }));
    expect(laftAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'upload_list_csv' }),
    );
  });

  it('syncManualCsv throws → 400 con mensaje', async () => {
    isManualListCodeMock.mockReturnValueOnce(true);
    syncManualCsvMock.mockRejectedValueOnce(new Error('CSV malformado'));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/lists/PROCURADURIA/upload-csv')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('x'), { filename: 'x.csv', contentType: 'text/csv' });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('CSV malformado');
  });
});

describe('POST /check/:counterpartyId — chequeo + auto-bloqueo', () => {
  it('id inválido → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/lists/check/abc').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('contraparte no existe → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/lists/check/999').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
    expect(checkAllListsMock).not.toHaveBeenCalled();
  });

  it('decisión shouldBlock=true Y status no es bloqueada → actualiza a bloqueada', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 5, docNumber: '900', fullName: 'Juan', status: 'pendiente', version: 1,
    }]));
    checkAllListsMock.mockResolvedValueOnce([
      { listId: 1, listCode: 'OFAC', listName: 'OFAC', binding: true, score: 100, kind: 'doc_exact', entryId: 9, entryName: 'X', entryDoc: '900' },
    ]);
    decideFromMatchesMock.mockReturnValueOnce({
      shouldBlock: true, reason: 'doc_exact OFAC', needsReview: false, bindingMatches: [],
    });
    insertMock.mockReturnValueOnce({ values: () => Promise.resolve(undefined) });
    let updateValues: any = null;
    updateMock.mockReturnValueOnce({
      set: (v: any) => { updateValues = v; return { where: () => Promise.resolve(undefined) }; },
    });

    const token = await testToken({ sub: 7, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/lists/check/5').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('bloqueada');
    expect(updateValues).toMatchObject({
      status: 'bloqueada',
      blockReason: 'doc_exact OFAC',
      version: 2, // +1 optimistic lock
    });
    expect(laftAuditMock).toHaveBeenCalled();
  });

  it('decisión shouldBlock=false → NO actualiza pero persiste checks (DD §11)', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 5, docNumber: '900', fullName: 'Juan', status: 'pendiente', version: 1,
    }]));
    checkAllListsMock.mockResolvedValueOnce([
      { listId: 1, listCode: 'PEP', listName: 'PEP', binding: false, score: 80, kind: 'name_partial', entryId: 1, entryName: 'X', entryDoc: null },
    ]);
    decideFromMatchesMock.mockReturnValueOnce({
      shouldBlock: false, reason: null, needsReview: false, bindingMatches: [],
    });
    insertMock.mockReturnValueOnce({ values: () => Promise.resolve(undefined) });

    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/lists/check/5').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('pendiente'); // sin cambios
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('contraparte ya bloqueada + shouldBlock=true → NO re-bloquea (idempotente)', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 5, docNumber: '900', fullName: 'Juan', status: 'bloqueada', version: 1,
    }]));
    checkAllListsMock.mockResolvedValueOnce([
      { listId: 1, listCode: 'OFAC', listName: 'OFAC', binding: true, score: 100, kind: 'doc_exact', entryId: 1, entryName: 'X', entryDoc: '900' },
    ]);
    decideFromMatchesMock.mockReturnValueOnce({
      shouldBlock: true, reason: 'X', needsReview: false, bindingMatches: [],
    });
    insertMock.mockReturnValueOnce({ values: () => Promise.resolve(undefined) });

    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/lists/check/5').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('matches vacíos → no inserta checks pero responde 200', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 5, docNumber: '900', fullName: 'Juan', status: 'pendiente', version: 1,
    }]));
    checkAllListsMock.mockResolvedValueOnce([]);
    decideFromMatchesMock.mockReturnValueOnce({ shouldBlock: false, reason: null, needsReview: false, bindingMatches: [] });

    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/lists/check/5').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(insertMock).not.toHaveBeenCalled();
  });
});

describe('GET /entry/:id', () => {
  it('id inválido → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/lists/entry/abc').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('no encontrado → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/lists/entry/999').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
  });
});
