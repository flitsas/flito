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

const sendEmailMock = vi.fn().mockResolvedValue({ ok: true, messageId: 'm-001' });
const isSmtpConfiguredMock = vi.fn().mockReturnValue(true);
vi.mock('../../src/services/email.js', () => ({
  sendEmail: sendEmailMock,
  isSmtpConfigured: isSmtpConfiguredMock,
  escapeHtml: (s: string) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)),
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
  sendEmailMock.mockClear().mockResolvedValue({ ok: true, messageId: 'm-001' });
  isSmtpConfiguredMock.mockClear().mockReturnValue(true);
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/drivers/alcohol.routes.js');
  app.use('/api/alcohol', router);
  return app;
}

const adminToken = () => testToken({ sub: 1, role: 'admin' });

describe('alcohol — auth + requirePage(pesv)', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/alcohol');
    expect(r.status).toBe(401);
  });

  it('proveedor sin PESV → 403', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).get('/api/alcohol').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });
});

describe('GET / — listado tests', () => {
  it('admin sin filtros → 200', async () => {
    selectMock.mockReturnValueOnce(chain([
      { id: 1, conductorId: 5, conductorName: 'Juan', resultado: 'negativo' },
    ]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/alcohol').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
  });

  it('filtros conductorId + tipo + resultado + desde + hasta', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/alcohol?conductorId=5&tipo=preoperacional&resultado=negativo&desde=2026-01-01&hasta=2026-12-31')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });
});

describe('GET /:id', () => {
  it('id no numérico → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/alcohol/abc').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('no encontrado → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/alcohol/999').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
  });

  it('encontrado → 200', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, conductorId: 5, valorMg: '0.5' }]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/alcohol/1').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });
});

