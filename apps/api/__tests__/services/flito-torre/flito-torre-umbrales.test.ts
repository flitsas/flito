// Torre de Control Gerencial (Épica #14590) — rutas `/api/flito/torre` con supertest: umbrales completos (GET/PUT),
// 403 sin función y validación; el resto del contrato (consultar, exportar, placa, tableros) valida y llega a su servicio.
// Son reales `authMiddleware`, `exigirFuncion`, el Zod y la traducción a HTTP; los servicios (umbrales, motor, placa,
// tablero comercial) son dobles: su SQL se prueba contra PostgreSQL en `flito-torre-metricas.test.ts`.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { SignJWT } from 'jose';

vi.mock('../../../src/db/client.js', () => {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit', 'innerJoin', 'leftJoin']) c[m] = () => c;
  (c as { then: unknown }).then = (res: (v: unknown) => void) => res([]);
  return { db: { select: () => c, insert: () => ({ values: () => Promise.resolve() }) }, getPoolStats: vi.fn() };
});
vi.mock('../../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
const svc = { listarUmbrales: vi.fn(), actualizarUmbral: vi.fn() };
vi.mock('../../../src/modules/flito-torre/flito-torre.umbrales.service.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, ...svc };
});

const motor = { consultarMetrica: vi.fn() };
vi.mock('../../../src/modules/flito-torre/flito-torre.metricas.service.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, ...motor };
});
const placaSvc = { buscarPlaca: vi.fn() };
vi.mock('../../../src/modules/flito-torre/flito-torre.placa.service.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, ...placaSvc };
});
const comercialSvc = { tableroComercial: vi.fn() };
vi.mock('../../../src/modules/flito-torre/flito-torre.comercial.service.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, ...comercialSvc };
});
vi.mock('../../../src/shared/pii-audit.js', () => ({ logPiiAccess: vi.fn().mockResolvedValue(undefined) }));

const permisos = await import('../../../src/shared/permisos-efectivos.js');
const { errorDeRangoUmbral } = await import('../../../src/modules/flito-torre/flito-torre.umbrales.service.js');
const { default: router } = await import('../../../src/modules/flito-torre/flito-torre.routes.js');
const { default: tableros } = await import('../../../src/modules/flito-torre/flito-torre.tableros.routes.js');
import type { FilasPermisos } from '../../../src/shared/permisos-efectivos.js';
import { conCadena } from '../../helpers/auth.js';

const filas = new Map<number, FilasPermisos>();
const de = (id: number, funciones: string[], tipoEnlace = 'ninguno') => {
  filas.set(id, { rol: `r${id}`, tipoEnlace, proveedor: null, funcionesDelRol: conCadena(funciones), excepciones: [] });
};
const token = (sub: number) => new SignJWT({ username: 'u', role: 'x' }).setProtectedHeader({ alg: 'HS256' }).setSubject(String(sub))
  .setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));

const app = express();
app.use(express.json());
app.use('/api/flito/torre/tableros', tableros);
app.use('/api/flito/torre', router);

const pide = async (metodo: 'get' | 'post' | 'put', ruta: string, sub: number, body?: object) => {
  const r = request(app)[metodo](`/api/flito/torre${ruta}`).set('Authorization', `Bearer ${await token(sub)}`);
  return body === undefined ? r : r.send(body);
};

const UMBRAL = {
  clave: 'pct_caida_volumen', valor: 30, unidad: 'porcentaje', descripcion: 'Caída…', actualizadoPor: null, actualizadoEn: null,
};
const FILTRO = { rango: { preset: 'mes' } };

beforeEach(() => {
  filas.clear();
  permisos.fijarFuenteDePermisos(async (id: number) => filas.get(id) ?? null);
  for (const i of [1, 2, 3, 4]) permisos.invalidarPermisosDe(i);
  Object.values(svc).forEach((f) => f.mockReset());
  auditMock.mockClear();
  de(1, ['accion.torre_umbrales.ver', 'accion.torre_umbrales.editar', 'accion.torre_explorador.consultar',
    'accion.torre_explorador.exportar', 'accion.torre_explorador.buscar_placa', 'accion.torre_comercial.ver']);
  de(2, ['accion.torre_umbrales.ver', 'accion.torre_comercial.ver']); // como gerencia_general: ve, no edita
  de(3, []);
  svc.listarUmbrales.mockResolvedValue([UMBRAL]);
  svc.actualizarUmbral.mockResolvedValue({ anterior: 30, umbral: { ...UMBRAL, valor: 40 } });
});

