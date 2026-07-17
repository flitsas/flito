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

describe('Jornadas · abrir', () => {
  it('POST /abrir sin Idempotency-Key → 400', async () => {
    const r = await request(app).post('/api/jornadas/abrir').set('Authorization', await adminAuth()).send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Idempotency/);
  });

  it('POST /abrir admin OK crea jornada con cálculo de descanso previo', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        select: vi.fn()
          .mockReturnValueOnce(chain([])) // idempotency check vacía
          .mockReturnValueOnce(chain([{ id: 99, finAt: new Date(Date.now() - 10 * 3600_000).toISOString() }])), // last cerrada hace 10h
        insert: vi.fn()
          .mockReturnValueOnce(chain([{ id: 1, conductorId: 2, inicioAt: new Date().toISOString(), cerrada: false, horasDescansoPre: '10.00', optimisticV: 1 }]))
          .mockReturnValueOnce(chain([])), // idempotency keys insert
      };
      return cb(tx);
    });
    const r = await request(app).post('/api/jornadas/abrir')
      .set('Authorization', await adminAuth())
      .set('Idempotency-Key', 'test-key-12345678')
      .send({ conductorId: 2 });
    expect(r.status).toBe(201);
    expect(r.body.id).toBe(1);
    expect(r.body.horasDescansoPre).toBe('10.00');
  });

  it('POST /abrir con Idempotency-Key reusada devuelve la jornada existente (200)', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        select: vi.fn()
          .mockReturnValueOnce(chain([{ key: 'reused-12345', scope: 'open', jornadaId: 50 }]))
          .mockReturnValueOnce(chain([{ id: 50, conductorId: 2, cerrada: false }])),
        insert: vi.fn(),
      };
      return cb(tx);
    });
    const r = await request(app).post('/api/jornadas/abrir')
      .set('Authorization', await adminAuth())
      .set('Idempotency-Key', 'reused-12345')
      .send({ conductorId: 2 });
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(50);
  });

  it('POST /abrir UNIQUE viola → 409 doble jornada abierta', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        select: vi.fn().mockReturnValueOnce(chain([])).mockReturnValueOnce(chain([])),
        insert: vi.fn().mockReturnValueOnce(chainReject(Object.assign(new Error('dup'), { code: '23505' }))),
      };
      return cb(tx);
    });
    const r = await request(app).post('/api/jornadas/abrir')
      .set('Authorization', await adminAuth())
      .set('Idempotency-Key', 'new-test-12345')
      .send({ conductorId: 2 });
    expect(r.status).toBe(409);
  });

  it('POST /abrir con conductorId de otro y rol no admin → 403', async () => {
    const tokenProv = await testToken({ role: 'proveedor', sub: 5 });
    const r = await request(app).post('/api/jornadas/abrir')
      .set('Authorization', `Bearer ${tokenProv}`)
      .set('Idempotency-Key', 'attempt-12345')
      .send({ conductorId: 2 });
    expect(r.status).toBe(403);
  });
});

