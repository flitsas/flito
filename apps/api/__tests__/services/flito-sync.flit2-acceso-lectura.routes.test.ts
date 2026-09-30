// HU #13190 (Feature #13059, Épica #12736) — lectura de FLIT 2 al guardar el acceso y retiro del
// `POST /api/flito/sync/flit2/sincronizar`.
//
// Frontera HTTP con los servicios sustituidos por espías: `guardarAcceso` (el guardado real se prueba en
// `flito-sync.flit2-acceso.test.ts`) y `leerConCandado` / `auditarLecturaProgramada` (la lectura real, su
// candado, su anotación de errores en la fila —lo que el estado muestra como problema— y el detalle de
// auditoría se prueban en `flito-sync.flit2-lectura.test.ts`). Aquí: si se lanza, cuándo, con qué
// origen, que la respuesta no la espera y que ningún desenlace escapa sin capturar.
//
// Mapa AC → casos: AC1 «encendida» · AC2 «apagada» · AC3 «candado tomado» · AC4 «falla en segundo
// plano» · AC5 «PUT que no responde 200» · AC6 «auditoría con origen acceso» · AC7 «ruta retirada».

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken } from '../helpers/auth.js';

const entorno = { cron: true };
vi.mock('../../src/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/env.js')>();
  return {
    ...actual,
    env: new Proxy(actual.env as Record<string, unknown>, {
      get(target, prop) {
        if (prop === 'FLIT2_SYNC_CRON') return entorno.cron;
        return target[prop as string];
      },
    }),
  };
});

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const logFlit2 = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
vi.mock('../../src/shared/logger.js', async (orig) => {
  const real = await orig() as { loggerFor: (n: string) => unknown };
  return {
    ...real,
    loggerFor: (nombre: string) => (nombre === 'flito-sync-flit2' ? logFlit2 : real.loggerFor(nombre)),
  };
});

const guardarMock = vi.fn();
vi.mock('../../src/modules/flito-sync/flit2-acceso.service.js', async (orig) => ({
  ...(await orig() as Record<string, unknown>), guardarAcceso: guardarMock,
}));
const leerMock = vi.fn();
const auditarMock = vi.fn();
vi.mock('../../src/modules/flito-sync/flit2-lectura.service.js', async (orig) => ({
  ...(await orig() as Record<string, unknown>), leerConCandado: leerMock, auditarLecturaProgramada: auditarMock,
}));

const {
  Flit2LecturaEnCursoError, Flit2RechazadoError, Flit2NoRespondeError, Flit2RespuestaError,
  Flit2AccesoRotacionConcurrenteError, Flit2LlaveMaestraError,
} = await import('../../src/modules/flito-sync/flit2.errors.js');
const { correrLecturaTrasAcceso } = await import('../../src/modules/flito-sync/flit2-lectura-acceso.js');

const BASE = '/api/flito/sync/flit2';
const RUTA = `${BASE}/acceso`;
const CUERPO = { clientId: 'flito-sync', clientSecret: 'Fl1t2-s3cr3t0-de-prueba-9c7e2a51d4b8' };
const META = { configurado: true, clientId: 'flito-sync', actualizadoPor: null, actualizadoEn: null, estado: 'vigente', bloqueadoHasta: null };
const RESULTADO = {
  leidos: 3, nuevos: 1, actualizados: 1, sinCambios: 1, conflictos: 0, sinVehiculo: 0, eliminadosIgnorados: 0,
  invalidos: 0, companiasFaltantes: 0, organismosSinEmparejar: 0, paginas: 1, hasMore: false, modo: 'cursor',
  ejecutadoEn: '2026-09-30T15:00:00.000Z',
};

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-sync/flit2.routes.js');
  app.use(BASE, router);
  return app;
}

let siguienteSub = 1300;
const auth = async (sub = siguienteSub++) => `Bearer ${await testToken({ sub, username: 'ops@flit.io', role: 'admin' })}`;

/** Promesa que el test resuelve o rechaza a mano: prueba que la respuesta no espera la lectura. */
function diferida<T>() {
  let resolver!: (v: T) => void;
  let rechazar!: (e: unknown) => void;
  const promesa = new Promise<T>((ok, ko) => { resolver = ok; rechazar = ko; });
  return { promesa, resolver, rechazar };
}

/** Deja correr las microtareas pendientes (la lectura de fondo y su `catch`). */
const drenar = () => new Promise<void>((ok) => { setImmediate(ok); });

beforeEach(() => {
  kdb.reset();
  entorno.cron = true;
  guardarMock.mockReset().mockResolvedValue({ id: 3, meta: META });
  leerMock.mockReset().mockResolvedValue(RESULTADO);
  auditarMock.mockReset().mockResolvedValue(undefined);
  for (const f of Object.values(logFlit2)) f.mockReset();
});

describe('AC1 · lectura automática encendida', () => {
  it('PUT válido → 200 sin esperar la lectura; en segundo plano leerConCandado con origen «acceso»', async () => {
    const lectura = diferida<typeof RESULTADO>();
    leerMock.mockReturnValue(lectura.promesa);

    const r = await request(await buildApp()).put(RUTA).set('Authorization', await auth()).send(CUERPO);

    // La lectura sigue pendiente y la respuesta ya salió con el acceso guardado.
    expect(r.status).toBe(200);
    expect(r.body).toEqual(META);
    expect(leerMock).toHaveBeenCalledTimes(1);
    expect(leerMock).toHaveBeenCalledWith('acceso');
    expect(auditarMock).not.toHaveBeenCalled();

    lectura.resolver(RESULTADO);
    await drenar();
    // AC6: terminada bien, se audita como la programada con el origen que la distingue.
    expect(auditarMock).toHaveBeenCalledWith(RESULTADO, 'acceso');
  });
});

