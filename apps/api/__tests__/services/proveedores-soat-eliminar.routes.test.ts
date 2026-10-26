// HU #13960 (Feature #13940) — `DELETE /api/flito/parametrizacion/proveedores-soat/:id` y el 409 de activar a un
// usuario huérfano (`PATCH /api/users/:id/toggle`, `POST /api/users/:id/reactivar`).
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
vi.mock('../../src/modules/flito-parametrizacion/flito-proveedores-eliminar.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/flito-parametrizacion/flito-proveedores-eliminar.service.js')>();
  return { ...actual, eliminarProveedorSoat: eliminarMock };
});
vi.mock('../../src/modules/users/users.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/users/users.service.js')>();
  return { ...actual, cambiarActivo: cambiarActivoMock, reactivarUsuario: reactivarMock };
});

const { ProveedorSoatNoEliminableError } = await import('../../src/modules/flito-parametrizacion/flito-proveedores-eliminar.service.js');
const {
  EstadoProveedorCambiadoError, ProveedorSoatNoEncontradoError, motivoNoEliminableProveedor,
} = await import('../../src/modules/flito-parametrizacion/flito-proveedores-estado.service.js');
const { ProveedorSoatDelUsuarioEliminadoError } = await import('../../src/modules/users/users.service.js');
const { BloqueoAdministracionError } = await import('../../src/shared/permisos-anti-bloqueo.js');

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

const ID = 'a0000000-0000-4000-8000-000000013960';
const URL = `/api/flito/parametrizacion/proveedores-soat/${ID}`;
const adminToken = () => testToken({
  sub: 1, role: 'admin',
  funciones: ['parametrizacion.proveedores.eliminar', 'usuarios.usuario.activar', 'usuarios.usuario.reactivar'],
});
/** Auditor: ve los proveedores pero no tiene la exclusiva del Administrador. */
const auditorToken = () => testToken({ sub: 2, role: 'auditor' });

const borrar = async () => request(await buildApp()).delete(URL).set('Authorization', `Bearer ${await adminToken()}`);
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

describe('DELETE /proveedores-soat/:id (HU #13960)', () => {
  it('AC1: 200, limpia la caché de sesión de sus usuarios tras el commit y audita la baja', async () => {
    eliminarMock.mockResolvedValueOnce({ id: ID, nombre: 'Gestora Andina', usuariosDesactivados: [21, 22] });
    const r = await borrar();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: ID, eliminado: true });
    expect(eliminarMock.mock.calls[0]![0]).toBe(ID);
    expect(eliminarMock.mock.calls[0]![1]).toMatchObject({ userId: 1 });
    expect(invalidateMock.mock.calls.map((c) => c[0])).toEqual([21, 22]);
    const entrada = auditMock.mock.calls[0]![1];
    expect(entrada).toMatchObject({ action: 'delete', resource: 'flito_proveedor_soat', resourceId: ID });
    expect(entrada.detail).toBe('Proveedor SOAT eliminado: Gestora Andina · usuarios desactivados: 2');
  });

  it.each([
    ['AC2', 'Primero debe desactivarlo.'],
    ['AC3', 'Tiene 4 SOAT en curso.'],
    ['AC4', 'Es el proveedor de SOAT sin trámite de 2 compañías (Alfa, Beta).'],
  ])('%s: no eliminable → 409 con el motivo, sin auditar ni invalidar', async (_ac, motivo) => {
    eliminarMock.mockRejectedValueOnce(new ProveedorSoatNoEliminableError(motivo));
    const r = await borrar();
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: motivo });
    expect(auditMock).not.toHaveBeenCalled();
    expect(invalidateMock).not.toHaveBeenCalled();
  });

  it('AC9: otro administrador lo eliminó mientras se esperaba el bloqueo → 409 «Otro administrador ya cambió su estado»', async () => {
    eliminarMock.mockRejectedValueOnce(new EstadoProveedorCambiadoError());
    const r = await borrar();
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('Otro administrador ya cambió su estado');
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('inexistente o ya eliminado → 404; seguro anti-bloqueo → 409 con `funcion`', async () => {
    eliminarMock.mockRejectedValueOnce(new ProveedorSoatNoEncontradoError());
    expect((await borrar()).status).toBe(404);
    eliminarMock.mockRejectedValueOnce(new BloqueoAdministracionError('usuarios.usuario.editar'));
    const r = await borrar();
    expect(r.status).toBe(409);
    expect(r.body.funcion).toBe('usuarios.usuario.editar');
  });

  it('AC8: sin `parametrizacion.proveedores.eliminar` → 403 estándar con `funcion`, sin llamar al servicio', async () => {
    const r = await request(await buildApp()).delete(URL).set('Authorization', `Bearer ${await auditorToken()}`);
    expect(r.status).toBe(403);
    expect(r.body.error).toEqual(expect.any(String));
    expect(r.body.funcion).toBe('parametrizacion.proveedores.eliminar');
    expect(eliminarMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('id no uuid → 400 sin llamar al servicio', async () => {
    const r = await request(await buildApp()).delete('/api/flito/parametrizacion/proveedores-soat/abc')
      .set('Authorization', `Bearer ${await adminToken()}`);
    expect(r.status).toBe(400);
    expect(eliminarMock).not.toHaveBeenCalled();
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
