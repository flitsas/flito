import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

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
    delete: vi.fn(),
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({
  audit: auditMock,
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
  transactionMock.mockReset();
  auditMock.mockClear();
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/drivers/incidents.routes.js');
  app.use('/api/incidents', router);
  return app;
}

const adminToken = () => testToken({ sub: 1, role: 'admin' });

describe('incidents — auth', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/incidents');
    expect(r.status).toBe(401);
  });

  it('proveedor sin PESV → 403', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).get('/api/incidents').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });
});

describe('GET / — listado con filtros', () => {
  it('admin sin filtros → 200', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, tipo: 'accidente' }]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/incidents').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
  });

  it('todos los filtros (tipo/gravedad/from/to/conductorId)', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/incidents?tipo=accidente&gravedad=grave&from=2026-01-01&to=2026-12-31&conductorId=5')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });
});

describe('GET /:id', () => {
  it('id no numérico → 404 (path constraint /:id(\\\\d+) no matchea)', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/incidents/abc').set('Authorization', `Bearer ${token}`);
    // Antes el handler hacía parseId y devolvía 400; ahora la ruta tiene constraint
    // numérico para que /stats no se intercepte como id, así que /abc cae a 404.
    expect(r.status).toBe(404);
  });

  it('no encontrado → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/incidents/999').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
  });

  it('encontrado → 200 con actions', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, tipo: 'accidente', estado: 'abierto' }]));
    selectMock.mockReturnValueOnce(chain([
      { id: 10, incidentId: 1, descripcion: 'capacitar', estado: 'pendiente' },
    ]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/incidents/1').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.data.id).toBe(1);
    expect(r.body.actions).toHaveLength(1);
  });
});

describe('POST / — crear incidente', () => {
  const VALID_BODY = {
    tipo: 'accidente',
    fecha: '2026-05-06',
    gravedad: 'leve',
    descripcion: 'Choque en parqueadero',
    costos: 250000,
    victimasCount: 0,
    diasPerdidos: 2,
  };

  it('proveedor → 403', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).post('/api/incidents').set('Authorization', `Bearer ${token}`).send(VALID_BODY);
    expect(r.status).toBe(403);
  });

  it('tipo fuera enum → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/incidents').set('Authorization', `Bearer ${token}`)
      .send({ ...VALID_BODY, tipo: 'inventado' });
    expect(r.status).toBe(400);
  });

  it('gravedad fuera enum → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/incidents').set('Authorization', `Bearer ${token}`)
      .send({ ...VALID_BODY, gravedad: 'extrema' });
    expect(r.status).toBe(400);
  });

  it('fecha formato inválido → 400 (regex zod)', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/incidents').set('Authorization', `Bearer ${token}`)
      .send({ ...VALID_BODY, fecha: '06/05/2026' });
    expect(r.status).toBe(400);
  });

  it('lat fuera [-90,90] → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/incidents').set('Authorization', `Bearer ${token}`)
      .send({ ...VALID_BODY, lat: 100 });
    expect(r.status).toBe(400);
  });

  it('costos < 0 → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/incidents').set('Authorization', `Bearer ${token}`)
      .send({ ...VALID_BODY, costos: -1 });
    expect(r.status).toBe(400);
  });

  it('éxito → 201 + numerics convertidos a string + audit', async () => {
    let captured: any = null;
    insertMock.mockReturnValueOnce({
      values: (v: any) => { captured = v; return { returning: () => Promise.resolve([{ id: 100, ...v }]) }; },
    });
    const token = await testToken({ sub: 7, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/incidents').set('Authorization', `Bearer ${token}`)
      .send({ ...VALID_BODY, lat: 6.25, lng: -75.5, valorMulta: 500000 });
    expect(r.status).toBe(201);
    expect(captured.costos).toBe('250000');
    expect(captured.valorMulta).toBe('500000');
    expect(captured.lat).toBe('6.25');
    expect(captured.lng).toBe('-75.5');
    expect(captured.reportadoPor).toBe(7);
    expect(auditMock.mock.calls[0][1].detail).toBe('accidente leve');
  });
});

describe('PATCH /:id', () => {
  it('id inválido → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/incidents/abc').set('Authorization', `Bearer ${token}`)
      .send({ gravedad: 'grave' });
    expect(r.status).toBe(400);
  });

  it('no encontrado → 404', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/incidents/999').set('Authorization', `Bearer ${token}`)
      .send({ gravedad: 'grave' });
    expect(r.status).toBe(404);
  });

  it('actualizar costos+lat → coerciones a string', async () => {
    let captured: any = null;
    updateMock.mockReturnValueOnce({
      set: (v: any) => { captured = v; return { where: () => ({ returning: () => Promise.resolve([{ id: 1 }]) }) }; },
    });
    const token = await adminToken();
    const app = await buildApp();
    await request(app).patch('/api/incidents/1').set('Authorization', `Bearer ${token}`)
      .send({ costos: 100000, lat: 4.6 });
    expect(captured.costos).toBe('100000');
    expect(captured.lat).toBe('4.6');
  });
});

