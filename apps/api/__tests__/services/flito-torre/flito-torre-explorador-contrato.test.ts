// Torre de Control — Explorador flexible (Épica #14590, ADR-0044), contract-first (bloque i): la matriz medida × fecha
// base y las combinaciones de agrupación dan 400 en Zod (RN-TOR-M10/M11, RN-TOR-C1); lo que ya valida pero el motor aún
// no resuelve da 501; `POST /placa/sugerencias` queda montada con su cadena completa y su servicio en STUB (501); y el
// preset `ultimos_6m` se alinea al mes (RN-TOR-F5). Reales: `authMiddleware`, `exigirFuncion`, Zod y el stub.
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

const permisos = await import('../../../src/shared/permisos-efectivos.js');
const { default: router } = await import('../../../src/modules/flito-torre/flito-torre.routes.js');
const { resolverRango } = await import('../../../src/modules/flito-torre/flito-torre.filtro.js');
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
app.use('/api/flito/torre', router);
const pide = async (ruta: string, sub: number, body: object) =>
  request(app).post(`/api/flito/torre${ruta}`).set('Authorization', `Bearer ${await token(sub)}`).send(body);

const EXPLORADOR = ['accion.torre_explorador.consultar', 'accion.torre_explorador.buscar_placa', 'accion.torre_explorador.ver_dinero'];
const MARZO = { rango: { desde: '2035-03-01', hasta: '2035-03-31' } };

beforeEach(() => {
  filas.clear();
  permisos.fijarFuenteDePermisos(async (id: number) => filas.get(id) ?? null);
  for (const i of [1, 2]) permisos.invalidarPermisosDe(i);
  pii.mockClear();
  de(1, EXPLORADOR);
  de(2, ['accion.torre_explorador.consultar']); // sin la función de placa
});

describe('consultaMetricaSchema v2 por HTTP (RN-TOR-M11, RN-TOR-C1)', () => {
  it.each([
    ['tiempo de ciclo por creación (D9)', { metrica: 'tiempo_creacion_aprobacion', fechaBase: 'creacion' }, 'fechaBase'],
    ['impuestos por facturación', { metrica: 'impuestos_pagados', fechaBase: 'facturacion' }, 'fechaBase'],
    ['tramites por pago', { metrica: 'tramites', fechaBase: 'pago' }, 'fechaBase'],
    ['fecha base en una foto (wip_activo)', { metrica: 'wip_activo', fechaBase: 'creacion' }, 'fechaBase'],
    ['fecha base fuera del catálogo', { metrica: 'tramites', fechaBase: 'liquidacion' }, 'fechaBase'],
    ['columnas sin agrupación principal', { metrica: 'tramites', agrupacionColumnas: 'mes' }, 'agrupacionColumnas'],
    ['la misma agrupación dos veces', { metrica: 'tramites', agrupacion: 'compania', agrupacionColumnas: 'compania' }, 'agrupacionColumnas'],
    ['dos agrupaciones temporales', { metrica: 'tramites', agrupacion: 'mes', agrupacionColumnas: 'semana' }, 'agrupacionColumnas'],
    ['columnas no permitidas por la métrica', { metrica: 'wip_activo', agrupacion: 'compania', agrupacionColumnas: 'mes' }, 'agrupacionColumnas'],
  ])('400 DATOS_INVALIDOS: %s', async (_caso, consulta, campo) => {
    const r = await pide('/metricas/consultar', 1, { ...consulta, filtro: MARZO });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('DATOS_INVALIDOS');
    expect(r.body.error).toContain(campo);
  });

  it.each([
    ['dos agrupaciones válidas', { metrica: 'tramites', agrupacion: 'compania', agrupacionColumnas: 'mes' }],
    ['una fecha base admitida distinta de la de defecto', { metrica: 'tramites', fechaBase: 'aprobacion' }],
  ])('501 hasta el bloque (ii): %s pasa Zod pero el motor aún no la resuelve', async (_caso, consulta) => {
    const r = await pide('/metricas/consultar', 1, { ...consulta, filtro: { rango: { preset: 'ultimos_6m' } } });
    expect(r.status).toBe(501);
  });
});

describe('POST /placa/sugerencias (contract-first)', () => {
  it('responde 501 del stub, con no-store y logPiiAccess (search, placa) sin el texto', async () => {
    const r = await pide('/placa/sugerencias', 1, { texto: 'bc12' });
    expect(r.status).toBe(501);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(pii).toHaveBeenCalledTimes(1);
    expect(pii.mock.calls[0]![1]).toMatchObject({ resourceTipo: 'flito_tramite', accion: 'search', camposAccedidos: ['placa'] });
    expect(JSON.stringify(pii.mock.calls[0]![1])).not.toMatch(/bc12/i);
  });

  it.each([
    ['2 caracteres', { texto: 'AB' }],
    ['con guion', { texto: 'ABC-12' }],
    ['8 caracteres', { texto: 'ABCD1234' }],
    ['un campo extra', { texto: 'ABC', placa: 'ABC123' }],
  ])('400 DATOS_INVALIDOS (%s), sin eco del texto y sin logPiiAccess', async (_caso, body) => {
    const r = await pide('/placa/sugerencias', 1, body);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('DATOS_INVALIDOS');
    expect(r.body.error).not.toContain(body.texto);
    expect(pii).not.toHaveBeenCalled();
  });

  it('403 sin la función de la ficha (torre.placa.buscar)', async () => {
    expect((await pide('/placa/sugerencias', 2, { texto: 'ABC' })).status).toBe(403);
    expect(pii).not.toHaveBeenCalled();
  });
});

describe('preset ultimos_6m (RN-TOR-F5)', () => {
  it.each([
    ['2026-11-18', '2026-06-01'],
    ['2026-03-05', '2025-10-01'],
    ['2026-05-31', '2025-12-01'],
    ['2026-06-01', '2026-01-01'],
  ])('hoy %s → desde %s hasta hoy', (hoy, desde) => {
    expect(resolverRango({ preset: 'ultimos_6m' }, hoy)).toEqual({ desde, hasta: hoy });
  });
});
