import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { adminAuth } from '../helpers/auth.js';
import { chain } from '../helpers/db.js';

// Remesas usa db.select/insert/update directamente + db.transaction para POST.
const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock,
    insert: insertMock,
    update: updateMock,
    transaction: transactionMock,
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

const REMESA_BODY = {
  municipioOrigenDane: '05001',
  municipioDestinoDane: '11001',
  cantidadCargada: 1000,
  fechaCargue: '2026-05-06',
  valorFlete: 500000,
  valorAnticipo: 100000,
};

const REMESA_ROW = {
  id: 1,
  numero: 'R-2026-0001',
  estado: 'borrador',
  municipioOrigenDane: '05001',
  municipioDestinoDane: '11001',
  cantidadCargada: '1000',
  valorFlete: '500000',
  valorAnticipo: '100000',
  fechaCargue: '2026-05-06',
  deletedAt: null,
};

describe('RNDC remesas — listado y detalle', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;

  beforeEach(async () => {
    selectMock.mockReset();
    insertMock.mockReset();
    updateMock.mockReset();
    transactionMock.mockReset();
    const { createApp } = await import('../../src/app.js');
    app = createApp();
  });

  it('GET / sin token → 401', async () => {
    const r = await request(app).get('/api/rndc/remesas');
    expect(r.status).toBe(401);
  });

  it('GET / con admin → 200 con lista', async () => {
    selectMock.mockReturnValueOnce(chain([REMESA_ROW]));
    const r = await request(app).get('/api/rndc/remesas').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
  });

  it('GET / con filtros estado/desde/hasta/sinManifiesto → 200', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const r = await request(app)
      .get('/api/rndc/remesas?estado=activa&desde=2026-01-01&hasta=2026-12-31&sinManifiesto=1&clienteId=5')
      .set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
  });

  it('GET /:id no numérico → 400', async () => {
    const r = await request(app).get('/api/rndc/remesas/abc').set('Authorization', await adminAuth());
    expect(r.status).toBe(400);
  });

  it('GET /:id no encontrado → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const r = await request(app).get('/api/rndc/remesas/999').set('Authorization', await adminAuth());
    expect(r.status).toBe(404);
  });

  it('GET /:id soft-deleted → 404', async () => {
    selectMock.mockReturnValueOnce(chain([{ ...REMESA_ROW, deletedAt: new Date() }]));
    const r = await request(app).get('/api/rndc/remesas/1').set('Authorization', await adminAuth());
    expect(r.status).toBe(404);
  });

  it('GET /:id éxito → 200', async () => {
    selectMock.mockReturnValueOnce(chain([REMESA_ROW]));
    const r = await request(app).get('/api/rndc/remesas/1').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.data.numero).toBe('R-2026-0001');
  });
});

describe('RNDC remesas — POST crear (con transaction + advisory lock)', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;

  beforeEach(async () => {
    selectMock.mockReset();
    insertMock.mockReset();
    updateMock.mockReset();
    transactionMock.mockReset();
    const { createApp } = await import('../../src/app.js');
    app = createApp();
  });

  it('POST sin token → 401', async () => {
    const r = await request(app).post('/api/rndc/remesas').send(REMESA_BODY);
    expect(r.status).toBe(401);
  });

  it('POST body inválido (DANE corto) → 400 y NO toca BD', async () => {
    const r = await request(app)
      .post('/api/rndc/remesas')
      .set('Authorization', await adminAuth())
      .send({ ...REMESA_BODY, municipioOrigenDane: '123' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Validación');
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('POST anticipo > flete → 400 (refine de zod)', async () => {
    const r = await request(app)
      .post('/api/rndc/remesas')
      .set('Authorization', await adminAuth())
      .send({ ...REMESA_BODY, valorAnticipo: 600000, valorFlete: 500000 });
    expect(r.status).toBe(400);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('POST éxito → 201 con número correlativo', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        execute: vi.fn().mockResolvedValueOnce([{ numero: 'R-2026-0001' }]),
        insert: vi.fn().mockReturnValueOnce(chain([REMESA_ROW])),
      };
      return cb(tx);
    });

    const r = await request(app)
      .post('/api/rndc/remesas')
      .set('Authorization', await adminAuth())
      .send(REMESA_BODY);
    expect(r.status).toBe(201);
    expect(r.body.data.numero).toBe('R-2026-0001');
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });

  it('POST falla si fn_next_remesa_numero no devuelve número → 500', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        execute: vi.fn().mockResolvedValueOnce([{ numero: null }]),
        insert: vi.fn(),
      };
      return cb(tx);
    });

    const r = await request(app)
      .post('/api/rndc/remesas')
      .set('Authorization', await adminAuth())
      .send(REMESA_BODY);
    expect(r.status).toBe(500);
  });
});

