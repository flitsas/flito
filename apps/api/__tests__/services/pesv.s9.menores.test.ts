import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { chain } from '../helpers/db.js';
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

describe('PESV-S9 · /pesv/raci', () => {
  it('admin lista matriz pivoteada', async () => {
    selectMock.mockReturnValueOnce(chain([
      { id: 1, procesoCodigo: 'S1.5', procesoNombre: 'RACI', rol: 'admin', tipo: 'A' },
      { id: 2, procesoCodigo: 'S1.5', procesoNombre: 'RACI', rol: 'lider_pesv', tipo: 'R' },
    ]));
    const r = await request(app).get('/api/pesv/raci/matriz').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.procesos).toHaveLength(1);
    expect(r.body.celdas['S1.5'].admin).toContain('A');
    expect(r.body.celdas['S1.5'].lider_pesv).toContain('R');
  });

  it('lider_pesv crea asignación → 201', async () => {
    insertMock.mockReturnValueOnce(chain([{ id: 5, procesoCodigo: 'S2.4', rol: 'lider_pesv', tipo: 'R' }]));
    const tok = await testToken({ role: 'lider_pesv', sub: 7 });
    const r = await request(app).post('/api/pesv/raci').set('Authorization', `Bearer ${tok}`)
      .send({ procesoCodigo: 'S2.4', procesoNombre: 'Plan PESV', rol: 'lider_pesv', tipo: 'R' });
    expect(r.status).toBe(201);
  });

  it('duplicado UNIQUE proceso/rol/tipo → 409', async () => {
    const dup = Object.assign(new Error('dup'), { code: '23505' });
    insertMock.mockReturnValueOnce({
      values: () => ({ returning: () => Promise.reject(dup) }),
    });
    const r = await request(app).post('/api/pesv/raci').set('Authorization', await adminAuth())
      .send({ procesoCodigo: 'S1.5', procesoNombre: 'RACI', rol: 'admin', tipo: 'A' });
    expect(r.status).toBe(409);
  });

  it('conductor sin permiso → 403', async () => {
    const tok = await testToken({ role: 'conductor', sub: 9 });
    const r = await request(app).get('/api/pesv/raci/matriz').set('Authorization', `Bearer ${tok}`);
    expect(r.status).toBe(403);
  });

  it('bulk PUT /proceso reescribe asignaciones en transacción', async () => {
    const tx = {
      delete: vi.fn().mockReturnValue({ where: () => Promise.resolve(undefined) }),
      insert: vi.fn().mockReturnValue({ values: () => Promise.resolve(undefined) }),
    };
    transactionMock.mockImplementationOnce(async (cb: any) => cb(tx));
    const r = await request(app).put('/api/pesv/raci/proceso').set('Authorization', await adminAuth())
      .send({
        procesoCodigo: 'S1.5', procesoNombre: 'RACI',
        asignaciones: [{ rol: 'admin', tipos: ['A', 'I'] }, { rol: 'lider_pesv', tipos: ['R'] }],
      });
    expect(r.status).toBe(200);
    expect(tx.delete).toHaveBeenCalled();
    expect(tx.insert).toHaveBeenCalled();
  });
});

describe('PESV-S9 · /pesv/normativa', () => {
  it('admin crea normativa → 201', async () => {
    insertMock.mockReturnValueOnce(chain([{ id: 1, codigo: 'TEST-001-2026', tipo: 'resolucion', titulo: 'Resolución de prueba completa' }]));
    const r = await request(app).post('/api/pesv/normativa').set('Authorization', await adminAuth())
      .send({
        codigo: 'TEST-001-2026', tipo: 'resolucion', titulo: 'Resolución de prueba completa',
        emisor: 'MinTransporte', fechaPublicacion: '2026-01-01',
        proximaRevisionAt: '2026-12-31', aplicaA: ['pesv'],
      });
    expect(r.status).toBe(201);
  });

  it('código duplicado → 409', async () => {
    const dup = Object.assign(new Error('dup'), { code: '23505' });
    insertMock.mockReturnValueOnce({
      values: () => ({ returning: () => Promise.reject(dup) }),
    });
    const r = await request(app).post('/api/pesv/normativa').set('Authorization', await adminAuth())
      .send({ codigo: 'RES-40595-2022', tipo: 'resolucion', titulo: 'duplicada de prueba', emisor: 'MinTransporte', fechaPublicacion: '2026-01-01', proximaRevisionAt: '2026-12-31' });
    expect(r.status).toBe(409);
  });

  it('marcar como revisada en transacción → 200', async () => {
    const tx = {
      select: vi.fn().mockReturnValue(chainFor([{ id: 1, optimisticV: 1 }])),
      insert: vi.fn().mockReturnValue({ values: () => Promise.resolve(undefined) }),
      update: vi.fn().mockReturnValue(chain([{ id: 1, optimisticV: 2, ultimaRevisionAt: new Date().toISOString() }])),
    };
    transactionMock.mockImplementationOnce(async (cb: any) => cb(tx));
    const r = await request(app).post('/api/pesv/normativa/1/revisar').set('Authorization', await adminAuth())
      .send({ proximaRevisionAt: '2027-01-01', cambiosObservados: 'sin cambios' });
    expect(r.status).toBe(200);
    expect(tx.insert).toHaveBeenCalled();
    expect(tx.update).toHaveBeenCalled();
  });

  it('lectura sin filtros → 200 vigentes ordenados por próxima rev', async () => {
    selectMock.mockReturnValueOnce(chain([
      { id: 1, codigo: 'A', proximaRevisionAt: new Date('2026-06-01') },
      { id: 2, codigo: 'B', proximaRevisionAt: new Date('2026-12-01') },
    ]));
    const r = await request(app).get('/api/pesv/normativa').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(2);
  });
});

