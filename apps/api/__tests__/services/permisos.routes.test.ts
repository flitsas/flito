// HU #12081 AC5 — GET /api/permisos/funciones: quién entra, quién no y con qué forma responde.
// HU #12082 AC7 — GET /api/permisos/mios: el conjunto efectivo del PROPIO usuario, ya resuelto.
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
import { testToken, registrarUsuarioDePrueba, fuenteDePrueba, operacionesDePartida } from '../helpers/auth.js';

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

describe('TC #12270 AC7 — GET /api/permisos/mios devuelve el mismo conjunto efectivo que usa el servidor, ya resuelto, con un identificador de versión que cambia cuando el administrador escribe', () => {
  /** El resolutor real (regla, hash y caché) sobre el registro del helper; espiado, no sustituido. */
  const gestor7 = async (funcionesDelRol: string[]) => registrarUsuarioDePrueba(7, {
    rol: 'gestor', tipoPrincipal: 'interno', funcionesDelRol, excepciones: [{ codigo: 'pagina.dashboard', efecto: 'conceder' }],
  });

  it('sin token → 401', async () => {
    const res = await request(app()).get('/api/permisos/mios');
    expect(res.status).toBe(401);
  });

  it('cuerpo { funciones, rol, tipoPrincipal, version, resueltoEn }: funciones es EXACTAMENTE el conjunto del resolutor, ordenado; sin consultar nada más', async () => {
    const token = await testToken({ sub: 7, role: 'gestor_impuestos' });
    await gestor7(['soat.cola.ver', 'tramite.lote.crear']);
    const { resolverPermisos } = await import('../../src/shared/permisos-efectivos.js');
    const esperado = await resolverPermisos(7);

    const res = await request(app()).get('/api/permisos/mios').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(esperado.ok).toBe(true);
    if (!esperado.ok) return;
    expect(res.body).toEqual({
      funciones: [...esperado.funciones].sort(),
      rol: 'gestor',
      tipoPrincipal: 'interno',
      version: esperado.version,
      resueltoEn: esperado.resueltoEn.toISOString(),
    });
    expect(res.body.funciones).toEqual(['pagina.dashboard', 'soat.cola.ver', 'tramite.lote.crear']);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('tras una escritura del administrador que altera el conjunto, version cambia y funciones refleja el cambio', async () => {
    const token = await testToken({ sub: 7, role: 'gestor_impuestos' });
    await gestor7(['soat.cola.ver']);
    const antes = await request(app()).get('/api/permisos/mios').set('Authorization', `Bearer ${token}`);
    expect(antes.status).toBe(200);

    // Lo que hace `users.routes.ts` tras el commit: cambia la fila e invalida la caché de este usuario
    // (`registrarUsuarioDePrueba` llama a `invalidarPermisosDe`).
    await gestor7(['soat.cola.ver', 'tramite.lote.crear']);
    const despues = await request(app()).get('/api/permisos/mios').set('Authorization', `Bearer ${token}`);
    expect(despues.status).toBe(200);
    expect(despues.body.version).not.toBe(antes.body.version);
    expect(despues.body.funciones).toContain('tramite.lote.crear');
    expect(antes.body.funciones).not.toContain('tramite.lote.crear');

    // Y una escritura que NO cambia lo que puede deja la version igual: la pantalla no refresca en vano.
    await gestor7(['tramite.lote.crear', 'soat.cola.ver']);
    const igual = await request(app()).get('/api/permisos/mios').set('Authorization', `Bearer ${token}`);
    expect(igual.body.version).toBe(despues.body.version);
  });

  it('no exige ningún permiso propio: un rol externo con solo su canal también ve SU conjunto', async () => {
    const token = await testToken({ sub: 8, role: 'cliente' });
    const res = await request(app()).get('/api/permisos/mios').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.tipoPrincipal).toBe('externo');
    // HU #12083: el helper carga las operaciones de partida del rol (la foto); `cliente` tiene su
    // página y sus ocho `soat.*` de lectura y del canal, y nada más.
    expect(res.body.funciones).toEqual(['pagina.flito_soat', ...operacionesDePartida('cliente')].sort());
  });

  it('?userId=8 se ignora: nunca devuelve el conjunto de otro usuario', async () => {
    await registrarUsuarioDePrueba(8, { rol: 'admin', tipoPrincipal: 'interno', funcionesDelRol: ['pagina.users'], excepciones: [] });
    const token = await testToken({ sub: 7, role: 'gestor_impuestos' });
    await gestor7(['soat.cola.ver']);
    const res = await request(app()).get('/api/permisos/mios?userId=8').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.rol).toBe('gestor');
    expect(res.body.funciones).not.toContain('pagina.users');
  });

  it('si el resolutor no puede leer (ok:false) → 503, no un 403 ni un conjunto vacío', async () => {
    const token = await testToken({ sub: 7, role: 'gestor_impuestos' });
    const { fijarFuenteDePermisos } = await import('../../src/shared/permisos-efectivos.js');
    fijarFuenteDePermisos(async () => { throw new Error('ECONNREFUSED'); });
    try {
      const res = await request(app()).get('/api/permisos/mios').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'No se pudieron resolver los permisos' });
    } finally {
      fijarFuenteDePermisos(fuenteDePrueba); // repone el registro del helper
    }
  });
});
