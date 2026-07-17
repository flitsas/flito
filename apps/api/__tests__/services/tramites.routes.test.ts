import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
// OPS-02b r4: mock KEYED por tabla. `selectMock` se conserva como alias para los
// 3 mocks custom de captura de límite (no son chain()).
import { chain } from '../helpers/db.js';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken } from '../helpers/auth.js';

const kdb = createKeyedDb();
const { select: selectMock, insert: insertMock, update: updateMock, delete: deleteMock } = kdb;

vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
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
  kdb.reset();
  auditMock.mockClear();
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/tramites/tramites.routes.js');
  app.use('/api/tramites', router);
  return app;
}

/** GET /tramites hace 2 SELECT: items + count (Promise.all). */
function mockListTramites(items: unknown[] = [], total = items.length) {
  kdb.when.selectOnce('tramites_digitales', items as never[]);
  kdb.when.selectOnce('tramites_digitales', [{ count: total }]);
}

describe('tramites — auth middleware', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/tramites');
    expect(r.status).toBe(401);
  });

  it('rol proveedor → 403 (requireRole admin|transito)', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });

  it('rol transito → 200 (acceso permitido)', async () => {
    mockListTramites();
    const token = await testToken({ sub: 1, role: 'transito' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });
});

describe('GET /api/tramites/stats/* (rutas registradas ANTES de /:id)', () => {
  it('GET /stats/resumen → agrupa por estado con defaults a 0', async () => {
    kdb.when.selectOnce('tramites_digitales', [
      { estado: 'borrador', count: 3 },
      { estado: 'aprobado', count: 5 },
    ]);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/stats/resumen').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.borrador).toBe(3);
    expect(r.body.aprobado).toBe(5);
    expect(r.body.radicado).toBe(0); // default
    expect(r.body.identidad).toBe(0);
  });

  it('GET /stats/metricas → 3 queries (porEstado, recientes, completados)', async () => {
    kdb.when.selectOnce('tramites_digitales', [{ estado: 'borrador', count: 2 }]);
    kdb.when.selectOnce('tramites_digitales', [{ count: 10 }]);
    kdb.when.selectOnce('tramites_digitales', [{ count: 4 }]);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/stats/metricas').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.porEstado.borrador).toBe(2);
    expect(r.body.tramites30d).toBe(10);
    expect(r.body.completados30d).toBe(4);
  });
});

