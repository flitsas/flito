// HU #12619 — rutas de los viajes adicionales de logística (AC2, AC3, AC5, AC6, AC7, AC8, AC9, AC10, AC11, AC13).
//
// Calco de finanzas-servicios-adicionales.routes.test.ts: `db`, `audit`, intentos denegados, redis y
// `tarifaDe` mockeados; `testToken` registra al usuario con las funciones que la foto
// (`inventario.generado.ts`) reparte a su rol, así que el 200/201/204 del admin y el 403 de TODOS los
// demás salen del MOTOR, no de un stub. `db.transaction` ejecuta el callback con un `tx` propio.
//
// Mutantes: cambiar `exigirFuncion('…quitar')` por `…registrar` en el DELETE → cae la paridad
// (fixture ≠ código, permisos-catalogo.test.ts); quitar el `audit` → 0 llamadas; aceptar `valor` en
// `inicial` → cae «inicial con valor → 400»; quitar el 404 del uuid → 500/22P02 en vez de 404.
process.env.TZ = 'UTC';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import type { ViajeLogistica, ViajesLogisticaDeTramite } from '@operaciones/shared-types';
import { chain } from '../helpers/db.js';
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

const tarifaDeMock = vi.fn();
vi.mock('../../src/modules/flito-parametrizacion/flito-tarifas.service.js', () => ({ tarifaDe: tarifaDeMock }));

const TRAMITE = '7d2f4a10-0b1c-4d2e-9f30-a1b2c3d4e5f6';
const VIAJE = 'c0ffee00-1111-4222-8333-444455556666';
const T0 = new Date('2026-09-16T15:00:00.000Z');
const BASE = `/api/flito/logistica/tramites/${TRAMITE}/viajes`;
const FILA_TRAMITE = { id: TRAMITE, idFlit: 'FLIT-0001' };
const CTX_GESTIONA = { id: TRAMITE, idFlit: 'FLIT-0001', companiaId: 12, logisticaAutogestionable: false, excepcionViva: false };
const CTX_AUTOGESTIONA = { ...CTX_GESTIONA, logisticaAutogestionable: true };
const CTX_CON_EXCEPCION = { ...CTX_AUTOGESTIONA, excepcionViva: true };
const FILA_VIAJE = {
  id: VIAJE, numero: 2, modo: 'inicial', valor: '45000.00', tarifaVigente: '45000.00', motivo: 'devolucion',
  motivoDetalle: null, registradoPorId: 7, registradoPorNombre: 'Ana Pérez', registradoEn: T0,
};
const TARIFA_45 = { valor: 45000, origen: 'generica' };
const SIN_TARIFA = { valor: null, origen: 'no_configurada' };
const INICIAL = { modo: 'inicial', motivo: 'devolucion' };
const ROLES_SIN_FUNCION: TestRole[] = ['financiera', 'auditor', 'mensajero', 'cliente', 'gestor_impuestos', 'transito', 'proveedor'];

beforeEach(() => {
  for (const m of [selectMock, insertMock, deleteMock, transactionMock, txSelect, txInsert, txDelete, tarifaDeMock]) m.mockReset();
  auditMock.mockClear();
  intentoDenegadoMock.mockClear();
  transactionMock.mockImplementation(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx));
  tarifaDeMock.mockResolvedValue(TARIFA_45);
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-logistica/flito-logistica-viajes.routes.js');
  app.use('/api/flito/logistica', router);
  return app;
}

const auth = async (role: TestRole, sub = 7) => `Bearer ${await testToken({ sub, username: 'u', role })}`;

/** Grabador de `values()` para el INSERT de la transacción. */
function grabando(rows: unknown[], sobre: { values?: unknown }) {
  const c = chain(rows) as unknown as Record<string, (a: unknown) => unknown>;
  c.values = (a: unknown) => { sobre.values = a; return c; };
  return c;
}

