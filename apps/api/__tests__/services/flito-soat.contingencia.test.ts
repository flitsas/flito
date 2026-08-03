// FLITO SOAT — contingencia (Feature #11150): envío a gestión de Operaciones (HU #11152) y traspaso
// de gestión sobre un SOAT ya enviado (HU #11153).
//
// Lo que se prueba aquí no es «se llamó a update», sino QUÉ se escribe: la diferencia entre los dos
// destinos de envío, y la de asumir frente a devolver, vive entera en el payload del `set` y en el
// motivo que va al historial. El helper `chain` no registra argumentos, así que estos tests
// envuelven el chain con un recorder para poder afirmar sobre el contenido.
//
// Los asserts negativos (`not.toHaveProperty`) importan tanto como los positivos: buena parte del
// contrato es lo que el traspaso NO toca — estado, fecha de envío, proveedor de origen.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();
const updateMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, update: updateMock, insert: vi.fn(), delete: vi.fn(), transaction: transactionMock, execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

beforeEach(() => { selectMock.mockReset(); updateMock.mockReset(); transactionMock.mockReset(); });

const SOAT_ID = '00000000-0000-0000-0000-000000000001';
const PROVEEDOR_ID = '00000000-0000-0000-0000-0000000000aa';
const USER_ID = 7;

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-soat/flito-soat.routes.js');
  app.use('/api/flito/soat', router);
  return app;
}
const auth = async (role: string) => `Bearer ${await testToken({ sub: USER_ID, username: 'ops@flitsas.com', role: role as never })}`;

/**
 * Monta la transacción del envío y devuelve lo que se escribió: los payloads de `update().set()` y
 * las filas de `insert().values()` (que es por donde pasa el historial de estados).
 */
function montarTx(filasBloqueadas: { id: string }[] = [{ id: SOAT_ID }], filaActualizada: unknown = { id: SOAT_ID }) {
  const sets: Record<string, unknown>[] = [];
  const inserts: unknown[] = [];

  const txSelect = vi.fn().mockReturnValue(chain(filasBloqueadas));
  // El chain del update resuelve a la fila actualizada: las rutas de traspaso hacen
  // `const [updated] = await ...returning()` y leen su `id`.
  const txUpdate = vi.fn(() => {
    const c = chain([filaActualizada]);
    return { ...c, set: (v: Record<string, unknown>) => { sets.push(v); return c; } };
  });
  const txInsert = vi.fn(() => {
    const c = chain([]);
    return { ...c, values: (v: unknown) => { inserts.push(v); return c; } };
  });

  transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({ select: txSelect, update: txUpdate, insert: txInsert }));

  return { sets, inserts, txUpdate };
}

/** Las filas de historial son el único insert del envío; se aplana porque va en lote. */
const historial = (inserts: unknown[]) => inserts.flat() as Array<Record<string, unknown>>;

