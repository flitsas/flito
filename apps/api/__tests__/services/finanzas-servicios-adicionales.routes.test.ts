// HU #12545 — rutas de los servicios adicionales de un trámite (AC3, AC4, AC5, AC6, AC7).
//
// Calco de flito-parametrizacion.routes.test.ts: `db`, `audit`, intentos denegados y redis mockeados;
// `testToken` registra al usuario con las funciones que la foto (`inventario.generado.ts`) reparte a
// su rol, así que el 403 del auditor en POST/DELETE y el 200 en GET salen del MOTOR, no de un stub.
// `db.transaction` ejecuta el callback con un `tx` propio (select/insert/delete distintos de `db`).
//
// Mutantes: M-07b cambiar `exigirFuncion('…quitar')` por `…asignar` en el DELETE → cae la paridad
// (fixture ≠ código); M-04c quitar el `audit` → 0 llamadas; M-04b persistir un `valor` del body →
// cae «values() lleva el del tipo»; M-03d quitar el 404 del trámite → 200 vacío.
process.env.TZ = 'UTC';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import type { ServiciosAdicionalesDeTramite, TramiteServicioAdicional } from '@operaciones/shared-types';
import { chain, chainReject } from '../helpers/db.js';
import { testToken, type TestRole } from '../helpers/auth.js';

const selectMock = vi.fn();
const insertMock = vi.fn();
const deleteMock = vi.fn();
const transactionMock = vi.fn();
const txSelect = vi.fn();
const txInsert = vi.fn();
const txDelete = vi.fn();
const tx = { select: txSelect, insert: txInsert, delete: txDelete };

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock, insert: insertMock, update: vi.fn(), delete: deleteMock, transaction: transactionMock,
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));

const intentoDenegadoMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/historial/permisos-intentos-denegados.js', () => ({
  registrarIntentoDenegado: intentoDenegadoMock,
  ventanaActual: () => new Date(),
  VENTANA_DEDUP_MS: 3_600_000,
}));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

const TRAMITE = '7d2f4a10-0b1c-4d2e-9f30-a1b2c3d4e5f6';
const TIPO = '3f1c2b7e-9d4a-4c8e-8f0b-1a2b3c4d5e6f';
const ASIGNACION = 'c0ffee00-1111-4222-8333-444455556666';
const T0 = new Date('2026-09-14T15:00:00.000Z');
const BASE = `/api/finanzas/tramites/${TRAMITE}/servicios-adicionales`;
const FILA_TRAMITE = { id: TRAMITE, idFlit: 'FLIT-0001' };
const FILA_TIPO = { id: TIPO, nombre: 'Diagnóstico', descripcion: 'Revisión técnica', valor: '85000.00' };
const FILA_PUENTE = {
  id: ASIGNACION, tipoId: TIPO, nombre: 'Diagnóstico', descripcion: 'Revisión técnica', valor: '85000.00',
  asignadoPorId: 7, asignadoPorNombre: 'Ana Pérez', asignadoEn: T0,
};

beforeEach(() => {
  for (const m of [selectMock, insertMock, deleteMock, transactionMock, txSelect, txInsert, txDelete]) m.mockReset();
  auditMock.mockClear();
  intentoDenegadoMock.mockClear();
  transactionMock.mockImplementation(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx));
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/finanzas-servicios-adicionales/finanzas-servicios-adicionales.routes.js');
  app.use('/api/finanzas', router);
  return app;
}

const auth = async (role: TestRole, sub = 7) => `Bearer ${await testToken({ sub, username: 'u', role })}`;

/** Grabador de `values()` para el INSERT de la transacción. */
function grabando(rows: unknown[], sobre: { values?: unknown }) {
  const c = chain(rows) as unknown as Record<string, (a: unknown) => unknown>;
  c.values = (a: unknown) => { sobre.values = a; return c; };
  return c;
}

