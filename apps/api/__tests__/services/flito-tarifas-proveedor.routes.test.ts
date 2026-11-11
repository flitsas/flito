// Épica #13763 (ADR-0041 §6, §8) — rutas `/api/flito/parametrizacion/tarifas-proveedores` con supertest. El servicio es
// doble (sus reglas se prueban en `flito-tarifas-proveedor.test.ts` y contra PG en `db/flito-tarifas-proveedor.pg.test.ts`);
// aquí son reales el `authMiddleware`, la frontera por enlace, `exigirFuncion`, el Zod y la traducción de errores a HTTP.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { SignJWT } from 'jose';
import {
  CODIGO_TARIFA_PROVEEDOR_CAMBIADA, MENSAJE_TARIFA_PROVEEDOR_CAMBIADA_POR_OTRO, MENSAJE_VALOR_COSTO_INVALIDO,
} from '@operaciones/shared-types';

vi.mock('../../src/db/client.js', () => {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit', 'innerJoin', 'leftJoin']) c[m] = () => c;
  (c as { then: unknown }).then = (res: (v: unknown) => void) => res([]);
  return { db: { select: () => c, insert: () => ({ values: () => Promise.resolve() }) }, getPoolStats: vi.fn() };
});
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));

const svc = {
  listarProveedoresConCostos: vi.fn(), vistaCostosProveedor: vi.fn(), historialCostosProveedor: vi.fn(),
  fijarCosto: vi.fn(), cambiarOCerrarCosto: vi.fn(),
};
vi.mock('../../src/modules/flito-parametrizacion/flito-tarifas-proveedor.service.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, ...svc };
});

const permisos = await import('../../src/shared/permisos-efectivos.js');
const servicio = await import('../../src/modules/flito-parametrizacion/flito-tarifas-proveedor.service.js');
const { default: router } = await import('../../src/modules/flito-parametrizacion/flito-tarifas-proveedor.routes.js');
import type { FilasPermisos, ProveedorDePermisos } from '../../src/shared/permisos-efectivos.js';
import { conCadena, soloEstas } from '../helpers/auth.js';

const FN = {
  listar: 'parametrizacion.tarifas.listar', historial: 'parametrizacion.tarifas.historial',
  crear: 'parametrizacion.tarifas.crear', editar: 'parametrizacion.tarifas.editar',
};
const TODAS = Object.values(FN);
const filas = new Map<number, FilasPermisos>();
const de = (id: number, funciones: string[], tipoEnlace = 'ninguno', proveedor: ProveedorDePermisos | null = null) => {
  filas.set(id, { rol: `r${id}`, tipoEnlace, proveedor, funcionesDelRol: conCadena(funciones), excepciones: [] });
};
const token = (sub: number) => new SignJWT({ username: 'u', role: 'x' }).setProtectedHeader({ alg: 'HS256' }).setSubject(String(sub))
  .setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));

const BASE = '/api/flito/parametrizacion/tarifas-proveedores';
const app = express();
app.use(express.json());
app.use(BASE, router);

const P_ID = '11111111-1111-4111-8111-111111111111';
const V_ID = '22222222-2222-4222-8222-222222222222';
const VIGENCIA = {
  id: V_ID, proveedorId: P_ID, servicio: 'logistica', concepto: 'logistica', valor: 0, vigenteDesde: '2026-11-11T10:00:00.000Z',
  vigenteHasta: null, fijadoPor: { id: 1, nombre: 'Ana' }, fijadoEn: '2026-11-11T10:00:00.000Z', cerradoPor: null, cerradoEn: null,
  servicioAsignado: true,
};
const VISTA = (activo = true, eliminado = false) => ({
  proveedor: { id: P_ID, nombre: 'Mensajería Sur', activo, eliminado },
  filas: [{ servicio: 'logistica', concepto: 'logistica', vigencia: VIGENCIA }],
});

type Metodo = 'get' | 'post' | 'patch';
const pide = async (metodo: Metodo, ruta: string, sub: number, body?: unknown) => {
  const r = request(app)[metodo](`${BASE}${ruta}`).set('Authorization', `Bearer ${await token(sub)}`);
  return body === undefined ? r : r.send(body as object);
};
const CINCO: [Metodo, string, unknown?][] = [
  ['get', '/'], ['get', `/${P_ID}`], ['get', `/${P_ID}/historial`],
  ['post', `/${P_ID}/vigencias`, { concepto: 'logistica', valor: 1000 }], ['patch', `/vigencias/${V_ID}`, { valor: 2000 }],
];