describe('AC2 · lectura automática apagada', () => {
  it('FLIT2_SYNC_CRON=false → PUT válido 200 y ninguna lectura', async () => {
    entorno.cron = false;
    const r = await request(await buildApp()).put(RUTA).set('Authorization', await auth()).send(CUERPO);
    await drenar();
    expect(r.status).toBe(200);
    expect(guardarMock).toHaveBeenCalledTimes(1);
    expect(leerMock).not.toHaveBeenCalled();
  });
});

describe('AC3 · candado tomado', () => {
  it('otra corrida tiene el candado → el PUT sigue en 200 y queda en el log como aviso, no como error', async () => {
    leerMock.mockRejectedValue(new Flit2LecturaEnCursoError());
    const r = await request(await buildApp()).put(RUTA).set('Authorization', await auth()).send(CUERPO);
    await drenar();
    expect(r.status).toBe(200);
    expect(leerMock).toHaveBeenCalledWith('acceso');
    expect(logFlit2.info).toHaveBeenCalledWith(expect.stringMatching(/otra corrida tiene el candado/));
    expect(logFlit2.warn).not.toHaveBeenCalled();
    expect(logFlit2.error).not.toHaveBeenCalled();
    expect(auditarMock).not.toHaveBeenCalled();
  });
});

describe('AC4 · la lectura de fondo falla', () => {
  it.each([
    ['rechazado', new Flit2RechazadoError('credenciales'), 'rechazado'],
    ['no responde', new Flit2NoRespondeError(), 'no_responde'],
    ['respuesta inesperada', new Flit2RespuestaError(500, null), 'flit2_respuesta'],
  ])('%s → PUT 200, warn con el código (sin PII) y sin auditar', async (_n, error, codigo) => {
    leerMock.mockRejectedValue(error);
    const r = await request(await buildApp()).put(RUTA).set('Authorization', await auth()).send(CUERPO);
    await drenar();
    expect(r.status).toBe(200);
    expect(logFlit2.warn).toHaveBeenCalledWith({ codigo }, expect.stringMatching(/tras guardar el acceso interrumpida/));
    expect(auditarMock).not.toHaveBeenCalled();
    const logueado = JSON.stringify(logFlit2.warn.mock.calls);
    expect(logueado).not.toContain(CUERPO.clientSecret);
  });

  it('un error que no es de FLIT 2 → log de error con el nombre, y la corrida no rechaza', async () => {
    leerMock.mockRejectedValue(new TypeError('boom con dato 1020304050'));
    await expect(correrLecturaTrasAcceso()).resolves.toBeUndefined();
    expect(logFlit2.error).toHaveBeenCalledWith({ err: 'TypeError' }, expect.any(String));
    expect(JSON.stringify(logFlit2.error.mock.calls)).not.toContain('1020304050');
  });

  it('si la auditoría fallara, la corrida tampoco rechaza', async () => {
    auditarMock.mockRejectedValue(new Error('audit caído'));
    await expect(correrLecturaTrasAcceso()).resolves.toBeUndefined();
    expect(logFlit2.error).toHaveBeenCalledWith({ err: 'Error' }, expect.any(String));
  });
});

describe('AC5 · PUT que no responde 200 no lanza lectura', () => {
  it('400 datos inválidos', async () => {
    const r = await request(await buildApp()).put(RUTA).set('Authorization', await auth()).send({ clientId: '' });
    await drenar();
    expect(r.status).toBe(400);
    expect(guardarMock).not.toHaveBeenCalled();
    expect(leerMock).not.toHaveBeenCalled();
  });

  it.each([
    [409, new Flit2AccesoRotacionConcurrenteError()],
    [503, new Flit2LlaveMaestraError('sin llave')],
  ])('%i del guardado', async (status, error) => {
    guardarMock.mockRejectedValue(error);
    const r = await request(await buildApp()).put(RUTA).set('Authorization', await auth()).send(CUERPO);
    await drenar();
    expect(r.status).toBe(status);
    expect(leerMock).not.toHaveBeenCalled();
  });

  it('429 del limitador (11.ª petición del mismo usuario en el minuto)', async () => {
    const app = await buildApp();
    const token = await auth();
    for (let i = 0; i < 10; i++) {
      expect((await request(app).put(RUTA).set('Authorization', token).send(CUERPO)).status).toBe(200);
    }
    await drenar();
    leerMock.mockClear();
    const r = await request(app).put(RUTA).set('Authorization', token).send(CUERPO);
    await drenar();
    expect(r.status).toBe(429);
    expect(leerMock).not.toHaveBeenCalled();
  });
});

describe('AC7 · botón retirado', () => {
  it('POST /sincronizar → 404 y no lee', async () => {
    const r = await request(await buildApp()).post(`${BASE}/sincronizar`).set('Authorization', await auth()).send({});
    expect(r.status).toBe(404);
    expect(leerMock).not.toHaveBeenCalled();
  });
});
