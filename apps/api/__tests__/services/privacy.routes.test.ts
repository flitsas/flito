import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();
const transactionMock = vi.fn();
const executeMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock,
    transaction: transactionMock,
    execute: executeMock,
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({
  audit: auditMock,
}));

const deletePhotoMock = vi.fn();
vi.mock('../../src/services/storage.js', () => ({
  deletePhoto: deletePhotoMock,
}));

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
  transactionMock.mockReset();
  executeMock.mockReset().mockResolvedValue([{ '?column?': 1 }]);
  deletePhotoMock.mockReset().mockResolvedValue(undefined);
  auditMock.mockClear();
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/privacy/privacy.routes.js');
  app.use('/api/privacy', router);
  return app;
}

// Helper: mock tx que satisface todos los updates de la transaction (14 + 1 select + 1 execute)
function buildTxMock(opts: {
  driverHits?: number; // filas devueltas por driver_profile update (afecta también alcohol/incidents)
  perTableHits?: Record<string, number>;
} = {}) {
  const driverHits = opts.driverHits ?? 0;
  const hits = (table: string) => opts.perTableHits?.[table] ?? 1;

  return async (cb: any) => {
    const tx = {
      select: vi.fn(() => chain([{ id: 1 }])), // affectedVehicles para soat_requests
      execute: vi.fn().mockResolvedValue([{ id: 1 }]), // tramites_digitales jsonb update
      update: vi.fn(() => ({
        set: () => ({
          where: () => ({
            returning: () => Promise.resolve(
              // Devuelve N filas según tabla (heurística: usa el mismo número para todas)
              Array.from({ length: hits('default') }, (_, i) => ({ id: i + 1, userId: i + 1 })),
            ),
          }),
        }),
      })),
    };
    return cb(tx);
  };
}

describe('privacy — auth & roles', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).post('/api/privacy/forget').send({ docNumber: '123', reason: 'derecho al olvido' });
    expect(r.status).toBe(401);
  });

  it('proveedor → 403 (requireRole admin|compliance)', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).get('/api/privacy/preview/123').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });

  it('compliance puede preview (200) pero NO forget (403 — segregation of duties)', async () => {
    // Preview con compliance: requiere mocks de todos los counts
    selectMock.mockImplementation(() => chain([{ c: 0 }]));
    const token = await testToken({ sub: 1, role: 'compliance' });
    const app = await buildApp();

    const rPreview = await request(app).get('/api/privacy/preview/123456').set('Authorization', `Bearer ${token}`);
    expect(rPreview.status).toBe(200);

    const rForget = await request(app).post('/api/privacy/forget').set('Authorization', `Bearer ${token}`)
      .send({ docNumber: '123456', reason: 'derecho al olvido formal' });
    expect(rForget.status).toBe(403);
  });
});

describe('POST /forget — validación zod', () => {
  it('docNumber < 3 chars → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/privacy/forget').set('Authorization', `Bearer ${token}`)
      .send({ docNumber: 'AB', reason: 'derecho al olvido' });
    expect(r.status).toBe(400);
  });

  it('reason < 10 chars → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/privacy/forget').set('Authorization', `Bearer ${token}`)
      .send({ docNumber: '123456', reason: 'corto' });
    expect(r.status).toBe(400);
  });

  it('docNumber > 20 chars → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/privacy/forget').set('Authorization', `Bearer ${token}`)
      .send({ docNumber: '1'.repeat(25), reason: 'derecho al olvido formal' });
    expect(r.status).toBe(400);
  });
});

