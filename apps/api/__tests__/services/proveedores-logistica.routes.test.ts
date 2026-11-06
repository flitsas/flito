// HU #14103 (Feature #14089) — Listado de proveedores de logística, con la base mockeada, y AC4 SOAT intacto. Alta y edición
// son `POST` y `PATCH /proveedores` (HU #14332), medidas en `proveedores-gestion.routes.test.ts`.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const { selectMock, insertMock, updateMock, auditMock } = vi.hoisted(() => ({
  selectMock: vi.fn(), insertMock: vi.fn(), updateMock: vi.fn(), auditMock: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: insertMock, update: updateMock, delete: vi.fn(), transaction: vi.fn(),
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]) },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));

beforeEach(() => {
  selectMock.mockReset(); insertMock.mockReset(); updateMock.mockReset();
  auditMock.mockReset().mockResolvedValue(undefined);
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-parametrizacion/flito-proveedores-logistica.routes.js');
  app.use('/api/flito/parametrizacion/proveedores-logistica', router);
  return app;
}
const URL = '/api/flito/parametrizacion/proveedores-logistica';
const ID = 'b0000000-0000-4000-8000-000000014103';
const adminToken = () => testToken({ sub: 1, role: 'admin', funciones: ['parametrizacion.proveedores.crear', 'parametrizacion.proveedores.listar', 'parametrizacion.proveedores.editar'] });
const fila = { id: ID, nombre: 'Mensajeria Andina', nit: '900123456-7', contacto: 'Ana Perez', telefono: '3001112233', activo: true };

describe('GET /proveedores-logistica', () => {
  it('AC1: el proveedor aparece en el listado, con sus campos de logística', async () => {
    selectMock.mockReturnValueOnce(chain([fila]));
    const r = await request(await buildApp()).get(URL).set('Authorization', `Bearer ${await adminToken()}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual([fila]);
  });

});

describe('GET /proveedores-logistica — permisos', () => {
  it('401 sin token y 403 sin la función', async () => {
    expect((await request(await buildApp()).get(URL)).status).toBe(401);
    const t = await testToken({ sub: 2, role: 'financiera', funciones: ['clients.clientes.ver'] });
    expect((await request(await buildApp()).get(URL).set('Authorization', `Bearer ${t}`)).status).toBe(403);
  });
});

describe('AC4: proveedores SOAT intactos', () => {
  it('el DTO de logística no existe en el de SOAT y viceversa: el router SOAT sigue sin nit/contacto', async () => {
    const schema = readFileSync(resolve(__dirname, '../../src/db/schema/soat.ts'), 'utf8');
    const bloque = schema.slice(schema.indexOf("pgTable('flito_proveedores_soat'"), schema.indexOf("pgTable('flito_proveedores_soat'") + 1500);
    expect(bloque).not.toMatch(/\bnit:|contacto:|telefono:/);
  });
});