/** El GET feliz: contexto, liquidación (vacía), viajes. */
function armarGet(o: { ctx?: unknown; liquidacion?: unknown[]; viajes?: unknown[] } = {}) {
  selectMock.mockReturnValueOnce(chain([o.ctx ?? CTX_GESTIONA])).mockReturnValueOnce(chain(o.liquidacion ?? []));
  if (o.viajes !== undefined) selectMock.mockReturnValueOnce(chain(o.viajes));
}
/** tx.select del POST: trámite (FOR UPDATE), liquidación, contexto, MAX, actor. */
function armarPost(o: { liquidacion?: unknown[]; ctx?: unknown; max?: number } = {}) {
  txSelect
    .mockReturnValueOnce(chain([FILA_TRAMITE]))
    .mockReturnValueOnce(chain(o.liquidacion ?? []))
    .mockReturnValueOnce(chain([o.ctx ?? CTX_GESTIONA]))
    .mockReturnValueOnce(chain([{ siguiente: o.max ?? 2 }]))
    .mockReturnValueOnce(chain([{ name: 'Ana Pérez' }]));
}
/** tx.select del DELETE: trámite (FOR UPDATE), liquidación. */
function armarDelete(liquidacion: unknown[] = []) {
  txSelect.mockReturnValueOnce(chain([FILA_TRAMITE])).mockReturnValueOnce(chain(liquidacion));
}

describe('AC11 — acceso por función: admin las tres; ningún otro rol; 403 sin tocar la base', () => {
  it('sin token → 401 en los tres', async () => {
    const app = await buildApp();
    expect((await request(app).get(BASE)).status).toBe(401);
    expect((await request(app).post(BASE).send(INICIAL)).status).toBe(401);
    expect((await request(app).delete(`${BASE}/${VIAJE}`)).status).toBe(401);
  });

  it('admin → GET 200 (no-store), POST 201 y DELETE 204', async () => {
    const app = await buildApp();
    armarGet({ viajes: [FILA_VIAJE] });
    const g = await request(app).get(BASE).set('Authorization', await auth('admin'));
    expect(g.status).toBe(200);
    expect(g.headers['cache-control']).toBe('no-store');
    armarPost();
    txInsert.mockReturnValueOnce(chain([FILA_VIAJE]));
    expect((await request(app).post(BASE).set('Authorization', await auth('admin')).send(INICIAL)).status).toBe(201);
    armarDelete();
    txDelete.mockReturnValueOnce(chain([{ numero: 2, modo: 'inicial', valor: '45000.00' }]));
    expect((await request(app).delete(`${BASE}/${VIAJE}`).set('Authorization', await auth('admin'))).status).toBe(204);
  });

  for (const rol of ROLES_SIN_FUNCION) {
    it(`${rol} → 403 en los tres, sin tocar la base (el reparto de la 0199 es solo admin)`, async () => {
      const app = await buildApp();
      expect((await request(app).get(BASE).set('Authorization', await auth(rol))).status).toBe(403);
      expect((await request(app).post(BASE).set('Authorization', await auth(rol)).send(INICIAL)).status).toBe(403);
      expect((await request(app).delete(`${BASE}/${VIAJE}`).set('Authorization', await auth(rol))).status).toBe(403);
      expect(selectMock).not.toHaveBeenCalled();
      expect(transactionMock).not.toHaveBeenCalled();
      expect(auditMock).not.toHaveBeenCalled();
    });
  }
});

describe('AC5 — GET: la forma exacta del contrato', () => {
  it('200 con tramiteId, idFlit, gestionaLogistica, liquidado, tarifaVigente, items, totalViajes, totalAdicionales', async () => {
    armarGet({ viajes: [FILA_VIAJE, { ...FILA_VIAJE, id: 'b', numero: 3, modo: 'manual', valor: '62000.00' }] });
    const app = await buildApp();
    const r = await request(app).get(BASE).set('Authorization', await auth('admin'));
    expect(r.status).toBe(200);
    const cuerpo = r.body as ViajesLogisticaDeTramite;
    expect(cuerpo).toEqual({
      tramiteId: TRAMITE, idFlit: 'FLIT-0001', gestionaLogistica: true, liquidado: false, tarifaVigente: 45000,
      items: [
        { id: VIAJE, numero: 2, modo: 'inicial', valor: 45000, tarifaVigente: 45000, motivo: 'devolucion', motivoDetalle: null, registradoPorId: 7, registradoPorNombre: 'Ana Pérez', registradoEn: '2026-09-16T15:00:00.000Z' },
        { id: 'b', numero: 3, modo: 'manual', valor: 62000, tarifaVigente: 45000, motivo: 'devolucion', motivoDetalle: null, registradoPorId: 7, registradoPorNombre: 'Ana Pérez', registradoEn: '2026-09-16T15:00:00.000Z' },
      ],
      totalViajes: 3, totalAdicionales: 107000,
    });
  });

  it('cero viajes → items [], totalViajes 1, totalAdicionales 0; sin tarifa → tarifaVigente null (nunca 0)', async () => {
    tarifaDeMock.mockResolvedValue(SIN_TARIFA);
    armarGet({ viajes: [] });
    const app = await buildApp();
    const r = await request(app).get(BASE).set('Authorization', await auth('admin'));
    expect(r.body).toMatchObject({ items: [], totalViajes: 1, totalAdicionales: 0, tarifaVigente: null });
    expect(r.body.tarifaVigente).not.toBe(0);
  });

  it('AC8: compañía que autogestiona sin excepción → gestionaLogistica false, items [], totalViajes 0', async () => {
    armarGet({ ctx: CTX_AUTOGESTIONA });
    const app = await buildApp();
    const r = await request(app).get(BASE).set('Authorization', await auth('admin'));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ gestionaLogistica: false, items: [], totalViajes: 0, totalAdicionales: 0 });
  });

  it('liquidado: true cuando hay fila en flito_liquidaciones', async () => {
    armarGet({ liquidacion: [{ id: 'liq-1' }], viajes: [] });
    const app = await buildApp();
    expect((await request(app).get(BASE).set('Authorization', await auth('admin'))).body.liquidado).toBe(true);
  });
});

