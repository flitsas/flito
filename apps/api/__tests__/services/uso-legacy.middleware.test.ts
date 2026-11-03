// HU #13989 (ADR-0033 §1 y §6, AC1 y AC2) — capas de conteo sobre `createApp()` real, BD mockeada.
// M1–M12 de la lista del ADR. Sin asertos de tiempo: el overhead lo mide `scripts/bench-uso-legacy.ts`.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { chain, chainReject } from '../helpers/db.js';
import { registrarUsuarioDePrueba, testToken } from '../helpers/auth.js';

vi.hoisted(() => { process.env.USO_LEGACY_CONTEO_ENABLED = '1'; });

vi.mock('../../src/db/client.js', () => {
  const vacio = () => chain([]);
  return {
    db: {
      select: vi.fn(vacio), selectDistinct: vi.fn(vacio), insert: vi.fn(vacio), update: vi.fn(vacio),
      delete: vi.fn(vacio), execute: vi.fn().mockResolvedValue([]), transaction: vi.fn(),
    },
    getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
  };
});
vi.mock('../../src/shared/middleware/rateLimiter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/middleware/rateLimiter.js')>();
  const pasa = (_req: unknown, _res: unknown, next: () => void) => next();
  return { ...actual, apiLimiter: pasa, authLimiter: pasa, qrPublicLimiter: pasa };
});
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
// `acumular` observable, sin dejar de ser el real: M9 afirma que ni siquiera se llama.
vi.mock('../../src/modules/uso-legacy/uso-legacy.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/uso-legacy/uso-legacy.service.js')>();
  return { ...actual, acumular: vi.fn(actual.acumular) };
});

const { db } = await import('../../src/db/client.js');
const { env } = await import('../../src/config/env.js');
const { createApp } = await import('../../src/app.js');
const { acumular, flushUsoLegacy, _bufferUsoLegacy, _reiniciarUsoLegacy } = await import('../../src/modules/uso-legacy/uso-legacy.service.js');

let app: Express;
let admin: string;

type Clave = { modulo: string; ruta: string; metodo: string; consumidor: string; total: number };
const buffer = (): Clave[] => [..._bufferUsoLegacy()].map(([clave, total]) => {
  const [, modulo, ruta, metodo, consumidor] = clave.split('\t') as [string, string, string, string, string];
  return { modulo, ruta, metodo, consumidor, total };
});
/** `close` llega después de la respuesta: se espera a que el conteo aparezca, sin asumir un orden. */
const esperarConteos = (n: number) => vi.waitFor(() => {
  expect(buffer().reduce((s, c) => s + c.total, 0)).toBe(n);
});

function appConConteo(encendido: boolean): Express {
  const antes = env.USO_LEGACY_CONTEO_ENABLED;
  (env as { USO_LEGACY_CONTEO_ENABLED: boolean }).USO_LEGACY_CONTEO_ENABLED = encendido;
  try { return createApp(); } finally {
    (env as { USO_LEGACY_CONTEO_ENABLED: boolean }).USO_LEGACY_CONTEO_ENABLED = antes;
  }
}

beforeAll(async () => {
  app = appConConteo(true);
  admin = `Bearer ${await testToken({ sub: 99001, role: 'admin' })}`;
});
beforeEach(() => {
  _reiniciarUsoLegacy();
  vi.mocked(acumular).mockClear();
  vi.mocked(db.select).mockImplementation((() => chain([])) as never);
  vi.mocked(db.insert).mockImplementation((() => chain([])) as never);
});

