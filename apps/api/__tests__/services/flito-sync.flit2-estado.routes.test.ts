// HU #13097 (Feature #13060) — ruta `GET /api/flito/sync/flit2/estado`.
//
// El servicio se sustituye por un espía: aquí se prueba la frontera HTTP (auth, función
// `sync.sync.ver_estado`, forma de la respuesta). La lógica vive en `flito-sync.flit2-estado.test.ts`.

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
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));
const estadoMock = vi.fn();
vi.mock('../../src/modules/flito-sync/flit2-estado.service.js', async (orig) => ({
  ...(await orig() as Record<string, unknown>), obtenerEstadoConexion: estadoMock,
}));

const RUTA = '/api/flito/sync/flit2/estado';

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-sync/flit2.routes.js');
  app.use('/api/flito/sync/flit2', router);
  // Manejador mínimo: el de producción traduce a 500; aquí basta con ver que el error llega.
  app.use((_e: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: 'interno' });
  });
  return app;
}

let siguienteSub = 900;
const auth = async (role: TestRole = 'admin') =>
  `Bearer ${await testToken({ sub: siguienteSub++, username: 'ops@flit.io', role })}`;

const ESTADO = {
  configurado: true,
  motivoSinConfigurar: null,
  ultimaExitosaEn: '2026-09-29T14:55:00.000Z',
  ultimoIntentoEn: '2026-09-29T14:58:00.000Z',
  atrasada: false,
  alerta: true,
  problema: { tipo: 'rechazado', codigo: null, motivo: 'credenciales', en: '2026-09-29T14:58:00.000Z', hasta: null },
  piiEnmascarada: { tramites: 2, desde: '2026-09-29T10:00:00.000Z' },
};

beforeEach(() => {
  kdb.reset();
  estadoMock.mockReset().mockResolvedValue(ESTADO);
});

describe('HU #13097 · GET /estado', () => {
  it('admin con sync.sync.ver_estado → 200 con la forma del contrato', async () => {
    const r = await request(await buildApp()).get(RUTA).set('Authorization', await auth());
    expect(r.status).toBe(200);
    expect(r.body).toEqual(ESTADO);
    expect(Object.keys(r.body).sort()).toEqual(
      ['alerta', 'atrasada', 'configurado', 'motivoSinConfigurar', 'piiEnmascarada', 'problema', 'ultimaExitosaEn', 'ultimoIntentoEn'],
    );
    expect(estadoMock).toHaveBeenCalledTimes(1);
  });

  it('sin token → 401 y el servicio no se invoca', async () => {
    const r = await request(await buildApp()).get(RUTA);
    expect(r.status).toBe(401);
    expect(estadoMock).not.toHaveBeenCalled();
  });

  it.each<TestRole>(['auditor', 'compliance', 'gestor_impuestos'])('AC8: rol %s sin sync.sync.ver_estado → 403 y el servicio no se invoca', async (rol) => {
    const r = await request(await buildApp()).get(RUTA).set('Authorization', await auth(rol));
    expect(r.status).toBe(403);
    expect(estadoMock).not.toHaveBeenCalled();
  });

  it('un fallo del servicio llega al manejador de errores (no deja la petición colgada)', async () => {
    estadoMock.mockRejectedValueOnce(new Error('db caída'));
    const r = await request(await buildApp()).get(RUTA).set('Authorization', await auth());
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain('db caída');
  });
});