describe('AC2/AC3/AC9 — POST: inicial copia la tarifa, manual fija el precio', () => {
  it('inicial → 201 con numero 2, valor = tarifaVigente = 45000; values() lleva el snapshot; auditoría create sin PII', async () => {
    armarPost();
    const grabado: { values?: unknown } = {};
    txInsert.mockReturnValueOnce(grabando([FILA_VIAJE], grabado));
    const app = await buildApp();
    const r = await request(app).post(BASE).set('Authorization', await auth('admin')).send(INICIAL);
    expect(r.status).toBe(201);
    const v = r.body as ViajeLogistica;
    expect(v).toMatchObject({ id: VIAJE, numero: 2, modo: 'inicial', valor: 45000, tarifaVigente: 45000, registradoPorNombre: 'Ana Pérez' });
    expect(grabado.values).toEqual({
      tramiteId: TRAMITE, numero: 2, modo: 'inicial', valor: '45000.00', tarifaVigente: '45000.00',
      motivo: 'devolucion', motivoDetalle: null, registradoPorId: 7,
    });
    expect(tarifaDeMock).toHaveBeenCalledWith(12, 'logistica', null, null);
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0]![1]).toEqual({
      action: 'create', resource: 'flito_tramite_viaje_logistica', resourceId: VIAJE,
      detail: 'Viaje adicional #2 (inicial, 45000) registrado en el trámite FLIT-0001',
    });
  });

  it('manual 62000 + otro + detalle → 201 con tarifaVigente 45000 y valor 62000', async () => {
    armarPost();
    const grabado: { values?: unknown } = {};
    txInsert.mockReturnValueOnce(grabando([{ ...FILA_VIAJE, modo: 'manual', valor: '62000.00', motivo: 'otro', motivoDetalle: 'Portería cerrada' }], grabado));
    const app = await buildApp();
    const r = await request(app).post(BASE).set('Authorization', await auth('admin'))
      .send({ modo: 'manual', valor: 62000, motivo: 'otro', motivoDetalle: '  Portería cerrada  ' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ modo: 'manual', valor: 62000, tarifaVigente: 45000, motivo: 'otro', motivoDetalle: 'Portería cerrada' });
    expect(grabado.values).toMatchObject({ modo: 'manual', valor: '62000.00', tarifaVigente: '45000.00', motivo: 'otro', motivoDetalle: 'Portería cerrada' });
  });

  it.each([[0, '0.00'], [1e9, '1000000000.00']])('manual valor %s → 201 (grabado %s)', async (valor, numeric) => {
    armarPost();
    const grabado: { values?: unknown } = {};
    txInsert.mockReturnValueOnce(grabando([{ ...FILA_VIAJE, modo: 'manual', valor: numeric }], grabado));
    const app = await buildApp();
    const r = await request(app).post(BASE).set('Authorization', await auth('admin')).send({ modo: 'manual', valor, motivo: 'segunda_entrega' });
    expect(r.status).toBe(201);
    expect(grabado.values).toMatchObject({ valor: numeric });
  });

  it('manual sin tarifa configurada → 201 con tarifaVigente null', async () => {
    tarifaDeMock.mockResolvedValue(SIN_TARIFA);
    armarPost();
    txInsert.mockReturnValueOnce(chain([{ ...FILA_VIAJE, modo: 'manual', valor: '30000.00', tarifaVigente: null }]));
    const app = await buildApp();
    const r = await request(app).post(BASE).set('Authorization', await auth('admin')).send({ modo: 'manual', valor: 30000, motivo: 'documento_faltante' });
    expect(r.status).toBe(201);
    expect(r.body.tarifaVigente).toBeNull();
  });

  it('inicial sin tarifa → 422 TARIFA_LOGISTICA_NO_CONFIGURADA sin INSERT ni auditoría', async () => {
    tarifaDeMock.mockResolvedValue(SIN_TARIFA);
    armarPost();
    const app = await buildApp();
    const r = await request(app).post(BASE).set('Authorization', await auth('admin')).send(INICIAL);
    expect(r.status).toBe(422);
    expect(r.body).toEqual({ error: 'La compañía no tiene tarifa de logística vigente; fija el precio a mano o configura la tarifa', codigo: 'TARIFA_LOGISTICA_NO_CONFIGURADA' });
    expect(txInsert).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('AC8: autogestiona sin excepción → 409 LOGISTICA_AUTOGESTIONADA; con excepción viva → 201', async () => {
    const app = await buildApp();
    armarPost({ ctx: CTX_AUTOGESTIONA });
    const r = await request(app).post(BASE).set('Authorization', await auth('admin')).send(INICIAL);
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'La logística de esta compañía la gestiona el cliente; FLITO no registra viajes', codigo: 'LOGISTICA_AUTOGESTIONADA' });
    expect(txInsert).not.toHaveBeenCalled();
    // El 409 salió tras 3 lecturas: se vacía la cola del mock antes de armar el caso feliz.
    txSelect.mockReset();
    armarPost({ ctx: CTX_CON_EXCEPCION });
    txInsert.mockReturnValueOnce(chain([FILA_VIAJE]));
    expect((await request(app).post(BASE).set('Authorization', await auth('admin')).send(INICIAL)).status).toBe(201);
  });
});

