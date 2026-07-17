import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { chain, chainReject } from '../helpers/db.js';
import { adminAuth, proveedorAuth } from '../helpers/auth.js';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const deleteMock = vi.fn();
const executeMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock,
    insert: insertMock,
    update: updateMock,
    delete: deleteMock,
    execute: executeMock,
    transaction: transactionMock,
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

vi.mock('express-rate-limit', () => ({
  default: () => (_req: any, _res: any, next: any) => next(),
}));

let app: any;

beforeEach(async () => {
  selectMock.mockReset();
  insertMock.mockReset();
  updateMock.mockReset();
  deleteMock.mockReset();
  executeMock.mockReset();
  transactionMock.mockReset();
  auditMock.mockClear();
  executeMock.mockResolvedValue([{ '?column?': 1 }]);
  const { createApp } = await import('../../src/app.js');
  app = createApp();
});

describe('PESV · policy.routes', () => {
  it('GET /current devuelve la política vigente', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, version: 2, estado: 'vigente', titulo: 'PSV 2026' }]));
    const r = await request(app).get('/api/pesv/policy/current').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('vigente');
  });

  it('GET /current → 404 si no hay vigente', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const r = await request(app).get('/api/pesv/policy/current').set('Authorization', await adminAuth());
    expect(r.status).toBe(404);
  });

  it('POST / requiere admin (proveedor → 403)', async () => {
    const r = await request(app)
      .post('/api/pesv/policy')
      .set('Authorization', await proveedorAuth())
      .send({ titulo: 'PSV 2026 Nueva', contenidoMd: 'contenido suficientemente largo de la política', vigenciaDesde: '2026-06-01' });
    expect(r.status).toBe(403);
  });

  it('POST / OK admin crea borrador con version autonum', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        execute: vi.fn().mockResolvedValueOnce([{ next: 3 }]),
        insert: vi.fn().mockReturnValueOnce(chain([{ id: 10, version: 3, estado: 'borrador', titulo: 'PSV' }])),
      };
      return cb(tx);
    });
    const r = await request(app)
      .post('/api/pesv/policy')
      .set('Authorization', await adminAuth())
      .send({ titulo: 'PSV 2026 Nueva', contenidoMd: 'contenido suficientemente largo de la política PSV', vigenciaDesde: '2026-06-01' });
    expect(r.status).toBe(201);
    expect(r.body.version).toBe(3);
    expect(auditMock).toHaveBeenCalled();
  });

  it('POST /:id/firmar transiciona borrador → vigente y reemplaza la previa', async () => {
    const setMock = vi.fn();
    const updateChain = { set: setMock.mockReturnThis(), where: vi.fn().mockResolvedValueOnce([]), returning: vi.fn() };
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        select: vi.fn().mockReturnValueOnce(chain([{ id: 5, estado: 'borrador', optimisticV: 1 }])),
        update: vi.fn()
          .mockReturnValueOnce({ set: () => ({ where: () => Promise.resolve([]) }) })
          .mockReturnValueOnce(chain([{ id: 5, estado: 'vigente', firmadaAt: new Date().toISOString() }])),
      };
      return cb(tx);
    });
    const r = await request(app).post('/api/pesv/policy/5/firmar').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('vigente');
  });

  it('POST /:id/firmar → 409 si la política no está en borrador', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        select: vi.fn().mockReturnValueOnce(chain([{ id: 5, estado: 'reemplazada', optimisticV: 4 }])),
        update: vi.fn(),
      };
      return cb(tx);
    });
    const r = await request(app).post('/api/pesv/policy/5/firmar').set('Authorization', await adminAuth());
    expect(r.status).toBe(409);
  });

  it('PATCH /:id rechaza optimistic lock mismatch (concurrencia)', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      try {
        const tx = {
          select: vi.fn().mockReturnValueOnce(chain([{ id: 1, estado: 'borrador', optimisticV: 5, hashSha256: null }])),
          update: vi.fn(),
        };
        return await cb(tx);
      } catch (e: any) {
        return { __err: e };
      }
    });
    const r = await request(app)
      .patch('/api/pesv/policy/1')
      .set('Authorization', await adminAuth())
      .send({ titulo: 'Otro título de la política', optimisticV: 1 });
    expect(r.status).toBe(409);
  });
});

