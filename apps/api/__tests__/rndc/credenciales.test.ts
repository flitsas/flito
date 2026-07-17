import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { adminAuth, proveedorAuth } from '../helpers/auth.js';

// Mock del cliente BD: este módulo no se usa directamente en credenciales.routes (que pasa por el service),
// pero la app entera lo importa al boot.
vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]), transaction: vi.fn() },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

vi.mock('../../src/shared/middleware/rateLimiter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/middleware/rateLimiter.js')>();
  const passthrough = (_req: unknown, _res: unknown, next: () => void) => next();
  return { ...actual, apiLimiter: passthrough, authLimiter: passthrough, qrPublicLimiter: passthrough };
});

vi.mock('../../src/shared/redis.ts', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

// Mock del audit middleware — los tests no deben escribir a BD.
vi.mock('../../src/shared/middleware/audit.js', () => ({
  audit: vi.fn().mockResolvedValue(undefined),
}));

// Mock del service de credenciales — el router solo orquesta llamadas + zod + audit.
const setCredencialesMock = vi.fn();
const listCredencialesPublicMock = vi.fn();
const deactivateCredencialMock = vi.fn();
vi.mock('../../src/modules/rndc/credenciales.service.js', () => ({
  setCredenciales: setCredencialesMock,
  listCredencialesPublic: listCredencialesPublicMock,
  deactivateCredencial: deactivateCredencialMock,
}));

const VALID_BODY = {
  empresaNit: '900123456',
  habilitadorNit: '900654321',
  numNit: '900123456-1',
  claveQR: 'super-secret-clave-qr',
  ambiente: 'sandbox' as const,
  notas: 'test',
};

describe('RNDC credenciales — autenticación y permisos', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;

  beforeEach(async () => {
    setCredencialesMock.mockReset();
    listCredencialesPublicMock.mockReset();
    deactivateCredencialMock.mockReset();
    const { createApp } = await import('../../src/app.js');
    app = createApp();
  });

  it('GET sin token responde 401', async () => {
    const r = await request(app).get('/api/rndc/credenciales');
    expect(r.status).toBe(401);
  });

  it('GET con token role=proveedor responde 403 (requiere admin)', async () => {
    const r = await request(app)
      .get('/api/rndc/credenciales')
      .set('Authorization', await proveedorAuth());
    expect(r.status).toBe(403);
  });

  it('GET con token role=admin responde 200 con lista', async () => {
    listCredencialesPublicMock.mockResolvedValue([
      { id: 1, empresaNit: '900123456', ambiente: 'sandbox', activo: true, keyVersion: 1 },
    ]);
    const r = await request(app)
      .get('/api/rndc/credenciales')
      .set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0]).not.toHaveProperty('claveQR'); // PII protection: no exponer secreto
    expect(r.body.data[0]).not.toHaveProperty('claveQrCipher');
  });

  it('POST sin token responde 401', async () => {
    const r = await request(app).post('/api/rndc/credenciales').send(VALID_BODY);
    expect(r.status).toBe(401);
  });

  it('POST con role no-admin responde 403', async () => {
    const r = await request(app)
      .post('/api/rndc/credenciales')
      .set('Authorization', await proveedorAuth())
      .send(VALID_BODY);
    expect(r.status).toBe(403);
  });

  it('DELETE sin token responde 401', async () => {
    const r = await request(app).delete('/api/rndc/credenciales/123');
    expect(r.status).toBe(401);
  });
});

describe('RNDC credenciales — validación zod', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;

  beforeEach(async () => {
    setCredencialesMock.mockReset();
    const { createApp } = await import('../../src/app.js');
    app = createApp();
  });

  it('POST rechaza empresaNit no numérico', async () => {
    const r = await request(app)
      .post('/api/rndc/credenciales')
      .set('Authorization', await adminAuth())
      .send({ ...VALID_BODY, empresaNit: 'NOT-A-NUMBER' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Datos inválidos');
    expect(setCredencialesMock).not.toHaveBeenCalled();
  });

  it('POST rechaza ambiente fuera del enum', async () => {
    const r = await request(app)
      .post('/api/rndc/credenciales')
      .set('Authorization', await adminAuth())
      .send({ ...VALID_BODY, ambiente: 'staging' });
    expect(r.status).toBe(400);
  });

  it('POST rechaza claveQR muy corta', async () => {
    const r = await request(app)
      .post('/api/rndc/credenciales')
      .set('Authorization', await adminAuth())
      .send({ ...VALID_BODY, claveQR: 'abc' });
    expect(r.status).toBe(400);
  });

  it('POST rechaza body vacío', async () => {
    const r = await request(app)
      .post('/api/rndc/credenciales')
      .set('Authorization', await adminAuth())
      .send({});
    expect(r.status).toBe(400);
  });

  it('POST acepta body válido y delega al service con userId del JWT', async () => {
    setCredencialesMock.mockResolvedValue({
      id: 42, empresaNit: VALID_BODY.empresaNit,
      ambiente: VALID_BODY.ambiente, activo: true, keyVersion: 1,
    });
    const r = await request(app)
      .post('/api/rndc/credenciales')
      .set('Authorization', await adminAuth())
      .send(VALID_BODY);
    expect(r.status).toBe(201);
    expect(r.body.id).toBe(42);
    expect(setCredencialesMock).toHaveBeenCalledTimes(1);
    expect(setCredencialesMock.mock.calls[0]![0]).toMatchObject({
      empresaNit: VALID_BODY.empresaNit,
      ambiente: VALID_BODY.ambiente,
      claveQR: VALID_BODY.claveQR,
      userId: 1,
    });
  });
});

describe('RNDC credenciales — DELETE soft delete', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;

  beforeEach(async () => {
    deactivateCredencialMock.mockReset();
    const { createApp } = await import('../../src/app.js');
    app = createApp();
  });

  it('DELETE rechaza id no numérico (400)', async () => {
    const r = await request(app)
      .delete('/api/rndc/credenciales/abc')
      .set('Authorization', await adminAuth());
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('ID inválido');
    expect(deactivateCredencialMock).not.toHaveBeenCalled();
  });

  it('DELETE responde 404 cuando service retorna false (no encontrada)', async () => {
    deactivateCredencialMock.mockResolvedValue(false);
    const r = await request(app)
      .delete('/api/rndc/credenciales/999')
      .set('Authorization', await adminAuth());
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('No encontrada');
  });

  it('DELETE responde 200 cuando service desactiva exitosamente', async () => {
    deactivateCredencialMock.mockResolvedValue(true);
    const r = await request(app)
      .delete('/api/rndc/credenciales/42')
      .set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(deactivateCredencialMock).toHaveBeenCalledWith(42, 1);
  });
});