describe('GET /umbrales', () => {
  it('200 con la lista a quien tiene «Ver los umbrales»', async () => {
    const r = await pide('get', '/umbrales', 2);
    expect(r.status).toBe(200);
    expect(r.body).toEqual([UMBRAL]);
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('403 sin la función', async () => {
    const r = await pide('get', '/umbrales', 3);
    expect(r.status).toBe(403);
    expect(r.body.funcion).toBe('torre.umbrales.ver');
    expect(svc.listarUmbrales).not.toHaveBeenCalled();
  });

  it('401 sin token', async () => {
    expect((await request(app).get('/api/flito/torre/umbrales')).status).toBe(401);
  });
});

describe('PUT /umbrales/:clave', () => {
  it('200, llama al servicio con el actor y deja rastro en audit()', async () => {
    const r = await pide('put', '/umbrales/pct_caida_volumen', 1, { valor: 40 });
    expect(r.status).toBe(200);
    expect(r.body.valor).toBe(40);
    expect(svc.actualizarUmbral).toHaveBeenCalledWith('pct_caida_volumen', 40, 1);
    expect(auditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'update', resource: 'flito_torre_umbral', resourceId: 'pct_caida_volumen', detail: expect.stringContaining('30 → 40'),
    }));
  });

  it('403 a quien solo ve los umbrales (gerencia_general): editar es de admin', async () => {
    const r = await pide('put', '/umbrales/pct_caida_volumen', 2, { valor: 40 });
    expect(r.status).toBe(403);
    expect(r.body.funcion).toBe('torre.umbrales.editar');
    expect(svc.actualizarUmbral).not.toHaveBeenCalled();
  });

  it('400 si un porcentaje pasa de 100, sin tocar la base', async () => {
    const r = await pide('put', '/umbrales/pct_caida_volumen', 1, { valor: 100.01 });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: 'UMBRAL_FUERA_DE_RANGO', campo: 'valor' });
    expect(svc.actualizarUmbral).not.toHaveBeenCalled();
  });

  it('un porcentaje de exactamente 100 vale; un umbral en días por encima de 100 también', async () => {
    expect((await pide('put', '/umbrales/pct_caida_volumen', 1, { valor: 100 })).status).toBe(200);
    expect((await pide('put', '/umbrales/dias_ventana_fuga', 1, { valor: 180 })).status).toBe(200);
  });

  it('400 con negativo, más de dos decimales, campo extra o clave fuera del catálogo', async () => {
    for (const [ruta, body] of [
      ['/umbrales/dias_ventana_fuga', { valor: -1 }],
      ['/umbrales/dias_ventana_fuga', { valor: 1.234 }],
      ['/umbrales/dias_ventana_fuga', { valor: 1, unidad: 'horas' }],
      ['/umbrales/no_existe', { valor: 1 }],
    ] as const) {
      const r = await pide('put', ruta, 1, body);
      expect(r.status, `${ruta} ${JSON.stringify(body)}`).toBe(400);
    }
    expect(svc.actualizarUmbral).not.toHaveBeenCalled();
  });

  it('errorDeRangoUmbral: el porcentaje va de 0 a 100; el resto solo exige ≥ 0', () => {
    expect(errorDeRangoUmbral('porcentaje', 101)).not.toBeNull();
    expect(errorDeRangoUmbral('porcentaje', 0)).toBeNull();
    expect(errorDeRangoUmbral('dias', 101)).toBeNull();
    expect(errorDeRangoUmbral('horas', -1)).not.toBeNull();
  });
});

describe('contrato de las rutas (validan y llegan al servicio)', () => {
  it('consultar: 400 con métrica fuera del catálogo o agrupación no permitida; 200 con una consulta válida', async () => {
    motor.consultarMetrica.mockResolvedValue({ metrica: 'tramites_creados' });
    expect((await pide('post', '/metricas/consultar', 1, { metrica: 'x', filtro: FILTRO })).status).toBe(400);
    expect((await pide('post', '/metricas/consultar', 1, { metrica: 'wip_activo', agrupacion: 'dia', filtro: FILTRO })).status).toBe(400);
    expect((await pide('post', '/metricas/consultar', 1, { metrica: 'tramites_creados', filtro: FILTRO, sql: '1' })).status).toBe(400);
    const r = await pide('post', '/metricas/consultar', 1, { metrica: 'tramites_creados', agrupacion: 'mes', filtro: FILTRO });
    expect(r.status).toBe(200);
    expect(motor.consultarMetrica).toHaveBeenCalledTimes(1);
  });

  it('cada ruta exige su función: 403 sin ella', async () => {
    for (const [ruta, body, fn] of [
      ['/metricas/consultar', { metrica: 'tramites_creados', filtro: FILTRO }, 'torre.metricas.consultar'],
      ['/metricas/exportar', { consulta: { metrica: 'tramites_creados', filtro: FILTRO }, formato: 'xlsx' }, 'torre.metricas.exportar'],
      ['/placa/buscar', { placa: 'ABC123' }, 'torre.placa.buscar'],
      ['/tableros/financiera', { filtro: FILTRO }, 'torre.tablero_financiero.ver'],
    ] as const) {
      const r = await pide('post', ruta, 3, body);
      expect(r.status, ruta).toBe(403);
      expect(r.body.funcion).toBe(fn);
    }
  });

  it('placa por body: 400 si no es una placa; 200 si lo es', async () => {
    placaSvc.buscarPlaca.mockResolvedValue({ placa: 'ABC123', tramites: [] });
    expect((await pide('post', '/placa/buscar', 1, { placa: 'AB-12' })).status).toBe(400);
    expect((await pide('post', '/placa/buscar', 1, { placa: 'ABC123' })).status).toBe(200);
  });

  it('tableros: tener el comercial no abre el financiero; rango desde > hasta es 400', async () => {
    comercialSvc.tableroComercial.mockResolvedValue({ cifras: {} });
    expect((await pide('post', '/tableros/comercial', 2, { filtro: FILTRO })).status).toBe(200);
    expect((await pide('post', '/tableros/financiera', 2, { filtro: FILTRO })).status).toBe(403);
    expect((await pide('post', '/tableros/comercial', 2, { filtro: { rango: { desde: '2026-02-01', hasta: '2026-01-01' } } })).status).toBe(400);
  });

  it('un rol con enlace (cliente) no entra aunque tenga la función: la Torre es de la operación', async () => {
    de(4, ['accion.torre_umbrales.ver'], 'compania');
    expect((await pide('get', '/umbrales', 4)).status).toBe(403);
  });
});