/** El GET feliz: trámite, puente, liquidación (vacía). */
function armarGet(filas: unknown[] = [FILA_PUENTE], liquidacion: unknown[] = []) {
  selectMock.mockReturnValueOnce(chain([FILA_TRAMITE])).mockReturnValueOnce(chain(filas)).mockReturnValueOnce(chain(liquidacion));
}
/** tx.select del POST: trámite (FOR UPDATE), liquidación, tipo, actor. */
function armarPost(o: { liquidacion?: unknown[]; tipo?: unknown[] } = {}) {
  txSelect
    .mockReturnValueOnce(chain([FILA_TRAMITE]))
    .mockReturnValueOnce(chain(o.liquidacion ?? []))
    .mockReturnValueOnce(chain(o.tipo ?? [FILA_TIPO]))
    .mockReturnValueOnce(chain([{ name: 'Ana Pérez' }]));
}
/** tx.select del DELETE: trámite (FOR UPDATE), liquidación y (Bug #12913) si la asignación viene de un comprobante. */
function armarDelete(liquidacion: unknown[] = [], origen: unknown[] = [{ deComprobante: false }]) {
  txSelect.mockReturnValueOnce(chain([FILA_TRAMITE])).mockReturnValueOnce(chain(liquidacion)).mockReturnValueOnce(chain(origen));
}

describe('AC7 — acceso por función: admin y financiera escriben; auditor solo lee; cliente 403 antes de la base', () => {
  it('sin token → 401 en los tres', async () => {
    const app = await buildApp();
    expect((await request(app).get(BASE)).status).toBe(401);
    expect((await request(app).post(BASE).send({ tipoId: TIPO })).status).toBe(401);
    expect((await request(app).delete(`${BASE}/${ASIGNACION}`)).status).toBe(401);
  });

  for (const rol of ['admin', 'financiera', 'auditor'] as const) {
    it(`${rol} → GET 200`, async () => {
      armarGet();
      const app = await buildApp();
      const r = await request(app).get(BASE).set('Authorization', await auth(rol));
      expect(r.status).toBe(200);
      expect(r.headers['cache-control']).toBe('no-store');
    });
  }

  for (const rol of ['admin', 'financiera'] as const) {
    it(`${rol} → POST 201 y DELETE 204 (nunca 403)`, async () => {
      const app = await buildApp();
      armarPost();
      txInsert.mockReturnValueOnce(chain([FILA_PUENTE]));
      expect((await request(app).post(BASE).set('Authorization', await auth(rol)).send({ tipoId: TIPO })).status).toBe(201);
      armarDelete();
      txDelete.mockReturnValueOnce(chain([{ tipoId: TIPO, nombre: 'Diagnóstico', valor: '85000.00' }]));
      expect((await request(app).delete(`${BASE}/${ASIGNACION}`).set('Authorization', await auth(rol))).status).toBe(204);
    });
  }

  it('auditor → 403 en POST y DELETE sin abrir transacción', async () => {
    const app = await buildApp();
    expect((await request(app).post(BASE).set('Authorization', await auth('auditor')).send({ tipoId: TIPO })).status).toBe(403);
    expect((await request(app).delete(`${BASE}/${ASIGNACION}`).set('Authorization', await auth('auditor'))).status).toBe(403);
    expect(transactionMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  for (const rol of ['cliente', 'gestor_impuestos'] as const) {
    it(`${rol} → 403 en los tres, sin tocar la base`, async () => {
      const app = await buildApp();
      expect((await request(app).get(BASE).set('Authorization', await auth(rol))).status).toBe(403);
      expect((await request(app).post(BASE).set('Authorization', await auth(rol)).send({ tipoId: TIPO })).status).toBe(403);
      expect((await request(app).delete(`${BASE}/${ASIGNACION}`).set('Authorization', await auth(rol))).status).toBe(403);
      expect(selectMock).not.toHaveBeenCalled();
      expect(transactionMock).not.toHaveBeenCalled();
    });
  }
});

describe('AC3 — GET /tramites/:id/servicios-adicionales', () => {
  it('200 con { items, total, liquidado } tipado como ServiciosAdicionalesDeTramite; valor numérico; total sumado', async () => {
    armarGet([FILA_PUENTE, { ...FILA_PUENTE, id: 'b', tipoId: 'otro', nombre: 'Derecho de petición', valor: '40000.00' }]);
    const app = await buildApp();
    const r = await request(app).get(BASE).set('Authorization', await auth('financiera'));
    expect(r.status).toBe(200);
    const body = r.body as ServiciosAdicionalesDeTramite;
    expect(body.liquidado).toBe(false);
    expect(body.total).toBe(125000);
    expect(body.items).toHaveLength(2);
    const item: TramiteServicioAdicional = body.items[0]!;
    expect(item).toEqual({
      id: ASIGNACION, tipoId: TIPO, nombre: 'Diagnóstico', descripcion: 'Revisión técnica', valor: 85000,
      asignadoPorId: 7, asignadoPorNombre: 'Ana Pérez', asignadoEn: '2026-09-14T15:00:00.000Z', origen: 'manual',
    });
  });

  it('404 { error: "El trámite no existe" } si no existe (M-03d) y también si el :id no es uuid, sin tocar la base', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const app = await buildApp();
    const r = await request(app).get(BASE).set('Authorization', await auth('admin'));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'El trámite no existe' });
    const r2 = await request(app).get('/api/finanzas/tramites/no-uuid/servicios-adicionales').set('Authorization', await auth('admin'));
    expect(r2.status).toBe(404);
    expect(selectMock).toHaveBeenCalledTimes(1);
  });
});

