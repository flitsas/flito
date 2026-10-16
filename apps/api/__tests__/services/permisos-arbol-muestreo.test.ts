// HU #12873 AC6 — Muestreo 200/403 POR ACCIÓN, por HTTP: la guarda real (`exigirFuncion`) sobre el
// resolutor real (`resolverPermisos`, con la fuente de filas de pruebas). Para cada acción de Gestión y
// Tránsito se monta una ruta de laboratorio con la guarda de UNA de sus operaciones (la que solo da
// esa acción) y se comprueba: el rol que tiene la acción pasa (200); el rol que tiene TODAS las demás
// acciones y no esta, no (403 con el motivo de siempre, nunca «Función no reconocida»).
// No se monta el router de ningún módulo (memoria: arrastra ~786 tests seriales).
//
// Mutante nombrado: en `permisos-efectivos.ts`, devolver `conjunto` sin `expandir(…)` → todo 403.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { conCadenaEnFuente } from '../helpers/auth.js';
import { ancestrosDe } from '../../src/modules/permisos/arbol/expansion.js';

vi.mock('../../src/db/client.js', () => ({ db: {}, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/historial/permisos-intentos-denegados.js', () => ({ registrarIntentoDenegado: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/shared/logger.js', () => {
  const l = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { loggerFor: () => l, logger: l };
});

const { exigirFuncion } = await import('../../src/shared/middleware/exigir-funcion.js');
const { fijarFuenteDePermisos } = await import('../../src/shared/permisos-efectivos.js');
const { ACCIONES_GESTION } = await import('../../src/modules/permisos/arbol/acciones-gestion.js');
const { operacionesDe } = await import('../../src/modules/permisos/arbol/expansion.js');

const ACCIONES = Object.keys(ACCIONES_GESTION).sort();
/** La operación de muestra de cada acción: la primera que ninguna otra acción concede. */
const MUESTRA = ACCIONES.map((accion) => {
  const op = operacionesDe(accion).find((o) => !o.startsWith('pagina.')
    && ACCIONES.every((otra) => otra === accion || !operacionesDe(otra).includes(o)));
  return { accion, op: op! };
});

// Usuario 1: solo la acción i-ésima (se re-fija por caso). Usuario 2: todas MENOS la i-ésima.
let actual = '';
fijarFuenteDePermisos(conCadenaEnFuente(async (userId) => ({
  rol: `rol_${userId}`,
  tipoEnlace: 'ninguno',
  funcionesDelRol: userId === 1 ? [actual] : ACCIONES.filter((a) => a !== actual),
  excepciones: [],
})));

const app = express();
app.use((req: Request, _res: Response, next: NextFunction) => {
  const sub = Number(req.header('x-sub'));
  req.user = { sub, username: 'prueba', role: `rol_${sub}` } as Request['user'];
  next();
});
MUESTRA.forEach(({ op }, i) => app.get(`/m/${i}`, exigirFuncion(op), (_req: Request, res: Response) => { res.json({ ok: true }); }));

describe('AC6 — muestreo 200/403 por acción (guarda real, resolutor real)', () => {
  beforeAll(() => {
    expect(MUESTRA.filter((m) => !m.op).map((m) => m.accion)).toEqual([]);
    expect(MUESTRA.length).toBe(55);
  });

  it.each(MUESTRA.map((m, i) => [m.accion, m.op, i] as const))('%s → %s', async (accion, op, i) => {
    actual = accion;
    fijarFuenteDePermisos(conCadenaEnFuente(async (userId) => ({
      rol: `rol_${userId}`, tipoEnlace: 'ninguno', excepciones: [],
      // HU #13429: sin la acción NI sus hijas (una anidada exige a su madre: con la cadena, darla devolvería la madre).
      funcionesDelRol: userId === 1 ? [accion] : ACCIONES.filter((a) => a !== accion && !ancestrosDe(a).includes(accion)),
    })));
    const si = await request(app).get(`/m/${i}`).set('x-sub', '1');
    expect(si.status, `${accion} debería conceder ${op}`).toBe(200);
    const no = await request(app).get(`/m/${i}`).set('x-sub', '2');
    expect(no.status).toBe(403);
    // Sin «Función no reconocida»: la operación absorbida sigue en el índice de nombres del 403.
    expect(JSON.stringify(no.body)).toMatch(/Su rol no tiene esa función|No tiene acceso a este módulo/);
    expect(JSON.stringify(no.body)).not.toMatch(/no reconocida/);
  });

  it('la operación de conjunción (solicitar ambos) pasa solo con las dos acciones de solicitar', async () => {
    const appAmbos = express();
    appAmbos.use((req: Request, _res: Response, next: NextFunction) => {
      req.user = { sub: Number(req.header('x-sub')), username: 'prueba', role: 'r' } as Request['user'];
      next();
    });
    appAmbos.post('/ambos', exigirFuncion('tramites.solicitud.pedir_ambos'), (_req: Request, res: Response) => { res.json({ ok: true }); });
    const conjuntos: Record<number, string[]> = {
      1: ['accion.tramites.solicitar_soat', 'accion.tramites.solicitar_impuestos'],
      2: ['accion.tramites.solicitar_soat'],
      3: ['accion.tramites.solicitar_impuestos'],
    };
    fijarFuenteDePermisos(conCadenaEnFuente(async (userId) => ({ rol: 'r', tipoEnlace: 'ninguno', excepciones: [], funcionesDelRol: conjuntos[userId]! })));
    expect((await request(appAmbos).post('/ambos').set('x-sub', '1')).status).toBe(200);
    expect((await request(appAmbos).post('/ambos').set('x-sub', '2')).status).toBe(403);
    expect((await request(appAmbos).post('/ambos').set('x-sub', '3')).status).toBe(403);
  });
});
