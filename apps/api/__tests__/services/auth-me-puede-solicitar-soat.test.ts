// HU #11914 (Feature #11912) — `GET /api/auth/me` gana `puedeSolicitarSoat`.
//
// ── Qué es y qué NO es ───────────────────────────────────────────────────────────────────────────
//
// Es la CAPACIDAD DE INTERFAZ con la que la web decide si pinta el botón «Solicitar SOAT» y la
// tarjeta del AC5. No es la frontera: los dos endpoints del canal vuelven a leer el flag de la
// compañía en cada petición y responden 403 — eso es lo que cubre el caso de una pestaña abierta con
// un `/me` viejo. Por eso aquí se comprueban DOS cosas y no una: que el booleano dice la verdad, y
// que no se convierta en la única puerta.
//
// El dato se calcula en el SERVIDOR porque el flag es de la compañía y el navegador no la conoce; la
// web no puede derivarlo de `role === 'cliente'`.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: vi.fn(), update: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

beforeEach(() => { selectMock.mockReset(); });

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/auth/auth.routes.js');
  app.use('/api/auth', router);
  return app;
}

/**
 * Encola las consultas de `GET /me` en orden: la del usuario y —solo para un `cliente` con
 * compañía— la de `clients`.
 *
 * `authMiddleware` NO consulta nada aquí: `__tests__/setup.ts` pone
 * `AUTH_SKIP_SESSION_INVAL_CHECK=1`, así que su lectura de `sessionInvalidatedAt` no ocurre. Por eso
 * el conteo de llamadas de abajo empieza en 1 y no en 2, y por eso vale como medida de «no hay una
 * consulta de más».
 */
function conUsuario(usuario: Record<string, unknown>, compania?: Record<string, unknown>[]) {
  selectMock.mockReturnValueOnce(chain([usuario]));        // el usuario
  if (compania) selectMock.mockReturnValueOnce(chain(compania)); // clients
}

const token = async (role: string, sub = 5) => `Bearer ${await testToken({ sub, username: 'u@empresa.co', role: role as never })}`;

const CLIENTE = { id: 5, username: 'u@empresa.co', name: 'Cliente', role: 'cliente', allowedPages: null, transitoCodigo: null, companiaId: 7 };
const ADMIN = { id: 5, username: 'a@flit.io', name: 'Admin', role: 'admin', allowedPages: null, transitoCodigo: null, companiaId: null };

describe('GET /api/auth/me — `puedeSolicitarSoat`', () => {
  it('**cliente cuya compañía tiene el flag ENCENDIDO → true**', async () => {
    conUsuario(CLIENTE, [{ sinTramite: true }]);
    const r = await request(await buildApp()).get('/api/auth/me').set('Authorization', await token('cliente'));

    expect(r.status).toBe(200);
    expect(r.body.puedeSolicitarSoat).toBe(true);
  });

  it('**flag APAGADO → false, y no es «no vino el campo»**', async () => {
    conUsuario(CLIENTE, [{ sinTramite: false }]);
    const r = await request(await buildApp()).get('/api/auth/me').set('Authorization', await token('cliente'));

    // La clave TIENE que venir: la pantalla distingue «no puede» de «no sé», y un `undefined`
    // pintaría el botón por omisión.
    expect(Object.keys(r.body)).toContain('puedeSolicitarSoat');
    expect(r.body.puedeSolicitarSoat).toBe(false);
  });

  it('cliente sin compañía → false SIN consultar `clients` (no hay compañía que consultar)', async () => {
    conUsuario({ ...CLIENTE, companiaId: null });
    const r = await request(await buildApp()).get('/api/auth/me').set('Authorization', await token('cliente'));

    expect(r.body.puedeSolicitarSoat).toBe(false);
    expect(selectMock).toHaveBeenCalledTimes(1); // solo la del usuario: `clients` no se consulta
  });

  it('**admin → false y NI UNA consulta de más**: los otros once roles no pagan este dato', async () => {
    conUsuario(ADMIN);
    const r = await request(await buildApp()).get('/api/auth/me').set('Authorization', await token('admin'));

    expect(r.body.puedeSolicitarSoat).toBe(false);
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('`companiaId` NO sale en la respuesta: viaja el booleano derivado, no el identificador interno', async () => {
    conUsuario(CLIENTE, [{ sinTramite: true }]);
    const r = await request(await buildApp()).get('/api/auth/me').set('Authorization', await token('cliente'));

    expect(r.body.companiaId).toBeUndefined();
    // Y lo que ya devolvía sigue estando: esto AÑADE, no reemplaza.
    expect(r.body).toMatchObject({ id: 5, username: 'u@empresa.co', role: 'cliente' });
    expect(Array.isArray(r.body.allowedPages)).toBe(true);
  });
});
