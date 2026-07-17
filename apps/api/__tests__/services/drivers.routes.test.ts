import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const transactionMock = vi.fn();
const executeMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock,
    insert: insertMock,
    update: updateMock,
    transaction: transactionMock,
    execute: executeMock,
    delete: vi.fn(),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({
  audit: auditMock,
}));

// Mock crypto helpers — devolver placeholders deterministas
vi.mock('../../src/shared/utils/crypto.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/utils/crypto.js')>();
  return {
    ...actual,
    encryptPii: vi.fn(() => ({
      cipher: Buffer.from('CIPHER'),
      iv: Buffer.from('IV'),
      authTag: Buffer.from('TAG'),
      keyVersion: 1,
    })),
    decryptPii: vi.fn(() => 'PLAINTEXT'),
    hmacCedula: vi.fn(() => Buffer.from('HMAC32bytes______________________')),
    newUuid: vi.fn(() => 'uuid-test-0000'),
    normalizeDocument: vi.fn((s: string) => s.replace(/\D/g, '')),
  };
});

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

beforeEach(() => {
  selectMock.mockReset();
  insertMock.mockReset();
  updateMock.mockReset();
  transactionMock.mockReset();
  executeMock.mockReset().mockResolvedValue([{ '?column?': 1 }]);
  auditMock.mockClear();
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/drivers/drivers.routes.js');
  app.use('/api/drivers', router);
  return app;
}

// admin tiene PESV en defaults; transito y otros NO. Usar admin para casos felices.
const adminToken = () => testToken({ sub: 1, role: 'admin' });

describe('drivers — auth + requirePage(pesv)', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/drivers');
    expect(r.status).toBe(401);
  });

  it('proveedor no tiene PESV → 403', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).get('/api/drivers').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });

  it('admin con PESV → 200', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/drivers').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });
});

describe('GET / — listado conductores', () => {
  it('sin q → devuelve todos los activos esConductor=true', async () => {
    selectMock.mockReturnValueOnce(chain([
      { id: 1, name: 'Juan', username: 'juan', email: 'j@x.com', userId: 1,
        cedulaCipher: Buffer.from('x'), cedulaKeyVersion: 1, cedulaAadNonce: 'n',
        categorias: ['B1'], licenciaVigencia: '2027-01-01', examenPsicoVigencia: '2026-01-01' },
    ]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/drivers').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0].cedula).toBe('PLAINTEXT'); // descifrado mock
  });

  it('q solo dígitos (6-12) → busca por HMAC cédula', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/drivers?q=900123456').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });

  it('q con texto (no dígitos) → busca name/username ilike', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/drivers?q=Juan').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });

  it('q se trunca a 100 chars', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get(`/api/drivers?q=${'A'.repeat(150)}`).set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });

  it('vencidos=true → filtra por licenciaVigencia/examenPsicoVigencia <= hoy', async () => {
    const ayer = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    const futuro = '2030-01-01';
    selectMock.mockReturnValueOnce(chain([
      { id: 1, name: 'Vencido', userId: 1, licenciaVigencia: ayer, examenPsicoVigencia: futuro },
      { id: 2, name: 'Vigente', userId: 2, licenciaVigencia: futuro, examenPsicoVigencia: futuro },
    ]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/drivers?vencidos=true').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0].id).toBe(1);
  });

  it('userId null (sin profile aún) → cedula y licenciaNumero null', async () => {
    selectMock.mockReturnValueOnce(chain([
      { id: 1, name: 'Sin profile', userId: null, categorias: null, licenciaVigencia: null },
    ]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/drivers').set('Authorization', `Bearer ${token}`);
    expect(r.body.data[0].cedula).toBeNull();
    expect(r.body.data[0].licenciaNumero).toBeNull();
  });
});

describe('GET /:id — detalle conductor', () => {
  it('id no numérico → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/drivers/abc').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('user no existe → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/drivers/999').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
  });

  it('user existe pero NO esConductor → 404', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, esConductor: false, name: 'X' }]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/drivers/1').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
  });

  it('encontrado con profile → DTO sin columnas cipher + counts', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 5, name: 'Juan', username: 'juan', email: 'j@x.com', esConductor: true }]));
    selectMock.mockReturnValueOnce(chain([{
      userId: 5,
      cedulaCipher: Buffer.from('x'), cedulaIv: Buffer.from('iv'), cedulaAuthTag: Buffer.from('t'),
      cedulaAadNonce: 'n', cedulaKeyVersion: 1,
      categorias: ['B1'], licenciaVigencia: '2027-01-01',
      arl: 'SURA', eps: 'COMPENSAR',
    }]));
    executeMock.mockResolvedValueOnce({ rows: [{ count: 3 }] }); // docs
    executeMock.mockResolvedValueOnce({ rows: [{ count: 1 }] }); // incidents
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/drivers/5').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.user.name).toBe('Juan');
    expect(r.body.profile.cedula).toBe('PLAINTEXT');
    // NO debe exponer columnas cipher/iv/authTag/aadNonce
    expect(JSON.stringify(r.body.profile)).not.toContain('cipher');
    expect(JSON.stringify(r.body.profile)).not.toContain('Iv');
    expect(JSON.stringify(r.body.profile)).not.toContain('AuthTag');
    expect(r.body.documentosCount).toBe(3);
    expect(r.body.incidentesCount).toBe(1);
  });

  it('encontrado sin profile → profile=null + counts en 0', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 5, name: 'X', esConductor: true }]));
    selectMock.mockReturnValueOnce(chain([])); // sin profile
    executeMock.mockResolvedValue({ rows: [{ count: 0 }] });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/drivers/5').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.profile).toBeNull();
  });
});

