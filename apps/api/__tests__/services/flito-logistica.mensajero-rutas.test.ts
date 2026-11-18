// HU #14347 (AC6). Las tres rutas de despacho pasan por la regla y traducen el rechazo a 422 con su código.
// La regla en sí se prueba contra PostgreSQL en `db/flito-logistica.mensajero-asignable.pg.test.ts`.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();
const transactionMock = vi.fn();
const usuariosConFuncionMock = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: transactionMock, execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/services/storage.js', () => ({ uploadEntityDocument: vi.fn().mockResolvedValue('k'), presignedGetEntityDocument: vi.fn(), getEntityDocumentStream: vi.fn() }));
vi.mock('../../src/modules/flito-logistica/flito-logistica-precios.js', async (orig) => ({
  ...await orig<typeof import('../../src/modules/flito-logistica/flito-logistica-precios.js')>(),
  precioTrasladoDe: vi.fn().mockResolvedValue({ valor: 1, vigenciaId: null }),
}));
vi.mock('../../src/shared/permisos-efectivos.js', async (orig) => ({
  ...await orig<typeof import('../../src/shared/permisos-efectivos.js')>(),
  usuariosConFuncion: usuariosConFuncionMock,
}));

const { default: rutas } = await import('../../src/modules/flito-logistica/flito-logistica.routes.js');

const TR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACTA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const D1 = '11111111-1111-4111-8111-111111111111';

async function post(ruta: string, cuerpo: object) {
  const app = express();
  app.use(express.json());
  app.use('/api/flito/logistica', rutas);
  return request(app).post(`/api/flito/logistica${ruta}`).set('Authorization', `Bearer ${await testToken({ role: 'admin', sub: 1 })}`).send(cuerpo);
}
const cola = (...filas: unknown[][]) => { for (const f of filas) selectMock.mockReturnValueOnce(chain(f)); };

beforeEach(() => {
  selectMock.mockReset().mockImplementation(() => chain([]));
  usuariosConFuncionMock.mockReset().mockResolvedValue([]); // nadie es asignable
  transactionMock.mockReset().mockImplementation(async (fn: (t: unknown) => unknown) => fn({ select: selectMock, insert: vi.fn(), update: vi.fn() }));
});

describe('AC6 — un mensajero no asignable', () => {
  it('POST /traslados → 422 MENSAJERO_NO_ASIGNABLE', async () => {
    cola([{ id: 5, nombre: 'ACME', autogestionable: false, proveedorId: 'prov' }], [{ id: D1, estado: 'clasificado', companiaId: 5, actaOrganismoPendiente: false, proveedorId: 'prov' }]);
    const r = await post('/traslados', { companiaId: 5, destino: 'cliente', lts: [{ documentoId: D1 }], mensajeroId: 9 });
    expect([r.status, r.body.codigo]).toEqual([422, 'MENSAJERO_NO_ASIGNABLE']);
    expect(usuariosConFuncionMock).toHaveBeenCalledWith('logistica.actas.entregar', { sin: 'logistica.actas.operar_ajenas' });
  });

  it('POST /traslados/:id/despachar → 422 MENSAJERO_NO_ASIGNABLE', async () => {
    cola([{ id: TR, companiaId: 5, destino: 'cliente', origen: 'organismo', estado: 'registrado', mensajeroId: 1 }], [{ id: ACTA, estado: 'generada', mensajeroId: 1, proveedorId: 'prov' }]);
    const r = await post(`/traslados/${TR}/despachar`, { mensajeroId: 9 });
    expect([r.status, r.body.codigo]).toEqual([422, 'MENSAJERO_NO_ASIGNABLE']);
  });

  it('POST /actas/:id/despachar → 422 MENSAJERO_NO_ASIGNABLE', async () => {
    cola([{ id: ACTA, punto: 'cliente', trasladoId: null }], [{ id: ACTA, companiaId: 5, estado: 'generada', mensajeroId: null, proveedorId: 'prov' }], [{ id: ACTA, companiaId: 5, estado: 'generada', mensajeroId: null, proveedorId: 'prov' }]);
    const r = await post(`/actas/${ACTA}/despachar`, { mensajeroId: 9, firmaEntrega: 'iVBORw0KGgo=' });
    expect([r.status, r.body.codigo]).toEqual([422, 'MENSAJERO_NO_ASIGNABLE']);
  });
});