describe('RNDC remesas — PUT editar', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;

  beforeEach(async () => {
    selectMock.mockReset();
    updateMock.mockReset();
    const { createApp } = await import('../../src/app.js');
    app = createApp();
  });

  it('PUT /:id no encontrada → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const r = await request(app)
      .put('/api/rndc/remesas/999')
      .set('Authorization', await adminAuth())
      .send({ valorFlete: 100 });
    expect(r.status).toBe(404);
  });

  it('PUT /:id en estado cumplida → 409 (no editable)', async () => {
    selectMock.mockReturnValueOnce(chain([{ ...REMESA_ROW, estado: 'cumplida' }]));
    const r = await request(app)
      .put('/api/rndc/remesas/1')
      .set('Authorization', await adminAuth())
      .send({ valorFlete: 100 });
    expect(r.status).toBe(409);
  });

  it('PUT /:id en borrador → 200 con fila actualizada', async () => {
    selectMock.mockReturnValueOnce(chain([REMESA_ROW]));
    updateMock.mockReturnValueOnce(chain([{ ...REMESA_ROW, valorFlete: '600000' }]));
    const r = await request(app)
      .put('/api/rndc/remesas/1')
      .set('Authorization', await adminAuth())
      .send({ valorFlete: 600000 });
    expect(r.status).toBe(200);
    expect(r.body.data.valorFlete).toBe('600000');
  });

  it('PUT /:id en activa → 200', async () => {
    selectMock.mockReturnValueOnce(chain([{ ...REMESA_ROW, estado: 'activa' }]));
    updateMock.mockReturnValueOnce(chain([{ ...REMESA_ROW, estado: 'activa' }]));
    const r = await request(app)
      .put('/api/rndc/remesas/1')
      .set('Authorization', await adminAuth())
      .send({ observaciones: 'edit' });
    expect(r.status).toBe(200);
  });
});

describe('RNDC remesas — transiciones de estado', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;

  beforeEach(async () => {
    selectMock.mockReset();
    updateMock.mockReset();
    const { createApp } = await import('../../src/app.js');
    app = createApp();
  });

  it('POST /:id/activar éxito → 200', async () => {
    updateMock.mockReturnValueOnce(chain([{ ...REMESA_ROW, estado: 'activa' }]));
    const r = await request(app)
      .post('/api/rndc/remesas/1/activar')
      .set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.data.estado).toBe('activa');
  });

  it('POST /:id/activar cuando no estaba en borrador → 409', async () => {
    updateMock.mockReturnValueOnce(chain([]));
    const r = await request(app)
      .post('/api/rndc/remesas/1/activar')
      .set('Authorization', await adminAuth());
    expect(r.status).toBe(409);
  });

  it('POST /:id/cumplir cantidad > cargada → 400', async () => {
    selectMock.mockReturnValueOnce(chain([{ ...REMESA_ROW, estado: 'activa', cantidadCargada: '1000' }]));
    const r = await request(app)
      .post('/api/rndc/remesas/1/cumplir')
      .set('Authorization', await adminAuth())
      .send({ cantidadEntregada: 1500 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/superar/i);
  });

  it('POST /:id/cumplir en estado borrador → 409', async () => {
    selectMock.mockReturnValueOnce(chain([{ ...REMESA_ROW, estado: 'borrador' }]));
    const r = await request(app)
      .post('/api/rndc/remesas/1/cumplir')
      .set('Authorization', await adminAuth())
      .send({ cantidadEntregada: 500 });
    expect(r.status).toBe(409);
  });

  it('POST /:id/cumplir éxito → 200', async () => {
    selectMock.mockReturnValueOnce(chain([{ ...REMESA_ROW, estado: 'activa', cantidadCargada: '1000' }]));
    updateMock.mockReturnValueOnce(chain([{ ...REMESA_ROW, estado: 'cumplida' }]));
    const r = await request(app)
      .post('/api/rndc/remesas/1/cumplir')
      .set('Authorization', await adminAuth())
      .send({ cantidadEntregada: 950, observaciones: 'ok' });
    expect(r.status).toBe(200);
    expect(r.body.data.estado).toBe('cumplida');
  });

  it('POST /:id/anular sin motivo → 400', async () => {
    const r = await request(app)
      .post('/api/rndc/remesas/1/anular')
      .set('Authorization', await adminAuth())
      .send({});
    expect(r.status).toBe(400);
  });

  it('POST /:id/anular con motivo válido → 200', async () => {
    updateMock.mockReturnValueOnce(chain([{ ...REMESA_ROW, estado: 'anulada' }]));
    const r = await request(app)
      .post('/api/rndc/remesas/1/anular')
      .set('Authorization', await adminAuth())
      .send({ motivo: 'cliente canceló' });
    expect(r.status).toBe(200);
    expect(r.body.data.estado).toBe('anulada');
  });

  it('POST /:id/anular no encontrada → 404', async () => {
    updateMock.mockReturnValueOnce(chain([]));
    const r = await request(app)
      .post('/api/rndc/remesas/999/anular')
      .set('Authorization', await adminAuth())
      .send({ motivo: 'no aplica' });
    expect(r.status).toBe(404);
  });

  it('DELETE /:id en estado activa → 409 (solo borradores)', async () => {
    updateMock.mockReturnValueOnce(chain([]));
    const r = await request(app)
      .delete('/api/rndc/remesas/1')
      .set('Authorization', await adminAuth());
    expect(r.status).toBe(409);
  });

  it('DELETE /:id en borrador → 200 soft delete', async () => {
    updateMock.mockReturnValueOnce(chain([{ ...REMESA_ROW, deletedAt: new Date() }]));
    const r = await request(app)
      .delete('/api/rndc/remesas/1')
      .set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
  });
});
