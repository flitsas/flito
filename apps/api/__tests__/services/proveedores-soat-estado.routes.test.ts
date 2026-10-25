// HU #13958 (Feature #13940) — Rutas de desactivar/activar un proveedor SOAT y su vista previa de impacto.
//
// Aquí se mide la RUTA con la base mockeada (gemelo de `clients-estado.routes.test.ts`): guarda `exigirFuncion` (AC6),
// validación, mapeo 404/409 (AC9/AC8), limpieza de la caché de sesión tras el commit y auditoría (AC2/AC4), el
// `PATCH /:id` general con `activo` (AC5) y que el impacto no escriba (AC1). Los conteos del impacto, el FOR UPDATE y
// el login contra PostgreSQL de verdad están en `__tests__/db/proveedores-soat-estado.test.ts`.
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

/** La transacción del servicio: cada `select`/`update` del `tx` consume la siguiente respuesta de su cola. */
function prepararTx(selects: unknown[][], updates: unknown[][] = []) {
  const txUpdate = vi.fn();
  const txSelect = vi.fn();
  for (const s of selects) txSelect.mockReturnValueOnce(chain(s));
  for (const u of updates) txUpdate.mockReturnValueOnce(chain(u));
  transactionMock.mockImplementationOnce(async (fn: (tx: unknown) => unknown) => fn({ update: txUpdate, select: txSelect }));
  return { txUpdate, txSelect };
}

describe('PATCH /proveedores-soat/:id/estado (HU #13958)', () => {
  it('AC2: desactivar → 200, invalida las sesiones de sus usuarios tras el commit y audita con el nombre', async () => {
    const { txUpdate } = prepararTx([[{ activo: true }]], [
      [{ id: ID, nombre: 'Gestora Andina', activo: false }], [{ id: 21 }, { id: 22 }],
    ]);
    const r = await request(await buildApp()).patch(`${URL}/estado`).set('Authorization', `Bearer ${await adminToken()}`)
      .send({ activo: false, activoEsperado: true });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: ID, activo: false });
    expect(txUpdate).toHaveBeenCalledTimes(2); // proveedor + users.session_invalidated_at (users.active no se toca)
    expect(invalidateMock.mock.calls.map((c) => c[0])).toEqual([21, 22]);
    const entrada = auditMock.mock.calls[0]![1];
    expect(entrada).toMatchObject({ action: 'update', resource: 'flito_proveedor_soat', resourceId: ID });
    expect(entrada.detail).toBe('Proveedor SOAT desactivado: Gestora Andina · sesiones invalidadas: 2 usuario(s)');
  });

  it('AC4: activar → 200, no invalida sesiones y audita la activación', async () => {
    const { txUpdate } = prepararTx([[{ activo: false }]], [[{ id: ID, nombre: 'Gestora Andina', activo: true }]]);
    const r = await request(await buildApp()).patch(`${URL}/estado`).set('Authorization', `Bearer ${await adminToken()}`)
      .send({ activo: true, activoEsperado: false });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: ID, activo: true });
    expect(txUpdate).toHaveBeenCalledTimes(1);
    expect(invalidateMock).not.toHaveBeenCalled();
    expect(auditMock.mock.calls[0]![1].detail).toBe('Proveedor SOAT activado: Gestora Andina');
  });

  it('AC8: el estado ya no es el esperado → 409 «Otro administrador ya cambió su estado», sin escribir ni auditar', async () => {
    const { txUpdate } = prepararTx([[{ activo: false }]]);
    const r = await request(await buildApp()).patch(`${URL}/estado`).set('Authorization', `Bearer ${await adminToken()}`)
      .send({ activo: false, activoEsperado: true });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('Otro administrador ya cambió su estado');
    expect(txUpdate).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
    expect(invalidateMock).not.toHaveBeenCalled();
  });

  it('AC9: inexistente o eliminado (el SELECT FOR UPDATE de vigentes no lo encuentra) → 404 «Proveedor SOAT no encontrado»', async () => {
    const { txUpdate } = prepararTx([[]]);
    const r = await request(await buildApp()).patch(`${URL}/estado`).set('Authorization', `Bearer ${await adminToken()}`)
      .send({ activo: false, activoEsperado: true });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('Proveedor SOAT no encontrado');
    expect(txUpdate).not.toHaveBeenCalled();
  });

  // El 403 es el canónico de `exigirFuncion` (texto estándar del middleware + `funcion`), no el literal «Sin permisos».
  it('AC6: sin `parametrizacion.proveedores.estado` → 403 y no se abre la transacción', async () => {
    const r = await request(await buildApp()).patch(`${URL}/estado`).set('Authorization', `Bearer ${await auditorToken()}`)
      .send({ activo: false, activoEsperado: true });
    expect(r.status).toBe(403);
    expect(r.body.error).toEqual(expect.any(String));
    expect(r.body.funcion).toBe('parametrizacion.proveedores.estado');
    expect(transactionMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('cuerpo inválido o id no uuid → 400 sin tocar la base', async () => {
    const app = await buildApp();
    const token = await adminToken();
    for (const body of [{ activo: false }, { activo: 'no', activoEsperado: true }, { activo: false, activoEsperado: true, extra: 1 }]) {
      const r = await request(app).patch(`${URL}/estado`).set('Authorization', `Bearer ${token}`).send(body);
      expect(r.status).toBe(400);
    }
    const r = await request(app).patch('/api/flito/parametrizacion/proveedores-soat/abc/estado')
      .set('Authorization', `Bearer ${token}`).send({ activo: false, activoEsperado: true });
    expect(r.status).toBe(400);
    expect(transactionMock).not.toHaveBeenCalled();
  });
});

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
      puedeEliminar: false,
      motivoNoEliminable: null,
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

describe('PATCH /proveedores-soat/:id (edición general) con `activo` — AC5', () => {
  it('intentar cambiar el estado → 400 con el mensaje, sin escribir', async () => {
    selectMock.mockReturnValueOnce(chain([{ activo: true }]));
    const r = await request(await buildApp()).patch(URL).set('Authorization', `Bearer ${await adminToken()}`)
      .send({ nombre: 'Gestora Andina', activo: false });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('El estado del proveedor se cambia con Activar o Desactivar.');
    expect(updateMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('`activo` igual al actual se ignora: la edición sigue y `activo` no entra en el SET', async () => {
    selectMock
      .mockReturnValueOnce(chain([{ activo: true }])) // estado actual
      .mockReturnValueOnce(chain([])); // nombre libre entre vigentes
    const setSpy = vi.fn(() => ({ where: () => ({ returning: () => Promise.resolve([{
      id: ID, nombre: 'Gestora 2', estrategia: 'portal', umbralOcr: null, slaHoras: null, activo: true,
    }]) }) }));
    updateMock.mockReturnValueOnce({ set: setSpy });
    const r = await request(await buildApp()).patch(URL).set('Authorization', `Bearer ${await adminToken()}`)
      .send({ nombre: 'Gestora 2', activo: true });
    expect(r.status).toBe(200);
    expect(setSpy.mock.calls[0]![0]).toEqual({ nombre: 'Gestora 2' });
  });
});
