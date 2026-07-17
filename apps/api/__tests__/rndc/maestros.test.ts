import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { adminAuth } from '../helpers/auth.js';
import { chain, chainReject } from '../helpers/db.js';

// Mock del cliente BD: maestros usa db.select/insert/update directamente (sin service).
const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock,
    insert: insertMock,
    update: updateMock,
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
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

vi.mock('../../src/shared/middleware/audit.js', () => ({
  audit: vi.fn().mockResolvedValue(undefined),
}));

const TENEDOR_BODY = {
  tipo: 'tenedor' as const,
  tipoDoc: 'CC' as const,
  documento: '1036640908',
  nombre: 'Juan Test',
};

const TENEDOR_ROW = {
  id: 7, tipo: 'tenedor', tipoDoc: 'CC', documento: '1036640908',
  nombre: 'Juan Test', activo: true, createdAt: new Date(),
};

describe('RNDC maestros — tenedores', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;

  beforeEach(async () => {
    selectMock.mockReset();
    insertMock.mockReset();
    updateMock.mockReset();
    const { createApp } = await import('../../src/app.js');
    app = createApp();
  });

  it('GET sin token → 401', async () => {
    const r = await request(app).get('/api/rndc/tenedores');
    expect(r.status).toBe(401);
  });

  it('GET con admin → 200 con lista', async () => {
    selectMock.mockReturnValueOnce(chain([TENEDOR_ROW]));
    const r = await request(app).get('/api/rndc/tenedores').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
  });

  it('GET con filtro q corto (<2 chars) → no aplica filtro pero devuelve 200', async () => {
    selectMock.mockReturnValueOnce(chain([TENEDOR_ROW]));
    const r = await request(app).get('/api/rndc/tenedores?q=a').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
  });

  it('GET /:id con id no numérico → 400', async () => {
    const r = await request(app).get('/api/rndc/tenedores/abc').set('Authorization', await adminAuth());
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('ID inválido');
  });

  it('GET /:id no encontrado → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const r = await request(app).get('/api/rndc/tenedores/999').set('Authorization', await adminAuth());
    expect(r.status).toBe(404);
  });

  it('GET /:id éxito → 200', async () => {
    selectMock.mockReturnValueOnce(chain([TENEDOR_ROW]));
    const r = await request(app).get('/api/rndc/tenedores/7').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.data.id).toBe(7);
  });

  it('POST sin token → 401', async () => {
    const r = await request(app).post('/api/rndc/tenedores').send(TENEDOR_BODY);
    expect(r.status).toBe(401);
  });

  it('POST body inválido (documento vacío) → 400 y NO toca BD', async () => {
    const r = await request(app)
      .post('/api/rndc/tenedores')
      .set('Authorization', await adminAuth())
      .send({ ...TENEDOR_BODY, documento: '' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Validación');
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('POST éxito → 201 con la fila creada', async () => {
    insertMock.mockReturnValueOnce(chain([TENEDOR_ROW]));
    const r = await request(app)
      .post('/api/rndc/tenedores')
      .set('Authorization', await adminAuth())
      .send(TENEDOR_BODY);
    expect(r.status).toBe(201);
    expect(r.body.data.id).toBe(7);
    expect(insertMock).toHaveBeenCalledTimes(1);
  });

  it('POST conflict 23505 (documento duplicado) → 409', async () => {
    const err = Object.assign(new Error('duplicate key'), { code: '23505' });
    insertMock.mockReturnValueOnce(chainReject(err));
    const r = await request(app)
      .post('/api/rndc/tenedores')
      .set('Authorization', await adminAuth())
      .send(TENEDOR_BODY);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Ya existe/i);
  });

  // ⭐ REGRESSION TEST DEL BUG api.put — Si alguien borra `router.put` del backend (o
  // alguien borra `api.put` del frontend api.ts), este test falla. El test debe
  // permanecer hasta que api.ts deprecate PUT explícitamente.
  it('PUT /:id existe y responde con la fila actualizada (regression: bug api.put)', async () => {
    updateMock.mockReturnValueOnce(chain([{ ...TENEDOR_ROW, nombre: 'Juan Actualizado' }]));
    const r = await request(app)
      .put('/api/rndc/tenedores/7')
      .set('Authorization', await adminAuth())
      .send({ nombre: 'Juan Actualizado' });
    expect(r.status).toBe(200);
    expect(r.body.data.nombre).toBe('Juan Actualizado');
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it('PUT /:id con id no numérico → 400', async () => {
    const r = await request(app)
      .put('/api/rndc/tenedores/xxx')
      .set('Authorization', await adminAuth())
      .send({ nombre: 'Xy' });
    expect(r.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('PUT /:id no encontrado → 404', async () => {
    updateMock.mockReturnValueOnce(chain([]));
    const r = await request(app)
      .put('/api/rndc/tenedores/999')
      .set('Authorization', await adminAuth())
      .send({ nombre: 'Xy' });
    expect(r.status).toBe(404);
  });

  it('DELETE /:id soft delete (activo=false) → 200', async () => {
    updateMock.mockReturnValueOnce(chain([{ ...TENEDOR_ROW, activo: false }]));
    const r = await request(app)
      .delete('/api/rndc/tenedores/7')
      .set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.data.activo).toBe(false);
  });

  it('DELETE /:id no encontrado → 404', async () => {
    updateMock.mockReturnValueOnce(chain([]));
    const r = await request(app)
      .delete('/api/rndc/tenedores/999')
      .set('Authorization', await adminAuth());
    expect(r.status).toBe(404);
  });
});

describe('RNDC maestros — propietarios-carga (regression simétrico)', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;

  beforeEach(async () => {
    selectMock.mockReset();
    insertMock.mockReset();
    updateMock.mockReset();
    const { createApp } = await import('../../src/app.js');
    app = createApp();
  });

  // Estos tests son menores en cantidad pero confirman que las rutas hermanas existen.
  // Si alguien borra accidentalmente uno de estos endpoints, este test cae.

  it('PUT /:id existe (regression api.put en propietarios)', async () => {
    updateMock.mockReturnValueOnce(chain([{ id: 5, nombre: 'X' }]));
    const r = await request(app)
      .put('/api/rndc/propietarios-carga/5')
      .set('Authorization', await adminAuth())
      .send({ nombre: 'Xy' });
    expect(r.status).toBe(200);
  });

  it('POST exitoso', async () => {
    insertMock.mockReturnValueOnce(chain([{ id: 5 }]));
    const r = await request(app)
      .post('/api/rndc/propietarios-carga')
      .set('Authorization', await adminAuth())
      .send({ tipoDoc: 'NIT', documento: '900123456', nombre: 'Empresa Ltda' });
    expect(r.status).toBe(201);
  });
});

describe('RNDC maestros — destinatarios-carga (regression simétrico)', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;

  beforeEach(async () => {
    selectMock.mockReset();
    insertMock.mockReset();
    updateMock.mockReset();
    const { createApp } = await import('../../src/app.js');
    app = createApp();
  });

  it('PUT /:id existe (regression api.put en destinatarios)', async () => {
    updateMock.mockReturnValueOnce(chain([{ id: 9, nombre: 'X' }]));
    const r = await request(app)
      .put('/api/rndc/destinatarios-carga/9')
      .set('Authorization', await adminAuth())
      .send({ nombre: 'Xy' });
    expect(r.status).toBe(200);
  });

  it('DELETE /:id soft delete', async () => {
    updateMock.mockReturnValueOnce(chain([{ id: 9, activo: false }]));
    const r = await request(app)
      .delete('/api/rndc/destinatarios-carga/9')
      .set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.data.activo).toBe(false);
  });
});
