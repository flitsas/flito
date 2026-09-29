// HU #13091 (Feature #13059) — ruta `POST /api/flito/sync/flit2/sincronizar`.
//
// El servicio se sustituye por un espía: aquí se prueba la frontera HTTP (auth, permiso
// `sync.sync.lanzar`, cuerpo sin fecha, traducción de errores, audit sin PII). La lógica de la
// lectura vive en `flito-sync.flit2-lectura.test.ts`.
// TCs: TC-07, TC-08, TC-09 y la parte HTTP de TC-06 / TC-47.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken, type TestRole } from '../helpers/auth.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));
const leerIncrementalMock = vi.fn();
const parcialDeMock = vi.fn();
vi.mock('../../src/modules/flito-sync/flit2-lectura.service.js', () => ({
  leerIncremental: leerIncrementalMock, parcialDe: parcialDeMock,
}));

const { Flit2SinAccesoError, Flit2LecturaConcurrenteError, Flit2RespuestaError } =
  await import('../../src/modules/flito-sync/flit2.errors.js');

const RUTA = '/api/flito/sync/flit2/sincronizar';

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-sync/flit2.routes.js');
  app.use('/api/flito/sync/flit2', router);
  return app;
}

// El limitador cuenta por usuario (6/min): cada petición usa un `sub` distinto.
let siguienteSub = 500;
const auth = async (role: TestRole = 'admin') =>
  `Bearer ${await testToken({ sub: siguienteSub++, username: 'ops@flit.io', role })}`;

const RESULTADO = {
  leidos: 3, nuevos: 1, actualizados: 1, sinCambios: 0, conflictos: 1, sinVehiculo: 0, eliminadosIgnorados: 0,
  invalidos: 0, companiasFaltantes: 0, organismosSinEmparejar: 0, paginas: 1, hasMore: false,
  modo: 'since' as const, ejecutadoEn: '2026-09-29T15:00:00.000Z',
};

beforeEach(() => {
  kdb.reset();
  auditMock.mockClear();
  leerIncrementalMock.mockReset().mockResolvedValue(RESULTADO);
  parcialDeMock.mockReset().mockReturnValue(null);
});

describe('HU #13091 · POST /sincronizar', () => {
  it('TC-07: admin con sync.sync.lanzar → 200 con el resumen, y audit solo con totales', async () => {
    const r = await request(await buildApp()).post(RUTA).set('Authorization', await auth()).send({});
    expect(r.status).toBe(200);
    expect(r.body).toEqual(RESULTADO);
    expect(leerIncrementalMock).toHaveBeenCalledTimes(1);
    expect(leerIncrementalMock).toHaveBeenCalledWith();
    expect(auditMock).toHaveBeenCalledTimes(1);
    const entrada = auditMock.mock.calls[0][1] as { action: string; resource: string; detail: string };
    expect(entrada.resource).toBe('flito_sincronizacion_flit2');
    expect(entrada.detail).toMatch(/^Sync FLIT 2 \(since\): 3 leídos, 1 nuevos/);
  });

  it('TC-07: sin cuerpo también vale (el botón no manda nada)', async () => {
    const r = await request(await buildApp()).post(RUTA).set('Authorization', await auth());
    expect(r.status).toBe(200);
  });

  it('TC-08: sin token → 401 y el servicio no se invoca', async () => {
    const r = await request(await buildApp()).post(RUTA).send({});
    expect(r.status).toBe(401);
    expect(leerIncrementalMock).not.toHaveBeenCalled();
  });

  it.each<TestRole>(['auditor', 'compliance', 'gestor_impuestos'])('TC-08: rol %s sin sync.sync.lanzar → 403 y el servicio no se invoca', async (rol) => {
    const r = await request(await buildApp()).post(RUTA).set('Authorization', await auth(rol)).send({});
    expect(r.status).toBe(403);
    expect(leerIncrementalMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ fecha: '2026-01-01' }],
    [{ initialDate: '20260101' }],
    [{ since: '2026-01-01T00:00:00Z' }],
  ])('TC-09: el cuerpo %j (una fecha) → 400 datos_invalidos y la fecha no llega al servicio', async (cuerpo) => {
    const r = await request(await buildApp()).post(RUTA).set('Authorization', await auth()).send(cuerpo);
    expect(r.status).toBe(400);
    expect(r.body.codigo).toBe('datos_invalidos');
    expect(leerIncrementalMock).not.toHaveBeenCalled();
  });

  it('TC-06: sin acceso → 503 sin_acceso tipado (no 500) y sin audit', async () => {
    leerIncrementalMock.mockRejectedValue(new Flit2SinAccesoError());
    const r = await request(await buildApp()).post(RUTA).set('Authorization', await auth()).send({});
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: expect.any(String), codigo: 'sin_acceso' });
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('lectura concurrente → 409 lectura_concurrente', async () => {
    leerIncrementalMock.mockRejectedValue(new Flit2LecturaConcurrenteError());
    const r = await request(await buildApp()).post(RUTA).set('Authorization', await auth()).send({});
    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('lectura_concurrente');
  });

  it('respuesta inesperada de FLIT 2 con páginas ya guardadas → 502 con el parcial; sin el cuerpo de FLIT 2', async () => {
    const error = new Flit2RespuestaError(500, 'internal_error');
    leerIncrementalMock.mockRejectedValue(error);
    parcialDeMock.mockImplementation((e: unknown) => (e === error ? { ...RESULTADO, paginas: 1, hasMore: true } : null));
    const r = await request(await buildApp()).post(RUTA).set('Authorization', await auth()).send({});
    expect(r.status).toBe(502);
    expect(r.body.codigo).toBe('flit2_respuesta');
    expect(r.body.parcial).toEqual({ ...RESULTADO, paginas: 1, hasMore: true });
    expect(JSON.stringify(r.body)).not.toContain('internal_error');
  });
});
