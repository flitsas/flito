import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
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

const sendExcelMock = vi.fn().mockImplementation((res: any) => {
  res.status(200).type('application/octet-stream').send(Buffer.from('xlsx'));
});
vi.mock('../../src/shared/utils/excel.js', () => ({
  parseExcel: vi.fn(),
  sendExcel: sendExcelMock,
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
  sendExcelMock.mockClear().mockImplementation((res: any) => {
    res.status(200).type('application/octet-stream').send(Buffer.from('xlsx'));
  });
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/vehicles/vehicles.routes.js');
  app.use('/api/vehicles', router);
  return app;
}

describe('vehicles — auth', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/vehicles');
    expect(r.status).toBe(401);
  });

  it('GET /pipeline/stats requiere admin (proveedor → 403)', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).get('/api/vehicles/pipeline/stats').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });
});

describe('GET / — listado con search + masking PII', () => {
  function stubListQuery(rows: any[]) {
    // `$dynamic()` devuelve un chain que soporta tanto await directo como `.where()` (cuando hay search).
    selectMock.mockReturnValueOnce({
      from: () => ({
        leftJoin: () => ({
          $dynamic: () => chain(rows),
        }),
      }),
    });
  }

  it('admin → ownerDocument completo (sin masking)', async () => {
    stubListQuery([
      { id: 1, vin: 'V1', plate: 'ABC123', ownerDocument: '1036640908', soatStatus: 'aprobado' },
    ]);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/vehicles').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body[0].ownerDocument).toBe('1036640908');
  });

  it('no-admin (transito) → ownerDocument enmascarado (4 chars + ****)', async () => {
    stubListQuery([
      { id: 1, vin: 'V1', plate: 'ABC', ownerDocument: '1036640908', soatStatus: 'aprobado' },
    ]);
    const token = await testToken({ sub: 1, role: 'transito' });
    const app = await buildApp();
    const r = await request(app).get('/api/vehicles').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body[0].ownerDocument).toBe('1036****');
  });

  it('ownerDocument null no rompe masking', async () => {
    stubListQuery([{ id: 1, vin: 'V1', ownerDocument: null, soatStatus: null }]);
    const token = await testToken({ sub: 1, role: 'transito' });
    const app = await buildApp();
    const r = await request(app).get('/api/vehicles').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body[0].ownerDocument).toBeNull();
  });

  it('filtro status post-fetch (sin_solicitud cuando soatStatus null)', async () => {
    stubListQuery([
      { id: 1, vin: 'V1', soatStatus: 'aprobado' },
      { id: 2, vin: 'V2', soatStatus: null },
    ]);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/vehicles?status=sin_solicitud').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
    expect(r.body[0].id).toBe(2);
  });

  it('fecha inválida → ignorada (sin filtro de día)', async () => {
    stubListQuery([{ id: 1, vin: 'V1', soatStatus: null }]);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/vehicles?fecha=31-02-2026').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
  });

  it('fecha válida → 200 con filtro aplicado', async () => {
    stubListQuery([{ id: 2, vin: 'V2', soatStatus: null, createdAt: '2026-05-30T10:00:00Z' }]);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/vehicles?fecha=2026-05-30').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body[0].id).toBe(2);
  });

  it('rango desde/hasta → 200', async () => {
    stubListQuery([{ id: 3, vin: 'V3', soatStatus: null }]);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/vehicles?desde=2026-05-01&hasta=2026-05-30').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body[0].id).toBe(3);
  });

  it('rango invertido (hasta < desde) → intercambia y responde 200', async () => {
    stubListQuery([{ id: 4, vin: 'V4', soatStatus: null }]);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/vehicles?desde=2026-05-30&hasta=2026-05-01').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });

  it('paginación slice por offset+limit', async () => {
    stubListQuery(Array.from({ length: 10 }, (_, i) => ({ id: i + 1, vin: `V${i}`, soatStatus: null })));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/vehicles?limit=3&offset=2').set('Authorization', `Bearer ${token}`);
    expect(r.body).toHaveLength(3);
    expect(r.body[0].id).toBe(3);
  });

  it('search trunca a 100 chars', async () => {
    stubListQuery([]);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const longSearch = 'A'.repeat(150);
    const r = await request(app).get(`/api/vehicles?search=${longSearch}`).set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });
});

