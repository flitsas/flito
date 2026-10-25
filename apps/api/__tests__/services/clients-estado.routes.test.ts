// HU #13945 (Feature #13939) — Rutas de desactivar/activar un cliente y su vista previa de impacto.
//
// Aquí se mide la RUTA con la base mockeada: guarda (AC7), validación, mapeo 404/409 (AC10/AC6), limpieza de la caché
// de sesión tras el commit y auditoría sin PII (AC2/AC4), y el `PATCH /:id` general con `active` (AC8). Los conteos del
// impacto y el UPDATE optimista contra PostgreSQL de verdad están en `__tests__/db/clients-estado.test.ts`.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();
const updateMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock,
    insert: vi.fn(),
    update: updateMock,
    delete: vi.fn(),
    transaction: transactionMock,
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: vi.fn().mockResolvedValue(undefined) }));

const invalidateMock = vi.fn();
vi.mock('../../src/shared/middleware/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/middleware/auth.js')>();
  return { ...actual, invalidateSessionCacheFor: invalidateMock };
});

beforeEach(() => {
  selectMock.mockReset();
  updateMock.mockReset();
  transactionMock.mockReset();
  auditMock.mockClear();
  invalidateMock.mockClear();
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/clients/clients.routes.js');
  app.use('/api/clients', router);
  return app;
}

const adminToken = () => testToken({ sub: 1, role: 'admin', funciones: ['clients.clientes.estado'] });
/** Auditor: ve clientes (`clients.clientes.ver`) pero no tiene la exclusiva del Administrador. */
const auditorToken = () => testToken({ sub: 2, role: 'auditor' });

/** La transacción del servicio: cada `update`/`select` del `tx` consume la siguiente respuesta de su cola. */
function prepararTx(updates: unknown[][], selects: unknown[][] = []) {
  const txUpdate = vi.fn();
  const txSelect = vi.fn();
  for (const u of updates) txUpdate.mockReturnValueOnce(chain(u));
  for (const s of selects) txSelect.mockReturnValueOnce(chain(s));
  transactionMock.mockImplementationOnce(async (fn: (tx: unknown) => unknown) => fn({ update: txUpdate, select: txSelect }));
  return { txUpdate, txSelect };
}

describe('PATCH /api/clients/:id/estado', () => {
  it('AC2: desactivar → 200, invalida las sesiones de sus usuarios tras el commit y audita con el nombre enmascarado', async () => {
    const { txUpdate } = prepararTx([[{ id: 5, name: 'Transportes Andinos SAS', active: false }], [{ id: 11 }, { id: 12 }]]);
    const app = await buildApp();
    const r = await request(app).patch('/api/clients/5/estado').set('Authorization', `Bearer ${await adminToken()}`)
      .send({ activo: false, activoEsperado: true });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: 5, active: false });
    expect(txUpdate).toHaveBeenCalledTimes(2); // clients + users.session_invalidated_at (users.active no se toca)
    expect(invalidateMock.mock.calls.map((c) => c[0])).toEqual([11, 12]);
    const entrada = auditMock.mock.calls[0]![1];
    expect(entrada).toMatchObject({ action: 'update', resource: 'client', resourceId: '5' });
    expect(entrada.detail).toContain('Cliente desactivado: Tra***');
    expect(entrada.detail).toContain('2 usuario(s)');
    expect(entrada.detail).not.toContain('Transportes');
  });

  it('AC4: activar → 200, no invalida sesiones y audita la activación', async () => {
    const { txUpdate } = prepararTx([[{ id: 5, name: 'Transportes Andinos SAS', active: true }]]);
    const app = await buildApp();
    const r = await request(app).patch('/api/clients/5/estado').set('Authorization', `Bearer ${await adminToken()}`)
      .send({ activo: true, activoEsperado: false });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: 5, active: true });
    expect(txUpdate).toHaveBeenCalledTimes(1);
    expect(invalidateMock).not.toHaveBeenCalled();
    expect(auditMock.mock.calls[0]![1].detail).toBe('Cliente activado: Tra***');
  });

  it('AC6: el estado ya no es el esperado → 409 «Otro administrador ya cambió su estado», sin auditar', async () => {
    prepararTx([[]], [[{ id: 5 }]]);
    const app = await buildApp();
    const r = await request(app).patch('/api/clients/5/estado').set('Authorization', `Bearer ${await adminToken()}`)
      .send({ activo: false, activoEsperado: true });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('Otro administrador ya cambió su estado');
    expect(auditMock).not.toHaveBeenCalled();
    expect(invalidateMock).not.toHaveBeenCalled();
  });

  it('AC10: cliente inexistente → 404 «Cliente no encontrado»', async () => {
    prepararTx([[]], [[]]);
    const app = await buildApp();
    const r = await request(app).patch('/api/clients/999/estado').set('Authorization', `Bearer ${await adminToken()}`)
      .send({ activo: false, activoEsperado: true });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('Cliente no encontrado');
  });

  // El 403 es el canónico de `exigirFuncion` (texto según el motivo de la denegación), no el literal «Sin permisos» de
  // las guardas en línea de este módulo: la regla del AC (403 y nada cambia) es la que se mide.
  it('AC7: sin `clients.clientes.estado` → 403 y no se abre la transacción', async () => {
    const app = await buildApp();
    const r = await request(app).patch('/api/clients/5/estado').set('Authorization', `Bearer ${await auditorToken()}`)
      .send({ activo: false, activoEsperado: true });
    expect(r.status).toBe(403);
    expect(r.body.error).toEqual(expect.any(String));
    expect(transactionMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('cuerpo inválido (falta activoEsperado / tipos) → 400 sin tocar la base', async () => {
    const app = await buildApp();
    const token = await adminToken();
    for (const body of [{ activo: false }, { activo: 'no', activoEsperado: true }, { activo: false, activoEsperado: true, extra: 1 }]) {
      const r = await request(app).patch('/api/clients/5/estado').set('Authorization', `Bearer ${token}`).send(body);
      expect(r.status).toBe(400);
    }
    const r = await request(app).patch('/api/clients/abc/estado').set('Authorization', `Bearer ${token}`)
      .send({ activo: false, activoEsperado: true });
    expect(r.status).toBe(400);
    expect(transactionMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/clients/:id/impacto', () => {
  it('AC1: devuelve el impacto con los conteos y los campos neutros de eliminar', async () => {
    selectMock
      .mockReturnValueOnce(chain([{ active: true }]))
      .mockReturnValueOnce(chain([{ total: 3 }])) // soat
      .mockReturnValueOnce(chain([{ total: 0 }])) // impuestos
      .mockReturnValueOnce(chain([{ total: 2 }])) // trámites asignados
      .mockReturnValueOnce(chain([{ total: 0 }])) // liquidaciones
      .mockReturnValueOnce(chain([{ saldo: '150000.50' }]))
      .mockReturnValueOnce(chain([{ total: 4 }])); // usuarios
    const app = await buildApp();
    const r = await request(app).get('/api/clients/5/impacto').set('Authorization', `Bearer ${await adminToken()}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      activo: true,
      procesosAbiertos: { soat: 3, impuestos: 0, tramites: 2, liquidaciones: 0 },
      saldoBolsa: 150000.5,
      usuariosAfectados: 4,
      puedeEliminar: false,
      motivoNoEliminable: null,
    });
    expect(updateMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('AC10: cliente inexistente → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const app = await buildApp();
    const r = await request(app).get('/api/clients/999/impacto').set('Authorization', `Bearer ${await adminToken()}`);
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('Cliente no encontrado');
  });

  it('AC7: sin `clients.clientes.estado` → 403 aunque vea clientes', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/clients/5/impacto').set('Authorization', `Bearer ${await auditorToken()}`);
    expect(r.status).toBe(403);
    expect(selectMock).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/clients/:id (edición general) con `active` — AC8', () => {
  const previo = { id: 5, name: 'Acme SAS', document: null, documentType: null, personType: null, idType: null, branchOffice: 0, active: true };

  it('intentar cambiar el estado → 400 con el mensaje, sin escribir', async () => {
    selectMock.mockReturnValueOnce(chain([previo]));
    const app = await buildApp();
    const r = await request(app).patch('/api/clients/5').set('Authorization', `Bearer ${await adminToken()}`)
      .send({ name: 'Acme', active: false });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('El estado del cliente se cambia con Activar o Desactivar.');
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('`active` igual al actual se ignora: la edición sigue (el formulario que reenvía la fila no se rompe)', async () => {
    selectMock.mockReturnValueOnce(chain([previo]));
    const setSpy = vi.fn(() => ({ where: () => ({ returning: () => Promise.resolve([{ ...previo, name: 'Acme 2' }]) }) }));
    updateMock.mockReturnValueOnce({ set: setSpy });
    const app = await buildApp();
    const r = await request(app).patch('/api/clients/5').set('Authorization', `Bearer ${await adminToken()}`)
      .send({ name: 'Acme 2', active: true });
    expect(r.status).toBe(200);
    expect(setSpy.mock.calls[0]![0]).not.toHaveProperty('active');
  });
});
