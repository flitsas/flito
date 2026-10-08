// HU #13425 (Feature #13414, Épica #13411) — AC1 / AC7: la sesión (`GET /api/auth/me` y el sobre de
// `POST /api/auth/login`) lleva los permisos EFECTIVOS (`funciones`, `allowedPages`) y los indicadores
// calculados desde esos permisos (`puedeSolicitarSoat`), y sale IDÉNTICA si el rol se renombra o es
// otro código con las mismas funciones — salvo `role` / `rolNombre`, que son descripción.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken, registrarUsuarioDePrueba } from '../helpers/auth.js';

const selectMock = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: vi.fn(), update: vi.fn(), execute: vi.fn().mockResolvedValue([]) },
  getPoolStats: vi.fn(),
}));
const argonVerifyMock = vi.fn();
vi.mock('argon2', () => ({ default: { verify: argonVerifyMock }, verify: argonVerifyMock }));
vi.mock('../../src/modules/auth/loginLockout.js', () => ({
  checkLockout: vi.fn().mockResolvedValue({ locked: false }),
  registerFailed: vi.fn().mockResolvedValue(undefined),
  clearLockout: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

beforeEach(() => { selectMock.mockReset(); argonVerifyMock.mockReset(); });

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/auth/auth.routes.js');
  app.use('/api/auth', router);
  return app;
}

const FUNCIONES_CANAL = ['pagina.flito_soat', 'soat.solicitud.crear', 'soat.runt.preconsultar'];
const fila = (role: string, rolNombre: string) => ({
  id: 5, username: 'u@empresa.co', name: 'Cliente', email: null, role, rolNombre, allowedPages: null, companiaId: 7,
});

/** `/me` de un usuario con ese código de rol y esas funciones. Consultas: usuario → puente → clients. */
async function me(rol: string, rolNombre: string, funciones: string[], tipoPrincipal: 'interno' | 'externo' = 'externo', sinTramite = true) {
  const token = await testToken({ sub: 5, role: 'cliente' });
  await registrarUsuarioDePrueba(5, { rol, tipoPrincipal, tipoEnlace: 'compania', funcionesDelRol: funciones, excepciones: [] });
  selectMock
    .mockReturnValueOnce(chain([fila(rol, rolNombre)]))
    .mockReturnValueOnce(chain([]))
    .mockReturnValueOnce(chain([{ sinTramite }]));
  return request(await buildApp()).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
}

const sinNombre = (b: Record<string, unknown>) => { const { role: _r, rolNombre: _n, ...resto } = b; return resto; };

describe('HU #13425 AC1 — /me con permisos efectivos e indicadores desde permisos', () => {
  it('lleva `funciones` (códigos efectivos, ordenados) y `puedeSolicitarSoat` calculado de ellas', async () => {
    const r = await me('cliente', 'Cliente', FUNCIONES_CANAL);
    expect(r.status).toBe(200);
    expect(r.body.funciones).toEqual([...FUNCIONES_CANAL].sort());
    expect(r.body.allowedPages).toEqual(['flito_soat']);
    expect(r.body.puedeSolicitarSoat).toBe(true);
    expect(r.body.companiaId).toBeUndefined();
  });

  it('rol llamado `cliente` SIN `soat.solicitud.crear` → false, sin consultar la compañía', async () => {
    const r = await me('cliente', 'Cliente', ['pagina.flito_soat']);
    expect(r.body.puedeSolicitarSoat).toBe(false);
    expect(selectMock).toHaveBeenCalledTimes(2); // usuario + puente; `clients` no
  });

  it('interno con compañía y `soat.solicitud.crear` → false (el canal es del principal externo; riesgo R1)', async () => {
    const r = await me('cola_soat', 'Cola SOAT', FUNCIONES_CANAL, 'interno');
    expect(r.body.puedeSolicitarSoat).toBe(false);
  });
});

describe('HU #13425 AC7 — rol renombrado u otro código con las mismas funciones → misma sesión', () => {
  it('`cliente` vs `cliente_corporativo` (mismas funciones): el sobre coincide campo a campo salvo role/rolNombre', async () => {
    const a = await me('cliente', 'Cliente', FUNCIONES_CANAL);
    const b = await me('cliente_corporativo', 'Cliente corporativo', FUNCIONES_CANAL);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(sinNombre(b.body)).toEqual(sinNombre(a.body));
    expect(b.body.puedeSolicitarSoat).toBe(true);
  });

  it('el mismo código de rol con otro `nombre` en el catálogo → idéntico salvo rolNombre', async () => {
    const a = await me('cliente', 'Cliente', FUNCIONES_CANAL);
    const b = await me('cliente', 'Empresas aliadas', FUNCIONES_CANAL);
    expect({ ...b.body, rolNombre: null }).toEqual({ ...a.body, rolNombre: null });
  });

  it('login y /me llevan las MISMAS `funciones` y el mismo indicador (Bug #11937: un sobre no diverge del otro)', async () => {
    await registrarUsuarioDePrueba(5, { rol: 'cliente_corporativo', tipoPrincipal: 'externo', tipoEnlace: 'compania', funcionesDelRol: FUNCIONES_CANAL, excepciones: [] });
    argonVerifyMock.mockResolvedValueOnce(true);
    selectMock
      .mockReturnValueOnce(chain([{ ...fila('cliente_corporativo', 'Cliente corporativo'), passwordHash: 'h', active: true, deletedAt: null }]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{ sinTramite: true }]));
    const login = await request(await buildApp()).post('/api/auth/login').send({ username: 'u@empresa.co', password: 'OK' });
    expect(login.status).toBe(200);
    const m = await me('cliente_corporativo', 'Cliente corporativo', FUNCIONES_CANAL);
    expect(login.body.user.funciones).toEqual(m.body.funciones);
    expect(login.body.user.allowedPages).toEqual(m.body.allowedPages);
    expect(login.body.user.puedeSolicitarSoat).toBe(true);
    expect(m.body.puedeSolicitarSoat).toBe(true);
  });
});
