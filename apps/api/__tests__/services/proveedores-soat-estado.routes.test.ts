// HU #13958 (Feature #13940) — La vista previa de impacto de un proveedor SOAT, con la base mockeada: guarda
// `exigirFuncion` (AC6), 404 (AC9) y que el impacto no escriba (AC1). Cambiar el estado es `PATCH /proveedores/:id/estado`
// (HU #14334), medido en `proveedores-gestion.routes.test.ts`. Lo demás contra PostgreSQL está en `db/proveedores-soat-estado.test.ts`.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const { selectMock, updateMock, transactionMock, auditMock, invalidateMock } = vi.hoisted(() => ({
  selectMock: vi.fn(), updateMock: vi.fn(), transactionMock: vi.fn(), auditMock: vi.fn(), invalidateMock: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock, insert: vi.fn(), update: updateMock, delete: vi.fn(), transaction: transactionMock,
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/shared/middleware/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/middleware/auth.js')>();
  return { ...actual, invalidateSessionCacheFor: invalidateMock };
});

beforeEach(() => {
  selectMock.mockReset(); updateMock.mockReset(); transactionMock.mockReset();
  auditMock.mockReset().mockResolvedValue(undefined);
  invalidateMock.mockClear();
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-parametrizacion/flito-parametrizacion.routes.js');
  app.use('/api/flito/parametrizacion', router);
  return app;
}

const ID = 'a0000000-0000-4000-8000-000000000013';
const URL = `/api/flito/parametrizacion/proveedores-soat/${ID}`;
const adminToken = () => testToken({ sub: 1, role: 'admin', funciones: ['parametrizacion.proveedores.estado', 'parametrizacion.proveedores.editar'] });
/** Auditor: ve los proveedores (`parametrizacion.proveedores.listar`) pero no tiene la exclusiva del Administrador. */
const auditorToken = () => testToken({ sub: 2, role: 'auditor' });

describe('GET /proveedores-soat/:id/impacto (HU #13958)', () => {
  it('AC1: devuelve SOAT en curso, compañías con el proveedor por defecto y usuarios afectados; no modifica nada', async () => {
    selectMock
      .mockReturnValueOnce(chain([{ activo: true }]))
      .mockReturnValueOnce(chain([{ total: 4 }])) // flito_soat en curso
      .mockReturnValueOnce(chain([{ name: 'Alfa' }, { name: 'Beta' }])) // clientes vigentes con el gestor por defecto
      .mockReturnValueOnce(chain([{ total: 3 }])); // usuarios
    const r = await request(await buildApp()).get(`${URL}/impacto`).set('Authorization', `Bearer ${await adminToken()}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      activo: true,
      soatEnCurso: 4,
      companiasGestorPorDefecto: { cantidad: 2, nombres: ['Alfa', 'Beta'] },
      usuariosAfectados: 3,
      // HU #13960: activo → el primer motivo de RN-PROV-6.
      puedeEliminar: false,
      motivoNoEliminable: 'Primero debe desactivarlo.',
    });
    expect(updateMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('AC9: inexistente o eliminado → 404 «Proveedor SOAT no encontrado»', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const r = await request(await buildApp()).get(`${URL}/impacto`).set('Authorization', `Bearer ${await adminToken()}`);
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('Proveedor SOAT no encontrado');
  });

  it('AC6: sin `parametrizacion.proveedores.estado` → 403 aunque vea los proveedores', async () => {
    const r = await request(await buildApp()).get(`${URL}/impacto`).set('Authorization', `Bearer ${await auditorToken()}`);
    expect(r.status).toBe(403);
    expect(r.body.funcion).toBe('parametrizacion.proveedores.estado');
    expect(selectMock).not.toHaveBeenCalled();
  });
});
