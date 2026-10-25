// HU #13959 (Feature #13940) — Un proveedor SOAT inactivo o eliminado no se puede elegir como destino (RN-PROV-5).
//
// Aquí se mide la RUTA con la base mockeada: el envío (`POST /flito/soat/enviar`, 409, AC1/AC2) y el gestor por defecto
// de la compañía (`PATCH /flito/parametrizacion/companias/:id`, 400, AC3; 200 si el valor no cambia, AC4). Cada caso
// negativo comprueba además que NO hubo escritura: un 409 que igual envió es un 409 inútil. El `FOR SHARE`, la
// concurrencia (AC6) y el canal sin trámite (AC5) contra PostgreSQL de verdad están en
// `__tests__/db/proveedores-soat-inactivo.test.ts`.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';
import { conAlcance } from '../helpers/frontera.js';

const { selectMock, updateMock, transactionMock } = vi.hoisted(() => ({
  selectMock: vi.fn(), updateMock: vi.fn(), transactionMock: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, update: updateMock, insert: vi.fn(), delete: vi.fn(), transaction: transactionMock, execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

beforeEach(() => { selectMock.mockReset(); updateMock.mockReset(); transactionMock.mockReset(); });

const SOAT_ID = '00000000-0000-0000-0000-000000000001';
const P = '00000000-0000-0000-0000-0000000000aa';
const OTRO = '00000000-0000-0000-0000-0000000000bb';
const INACTIVO = 'El gestor Gestora Andina está inactivo: elige otro gestor.';
const NO_EXISTE = 'El gestor seleccionado no existe o fue eliminado.';

const auth = async () => `Bearer ${await testToken({ sub: 7, username: 'ops@flitsas.com', role: 'admin' })}`;

/** La tx: la 1.ª lectura es el proveedor `FOR SHARE`; las demás, las filas bloqueadas del envío. */
function montarTx(proveedor: unknown[]) {
  const txSelect = vi.fn().mockReturnValue(chain([{ id: SOAT_ID }]));
  txSelect.mockReturnValueOnce(chain(proveedor));
  const txUpdate = vi.fn().mockReturnValue(chain([{ id: SOAT_ID }]));
  const txInsert = vi.fn().mockReturnValue(chain([]));
  transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({ select: txSelect, update: txUpdate, insert: txInsert }));
  return { txSelect, txUpdate, txInsert };
}

async function appSoat() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-soat/flito-soat.routes.js');
  app.use('/api/flito/soat', conAlcance('soat', router));
  return app;
}

const enviar = async (proveedorSoatId: string) => request(await appSoat()).post('/api/flito/soat/enviar')
  .set('Authorization', await auth()).send({ ids: [SOAT_ID], proveedorSoatId });

describe('POST /flito/soat/enviar — proveedor no utilizable (HU #13959)', () => {
  it('AC1: proveedor inactivo → 409 «El gestor P está inactivo: elige otro gestor.» y no se envía nada', async () => {
    const { txUpdate, txInsert } = montarTx([{ nombre: 'Gestora Andina', activo: false, deletedAt: null }]);
    const r = await enviar(P);
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: INACTIVO });
    expect(txUpdate).not.toHaveBeenCalled();
    expect(txInsert).not.toHaveBeenCalled();
  });

  it('AC2: proveedor eliminado (aunque siga `activo`) → 409 «no existe o fue eliminado» y no se envía nada', async () => {
    const { txUpdate } = montarTx([{ nombre: 'Gestora Andina', activo: true, deletedAt: new Date() }]);
    const r = await enviar(P);
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: NO_EXISTE });
    expect(txUpdate).not.toHaveBeenCalled();
  });

  it('AC2: proveedor inexistente → 409 con el mismo texto (no un 500 por la FK)', async () => {
    const { txUpdate } = montarTx([]);
    const r = await enviar(OTRO);
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: NO_EXISTE });
    expect(txUpdate).not.toHaveBeenCalled();
  });

  it('proveedor activo y vigente → 200; el estado se lee DENTRO de la transacción del envío', async () => {
    const { txSelect, txUpdate } = montarTx([{ nombre: 'Gestora Andina', activo: true, deletedAt: null }]);
    const r = await enviar(P);
    expect(r.status).toBe(200);
    expect(r.body.enviados).toEqual([SOAT_ID]);
    expect(txSelect).toHaveBeenCalledTimes(2); // proveedor FOR SHARE + filas FOR UPDATE SKIP LOCKED
    expect(txUpdate).toHaveBeenCalledTimes(1);
  });

  it('a gestión de Operaciones no consulta ningún proveedor', async () => {
    const { txSelect } = montarTx([]);
    txSelect.mockReset().mockReturnValue(chain([{ id: SOAT_ID }]));
    const r = await request(await appSoat()).post('/api/flito/soat/enviar')
      .set('Authorization', await auth()).send({ ids: [SOAT_ID], gestionOperaciones: true });
    expect(r.status).toBe(200);
    expect(txSelect).toHaveBeenCalledTimes(1);
  });
});

