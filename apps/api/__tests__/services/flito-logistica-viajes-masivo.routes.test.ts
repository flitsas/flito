// HU #14127 — registro masivo de viajes adicionales sobre varias LT (AC1–AC6), identificadas por la PLACA
// del vehículo (ADR-0030 §17.2): 1 trámite aprobado → se usa; 0 → NO_ENCONTRADO; varios → VARIOS_TRAMITES_APROBADOS.
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
// Alcance por compañía: por defecto pasa de largo (admin); cada test restringe con `ajenos`.
const ajenos = new Set<string>();
vi.mock('../../src/modules/flito-logistica/flito-logistica.alcance.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  enAlcanceLogistica: async (_t: string, id: string) => !ajenos.has(id),
}));
const buscarIdem = vi.fn();
const guardarIdem = vi.fn();
vi.mock('../../src/modules/flito-logistica/flito-logistica.service.js', () => ({
  buscarIdempotencia: buscarIdem, guardarIdempotencia: guardarIdem,
}));

const LT1 = '7d2f4a10-0b1c-4d2e-9f30-a1b2c3d4e5f1';
const LT2 = '7d2f4a10-0b1c-4d2e-9f30-a1b2c3d4e5f2';
const LT3 = '7d2f4a10-0b1c-4d2e-9f30-a1b2c3d4e5f3';
const P1 = 'ABC123'; const P2 = 'DEF456'; const P3 = 'GHI789';
const URL = '/api/flito/logistica/viajes/masivo';
const T0 = new Date('2026-09-16T15:00:00.000Z');
const CTX = (id: string) => ({ id, idFlit: `FLIT-${id.slice(-1)}`, companiaId: 12, logisticaAutogestionable: false, excepcionViva: false });
const CTX_AUTOGESTION = (id: string) => ({ ...CTX(id), logisticaAutogestionable: true });
const fila = (valor: string) => ({
  id: 'c0ffee00-1111-4222-8333-444455556666', numero: 2, modo: 'manual', valor, tarifaVigente: '45000.00',
  motivo: 'devolucion', motivoDetalle: null, registradoPorId: 7, registradoPorNombre: null, registradoEn: T0,
});
const BASE = { motivo: 'devolucion' };

/** Candidatos aprobados que devuelve la búsqueda por placa (un `db.select` por ítem). */
const candidatos = (...ids: string[]) => selectMock.mockReturnValueOnce(chain(ids.map((id) => ({ tramiteId: id, idFlit: CTX(id).idFlit }))));

/** Elegibilidad previa (con `db`): liquidación y contexto del trámite; luego, si es elegible, `registrar` (tx). */
function elegibilidad(id: string, o: { liquidada?: boolean; autogestion?: boolean } = {}) {
  selectMock.mockReturnValueOnce(chain(o.liquidada ? [{ id: 'liq' }] : []));
  if (o.liquidada) return;
  selectMock.mockReturnValueOnce(chain([o.autogestion ? CTX_AUTOGESTION(id) : CTX(id)]));
}

/** Una LT por `registrar`: aprobados + elegibilidad previa; si es elegible, trámite, liquidación, contexto, MAX, actor + INSERT. */
function armarLt(id: string, o: { liquidada?: boolean; autogestion?: boolean; valor?: string } = {}) {
  candidatos(id);
  elegibilidad(id, o);
  if (o.liquidada || o.autogestion) return;
  txSelect.mockReturnValueOnce(chain([{ id, idFlit: CTX(id).idFlit }])).mockReturnValueOnce(chain([]))
    .mockReturnValueOnce(chain([CTX(id)]))
    .mockReturnValueOnce(chain([{ siguiente: 2 }])).mockReturnValueOnce(chain([{ name: 'Ana' }]));
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
  auditMock.mockClear(); ajenos.clear();
  transactionMock.mockImplementation(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx));
  buscarIdem.mockResolvedValue(null);
});