describe('POST / — crear vehículo', () => {
  it('sin admin → 403', async () => {
    const token = await testToken({ sub: 1, role: 'transito' });
    const app = await buildApp();
    const r = await request(app).post('/api/vehicles').set('Authorization', `Bearer ${token}`)
      .send({ vin: 'XYZ' });
    expect(r.status).toBe(403);
  });

  it('vin > 17 chars → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/vehicles').set('Authorization', `Bearer ${token}`)
      .send({ vin: 'A'.repeat(20) });
    expect(r.status).toBe(400);
  });

  it('VIN duplicado → 409', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 5 }])); // existe
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/vehicles').set('Authorization', `Bearer ${token}`)
      .send({ vin: 'V123' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/VIN ya existe/);
  });

  it('éxito → 201 + audit + ownerDocument normalizado', async () => {
    selectMock.mockReturnValueOnce(chain([])); // no existe previo
    let captured: any = null;
    insertMock.mockReturnValueOnce({
      values: (v: any) => { captured = v; return { returning: () => Promise.resolve([{ id: 9, ...v }]) }; },
    });
    const token = await testToken({ sub: 7, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/vehicles').set('Authorization', `Bearer ${token}`)
      .send({ vin: 'V001', ownerDocument: '1.036.640.908' });
    expect(r.status).toBe(201);
    expect(captured.ownerDocument).toBe('1036640908'); // normalizado
    expect(auditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'create', resource: 'vehicle' }),
    );
  });
});

describe('PATCH /:id — actualizar', () => {
  it('id no numérico → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/vehicles/abc').set('Authorization', `Bearer ${token}`)
      .send({ plate: 'X' });
    expect(r.status).toBe(400);
  });

  it('id <= 0 → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/vehicles/0').set('Authorization', `Bearer ${token}`)
      .send({ plate: 'X' });
    expect(r.status).toBe(400);
  });

  it('no encontrado → 404', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/vehicles/999').set('Authorization', `Bearer ${token}`)
      .send({ plate: 'NEW' });
    expect(r.status).toBe(404);
  });

  it('éxito → 200', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 1, plate: 'NEW' }]) }) }),
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/vehicles/1').set('Authorization', `Bearer ${token}`)
      .send({ plate: 'NEW' });
    expect(r.status).toBe(200);
    expect(r.body.plate).toBe('NEW');
  });
});

describe('DELETE /:id — transaction con check SOAT', () => {
  it('vehículo con SOAT activo → 409 (NO borra)', async () => {
    transactionMock.mockImplementationOnce(async (cb) => {
      const tx = {
        select: vi.fn(() => chain([{ id: 5 }])), // SOAT activo
        delete: vi.fn(),
      };
      return cb(tx);
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).delete('/api/vehicles/1').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/SOAT/);
  });

  it('vehículo sin SOAT pero no encontrado → 404', async () => {
    transactionMock.mockImplementationOnce(async (cb) => {
      const tx = {
        select: vi.fn(() => chain([])), // sin SOAT
        delete: vi.fn(() => ({
          where: () => ({ returning: () => Promise.resolve([]) }), // delete vacío
        })),
      };
      return cb(tx);
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).delete('/api/vehicles/999').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
  });

  it('borrado exitoso → 200', async () => {
    transactionMock.mockImplementationOnce(async (cb) => {
      const tx = {
        select: vi.fn(() => chain([])),
        delete: vi.fn(() => ({
          where: () => ({ returning: () => Promise.resolve([{ id: 1 }]) }),
        })),
      };
      return cb(tx);
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).delete('/api/vehicles/1').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it('id inválido → 400 (no entra a transaction)', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).delete('/api/vehicles/abc').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
    expect(transactionMock).not.toHaveBeenCalled();
  });
});

describe('PATCH /:id/multas — refine condicional', () => {
  it('estado=con_multas SIN total/count > 0 → 400 (refine zod)', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/vehicles/1/multas').set('Authorization', `Bearer ${token}`)
      .send({ estado: 'con_multas' });
    expect(r.status).toBe(400);
  });

  it('estado=con_multas con total=0 → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/vehicles/1/multas').set('Authorization', `Bearer ${token}`)
      .send({ estado: 'con_multas', total: 0, count: 1 });
    expect(r.status).toBe(400);
  });

  it('estado=sin_multas con total/count → fuerza ambos a 0', async () => {
    let captured: any = null;
    updateMock.mockReturnValueOnce({
      set: (v: any) => { captured = v; return { where: () => ({ returning: () => Promise.resolve([{ id: 1, ...v }]) }) }; },
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/vehicles/1/multas').set('Authorization', `Bearer ${token}`)
      .send({ estado: 'sin_multas', total: 999, count: 5 });
    expect(r.status).toBe(200);
    expect(captured.multasTotal).toBe('0'); // forzado a 0
    expect(captured.multasCount).toBe(0);
    expect(captured.multasConsultadoAt).toBeInstanceOf(Date);
  });

  it('estado=con_multas válido → 200 + audit con detalle', async () => {
    let captured: any = null;
    updateMock.mockReturnValueOnce({
      set: (v: any) => { captured = v; return { where: () => ({ returning: () => Promise.resolve([{ id: 1, plate: 'ABC', ...v }]) }) }; },
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/vehicles/1/multas').set('Authorization', `Bearer ${token}`)
      .send({ estado: 'con_multas', total: 250000, count: 3, notas: 'verificado' });
    expect(r.status).toBe(200);
    expect(captured.multasTotal).toBe('250000');
    expect(captured.multasCount).toBe(3);
    expect(auditMock.mock.calls[0][1].detail).toContain('con_multas');
    expect(auditMock.mock.calls[0][1].detail).toContain('3 comparendos');
  });

  it('estado fuera del enum → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/vehicles/1/multas').set('Authorization', `Bearer ${token}`)
      .send({ estado: 'desconocido' });
    expect(r.status).toBe(400);
  });

  it('vehículo no encontrado → 404', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/vehicles/999/multas').set('Authorization', `Bearer ${token}`)
      .send({ estado: 'sin_multas' });
    expect(r.status).toBe(404);
  });
});

