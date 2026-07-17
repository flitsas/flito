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
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('express-rate-limit', () => ({ default: () => (_req: any, _res: any, next: any) => next() }));

let app: any;
beforeEach(async () => {
  selectMock.mockReset(); insertMock.mockReset(); updateMock.mockReset();
  deleteMock.mockReset(); executeMock.mockReset(); transactionMock.mockReset();
  executeMock.mockResolvedValue([{ '?column?': 1 }]);
  const { createApp } = await import('../../src/app.js');
  app = createApp();
});

describe('PESV-S6 · /pesv/auditorias', () => {
  it('lider_pesv crea auditoría → 201', async () => {
    insertMock.mockReturnValueOnce(chain([{ id: 1, anio: 2026, tipo: 'interna', estado: 'planificada' }]));
    const tok = await testToken({ role: 'lider_pesv', sub: 5 });
    const r = await request(app).post('/api/pesv/auditorias').set('Authorization', `Bearer ${tok}`)
      .send({ anio: 2026, tipo: 'interna', alcance: 'Auditoría interna anual PESV cubriendo los 24 pasos PHVA', fechaPlanificada: '2026-12-15' });
    expect(r.status).toBe(201);
  });

  it('proveedor → 403', async () => {
    const tok = await testToken({ role: 'proveedor', sub: 6 });
    const r = await request(app).post('/api/pesv/auditorias').set('Authorization', `Bearer ${tok}`).send({});
    expect(r.status).toBe(403);
  });

  it('cerrar auditoría → atómico WHERE estado != cerrada', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        select: vi.fn().mockReturnValueOnce(chain([{ id: 1, estado: 'en_curso', optimisticV: 1 }])),
        update: vi.fn().mockReturnValueOnce(chain([{ id: 1, estado: 'cerrada' }])),
      };
      return cb(tx);
    });
    const r = await request(app).post('/api/pesv/auditorias/1/cerrar').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('cerrada');
  });

  it('hallazgo crear con severidad y descripcion', async () => {
    insertMock.mockReturnValueOnce(chain([{ id: 10, severidad: 'critico', estado: 'abierto' }]));
    const r = await request(app).post('/api/pesv/auditorias/1/hallazgos').set('Authorization', await adminAuth())
      .send({ severidad: 'critico', descripcion: 'No hay política firmada por el representante legal — Paso 3' });
    expect(r.status).toBe(201);
  });

  it('cerrar hallazgo abierto → 200', async () => {
    updateMock.mockReturnValueOnce(chain([{ id: 10, estado: 'cerrado' }]));
    const r = await request(app).post('/api/pesv/hallazgos/10/cerrar').set('Authorization', await adminAuth())
      .send({ cierreObservaciones: 'Política firmada el 2026-12-20 vía firma electrónica Ley 527' });
    expect(r.status).toBe(200);
  });

  it('cerrar hallazgo ya cerrado → 409', async () => {
    updateMock.mockReturnValueOnce(chain([]));
    const r = await request(app).post('/api/pesv/hallazgos/10/cerrar').set('Authorization', await adminAuth()).send({});
    expect(r.status).toBe(409);
  });
});

describe('PESV-S6 · /pesv/comunicaciones', () => {
  it('crear y publicar comunicación', async () => {
    insertMock.mockReturnValueOnce(chain([{ id: 1, tipo: 'politica', publicadoAt: null }]));
    const rCreate = await request(app).post('/api/pesv/comunicaciones').set('Authorization', await adminAuth())
      .send({ tipo: 'politica', asunto: 'Nueva política PESV 2026', cuerpoMd: 'Se publica nueva versión vigente desde junio 2026' });
    expect(rCreate.status).toBe(201);

    updateMock.mockReturnValueOnce(chain([{ id: 1, publicadoAt: new Date().toISOString() }]));
    const rPub = await request(app).post('/api/pesv/comunicaciones/1/publicar').set('Authorization', await adminAuth());
    expect(rPub.status).toBe(200);
  });

  it('acuse de recibo idempotente — 2do POST no duplica', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        insert: vi.fn().mockReturnValueOnce(chainReject(Object.assign(new Error('dup'), { code: '23505' }))),
        update: vi.fn(),
      };
      return cb(tx);
    });
    const r = await request(app).post('/api/pesv/comunicaciones/1/acusar').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.alreadyAcknowledged).toBe(true);
  });

  it('acuse a comunicación inexistente → 404', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        insert: vi.fn().mockReturnValueOnce(chainReject(Object.assign(new Error('fk'), { code: '23503' }))),
        update: vi.fn(),
      };
      return cb(tx);
    });
    const r = await request(app).post('/api/pesv/comunicaciones/9999/acusar').set('Authorization', await adminAuth());
    expect(r.status).toBe(404);
  });
});