describe('POST / — crear test (CERO ALCOHOL + alerta PESV)', () => {
  it('proveedor → 403 (admin only)', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).post('/api/alcohol').set('Authorization', `Bearer ${token}`)
      .send({ conductorId: 5, tipo: 'preoperacional', valorMg: 0 });
    expect(r.status).toBe(403);
  });

  it('valorMg > 9.99 → 400 (zod max)', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/alcohol').set('Authorization', `Bearer ${token}`)
      .send({ conductorId: 5, tipo: 'preoperacional', valorMg: 12 });
    expect(r.status).toBe(400);
  });

  it('tipo fuera del enum → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/alcohol').set('Authorization', `Bearer ${token}`)
      .send({ conductorId: 5, tipo: 'inventado', valorMg: 0 });
    expect(r.status).toBe(400);
  });

  it('conductor no existe → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/alcohol').set('Authorization', `Bearer ${token}`)
      .send({ conductorId: 999, tipo: 'preoperacional', valorMg: 0 });
    expect(r.status).toBe(404);
  });

  it('valorMg=0 → resultado=negativo, NO suspende, NO envía alerta', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 5, name: 'Juan', email: 'juan@x.com' }]));
    let updateCalled = false;
    transactionMock.mockImplementationOnce(async (cb) => {
      const tx = {
        insert: vi.fn(() => ({
          values: () => ({ returning: () => Promise.resolve([{ id: 1, resultado: 'negativo' }]) }),
        })),
        update: vi.fn(() => {
          updateCalled = true;
          return { set: () => ({ where: () => Promise.resolve(undefined) }) };
        }),
      };
      return cb(tx);
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/alcohol').set('Authorization', `Bearer ${token}`)
      .send({ conductorId: 5, tipo: 'preoperacional', valorMg: 0 });
    expect(r.status).toBe(201);
    expect(r.body.suspendido).toBe(false);
    expect(updateCalled).toBe(false); // suspensión NO se ejecuta
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('valorMg=0.5 (positivo) → suspende + grado 2 + audit', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 5, name: 'Juan', email: 'juan@x.com' }]));
    let insertValues: any = null;
    let updateValues: any = null;
    transactionMock.mockImplementationOnce(async (cb) => {
      const tx = {
        insert: vi.fn(() => ({
          values: (v: any) => { insertValues = v; return { returning: () => Promise.resolve([{ id: 100, ...v }]) }; },
        })),
        update: vi.fn(() => ({
          set: (v: any) => { updateValues = v; return { where: () => Promise.resolve(undefined) }; },
        })),
      };
      return cb(tx);
    });
    // PESV admins fallback
    selectMock.mockReturnValueOnce(chain([{ email: 'admin@kyverum.com' }]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/alcohol').set('Authorization', `Bearer ${token}`)
      .send({ conductorId: 5, tipo: 'aleatoria', valorMg: 0.5 });
    expect(r.status).toBe(201);
    expect(r.body.suspendido).toBe(true);
    expect(insertValues.resultado).toBe('positivo');
    expect(insertValues.gradoAlcohol).toBe(2); // 0.5 mg/L → grado 2 (Ley 1696)
    expect(updateValues.suspendidoPorAlcohol).toBe(true);
    expect(updateValues.fechaSuspension).toBeInstanceOf(Date);
    expect(updateValues.motivoSuspension).toContain('Alcoholimetría positiva');
    expect(auditMock.mock.calls[0][1].detail).toContain('positivo');
  });

  it('grado de alcohol según Ley 1696/2013', async () => {
    const cases = [
      { valorMg: 0.0, grado: 0 },
      { valorMg: 0.19, grado: 0 },
      { valorMg: 0.20, grado: 1 },
      { valorMg: 0.39, grado: 1 },
      { valorMg: 0.40, grado: 2 },
      { valorMg: 0.79, grado: 2 },
      { valorMg: 0.80, grado: 3 },
      { valorMg: 1.50, grado: 3 },
    ];
    for (const c of cases) {
      selectMock.mockReturnValueOnce(chain([{ id: 5, name: 'Juan', email: 'j@x.com' }]));
      let insertValues: any = null;
      transactionMock.mockImplementationOnce(async (cb) => {
        const tx = {
          insert: vi.fn(() => ({
            values: (v: any) => { insertValues = v; return { returning: () => Promise.resolve([{ id: 1, ...v }]) }; },
          })),
          update: vi.fn(() => ({ set: () => ({ where: () => Promise.resolve(undefined) }) })),
        };
        return cb(tx);
      });
      if (c.valorMg > 0) selectMock.mockReturnValueOnce(chain([])); // fallback admins vacío
      const token = await adminToken();
      const app = await buildApp();
      await request(app).post('/api/alcohol').set('Authorization', `Bearer ${token}`)
        .send({ conductorId: 5, tipo: 'aleatoria', valorMg: c.valorMg });
      expect(insertValues.gradoAlcohol).toBe(c.grado);
    }
  });

  it('positivo + SMTP no configurado → NO envía email (no rompe)', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 5, name: 'Juan', email: 'j@x.com' }]));
    transactionMock.mockImplementationOnce(async (cb) => {
      const tx = {
        insert: vi.fn(() => ({ values: () => ({ returning: () => Promise.resolve([{ id: 1 }]) }) })),
        update: vi.fn(() => ({ set: () => ({ where: () => Promise.resolve(undefined) }) })),
      };
      return cb(tx);
    });
    isSmtpConfiguredMock.mockReturnValueOnce(false);
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/alcohol').set('Authorization', `Bearer ${token}`)
      .send({ conductorId: 5, tipo: 'aleatoria', valorMg: 0.5 });
    expect(r.status).toBe(201);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('positivo + admins activos sin email → recipients vacío, no envía', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 5, name: 'Juan', email: 'j@x.com' }]));
    transactionMock.mockImplementationOnce(async (cb) => {
      const tx = {
        insert: vi.fn(() => ({ values: () => ({ returning: () => Promise.resolve([{ id: 1 }]) }) })),
        update: vi.fn(() => ({ set: () => ({ where: () => Promise.resolve(undefined) }) })),
      };
      return cb(tx);
    });
    selectMock.mockReturnValueOnce(chain([{ email: null }, { email: 'no-arroba' }])); // sin emails válidos
    const token = await adminToken();
    const app = await buildApp();
    await request(app).post('/api/alcohol').set('Authorization', `Bearer ${token}`)
      .send({ conductorId: 5, tipo: 'aleatoria', valorMg: 0.5 });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('alerta PESV con destinatarios incluye nombre + valor + grado en HTML', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 5, name: 'Juan Pérez', email: 'j@x.com' }]));
    transactionMock.mockImplementationOnce(async (cb) => {
      const tx = {
        insert: vi.fn(() => ({ values: () => ({ returning: () => Promise.resolve([{ id: 100 }]) }) })),
        update: vi.fn(() => ({ set: () => ({ where: () => Promise.resolve(undefined) }) })),
      };
      return cb(tx);
    });
    selectMock.mockReturnValueOnce(chain([{ email: 'admin@kyverum.com' }]));
    const token = await adminToken();
    const app = await buildApp();
    await request(app).post('/api/alcohol').set('Authorization', `Bearer ${token}`)
      .send({ conductorId: 5, tipo: 'aleatoria', valorMg: 0.85 });
    // Promise.resolve aún en flight tras res.json — esperar tick
    await new Promise(r => setImmediate(r));
    expect(sendEmailMock).toHaveBeenCalled();
    const call = sendEmailMock.mock.calls[0][0];
    expect(call.to).toEqual(['admin@kyverum.com']);
    expect(call.subject).toContain('Juan Pérez');
    expect(call.html).toContain('Juan Pérez');
    expect(call.html).toContain('0.85 mg/L');
    expect(call.html).toContain('Grado: 3');
  });
});

