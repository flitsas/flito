// HU #14127 — registro masivo de viajes adicionales sobre varias LT (AC1–AC6).
// Calco de flito-logistica-viajes.routes.test.ts: db/audit/redis/tarifaDe mockeados, permisos por el
// motor real. Cada LT corre por `registrar` (una transacción por LT), no todo-o-nada.
process.env.TZ = 'UTC';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken, type TestRole } from '../helpers/auth.js';

const selectMock = vi.fn();
const transactionMock = vi.fn();
const txSelect = vi.fn();
const txInsert = vi.fn();
const tx = { select: txSelect, insert: txInsert, delete: vi.fn() };

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock, insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: transactionMock,
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/shared/historial/permisos-intentos-denegados.js', () => ({
  registrarIntentoDenegado: vi.fn().mockResolvedValue(undefined), ventanaActual: () => new Date(), VENTANA_DEDUP_MS: 3_600_000,
}));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/modules/flito-parametrizacion/flito-tarifas.service.js', () => ({
  tarifaDe: vi.fn().mockResolvedValue({ valor: 45000, origen: 'generica' }),
}));
// El freno real (10/10 min) se ejercita en su propio test; aquí pasa de largo para no mezclar 429.
vi.mock('../../src/shared/middleware/rateLimiter.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  viajesMasivoLimiter: (_q: unknown, _s: unknown, next: () => void) => next(),
}));
const buscarIdem = vi.fn();
const guardarIdem = vi.fn();
vi.mock('../../src/modules/flito-logistica/flito-logistica.service.js', () => ({
  buscarIdempotencia: buscarIdem, guardarIdempotencia: guardarIdem,
}));

const LT1 = '7d2f4a10-0b1c-4d2e-9f30-a1b2c3d4e5f1';
const LT2 = '7d2f4a10-0b1c-4d2e-9f30-a1b2c3d4e5f2';
const LT3 = '7d2f4a10-0b1c-4d2e-9f30-a1b2c3d4e5f3';
const URL = '/api/flito/logistica/viajes/masivo';
const T0 = new Date('2026-09-16T15:00:00.000Z');
const CTX = (id: string) => ({ id, idFlit: `FLIT-${id.slice(-1)}`, companiaId: 12, logisticaAutogestionable: false, excepcionViva: false });
const CTX_AUTOGESTION = (id: string) => ({ ...CTX(id), logisticaAutogestionable: true });
const fila = (valor: string) => ({
  id: 'c0ffee00-1111-4222-8333-444455556666', numero: 2, modo: 'manual', valor, tarifaVigente: '45000.00',
  motivo: 'devolucion', motivoDetalle: null, registradoPorId: 7, registradoPorNombre: null, registradoEn: T0,
});
const BASE = { motivo: 'devolucion' };

/** Una LT por `registrar`: trámite, liquidación, contexto, MAX, actor + INSERT. */
function armarLt(id: string, o: { liquidada?: boolean; autogestion?: boolean; valor?: string } = {}) {
  txSelect.mockReturnValueOnce(chain([{ id, idFlit: CTX(id).idFlit }]))
    .mockReturnValueOnce(chain(o.liquidada ? [{ id: 'liq' }] : []));
  if (o.liquidada) return;
  txSelect.mockReturnValueOnce(chain([o.autogestion ? CTX_AUTOGESTION(id) : CTX(id)]));
  if (o.autogestion) return;
  txSelect.mockReturnValueOnce(chain([{ siguiente: 2 }])).mockReturnValueOnce(chain([{ name: 'Ana' }]));
  txInsert.mockReturnValueOnce(chain([fila(o.valor ?? '1000.00')]));
}

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-logistica/flito-logistica-viajes.routes.js');
  app.use('/api/flito/logistica', router);
  return app;
}
const auth = async (role: TestRole) => `Bearer ${await testToken({ sub: 7, username: 'u', role })}`;
const post = async (body: unknown, extra: Record<string, string> = {}) =>
  request(await buildApp()).post(URL).set('Authorization', await auth('admin')).set(extra).send(body as object);

beforeEach(() => {
  for (const m of [selectMock, transactionMock, txSelect, txInsert, buscarIdem, guardarIdem]) m.mockReset();
  auditMock.mockClear();
  transactionMock.mockImplementation(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx));
  buscarIdem.mockResolvedValue(null);
});