describe('PATCH /:id/stage', () => {
  it('stage fuera de validStages → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/vehicles/1/stage').set('Authorization', `Bearer ${token}`)
      .send({ stage: 'hackeado' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Etapa inválida/);
  });

  it('stage válido → 200 + audit', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 1, stage: 'soat_comprado' }]) }) }),
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/vehicles/1/stage').set('Authorization', `Bearer ${token}`)
      .send({ stage: 'soat_comprado' });
    expect(r.status).toBe(200);
    expect(auditMock.mock.calls[0][1].detail).toContain('soat_comprado');
  });
});

describe('PATCH /:id/client', () => {
  it('clientId=null limpia asignación', async () => {
    let captured: any = null;
    updateMock.mockReturnValueOnce({
      set: (v: any) => { captured = v; return { where: () => ({ returning: () => Promise.resolve([{ id: 1, clientId: null }]) }) }; },
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/vehicles/1/client').set('Authorization', `Bearer ${token}`)
      .send({ clientId: null });
    expect(r.status).toBe(200);
    expect(captured.clientId).toBeNull();
  });

  it('clientId=5 asigna', async () => {
    let captured: any = null;
    updateMock.mockReturnValueOnce({
      set: (v: any) => { captured = v; return { where: () => ({ returning: () => Promise.resolve([{ id: 1, clientId: 5 }]) }) }; },
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    await request(app).patch('/api/vehicles/1/client').set('Authorization', `Bearer ${token}`)
      .send({ clientId: 5 });
    expect(captured.clientId).toBe(5);
  });
});

describe('GET /pipeline/stats', () => {
  it('groupBy stage con defaults a 0 para etapas conocidas', async () => {
    selectMock.mockReturnValueOnce({
      from: () => ({
        $dynamic: () => chain([
          { stage: 'ingreso', count: 5 },
          { stage: 'soat_comprado', count: 2 },
        ]),
      }),
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/vehicles/pipeline/stats').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.ingreso).toBe(5);
    expect(r.body.soat_comprado).toBe(2);
    expect(r.body.impuesto).toBe(0); // default
    expect(r.body.listo).toBe(0);
  });
});

describe('GET /export — Excel', () => {
  it('admin → 200 + sendExcel llamado', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, vin: 'V1', plate: 'ABC' }]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/vehicles/export').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(sendExcelMock).toHaveBeenCalled();
    // Headers definidos en el llamado
    const cols = sendExcelMock.mock.calls[0][2];
    expect(cols.map((c: any) => c.key)).toContain('vin');
    expect(cols.map((c: any) => c.key)).toContain('ownerDocument');
  });

  it('proveedor → 403', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).get('/api/vehicles/export').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });
});