describe('POST /:id/levantar-suspension', () => {
  it('id no numérico → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/alcohol/abc/levantar-suspension')
      .set('Authorization', `Bearer ${token}`).send({ motivo: 'razón válida' });
    expect(r.status).toBe(400);
  });

  it('motivo < 5 chars → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/alcohol/1/levantar-suspension')
      .set('Authorization', `Bearer ${token}`).send({ motivo: 'no' });
    expect(r.status).toBe(400);
  });

  it('test no existe → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/alcohol/999/levantar-suspension')
      .set('Authorization', `Bearer ${token}`).send({ motivo: 'razón válida aquí' });
    expect(r.status).toBe(404);
  });

  it('conductor no estaba suspendido → 409', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, conductorId: 5 }]));
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/alcohol/1/levantar-suspension')
      .set('Authorization', `Bearer ${token}`).send({ motivo: 'razón válida aquí' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/no estaba suspendido/);
  });

  it('éxito → 200 + audit con detail=levantar_suspension_alcohol', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, conductorId: 5 }]));
    let setValues: any = null;
    updateMock.mockReturnValueOnce({
      set: (v: any) => { setValues = v; return { where: () => ({ returning: () => Promise.resolve([{ userId: 5 }]) }) }; },
    });
    const token = await testToken({ sub: 7, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/alcohol/1/levantar-suspension')
      .set('Authorization', `Bearer ${token}`).send({ motivo: 'falso positivo confirmado' });
    expect(r.status).toBe(200);
    expect(setValues.suspendidoPorAlcohol).toBe(false);
    expect(setValues.suspensionLevantadaPor).toBe(7);
    expect(setValues.motivoSuspension).toContain('falso positivo confirmado');
    expect(setValues.motivoSuspension).toContain('levantada admin');
    expect(auditMock.mock.calls[0][1].detail).toBe('levantar_suspension_alcohol');
  });

  it('proveedor → 403 (admin only)', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).post('/api/alcohol/1/levantar-suspension')
      .set('Authorization', `Bearer ${token}`).send({ motivo: 'razón válida' });
    expect(r.status).toBe(403);
  });
});