describe('Jornadas · cerrar', () => {
  it('POST /:id/cerrar OK calcula horas y genera alarmas', async () => {
    const inicioAt = new Date(Date.now() - 11 * 3600_000); // 11h atrás → excede 10h jornada
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        select: vi.fn()
          .mockReturnValueOnce(chain([])) // idempotency
          .mockReturnValueOnce(chain([{ id: 1, conductorId: 1, inicioAt, cerrada: false, optimisticV: 1, horasDescansoPre: '5.00' }])) // FOR UPDATE
          .mockReturnValueOnce(chain([])), // pausas (vacío)
        update: vi.fn()
          .mockReturnValueOnce(chain([])) // cerrar pausa abierta
          .mockReturnValueOnce(chain([{ id: 1, finAt: new Date().toISOString(), inicioAt, cerrada: true, horasConduccion: '11.00', horasDescansoPre: '5.00', optimisticV: 2 }])),
        execute: vi.fn().mockResolvedValueOnce({ rows: [{ horas: 11 }] }), // semana acumulada
        insert: vi.fn()
          .mockReturnValueOnce(chain([])) // alarmas
          .mockReturnValueOnce(chain([])), // idempotency keys
      };
      return cb(tx);
    });
    const r = await request(app).post('/api/jornadas/1/cerrar')
      .set('Authorization', await adminAuth())
      .set('Idempotency-Key', 'close-12345678')
      .send({});
    expect(r.status).toBe(200);
    expect(r.body.cerrada).toBe(true);
    expect(r.body.alarmasGeneradas).toBeGreaterThanOrEqual(1); // al menos mas_10h_jornada
  });

  it('POST /:id/cerrar 409 si ya cerrada', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        select: vi.fn()
          .mockReturnValueOnce(chain([]))
          .mockReturnValueOnce(chain([{ id: 1, cerrada: true, conductorId: 1 }])),
        update: vi.fn(), insert: vi.fn(),
      };
      return cb(tx);
    });
    const r = await request(app).post('/api/jornadas/1/cerrar')
      .set('Authorization', await adminAuth())
      .set('Idempotency-Key', 'close-1235678')
      .send({});
    expect(r.status).toBe(409);
  });

  it('POST /:id/cerrar idempotente con misma key', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        select: vi.fn()
          .mockReturnValueOnce(chain([{ key: 'reused-close-1', scope: 'close', jornadaId: 1 }]))
          .mockReturnValueOnce(chain([{ id: 1, cerrada: true }])),
      };
      return cb(tx);
    });
    const r = await request(app).post('/api/jornadas/1/cerrar')
      .set('Authorization', await adminAuth())
      .set('Idempotency-Key', 'reused-close-1')
      .send({});
    expect(r.status).toBe(200);
  });

  it('POST /:id/cerrar 403 si no es del conductor y no es admin', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        select: vi.fn()
          .mockReturnValueOnce(chain([]))
          .mockReturnValueOnce(chain([{ id: 1, conductorId: 99, cerrada: false }])),
      };
      return cb(tx);
    });
    const tokenProv = await testToken({ role: 'proveedor', sub: 5 });
    const r = await request(app).post('/api/jornadas/1/cerrar')
      .set('Authorization', `Bearer ${tokenProv}`)
      .set('Idempotency-Key', 'unauth-12345')
      .send({});
    expect(r.status).toBe(403);
  });
});

describe('Jornadas · alarmas computarAlarmasCierre (PESV-S2 fix)', () => {
  it('Pausa real Decreto 1079: 30min cada 4h continuas (no 15min cada 2h)', async () => {
    const { computarAlarmasCierre, JORNADA_LIMITS } = await import('../../src/modules/jornadas/limits.js');
    expect(JORNADA_LIMITS.PAUSA_OBLIGATORIA_MIN).toBe(30);
    expect(JORNADA_LIMITS.PAUSA_INTERVALO_HORAS).toBe(4);
    // Jornada 8h con 30min de pausas → cumple la pausa esperada (floor(8/4)*30 = 60min)... falta 30min.
    const a1 = computarAlarmasCierre({ horasConduccion: 8, horasDescansoPre: null, pausasMinTotales: 30 });
    expect(a1.find((x) => x.tipo === 'sin_pausa_obligatoria')?.valorLimite).toBe(60);
    // Jornada 8h con 60min pausa cumple
    const a2 = computarAlarmasCierre({ horasConduccion: 8, horasDescansoPre: null, pausasMinTotales: 60 });
    expect(a2.find((x) => x.tipo === 'sin_pausa_obligatoria')).toBeUndefined();
  });

  it('Alarma >60h semanal se dispara cuando horasSemanaAcumulada > 60', async () => {
    const { computarAlarmasCierre } = await import('../../src/modules/jornadas/limits.js');
    const a = computarAlarmasCierre({ horasConduccion: 9, horasDescansoPre: 10, pausasMinTotales: 60, horasSemanaAcumulada: 65 });
    const semanal = a.find((x) => x.tipo === 'mas_60h_semanal');
    expect(semanal).toBeDefined();
    expect(semanal!.valorObservado).toBe(65);
    expect(semanal!.valorLimite).toBe(60);
  });

  it('Sin horasSemanaAcumulada NO se calcula alarma semanal (backward compat)', async () => {
    const { computarAlarmasCierre } = await import('../../src/modules/jornadas/limits.js');
    const a = computarAlarmasCierre({ horasConduccion: 9, horasDescansoPre: 10, pausasMinTotales: 60 });
    expect(a.find((x) => x.tipo === 'mas_60h_semanal')).toBeUndefined();
  });

  it('MAX_MENSUAL_HORAS=240 (no 300 que era falso negativo)', async () => {
    const { JORNADA_LIMITS } = await import('../../src/modules/jornadas/limits.js');
    expect(JORNADA_LIMITS.MAX_MENSUAL_HORAS).toBe(240);
  });
});

