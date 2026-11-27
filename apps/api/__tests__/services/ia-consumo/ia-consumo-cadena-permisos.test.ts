// Épica #14548 (ADR-0051, bloque A) — la CADENA REAL de permisos del visor de consumo de IA (B1 de QA, A-26).
// `exigirFuncion` y `resolverPermisos` van sin sustituir: lo único falso es la fuente de filas (la base), con la costura
// que el repo usa en sus tests (`fijarFuenteDePermisos`). Una acción concedida se expande a sus operaciones; sin ella,
// las tres rutas responden 403 con `funcion: ia_consumo.registros.ver` y sin tocar la base.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express, { type NextFunction, type Request, type Response } from 'express';
import { hoyColombia } from '../../../src/shared/utils/fecha-rango.js';
import { fijarFuenteDePermisos, invalidarPermisosDe } from '../../../src/shared/permisos-efectivos.js';

const { estado, registrarDenegadoMock, logPiiAccessMock, fakeDb } = vi.hoisted(() => {
  const estado = {
    respuestas: [] as unknown[][],
    lecturas: 0,
    funcionesDelRol: [] as string[],
  };
  const tx = {
    execute: async () => [],
    select: () => {
      estado.lecturas++;
      const builder = {
        from: () => builder,
        where: () => builder,
        orderBy: () => builder,
        limit: () => builder,
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(estado.respuestas.shift() ?? []).then(resolve, reject),
      };
      return builder;
    },
  };
  return {
    estado,
    registrarDenegadoMock: vi.fn().mockResolvedValue(undefined),
    logPiiAccessMock: vi.fn().mockResolvedValue(undefined),
    fakeDb: { transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) },
  };
});

vi.mock('../../../src/db/client.js', () => ({ db: fakeDb }));
vi.mock('../../../src/shared/pii-audit.js', () => ({
  logPiiAccess: (...args: unknown[]) => logPiiAccessMock(...args),
}));
vi.mock('../../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../../src/shared/historial/permisos-intentos-denegados.js', () => ({
  registrarIntentoDenegado: (...args: unknown[]) => registrarDenegadoMock(...args),
}));
vi.mock('../../../src/shared/middleware/auth.js', () => ({
  authMiddleware: (req: Request, res: Response, next: NextFunction) => {
    if (!req.headers.authorization) {
      res.status(401).json({ error: 'No autenticado' });
      return;
    }
    (req as Request & { user?: unknown }).user = { sub: 7, username: 'ops@flit.io', role: 'admin' };
    next();
  },
}));

const BASE = '/api/ia-consumo';
const AUTH = 'Bearer prueba';
const UUID = '0190c0de-0000-7000-8000-000000000001';
const USUARIO = 7;

const hoy = hoyColombia();
const hace6 = new Date(Date.parse(`${hoy}T00:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10);

/** Fila del detalle con lo mínimo que la respuesta necesita. */
function filaDetalle() {
  return {
    id: UUID,
    correlacionId: UUID,
    fechaInicio: new Date('2026-11-20T20:00:00Z'),
    fechaFin: new Date('2026-11-20T20:00:02Z'),
    bytesPrompt: 10,
    bytesRespuesta: 10,
    tieneContenido: true,
    metadatosBytes: null,
    metadatos: null,
    errorMensaje: null,
  };
}

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../../src/modules/ia-consumo/ia-consumo.routes.js');
  app.use(BASE, router);
  return app;
}

/** Las tres rutas del visor, cada una con una petición válida. */
const peticiones = {
  catalogos: (app: express.Express) => request(app).get(`${BASE}/catalogos`).set('Authorization', AUTH),
  buscar: (app: express.Express) => request(app).post(`${BASE}/registros/buscar`).set('Authorization', AUTH)
    .send({ desde: hace6, hasta: hoy }),
  detalle: (app: express.Express) => request(app).get(`${BASE}/registros/${UUID}`).set('Authorization', AUTH),
};
const RUTAS = Object.entries(peticiones);

beforeAll(() => {
  // La fuente de filas es el único falso: el conjunto sale de `funcionesDelRol` y lo expande el resolutor real.
  fijarFuenteDePermisos(async () => ({
    rol: 'admin', tipoEnlace: null, funcionesDelRol: [...estado.funcionesDelRol], excepciones: [],
  }));
});

afterAll(() => {
  fijarFuenteDePermisos(null);
});

beforeEach(() => {
  estado.respuestas.length = 0;
  estado.lecturas = 0;
  estado.funcionesDelRol.length = 0;
  registrarDenegadoMock.mockClear();
  invalidarPermisosDe(USUARIO);
});

describe('cadena real de permisos del visor (B1, A-26)', () => {
  it('con `accion.ia_consumo.ver` concedida, las tres rutas responden 200: la acción se expande a `ia_consumo.registros.ver`', async () => {
    // La acción va con su cadena, como la concede el panel y como la siembra la 0321: menú e ítem. Sin ellos no es efectiva.
    estado.funcionesDelRol.push('menu.administracion', 'pagina.ia_consumo', 'accion.ia_consumo.ver');
    invalidarPermisosDe(USUARIO);
    const app = await buildApp();
    // En el orden en que las rutas consultan: la lista de la búsqueda, y luego la fila del detalle y sus relacionados.
    estado.respuestas.push([], [filaDetalle()], []);
    const respuestas = [await peticiones.catalogos(app), await peticiones.buscar(app), await peticiones.detalle(app)];
    expect(respuestas.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(registrarDenegadoMock).not.toHaveBeenCalled();
  });

  it('sin esa acción, las tres rutas responden 403 con `funcion: ia_consumo.registros.ver` y no tocan la base', async () => {
    const app = await buildApp();
    for (const [nombre, pedir] of RUTAS) {
      const r = await pedir(app);
      expect(r.status, nombre).toBe(403);
      expect(r.body.funcion, nombre).toBe('ia_consumo.registros.ver');
      expect(r.body.motivo, nombre).toBe('sin_modulo');
    }
    expect(estado.lecturas).toBe(0);
    expect(registrarDenegadoMock).toHaveBeenCalledTimes(3);
    expect(registrarDenegadoMock.mock.calls.every(([intento]) => (intento as { codigo: string }).codigo === 'ia_consumo.registros.ver'))
      .toBe(true);
  });

  it('la acción sin su cadena (menú e ítem) no es efectiva: las tres rutas siguen en 403', async () => {
    estado.funcionesDelRol.push('accion.ia_consumo.ver');
    invalidarPermisosDe(USUARIO);
    const app = await buildApp();
    for (const [nombre, pedir] of RUTAS) expect((await pedir(app)).status, nombre).toBe(403);
    expect(estado.lecturas).toBe(0);
  });
});
