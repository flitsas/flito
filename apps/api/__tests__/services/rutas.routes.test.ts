import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { chain, chainReject } from '../helpers/db.js';
import { adminAuth, testToken } from '../helpers/auth.js';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const deleteMock = vi.fn();
const executeMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: insertMock, update: updateMock, delete: deleteMock, execute: executeMock, transaction: transactionMock },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('express-rate-limit', () => ({ default: () => (_req: any, _res: any, next: any) => next() }));

let app: any;
beforeEach(async () => {
  selectMock.mockReset(); insertMock.mockReset(); updateMock.mockReset();
  deleteMock.mockReset(); executeMock.mockReset(); transactionMock.mockReset();
  auditMock.mockClear();
  executeMock.mockResolvedValue([{ '?column?': 1 }]);
  const { createApp } = await import('../../src/app.js');
  app = createApp();
});

describe('Rutas · routes', () => {
  it('GET / lista rutas activas', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, codigo: 'R-001', nombre: 'Bogotá-Cali', activo: true }]));
    const r = await request(app).get('/api/rutas').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.data.length).toBe(1);
  });

  it('POST / OK admin crea ruta', async () => {
    insertMock.mockReturnValueOnce(chain([{ id: 5, codigo: 'R-005', criticidad: 'media' }]));
    const r = await request(app).post('/api/rutas').set('Authorization', await adminAuth())
      .send({ codigo: 'R-005', nombre: 'Bogotá-Medellín', origen: 'Bogotá', destino: 'Medellín' });
    expect(r.status).toBe(201);
    expect(r.body.codigo).toBe('R-005');
  });

  it('POST / código duplicado → 409', async () => {
    insertMock.mockReturnValueOnce(chainReject(Object.assign(new Error('dup'), { code: '23505' })));
    const r = await request(app).post('/api/rutas').set('Authorization', await adminAuth())
      .send({ codigo: 'R-005', nombre: 'Bogotá-Cali', origen: 'Bogotá', destino: 'Cali' });
    expect(r.status).toBe(409);
  });

  it('POST / proveedor → 403', async () => {
    const tokenProv = await testToken({ role: 'proveedor', sub: 5 });
    const r = await request(app).post('/api/rutas').set('Authorization', `Bearer ${tokenProv}`)
      .send({ codigo: 'R-005', nombre: 'X', origen: 'A', destino: 'B' });
    expect(r.status).toBe(403);
  });

  it('PATCH /:id optimistic lock conflict → 409', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, optimisticV: 5 }]));
    const r = await request(app).patch('/api/rutas/1').set('Authorization', await adminAuth())
      .send({ optimisticV: 1, nombre: 'nuevo' });
    expect(r.status).toBe(409);
  });

  it('POST /:id/waypoints lat fuera rango → 400', async () => {
    insertMock.mockReturnValueOnce(chainReject(Object.assign(new Error('check'), { code: '23514' })));
    const r = await request(app).post('/api/rutas/1/waypoints').set('Authorization', await adminAuth())
      .send({ orden: 1, tipo: 'origen', nombre: 'X', lat: 999, lng: 0 });
    expect(r.status).toBe(400);
  });

  it('POST /:id/waypoints orden duplicado → 409', async () => {
    insertMock.mockReturnValueOnce(chainReject(Object.assign(new Error('dup'), { code: '23505' })));
    const r = await request(app).post('/api/rutas/1/waypoints').set('Authorization', await adminAuth())
      .send({ orden: 1, tipo: 'origen', nombre: 'A' });
    expect(r.status).toBe(409);
  });

  it('POST /:id/waypoints/reorder con advisory lock', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        execute: vi.fn().mockResolvedValue([]), // advisory lock
        update: vi.fn().mockReturnValue({ set: () => ({ where: () => Promise.resolve([]) }) }),
      };
      return cb(tx);
    });
    const r = await request(app).post('/api/rutas/1/waypoints/reorder').set('Authorization', await adminAuth())
      .send({ items: [{ id: 10, orden: 1 }, { id: 11, orden: 2 }] });
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(2);
  });
});

