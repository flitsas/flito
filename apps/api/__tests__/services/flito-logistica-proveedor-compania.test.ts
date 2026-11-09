// HU #14104 (Feature #14089) — proveedor de logística por compañía: la regla «encendida exige proveedor» en
// `PATCH /api/flito/parametrizacion/companias/:id`, el resolvedor `proveedorDeCompania` y el bloqueo de inactivar un
// proveedor asignado (se mide en `db/proveedores-gestion.test.ts`, HU #14334 AC1). La migración 0279 se valida en la BD (HANDOFF).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';
import { testToken } from '../helpers/auth.js';

const kdb = createKeyedDb();
const espia = crearEspia(kdb);
const auditMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const COMPANIA = 1;
const PROV = '14104000-0000-4000-8000-000000000001';
const OTRO = '14104000-0000-4000-8000-000000000002';

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-parametrizacion/flito-parametrizacion.routes.js');
  const { default: logistica } = await import('../../src/modules/flito-parametrizacion/flito-proveedores-logistica.routes.js');
  const { errorHandler } = await import('../../src/shared/middleware/errorHandler.js');
  app.use('/api/flito/parametrizacion/proveedores-logistica', logistica);
  app.use('/api/flito/parametrizacion', router);
  app.use(errorHandler);
  return app;
}
const auth = async () => `Bearer ${await testToken({ sub: 1, username: 'ops@flito.co', role: 'admin' })}`;

const filaCompania = (over: Record<string, unknown> = {}) => ({
  id: COMPANIA, name: 'Acme', document: '900', active: true,
  soatAutogestionable: false, soatSinTramite: false, impuestosAutogestionable: false,
  logisticaAutogestionable: false, flitoProveedorLogisticaId: PROV, logisticaPermiteParcial: false,
  flitoCarpetaStorage: null, flitoToleranciaValorImpuesto: '0', flitoProveedorSoatSinTramiteId: null, ...over,
});

function escenario(previa: { logisticaAutogestionable: boolean; proveedorLogisticaId: string | null },
  proveedores: { id: string; nombre: string; activo: boolean }[] = [{ id: PROV, nombre: 'Andina', activo: true }],
  devuelve: Record<string, unknown> = filaCompania()) {
  kdb.when.scenario({ clients: [{ id: COMPANIA, proveedorSinTramiteId: null, ...previa }], flito_proveedores: proveedores, flito_proveedores_logistica: proveedores });
  kdb.when.update('clients', [devuelve]);
}
const patch = async (cuerpo: Record<string, unknown>) =>
  request(await buildApp()).patch(`/api/flito/parametrizacion/companias/${COMPANIA}`).set('Authorization', await auth()).send(cuerpo);
const setEscrito = () => espia.updatesEn('clients').at(-1)?.datos;

beforeEach(() => { kdb.reset(); espia.reiniciar(); auditMock.mockClear(); });

describe('AC1 — encender sin proveedor → 422', () => {
  it('apagada→encendida sin proveedor: 422, campo y CERO escrituras', async () => {
    escenario({ logisticaAutogestionable: true, proveedorLogisticaId: null });
    const r = await patch({ logisticaAutogestionable: false });
    expect(r.status).toBe(422);
    expect(r.body.campo).toBe('proveedorLogisticaId');
    expect(espia.updatesEn('clients')).toHaveLength(0);
  });

  it('encendida con proveedor y se lo quitan (null) → 422', async () => {
    escenario({ logisticaAutogestionable: false, proveedorLogisticaId: PROV });
    const r = await patch({ proveedorLogisticaId: null });
    expect(r.status).toBe(422);
    expect(espia.updatesEn('clients')).toHaveLength(0);
  });

  it('encender enviando el proveedor activo → 200 y se escriben ambos', async () => {
    escenario({ logisticaAutogestionable: true, proveedorLogisticaId: null });
    const r = await patch({ logisticaAutogestionable: false, proveedorLogisticaId: PROV });
    expect(r.status).toBe(200);
    expect(setEscrito()).toEqual({ logisticaAutogestionable: false, flitoProveedorLogisticaId: PROV });
    expect(r.body.proveedorLogisticaId).toBe(PROV);
  });

  it('proveedor inexistente o inactivo → 422 y CERO escrituras', async () => {
    escenario({ logisticaAutogestionable: true, proveedorLogisticaId: null }, []);
    expect((await patch({ logisticaAutogestionable: false, proveedorLogisticaId: OTRO })).status).toBe(422);
    kdb.reset(); espia.reiniciar();
    escenario({ logisticaAutogestionable: true, proveedorLogisticaId: null }, [{ id: PROV, nombre: 'Andina', activo: false }]);
    const r = await patch({ logisticaAutogestionable: false, proveedorLogisticaId: PROV });
    expect(r.status).toBe(422);
    expect(String(r.body.error)).toMatch(/inactivo/i);
    expect(espia.updatesEn('clients')).toHaveLength(0);
  });

  it('un PATCH que NO toca la logística no falla por una encendida sin proveedor (las existentes al migrar)', async () => {
    escenario({ logisticaAutogestionable: false, proveedorLogisticaId: null });
    const r = await patch({ logisticaPermiteParcial: true });
    expect(r.status).toBe(200);
    expect(setEscrito()).toEqual({ logisticaPermiteParcial: true });
  });
});

