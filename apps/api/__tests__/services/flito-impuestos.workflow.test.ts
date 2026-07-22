// FLITO Impuestos — workflow (cola, envío, estados). Fase 4 P2. Verifica fronteras (CA-05/CA-10),
// RBAC, envío atómico (CA-04) y 404-no-403, con drizzle mockeado. Invariantes de BD además con smoke.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();
const updateMock = vi.fn();
const insertMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, update: updateMock, insert: insertMock, delete: vi.fn(), transaction: transactionMock, execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

beforeEach(() => { selectMock.mockReset(); updateMock.mockReset(); insertMock.mockReset(); transactionMock.mockReset(); });

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-impuestos/flito-impuestos.routes.js');
  app.use('/api/flito/impuestos', router);
  return app;
}
const auth = async (role: string) => `Bearer ${await testToken({ sub: 5, username: 'u@x.io', role: role as never })}`;
const UUID = '00000000-0000-0000-0000-0000000000cc';

describe('flito-impuestos — RBAC', () => {
  it('gestor_impuestos → GET / (cola) 200', async () => {
    selectMock.mockReturnValueOnce(chain([{ t: '05001' }])); // contextoImpuesto
    selectMock.mockReturnValueOnce(chain([]));                // cola vacía
    const r = await request(await buildApp()).get('/api/flito/impuestos').set('Authorization', await auth('gestor_impuestos'));
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });
  it('gestor_impuestos → POST /enviar 403 (solo operaciones)', async () => {
    const r = await request(await buildApp()).post('/api/flito/impuestos/enviar').set('Authorization', await auth('gestor_impuestos')).send({ ids: [UUID] });
    expect(r.status).toBe(403);
  });
  it('auditor → POST /:id/rechazar 403', async () => {
    const r = await request(await buildApp()).post(`/api/flito/impuestos/${UUID}/rechazar`).set('Authorization', await auth('auditor')).send({ motivo: 'x' });
    expect(r.status).toBe(403);
  });
});

describe('flito-impuestos — fronteras (CA-05/CA-10)', () => {
  it('gestor sin organismo (transito_codigo null) → cola vacía', async () => {
    selectMock.mockReturnValueOnce(chain([{ t: null }])); // contexto: sin organismo
    const r = await request(await buildApp()).get('/api/flito/impuestos').set('Authorization', await auth('gestor_impuestos'));
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
    expect(selectMock).toHaveBeenCalledTimes(1); // ni siquiera consulta la cola
  });

  it('gestor consulta un impuesto de OTRO organismo → 404 (no 403)', async () => {
    selectMock.mockReturnValueOnce(chain([{ t: '05001' }])); // contexto gestor: organismo 05001
    selectMock.mockReturnValueOnce(chain([{ imp: { id: UUID, organismoCodigo: '08001', estado: 'en_gestion' }, autogestion: false }]));
    const r = await request(await buildApp()).get(`/api/flito/impuestos/${UUID}`).set('Authorization', await auth('gestor_impuestos'));
    expect(r.status).toBe(404);
  });
});

describe('flito-impuestos — envío atómico y estados', () => {
  it('enviar con ids vacío → 400', async () => {
    const r = await request(await buildApp()).post('/api/flito/impuestos/enviar').set('Authorization', await auth('admin')).send({ ids: [] });
    expect(r.status).toBe(400);
  });

  it('enviar (operaciones) → pendiente→en_gestion atómico, responde enviados', async () => {
    const txSelect = vi.fn().mockReturnValue(chain([{ id: UUID }])); // FOR UPDATE SKIP LOCKED
    const txUpdate = vi.fn().mockReturnValue(chain([]));
    const txInsert = vi.fn().mockReturnValue(chain([])); // audit
    transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => cb({ select: txSelect, update: txUpdate, insert: txInsert }));

    const r = await request(await buildApp()).post('/api/flito/impuestos/enviar').set('Authorization', await auth('admin')).send({ ids: [UUID] });
    expect(r.status).toBe(200);
    expect(r.body.enviados).toEqual([UUID]);
    expect(txUpdate).toHaveBeenCalledTimes(1);
  });

  it('rechazar un impuesto que no está En gestión → 400', async () => {
    selectMock.mockReturnValueOnce(chain([{ imp: { id: UUID, organismoCodigo: '08001', estado: 'pendiente' }, autogestion: false }])); // buscarConAcceso
    const r = await request(await buildApp()).post(`/api/flito/impuestos/${UUID}/rechazar`).set('Authorization', await auth('admin')).send({ motivo: 'no procede' });
    expect(r.status).toBe(400);
  });

  it('reversar con motivo < 5 → 400', async () => {
    const r = await request(await buildApp()).post(`/api/flito/impuestos/${UUID}/reversar`).set('Authorization', await auth('admin')).send({ estadoDestino: 'pendiente', motivo: 'x' });
    expect(r.status).toBe(400);
  });
});