describe('POST /:id/actions — crear acción correctiva', () => {
  it('id inválido → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/incidents/abc/actions').set('Authorization', `Bearer ${token}`)
      .send({ descripcion: 'capacitar' });
    expect(r.status).toBe(400);
  });

  it('descripcion vacía → 400 (zod min 1)', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/incidents/1/actions').set('Authorization', `Bearer ${token}`)
      .send({ descripcion: '' });
    expect(r.status).toBe(400);
  });

  it('éxito → 201 con incidentId asignado', async () => {
    let captured: any = null;
    insertMock.mockReturnValueOnce({
      values: (v: any) => { captured = v; return { returning: () => Promise.resolve([{ id: 50, ...v }]) }; },
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/incidents/1/actions').set('Authorization', `Bearer ${token}`)
      .send({ descripcion: 'Capacitar conductor', responsableId: 7, fechaLimite: '2026-06-30' });
    expect(r.status).toBe(201);
    expect(captured.incidentId).toBe(1);
    expect(captured.descripcion).toBe('Capacitar conductor');
    expect(captured.responsableId).toBe(7);
    expect(captured.fechaLimite).toBe('2026-06-30');
  });

  it('proveedor → 403', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).post('/api/incidents/1/actions').set('Authorization', `Bearer ${token}`)
      .send({ descripcion: 'X' });
    expect(r.status).toBe(403);
  });
});

describe('PATCH /:id/actions/:actionId', () => {
  it('actionId inválido → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/incidents/1/actions/abc').set('Authorization', `Bearer ${token}`)
      .send({ estado: 'cumplida' });
    expect(r.status).toBe(400);
  });

  it('estado fuera enum → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/incidents/1/actions/10').set('Authorization', `Bearer ${token}`)
      .send({ estado: 'inventado' });
    expect(r.status).toBe(400);
  });

  it('no encontrada → 404', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/incidents/1/actions/999').set('Authorization', `Bearer ${token}`)
      .send({ estado: 'cumplida' });
    expect(r.status).toBe(404);
  });

  it('marcar cumplida → 200', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 10, estado: 'cumplida' }]) }) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/incidents/1/actions/10').set('Authorization', `Bearer ${token}`)
      .send({ estado: 'cumplida', fechaCumplimiento: '2026-06-15' });
    expect(r.status).toBe(200);
    expect(r.body.data.estado).toBe('cumplida');
  });
});

describe('POST /:id/close — cierre de incidente', () => {
  it('id inválido → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/incidents/abc/close').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('incidente no existe → 409', async () => {
    transactionMock.mockImplementationOnce(async (cb) => {
      const tx = {
        select: vi.fn(() => chain([])),
        update: vi.fn(),
      };
      return cb(tx);
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/incidents/999/close').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/no encontrado/i);
  });

  it('ya cerrado → 200 idempotente (no audit)', async () => {
    transactionMock.mockImplementationOnce(async (cb) => {
      const tx = {
        select: vi.fn(() => chain([{ id: 1, estado: 'cerrado' }])),
        update: vi.fn(),
      };
      return cb(tx);
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/incidents/1/close').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.idempotente).toBe(true);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('acciones pendientes → 409 con count', async () => {
    transactionMock.mockImplementationOnce(async (cb) => {
      let selectCount = 0;
      const tx = {
        select: vi.fn(() => {
          selectCount++;
          if (selectCount === 1) return chain([{ id: 1, estado: 'abierto' }]);
          return chain([{ id: 10 }, { id: 11 }, { id: 12 }]); // 3 pendientes
        }),
        update: vi.fn(),
      };
      return cb(tx);
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/incidents/1/close').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/3 acciones sin cumplir/);
  });

  it('todas las acciones cumplidas → 200 + audit closed', async () => {
    transactionMock.mockImplementationOnce(async (cb) => {
      let selectCount = 0;
      let updateValues: any = null;
      const tx = {
        select: vi.fn(() => {
          selectCount++;
          if (selectCount === 1) return chain([{ id: 1, estado: 'abierto' }]);
          return chain([]); // sin acciones pendientes
        }),
        update: vi.fn(() => ({
          set: (v: any) => { updateValues = v; return { where: () => ({ returning: () => Promise.resolve([{ id: 1, estado: 'cerrado', closedAt: v.closedAt }]) }) }; },
        })),
      };
      const result = await cb(tx);
      // Validar que update set.estado='cerrado' + closedAt
      expect(updateValues.estado).toBe('cerrado');
      expect(updateValues.closedAt).toBeInstanceOf(Date);
      return result;
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/incidents/1/close').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.idempotente).toBe(false);
    expect(auditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'update', resource: 'road_incident', detail: 'closed' }),
    );
  });

  it('proveedor → 403', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).post('/api/incidents/1/close').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });
});
