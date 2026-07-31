// FLITO SOAT — contingencia: envío a gestión de Operaciones (HU #11152, Feature #11150).
//
// Lo que se prueba aquí no es «se llamó a update», sino QUÉ se escribe: la diferencia entre enviar
// a un proveedor y enviar a Operaciones vive entera en el payload del `set` y en el motivo que va
// al historial. El helper `chain` no registra argumentos, así que estos tests envuelven el chain
// con un recorder para poder afirmar sobre el contenido.
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
function montarTx(filasBloqueadas: { id: string }[] = [{ id: SOAT_ID }]) {
  const sets: Record<string, unknown>[] = [];
  const inserts: unknown[] = [];

  const txSelect = vi.fn().mockReturnValue(chain(filasBloqueadas));
  const txUpdate = vi.fn(() => {
    const c = chain([]);
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