describe('PESV-S9 · /pesv/retencion', () => {
  it('crea política → 201', async () => {
    insertMock.mockReturnValueOnce(chain([{ id: 1, tipoDocumento: 'foo_bar', retencionAnios: 5, accion: 'archivar_offline' }]));
    const r = await request(app).post('/api/pesv/retencion/politicas').set('Authorization', await adminAuth())
      .send({ tipoDocumento: 'foo_bar', retencionAnios: 5, baseLegal: 'Ley X de prueba', accion: 'archivar_offline' });
    expect(r.status).toBe(201);
  });

  it('tipo_documento mayúsculas → 400 (regex snake_case)', async () => {
    const r = await request(app).post('/api/pesv/retencion/politicas').set('Authorization', await adminAuth())
      .send({ tipoDocumento: 'FooBar', retencionAnios: 5, baseLegal: 'Ley X' });
    expect(r.status).toBe(400);
  });

  it('lider_pesv lista políticas → 200', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, tipoDocumento: 'a', retencionAnios: 1, baseLegal: 'b', accion: 'purgar', habilitado: true }]));
    const tok = await testToken({ role: 'lider_pesv', sub: 5 });
    const r = await request(app).get('/api/pesv/retencion/politicas').set('Authorization', `Bearer ${tok}`);
    expect(r.status).toBe(200);
  });

  it('run dry-run registra log sin tocar datos', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, tipoDocumento: 'audit_log', retencionAnios: 6, accion: 'archivar_offline', habilitado: true }]));
    insertMock.mockReturnValueOnce({ values: () => Promise.resolve(undefined) });
    const r = await request(app).post('/api/pesv/retencion/run').set('Authorization', await adminAuth())
      .send({ tipoDocumento: 'audit_log', confirm: false });
    expect(r.status).toBe(200);
    expect(r.body.modo).toBe('dry-run');
  });

  it('run política deshabilitada → 409', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, tipoDocumento: 'xx', retencionAnios: 1, habilitado: false, accion: 'purgar' }]));
    const r = await request(app).post('/api/pesv/retencion/run').set('Authorization', await adminAuth())
      .send({ tipoDocumento: 'xx', confirm: false });
    expect(r.status).toBe(409);
  });

  it('log read-only ordenado desc', async () => {
    selectMock.mockReturnValueOnce(chain([
      { id: 2, tipoDocumento: 'a', ejecutadoAt: '2026-05-08T03:00:00Z' },
      { id: 1, tipoDocumento: 'a', ejecutadoAt: '2026-05-07T03:00:00Z' },
    ]));
    const r = await request(app).get('/api/pesv/retencion/log').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(2);
  });

  it('sin auth → 401', async () => {
    const r = await request(app).get('/api/pesv/retencion/politicas');
    expect(r.status).toBe(401);
  });
});

// chain() del helper retorna una cadena terminada, pero para `for('update')` necesitamos
// una versión que también soporte limit y for. Aquí un wrapper que termina en limit.
function chainFor(rows: any[]): any {
  return {
    from: () => ({
      where: () => ({
        for: () => ({
          limit: () => Promise.resolve(rows),
        }),
        limit: () => Promise.resolve(rows),
      }),
    }),
  };
}