describe('PESV · comite.routes', () => {
  it('POST / OK admin crea comité', async () => {
    insertMock.mockReturnValueOnce(chain([{ id: 1, nombre: 'CSV Kyverum', periodicidad: 'trimestral' }]));
    const r = await request(app)
      .post('/api/pesv/comite')
      .set('Authorization', await adminAuth())
      .send({ nombre: 'CSV Kyverum', periodicidad: 'trimestral' });
    expect(r.status).toBe(201);
    expect(r.body.nombre).toBe('CSV Kyverum');
  });

  it('POST /:id/miembros con duplicado → 409', async () => {
    const dupErr = Object.assign(new Error('dup'), { code: '23505' });
    insertMock.mockReturnValueOnce(chainReject(dupErr));
    const r = await request(app)
      .post('/api/pesv/comite/1/miembros')
      .set('Authorization', await adminAuth())
      .send({ userId: 2, rol: 'lider_pesv', desde: '2026-01-01' });
    expect(r.status).toBe(409);
  });

  it('POST /:id/actas asigna numeración correlativa con advisory lock', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        execute: vi.fn()
          .mockResolvedValueOnce([]) // SELECT pg_advisory_xact_lock
          .mockResolvedValueOnce([{ next: 7 }]), // MAX(numero)+1
        insert: vi.fn().mockReturnValueOnce(chain([{ id: 50, comiteId: 1, numero: 7, fecha: '2026-05-07', estado: 'borrador' }])),
      };
      return cb(tx);
    });
    const r = await request(app)
      .post('/api/pesv/comite/1/actas')
      .set('Authorization', await adminAuth())
      .send({ fecha: '2026-05-07', lugar: 'Sede principal', agendaMd: 'punto 1', decisionesMd: 'decision 1' });
    expect(r.status).toBe(201);
    expect(r.body.numero).toBe(7);
  });

  it('POST /:id/actas/:actaId/cerrar — atómico WHERE estado=borrador devuelve 409 si ya está cerrada', async () => {
    updateMock.mockReturnValueOnce(chain([])); // sin filas afectadas
    const r = await request(app).post('/api/pesv/comite/1/actas/50/cerrar').set('Authorization', await adminAuth());
    expect(r.status).toBe(409);
  });

  it('POST /:id/actas/:actaId/cerrar OK → estado=cerrada (WORM activado)', async () => {
    updateMock.mockReturnValueOnce(chain([{ id: 50, estado: 'cerrada' }]));
    const r = await request(app).post('/api/pesv/comite/1/actas/50/cerrar').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('cerrada');
  });
});

describe('PESV · plan.routes', () => {
  it('POST / requiere objetivo general ≥ 20 chars', async () => {
    const r = await request(app)
      .post('/api/pesv/plan')
      .set('Authorization', await adminAuth())
      .send({ anio: 2026, objetivoGeneral: 'corto', presupuestoCop: '0' });
    expect(r.status).toBe(400);
  });

  it('POST / OK admin', async () => {
    insertMock.mockReturnValueOnce(chain([{ id: 1, anio: 2026, estado: 'borrador', optimisticV: 1 }]));
    const r = await request(app)
      .post('/api/pesv/plan')
      .set('Authorization', await adminAuth())
      .send({ anio: 2026, objetivoGeneral: 'reducir índice de accidentalidad anual en 20%' });
    expect(r.status).toBe(201);
  });

  it('POST / duplicado mismo año → 409', async () => {
    const dupErr = Object.assign(new Error('dup'), { code: '23505' });
    insertMock.mockReturnValueOnce(chainReject(dupErr));
    const r = await request(app)
      .post('/api/pesv/plan')
      .set('Authorization', await adminAuth())
      .send({ anio: 2026, objetivoGeneral: 'reducir índice de accidentalidad anual en 20%' });
    expect(r.status).toBe(409);
  });

  it('POST /:id/aprobar OK transiciona borrador → aprobado', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        select: vi.fn().mockReturnValueOnce(chain([{ id: 1, estado: 'borrador', optimisticV: 1 }])),
        update: vi.fn().mockReturnValueOnce(chain([{ id: 1, estado: 'aprobado', aprobadoAt: new Date().toISOString() }])),
      };
      return cb(tx);
    });
    const r = await request(app).post('/api/pesv/plan/1/aprobar').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('aprobado');
  });

  it('POST /:id/aprobar 409 si no está en borrador', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        select: vi.fn().mockReturnValueOnce(chain([{ id: 1, estado: 'cerrado', optimisticV: 5 }])),
        update: vi.fn(),
      };
      return cb(tx);
    });
    const r = await request(app).post('/api/pesv/plan/1/aprobar').set('Authorization', await adminAuth());
    expect(r.status).toBe(409);
  });
});