describe('AC2 / AC5 — apagar la logística', () => {
  it('con proveedor asignado se guarda (200) y el proveedor se conserva', async () => {
    escenario({ logisticaAutogestionable: false, proveedorLogisticaId: PROV }, undefined, filaCompania({ logisticaAutogestionable: true }));
    const r = await patch({ logisticaAutogestionable: true });
    expect(r.status).toBe(200);
    expect(setEscrito()).toEqual({ logisticaAutogestionable: true });
    expect(r.body.logisticaAutogestionable).toBe(true);
  });

  it('apagada y sin proveedor es válido (autogestionable nunca exige proveedor)', async () => {
    escenario({ logisticaAutogestionable: true, proveedorLogisticaId: null }, undefined, filaCompania({ logisticaAutogestionable: true, flitoProveedorLogisticaId: null }));
    const r = await patch({ logisticaAutogestionable: true });
    expect(r.status).toBe(200);
  });
});

describe('AC4 — resolvedor único proveedorDeCompania', () => {
  it('devuelve el id del proveedor, o null si no tiene o la compañía no existe', async () => {
    const { proveedorDeCompania } = await import('../../src/modules/flito-parametrizacion/flito-logistica-proveedor-compania.service.js');
    kdb.when.scenario({ clients: [{ id: COMPANIA, proveedorId: PROV }] });
    expect(await proveedorDeCompania(kdb.db as never, COMPANIA)).toBe(PROV);
    kdb.reset();
    kdb.when.scenario({ clients: [{ id: COMPANIA, proveedorId: null }] });
    expect(await proveedorDeCompania(kdb.db as never, COMPANIA)).toBeNull();
    kdb.reset();
    kdb.when.scenario({ clients: [] });
    expect(await proveedorDeCompania(kdb.db as never, 999)).toBeNull();
  });
});

describe('AC3 — migración 0279 (forma del SQL; la ejecución real se valida en la BD)', () => {
  const sql = readFileSync(resolve(__dirname, '../../src/db/migrations/0279_flito_clients_proveedor_logistica.sql'), 'utf8');
  it('idempotente, FK RESTRICT, índice y SIN backfill de proveedor', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS flito_proveedor_logistica_id uuid/);
    expect(sql).toMatch(/pg_constraint WHERE conname = 'clients_flito_proveedor_logistica_id_fkey'/);
    expect(sql).toMatch(/ON DELETE RESTRICT/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_clients_flito_proveedor_logistica/);
    expect(sql).not.toMatch(/^\s*(UPDATE|INSERT)\b/im);
  });
});

