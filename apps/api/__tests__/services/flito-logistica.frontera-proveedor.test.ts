// HU #14346 (AC10, Feature #14326). Esta entrega deja listo el dueño, sin abrir Logística: F4.2 (#14349, ADR-0024) cambia
// `FRONTERA_POR_ENLACE.logistica`. Un usuario de enlace proveedor sigue recibiendo 403 en TODA ruta del módulo.
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { FRONTERA_POR_ENLACE } from '@operaciones/shared-types';
import { chain } from '../helpers/db.js';
import { conAlcance } from '../helpers/frontera.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn().mockImplementation(() => chain([]));
vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));

const { default: logisticaRoutes } = await import('../../src/modules/flito-logistica/flito-logistica.routes.js');

const PROV = '14346000-0000-4000-8000-000000000001';
const llamar = async (metodo: 'get' | 'post', ruta: string, cuerpo: object = {}) => {
  const app = express();
  app.use(express.json());
  app.use('/api/flito/logistica', conAlcance('logistica', logisticaRoutes));
  const token = await testToken({ role: 'proveedor_x', sub: 77, tipoEnlace: 'proveedor', flitoProveedorId: PROV, funciones: ['logistica.consola.ver', 'logistica.documento.escanear', 'logistica.traslado.registrar', 'logistica.actas.despachar'] } as never);
  const r = request(app)[metodo](`/api/flito/logistica${ruta}`).set('Authorization', `Bearer ${token}`);
  return metodo === 'post' ? r.send(cuerpo) : r;
};

describe('AC10 — sin efecto para el usuario de proveedor', () => {
  it('la frontera de logística no incluye a `proveedor`', () => {
    expect(FRONTERA_POR_ENLACE.logistica).not.toContain('proveedor');
  });

  it.each([
    ['get', '/'], ['get', '/facetas'], ['get', '/mi-ruta'], ['post', '/escanear'], ['post', '/validar-lt'],
    ['post', '/consultar-vehiculo'], ['post', '/traslados'], ['post', '/recogidas/confirmar'],
  ] as const)('%s %s responde 403', async (metodo, ruta) => {
    const r = await llamar(metodo, ruta);
    expect(r.status).toBe(403);
  });
});
