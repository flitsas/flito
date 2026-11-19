// HU #14148 (Feature #14089) — rutas nuevas de proveedores: impacto, baja, listado unificado y PATCH /estado con
// `activoEsperado`. Servicio mockeado: aquí se mide permiso (403), validación (400), mapeo HTTP y auditoría; las reglas
// de conteo/tope/409 reales están en `db/flito-proveedores-logistica-gestion.test.ts` (PostgreSQL).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { testToken } from '../helpers/auth.js';

const m = vi.hoisted(() => ({
  impacto: vi.fn(), eliminar: vi.fn(), listar: vi.fn(), actualizar: vi.fn(), audit: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(),
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]) },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: m.audit }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const gestion = await import('../../src/modules/flito-parametrizacion/flito-proveedores-logistica-gestion.service.js');
vi.spyOn(gestion, 'impactoProveedorLogistica').mockImplementation(m.impacto);
vi.spyOn(gestion, 'eliminarProveedorLogistica').mockImplementation(m.eliminar);
vi.spyOn(gestion, 'listarProveedoresUnificados').mockImplementation(m.listar);
const logistica = await import('../../src/modules/flito-parametrizacion/flito-proveedores-logistica.service.js');
vi.spyOn(logistica, 'actualizarProveedorLogistica').mockImplementation(m.actualizar);
const { ProveedorLogisticaAsignadoError } = await import('../../src/modules/flito-parametrizacion/flito-logistica-proveedor-compania.service.js');

beforeEach(() => { Object.values(m).forEach((f) => f.mockReset()); m.audit.mockResolvedValue(undefined); });

const ID = 'c0000000-0000-4000-8000-000000014148';
const BASE = '/api/flito/parametrizacion';
async function app() {
  const a = express(); a.use(express.json());
  a.use(`${BASE}/proveedores-logistica`, (await import('../../src/modules/flito-parametrizacion/flito-proveedores-logistica.routes.js')).default);
  a.use(BASE, (await import('../../src/modules/flito-parametrizacion/flito-parametrizacion.routes.js')).default);
  return a;
}
const con = (...funciones: string[]) => testToken({ sub: 1, role: 'admin', funciones }).then((t) => `Bearer ${t}`);
const sin = () => testToken({ sub: 2, role: 'financiera', funciones: ['clients.clientes.ver'] }).then((t) => `Bearer ${t}`);

describe('GET /proveedores-logistica/:id/impacto', () => {
  it('con la función de estado → { companias, nombres }', async () => {
    m.impacto.mockResolvedValue({ companias: 5, nombres: ['A', 'B', 'C'] });
    const r = await request(await app()).get(`${BASE}/proveedores-logistica/${ID}/impacto`).set('Authorization', await con('parametrizacion.proveedores.estado'));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ companias: 5, nombres: ['A', 'B', 'C'] });
  });
  it('sin la función → 403 y el servicio no se consulta', async () => {
    const r = await request(await app()).get(`${BASE}/proveedores-logistica/${ID}/impacto`).set('Authorization', await sin());
    expect(r.status).toBe(403);
    expect(m.impacto).not.toHaveBeenCalled();
  });
  it('id no uuid → 400; inexistente → 404', async () => {
    const t = await con('parametrizacion.proveedores.estado');
    expect((await request(await app()).get(`${BASE}/proveedores-logistica/xx/impacto`).set('Authorization', t)).status).toBe(400);
    const { ProveedorLogisticaNoEncontradoError } = logistica;
    m.impacto.mockRejectedValue(new ProveedorLogisticaNoEncontradoError());
    expect((await request(await app()).get(`${BASE}/proveedores-logistica/${ID}/impacto`).set('Authorization', t)).status).toBe(404);
  });
});

describe('DELETE /proveedores-logistica/:id', () => {
  it('con la función de eliminar → 200 y auditoría sin contacto', async () => {
    m.eliminar.mockResolvedValue({ id: ID, nombre: 'Andina' });
    const r = await request(await app()).delete(`${BASE}/proveedores-logistica/${ID}`).set('Authorization', await con('parametrizacion.proveedores.eliminar'));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: ID, eliminado: true });
    expect(m.audit).toHaveBeenCalledOnce();
    expect(m.audit.mock.calls[0]![1]).toMatchObject({ action: 'delete', resource: 'flito_proveedor_logistica', resourceId: ID });
  });
  it('con compañías asignadas → 409 con los nombres, sin auditoría', async () => {
    m.eliminar.mockRejectedValue(new ProveedorLogisticaAsignadoError(['A', 'B'], 'eliminar'));
    const r = await request(await app()).delete(`${BASE}/proveedores-logistica/${ID}`).set('Authorization', await con('parametrizacion.proveedores.eliminar'));
    expect(r.status).toBe(409);
    expect(r.body.companias).toEqual(['A', 'B']);
    expect(m.audit).not.toHaveBeenCalled();
  });
  it('tener solo la función de estado NO basta → 403', async () => {
    const auditorConEstado = `Bearer ${await testToken({ sub: 3, role: 'auditor', funciones: ['parametrizacion.proveedores.estado'] })}`;
    const r = await request(await app()).delete(`${BASE}/proveedores-logistica/${ID}`).set('Authorization', auditorConEstado);
    expect(r.status).toBe(403);
    expect(m.eliminar).not.toHaveBeenCalled();
  });
  it('id inválido → 400', async () => {
    expect((await request(await app()).delete(`${BASE}/proveedores-logistica/xx`).set('Authorization', await con('parametrizacion.proveedores.eliminar'))).status).toBe(400);
  });
});

describe('GET /proveedores (unificado)', () => {
  it('con la función de listar → lista del servicio', async () => {
    m.listar.mockResolvedValue([{ tipo: 'soat', id: ID, nombre: 'S', nit: null, contacto: null, telefono: null, activo: true, companiasAsignadas: 1 }]);
    const r = await request(await app()).get(`${BASE}/proveedores`).set('Authorization', await con('parametrizacion.proveedores.listar'));
    expect(r.status).toBe(200);
    expect(r.body[0]).toMatchObject({ tipo: 'soat', companiasAsignadas: 1 });
  });
  it('quien solo ve Clientes (sin la función) → 403', async () => {
    const r = await request(await app()).get(`${BASE}/proveedores`).set('Authorization', await sin());
    expect(r.status).toBe(403);
    expect(m.listar).not.toHaveBeenCalled();
  });
});

describe('PATCH /proveedores-logistica/:id/estado con activoEsperado', () => {
  it('se acepta y se ignora: aplica `activo` igual que sin él', async () => {
    m.actualizar.mockResolvedValue({ id: ID, nombre: 'A', nit: '9', contacto: null, telefono: null, activo: false });
    const r = await request(await app()).patch(`${BASE}/proveedores-logistica/${ID}/estado`).set('Authorization', await con('parametrizacion.proveedores.estado'))
      .send({ activo: false, activoEsperado: true });
    expect(r.status).toBe(200);
    expect(m.actualizar).toHaveBeenCalledWith(ID, { activo: false });
  });
  it('inactivar con compañías asignadas sigue siendo 409', async () => {
    m.actualizar.mockRejectedValue(new ProveedorLogisticaAsignadoError(['A']));
    const r = await request(await app()).patch(`${BASE}/proveedores-logistica/${ID}/estado`).set('Authorization', await con('parametrizacion.proveedores.estado')).send({ activo: false });
    expect(r.status).toBe(409);
  });
});