describe('AC10 — 400 de Zod con «Datos inválidos: campo regla»; nada llega a la base', () => {
  const casos: [string, Record<string, unknown>, RegExp][] = [
    ['sin motivo', { modo: 'inicial' }, /motivo es obligatorio/],
    ['motivo fuera de lista', { modo: 'inicial', motivo: 'lluvia' }, /motivo /],
    ['otro sin detalle', { modo: 'inicial', motivo: 'otro' }, /motivoDetalle es obligatorio cuando el motivo es «otro»/],
    ['otro con detalle en blanco', { modo: 'inicial', motivo: 'otro', motivoDetalle: '   ' }, /motivoDetalle no puede estar en blanco/],
    ['detalle de 301 caracteres', { modo: 'inicial', motivo: 'devolucion', motivoDetalle: 'x'.repeat(301) }, /motivoDetalle no puede superar 300 caracteres/],
    ['inicial con valor (strict)', { modo: 'inicial', motivo: 'devolucion', valor: 1000 }, /valor/],
    ['manual sin valor', { modo: 'manual', motivo: 'devolucion' }, /valor es obligatorio/],
    ['manual con valor -1', { modo: 'manual', motivo: 'devolucion', valor: -1 }, /valor debe ser mayor o igual a 0/],
    ['manual con valor texto', { modo: 'manual', motivo: 'devolucion', valor: '62000' }, /valor debe ser un número/],
    ['sin modo', { motivo: 'devolucion' }, /modo/],
    ['modo desconocido', { modo: 'gratis', motivo: 'devolucion' }, /modo/],
  ];
  for (const [nombre, body, patron] of casos) {
    it(`${nombre} → 400`, async () => {
      const app = await buildApp();
      const r = await request(app).post(BASE).set('Authorization', await auth('admin')).send(body);
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/^Datos inválidos: /);
      expect(r.body.error).toMatch(patron);
      expect(transactionMock).not.toHaveBeenCalled();
      expect(auditMock).not.toHaveBeenCalled();
    });
  }

  it('detalle de 300 caracteres exactos con motivo devolucion (opcional fuera de otro) → 201', async () => {
    armarPost();
    txInsert.mockReturnValueOnce(chain([{ ...FILA_VIAJE, motivoDetalle: 'x'.repeat(300) }]));
    const app = await buildApp();
    const r = await request(app).post(BASE).set('Authorization', await auth('admin')).send({ modo: 'inicial', motivo: 'devolucion', motivoDetalle: 'x'.repeat(300) });
    expect(r.status).toBe(201);
  });
});