describe('POST / — crear conductor (cifrado + transaction)', () => {
  const VALID_BODY = {
    userId: 5,
    profile: {
      cedula: '900123456',
      licenciaNumero: 'LIC-001',
      categorias: ['B1'],
    },
  };

  it('proveedor → 403 (admin only)', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).post('/api/drivers').set('Authorization', `Bearer ${token}`).send(VALID_BODY);
    expect(r.status).toBe(403);
  });

  it('cédula con letras → 400 (regex zod)', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/drivers').set('Authorization', `Bearer ${token}`)
      .send({ ...VALID_BODY, profile: { ...VALID_BODY.profile, cedula: 'ABC' } });
    expect(r.status).toBe(400);
  });

  it('categorías duplicadas → 400 (refine no duplicar)', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/drivers').set('Authorization', `Bearer ${token}`)
      .send({ ...VALID_BODY, profile: { ...VALID_BODY.profile, categorias: ['B1', 'B1', 'C1'] } });
    expect(r.status).toBe(400);
  });

  it('categorías vacío → 400 (min 1)', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/drivers').set('Authorization', `Bearer ${token}`)
      .send({ ...VALID_BODY, profile: { ...VALID_BODY.profile, categorias: [] } });
    expect(r.status).toBe(400);
  });

  it('user no existe → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/drivers').set('Authorization', `Bearer ${token}`).send(VALID_BODY);
    expect(r.status).toBe(404);
  });

  it('éxito: transaction update users.esConductor=true + insert driverProfile cifrado + audit', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 5, username: 'juan' }]));
    let updateValues: any = null;
    let insertValues: any = null;
    transactionMock.mockImplementationOnce(async (cb) => {
      const tx = {
        update: vi.fn(() => ({
          set: (v: any) => { updateValues = v; return { where: () => Promise.resolve(undefined) }; },
        })),
        insert: vi.fn(() => ({
          values: (v: any) => { insertValues = v; return Promise.resolve(undefined); },
        })),
      };
      return cb(tx);
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/drivers').set('Authorization', `Bearer ${token}`).send(VALID_BODY);
    expect(r.status).toBe(201);
    expect(updateValues.esConductor).toBe(true);
    expect(insertValues.userId).toBe(5);
    expect(insertValues.cedulaCipher).toBeInstanceOf(Buffer);
    expect(insertValues.cedulaHash).toBeInstanceOf(Buffer);
    expect(insertValues.licenciaNumeroCipher).toBeInstanceOf(Buffer);
    expect(insertValues.categorias).toEqual(['B1']);
    expect(auditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'create', resource: 'driver' }),
    );
  });

  it('error 23505 (duplicate cedula/licencia) → 409', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 5, username: 'juan' }]));
    transactionMock.mockImplementationOnce(async () => {
      const err: any = new Error('duplicate');
      err.code = '23505';
      throw err;
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/drivers').set('Authorization', `Bearer ${token}`).send(VALID_BODY);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Cédula o licencia ya existen/);
  });
});