describe('AC4/AC5 — POST /tramites/:id/servicios-adicionales', () => {
  it('201 con la asignación; values() lleva el snapshot del tipo y el sub del token; audit create con nombre, valor, idFlit y tipo', async () => {
    const grabado: { values?: unknown } = {};
    armarPost();
    txInsert.mockReturnValueOnce(grabando([FILA_PUENTE], grabado));
    const app = await buildApp();
    const r = await request(app).post(BASE).set('Authorization', await auth('financiera', 7)).send({ tipoId: TIPO, valor: 1 });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ id: ASIGNACION, nombre: 'Diagnóstico', descripcion: 'Revisión técnica', valor: 85000, asignadoPorId: 7, asignadoPorNombre: 'Ana Pérez' });
    // M-04b: el `valor: 1` del body se ignora; lo persistido es el del tipo.
    expect(grabado.values).toEqual({ tramiteId: TRAMITE, tipoId: TIPO, nombre: 'Diagnóstico', descripcion: 'Revisión técnica', valor: '85000.00', asignadoPorId: 7 });
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0]![1]).toEqual({
      action: 'create', resource: 'flito_tramite_servicio_adicional', resourceId: ASIGNACION,
      detail: `Servicio «Diagnóstico» (85000) asignado al trámite FLIT-0001; tipo ${TIPO}`,
    });
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });

  it('400 Zod sin body, con tipoId no uuid o no string: sin abrir transacción', async () => {
    const app = await buildApp();
    for (const body of [undefined, {}, { tipoId: 'abc' }, { tipoId: 123 }]) {
      const r = await request(app).post(BASE).set('Authorization', await auth('admin')).send(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error).toMatch(/^Datos inválidos: tipoId /);
    }
    expect(transactionMock).not.toHaveBeenCalled();
    expect(selectMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('404 TIPO_NO_DISPONIBLE si el tipo no existe o está de baja; sin insertar ni auditar', async () => {
    armarPost({ tipo: [] });
    const app = await buildApp();
    const r = await request(app).post(BASE).set('Authorization', await auth('admin')).send({ tipoId: TIPO });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'El tipo de servicio adicional no existe o está dado de baja', codigo: 'TIPO_NO_DISPONIBLE' });
    expect(txInsert).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('409 SERVICIO_YA_ASIGNADO cuando el INSERT choca con el UNIQUE (23505), no 500; sin auditar', async () => {
    armarPost();
    txInsert.mockReturnValueOnce(chainReject(Object.assign(new Error('duplicate key'), { code: '23505' })));
    const app = await buildApp();
    const r = await request(app).post(BASE).set('Authorization', await auth('admin')).send({ tipoId: TIPO });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'Ese servicio ya está asignado a este trámite', codigo: 'SERVICIO_YA_ASIGNADO' });
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('409 TRAMITE_LIQUIDADO con el mensaje literal si hay liquidación; sin insertar (M1)', async () => {
    armarPost({ liquidacion: [{ id: 'liq-1' }] });
    const app = await buildApp();
    const r = await request(app).post(BASE).set('Authorization', await auth('financiera')).send({ tipoId: TIPO });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'Reversa la liquidación para cambiar los servicios', codigo: 'TRAMITE_LIQUIDADO' });
    expect(txInsert).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('404 si el trámite no existe (dentro de la transacción) y si el :id no es uuid (sin transacción)', async () => {
    txSelect.mockReturnValueOnce(chain([]));
    const app = await buildApp();
    const r = await request(app).post(BASE).set('Authorization', await auth('admin')).send({ tipoId: TIPO });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'El trámite no existe' });
    const r2 = await request(app).post('/api/finanzas/tramites/nope/servicios-adicionales').set('Authorization', await auth('admin')).send({ tipoId: TIPO });
    expect(r2.status).toBe(404);
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });
});