describe('Jornadas · pausas', () => {
  it('POST /:id/pausa/abrir OK', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        select: vi.fn().mockReturnValueOnce(chain([{ id: 1, conductorId: 1, cerrada: false }])),
        insert: vi.fn().mockReturnValueOnce(chain([{ id: 10, jornadaId: 1, motivo: 'descanso', inicioAt: new Date().toISOString() }])),
      };
      return cb(tx);
    });
    const r = await request(app).post('/api/jornadas/1/pausa/abrir').set('Authorization', await adminAuth()).send({ motivo: 'descanso' });
    expect(r.status).toBe(201);
    expect(r.body.motivo).toBe('descanso');
  });

  it('POST /:id/pausa/abrir 409 si ya hay pausa abierta', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        select: vi.fn().mockReturnValueOnce(chain([{ id: 1, conductorId: 1, cerrada: false }])),
        insert: vi.fn().mockReturnValueOnce(chainReject(Object.assign(new Error('dup'), { code: '23505' }))),
      };
      return cb(tx);
    });
    const r = await request(app).post('/api/jornadas/1/pausa/abrir').set('Authorization', await adminAuth()).send({ motivo: 'descanso' });
    expect(r.status).toBe(409);
  });

  it('POST /:id/pausa/cerrar OK', async () => {
    updateMock.mockReturnValueOnce(chain([{ id: 10, finAt: new Date().toISOString() }]));
    const r = await request(app).post('/api/jornadas/1/pausa/cerrar').set('Authorization', await adminAuth()).send({});
    expect(r.status).toBe(200);
  });

  it('POST /:id/pausa/cerrar sin pausa abierta → 404', async () => {
    updateMock.mockReturnValueOnce(chain([]));
    const r = await request(app).post('/api/jornadas/1/pausa/cerrar').set('Authorization', await adminAuth()).send({});
    expect(r.status).toBe(404);
  });
});

describe('Jornadas · ack alarmas (WORM-friendly)', () => {
  it('POST /alarmas/:id/ack OK admin', async () => {
    updateMock.mockReturnValueOnce(chain([{ id: 5, ackBy: 1, ackAt: new Date().toISOString() }]));
    const r = await request(app).post('/api/jornadas/alarmas/5/ack')
      .set('Authorization', await adminAuth())
      .send({ observaciones: 'revisado, conductor justificó retraso' });
    expect(r.status).toBe(200);
  });

  it('POST /alarmas/:id/ack 409 si ya tiene ack', async () => {
    updateMock.mockReturnValueOnce(chain([]));
    const r = await request(app).post('/api/jornadas/alarmas/5/ack').set('Authorization', await adminAuth()).send({});
    expect(r.status).toBe(409);
  });

  it('POST /alarmas/:id/ack proveedor → 403', async () => {
    const tokenProv = await testToken({ role: 'proveedor', sub: 5 });
    const r = await request(app).post('/api/jornadas/alarmas/5/ack').set('Authorization', `Bearer ${tokenProv}`).send({});
    expect(r.status).toBe(403);
  });
});

describe('Jornadas · reportes mensuales', () => {
  it('POST /reporte-mensual/regenerar admin OK con conteos correctos', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        select: vi.fn()
          .mockReturnValueOnce(chain([
            { id: 1, conductorId: 2, cerrada: true, horasConduccion: '8.5' },
            { id: 2, conductorId: 2, cerrada: true, horasConduccion: '9.0' },
          ]))
          .mockReturnValueOnce(chain([{ count: 1 }])),
        delete: vi.fn().mockReturnValueOnce(chain([])),
        insert: vi.fn().mockReturnValueOnce(chain([{
          id: 99, conductorId: 2, anio: 2026, mes: 5, jornadasCount: 2, horasTotales: '17.50', alarmasCount: 1, cumpleNorma: false,
        }])),
      };
      return cb(tx);
    });
    const r = await request(app).post('/api/jornadas/reporte-mensual/regenerar')
      .set('Authorization', await adminAuth())
      .send({ conductorId: 2, anio: 2026, mes: 5 });
    expect(r.status).toBe(201);
    expect(r.body.jornadasCount).toBe(2);
    expect(r.body.alarmasCount).toBe(1);
  });
});