describe('AC7 — trámite liquidado: 409 TRAMITE_LIQUIDADO en POST y DELETE, dentro de la transacción', () => {
  it('POST → 409 sin INSERT; DELETE → 409 sin DELETE; sin auditoría', async () => {
    const app = await buildApp();
    armarPost({ liquidacion: [{ id: 'liq-1' }] });
    const p = await request(app).post(BASE).set('Authorization', await auth('admin')).send(INICIAL);
    expect(p.status).toBe(409);
    expect(p.body).toEqual({ error: 'Reversa la liquidación para cambiar los viajes', codigo: 'TRAMITE_LIQUIDADO' });
    armarDelete([{ id: 'liq-1' }]);
    const d = await request(app).delete(`${BASE}/${VIAJE}`).set('Authorization', await auth('admin'));
    expect(d.status).toBe(409);
    expect(d.body.codigo).toBe('TRAMITE_LIQUIDADO');
    expect(txInsert).not.toHaveBeenCalled();
    expect(txDelete).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
    expect(transactionMock).toHaveBeenCalledTimes(2);
    expect(selectMock).not.toHaveBeenCalled();
  });
});

describe('AC6 — DELETE: 204 físico con auditoría; 404 VIAJE_NO_ENCONTRADO; sin PUT/PATCH', () => {
  it('204 y auditoría delete con número, modo y valor', async () => {
    armarDelete();
    txDelete.mockReturnValueOnce(chain([{ numero: 3, modo: 'manual', valor: '62000.00' }]));
    const app = await buildApp();
    const r = await request(app).delete(`${BASE}/${VIAJE}`).set('Authorization', await auth('admin'));
    expect(r.status).toBe(204);
    expect(auditMock.mock.calls[0]![1]).toEqual({
      action: 'delete', resource: 'flito_tramite_viaje_logistica', resourceId: VIAJE,
      detail: 'Viaje adicional #3 (manual, 62000) quitado del trámite FLIT-0001',
    });
  });

  it('viaje inexistente o de otro trámite (cero filas) → 404 VIAJE_NO_ENCONTRADO sin auditoría', async () => {
    armarDelete();
    txDelete.mockReturnValueOnce(chain([]));
    const app = await buildApp();
    const r = await request(app).delete(`${BASE}/${VIAJE}`).set('Authorization', await auth('admin'));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'El viaje no existe en este trámite', codigo: 'VIAJE_NO_ENCONTRADO' });
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('viajeId que no es uuid → 404 VIAJE_NO_ENCONTRADO sin abrir transacción', async () => {
    const app = await buildApp();
    const r = await request(app).delete(`${BASE}/no-es-uuid`).set('Authorization', await auth('admin'));
    expect(r.status).toBe(404);
    expect(r.body.codigo).toBe('VIAJE_NO_ENCONTRADO');
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('PUT y PATCH no existen (404 de Express)', async () => {
    const app = await buildApp();
    expect((await request(app).put(`${BASE}/${VIAJE}`).set('Authorization', await auth('admin')).send({})).status).toBe(404);
    expect((await request(app).patch(`${BASE}/${VIAJE}`).set('Authorization', await auth('admin')).send({})).status).toBe(404);
    expect(transactionMock).not.toHaveBeenCalled();
  });
});

describe('AC13 — tramiteId inexistente o que no es uuid → 404 «El trámite no existe» en las tres', () => {
  it('no-uuid → 404 en GET/POST/DELETE sin tocar la base', async () => {
    const app = await buildApp();
    const base = '/api/flito/logistica/tramites/FLIT-0001/viajes';
    for (const r of [
      await request(app).get(base).set('Authorization', await auth('admin')),
      await request(app).post(base).set('Authorization', await auth('admin')).send(INICIAL),
      await request(app).delete(`${base}/${VIAJE}`).set('Authorization', await auth('admin')),
    ]) {
      expect(r.status).toBe(404);
      expect(r.body).toEqual({ error: 'El trámite no existe' });
    }
    expect(selectMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('uuid inexistente → 404 en GET (sin fila de contexto), POST y DELETE (sin fila al bloquear)', async () => {
    const app = await buildApp();
    selectMock.mockReturnValueOnce(chain([]));
    expect((await request(app).get(BASE).set('Authorization', await auth('admin'))).body).toEqual({ error: 'El trámite no existe' });
    txSelect.mockReturnValueOnce(chain([]));
    expect((await request(app).post(BASE).set('Authorization', await auth('admin')).send(INICIAL)).status).toBe(404);
    txSelect.mockReturnValueOnce(chain([]));
    expect((await request(app).delete(`${BASE}/${VIAJE}`).set('Authorization', await auth('admin'))).status).toBe(404);
    expect(auditMock).not.toHaveBeenCalled();
  });
});