describe('AC1 — qué se registra', () => {
  it('M1: ruta legacy autenticada → soat, /api/soat/<patrón>, método y rol', async () => {
    await request(app).get('/api/soat/stats').set('Authorization', admin);
    await esperarConteos(1);
    expect(buffer()).toEqual([{ modulo: 'soat', ruta: '/api/soat/stats', metodo: 'GET', consumidor: 'admin', total: 1 }]);
  });

  it('M2: dos routers bajo un prefijo (soat + batch) → suma exactamente 1', async () => {
    await request(app).post('/api/soat/batch-validate').set('Authorization', admin);
    await esperarConteos(1);
    expect(buffer()).toEqual([{ modulo: 'soat', ruta: '/api/soat/batch-validate', metodo: 'POST', consumidor: 'admin', total: 1 }]);
  });

  it('M2: dos routers bajo un prefijo (tramites + firma) → suma exactamente 1', async () => {
    await request(app).post('/api/tramites/8f7d1c2e-0000-4000-8000-000000000001/firma/solicitar').set('Authorization', admin).send({});
    await esperarConteos(1);
    expect(buffer()).toEqual([{ modulo: 'tramites', ruta: '/api/tramites/:id/firma/solicitar', metodo: 'POST', consumidor: 'admin', total: 1 }]);
  });

  it('M3: la URL real no entra: solo el patrón y `publico`', async () => {
    await request(app).get('/api/tramite-portal/TOKENREAL?cedula=98765');
    await esperarConteos(1);
    expect(buffer()).toEqual([{ modulo: 'tramites', ruta: '/api/tramite-portal/:token', metodo: 'GET', consumidor: 'publico', total: 1 }]);
    const serializado = JSON.stringify([..._bufferUsoLegacy()]);
    expect(serializado).not.toContain('TOKENREAL');
    expect(serializado).not.toContain('98765');
  });

  it('M4: la grafía del cliente no abre otra clave: /API/SOAT → prefijo canónico', async () => {
    await request(app).get('/API/SOAT/stats').set('Authorization', admin);
    await esperarConteos(1);
    expect(buffer()[0]!.ruta).toBe('/api/soat/stats');
  });

  it('M5: handler que lanza error → conserva prefijo y patrón', async () => {
    vi.mocked(db.select).mockImplementation((() => chainReject(new Error('caída'))) as never);
    const r = await request(app).get('/api/soat/stats').set('Authorization', admin);
    expect(r.status).toBe(500);
    await esperarConteos(1);
    expect(buffer()[0]!.ruta).toBe('/api/soat/stats');
  });

  it('M6: 401 de router con 50 URL al azar → una sola clave (sin_ruta)', async () => {
    for (let i = 0; i < 50; i += 1) {
      const r = await request(app).get(`/api/soat/azar-${i}/mas/${i}?placa=ABC${i}`);
      expect(r.status).toBe(401);
    }
    await esperarConteos(50);
    expect(buffer()).toEqual([{ modulo: 'soat', ruta: '/api/soat/(sin_ruta)', metodo: 'GET', consumidor: 'publico', total: 50 }]);
  });

  it('M6: 404 autenticado con 50 URL al azar → una sola clave (sin_ruta) con el rol', async () => {
    for (let i = 0; i < 50; i += 1) {
      const r = await request(app).get(`/api/soat/azar-${i}/mas/${i}/y/mas`).set('Authorization', admin);
      expect(r.status).toBe(404);
    }
    await esperarConteos(50);
    expect(buffer()).toEqual([{ modulo: 'soat', ruta: '/api/soat/(sin_ruta)', metodo: 'GET', consumidor: 'admin', total: 50 }]);
  });

  it('M7: SSE cortado por el cliente → /api/validacion-identidad/sse suma 1 (solo al cortarse)', async () => {
    const servidor = app.listen(0);
    try {
      await new Promise((r) => servidor.once('listening', r));
      const { port } = servidor.address() as AddressInfo;
      const respuesta = await new Promise<http.IncomingMessage>((resolver, rechazar) => {
        http.get({ port, path: '/api/validacion-identidad/sse', headers: { Authorization: admin } }, resolver).on('error', rechazar);
      });
      expect(respuesta.statusCode).toBe(200);
      expect(buffer()).toEqual([]);
      respuesta.destroy();
      await esperarConteos(1);
      expect(buffer()).toEqual([{ modulo: 'tramites', ruta: '/api/validacion-identidad/sse', metodo: 'GET', consumidor: 'admin', total: 1 }]);
    } finally {
      servidor.closeAllConnections();
      await new Promise((r) => servidor.close(r));
    }
  });

  it('M8: /api/transito con `conAlcance` → cuenta con patrón y la frontera no cambia', async () => {
    const sinConteo = appConConteo(false);
    const compania = `Bearer ${await testToken({ sub: 99002, role: 'cliente' })}`;
    await registrarUsuarioDePrueba(99002, { rol: 'cliente', tipoEnlace: 'compania', funcionesDelRol: ['transito.organismos.listar'], excepciones: [] });

    const conCapa = await request(app).get('/api/transito/organismos').set('Authorization', compania);
    const sinCapa = await request(sinConteo).get('/api/transito/organismos').set('Authorization', compania);
    expect(conCapa.status).toBe(403);
    expect(conCapa.body).toEqual(sinCapa.body);
    await esperarConteos(1);
    expect(buffer()[0]).toMatchObject({ modulo: 'tramites', ruta: '/api/transito/(sin_ruta)', consumidor: 'cliente' });

    _reiniciarUsoLegacy();
    const r = await request(app).get('/api/transito/organismos').set('Authorization', admin);
    expect(r.status).toBe(200);
    await esperarConteos(1);
    expect(buffer()).toEqual([{ modulo: 'tramites', ruta: '/api/transito/organismos', metodo: 'GET', consumidor: 'admin', total: 1 }]);
  });
});