describe('HU #14127 — registro masivo de viajes adicionales', () => {
  it('AC1 — N LT válidas con su valor → N viajes (uno por LT, con su valor)', async () => {
    armarLt(LT1, { valor: '1000.00' }); armarLt(LT2, { valor: '2500.50' });
    const r = await post({ ...BASE, items: [{ tramiteId: LT1, valor: 1000 }, { tramiteId: LT2, valor: 2500.5 }] });
    expect(r.status).toBe(201);
    expect(r.body.creados).toHaveLength(2);
    expect(r.body.rechazados).toEqual([]);
    expect(txInsert).toHaveBeenCalledTimes(2);
    expect(auditMock).toHaveBeenCalledTimes(2);
  });

  it('AC2 — liquidada y autogestionable se rechazan solas con motivo; las demás se registran', async () => {
    armarLt(LT1, { liquidada: true }); armarLt(LT2, { autogestion: true }); armarLt(LT3);
    const r = await post({ ...BASE, items: [LT1, LT2, LT3].map((tramiteId) => ({ tramiteId, valor: 10 })) });
    expect(r.status).toBe(201);
    expect(r.body.creados).toHaveLength(1);
    expect(r.body.creados[0].tramiteId).toBe(LT3);
    expect(r.body.rechazados.map((x: { tramiteId: string; codigo: string }) => [x.tramiteId, x.codigo])).toEqual([
      [LT1, 'TRAMITE_LIQUIDADO'], [LT2, 'LOGISTICA_AUTOGESTIONADA'],
    ]);
    expect(r.body.rechazados[0].motivo).toMatch(/liquidación/);
  });

  it('AC3 — valor 0 válido; negativo, vacío o no numérico rechazan solo esa LT, sin tocar la base', async () => {
    armarLt(LT1, { valor: '0.00' });
    const r = await post({ ...BASE, items: [
      { tramiteId: LT1, valor: 0 }, { tramiteId: LT2, valor: -5 }, { tramiteId: LT3 },
    ] });
    expect(r.status).toBe(201);
    expect(r.body.creados).toHaveLength(1);
    expect(r.body.rechazados).toHaveLength(2);
    expect(r.body.rechazados.every((x: { codigo: string }) => x.codigo === 'VALOR_INVALIDO')).toBe(true);
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });

  it('AC3 — sin ninguna creada responde 200 con todo rechazado', async () => {
    const r = await post({ ...BASE, items: [{ tramiteId: LT1, valor: 'x' }] });
    expect(r.status).toBe(200);
    expect(r.body.creados).toEqual([]);
    expect(r.body.rechazados).toHaveLength(1);
  });

  it('AC4 — 200 LT pasan; 201 → 400 con mensaje claro y sin tocar la base; vacío → 400', async () => {
    const items = (n: number) => Array.from({ length: n }, () => ({ tramiteId: 'no-uuid', valor: 1 }));
    expect((await post({ ...BASE, items: items(200) })).status).toBe(200);
    const r = await post({ ...BASE, items: items(201) });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/no puede superar 200 LT por operación/);
    expect((await post({ ...BASE, items: [] })).status).toBe(400);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('AC5 — misma Idempotency-Key: devuelve lo guardado y no registra de nuevo', async () => {
    armarLt(LT1);
    const r1 = await post({ ...BASE, items: [{ tramiteId: LT1, valor: 10 }] }, { 'Idempotency-Key': 'k1' });
    expect(r1.status).toBe(201);
    expect(guardarIdem).toHaveBeenCalledWith('viajes-masivo:7:k1', 201, r1.body);
    buscarIdem.mockResolvedValueOnce({ status: 201, body: r1.body });
    const r2 = await post({ ...BASE, items: [{ tramiteId: LT1, valor: 10 }] }, { 'Idempotency-Key': 'k1' });
    expect(r2.status).toBe(201);
    expect(r2.body).toEqual(r1.body);
    expect(txInsert).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledTimes(1);
  });

  it('LT repetida en la misma operación: la segunda se rechaza', async () => {
    armarLt(LT1);
    const r = await post({ ...BASE, items: [{ tramiteId: LT1, valor: 1 }, { tramiteId: LT1, valor: 2 }] });
    expect(r.body.creados).toHaveLength(1);
    expect(r.body.rechazados[0].codigo).toBe('LT_REPETIDA');
  });

  it('motivo «otro» exige detalle; motivo ausente → 400', async () => {
    expect((await post({ motivo: 'otro', items: [{ tramiteId: LT1, valor: 1 }] })).status).toBe(400);
    expect((await post({ items: [{ tramiteId: LT1, valor: 1 }] })).status).toBe(400);
  });

  it('sin token 401; rol sin la función 403 (misma función que el individual)', async () => {
    const app = await buildApp();
    expect((await request(app).post(URL).send({})).status).toBe(401);
    const r = await request(app).post(URL).set('Authorization', await auth('financiera')).send({ ...BASE, items: [{ tramiteId: LT1, valor: 1 }] });
    expect(r.status).toBe(403);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('AC6 — el registro individual sigue igual (201 con su viaje)', async () => {
    txSelect.mockReturnValueOnce(chain([{ id: LT1, idFlit: 'FLIT-1' }])).mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([CTX(LT1)])).mockReturnValueOnce(chain([{ siguiente: 2 }])).mockReturnValueOnce(chain([{ name: 'Ana' }]));
    txInsert.mockReturnValueOnce(chain([fila('45000.00')]));
    const r = await request(await buildApp()).post(`/api/flito/logistica/tramites/${LT1}/viajes`)
      .set('Authorization', await auth('admin')).send({ modo: 'inicial', motivo: 'devolucion' });
    expect(r.status).toBe(201);
    expect(r.body.numero).toBe(2);
  });
});