beforeEach(() => {
  filas.clear();
  permisos.fijarFuenteDePermisos(async (id: number) => filas.get(id) ?? null);
  Object.values(svc).forEach((f) => f.mockReset());
  auditMock.mockClear();
  de(1, TODAS);
  svc.listarProveedoresConCostos.mockResolvedValue([{ id: P_ID, nombre: 'Mensajería Sur', servicios: ['logistica'], conceptos: 1, faltan: 0 }]);
  svc.vistaCostosProveedor.mockResolvedValue(VISTA());
  svc.historialCostosProveedor.mockResolvedValue([VIGENCIA]);
  svc.fijarCosto.mockResolvedValue({ resultado: VIGENCIA, proveedorNombre: 'Mensajería Sur' });
  svc.cambiarOCerrarCosto.mockResolvedValue({
    resultado: { vigencia: { ...VIGENCIA, valor: 2000 }, accion: 'cambiada', valorAnterior: 0, valorNuevo: 2000 }, proveedorNombre: 'Mensajería Sur',
  });
});

describe('R3 — 400 con el mensaje literal del valor', () => {
  it.each([['vacío', ''], ['null', null], ['texto', 'abc'], ['negativo', -1]])('POST con valor %s → 400 literal', async (_n, valor) => {
    const r = await pide('post', `/${P_ID}/vigencias`, 1, { concepto: 'logistica', valor });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: MENSAJE_VALOR_COSTO_INVALIDO, campo: 'valor', code: 'VALOR_INVALIDO' });
    expect(svc.fijarCosto).not.toHaveBeenCalled();
  });

  it('PATCH con valor negativo → 400 literal; sin valor ni cerrar → 400 DATOS_INVALIDOS', async () => {
    const neg = await pide('patch', `/vigencias/${V_ID}`, 1, { valor: -5 });
    expect(neg.status).toBe(400);
    expect(neg.body.error).toBe(MENSAJE_VALOR_COSTO_INVALIDO);
    const vacio = await pide('patch', `/vigencias/${V_ID}`, 1, { valor: 1, cerrar: true });
    expect(vacio.status).toBe(400);
    expect(vacio.body.code).toBe('DATOS_INVALIDOS');
  });

  it('R4 — $0 es válido: POST con valor 0 → 201 y audit de creación', async () => {
    const r = await pide('post', `/${P_ID}/vigencias`, 1, { concepto: 'logistica', valor: 0 });
    expect(r.status).toBe(201);
    expect(r.body.valor).toBe(0);
    expect(r.body).not.toHaveProperty('proveedorNombre');
    expect(svc.fijarCosto).toHaveBeenCalledWith({ proveedorId: P_ID, concepto: 'logistica', valor: 0 }, 1);
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0]![1]).toMatchObject({ action: 'create', resource: 'flito_tarifa_proveedor_vigencia', resourceId: V_ID });
    expect(auditMock.mock.calls[0]![1].detail).toContain('Mensajería Sur');
  });

  it('concepto fuera del catálogo y uuid mal formado → 400 DATOS_INVALIDOS', async () => {
    expect((await pide('post', `/${P_ID}/vigencias`, 1, { concepto: 'tramite_digital', valor: 1 })).body.code).toBe('DATOS_INVALIDOS');
    expect((await pide('get', '/no-es-uuid', 1)).status).toBe(400);
  });
});

describe('R7 — permisos y frontera', () => {
  it('sin ninguna función → 403 en las cinco rutas', async () => {
    de(2, []);
    for (const [m, ruta, body] of CINCO) expect((await pide(m, ruta, 2, body)).status, `${m} ${ruta}`).toBe(403);
  });

  it.each([
    ['proveedor', { id: P_ID, activo: true, servicios: ['soat', 'logistica'] } as ProveedorDePermisos],
    ['compania', null],
  ])('enlace %s con las cuatro funciones concedidas → 403 en las cinco rutas, sin importes', async (enlace, proveedor) => {
    de(3, TODAS, enlace, proveedor);
    for (const [m, ruta, body] of CINCO) {
      const r = await pide(m, ruta, 3, body);
      expect(r.status, `${m} ${ruta}`).toBe(403);
      expect(JSON.stringify(r.body)).not.toMatch(/valor|Mensajería/);
    }
    Object.values(svc).forEach((f) => expect(f).not.toHaveBeenCalled());
  });

  it('solo listar: la vista responde con capacidades.editar=false y verHistorial=false; POST → 403', async () => {
    // «Ver las tarifas» trae por su acción a sus hermanas; `soloEstas` deja exactamente `listar`.
    filas.set(4, { rol: 'r4', tipoEnlace: 'ninguno', proveedor: null, ...soloEstas([FN.listar]) });
    const r = await pide('get', `/${P_ID}`, 4);
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body.capacidades).toEqual({ editar: false, verHistorial: false });
    expect((await pide('post', `/${P_ID}/vigencias`, 4, { concepto: 'logistica', valor: 1 })).status).toBe(403);
  });

  it('con todas las funciones y proveedor activo: capacidades.editar=true', async () => {
    const r = await pide('get', `/${P_ID}`, 1);
    expect(r.body.capacidades).toEqual({ editar: true, verHistorial: true });
  });

  it('R5 — proveedor inactivo o eliminado: la vista responde con capacidades.editar=false', async () => {
    svc.vistaCostosProveedor.mockResolvedValueOnce(VISTA(false));
    expect((await pide('get', `/${P_ID}`, 1)).body.capacidades.editar).toBe(false);
    svc.vistaCostosProveedor.mockResolvedValueOnce(VISTA(false, true));
    const r = await pide('get', `/${P_ID}`, 1);
    expect(r.body.capacidades.editar).toBe(false);
    expect(r.body.proveedor).toEqual({ id: P_ID, nombre: 'Mensajería Sur', activo: false, eliminado: true });
  });

  it('la respuesta de la lista no proyecta NIT ni contacto', async () => {
    const r = await pide('get', '/', 1);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body[0]).sort()).toEqual(['conceptos', 'faltan', 'id', 'nombre', 'servicios']);
  });
});