describe('GET /api/tramites — listado con filtros y paginación', () => {
  it('limit cap a 200', async () => {
    let capturedLimit: number | null = null;
    selectMock.mockReturnValueOnce({
      from: () => ({
        orderBy: () => ({
          limit: (n: number) => { capturedLimit = n; return { offset: () => Promise.resolve([]) }; },
        }),
      }),
    });
    kdb.when.selectOnce('tramites_digitales', [{ count: 0 }]);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    await request(app).get('/api/tramites?limit=999').set('Authorization', `Bearer ${token}`);
    expect(capturedLimit).toBe(200);
  });

  it('limit default 50', async () => {
    let capturedLimit: number | null = null;
    selectMock.mockReturnValueOnce({
      from: () => ({
        orderBy: () => ({
          limit: (n: number) => { capturedLimit = n; return { offset: () => Promise.resolve([]) }; },
        }),
      }),
    });
    kdb.when.selectOnce('tramites_digitales', [{ count: 0 }]);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    await request(app).get('/api/tramites').set('Authorization', `Bearer ${token}`);
    expect(capturedLimit).toBe(50);
  });

  it('offset negativo → 0 (Math.max guard)', async () => {
    let capturedOffset: number | null = null;
    selectMock.mockReturnValueOnce({
      from: () => ({
        orderBy: () => ({
          limit: () => ({ offset: (n: number) => { capturedOffset = n; return Promise.resolve([]); } }),
        }),
      }),
    });
    kdb.when.selectOnce('tramites_digitales', [{ count: 0 }]);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    await request(app).get('/api/tramites?offset=-5').set('Authorization', `Bearer ${token}`);
    expect(capturedOffset).toBe(0);
  });

  it('search trunca a 100 chars', async () => {
    mockListTramites();
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const longSearch = 'A'.repeat(150);
    const r = await request(app).get(`/api/tramites?search=${longSearch}`).set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });

  it('estado fuera del enum → ignorado (no aplica filtro)', async () => {
    mockListTramites([{ id: 1 }], 1);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites?estado=hackeado').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });

  it('etapa inválida → ignorada (no aplica filtro)', async () => {
    mockListTramites([{ id: 1 }], 1);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites?etapa=noexiste').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });

  it('rango desde/hasta → 200', async () => {
    mockListTramites([{ id: 2 }], 1);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites?desde=2026-05-01&hasta=2026-05-30').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.items[0].id).toBe(2);
  });
});

describe('GET /api/tramites/:id', () => {
  it('id no numérico → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/abc').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('id <= 0 → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/0').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('no encontrado → 404', async () => {
    kdb.when.selectOnce('tramites_digitales', []);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/999').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
  });

  it('encontrado → 200 con archivos adjuntos', async () => {
    kdb.when.selectOnce('tramites_digitales', [{ id: 5, vin: 'XYZ', estado: 'borrador' }]);
    kdb.when.selectOnce('tramites_documentos', [{ id: 1, tramiteId: 5, tipo: 'factura' }]);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/5').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(5);
    expect(r.body.archivos).toHaveLength(1);
  });
});

describe('POST /api/tramites — crear', () => {
  it('vin vacío → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites').set('Authorization', `Bearer ${token}`)
      .send({ vin: '' });
    expect(r.status).toBe(400);
  });

  it('vin > 17 chars → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites').set('Authorization', `Bearer ${token}`)
      .send({ vin: 'A'.repeat(20) });
    expect(r.status).toBe(400);
  });

  it('éxito: normaliza vin (uppercase + remueve no-alfanuméricos), placa null si no viene', async () => {
    kdb.when.selectOnce('tramites_digitales', []); // sin trámite previo para este VIN
    let captured: any = null;
    insertMock.mockReturnValueOnce({
      values: (v: any) => { captured = v; return { returning: () => Promise.resolve([{ id: 100, ...v }]) }; },
    });
    const token = await testToken({ sub: 7, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites').set('Authorization', `Bearer ${token}`)
      .send({ vin: 'abc-123/xyz' });
    expect(r.status).toBe(201);
    expect(captured.vin).toBe('ABC123XYZ'); // limpia caracteres no [A-Z0-9]
    expect(captured.placa).toBeNull();
    expect(captured.estado).toBe('borrador');
    expect(captured.paso).toBe(1);
    expect(captured.creadoPor).toBe(7);
    expect(auditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'create', resource: 'tramite' }),
    );
  });

  it('VIN con trámite de matrícula inicial activo → 409 TRAMITE_DUPLICADO', async () => {
    kdb.when.selectOnce('tramites_digitales', [
      { id: 42, estado: 'borrador', paso: 4, placa: 'QTP710', vin: 'LRWYGCEK8TC541064' },
    ]);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites').set('Authorization', `Bearer ${token}`)
      .send({ vin: 'LRWYGCEK8TC541064' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('TRAMITE_DUPLICADO');
    expect(r.body.existingTramite.id).toBe(42);
    expect(r.body.error).toMatch(/matrícula inicial/i);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('VIN con matrícula inicial completada → 409 TRAMITE_MATRICULA_COMPLETADA', async () => {
    kdb.when.selectOnce('tramites_digitales', [
      { id: 9, estado: 'completado', paso: 5, placa: 'ABC123', vin: 'VINCOMPLETADO1' },
    ]);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites').set('Authorization', `Bearer ${token}`)
      .send({ vin: 'VINCOMPLETADO1' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('TRAMITE_MATRICULA_COMPLETADA');
    expect(insertMock).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/tramites/:id — máquina de estados + optimistic locking', () => {
  it('id inválido → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/tramites/abc').set('Authorization', `Bearer ${token}`)
      .send({ paso: 2 });
    expect(r.status).toBe(400);
  });

  it('paso fuera de [1,6] → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/tramites/1').set('Authorization', `Bearer ${token}`)
      .send({ paso: 99 });
    expect(r.status).toBe(400);
  });

  it('estado fuera del enum → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/tramites/1').set('Authorization', `Bearer ${token}`)
      .send({ estado: 'hackeado' });
    expect(r.status).toBe(400);
  });

  it('transición ilegal (borrador → completado) → 409', async () => {
    kdb.when.selectOnce('tramites_digitales', [{ estado: 'borrador' }]);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/tramites/1').set('Authorization', `Bearer ${token}`)
      .send({ estado: 'completado' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Transición no permitida/i);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('estado actual no encontrado en BD → 404', async () => {
    kdb.when.selectOnce('tramites_digitales', []);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/tramites/999').set('Authorization', `Bearer ${token}`)
      .send({ estado: 'aprobado' });
    expect(r.status).toBe(404);
  });

  it('transición legal (borrador → radicado) + optimistic locking → 200 + historial insert', async () => {
    kdb.when.selectOnce('tramites_digitales', [{ estado: 'borrador' }]);
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 1, estado: 'radicado', paso: 2 }]) }) }),
    });
    let historialInsertCalled = false;
    insertMock.mockReturnValueOnce({
      values: () => { historialInsertCalled = true; return Promise.resolve([]).catch(() => {}); },
    });
    const token = await testToken({ sub: 5, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/tramites/1').set('Authorization', `Bearer ${token}`)
      .send({ estado: 'radicado' });
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('radicado');
    expect(historialInsertCalled).toBe(true);
  });

  it('optimistic locking: si update no devuelve fila (alguien cambió estado entre check y update) → 409', async () => {
    kdb.when.selectOnce('tramites_digitales', [{ estado: 'borrador' }]);
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/tramites/1').set('Authorization', `Bearer ${token}`)
      .send({ estado: 'radicado' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/concurrencia/i);
  });

  it('actualizar solo vehículo (sin estado) NO requiere historial ni check de transición', async () => {
    const row = {
      modalidad: 'matricula_inicial',
      vehiculo: {},
      comprador: {},
      paso: 1,
    };
    kdb.when
      .selectOnce('tramites_digitales', [row])
      .selectOnce('tramites_digitales', [row])
      .selectOnce('tramites_digitales', [row]);
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 1, estado: 'borrador', paso: 1 }]) }) }),
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/tramites/1').set('Authorization', `Bearer ${token}`)
      .send({ vehiculo: { marca: 'Toyota' }, paso: 2 });
    expect(r.status).toBe(200);
  });

  it('traspaso con vendedor/comprador duplicados → 400 partes_duplicadas', async () => {
    const row = {
      modalidad: 'traspaso',
      estado: 'radicado',
      vehiculo: { _vendedor: { documento: '123', email: 'dup@x.co' } },
      comprador: { documento: '456', email: 'other@x.co' },
      paso: 1,
    };
    kdb.when
      .selectOnce('tramites_digitales', [row])
      .selectOnce('tramites_digitales', [row])
      .selectOnce('tramites_digitales', [row]);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/tramites/1').set('Authorization', `Bearer ${token}`)
      .send({ comprador: { nombre: 'Com', tipoDoc: 'CC', documento: '456', email: 'dup@x.co' } });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('partes_duplicadas');
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/tramites/:id/documentos', () => {
  it('id inválido → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/-1/documentos').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('lista vacía → 200 con []', async () => {
    kdb.when.selectOnce('tramites_documentos', []);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/1/documentos').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });
});

describe('DELETE /api/tramites/:tramiteId/documentos/:docId — ownership check', () => {
  it('IDs no numéricos → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).delete('/api/tramites/abc/documentos/def').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('docId no pertenece al tramiteId → 404 (ownership)', async () => {
    kdb.when.selectOnce('tramites_documentos', []);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).delete('/api/tramites/1/documentos/2').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/no encontrado en este trámite/i);
  });

  it('traspaso en STT: operador no puede borrar doc de gestión → 409', async () => {
    kdb.when.selectOnce('tramites_documentos', [{ id: 2, tramiteId: 1, tipo: 'compraventa', originalName: 'c.pdf', filename: 'uploads/tramites/1/c.pdf' }]);
    kdb.when.selectOnce('tramites_digitales', [{ modalidad: 'traspaso', estado: 'en_validacion' }]);
    const token = await testToken({ sub: 9, role: 'transito', transitoCodigo: '05001' });
    const app = await buildApp();
    const r = await request(app).delete('/api/tramites/1/documentos/2').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('gestion_cerrada');
  });

  it('éxito → 200 + audit', async () => {
    kdb.when.selectOnce('tramites_documentos', [{ id: 2, tramiteId: 1, tipo: 'factura', originalName: 'f.pdf', filename: 'uploads/tramites/1/factura.pdf' }]);
    kdb.when.selectOnce('tramites_digitales', [{ modalidad: 'matricula_inicial', estado: 'radicado' }]);
    deleteMock.mockReturnValueOnce({
      where: () => ({ returning: () => Promise.resolve([{ id: 2, tipo: 'factura', originalName: 'f.pdf', filename: 'uploads/tramites/1/factura.pdf' }]) }),
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).delete('/api/tramites/1/documentos/2').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(auditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'delete', resource: 'tramite_doc' }),
    );
  });
});

