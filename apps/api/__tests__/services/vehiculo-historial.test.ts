// TRAM-INNOV B1 — pasaporte vehicular: cadena de hashes + rutas.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const { selectMock, insertMock } = vi.hoisted(() => ({ selectMock: vi.fn(), insertMock: vi.fn() }));

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: insertMock, update: vi.fn(), delete: vi.fn(), execute: vi.fn().mockResolvedValue([]) },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

import {
  computeHash, verificarCadena, appendEvento, getHistorial, normalizeVin, GENESIS_HASH, type HistorialRow,
} from '../../src/modules/vehicles/vehiculo-historial.js';

beforeEach(() => { selectMock.mockReset(); insertMock.mockReset(); });

// Construye un eslabón válido encadenado al anterior.
function eslabon(prev: string, over: Partial<HistorialRow>): HistorialRow {
  const base = { id: 1, vin: 'ABC123', eventoTipo: 'tramite_creado', referenciaTramiteId: null as number | null, payload: { a: 1 }, createdAt: '2026-06-04T10:00:00.000Z', ...over };
  const hashSelf = computeHash({ hashPrev: prev, vin: base.vin, eventoTipo: base.eventoTipo, referenciaTramiteId: base.referenciaTramiteId, payload: base.payload, createdAtIso: base.createdAt });
  return { ...base, hashPrev: prev, hashSelf } as HistorialRow;
}

describe('B1 · hash chain (puro)', () => {
  it('computeHash determinístico e independiente del orden de claves del payload', () => {
    const a = computeHash({ hashPrev: GENESIS_HASH, vin: 'V', eventoTipo: 't', payload: { x: 1, y: 2 }, createdAtIso: 'I' });
    const b = computeHash({ hashPrev: GENESIS_HASH, vin: 'V', eventoTipo: 't', payload: { y: 2, x: 1 }, createdAtIso: 'I' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('cadena válida → integridad ok', () => {
    const e1 = eslabon(GENESIS_HASH, { id: 1 });
    const e2 = eslabon(e1.hashSelf, { id: 2, eventoTipo: 'tramite_enviado_transito', createdAt: '2026-06-04T11:00:00.000Z' });
    expect(verificarCadena([e1, e2])).toEqual({ valido: true, rotoEnId: null });
  });

  it('payload alterado → integridad rota en ese id', () => {
    const e1 = eslabon(GENESIS_HASH, { id: 1 });
    const e2 = eslabon(e1.hashSelf, { id: 2 });
    const tampered = { ...e2, payload: { a: 999 } }; // hash_self ya no corresponde
    expect(verificarCadena([e1, tampered])).toEqual({ valido: false, rotoEnId: 2 });
  });

  it('eslabón con hash_prev incorrecto → roto', () => {
    const e1 = eslabon(GENESIS_HASH, { id: 1 });
    const e2 = eslabon('f'.repeat(64), { id: 2 }); // no enlaza con e1
    expect(verificarCadena([e1, e2]).valido).toBe(false);
  });

  it('normalizeVin limpia y trunca', () => {
    expect(normalizeVin('abc-123/xyz')).toBe('ABC123XYZ');
    expect(normalizeVin('a'.repeat(30))).toHaveLength(17);
  });
});

describe('B1 · appendEvento encadena hash_prev = hash_self anterior', () => {
  it('primer evento usa GENESIS', async () => {
    selectMock.mockReturnValueOnce(chain([])); // sin eventos previos
    let captured: any = null;
    insertMock.mockReturnValueOnce({ values: (v: any) => { captured = v; return { returning: () => Promise.resolve([{ ...v, id: 1, createdAt: new Date() }]) }; } });
    await appendEvento({ vin: 'ABC123', eventoTipo: 'tramite_creado', payload: { placa: 'XYZ' } });
    expect(captured.hashPrev).toBe(GENESIS_HASH);
    expect(captured.hashSelf).toMatch(/^[0-9a-f]{64}$/);
  });

  it('segundo evento: hash_prev = hash_self del anterior', async () => {
    const prevHash = 'a'.repeat(64);
    selectMock.mockReturnValueOnce(chain([{ hashSelf: prevHash }]));
    let captured: any = null;
    insertMock.mockReturnValueOnce({ values: (v: any) => { captured = v; return { returning: () => Promise.resolve([{ ...v, id: 2, createdAt: new Date() }]) }; } });
    await appendEvento({ vin: 'ABC123', eventoTipo: 'tramite_placa_asignada', payload: { placa: 'XYZ' } });
    expect(captured.hashPrev).toBe(prevHash);
  });

  it('VIN vacío → no inserta', async () => {
    await appendEvento({ vin: '///', eventoTipo: 'tramite_creado' });
    expect(insertMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------
async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/vehicles/vehicles.routes.js');
  app.use('/api/vehicles', router);
  return app;
}

describe('GET /api/vehicles/:vin/historial', () => {
  it('devuelve eventos + integridad', async () => {
    const e1 = eslabon(GENESIS_HASH, { id: 1 });
    // pre-check con filas → no dispara hydratePasaporteFromLegacy (evita mocks extra).
    selectMock.mockReturnValueOnce(chain([{ id: 1 }]));
    selectMock.mockReturnValueOnce(chain([{ ...e1, createdAt: new Date(e1.createdAt) }]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/vehicles/ABC123/historial').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.vin).toBe('ABC123');
    expect(r.body.eventos).toHaveLength(1);
    expect(r.body.integridad.valido).toBe(true);
    expect(r.body.ultimoHash).toBe(e1.hashSelf);
  });
});

describe('GET /api/vehicles/:vin/certificado', () => {
  it('sin historial → 404', async () => {
    selectMock.mockReturnValueOnce(chain([])); // pre vacío → hydrate
    selectMock.mockReturnValueOnce(chain([])); // tramites backfill
    selectMock.mockReturnValueOnce(chain([])); // vehicles backfill
    selectMock.mockReturnValueOnce(chain([])); // historial final
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/vehicles/ABC123/certificado').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
  });

  it('con historial → 200 PDF', async () => {
    const e1 = eslabon(GENESIS_HASH, { id: 1 });
    selectMock.mockReturnValueOnce(chain([{ id: 1 }]));
    selectMock.mockReturnValueOnce(chain([{ ...e1, createdAt: new Date(e1.createdAt) }]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/vehicles/ABC123/certificado').set('Authorization', `Bearer ${token}`).buffer(true);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(r.body.length).toBeGreaterThan(500); // PDF real
  });
});