// ── Gestor por defecto de la compañía ──────────────────────────────────────────────────────────────

async function appParam() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-parametrizacion/flito-parametrizacion.routes.js');
  app.use('/api/flito/parametrizacion', router);
  return app;
}

/** `previo` = la fila de la compañía antes del PATCH; `proveedor` = lo que devuelve el `FOR SHARE` dentro de la tx. */
function montarCompania(previo: { proveedorSinTramiteId: string | null; soatSinTramite?: boolean }, proveedor: unknown[]) {
  selectMock.mockReturnValueOnce(chain([{ id: 1, soatSinTramite: false, ...previo }]));
  const txSelect = vi.fn().mockReturnValueOnce(chain(proveedor));
  const sets: Record<string, unknown>[] = [];
  const txUpdate = vi.fn(() => ({
    set: (v: Record<string, unknown>) => {
      sets.push(v);
      return { where: () => ({ returning: () => Promise.resolve([{ id: 1, name: 'Acme', flitoProveedorSoatSinTramiteId: P }]) }) };
    },
  }));
  transactionMock.mockImplementationOnce(async (fn: (tx: unknown) => unknown) => fn({ select: txSelect, update: txUpdate }));
  return { txSelect, txUpdate, sets };
}

const patchCompania = async (cuerpo: Record<string, unknown>) => request(await appParam())
  .patch('/api/flito/parametrizacion/companias/1').set('Authorization', await auth()).send(cuerpo);

describe('PATCH /flito/parametrizacion/companias/:id — gestor por defecto (HU #13959)', () => {
  it('AC3: fijar un proveedor inactivo → 400 con el texto de AC1 y no se escribe', async () => {
    const { txUpdate } = montarCompania({ proveedorSinTramiteId: null },
      [{ nombre: 'Gestora Andina', activo: false, deletedAt: null }]);
    const r = await patchCompania({ proveedorSoatSinTramiteId: P });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: INACTIVO, campo: 'proveedorSoatSinTramiteId' });
    expect(txUpdate).not.toHaveBeenCalled();
  });

  it('AC3: fijar un proveedor eliminado o inexistente → 400 «no existe o fue eliminado»', async () => {
    let m = montarCompania({ proveedorSinTramiteId: null }, [{ nombre: 'Gestora Andina', activo: true, deletedAt: new Date() }]);
    let r = await patchCompania({ proveedorSoatSinTramiteId: P });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: NO_EXISTE, campo: 'proveedorSoatSinTramiteId' });
    expect(m.txUpdate).not.toHaveBeenCalled();

    m = montarCompania({ proveedorSinTramiteId: P }, []);
    r = await patchCompania({ proveedorSoatSinTramiteId: OTRO });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe(NO_EXISTE);
    expect(m.txUpdate).not.toHaveBeenCalled();
  });

  it('AC4: la compañía YA tenía P (hoy inactivo) y el formulario lo reenvía al editar otro campo → 200, sin consultar P', async () => {
    const { txSelect, sets } = montarCompania({ proveedorSinTramiteId: P, soatSinTramite: true },
      [{ nombre: 'Gestora Andina', activo: false, deletedAt: null }]);
    const r = await patchCompania({ proveedorSoatSinTramiteId: P, toleranciaValorImpuesto: 500 });
    expect(r.status).toBe(200);
    expect(txSelect).not.toHaveBeenCalled();
    expect(sets[0]).toMatchObject({ flitoToleranciaValorImpuesto: '500' });
  });

  it('cambiar a un proveedor activo y vigente → 200 y se escribe', async () => {
    const { txSelect, sets } = montarCompania({ proveedorSinTramiteId: null },
      [{ nombre: 'Gestora Andina', activo: true, deletedAt: null }]);
    const r = await patchCompania({ proveedorSoatSinTramiteId: P });
    expect(r.status).toBe(200);
    expect(txSelect).toHaveBeenCalledTimes(1);
    expect(sets[0]).toEqual({ flitoProveedorSoatSinTramiteId: P });
  });
});
