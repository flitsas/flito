// Torre de Control — Explorador flexible (Épica #14590, ADR-0044): la matriz medida × fecha base y las combinaciones de
// agrupación dan 400 en Zod (RN-TOR-M10/M11, RN-TOR-C1); lo que valida llega al motor (bloque ii: ya no hay 501);
// `POST /placa/sugerencias` con su cadena completa responde 200 (lista vacía = 200, nunca 404) con `no-store` y
// `logPiiAccess`; y el preset `ultimos_6m` se alinea al mes (RN-TOR-F5). Reales: `authMiddleware`, `exigirFuncion`,
// Zod, el motor y el servicio; la base es un ejecutor que devuelve 0 filas (el SQL se prueba en los archivos de PG).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { SignJWT } from 'jose';

vi.mock('../../../src/db/client.js', () => {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit', 'innerJoin', 'leftJoin']) c[m] = () => c;
  (c as { then: unknown }).then = (res: (v: unknown) => void) => res([]);
  return {
    db: {
      select: () => c, insert: () => ({ values: () => Promise.resolve() }),
      transaction: async (fn: (tx: { execute: () => Promise<unknown[]> }) => Promise<unknown>) => fn({ execute: async () => [] }),
    },
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
    ['top fuera de 5/10/20/50 (RN-TOR-K4)', { metrica: 'tramites', agrupacion: 'compania', top: 7 }, 'top'],
    ['top no entero', { metrica: 'tramites', agrupacion: 'compania', top: 'diez' }, 'top'],
    ['comparar en una foto (RN-TOR-K2)', { metrica: 'wip_activo', comparar: true }, 'comparar'],
    ['comparar en el cruce (RN-TOR-K2)', { metrica: 'tramites', agrupacion: 'compania', agrupacionColumnas: 'mes', comparar: true }, 'comparar'],
    ['comparar no booleano', { metrica: 'tramites', comparar: 'si' }, 'comparar'],
  ])('400 DATOS_INVALIDOS: %s', async (_caso, consulta, campo) => {
    const r = await pide('/metricas/consultar', 1, { ...consulta, filtro: MARZO });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('DATOS_INVALIDOS');
    expect(r.body.error).toContain(campo);
  });

  it.each([
    ['dos agrupaciones válidas', { metrica: 'tramites', agrupacion: 'compania', agrupacionColumnas: 'mes' }, 'creacion'],
    ['una fecha base admitida distinta de la de defecto', { metrica: 'tramites', fechaBase: 'aprobacion' }, 'aprobacion'],
    ['facturación', { metrica: 'ingreso_liquidado', fechaBase: 'facturacion' }, 'facturacion'],
  ])('200 (sin la guarda 501 del bloque i): %s llega al motor y declara la fecha base aplicada', async (_caso, consulta, fechaBase) => {
    const r = await pide('/metricas/consultar', 1, { ...consulta, filtro: { rango: { preset: 'ultimos_6m' } } });
    expect(r.status).toBe(200);
    expect(r.body.baseFecha.fechaBase).toBe(fechaBase);
    if ('agrupacionColumnas' in consulta) expect(r.body.cruce).toEqual({ agrupacion: 'mes', columnas: [], celdas: [], truncadoColumnas: false });
    else expect(r.body.cruce).toBeUndefined();
  });

  it('200 aditivo (RN-TOR-K1..K4): `top` y `comparar` llegan al motor; sin ellos no hay `anterior`', async () => {
    const r = await pide('/metricas/consultar', 1, { metrica: 'tramites', agrupacion: 'compania', top: 5, comparar: true, filtro: { rango: { preset: 'mes' } } });
    expect(r.status).toBe(200);
    expect(r.body.anterior).toMatchObject({ total: { valor: 0, n: 0 }, variacion: null, en: 'relativa', filas: [] });
    const [d, h] = [r.body.rango.desde as string, r.body.anterior.rango.hasta as string];
    expect(Date.parse(`${d}T00:00:00Z`) - Date.parse(`${h}T00:00:00Z`)).toBe(86_400_000); // termina el día antes
    const sin = await pide('/metricas/consultar', 1, { metrica: 'tramites', agrupacion: 'compania', top: 50, filtro: MARZO });
    expect(sin.status).toBe(200);
    expect(sin.body).not.toHaveProperty('anterior');
  });

  it('400 RANGO_EXCEDIDO (campo rango) si el eje temporal del cruce pasa de 62 cortes', async () => {
    const r = await pide('/metricas/consultar', 1, { metrica: 'tramites', agrupacion: 'compania', agrupacionColumnas: 'dia', filtro: { rango: { desde: '2035-01-01', hasta: '2035-03-31' } } });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: 'RANGO_EXCEDIDO', campo: 'rango' });
    expect(r.body.error).toContain('62 cortes por día');
  });
});

describe('POST /placa/sugerencias', () => {
  it('lista vacía = 200 { sugerencias: [], hayMas: false }, con no-store y logPiiAccess (search, placa) sin el texto', async () => {
    const r = await pide('/placa/sugerencias', 1, { texto: 'bc12' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ sugerencias: [], hayMas: false });
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