describe('POST /forget — flujo principal', () => {
  it('sin driverProfile match → driver/alcohol/incidents = 0; el resto se anonimiza', async () => {
    selectMock.mockReturnValueOnce(chain([])); // driver_profile match: ninguno
    selectMock.mockReturnValueOnce(chain([])); // tramitesPhotos
    transactionMock.mockImplementationOnce(buildTxMock());

    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/privacy/forget').set('Authorization', `Bearer ${token}`)
      .send({ docNumber: '900123456', reason: 'titular ejerce derecho al olvido' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.docHash).toMatch(/^ANON-[a-f0-9]{16}$/);
    expect(r.body.summary).toBeDefined();
    // driver_profile/alcohol_tests/road_incidents = 0 cuando no hay driver match
    expect(r.body.summary.driver_profile).toBe(0);
    expect(r.body.summary.alcohol_tests).toBe(0);
    expect(r.body.summary.road_incidents).toBe(0);
    expect(r.body.note).toMatch(/anonimizados.*no eliminados/i);
  });

  it('driverProfile match → captura keys S3 y borra fotos via deletePhoto', async () => {
    // driverRows con foto S3
    selectMock.mockReturnValueOnce(chain([
      { userId: 7, fotoStorageKey: 'drivers/7/foto.jpg' },
    ]));
    // tramitesPhotos
    selectMock.mockReturnValueOnce(chain([
      { rostro: 'validaciones/1/rostro.jpg', frontal: null, reverso: 'validaciones/1/reverso.jpg' },
    ]));
    // alcohol keys
    selectMock.mockReturnValueOnce(chain([{ keys: ['alcohol/7/k1.jpg', 'alcohol/7/k2.jpg'] }]));
    // road incident keys
    selectMock.mockReturnValueOnce(chain([{ keys: ['incidents/7/inc.jpg'] }]));

    transactionMock.mockImplementationOnce(buildTxMock());

    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/privacy/forget').set('Authorization', `Bearer ${token}`)
      .send({ docNumber: '1036640908', reason: 'derecho al olvido formal' });
    expect(r.status).toBe(200);
    // 1 foto driver + 2 tramites válidas (rostro + reverso, frontal=null) + 2 alcohol + 1 incident = 6
    expect(r.body.s3Total).toBe(6);
    expect(r.body.s3Deleted).toBe(6);
    expect(r.body.s3Failed).toBe(0);
    expect(deletePhotoMock).toHaveBeenCalledTimes(6);
    expect(deletePhotoMock).toHaveBeenCalledWith('drivers/7/foto.jpg');
    expect(deletePhotoMock).toHaveBeenCalledWith('validaciones/1/rostro.jpg');
    expect(deletePhotoMock).toHaveBeenCalledWith('alcohol/7/k1.jpg');
  });

  it('keys legacy (con ":") NO se intentan borrar de S3', async () => {
    selectMock.mockReturnValueOnce(chain([{ userId: 7, fotoStorageKey: 'iv:tag:b64payload' }]));
    selectMock.mockReturnValueOnce(chain([
      { rostro: 'iv:tag:base64data', frontal: null, reverso: null },
    ]));
    selectMock.mockReturnValueOnce(chain([{ keys: [] }]));
    selectMock.mockReturnValueOnce(chain([{ keys: [] }]));

    transactionMock.mockImplementationOnce(buildTxMock());

    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/privacy/forget').set('Authorization', `Bearer ${token}`)
      .send({ docNumber: '900123', reason: 'derecho al olvido formal' });
    expect(r.status).toBe(200);
    expect(deletePhotoMock).not.toHaveBeenCalled();
    expect(r.body.s3Total).toBe(2); // capturadas pero no borradas
    expect(r.body.s3Deleted).toBe(0);
  });

  it('deletePhoto throws → continúa, s3Failed cuenta', async () => {
    selectMock.mockReturnValueOnce(chain([{ userId: 1, fotoStorageKey: 'drivers/1/a.jpg' }]));
    selectMock.mockReturnValueOnce(chain([
      { rostro: 'validaciones/1/r.jpg', frontal: null, reverso: null },
    ]));
    selectMock.mockReturnValueOnce(chain([{ keys: [] }]));
    selectMock.mockReturnValueOnce(chain([{ keys: [] }]));

    deletePhotoMock.mockRejectedValueOnce(new Error('S3 down'));
    deletePhotoMock.mockResolvedValueOnce(undefined);

    transactionMock.mockImplementationOnce(buildTxMock());

    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/privacy/forget').set('Authorization', `Bearer ${token}`)
      .send({ docNumber: '900', reason: 'derecho al olvido formal' });
    expect(r.status).toBe(200);
    expect(r.body.s3Failed).toBe(1);
    expect(r.body.s3Deleted).toBe(1);
  });

  it('audit con resource=pii_erasure + docHash + detail enmascarado', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    selectMock.mockReturnValueOnce(chain([]));
    transactionMock.mockImplementationOnce(buildTxMock());

    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    await request(app).post('/api/privacy/forget').set('Authorization', `Bearer ${token}`)
      .send({ docNumber: '1234567890', reason: 'derecho al olvido del titular' });

    expect(auditMock).toHaveBeenCalledTimes(1);
    const auditEntry = auditMock.mock.calls[0][1];
    expect(auditEntry.action).toBe('delete');
    expect(auditEntry.resource).toBe('pii_erasure');
    expect(auditEntry.resourceId).toMatch(/^ANON-[a-f0-9]{16}$/);
    // doc enmascarado: "12***90" → docNumber.slice(0,2) + "***" + slice(-2)
    expect(auditEntry.detail).toContain('12***90');
    expect(auditEntry.detail).not.toContain('1234567890');
    expect(auditEntry.detail).toMatch(/Ley 1581/);
    expect(auditEntry.detail).toMatch(/afectados:/);
    expect(auditEntry.detail).toMatch(/s3_deleted:/);
  });

  it('docHash es determinístico (mismo doc → mismo hash)', async () => {
    selectMock.mockImplementation(() => chain([]));
    transactionMock.mockImplementation(buildTxMock());

    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r1 = await request(app).post('/api/privacy/forget').set('Authorization', `Bearer ${token}`)
      .send({ docNumber: '1036640908', reason: 'derecho al olvido formal' });
    const r2 = await request(app).post('/api/privacy/forget').set('Authorization', `Bearer ${token}`)
      .send({ docNumber: '1036640908', reason: 'derecho al olvido formal' });
    expect(r1.body.docHash).toBe(r2.body.docHash);
  });

  it('docHash es case-insensitive (1036A vs 1036a → mismo hash)', async () => {
    selectMock.mockImplementation(() => chain([]));
    transactionMock.mockImplementation(buildTxMock());

    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r1 = await request(app).post('/api/privacy/forget').set('Authorization', `Bearer ${token}`)
      .send({ docNumber: '1036A', reason: 'derecho al olvido formal' });
    const r2 = await request(app).post('/api/privacy/forget').set('Authorization', `Bearer ${token}`)
      .send({ docNumber: '1036a', reason: 'derecho al olvido formal' });
    expect(r1.body.docHash).toBe(r2.body.docHash);
  });
});

