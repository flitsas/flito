// HU #12081 AC5 — GET /api/permisos/funciones: quién entra, quién no y con qué forma responde.
//
// Lo que se prueba aquí es la PUERTA, no el contenido: que la ruta lleva `authMiddleware` y la guarda
// de administración, y que agrupa por módulo. El contenido de verdad —que la base tiene exactamente
// el catálogo del código— se comprueba contra PostgreSQL en `__tests__/db/migracion-0179.test.ts`,
// porque el mock de este repo devuelve la fila entera aunque el `select` pida menos y su `orderBy` es
// un passthrough: un aserto de orden escrito sobre el mock sería verde vacío.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const { default: permisosRoutes } = await import('../../src/modules/permisos/permisos.routes.js');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/permisos', permisosRoutes);
  return a;
}

const FILAS = [
  { codigo: 'pagina.dashboard', modulo: 'general', nombreNegocio: 'Tablero de control', descripcion: 'Entrar.', tipo: 'pagina' },
  { codigo: 'soat.cola.ver', modulo: 'soat', nombreNegocio: 'Ver la cola de SOAT', descripcion: 'Abrir.', tipo: 'operacion' },
  { codigo: 'soat.solicitud.enviar', modulo: 'soat', nombreNegocio: 'Enviar solicitudes', descripcion: 'Pasar.', tipo: 'operacion' },
];

beforeEach(() => { selectMock.mockReset(); });

describe('AC5 — GET /api/permisos/funciones', () => {
  it('sin token responde 401 y no consulta nada', async () => {
    const res = await request(app()).get('/api/permisos/funciones');
    expect(res.status).toBe(401);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('un usuario sin permiso de administración recibe 403', async () => {
    for (const rol of ['auditor', 'financiera', 'gestor_impuestos', 'cliente']) {
      const res = await request(app())
        .get('/api/permisos/funciones')
        .set('Authorization', `Bearer ${await testToken({ role: rol })}`);
      expect(res.status, `rol ${rol}`).toBe(403);
    }
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('administración recibe 200 con las funciones agrupadas por módulo', async () => {
    selectMock.mockReturnValueOnce(chain(FILAS));
    const res = await request(app())
      .get('/api/permisos/funciones')
      .set('Authorization', `Bearer ${await testToken({ role: 'admin' })}`);

    expect(res.status).toBe(200);
    expect(res.body.grupos).toHaveLength(2);
    const soat = res.body.grupos.find((g: { modulo: string }) => g.modulo === 'soat');
    expect(soat.funciones).toHaveLength(2);
    // Los cuatro campos que el AC5 exige por función, y ninguno vacío.
    for (const f of soat.funciones) {
      expect(f).toEqual(expect.objectContaining({
        codigo: expect.any(String), nombreNegocio: expect.any(String),
        descripcion: expect.any(String), tipo: expect.any(String),
      }));
    }
  });

  it('no expone escritura: el catálogo lo declara el producto, no el administrador (CF-23)', async () => {
    const token = `Bearer ${await testToken({ role: 'admin' })}`;
    for (const peticion of [
      request(app()).post('/api/permisos/funciones').set('Authorization', token).send({}),
      request(app()).patch('/api/permisos/funciones').set('Authorization', token).send({}),
      request(app()).delete('/api/permisos/funciones').set('Authorization', token),
    ]) {
      const res = await peticion;
      expect(res.status).toBe(404);
    }
  });
});
