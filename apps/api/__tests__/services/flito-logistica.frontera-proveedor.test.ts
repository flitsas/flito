// HU #14351 (Feature #14326, ADR-0024, ADR-0039 §6.5) — F4.2 abre Logística al usuario de proveedor: `FRONTERA_POR_ENLACE.logistica` lo
// incluye y cada ruta decide con su guarda y su filtro. Aquí, solo qué rutas alcanza y cuáles siguen cerradas aunque tenga la función.
// A sobre B, ruta por ruta: flito-logistica.alcance-proveedor.test.ts y db/flito-logistica.alcance-proveedor.pg.test.ts.
import 'express-async-errors';
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { FRONTERA_POR_ENLACE } from '@operaciones/shared-types';
import { chain } from '../helpers/db.js';
import { conAlcance } from '../helpers/frontera.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn().mockImplementation(() => chain([]));
vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, selectDistinct: selectMock, insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));

const { default: logisticaRoutes } = await import('../../src/modules/flito-logistica/flito-logistica.routes.js');
const { default: viajesRoutes } = await import('../../src/modules/flito-logistica/flito-logistica-viajes.routes.js');
const { errorHandler } = await import('../../src/shared/middleware/errorHandler.js');

const PROV = '14346000-0000-4000-8000-000000000001';
const ID = '14346000-0000-4000-8000-0000000000aa';
const FUNCIONES = ['logistica.consola.ver', 'logistica.consola.filtrar', 'logistica.documento.escanear', 'logistica.traslado.registrar', 'logistica.actas.despachar',
  'logistica.documento.resolver_tramite', 'logistica.documento.reversar', 'logistica.lote.cerrar', 'logistica.viajes.ver', 'logistica.viajes.registrar', 'logistica.viajes.quitar',
  'logistica.actas.firmar_flit', 'logistica.ruta.ver', 'logistica.actas.listar'];
const llamar = async (metodo: 'get' | 'post' | 'delete', ruta: string, cuerpo: object = {}) => {
  const app = express();
  app.use(express.json());
  app.use('/api/flito/logistica', conAlcance('logistica', logisticaRoutes));
  app.use('/api/flito/logistica', conAlcance('logistica', viajesRoutes));
  app.use(errorHandler);
  const token = await testToken({ role: 'proveedor_x' as never, sub: 77, tipoEnlace: 'proveedor', flitoProveedorId: PROV, funciones: FUNCIONES } as never);
  const r = request(app)[metodo](`/api/flito/logistica${ruta}`).set('Authorization', `Bearer ${token}`);
  return metodo === 'post' ? r.send(cuerpo) : r;
};

describe('apertura del módulo al usuario de proveedor', () => {
  it('la frontera de logística incluye a `proveedor` desde F4.2', () => {
    expect(FRONTERA_POR_ENLACE.logistica).toContain('proveedor');
  });

  it.each([
    ['get', '/'], ['get', '/facetas'], ['get', '/actas'], ['get', '/mi-ruta'],
  ] as const)('%s %s lo alcanza, sin datos ajenos en un mundo vacío', async (metodo, ruta) => {
    const r = await llamar(metodo, ruta);
    expect(r.status).toBe(200);
  });

  // AC5 de #14351: aunque tenga la función. Con cuerpo vacío: la guarda va antes de validar.
  it.each([
    ['get', '/pendientes-tramite'], ['get', `/documentos/${ID}/candidatos-tramite`], ['post', `/documentos/${ID}/resolver-tramite`],
    ['post', `/documentos/${ID}/reversar`], ['post', '/cerrar-lote'], ['get', `/tramites/${ID}/viajes`], ['post', `/tramites/${ID}/viajes`],
    ['post', '/viajes/masivo'], ['delete', `/tramites/${ID}/viajes/${ID}`],
  ] as const)('%s %s sigue cerrada: 403, con la función', async (metodo, ruta) => {
    const r = await llamar(metodo, ruta);
    expect([r.status, r.body]).toEqual([403, { error: 'Sin permisos' }]);
  });
});
