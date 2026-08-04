// FLITO — ver los soportes desde la pantalla en la que se trabaja.
//
// Antes los comprobantes solo se podían consultar desde el reporte de costos (rol `financiera`) o
// desde la tabla de derechos. Quien despacha en Gestión de trámites, el gestor del proveedor de
// SOAT y el gestor del organismo —los tres que cargan y necesitan ese papel— no entraban ahí.
//
// Lo que se prueba aquí es lo que solo se ve desde la ruta: quién puede pedir la lista y, sobre
// todo, que abrir documentos NO sea una puerta trasera a la frontera del gestor. El armado de la
// lista se prueba aparte, en flito-soportes-consulta.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken, type TestRole } from '../helpers/auth.js';

// Lo único que llega a la BD de verdad en estas rutas es el organismo del gestor de impuestos, que
// se lee de `users` para armar su contexto (§9.3). Todo lo demás está mockeado más abajo.
vi.mock('../../src/db/client.js', () => ({
  db: {
    select: vi.fn(() => chain([{ t: '05001' }])),
    insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn(),
  },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const soportesDeTramiteMock = vi.fn();
const soportesDeSoatMock = vi.fn();
const soportesDeImpuestoMock = vi.fn();
vi.mock('../../src/shared/soportes/soportes-consulta.js', () => ({
  soportesDeTramite: (...a: unknown[]) => soportesDeTramiteMock(...a),
  soportesDeSoat: (...a: unknown[]) => soportesDeSoatMock(...a),
  soportesDeImpuesto: (...a: unknown[]) => soportesDeImpuestoMock(...a),
  soportesDeDerecho: vi.fn(),
}));

// Los detalles son los que aplican la frontera del gestor (404-no-403): se mockean para poder
// decir «este registro no es tuyo» sin montar media base de datos.
const detalleSoatMock = vi.fn();
vi.mock('../../src/modules/flito-soat/flito-soat.service.js', () => ({
  detalle: (...a: unknown[]) => detalleSoatMock(...a),
  contextoSoat: vi.fn().mockResolvedValue({ userId: 1, username: 'u', role: 'admin', proveedorSoatId: null }),
  cola: vi.fn(), facetasCola: vi.fn(), enviarAlGestor: vi.fn(), rechazar: vi.fn(), reactivar: vi.fn(),
  reversar: vi.fn(), cambiarProveedor: vi.fn(), asumirEnOperaciones: vi.fn(), devolverAlGestor: vi.fn(),
  cargarFactura: vi.fn(), cargarFacturasMasivo: vi.fn(),
  SoatError: class SoatError extends Error { constructor(public status: number, m: string) { super(m); } },
}));

const detalleImpuestoMock = vi.fn();
vi.mock('../../src/modules/flito-impuestos/flito-impuestos.service.js', () => ({
  detalleImpuesto: (...a: unknown[]) => detalleImpuestoMock(...a),
  colaImpuestos: vi.fn(), facetasColaImpuestos: vi.fn(), enviarAlGestor: vi.fn(), rechazar: vi.fn(),
  reactivar: vi.fn(), reversar: vi.fn(), asumirEnOperaciones: vi.fn(), devolverAlGestor: vi.fn(),
  facturaVentaFlitConAcceso: vi.fn(),
}));

const [{ default: tramitesRoutes }, { default: soatRoutes }, { default: impuestosRoutes }] = await Promise.all([
  import('../../src/modules/flito-tramites/flito-tramites.routes.js'),
  import('../../src/modules/flito-soat/flito-soat.routes.js'),
  import('../../src/modules/flito-impuestos/flito-impuestos.routes.js'),
]);

const app = express();
app.use(express.json());
app.use('/api/flito/tramites', tramitesRoutes);
app.use('/api/flito/soat', soatRoutes);
app.use('/api/flito/impuestos', impuestosRoutes);

const get = async (ruta: string, role: TestRole) =>
  request(app).get(ruta).set('Authorization', `Bearer ${await testToken({ role })}`);

const UN_SOPORTE = [{ id: 's1', origen: 'soat', tipo: 'factura_soat', nombreArchivo: 'soat.pdf', url: '/api/files?key=a', subidoEn: '2026-07-01T00:00:00.000Z' }];

beforeEach(() => {
  soportesDeTramiteMock.mockReset(); soportesDeSoatMock.mockReset(); soportesDeImpuestoMock.mockReset();
  detalleSoatMock.mockReset(); detalleImpuestoMock.mockReset();
});

describe('GET /flito/tramites/:id/soportes — Gestión de trámites', () => {
  it('operaciones ve los documentos del trámite sin salir de la pantalla', async () => {
    soportesDeTramiteMock.mockResolvedValue(UN_SOPORTE);
    const res = await get('/api/flito/tramites/t1/soportes', 'admin');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('auditoría también: observar es justo lo suyo', async () => {
    soportesDeTramiteMock.mockResolvedValue([]);
    expect((await get('/api/flito/tramites/t1/soportes', 'auditor')).status).toBe(200);
  });

  it('un trámite inexistente es 404, no una lista vacía que parezca «sin documentos»', async () => {
    soportesDeTramiteMock.mockResolvedValue(null);
    expect((await get('/api/flito/tramites/t1/soportes', 'admin')).status).toBe(404);
  });

  it('no se cachea: un soporte cargado hace un minuto tiene que salir sin recargar', async () => {
    soportesDeTramiteMock.mockResolvedValue([]);
    const res = await get('/api/flito/tramites/t1/soportes', 'admin');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('un gestor de impuestos no entra a esta pantalla, tampoco a sus documentos', async () => {
    expect((await get('/api/flito/tramites/t1/soportes', 'gestor_impuestos')).status).toBe(403);
    expect(soportesDeTramiteMock).not.toHaveBeenCalled();
  });
});

describe('GET /flito/soat/:id/soportes — detalle del SOAT', () => {
  it('devuelve la factura cargada de ese SOAT', async () => {
    detalleSoatMock.mockResolvedValue({ id: 's1' });
    soportesDeSoatMock.mockResolvedValue(UN_SOPORTE);
    const res = await get('/api/flito/soat/s1/soportes', 'proveedor');
    expect(res.status).toBe(200);
    expect(res.body[0].nombreArchivo).toBe('soat.pdf');
  });

  // Lo importante de la ruta: la frontera se aplica ANTES de leer nada. Sin este paso, un proveedor
  // podría ver los documentos de un SOAT ajeno con solo conocer su id.
  it('SOAT de otro proveedor → 404 y ni siquiera se consultan sus documentos', async () => {
    detalleSoatMock.mockResolvedValue(null);
    const res = await get('/api/flito/soat/ajeno/soportes', 'proveedor');
    expect(res.status).toBe(404);
    expect(soportesDeSoatMock).not.toHaveBeenCalled();
  });

  it('un gestor de impuestos no pinta nada en la cola de SOAT', async () => {
    expect((await get('/api/flito/soat/s1/soportes', 'gestor_impuestos')).status).toBe(403);
  });
});

describe('GET /flito/impuestos/:id/soportes — detalle del impuesto', () => {
  it('devuelve el recibo cargado de ese impuesto', async () => {
    detalleImpuestoMock.mockResolvedValue({ id: 'i1' });
    soportesDeImpuestoMock.mockResolvedValue(UN_SOPORTE);
    const res = await get('/api/flito/impuestos/i1/soportes', 'gestor_impuestos');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('impuesto de otro organismo → 404 y ni siquiera se consultan sus documentos', async () => {
    detalleImpuestoMock.mockResolvedValue(null);
    const res = await get('/api/flito/impuestos/ajeno/soportes', 'gestor_impuestos');
    expect(res.status).toBe(404);
    expect(soportesDeImpuestoMock).not.toHaveBeenCalled();
  });

  it('un proveedor de SOAT no entra a la cola de impuestos', async () => {
    expect((await get('/api/flito/impuestos/i1/soportes', 'proveedor')).status).toBe(403);
  });
});