describe('HU #14127 — registro masivo de viajes adicionales', () => {
  it('AC1 — N LT válidas con su valor → N viajes (uno por LT, con su valor)', async () => {
    armarLt(LT1, { valor: '1000.00' }); armarLt(LT2, { valor: '2500.50' });
    const r = await post({ ...BASE, items: [{ placa: P1, valor: 1000 }, { placa: P2, valor: 2500.5 }] });
    expect(r.status).toBe(201);
    expect(r.body.creados).toHaveLength(2);
    expect(r.body.rechazados).toEqual([]);
    expect(txInsert).toHaveBeenCalledTimes(2);
    expect(auditMock).toHaveBeenCalledTimes(2);
  });

  it('AC2 — liquidada y autogestionable se rechazan solas con motivo; las demás se registran', async () => {
    armarLt(LT1, { liquidada: true }); armarLt(LT2, { autogestion: true }); armarLt(LT3);
    const r = await post({ ...BASE, items: [P1, P2, P3].map((placa) => ({ placa, valor: 10 })) });
    expect(r.status).toBe(201);
    expect(r.body.creados).toHaveLength(1);
    expect(r.body.creados[0]).toMatchObject({ placa: P3, tramiteId: LT3 });
    expect(r.body.rechazados.map((x: { placa: string; codigo: string }) => [x.placa, x.codigo])).toEqual([
      [P1, 'TRAMITE_LIQUIDADO'], [P2, 'LOGISTICA_AUTOGESTIONADA'],
    ]);
    expect(r.body.rechazados[0].motivo).toMatch(/liquidación/);
  });

  it('AC3 — valor 0 válido; negativo, vacío o no numérico rechazan solo esa LT, sin tocar la base', async () => {
    armarLt(LT1, { valor: '0.00' });
    const r = await post({ ...BASE, items: [
      { placa: P1, valor: 0 }, { placa: P2, valor: -5 }, { placa: P3 },
    ] });
    expect(r.status).toBe(201);
    expect(r.body.creados).toHaveLength(1);
    expect(r.body.rechazados).toHaveLength(2);
    expect(r.body.rechazados.every((x: { codigo: string }) => x.codigo === 'VALOR_INVALIDO')).toBe(true);
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });

  it('AC3 — sin ninguna creada responde 200 con todo rechazado', async () => {
    const r = await post({ ...BASE, items: [{ placa: P1, valor: 'x' }] });
    expect(r.status).toBe(200);
    expect(r.body.creados).toEqual([]);
    expect(r.body.rechazados).toHaveLength(1);
  });

  it('AC4 — 200 LT pasan; 201 → 400 con mensaje claro y sin tocar la base; vacío → 400', async () => {
    // valor 'x' → rechazo de entrada, sin tocar la base
    const items = (n: number) => Array.from({ length: n }, (_, i) => ({ placa: `P${i}`, valor: 'x' }));
    expect((await post({ ...BASE, items: items(200) })).status).toBe(200);
    const r = await post({ ...BASE, items: items(201) });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/no puede superar 200 LT por operación/);
    expect((await post({ ...BASE, items: [] })).status).toBe(400);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('AC5 — misma Idempotency-Key: devuelve lo guardado y no registra de nuevo', async () => {
    armarLt(LT1);
    const r1 = await post({ ...BASE, items: [{ placa: P1, valor: 10 }] }, { 'Idempotency-Key': 'k1' });
    expect(r1.status).toBe(201);
    expect(guardarIdem).toHaveBeenCalledWith('viajes-masivo:7:k1', 201, r1.body);
    buscarIdem.mockResolvedValueOnce({ status: 201, body: r1.body });
    const r2 = await post({ ...BASE, items: [{ placa: P1, valor: 10 }] }, { 'Idempotency-Key': 'k1' });
    expect(r2.status).toBe(201);
    expect(r2.body).toEqual(r1.body);
    expect(txInsert).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledTimes(1);
  });

  it('Placa repetida en la misma operación (también con otro formato): la segunda se rechaza', async () => {
    armarLt(LT1);
    const r = await post({ ...BASE, items: [{ placa: P1, valor: 1 }, { placa: 'abc-123', valor: 2 }] });
    expect(r.body.creados).toHaveLength(1);
    expect(r.body.rechazados[0].codigo).toBe('PLACA_REPETIDA');
  });

  it('Vehículo inexistente o sin trámite aprobado → NO_ENCONTRADO; sin crear nada', async () => {
    candidatos();
    const r = await post({ ...BASE, items: [{ placa: P1, valor: 10 }] });
    expect(r.status).toBe(200);
    expect(r.body.rechazados).toEqual([expect.objectContaining({ placa: P1, codigo: 'NO_ENCONTRADO' })]);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('Varios trámites aprobados → VARIOS_TRAMITES_APROBADOS con candidatos (id + idFlit); las demás pasan; nunca crea pendientes', async () => {
    candidatos(LT1, LT2); elegibilidad(LT1); elegibilidad(LT2);
    armarLt(LT3);
    const r = await post({ ...BASE, items: [{ placa: P1, valor: 10 }, { placa: P3, valor: 10 }] });
    expect(r.status).toBe(201);
    expect(r.body.creados).toHaveLength(1);
    expect(r.body.rechazados).toEqual([{
      placa: P1, codigo: 'VARIOS_TRAMITES_APROBADOS', motivo: expect.any(String),
      candidatos: [{ tramiteId: LT1, idFlit: 'FLIT-1' }, { tramiteId: LT2, idFlit: 'FLIT-2' }],
    }]);
    expect(txInsert).toHaveBeenCalledTimes(1);
  });

  it('Varios aprobados con uno liquidado → el elegible pasa (no es VARIOS)', async () => {
    candidatos(LT1, LT2); elegibilidad(LT1, { liquidada: true }); elegibilidad(LT2);
    txSelect.mockReturnValueOnce(chain([{ id: LT2, idFlit: CTX(LT2).idFlit }])).mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([CTX(LT2)])).mockReturnValueOnce(chain([{ siguiente: 2 }])).mockReturnValueOnce(chain([{ name: 'Ana' }]));
    txInsert.mockReturnValueOnce(chain([fila('10.00')]));
    const r = await post({ ...BASE, items: [{ placa: P1, valor: 10 }] });
    expect(r.body.rechazados).toEqual([]);
    expect(r.body.creados).toEqual([expect.objectContaining({ placa: P1, tramiteId: LT2 })]);
  });

  it('Varios aprobados, solo los elegibles son candidatos (el autogestionado no aparece)', async () => {
    candidatos(LT1, LT2, LT3); elegibilidad(LT1); elegibilidad(LT2, { autogestion: true }); elegibilidad(LT3);
    const r = await post({ ...BASE, items: [{ placa: P1, valor: 10 }] });
    expect(r.body.rechazados[0]).toMatchObject({ codigo: 'VARIOS_TRAMITES_APROBADOS' });
    expect(r.body.rechazados[0].candidatos.map((c: { tramiteId: string }) => c.tramiteId)).toEqual([LT1, LT3]);
  });

  it('Varios aprobados y ninguno elegible → NO_ENCONTRADO', async () => {
    candidatos(LT1, LT2); elegibilidad(LT1, { liquidada: true }); elegibilidad(LT2, { autogestion: true });
    const r = await post({ ...BASE, items: [{ placa: P1, valor: 10 }] });
    expect(r.body.rechazados).toEqual([expect.objectContaining({ codigo: 'NO_ENCONTRADO' })]);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('Alcance: un aprobado ajeno + uno propio → se registra el propio, no VARIOS', async () => {
    ajenos.add(LT1);
    candidatos(LT1, LT2); elegibilidad(LT2);
    txSelect.mockReturnValueOnce(chain([{ id: LT2, idFlit: CTX(LT2).idFlit }])).mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([CTX(LT2)])).mockReturnValueOnce(chain([{ siguiente: 2 }])).mockReturnValueOnce(chain([{ name: 'Ana' }]));
    txInsert.mockReturnValueOnce(chain([fila('10.00')]));
    const r = await post({ ...BASE, items: [{ placa: P1, valor: 10 }] });
    expect(r.body.rechazados).toEqual([]);
    expect(r.body.creados).toEqual([expect.objectContaining({ tramiteId: LT2 })]);
  });

  it('Alcance: único aprobado ajeno y liquidado → NO_ENCONTRADO (sin oráculo de TRAMITE_LIQUIDADO)', async () => {
    ajenos.add(LT1);
    candidatos(LT1); // sin elegibilidad(): un ajeno ni se evalúa
    const r = await post({ ...BASE, items: [{ placa: P1, valor: 10 }] });
    expect(r.body.rechazados).toEqual([expect.objectContaining({ placa: P1, codigo: 'NO_ENCONTRADO' })]);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('Alcance: 2 propios + 1 ajeno → VARIOS con solo los 2 propios como candidatos', async () => {
    ajenos.add(LT2);
    candidatos(LT1, LT2, LT3); elegibilidad(LT1); elegibilidad(LT3);
    const r = await post({ ...BASE, items: [{ placa: P1, valor: 10 }] });
    expect(r.body.rechazados[0].codigo).toBe('VARIOS_TRAMITES_APROBADOS');
    expect(r.body.rechazados[0].candidatos.map((c: { tramiteId: string }) => c.tramiteId)).toEqual([LT1, LT3]);
  });

  it('La placa (PII) no viaja al rastro de auditoría', async () => {
    armarLt(LT1);
    await post({ ...BASE, items: [{ placa: P1, valor: 10 }] });
    expect(JSON.stringify(auditMock.mock.calls.map((c) => c[1]))).not.toContain(P1);
  });

  it('El item con tramiteId (contrato viejo) es 400', async () => {
    expect((await post({ ...BASE, items: [{ tramiteId: LT1, valor: 1 }] })).status).toBe(400);
  });

  it('motivo «otro» exige detalle; motivo ausente → 400', async () => {
    expect((await post({ motivo: 'otro', items: [{ placa: P1, valor: 1 }] })).status).toBe(400);
    expect((await post({ items: [{ placa: P1, valor: 1 }] })).status).toBe(400);
  });

  it('sin token 401; rol sin la función 403 (misma función que el individual)', async () => {
    const app = await buildApp();
    expect((await request(app).post(URL).send({})).status).toBe(401);
    const r = await request(app).post(URL).set('Authorization', await auth('financiera')).send({ ...BASE, items: [{ placa: P1, valor: 1 }] });
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