describe('AC2 — no invasivo', () => {
  it('M9: /api/flito/soat y /api/vehicles → buffer vacío y `acumular` sin llamar', async () => {
    await request(app).get('/api/flito/soat/algo').set('Authorization', admin);
    await request(app).get('/api/vehicles/algo').set('Authorization', admin);
    await request(app).get('/api/soatx/algo').set('Authorization', admin);
    await new Promise((r) => setTimeout(r, 30));
    expect(acumular).not.toHaveBeenCalled();
    expect(buffer()).toEqual([]);
  });

  it('M10: misma ruta legacy con y sin conteo → status y cuerpo idénticos, sin cabeceras nuevas', async () => {
    const sinConteo = appConConteo(false);
    for (const pedir of [
      (a: Express) => request(a).get('/api/soat/stats').set('Authorization', admin),
      (a: Express) => request(a).get('/api/soat/stats'),
      (a: Express) => request(a).get('/api/tramite-portal/UNTOKEN'),
    ]) {
      const con = await pedir(app);
      const sin = await pedir(sinConteo);
      expect(con.status).toBe(sin.status);
      expect(con.body).toEqual(sin.body);
      expect(Object.keys(con.headers).sort()).toEqual(Object.keys(sin.headers).sort());
    }
  });

  it.each([
    ['nunca resuelve', () => new Promise(() => {})],
    ['rechaza', () => Promise.reject(new Error('caída'))],
  ])('M11: `db.insert` que %s, con flush forzado → la petición responde igual', async (_nombre, resultado) => {
    const base = await request(app).get('/api/soat/stats').set('Authorization', admin);
    await esperarConteos(1);
    vi.mocked(db.insert).mockImplementation((() => ({
      values: () => ({ onConflictDoUpdate: () => resultado() }),
    })) as never);
    void flushUsoLegacy();
    expect(db.insert).toHaveBeenCalled();
    const durante = await request(app).get('/api/soat/stats').set('Authorization', admin);
    expect(durante.status).toBe(base.status);
    expect(durante.body).toEqual(base.body);
  });

  it('M12: con la variable en 0 no hay capas de conteo en la pila; encendida hay 7 antes de las rutas', () => {
    type Capa = { name: string; regexp: RegExp };
    const pila = (a: Express) => (a as unknown as { _router: { stack: Capa[] } })._router.stack;
    expect(pila(appConConteo(false)).filter((c) => c.name === 'contarUsoLegacy')).toHaveLength(0);

    const capas = pila(appConConteo(true));
    expect(capas.filter((c) => c.name === 'contarUsoLegacy')).toHaveLength(7);
    const ultimaDeConteo = capas.map((c) => c.name).lastIndexOf('contarUsoLegacy');
    const routerSoat = capas.findIndex((c) => c.name === 'router' && c.regexp.test('/api/soat'));
    expect(routerSoat).toBeGreaterThan(-1);
    expect(ultimaDeConteo).toBeLessThan(routerSoat);
  });
});