describe('Errores de dominio → HTTP', () => {
  it('404: proveedor inexistente y vigencia inexistente', async () => {
    svc.vistaCostosProveedor.mockRejectedValueOnce(new servicio.TarifaProveedorProveedorNoEncontradoError());
    const a = await pide('get', `/${P_ID}`, 1);
    expect(a.status).toBe(404);
    expect(a.body.code).toBe('PROVEEDOR_NO_ENCONTRADO');
    svc.cambiarOCerrarCosto.mockRejectedValueOnce(new servicio.VigenciaCostoNoEncontradaError());
    const b = await pide('patch', `/vigencias/${V_ID}`, 1, { valor: 3 });
    expect(b.status).toBe(404);
    expect(b.body.code).toBe('VIGENCIA_NO_ENCONTRADA');
  });

  it('R6 — 409 con código y mensaje literales de «otro usuario cambió este valor»; sin audit', async () => {
    svc.cambiarOCerrarCosto.mockRejectedValueOnce(new servicio.TarifaProveedorCambiadaError());
    const r = await pide('patch', `/vigencias/${V_ID}`, 1, { valor: 3 });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: MENSAJE_TARIFA_PROVEEDOR_CAMBIADA_POR_OTRO, code: CODIGO_TARIFA_PROVEEDOR_CAMBIADA });
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('R5 — 409 PROVEEDOR_NO_ACTIVO al fijar sobre un inactivo', async () => {
    svc.fijarCosto.mockRejectedValueOnce(new servicio.ProveedorNoActivoError());
    const r = await pide('post', `/${P_ID}/vigencias`, 1, { concepto: 'logistica', valor: 3 });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('PROVEEDOR_NO_ACTIVO');
  });

  it('R2 — 422 SERVICIO_NO_PRESTADO', async () => {
    svc.fijarCosto.mockRejectedValueOnce(new servicio.ServicioCostoNoPrestadoError());
    const r = await pide('post', `/${P_ID}/vigencias`, 1, { concepto: 'soat_con_tramite', valor: 3 });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('SERVICIO_NO_PRESTADO');
  });
});

describe('R4 — auditoría de las tres mutaciones', () => {
  it('cambiar → audit update con valor anterior y nuevo', async () => {
    const r = await pide('patch', `/vigencias/${V_ID}`, 1, { valor: 2000 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ accion: 'cambiada', valorAnterior: 0, valorNuevo: 2000 });
    expect(auditMock.mock.calls[0]![1]).toMatchObject({ action: 'update', resource: 'flito_tarifa_proveedor_vigencia' });
    expect(auditMock.mock.calls[0]![1].detail).toMatch(/de 0 a 2000/);
  });

  it('cerrar → audit update «dejar de cobrar»', async () => {
    svc.cambiarOCerrarCosto.mockResolvedValueOnce({
      resultado: { vigencia: { ...VIGENCIA, vigenteHasta: 'x' }, accion: 'cerrada', valorAnterior: 0, valorNuevo: null }, proveedorNombre: 'S',
    });
    const r = await pide('patch', `/vigencias/${V_ID}`, 1, { cerrar: true });
    expect(r.status).toBe(200);
    expect(svc.cambiarOCerrarCosto).toHaveBeenCalledWith(V_ID, { cerrar: true }, 1);
    expect(auditMock.mock.calls[0]![1].detail).toMatch(/dejar de cobrar/);
  });

  it('sin cambio → no audita', async () => {
    svc.cambiarOCerrarCosto.mockResolvedValueOnce({
      resultado: { vigencia: VIGENCIA, accion: 'sin_cambio', valorAnterior: 0, valorNuevo: 0 }, proveedorNombre: 'S',
    });
    expect((await pide('patch', `/vigencias/${V_ID}`, 1, { valor: 0 })).status).toBe(200);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('historial con filtro de concepto llega al servicio; concepto inválido → 400', async () => {
    expect((await pide('get', `/${P_ID}/historial?concepto=soat_sin_tramite`, 1)).status).toBe(200);
    expect(svc.historialCostosProveedor).toHaveBeenCalledWith(P_ID, 'soat_sin_tramite');
    expect((await pide('get', `/${P_ID}/historial?concepto=otro`, 1)).status).toBe(400);
  });
});