describe('HU #14346 — el PATCH reasigna las licencias en su transacción', () => {
  const NUEVO = OTRO;
  const conNuevo = () => [{ id: NUEVO, nombre: 'Nuevo', activo: true }];
  const previa = (proveedorId: string | null) => ({ logisticaAutogestionable: false, proveedorLogisticaId: proveedorId });

  it('AC5: cambiar de proveedor actualiza las licencias, con la compañía bloqueada, antes del UPDATE de la compañía; la auditoría cuenta las reasignadas', async () => {
    escenario(previa(PROV), conNuevo());
    kdb.when.update('flito_logistica_documentos', [{ id: 'd1' }, { id: 'd2' }]);
    const r = await patch({ proveedorLogisticaId: NUEVO });
    expect(r.status).toBe(200);
    expect(espia.updatesEn('flito_logistica_documentos').at(-1)?.datos).toMatchObject({ proveedorLogisticaId: NUEVO });
    expect(auditMock.mock.calls[0]![1].detail).toContain('Licencias reasignadas: 2');
    expect(JSON.stringify(auditMock.mock.calls[0]![1])).not.toMatch(/d1|d2/);
  });

  it('reenviar el mismo proveedor llega al UPDATE de licencias y la auditoría cuenta las reasignadas', async () => {
    escenario(previa(PROV));
    kdb.when.update('flito_logistica_documentos', [{ id: 'd1' }]);
    const r = await patch({ proveedorLogisticaId: PROV });
    expect(r.status).toBe(200);
    expect(espia.updatesEn('flito_logistica_documentos').at(-1)?.datos).toMatchObject({ proveedorLogisticaId: PROV });
    expect(auditMock.mock.calls[0]![1].detail).toContain('Licencias reasignadas: 1');
  });

  it('reenviar el mismo proveedor sin nada que reasignar: la auditoría no menciona licencias', async () => {
    escenario(previa(PROV));
    kdb.when.update('flito_logistica_documentos', []);
    const r = await patch({ proveedorLogisticaId: PROV });
    expect(r.status).toBe(200);
    expect(espia.updatesEn('flito_logistica_documentos')).toHaveLength(1);
    expect(auditMock.mock.calls[0]![1].detail).not.toContain('Licencias reasignadas');
  });

  it('AC7: quitar el proveedor no toca las licencias', async () => {
    escenario({ logisticaAutogestionable: true, proveedorLogisticaId: PROV });
    const r = await patch({ proveedorLogisticaId: null });
    expect(r.status).toBe(200);
    expect(espia.updatesEn('flito_logistica_documentos')).toHaveLength(0);
  });

  it('un PATCH que no trae el proveedor no toca las licencias', async () => {
    escenario(previa(PROV));
    const r = await patch({ logisticaPermiteParcial: true });
    expect(r.status).toBe(200);
    expect(espia.updatesEn('flito_logistica_documentos')).toHaveLength(0);
  });

  it('si el proveedor nuevo no es usable, no se reasigna nada', async () => {
    escenario(previa(PROV), [{ id: NUEVO, nombre: 'Nuevo', activo: false }]);
    const r = await patch({ proveedorLogisticaId: NUEVO });
    expect(r.status).toBe(422);
    expect(espia.updatesEn('flito_logistica_documentos')).toHaveLength(0);
  });
});

describe('Autogestionada = sin proveedor en sus licencias (decisión del agente en F4.2, declarada)', () => {
  it('asignarle un proveedor a una compañía que queda autogestionada no le reasigna ninguna licencia', async () => {
    escenario({ logisticaAutogestionable: true, proveedorLogisticaId: null }, undefined, filaCompania({ logisticaAutogestionable: true }));
    const r = await patch({ proveedorLogisticaId: PROV });
    expect(r.status).toBe(200);
    expect(espia.updatesEn('flito_logistica_documentos')).toHaveLength(0);
  });

  it('al encender la logística conservando su proveedor, sus licencias pasan a él', async () => {
    escenario({ logisticaAutogestionable: true, proveedorLogisticaId: PROV });
    const r = await patch({ logisticaAutogestionable: false });
    expect(r.status).toBe(200);
    expect(espia.updatesEn('flito_logistica_documentos')).toHaveLength(1);
  });

  it('un PATCH que no toca la logística de una compañía encendida no reasigna', async () => {
    escenario({ logisticaAutogestionable: false, proveedorLogisticaId: PROV });
    expect((await patch({ logisticaPermiteParcial: true })).status).toBe(200);
    expect(espia.updatesEn('flito_logistica_documentos')).toHaveLength(0);
  });
});