describe('PESV-S6 · /pesv/contratistas', () => {
  it('crear contratista admin OK', async () => {
    insertMock.mockReturnValueOnce(chain([{ id: 1, razonSocial: 'Transcarga SAS', nit: '900111222' }]));
    const r = await request(app).post('/api/pesv/contratistas').set('Authorization', await adminAuth())
      .send({ razonSocial: 'Transcarga SAS', nit: '900111222', evaluacion: 'apto', pesvNivel: 'estandar' });
    expect(r.status).toBe(201);
  });

  it('NIT duplicado → 409', async () => {
    insertMock.mockReturnValueOnce(chainReject(Object.assign(new Error('dup'), { code: '23505' })));
    const r = await request(app).post('/api/pesv/contratistas').set('Authorization', await adminAuth())
      .send({ razonSocial: 'Transcarga DUP', nit: '900111222' });
    expect(r.status).toBe(409);
  });

  it('email contacto inválido → 400', async () => {
    const r = await request(app).post('/api/pesv/contratistas').set('Authorization', await adminAuth())
      .send({ razonSocial: 'X', nit: '900111223', contactoEmail: 'no-es-email' });
    expect(r.status).toBe(400);
  });
});

describe('PESV-S6 · /incidents/:id/causa-raiz', () => {
  it('PATCH causa raíz con metodología 5_porques', async () => {
    updateMock.mockReturnValueOnce(chain([{
      id: 1, causaRaizMetodo: '5_porques',
      causaRaizJsonb: { porques: ['exceso velocidad', 'fatiga conductor', 'turno largo', 'sin pausas', 'planificación deficiente'] },
    }]));
    const r = await request(app).patch('/api/pesv/incidents/1/causa-raiz').set('Authorization', await adminAuth())
      .send({
        metodo: '5_porques',
        jsonb: { porques: ['exceso velocidad', 'fatiga conductor', 'turno largo', 'sin pausas', 'planificación deficiente'] },
        cerrarInvestigacion: false,
      });
    expect(r.status).toBe(200);
    expect(r.body.causaRaizMetodo).toBe('5_porques');
  });

  it('supervisor_flota puede registrar causa raíz', async () => {
    updateMock.mockReturnValueOnce(chain([{ id: 1, causaRaizMetodo: 'ishikawa' }]));
    const tok = await testToken({ role: 'supervisor_flota', sub: 8 });
    const r = await request(app).patch('/api/pesv/incidents/1/causa-raiz').set('Authorization', `Bearer ${tok}`)
      .send({ metodo: 'ishikawa', jsonb: { categorias: { humano: ['fatiga'], vehiculo: [], via: [], entorno: [] } } });
    expect(r.status).toBe(200);
  });

  it('proveedor → 403', async () => {
    const tok = await testToken({ role: 'proveedor', sub: 6 });
    const r = await request(app).patch('/api/pesv/incidents/1/causa-raiz').set('Authorization', `Bearer ${tok}`).send({ metodo: '5_porques', jsonb: {} });
    expect(r.status).toBe(403);
  });
});

describe('PESV-S6 · /privacy/pii-access-log (Ley 1581)', () => {
  it('admin lista log con paginación', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, userId: 5, resourceTipo: 'driver_profile', accion: 'decrypt', camposAccedidos: ['cedula'] }]));
    selectMock.mockReturnValueOnce(chain([{ count: 1 }]));
    const r = await request(app).get('/api/privacy/pii-access-log').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(1);
  });

  it('compliance también puede ver', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    selectMock.mockReturnValueOnce(chain([{ count: 0 }]));
    const tok = await testToken({ role: 'compliance', sub: 9 });
    const r = await request(app).get('/api/privacy/pii-access-log').set('Authorization', `Bearer ${tok}`);
    expect(r.status).toBe(200);
  });

  it('proveedor → 403', async () => {
    const tok = await testToken({ role: 'proveedor', sub: 6 });
    const r = await request(app).get('/api/privacy/pii-access-log').set('Authorization', `Bearer ${tok}`);
    expect(r.status).toBe(403);
  });

  it('GET /stats devuelve agregados últimos 30 días', async () => {
    executeMock.mockResolvedValueOnce({ rows: [{ user_id: 5, user_role: 'admin', accesos: 12 }] });
    executeMock.mockResolvedValueOnce({ rows: [{ resource_tipo: 'driver_profile', accion: 'decrypt', accesos: 12 }] });
    const r = await request(app).get('/api/privacy/pii-access-log/stats').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.porUsuario.length).toBe(1);
    expect(r.body.porRecurso.length).toBe(1);
  });
});