describe('PATCH /:id/profile — update parcial', () => {
  it('id no numérico → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/drivers/abc/profile').set('Authorization', `Bearer ${token}`)
      .send({ arl: 'NUEVA' });
    expect(r.status).toBe(400);
  });

  it('profile no existe → 404', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/drivers/999/profile').set('Authorization', `Bearer ${token}`)
      .send({ arl: 'NUEVA' });
    expect(r.status).toBe(404);
  });

  it('cédula en patch → re-cifra y re-calcula hash', async () => {
    let captured: any = null;
    updateMock.mockReturnValueOnce({
      set: (v: any) => {
        captured = v;
        return { where: () => ({ returning: () => Promise.resolve([{ userId: 5 }]) }) };
      },
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/drivers/5/profile').set('Authorization', `Bearer ${token}`)
      .send({ cedula: '900654321' });
    expect(r.status).toBe(200);
    expect(captured.cedulaCipher).toBeInstanceOf(Buffer);
    expect(captured.cedulaHash).toBeInstanceOf(Buffer);
    expect(captured.cedula).toBeUndefined(); // se eliminó del payload, solo van los _Cipher/_Iv/...
  });

  it('experienciaAnios → se convierte a string para drizzle decimal', async () => {
    let captured: any = null;
    updateMock.mockReturnValueOnce({
      set: (v: any) => { captured = v; return { where: () => ({ returning: () => Promise.resolve([{ userId: 5 }]) }) }; },
    });
    const token = await adminToken();
    const app = await buildApp();
    await request(app).patch('/api/drivers/5/profile').set('Authorization', `Bearer ${token}`)
      .send({ experienciaAnios: 7 });
    expect(captured.experienciaAnios).toBe('7');
  });

  it('cedula con caracteres no-numéricos → zod 400 (no llega a normalize)', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/drivers/5/profile').set('Authorization', `Bearer ${token}`)
      .send({ cedula: '900-123' });
    expect(r.status).toBe(400);
  });
});

describe('DELETE /:id — soft delete (esConductor=false)', () => {
  it('id no numérico → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).delete('/api/drivers/abc').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('user no existe → 404', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).delete('/api/drivers/999').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
  });

  it('éxito → 200 + audit con detail=soft_delete', async () => {
    let setValues: any = null;
    updateMock.mockReturnValueOnce({
      set: (v: any) => { setValues = v; return { where: () => ({ returning: () => Promise.resolve([{ id: 5 }]) }) }; },
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).delete('/api/drivers/5').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(setValues.esConductor).toBe(false);
    expect(auditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'delete', resource: 'driver', detail: 'soft_delete' }),
    );
  });
});

describe('GET /candidates/non-driver', () => {
  it('proveedor → 403', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).get('/api/drivers/candidates/non-driver').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });

  it('admin → lista users con esConductor=false y active=true', async () => {
    selectMock.mockReturnValueOnce(chain([
      { id: 1, name: 'Alice', username: 'alice' },
      { id: 2, name: 'Bob', username: 'bob' },
    ]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/drivers/candidates/non-driver').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(2);
  });
});