describe('AC6 — DELETE /tramites/:id/servicios-adicionales/:asignacionId', () => {
  it('204 sin cuerpo; audit delete con nombre y valor del snapshot (leídos por RETURNING), idFlit y tipo', async () => {
    armarDelete();
    txDelete.mockReturnValueOnce(chain([{ tipoId: TIPO, nombre: 'Diagnóstico', valor: '85000.00' }]));
    const app = await buildApp();
    const r = await request(app).delete(`${BASE}/${ASIGNACION}`).set('Authorization', await auth('admin'));
    expect(r.status).toBe(204);
    expect(r.text).toBe('');
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0]![1]).toEqual({
      action: 'delete', resource: 'flito_tramite_servicio_adicional', resourceId: ASIGNACION,
      detail: `Servicio «Diagnóstico» (85000) quitado del trámite FLIT-0001; tipo ${TIPO}`,
    });
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('404 si la asignación no existe o es de otro trámite (0 filas); 404 si el :asignacionId no es uuid, sin transacción', async () => {
    armarDelete();
    txDelete.mockReturnValueOnce(chain([]));
    const app = await buildApp();
    const r = await request(app).delete(`${BASE}/${ASIGNACION}`).set('Authorization', await auth('admin'));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'La asignación no existe en este trámite' });
    const r2 = await request(app).delete(`${BASE}/nope`).set('Authorization', await auth('admin'));
    expect(r2.status).toBe(404);
    expect(r2.body).toEqual({ error: 'La asignación no existe en este trámite' });
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('Bug #12913 — 409 ASIGNACION_DE_COMPROBANTE (mensaje literal) si la asignación viene de un comprobante de pago aplicado: sin borrar ni auditar', async () => {
    armarDelete([], [{ deComprobante: true }]);
    const app = await buildApp();
    const r = await request(app).delete(`${BASE}/${ASIGNACION}`).set('Authorization', await auth('financiera'));
    expect(r.status).toBe(409);
    expect(r.body).toEqual({
      error: 'Este servicio viene de un comprobante de pago aplicado; no se puede quitar desde el panel', codigo: 'ASIGNACION_DE_COMPROBANTE',
    });
    expect(txDelete).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('409 TRAMITE_LIQUIDADO sin borrar ni auditar (M1 por el DELETE)', async () => {
    armarDelete([{ id: 'liq-1' }]);
    const app = await buildApp();
    const r = await request(app).delete(`${BASE}/${ASIGNACION}`).set('Authorization', await auth('financiera'));
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'Reversa la liquidación para cambiar los servicios', codigo: 'TRAMITE_LIQUIDADO' });
    expect(txDelete).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });
});