describe('POST /api/tramites/:id/generar-fur', () => {
  it('id inválido → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/0/generar-fur').set('Authorization', `Bearer ${token}`).send({});
    expect(r.status).toBe(400);
  });

  it('no encontrado → 404', async () => {
    kdb.when.selectOnce('tramites_digitales', []);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/999/generar-fur').set('Authorization', `Bearer ${token}`).send({});
    expect(r.status).toBe(404);
  });
});

// TRAM-TRASPASO-F2 — documentos legales (proxy CEA). 400/404 cortocircuitan
// antes de llamar a CEA, así que no requieren mock de red.
describe('POST /api/tramites/:id/generar-contrato', () => {
  it('id inválido → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/0/generar-contrato').set('Authorization', `Bearer ${token}`).send({});
    expect(r.status).toBe(400);
  });

  it('no encontrado → 404', async () => {
    kdb.when.selectOnce('tramites_digitales', []);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/999/generar-contrato').set('Authorization', `Bearer ${token}`).send({});
    expect(r.status).toBe(404);
  });
});

describe('POST /api/tramites/:id/generar-improntas', () => {
  it('id inválido → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/0/generar-improntas').set('Authorization', `Bearer ${token}`).send({});
    expect(r.status).toBe(400);
  });

  it('no encontrado → 404', async () => {
    kdb.when.selectOnce('tramites_digitales', []);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/999/generar-improntas').set('Authorization', `Bearer ${token}`).send({});
    expect(r.status).toBe(404);
  });
});
