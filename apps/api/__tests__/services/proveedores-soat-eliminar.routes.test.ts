// HU #13960 (Feature #13940) — Las condiciones para eliminar y el 409 de activar a un usuario huérfano
// (`PATCH /api/users/:id/toggle`, `POST /api/users/:id/reactivar`). La ruta de eliminar es `DELETE /proveedores/:id`
// (HU #14334), medida en `proveedores-gestion.routes.test.ts`.
//
// Aquí se mide la RUTA con el servicio mockeado: guarda `exigirFuncion` (AC8), validación, mapeo 404/409 (AC2–AC4,
// AC9), limpieza de la caché de sesión tras el commit y auditoría (AC1), y el orden y los textos de las condiciones
// (`motivoNoEliminableProveedor`, pura). Las condiciones, el FOR UPDATE, la concurrencia real, el listado (AC6) y la
// reactivación contra PostgreSQL de verdad están en `__tests__/db/proveedores-soat-eliminar.test.ts`.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const { selectMock, transactionMock, auditMock, invalidateMock, eliminarMock, cambiarActivoMock, reactivarMock } = vi.hoisted(() => ({
  selectMock: vi.fn(), transactionMock: vi.fn(), auditMock: vi.fn(), invalidateMock: vi.fn(), eliminarMock: vi.fn(),
  cambiarActivoMock: vi.fn(), reactivarMock: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock, insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: transactionMock,
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
vi.mock('../../src/modules/users/users.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/users/users.service.js')>();
  return { ...actual, cambiarActivo: cambiarActivoMock, reactivarUsuario: reactivarMock };
});

const {
  motivoNoEliminableProveedor,
} = await import('../../src/modules/flito-parametrizacion/flito-proveedores-estado.service.js');
const { ProveedorSoatDelUsuarioEliminadoError } = await import('../../src/modules/users/users.service.js');

beforeEach(() => {
  selectMock.mockReset(); transactionMock.mockReset(); eliminarMock.mockReset();
  cambiarActivoMock.mockReset(); reactivarMock.mockReset();
  auditMock.mockReset().mockResolvedValue(undefined);
  invalidateMock.mockClear();
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-parametrizacion/flito-parametrizacion.routes.js');
  app.use('/api/flito/parametrizacion', router);
  const { default: users } = await import('../../src/modules/users/users.routes.js');
  app.use('/api/users', users);
  return app;
}

const adminToken = () => testToken({
  sub: 1, role: 'admin',
  funciones: ['parametrizacion.proveedores.eliminar', 'usuarios.usuario.activar', 'usuarios.usuario.reactivar'],
});
const sinTramite = (nombres: string[]) => ({ cantidad: nombres.length, nombres });

describe('RN-PROV-6 — condiciones en orden (`motivoNoEliminableProveedor`)', () => {
  it('AC2: activo gana sobre todo lo demás', () => {
    expect(motivoNoEliminableProveedor({ activo: true, soatEnCurso: 4, companiasGestorPorDefecto: sinTramite(['Alfa']) }))
      .toBe('Primero debe desactivarlo.');
  });
  it('AC3: inactivo con SOAT en curso → «Tiene 4 SOAT en curso.» aunque también tenga compañías', () => {
    expect(motivoNoEliminableProveedor({ activo: false, soatEnCurso: 4, companiasGestorPorDefecto: sinTramite(['Alfa']) }))
      .toBe('Tiene 4 SOAT en curso.');
  });
  it('AC4: compañías → texto con cantidad y nombres; singular con una', () => {
    expect(motivoNoEliminableProveedor({ activo: false, soatEnCurso: 0, companiasGestorPorDefecto: sinTramite(['Alfa', 'Beta']) }))
      .toBe('Es el proveedor de SOAT sin trámite de 2 compañías (Alfa, Beta).');
    expect(motivoNoEliminableProveedor({ activo: false, soatEnCurso: 0, companiasGestorPorDefecto: sinTramite(['Alfa']) }))
      .toBe('Es el proveedor de SOAT sin trámite de 1 compañía (Alfa).');
  });
  it('sin nada que lo impida → null', () => {
    expect(motivoNoEliminableProveedor({ activo: false, soatEnCurso: 0, companiasGestorPorDefecto: sinTramite([]) })).toBeNull();
  });
});

describe('AC7 — activar a un usuario huérfano (su proveedor SOAT fue eliminado) → 409', () => {
  const MSG = 'El proveedor SOAT de este usuario fue eliminado; asígnale otro antes de activarlo.';

  it('PATCH /api/users/:id/toggle → 409 con el texto, sin invalidar ni auditar', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 30, active: false, deletedAt: null, role: 'gestor_soat' }]));
    cambiarActivoMock.mockRejectedValueOnce(new ProveedorSoatDelUsuarioEliminadoError());
    const r = await request(await buildApp()).patch('/api/users/30/toggle').set('Authorization', `Bearer ${await adminToken()}`);
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: MSG });
    expect(invalidateMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('POST /api/users/:id/reactivar → 409 con el texto', async () => {
    reactivarMock.mockRejectedValueOnce(new ProveedorSoatDelUsuarioEliminadoError());
    const r = await request(await buildApp()).post('/api/users/30/reactivar').set('Authorization', `Bearer ${await adminToken()}`);
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: MSG });
    expect(auditMock).not.toHaveBeenCalled();
  });
});
