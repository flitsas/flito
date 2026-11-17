// Torre de Control Gerencial (Épica #14590) — rutas del motor con supertest: 403 de dinero, 400 por tope de rango (los
// dos antes de tocar la base, con el motor REAL), ficha de placa con `logPiiAccess` y 404 indistinto, y el permiso de
// dinero que llega a los tableros. Son reales `authMiddleware`, `exigirFuncion`/`tieneFuncion`, Zod y el motor; la
// base no se toca (el SQL se prueba en `flito-torre-metricas.test.ts`).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { SignJWT } from 'jose';

vi.mock('../../../src/db/client.js', () => {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit', 'innerJoin', 'leftJoin']) c[m] = () => c;
  (c as { then: unknown }).then = (res: (v: unknown) => void) => res([]);
  return {
    db: { select: () => c, insert: () => ({ values: () => Promise.resolve() }), transaction: () => Promise.reject(new Error('sin base en este archivo')) },
    getPoolStats: vi.fn(),
  };
});
vi.mock('../../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
const pii = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../src/shared/pii-audit.js', () => ({ logPiiAccess: pii }));
const placaSvc = { buscarPlaca: vi.fn() };
vi.mock('../../../src/modules/flito-torre/flito-torre.placa.service.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, ...placaSvc };
});
const finSvc = { tableroFinanciero: vi.fn() };
vi.mock('../../../src/modules/flito-torre/flito-torre.financiera.service.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, ...finSvc };
});

const permisos = await import('../../../src/shared/permisos-efectivos.js');
const { PlacaTorreNoEncontradaError } = await import('../../../src/modules/flito-torre/flito-torre.placa.service.js');
const { default: router } = await import('../../../src/modules/flito-torre/flito-torre.routes.js');
const { default: tableros } = await import('../../../src/modules/flito-torre/flito-torre.tableros.routes.js');
import type { FilasPermisos } from '../../../src/shared/permisos-efectivos.js';
import { conCadena } from '../../helpers/auth.js';

const filas = new Map<number, FilasPermisos>();
const de = (id: number, funciones: string[]) => {
  filas.set(id, { rol: `r${id}`, tipoEnlace: 'ninguno', proveedor: null, funcionesDelRol: conCadena(funciones), excepciones: [] });
};
const token = (sub: number) => new SignJWT({ username: 'u', role: 'x' }).setProtectedHeader({ alg: 'HS256' }).setSubject(String(sub))
  .setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));

const app = express();
app.use(express.json());
app.use('/api/flito/torre/tableros', tableros);
app.use('/api/flito/torre', router);
const pide = async (ruta: string, sub: number, body: object) =>
  request(app).post(`/api/flito/torre${ruta}`).set('Authorization', `Bearer ${await token(sub)}`).send(body);

const EXPLORADOR = ['accion.torre_explorador.consultar', 'accion.torre_explorador.exportar', 'accion.torre_explorador.buscar_placa', 'accion.torre_financiera.ver'];
const MARZO = { rango: { desde: '2035-03-01', hasta: '2035-03-31' } };

beforeEach(() => {
  filas.clear();
  permisos.fijarFuenteDePermisos(async (id: number) => filas.get(id) ?? null);
  for (const i of [1, 2]) permisos.invalidarPermisosDe(i);
  pii.mockClear(); placaSvc.buscarPlaca.mockReset(); finSvc.tableroFinanciero.mockReset();
  de(1, EXPLORADOR);                                            // sin dinero
  de(2, [...EXPLORADOR, 'accion.torre_explorador.ver_dinero']); // con dinero
});

describe('motor por HTTP', () => {
  it('403 TORRE_DINERO_DENEGADO al consultar o exportar una métrica de dinero sin la función', async () => {
    const r = await pide('/metricas/consultar', 1, { metrica: 'costo_logistica', filtro: MARZO });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('TORRE_DINERO_DENEGADO');
    const x = await pide('/metricas/exportar', 1, { consulta: { metrica: 'impuestos_pagados', filtro: MARZO }, formato: 'xlsx' });
    expect(x.status).toBe(403);
  });

  it('400 RANGO_EXCEDIDO con más de 24 meses, o más de 366 días agrupando por día', async () => {
    const r = await pide('/metricas/consultar', 2, { metrica: 'tramites_creados', filtro: { rango: { desde: '2030-01-01', hasta: '2035-01-01' } } });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: 'RANGO_EXCEDIDO', campo: 'rango' });
    const d = await pide('/metricas/consultar', 2, { metrica: 'tramites_creados', agrupacion: 'dia', filtro: { rango: { desde: '2034-01-01', hasta: '2035-01-31' } } });
    expect(d.status).toBe(400);
  });

  it('un fallo de la base es un 500 genérico, sin SQL ni parámetros', async () => {
    const r = await pide('/metricas/consultar', 2, { metrica: 'tramites_creados', filtro: { ...MARZO, companiaIds: [77] } });
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'No pudimos calcular la información de la Torre. Intente de nuevo.', code: 'TORRE_ERROR' });
  });

  it('exportar a PDF sigue en 501', async () => {
    expect((await pide('/metricas/exportar', 2, { consulta: { metrica: 'tramites_creados', filtro: MARZO }, formato: 'pdf' })).status).toBe(501);
  });
});

describe('ficha de placa por HTTP', () => {
  it('normaliza la placa del body, registra logPiiAccess (search, placa) y responde la lista', async () => {
    placaSvc.buscarPlaca.mockResolvedValue({ placa: 'ABC123', tramites: [{ tramiteUuid: 'u1' }] });
    const r = await pide('/placa/buscar', 1, { placa: ' abc123 ' });
    expect(r.status).toBe(200);
    expect(placaSvc.buscarPlaca).toHaveBeenCalledWith('abc123', { enlace: 'ninguno' });
    expect(pii).toHaveBeenCalledTimes(1);
    expect(pii.mock.calls[0]![1]).toMatchObject({ accion: 'search', camposAccedidos: ['placa'], resourceTipo: 'flito_tramite' });
    expect(JSON.stringify(pii.mock.calls[0]![1])).not.toMatch(/abc123/i);
  });

  it('no encontrada (o fuera de alcance): 404 PLACA_NO_ENCONTRADA, y la búsqueda igual queda en el log', async () => {
    placaSvc.buscarPlaca.mockRejectedValue(new PlacaTorreNoEncontradaError());
    const r = await pide('/placa/buscar', 1, { placa: 'ZZZ999' });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('PLACA_NO_ENCONTRADA');
    expect(pii).toHaveBeenCalledTimes(1);
  });
});

describe('tableros por HTTP', () => {
  it('el permiso de dinero llega al servicio: sin la función, `dinero: false`', async () => {
    finSvc.tableroFinanciero.mockResolvedValue({ ok: true });
    expect((await pide('/tableros/financiera', 1, { filtro: MARZO })).status).toBe(200);
    expect(finSvc.tableroFinanciero.mock.calls[0]![0]).toMatchObject({ dinero: false, alcance: { enlace: 'ninguno' }, filtro: MARZO });
    await pide('/tableros/financiera', 2, { filtro: MARZO });
    expect(finSvc.tableroFinanciero.mock.calls[1]![0]).toMatchObject({ dinero: true });
  });
});