describe('Rutas · risk', () => {
  it('POST /risk admin crea con trimestre válido', async () => {
    insertMock.mockReturnValueOnce(chain([{ id: 1, trimestre: '2026-Q2', estado: 'borrador' }]));
    const r = await request(app).post('/api/rutas/risk').set('Authorization', await adminAuth())
      .send({ routeId: 1, trimestre: '2026-Q2', fecha: '2026-05-07' });
    expect(r.status).toBe(201);
  });

  it('POST /risk trimestre formato inválido → 400 zod', async () => {
    const r = await request(app).post('/api/rutas/risk').set('Authorization', await adminAuth())
      .send({ routeId: 1, trimestre: '2026-INV', fecha: '2026-05-07' });
    expect(r.status).toBe(400);
  });

  it('POST /risk trimestre duplicado → 409', async () => {
    insertMock.mockReturnValueOnce(chainReject(Object.assign(new Error('dup'), { code: '23505' })));
    const r = await request(app).post('/api/rutas/risk').set('Authorization', await adminAuth())
      .send({ routeId: 1, trimestre: '2026-Q2', fecha: '2026-05-07' });
    expect(r.status).toBe(409);
  });

  it('POST /:id/aprobar transiciona a aprobado (WORM)', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        select: vi.fn().mockReturnValueOnce(chain([{ id: 1, estado: 'borrador', optimisticV: 1 }])),
        update: vi.fn().mockReturnValueOnce(chain([{ id: 1, estado: 'aprobado', aprobadoAt: new Date().toISOString() }])),
      };
      return cb(tx);
    });
    const r = await request(app).post('/api/rutas/risk/1/aprobar').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('aprobado');
  });

  it('POST /:id/aprobar 409 si no es borrador', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        select: vi.fn().mockReturnValueOnce(chain([{ id: 1, estado: 'aprobado', optimisticV: 5 }])),
        update: vi.fn(),
      };
      return cb(tx);
    });
    const r = await request(app).post('/api/rutas/risk/1/aprobar').set('Authorization', await adminAuth());
    expect(r.status).toBe(409);
  });

  it('POST /:id/items rechaza si análisis aprobado (WORM precheck)', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, estado: 'aprobado' }]));
    const r = await request(app).post('/api/rutas/risk/1/items').set('Authorization', await adminAuth())
      .send({ peligro: 'Niebla', probabilidad: 4, impacto: 5 });
    expect(r.status).toBe(409);
  });

  it('POST /:id/items OK borrador con score generado', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, estado: 'borrador' }]));
    insertMock.mockReturnValueOnce(chain([{ id: 100, peligro: 'Niebla', score: 20 }]));
    const r = await request(app).post('/api/rutas/risk/1/items').set('Authorization', await adminAuth())
      .send({ peligro: 'Niebla en Páramo', probabilidad: 4, impacto: 5 });
    expect(r.status).toBe(201);
    expect(r.body.score).toBe(20);
  });
});

describe('Rutas · pernocta + assignments', () => {
  it('POST /pernocta admin OK', async () => {
    insertMock.mockReturnValueOnce(chain([{ id: 1, nombre: 'Estación La Linea', vigente: true }]));
    const r = await request(app).post('/api/rutas/pernocta').set('Authorization', await adminAuth())
      .send({ nombre: 'Estación La Linea', lat: 4.5, lng: -75.5, capacidad: 30 });
    expect(r.status).toBe(201);
  });

  it('GET /pernocta/cercanas calcula haversine', async () => {
    executeMock.mockResolvedValueOnce({ rows: [
      { id: 1, nombre: 'A', lat: 4.5, lng: -75.5, distancia_km: '15.2' },
      { id: 2, nombre: 'B', lat: 6.5, lng: -78.5, distancia_km: '450.0' },
    ] });
    const r = await request(app).get('/api/rutas/pernocta/cercanas?lat=4.5&lng=-75.5&radioKm=50').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.data.length).toBe(1);
    expect(r.body.data[0].nombre).toBe('A');
  });

  it('DELETE /pernocta/:id soft archive (vigente=false)', async () => {
    updateMock.mockReturnValueOnce(chain([{ id: 1, vigente: false }]));
    const r = await request(app).delete('/api/rutas/pernocta/1').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
  });

  it('POST /assignments XOR refine zod (sin ninguno) → 400', async () => {
    const r = await request(app).post('/api/rutas/assignments').set('Authorization', await adminAuth())
      .send({ routeId: 1 });
    expect(r.status).toBe(400);
  });

  it('POST /assignments XOR refine zod (con ambos) → 400', async () => {
    const r = await request(app).post('/api/rutas/assignments').set('Authorization', await adminAuth())
      .send({ routeId: 1, remesaId: 1, manifiestoId: 1 });
    expect(r.status).toBe(400);
  });

  it('POST /assignments OK con remesaId solo', async () => {
    insertMock.mockReturnValueOnce(chain([{ id: 1, routeId: 1, remesaId: 5 }]));
    const r = await request(app).post('/api/rutas/assignments').set('Authorization', await adminAuth())
      .send({ routeId: 1, remesaId: 5 });
    expect(r.status).toBe(201);
  });

  it('POST /assignments remesa ya asignada → 409', async () => {
    insertMock.mockReturnValueOnce(chainReject(Object.assign(new Error('dup'), { code: '23505' })));
    const r = await request(app).post('/api/rutas/assignments').set('Authorization', await adminAuth())
      .send({ routeId: 1, remesaId: 5 });
    expect(r.status).toBe(409);
  });
});