describe('GET /preview/:docNumber', () => {
  it('docNumber < 3 chars → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/privacy/preview/AB').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('docNumber > 20 chars → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get(`/api/privacy/preview/${'1'.repeat(25)}`).set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('sin matches en ninguna tabla → counts en 0', async () => {
    // 12 SELECT (drizzle) + 2 raw db.execute (soat + tramites_digitales)
    selectMock.mockImplementation(() => chain([{ c: 0 }]));
    executeMock.mockResolvedValue([{ c: 0 }]);

    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/privacy/preview/900123').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.docNumber).toBe('900123');
    expect(r.body.affected.clients).toBe(0);
    expect(r.body.affected.driver_profile).toBe(0);
    expect(r.body.affected.alcohol_tests).toBe(0); // sin driver match → no llama
    expect(r.body.affected.road_incidents).toBe(0);
  });

  it('con driver match → cuenta alcohol_tests + road_incidents adicionales', async () => {
    // El handler hace 10 db.select() en paralelo (clients/vehicles/cp/bo/drv/trv/man/ten/prop/dest)
    // + 2 db.execute() (soat/tramites_digitales). Solo 10 selects entran a selectMock.
    // Orden: clients(1), vehicles(2), cp(3), bo(4), drv(5), trv(6), man(7), ten(8), prop(9), dest(10).
    // Si drv>0 → 11° SELECT userId, 12° count alcohol, 13° count incidents.
    let selectCallCount = 0;
    selectMock.mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 5) return chain([{ c: 1 }]); // drv > 0
      if (selectCallCount === 11) return chain([{ userId: 7 }]); // SELECT userId
      if (selectCallCount === 12) return chain([{ c: 5 }]); // alcohol count
      if (selectCallCount === 13) return chain([{ c: 2 }]); // incidents count
      return chain([{ c: 0 }]);
    });
    executeMock.mockResolvedValue([{ c: 0 }]);

    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/privacy/preview/1036640908').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.affected.driver_profile).toBe(1);
    expect(r.body.affected.alcohol_tests).toBe(5);
    expect(r.body.affected.road_incidents).toBe(2);
  });

  it('responde con todos los 14 campos esperados en affected', async () => {
    selectMock.mockImplementation(() => chain([{ c: 3 }]));
    executeMock.mockResolvedValue([{ c: 7 }]);

    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/privacy/preview/900123').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    const expectedKeys = [
      'clients', 'vehicles', 'soat_requests', 'tramites_digitales',
      'laft_counterparties', 'laft_beneficial_owners', 'driver_profile',
      'tramites_validaciones', 'alcohol_tests', 'road_incidents',
      'manifiestos', 'tenedores', 'propietarios_carga', 'destinatarios_carga',
    ];
    for (const k of expectedKeys) {
      expect(r.body.affected).toHaveProperty(k);
    }
  });

  it('NO modifica BD (read-only)', async () => {
    selectMock.mockImplementation(() => chain([{ c: 0 }]));
    executeMock.mockResolvedValue([{ c: 0 }]);

    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    await request(app).get('/api/privacy/preview/900123').set('Authorization', `Bearer ${token}`);
    expect(transactionMock).not.toHaveBeenCalled();
    expect(deletePhotoMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });
});