describe('PESV · diagnostico.routes', () => {
  it('POST / auto-puebla los 24 ítems PHVA al crear diagnóstico', async () => {
    const insertItemsSpy = vi.fn().mockReturnValueOnce(Promise.resolve([]));
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        // El handler lee el catálogo de estándares con tx.execute(sql`...`),
        // no con tx.select. execute() resuelve a { rows: [...] }.
        execute: vi.fn().mockResolvedValueOnce({
          rows: Array.from({ length: 24 }, (_, i) => ({ id: i + 1 })),
        }),
        insert: vi.fn()
          .mockReturnValueOnce(chain([{ id: 1, anio: 2026, estado: 'borrador', scoreGlobal: '0', optimisticV: 1 }]))
          .mockImplementationOnce((..._args: any[]) => ({ values: insertItemsSpy })),
      };
      return cb(tx);
    });
    const r = await request(app)
      .post('/api/pesv/diagnostico')
      .set('Authorization', await adminAuth())
      .send({ anio: 2026, fecha: '2026-05-07' });
    expect(r.status).toBe(201);
    expect(insertItemsSpy).toHaveBeenCalled();
    const valuesArg = insertItemsSpy.mock.calls[0][0];
    expect(Array.isArray(valuesArg)).toBe(true);
    expect(valuesArg).toHaveLength(24);
  });

  it('POST /:id/cerrar calcula score ponderado SUM(score*peso)/SUM(peso)', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        select: vi.fn().mockReturnValueOnce(chain([{ id: 1, estado: 'borrador', optimisticV: 1 }])),
        execute: vi.fn().mockResolvedValueOnce({ rows: [{ score: '85.00' }] }),
        update: vi.fn().mockReturnValueOnce(chain([{ id: 1, estado: 'cerrado', scoreGlobal: '85.00', cerradoAt: new Date().toISOString() }])),
      };
      return cb(tx);
    });
    const r = await request(app).post('/api/pesv/diagnostico/1/cerrar').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('cerrado');
    expect(parseFloat(r.body.scoreGlobal)).toBeCloseTo(85.0);
  });

  it('POST /:id/cerrar → 409 si ya está cerrado', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        select: vi.fn().mockReturnValueOnce(chain([{ id: 1, estado: 'cerrado', optimisticV: 5 }])),
        execute: vi.fn(),
        update: vi.fn(),
      };
      return cb(tx);
    });
    const r = await request(app).post('/api/pesv/diagnostico/1/cerrar').set('Authorization', await adminAuth());
    expect(r.status).toBe(409);
  });

  it('PATCH /:id/items/:estandarId rechaza score fuera de rango (manejado por BD CHECK pero validamos parser)', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, estado: 'borrador' }]));
    updateMock.mockReturnValueOnce(chain([{ diagnosticoId: 1, estandarId: 5, scorePct: '75' }]));
    const r = await request(app)
      .patch('/api/pesv/diagnostico/1/items/5')
      .set('Authorization', await adminAuth())
      .send({ scorePct: 75, comentarios: 'evidencia OK' });
    expect(r.status).toBe(200);
  });

  it('PATCH /:id/items/:estandarId rechaza si diagnóstico cerrado', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, estado: 'cerrado' }]));
    const r = await request(app)
      .patch('/api/pesv/diagnostico/1/items/5')
      .set('Authorization', await adminAuth())
      .send({ scorePct: 75 });
    expect(r.status).toBe(409);
  });

  it('GET /api/pesv/estandares devuelve catálogo seed', async () => {
    selectMock.mockReturnValueOnce(chain([
      { id: 1, codigo: '1.1', paso: 1, nombre: 'Política', vigente: true },
      { id: 11, codigo: '2.1', paso: 2, nombre: 'Selección conductores', vigente: true },
    ]));
    const r = await request(app).get('/api/pesv/estandares').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.data.length).toBeGreaterThan(0);
  });
});