describe('flito-soat — envío a gestión de Operaciones (HU #11152)', () => {
  it('AC1 — marca la contingencia, deja el SOAT sin proveedor y anota quién la asumió', async () => {
    const { sets, inserts, txUpdate } = montarTx();

    const r = await request(await buildApp()).post('/api/flito/soat/enviar')
      .set('Authorization', await auth('admin'))
      .send({ ids: [SOAT_ID], gestionOperaciones: true });

    expect(r.status).toBe(200);
    expect(r.body.enviados).toEqual([SOAT_ID]);
    expect(txUpdate).toHaveBeenCalledTimes(1);

    expect(sets[0]).toMatchObject({
      estado: 'solicitado',
      gestionOperaciones: true,
      gestionOperacionesPorId: USER_ID,
      // Sin proveedor, y explícitamente a null: una reversa previa pudo dejar un resto.
      proveedorSoatId: null,
      proveedorSobrescrito: false,
      enviadoPorId: USER_ID,
    });
    expect(sets[0].gestionOperacionesEn).toBeInstanceOf(Date);

    expect(historial(inserts)[0]).toMatchObject({
      concepto: 'soat',
      registroId: SOAT_ID,
      estadoAnterior: 'pendiente',
      estadoNuevo: 'solicitado',
      motivo: 'Envío a gestión de Operaciones',
      usuarioId: USER_ID,
    });
  });

  it('AC2 — el envío con proveedor no queda marcado como contingencia', async () => {
    const { sets, inserts } = montarTx();

    const r = await request(await buildApp()).post('/api/flito/soat/enviar')
      .set('Authorization', await auth('admin'))
      .send({ ids: [SOAT_ID], proveedorSoatId: PROVEEDOR_ID });

    expect(r.status).toBe(200);
    expect(sets[0]).toMatchObject({
      estado: 'solicitado',
      proveedorSoatId: PROVEEDOR_ID,
      proveedorSobrescrito: true,
    });
    // Ni siquiera se toca la columna: el default de la tabla ya es false.
    expect(sets[0]).not.toHaveProperty('gestionOperaciones');
    expect(historial(inserts)[0]).toMatchObject({ motivo: 'Envío al gestor' });
  });

  it('AC3 — sin destino → 400 y no se escribe nada', async () => {
    const { txUpdate } = montarTx();
    const r = await request(await buildApp()).post('/api/flito/soat/enviar')
      .set('Authorization', await auth('admin'))
      .send({ ids: [SOAT_ID] });

    expect(r.status).toBe(400);
    expect(txUpdate).not.toHaveBeenCalled();
  });

  it('AC3 — con los dos destinos a la vez → 400 y no se escribe nada', async () => {
    const { txUpdate } = montarTx();
    const r = await request(await buildApp()).post('/api/flito/soat/enviar')
      .set('Authorization', await auth('admin'))
      .send({ ids: [SOAT_ID], proveedorSoatId: PROVEEDOR_ID, gestionOperaciones: true });

    expect(r.status).toBe(400);
    expect(txUpdate).not.toHaveBeenCalled();
  });

  it('AC3 — `gestionOperaciones: false` no cuenta como destino', async () => {
    const { txUpdate } = montarTx();
    const r = await request(await buildApp()).post('/api/flito/soat/enviar')
      .set('Authorization', await auth('admin'))
      .send({ ids: [SOAT_ID], gestionOperaciones: false });

    expect(r.status).toBe(400);
    expect(txUpdate).not.toHaveBeenCalled();
  });

  for (const rol of ['proveedor', 'gestor_impuestos', 'auditor']) {
    it(`AC4 — ${rol} no puede enviar a gestión de Operaciones → 403`, async () => {
      const { txUpdate } = montarTx();
      const r = await request(await buildApp()).post('/api/flito/soat/enviar')
        .set('Authorization', await auth(rol))
        .send({ ids: [SOAT_ID], gestionOperaciones: true });

      expect(r.status).toBe(403);
      expect(txUpdate).not.toHaveBeenCalled();
    });
  }

  it('AC6 — el envío sigue siendo un solo update sobre lo que el lock dejó pasar', async () => {
    // El segundo id no vuelve del SELECT ... FOR UPDATE SKIP LOCKED: otro usuario lo tenía.
    const otro = '00000000-0000-0000-0000-000000000002';
    const { sets, inserts, txUpdate } = montarTx([{ id: SOAT_ID }]);

    const r = await request(await buildApp()).post('/api/flito/soat/enviar')
      .set('Authorization', await auth('admin'))
      .send({ ids: [SOAT_ID, otro], gestionOperaciones: true });

    expect(r.status).toBe(200);
    expect(r.body.enviados).toEqual([SOAT_ID]);
    expect(r.body.yaEnviados).toEqual([otro]);
    expect(txUpdate).toHaveBeenCalledTimes(1);
    // El historial cuenta lo que pasó, no lo que se intentó.
    expect(historial(inserts)).toHaveLength(1);
    // Y en ningún caso la fila queda con las dos formas de gestión.
    expect(sets[0].proveedorSoatId).toBeNull();
    expect(sets[0].gestionOperaciones).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HU #11153 — traspaso de gestión sobre un SOAT YA enviado: Operaciones lo asume, y se lo devuelve
// al proveedor cuando este puede retomarlo. Sin reversar el estado y sin perder de quién se retomó.

const PROVEEDOR_DESTINO = '00000000-0000-0000-0000-0000000000bb';

/** Fila de `flito_soat` tal como la lee el servicio antes de decidir. */
const soatEn = (over: Record<string, unknown> = {}) => ({
  id: SOAT_ID,
  estado: 'solicitado',
  gestionOperaciones: false,
  proveedorSoatId: PROVEEDOR_ID,
  enviadoEn: new Date('2026-07-01T10:00:00Z'),
  motivoRechazo: null,
  ...over,
});

const asumir = async (rol: string, body: unknown) =>
  request(await buildApp()).post(`/api/flito/soat/${SOAT_ID}/asumir-operaciones`)
    .set('Authorization', await auth(rol)).send(body as object);

const devolver = async (rol: string, body: unknown) =>
  request(await buildApp()).post(`/api/flito/soat/${SOAT_ID}/devolver-gestor`)
    .set('Authorization', await auth(rol)).send(body as object);

describe('flito-soat — asumir y devolver la gestión (HU #11153)', () => {
  it('AC1 — asumir marca la contingencia, conserva estado, fecha de envío y proveedor de origen', async () => {
    selectMock.mockReturnValueOnce(chain([soatEn()]));
    selectMock.mockReturnValue(chain([])); // el detalle de la respuesta
    const { sets, inserts } = montarTx();

    const r = await asumir('admin', { motivo: 'el proveedor no responde desde el lunes' });

    expect(r.status).toBe(200);
    expect(sets[0]).toMatchObject({
      gestionOperaciones: true,
      gestionOperacionesMotivo: 'el proveedor no responde desde el lunes',
      gestionOperacionesPorId: USER_ID,
    });
    // Ni el estado, ni la fecha de envío, ni el proveedor se tocan.
    expect(sets[0]).not.toHaveProperty('estado');
    expect(sets[0]).not.toHaveProperty('enviadoEn');
    expect(sets[0]).not.toHaveProperty('proveedorSoatId');

    // AC8 — el historial dice de quién se retomó.
    expect(historial(inserts)[0]).toMatchObject({
      concepto: 'soat',
      estadoAnterior: 'solicitado',
      estadoNuevo: 'solicitado',
      usuarioId: USER_ID,
    });
    expect(historial(inserts)[0].motivo).toContain(PROVEEDOR_ID);
    expect(historial(inserts)[0].motivo).toContain('el proveedor no responde desde el lunes');
  });

  it('AC2 — devolver limpia las marcas y asigna el proveedor de destino', async () => {
    selectMock.mockReturnValueOnce(chain([soatEn({ gestionOperaciones: true, proveedorSoatId: PROVEEDOR_ID })]));
    selectMock.mockReturnValueOnce(chain([{ id: PROVEEDOR_DESTINO }])); // el proveedor existe
    selectMock.mockReturnValue(chain([]));
    const { sets, inserts } = montarTx();

    const r = await devolver('admin', { proveedorSoatId: PROVEEDOR_DESTINO, motivo: 'el proveedor ya puede retomarlo' });

    expect(r.status).toBe(200);
    expect(sets[0]).toMatchObject({
      gestionOperaciones: false,
      gestionOperacionesMotivo: null,
      gestionOperacionesPorId: null,
      gestionOperacionesEn: null,
      proveedorSoatId: PROVEEDOR_DESTINO,
      proveedorSobrescrito: true,
    });
    expect(historial(inserts)[0].motivo).toContain(PROVEEDOR_DESTINO);
  });

  it('AC3 — un SOAT Con novedad también se puede asumir, y conserva su estado', async () => {
    selectMock.mockReturnValueOnce(chain([soatEn({ estado: 'con_novedad', motivoRechazo: 'placa ilegible' })]));
    selectMock.mockReturnValue(chain([]));
    const { sets, inserts } = montarTx();

    const r = await asumir('admin', { motivo: 'lo corrige Operaciones' });

    expect(r.status).toBe(200);
    expect(sets[0]).not.toHaveProperty('estado');
    expect(sets[0]).not.toHaveProperty('motivoRechazo'); // el porqué del rechazo no se pierde
    expect(historial(inserts)[0]).toMatchObject({ estadoAnterior: 'con_novedad', estadoNuevo: 'con_novedad' });
  });

  it('AC4 — motivo corto o vacío → 400, sin escribir', async () => {
    const { txUpdate } = montarTx();
    expect((await asumir('admin', { motivo: 'x' })).status).toBe(400);
    expect((await asumir('admin', { motivo: '' })).status).toBe(400);
    expect((await devolver('admin', { proveedorSoatId: PROVEEDOR_DESTINO, motivo: 'x' })).status).toBe(400);
    expect(txUpdate).not.toHaveBeenCalled();
  });

  it('AC5 — un SOAT Pagado no se asume, y lo dice', async () => {
    selectMock.mockReturnValueOnce(chain([soatEn({ estado: 'pagado' })]));
    const { txUpdate } = montarTx();

    const r = await asumir('admin', { motivo: 'quiero rehacerlo' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/pagado/i);
    expect(txUpdate).not.toHaveBeenCalled();
  });

  it('AC5 — un SOAT Pendiente tampoco, y el mensaje es otro', async () => {
    selectMock.mockReturnValueOnce(chain([soatEn({ estado: 'pendiente' })]));
    const { txUpdate } = montarTx();

    const r = await asumir('admin', { motivo: 'lo asumo desde ya' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/no se ha enviado a gestión/i);
    expect(txUpdate).not.toHaveBeenCalled();
  });

  it('AC6 — asumir dos veces, devolver lo que no gestiona Operaciones, y proveedor inexistente', async () => {
    const { txUpdate } = montarTx();

    selectMock.mockReturnValueOnce(chain([soatEn({ gestionOperaciones: true })]));
    const yaAsumido = await asumir('admin', { motivo: 'otra vez por si acaso' });
    expect(yaAsumido.status).toBe(400);
    expect(yaAsumido.body.error).toMatch(/ya lo gestiona Operaciones/i);

    selectMock.mockReturnValueOnce(chain([soatEn({ gestionOperaciones: false })]));
    const noAsumido = await devolver('admin', { proveedorSoatId: PROVEEDOR_DESTINO, motivo: 'devolver sin haberlo tomado' });
    expect(noAsumido.status).toBe(400);
    expect(noAsumido.body.error).toMatch(/no lo gestiona Operaciones/i);

    selectMock.mockReturnValueOnce(chain([soatEn({ gestionOperaciones: true })]));
    selectMock.mockReturnValueOnce(chain([])); // el proveedor no existe
    const sinProveedor = await devolver('admin', { proveedorSoatId: PROVEEDOR_DESTINO, motivo: 'a un proveedor fantasma' });
    expect(sinProveedor.status).toBe(404);

    expect(txUpdate).not.toHaveBeenCalled();
  });

  it('AC6 — un SOAT inexistente → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    expect((await asumir('admin', { motivo: 'no existe este id' })).status).toBe(404);
  });

  for (const rol of ['proveedor', 'gestor_impuestos', 'auditor']) {
    it(`AC7 — ${rol} no puede asumir ni devolver → 403`, async () => {
      const { txUpdate } = montarTx();
      expect((await asumir(rol, { motivo: 'me lo quedo yo' })).status).toBe(403);
      expect((await devolver(rol, { proveedorSoatId: PROVEEDOR_DESTINO, motivo: 'me lo quedo yo' })).status).toBe(403);
      expect(txUpdate).not.toHaveBeenCalled();
    });
  }
});
