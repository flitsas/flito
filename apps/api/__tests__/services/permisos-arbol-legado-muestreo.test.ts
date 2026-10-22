// HU #13429 AC2 / TC-05 — Muestreo 200/403 por ítem antiguo, por HTTP: la guarda real (`exigirFuncion`) sobre el
// resolutor real (fuente de filas de pruebas). Con el ítem y su elemento → 200; sin el ítem (o sin el elemento) →
// 403 y fila en la bitácora de intentos denegados. Para PESV (A1) la administración la da «Administrar», no el ítem.
// Todo 403 se decide ANTES de tocar la base.
//
// Mutante nombrado: expandir el ítem antiguo sin mirar su elemento → cae «sin el elemento: 403».
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

const selectMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/db/client.js', () => ({ db: { select: selectMock }, getPoolStats: vi.fn() }));
const bitacora = vi.hoisted(() => ({ registrarIntentoDenegado: vi.fn(async (_fila: { metodo: string; codigo: string; userId: number }) => undefined) }));
vi.mock('../../src/shared/historial/permisos-intentos-denegados.js', () => bitacora);
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/shared/logger.js', () => {
  const l = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { loggerFor: () => l, logger: l };
});

const { exigirFuncion } = await import('../../src/shared/middleware/exigir-funcion.js');
const { fijarFuenteDePermisos, invalidarPermisosDe } = await import('../../src/shared/permisos-efectivos.js');
const { PADRE } = await import('../../src/modules/permisos/arbol/expansion.js');
const { ITEMS_LEGADO_OPS } = await import('../../src/modules/permisos/arbol/acciones-legado.js');

/** Una operación de escritura por ítem antiguo que expande algo (la primera `.administrar`, o la primera). */
const MUESTRA = Object.entries(ITEMS_LEGADO_OPS).filter(([, i]) => i.operaciones.length)
  .map(([item, i]) => ({ item, op: i.operaciones.find((o) => o.endsWith('.administrar')) ?? i.operaciones[0]! }));

let conjuntos: Record<number, readonly string[]> = {};
function fijar(c: Record<number, readonly string[]>) {
  conjuntos = c;
  for (const id of Object.keys(c)) invalidarPermisosDe(Number(id));
  fijarFuenteDePermisos(async (userId) => ({ rol: `rol_${userId}`, tipoEnlace: 'ninguno', excepciones: [], funcionesDelRol: [...(conjuntos[userId] ?? [])] }));
}

const lab = express();
lab.use((req: Request, _res: Response, next: NextFunction) => {
  const sub = Number(req.header('x-sub'));
  req.user = { sub, username: 'prueba', role: `rol_${sub}` } as Request['user'];
  next();
});
const ok = (_req: Request, res: Response) => { res.json({ ok: true }); };
MUESTRA.forEach(({ op }, i) => lab.post(`/m/${i}`, exigirFuncion(op), ok));
lab.post('/pesv-plan', exigirFuncion('pesv.plan.administrar'), ok);

beforeEach(() => {
  bitacora.registrarIntentoDenegado.mockClear();
  selectMock.mockReset();
});

describe('AC2 / TC-05 — ítem antiguo: 200 con el ítem y su elemento, 403 sin él', () => {
  it('la muestra cubre los ítems antiguos que expanden (18)', () => {
    expect(MUESTRA).toHaveLength(18);
  });

  it.each(MUESTRA.map((m, i) => [m.item, m.op, i] as const))('%s → %s', async (item, op, i) => {
    const elemento = PADRE.get(item)!;
    fijar({ 1: [elemento, item], 2: [elemento], 3: [item] });
    expect((await request(lab).post(`/m/${i}`).set('x-sub', '1')).status).toBe(200);
    expect((await request(lab).post(`/m/${i}`).set('x-sub', '2')).status).toBe(403);
    expect((await request(lab).post(`/m/${i}`).set('x-sub', '3')).status).toBe(403);
    const filas = bitacora.registrarIntentoDenegado.mock.calls.map(([f]) => `${f.metodo} ${f.codigo} ${f.userId}`);
    expect(filas).toEqual([`POST ${op} 2`, `POST ${op} 3`]);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('P-24 A1: el ítem PESV solo no administra; con «Administrar» sí', async () => {
    fijar({ 1: ['menu.pesv', 'pagina.pesv_plan'], 2: ['menu.pesv', 'pagina.pesv_plan', 'accion.pesv_plan.administrar'] });
    expect((await request(lab).post('/pesv-plan').set('x-sub', '1')).status).toBe(403);
    expect((await request(lab).post('/pesv-plan').set('x-sub', '2')).status).toBe(200);
  });
});
